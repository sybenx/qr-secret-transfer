// A small Nostr relay for development and tests.
//
//   node tools/test-relay.mjs [port]
//
// It speaks enough of NIP-01, NIP-11 and NIP-42 to carry a QRST session, verifies
// event signatures like a real relay, and can be told to misbehave in the ways public
// relays do, so that relay selection is tested against failure and not only success.
//
// It keeps everything in memory and is not meant to face the internet.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { verifyEvent } from 'nostr-tools';
import { WebSocketServer } from 'ws';

/**
 * @typedef {object} Behaviour
 * @property {string} [rejectWrites]   Refuse every EVENT with this message, e.g. "blocked: members only".
 * @property {number[]} [rejectKinds]  Refuse these kinds.
 * @property {'write'|'read'|'both'} [authRequired]  Demand NIP-42 before EVENT, REQ, or both.
 * @property {boolean} [recipientOnly] Serve kind 1059 only to the authenticated p-tagged key (NIP-17).
 * @property {number} [maxEventBytes]  Refuse events whose JSON is longer than this.
 * @property {boolean} [swallow]       Say OK, then never deliver to anyone.
 * @property {boolean} [silent]        Accept the socket and answer nothing at all.
 * @property {number} [delayMs]        Wait this long before delivering an event to subscribers.
 * @property {object|false} [nip11]    The NIP-11 document; false to answer 404.
 */

function matches(filter, event) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (key[0] !== '#' || key.length !== 2) continue;
    const name = key[1];
    if (!event.tags.some((t) => t[0] === name && values.includes(t[1]))) return false;
  }
  return true;
}

const tag = (event, name) => event.tags.find((t) => t[0] === name)?.[1];

export async function startRelay({ port = 0, host = '127.0.0.1', behaviour = {} } = {}) {
  /** @type {Behaviour} */
  let how = { ...behaviour };
  const stored = [];
  const sockets = new Set();
  const stats = { connections: 0, events: 0, accepted: 0, rejected: 0, reqs: 0, auths: 0 };

  const http = createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if ((req.headers.accept ?? '').includes('application/nostr+json') && how.nip11 !== false) {
      const doc = { name: 'qrst test relay', supported_nips: [1, 11, 42], ...(how.nip11 ?? {}) };
      return res.writeHead(200, { ...cors, 'Content-Type': 'application/nostr+json' }).end(JSON.stringify(doc));
    }
    res.writeHead(404, cors).end('this is a relay');
  });
  const wss = new WebSocketServer({ server: http, maxPayload: 1 << 20 });

  wss.on('connection', (ws) => {
    stats.connections++;
    const client = { ws, subs: new Map(), challenge: randomBytes(16).toString('hex'), authed: new Set() };
    sockets.add(client);
    const send = (message) => ws.readyState === 1 && ws.send(JSON.stringify(message));
    if (how.authRequired || how.recipientOnly) send(['AUTH', client.challenge]);

    ws.on('close', () => sockets.delete(client));
    ws.on('message', (data) => {
      if (how.silent) return;
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return send(['NOTICE', 'invalid: not JSON']);
      }
      const [type, a, b] = message;

      if (type === 'AUTH') {
        stats.auths++;
        const ok =
          a && a.kind === 22242 && verifyEvent(a) && tag(a, 'challenge') === client.challenge &&
          Math.abs(Date.now() / 1000 - a.created_at) < 600;
        if (ok) client.authed.add(a.pubkey);
        return send(['OK', a?.id ?? '', Boolean(ok), ok ? '' : 'invalid: bad auth event']);
      }

      if (type === 'EVENT') {
        stats.events++;
        const event = a;
        const refuse = (why) => {
          stats.rejected++;
          send(['OK', event?.id ?? '', false, why]);
        };
        if (!event || typeof event !== 'object' || !verifyEvent(event)) return refuse('invalid: bad signature or id');
        if ((how.authRequired === 'write' || how.authRequired === 'both') && client.authed.size === 0) {
          return refuse('auth-required: authenticate to publish');
        }
        if (how.rejectWrites) return refuse(how.rejectWrites);
        if (how.rejectKinds?.includes(event.kind)) return refuse('blocked: kind not accepted here');
        if (how.maxEventBytes && JSON.stringify(event).length > how.maxEventBytes) return refuse('invalid: event too large');
        if (event.kind === 22242) return refuse('invalid: auth events are not published');
        stats.accepted++;
        send(['OK', event.id, true, '']);
        if (how.swallow) return;
        const ephemeral = event.kind >= 20000 && event.kind < 30000;
        if (!ephemeral && !stored.some((e) => e.id === event.id)) stored.push(event);
        const deliver = () => {
          for (const other of sockets) {
            for (const [subId, filters] of other.subs) {
              if (!filters.some((f) => matches(f, event))) continue;
              if (how.recipientOnly && event.kind === 1059 && !other.authed.has(tag(event, 'p'))) continue;
              other.ws.readyState === 1 && other.ws.send(JSON.stringify(['EVENT', subId, event]));
            }
          }
        };
        return how.delayMs ? setTimeout(deliver, how.delayMs) : deliver();
      }

      if (type === 'REQ') {
        stats.reqs++;
        const subId = a;
        const filters = message.slice(2);
        if ((how.authRequired === 'read' || how.authRequired === 'both') && client.authed.size === 0) {
          return send(['CLOSED', subId, 'auth-required: authenticate to read']);
        }
        client.subs.set(subId, filters);
        for (const filter of filters) {
          let found = stored.filter((e) => matches(filter, e));
          if (how.recipientOnly) found = found.filter((e) => e.kind !== 1059 || client.authed.has(tag(e, 'p')));
          found.sort((x, y) => y.created_at - x.created_at);
          for (const e of found.slice(0, filter.limit ?? 500)) send(['EVENT', subId, e]);
        }
        return send(['EOSE', subId]);
      }

      if (type === 'CLOSE') {
        client.subs.delete(a);
        return;
      }
      void b;
    });
  });

  await new Promise((resolve) => http.listen(port, host, resolve));
  const actual = http.address().port;
  return {
    url: `ws://${host === '127.0.0.1' ? 'localhost' : host}:${actual}`,
    port: actual,
    stats,
    stored,
    /** Replace the behaviour while running. */
    set(next) {
      how = { ...next };
    },
    /** Store an event as if it had been published. */
    inject(event) {
      stored.push(event);
    },
    /** Drop every open connection, as a relay restart would. */
    kick() {
      for (const c of sockets) c.ws.terminate();
    },
    async close() {
      for (const c of sockets) c.ws.terminate();
      wss.close();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRelay({ port: Number(process.argv[2] ?? 7777) }).then((relay) => console.log(`test relay listening on ${relay.url}`));
}
