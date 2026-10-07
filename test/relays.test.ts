// Relay transport and relay selection, against real WebSockets and a local relay that
// can be told to misbehave the way public relays do.

import { finalizeEvent, generateSecretKey as ntKey } from 'nostr-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { type Env, KINDS, Session, demoText, generateSecretKey } from '../src/core/index.ts';
import { Pool, type RelayProgress, Store, loopbackOnce, rankDiscovered, relayInfo, ruledOutBy, selectRelays } from '../src/web/index.ts';
import { startRelay } from '../tools/test-relay.mjs';

type Relay = Awaited<ReturnType<typeof startRelay>>;

const env: Env = { random: (n) => crypto.getRandomValues(new Uint8Array(n)), now: () => Math.floor(Date.now() / 1000) };
const timing = { echoMs: 700, connectMs: 900, graceMs: 150, nip11Ms: 500, queryMs: 700, retryMs: 150 };
const DEAD = 'ws://localhost:9'; // discard port: nothing listens

const open: Relay[] = [];
const pools: Pool[] = [];
async function relay(behaviour: Record<string, unknown> = {}): Promise<Relay> {
  const r = await startRelay({ behaviour });
  open.push(r);
  return r;
}
afterEach(async () => {
  for (const p of pools.splice(0)) p.close();
  await Promise.all(open.splice(0).map((r) => r.close()));
});

function showing() {
  const session = new Session<string>({ role: 'receiver', showing: true, profile: demoText, secretKey: generateSecretKey(env.random), env });
  const received: unknown[] = [];
  const pool = new Pool({
    filter: session.filter(),
    signAuth: (u, c) => session.signAuth(u, c),
    onEvent: (e) => received.push(e),
  });
  pools.push(pool);
  const probe = session.probe();
  pool.ignore(probe.id);
  return { session, pool, probe, received };
}

describe('loopback test (§11.3a)', () => {
  const once = (url: string) => loopbackOnce(url, demoText, env, { timing });

  it('passes a relay that accepts and returns a maximum-size wrap', async () => {
    const r = await relay();
    expect(await once(r.url)).toEqual({ ok: true });
    // the probe really was the size of the profile's largest payload
    const probe = r.stored.find((e: { kind: number }) => e.kind === KINDS.WRAP);
    expect(JSON.stringify(probe).length).toBeGreaterThan(6500);
  });

  it('fails a relay that cannot be reached', async () => {
    expect(await once(DEAD)).toEqual({ ok: false, reason: 'could not connect' });
  });

  it('fails a relay that refuses writes from an unknown key, and says why', async () => {
    const r = await relay({ rejectWrites: 'blocked: members only' });
    expect(await once(r.url)).toEqual({ ok: false, reason: 'refused: blocked: members only' });
  });

  it('fails a relay that does not accept gift wraps', async () => {
    const r = await relay({ rejectKinds: [1059] });
    expect((await once(r.url)).reason).toMatch(/^refused: blocked/);
  });

  it('fails a relay that says OK and delivers nothing', async () => {
    const r = await relay({ swallow: true });
    expect(await once(r.url)).toEqual({ ok: false, reason: 'accepted the event but did not deliver it' });
  });

  it('fails a relay that opens a socket and never answers', async () => {
    const r = await relay({ silent: true });
    expect(await once(r.url)).toEqual({ ok: false, reason: 'no answer' });
  });

  it('fails a relay too small for the profile, though it would pass a small event', async () => {
    const r = await relay({ maxEventBytes: 4000 });
    expect((await once(r.url)).reason).toMatch(/too large/);
  });

  it('fails a relay whose answer comes after the deadline', async () => {
    const r = await relay({ delayMs: 1200 });
    expect((await once(r.url)).ok).toBe(false);
  });

  it('passes a relay that demands NIP-42, authenticating with the burner (§11.5)', async () => {
    for (const authRequired of ['write', 'read', 'both']) {
      const r = await relay({ authRequired });
      expect(await once(r.url), authRequired).toEqual({ ok: true });
      expect(r.stats.auths).toBe(1);
    }
  });

  it('passes a relay that serves gift wraps only to the authenticated recipient (NIP-17)', async () => {
    const r = await relay({ recipientOnly: true });
    expect(await once(r.url)).toEqual({ ok: true });
  });

  it('never hands the probe to the session', async () => {
    const r = await relay();
    const { pool, probe, received } = showing();
    expect(await pool.loopback(r.url, probe, timing.echoMs, timing.connectMs)).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toEqual([]);
  });
});

