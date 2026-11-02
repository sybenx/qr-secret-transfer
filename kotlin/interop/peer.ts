// A QRST peer driven over stdin/stdout, built from the TypeScript reference
// implementation in ../qr-secret-transfer. The Kotlin InteropTest spawns it.
//
//   node --experimental-transform-types interop/peer.ts <path-to-qr-secret-transfer> <relay-url>
//
// Commands (one per line): show <sender|receiver> <check> [payload] | join <uri> [payload]
//   | code <digits> | match | release | accept | quit
// Output: URI <uri> | VIEW <json>

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const [repo, relay] = process.argv.slice(2);
const core = await import(pathToFileURL(`${repo}/src/core/index.ts`).href);
const web = await import(pathToFileURL(`${repo}/src/web/index.ts`).href);
core.relayPolicy.loopback = true;

const env = { random: (n: number) => crypto.getRandomValues(new Uint8Array(n)), now: () => Math.floor(Date.now() / 1000) };

// profiles/nostr-nsec.md, as the reference would define it.
const nsec = {
  id: 'nostr-nsec',
  maxPayloadBytes: 2048,
  revocable: false,
  minCheck: 'type',
  encode: (v: string) => v,
  check: (c: string) => (/^[0-9a-f]{64}$/.test(c) ? { ok: true, value: c } : { ok: false, reason: 'not hex' }),
  render: (v: string) => `npub of ${v.slice(0, 4)}`,
  direction: { offer: '', request: '' },
  release: { heading: '', body: '', confirm: () => '', decline: '' },
  accept: { heading: '', confirm: '', decline: '' },
};

let transfer: any;
let profile: any = core.demoText;
let lastUri: string | undefined;
let lastView = '';

function deps(check: string) {
  return {
    profile,
    store: new web.Store(undefined, env.now, [], [relay]),
    env,
    baseUrl: 'https://qrst.example/',
    origin: 'https://qrst.example',
    replenish: false,
    check,
    timing: { echoMs: 1500, connectMs: 2000, graceMs: 100, nip11Ms: 400, queryMs: 500, retryMs: 300 },
  };
}

function watch(t: any) {
  transfer = t;
  t.onChange = () => {
    const v = t.view();
    if (v.uri && v.uri !== lastUri) {
      lastUri = v.uri;
      console.log(`URI ${v.uri}`);
    }
    const s = v.session;
    const line = JSON.stringify({ phase: s.phase, check: s.check, code: s.code, compare: s.compare, outcome: s.outcome, rendering: s.rendering, value: v.value });
    if (line !== lastView) {
      lastView = line;
      console.log(`VIEW ${line}`);
    }
  };
}

for await (const raw of createInterface({ input: process.stdin })) {
  const [cmd, a, b, c] = raw.trim().split(' ');
  try {
    switch (cmd) {
      case 'profile': profile = a === 'nostr-nsec' ? nsec : core.demoText; break;
      case 'show': watch(web.Transfer.show(deps(b!), a, c)); break;
      case 'join': watch(web.Transfer.join(deps(c ?? 'type'), core.parseUri(a!), { viaCamera: true }, b === '_' ? undefined : b)); break;
      case 'code': transfer.enterCode(a); break;
      case 'match': transfer.confirmMatch(); break;
      case 'release': transfer.release(); break;
      case 'accept': transfer.accept(); break;
      case 'quit': transfer?.dispose(); process.exit(0);
    }
  } catch (e) {
    console.log(`ERROR ${(e as Error).message}`);
  }
}