describe('advertised limits (§11.6)', () => {
  it('reads NIP-11 and rules out a relay that advertises too little or wants payment', async () => {
    const { probe } = showing();
    const small = await relay({ nip11: { limitation: { max_content_length: 4096 } } });
    const paid = await relay({ nip11: { limitation: { payment_required: true } } });
    const roomy = await relay({ nip11: { limitation: { max_content_length: 8196, max_message_length: 16384 } } });
    const mute = await relay({ nip11: false });
    expect(ruledOutBy(await relayInfo(small.url, 500), probe)).toMatch(/content limit of 4096/);
    expect(ruledOutBy(await relayInfo(paid.url, 500), probe)).toBe('requires payment');
    expect(ruledOutBy(await relayInfo(roomy.url, 500), probe)).toBeUndefined();
    expect(await relayInfo(mute.url, 500)).toBeUndefined();
    expect(await relayInfo(DEAD, 300)).toBeUndefined();
    // and the loopback as a whole respects it, even though the relay would have carried the event
    expect((await loopbackOnce(small.url, demoText, env, { timing })).ok).toBe(false);
    expect((await loopbackOnce(roomy.url, demoText, env, { timing })).ok).toBe(true);
  });

  it('the default maximum fits the smallest limit the specification names', () => {
    const { probe } = showing();
    expect(ruledOutBy({ maxContentLength: 8196 }, probe)).toBeUndefined();
  });
});

function store(seeds: string[] = [], adopter: string[] = []) {
  return new Store(undefined, env.now, seeds, adopter);
}

async function select(s: Store, extra: { hints?: string[] } = {}) {
  const { pool, probe } = showing();
  const seen: RelayProgress[][] = [];
  const listed = await selectRelays({
    pool,
    store: s,
    probe,
    now: env.now,
    onProgress: (p) => seen.push(p),
    timing,
    ...(extra.hints ? { discoveryHints: extra.hints } : {}),
  });
  return { listed, pool, last: seen.at(-1) ?? [] };
}

describe('relay selection (§11.3a)', () => {
  it('lists only relays that passed, and leaves the others out with a reason', async () => {
    const good = await relay();
    const closed = await relay({ rejectWrites: 'blocked: no' });
    const s = store([], [closed.url, DEAD, good.url]);
    const { listed, last, pool } = await select(s);
    expect(listed).toEqual([good.url]);
    expect(last.find((p) => p.url === closed.url)).toMatchObject({ state: 'failed', why: 'refused: blocked: no' });
    // once the tests still in flight have finished, the pool holds the passing relay alone
    await expect.poll(() => pool.all().map((l) => l.url), { timeout: 2000 }).toEqual([good.url]);
  });

  it('works with no seed at all when a configured relay passes', async () => {
    const good = await relay();
    const { listed } = await select(store([], [good.url]));
    expect(listed).toEqual([good.url]);
  });

  it('does not fail because its seeds are dead while another source passes', async () => {
    const good = await relay();
    const s = store([DEAD, 'ws://localhost:1'], []);
    s.notePass(good.url, 'discovered');
    const { listed } = await select(s);
    expect(listed).toEqual([good.url]);
  });

  it('prefers configured and remembered relays, and does not touch a seed when they pass', async () => {
    const mine = await relay();
    const seed = await relay();
    const s = store([seed.url], [mine.url]);
    const { listed } = await select(s);
    expect(listed).toEqual([mine.url]);
    expect(seed.stats.connections).toBe(0);
  });

  it('falls back to a seed when nothing else is known, then remembers it', async () => {
    const seed = await relay();
    const s = store([seed.url]);
    expect((await select(s)).listed).toEqual([seed.url]);
    expect(s.candidates()[0]).toEqual({ url: seed.url, source: 'remembered' });
  });

  it('lists several when several pass, up to its target', async () => {
    const relays = await Promise.all([relay(), relay(), relay(), relay(), relay()]);
    const { listed } = await select(store([], relays.map((r) => r.url)));
    expect(listed.length).toBe(3);
  });

  it('does not wait for a slow relay once one has passed', async () => {
    const fast = await relay();
    const slow = await relay({ delayMs: 600 });
    const started = Date.now();
    const { listed } = await select(store([], [slow.url, fast.url]));
    expect(listed).toEqual([fast.url]);
    expect(Date.now() - started).toBeLessThan(550);
  });

  it('finds a relay through NIP-66 discovery when its seeds only read', async () => {
    const good = await relay();
    // A seed that answers queries but refuses our writes, holding what a monitor published.
    const readOnlySeed = await relay({ rejectWrites: 'blocked: read only' });
    const monitor = ntKey();
    readOnlySeed.inject(
      finalizeEvent(
        { kind: 30166, created_at: env.now(), content: '', tags: [['d', good.url], ['n', 'clearnet'], ['R', '!auth'], ['R', '!payment']] },
        monitor,
      ),
    );
    const s = store([readOnlySeed.url]);
    const { pool, probe } = showing();
    const listed = await selectRelays({
      pool, store: s, probe, now: env.now, onProgress: () => {}, timing, net: { allowLoopbackDiscovery: true },
    });
    expect(listed).toEqual([good.url]);
    // and next time it is simply a relay that passed here before
    expect(s.candidates()[0]).toEqual({ url: good.url, source: 'remembered' });
  });

  it('never lets a report point it at a relay on this machine', () => {
    const local = { kind: 30166, pubkey: 'aa'.repeat(32), created_at: env.now(), content: '', tags: [['d', 'ws://localhost:1234']] };
    expect(rankDiscovered([local], env.now())).toEqual([]);
  });

  it('reaches a live relay that sits behind more dead ones than one batch holds', async () => {
    const good = await relay();
    const dead = Array.from({ length: 9 }, (_, i) => `ws://localhost:${i + 1}`);
    const { listed } = await select(store([], [...dead, good.url]));
    expect(listed).toEqual([good.url]);
  });

  it('keeps trying when nothing passes, and succeeds when a relay comes back', async () => {
    const r = await relay({ rejectWrites: 'blocked: maintenance' });
    const s = store([r.url]);
    setTimeout(() => r.set({}), 500);
    const { listed } = await select(s);
    expect(listed).toEqual([r.url]);
  });

  it('forgets nothing when nothing passes: that is more likely this device than every relay', async () => {
    const s = store([], []);
    s.notePass(DEAD, 'learned');
    const { pool, probe } = showing();
    const done = selectRelays({ pool, store: s, probe, now: env.now, onProgress: () => {}, timing });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    pool.close();
    expect(await done).toEqual([]);
    expect(s.memos().find((m) => m.url === DEAD)).toMatchObject({ fails: 0 });
  });
});

describe('NIP-66 ranking', () => {
  const event = (d: string, tags: string[][] = [], age = 0, pubkey = 'aa'.repeat(32)) => ({
    kind: 30166,
    pubkey,
    created_at: env.now() - age,
    content: '',
    tags: [['d', d], ...tags],
  });
  it('drops what cannot work and orders the rest by what monitors report', () => {
    const ranked = rankDiscovered(
      [
        event('wss://paid.example', [['R', 'payment']]),
        event('wss://nowraps.example', [['k', '!1059']]),
        event('wss://tor.example', [['n', 'tor']]),
        event('wss://abcdef.onion'),
        event('ws://plain.example'),
        event('wss://stale.example', [], 40 * 24 * 3600),
        event('wss://plain.example'),
        event('wss://good.example', [['R', '!auth'], ['R', '!payment'], ['k', '1059'], ['rtt-open', '120']]),
        event('wss://two.example', [['R', '!payment']], 0, 'bb'.repeat(32)),
        event('wss://two.example', [['R', '!payment']], 0, 'cc'.repeat(32)),
        { not: 'an event' },
      ],
      env.now(),
      () => 0.5,
    );
    expect(ranked).toEqual(['wss://good.example', 'wss://two.example', 'wss://plain.example']);
  });
});
