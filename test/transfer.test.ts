// Two devices, real WebSockets, a local relay: the whole stack below the UI.

import { afterEach, describe, expect, it } from 'vitest';
import { type Env, demoText, parseUri } from '../src/core/index.ts';
import { Store, Transfer, type TransferDeps, type TransferView } from '../src/web/index.ts';
import { type Behaviour, type TestRelay, startRelay } from '../tools/test-relay.mjs';

const env: Env = { random: (n) => crypto.getRandomValues(new Uint8Array(n)), now: () => Math.floor(Date.now() / 1000) };
const timing = { echoMs: 800, connectMs: 900, graceMs: 100, nip11Ms: 400, queryMs: 500, retryMs: 150 };
const SECRET = 'correct horse battery staple';

const relays: TestRelay[] = [];
const transfers: Transfer<string>[] = [];
async function relay(behaviour: Behaviour = {}) {
  const r = await startRelay({ behaviour });
  relays.push(r);
  return r;
}
afterEach(async () => {
  for (const t of transfers.splice(0)) t.dispose();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

function device(configured: string[]): TransferDeps<string> {
  return {
    profile: demoText,
    store: new Store(undefined, env.now, [], configured),
    env,
    baseUrl: 'https://qrst.example/',
    origin: 'https://qrst.example',
    replenish: false,
    timing,
  };
}

const track = (t: Transfer<string>) => (transfers.push(t), t);

function until(t: Transfer<string>, predicate: (v: TransferView<string>) => boolean, ms = 6000): Promise<TransferView<string>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; last view: ${JSON.stringify(t.view().session)} log: ${t.view().log.join(' | ')}`)), ms);
    const check = () => {
      const v = t.view();
      if (predicate(v)) {
        clearTimeout(timer);
        resolve(v);
      }
    };
    const previous = t.onChange;
    t.onChange = () => {
      previous();
      check();
    };
    check();
  });
}

async function runFlowA(showDeps: TransferDeps<string>, joinDeps: TransferDeps<string>) {
  const receiver = track(Transfer.show(showDeps, 'receiver'));
  const shown = await until(receiver, (v) => v.uri !== undefined);
  const params = parseUri(shown.uri!);
  expect(params.mode).toBe('offer');
  expect(Transfer.refusal(joinDeps, params)).toBeUndefined();
  const sender = track(Transfer.join(joinDeps, params, { viaCamera: false }, SECRET));
  const code = (await until(receiver, (v) => v.session.phase === 'code')).session.code!;
  await until(sender, (v) => v.session.phase === 'release');
  sender.enterCode(code);
  await until(receiver, (v) => v.session.phase === 'accept');
  receiver.accept();
  const done = await until(sender, (v) => v.stage === 'ended');
  return { receiver, sender, done, params };
}

describe('Flow A over a relay', () => {
  it('moves the secret and both sides agree it arrived', async () => {
    const r = await relay();
    const a = device([r.url]);
    const b = device([]);
    const { receiver, done, params } = await runFlowA(a, b);
    expect(done.session.outcome).toBe('delivered');
    expect(receiver.view().value).toBe(SECRET);
    expect(receiver.view().session.outcome).toBe('received');
    expect(params.origin).toBe('https://qrst.example');
    // §14 on both, and §11.3a "learned" on the device that scanned
    expect(a.store.records()).toHaveLength(1);
    expect(b.store.records()[0]).toMatchObject({ role: 'sender', outcome: 'delivered', transport: 'relay', relays: [r.url] });
    expect(b.store.candidates()).toContainEqual({ url: r.url, source: 'learned' });
  });

  it('the relay never sees the secret, the code, or either burner', async () => {
    const r = await relay();
    const { receiver, params } = await runFlowA(device([r.url]), device([]));
    const everything = JSON.stringify(r.stored);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(Buffer.from(SECRET).toString('base64'));
    // the showing burner appears only as a recipient tag, never as an author
    expect(r.stored.every((e) => e.kind === 1059)).toBe(true);
    expect(r.stored.some((e) => e.pubkey === params.pub)).toBe(false);
    expect(receiver.view().value).toBe(SECRET);
  });

  it('works through a relay that demands authentication only after the first publish (§11.5 outbox)', async () => {
    const r = await relay({ authRequired: 'both', recipientOnly: true });
    const { done } = await runFlowA(device([r.url]), device([]));
    expect(done.session.outcome).toBe('delivered');
  });

  it('survives the relay dropping every connection mid-session', async () => {
    const r = await relay();
    const receiver = track(Transfer.show(device([r.url]), 'receiver'));
    const params = parseUri((await until(receiver, (v) => v.uri !== undefined)).uri!);
    const sender = track(Transfer.join(device([]), params, { viaCamera: true }, SECRET));
    const code = (await until(receiver, (v) => v.session.phase === 'code')).session.code!;
    await until(sender, (v) => v.session.phase === 'release');
    r.kick();
    await until(sender, (v) => !v.connected);
    sender.enterCode(code); // published into the outbox while offline
    await until(receiver, (v) => v.session.phase === 'accept', 8000);
    receiver.accept();
    expect((await until(sender, (v) => v.stage === 'ended', 8000)).session.outcome).toBe('delivered');
  });

  it('completes when one of the two listed relays dies after the code is shown', async () => {
    const r1 = await relay();
    const r2 = await relay();
    const receiver = track(Transfer.show(device([r1.url, r2.url]), 'receiver'));
    const params = parseUri((await until(receiver, (v) => v.uri !== undefined && v.relays.filter((x) => x.inUse).length === 2)).uri!);
    expect(params.relays).toHaveLength(2);
    await r1.close();
    relays.splice(relays.indexOf(r1), 1);
    const sender = track(Transfer.join(device([]), params, { viaCamera: true }, SECRET));
    const code = (await until(receiver, (v) => v.session.phase === 'code')).session.code!;
    sender.enterCode(code);
    await until(receiver, (v) => v.session.phase === 'accept');
    receiver.accept();
    expect((await until(sender, (v) => v.stage === 'ended')).session.outcome).toBe('delivered');
  });
});

describe('Flow B over a relay', () => {
  it('moves the secret when the Sender shows the code', async () => {
    const r = await relay();
    const sender = track(Transfer.show(device([r.url]), 'sender', SECRET));
    const params = parseUri((await until(sender, (v) => v.uri !== undefined)).uri!);
    expect(params.mode).toBe('request');
    const receiver = track(Transfer.join(device([]), params, { viaCamera: true }));
    const code = (await until(receiver, (v) => v.session.phase === 'code')).session.code!;
    await until(sender, (v) => v.session.phase === 'release');
    expect(sender.view().session.code).toBeUndefined();
    sender.enterCode(code);
    await until(receiver, (v) => v.session.phase === 'accept');
    expect(receiver.view().session.rendering).toBe('28 characters, starting with “cor”');
    receiver.accept();
    expect((await until(sender, (v) => v.stage === 'ended')).session.outcome).toBe('delivered');
    expect(receiver.view().value).toBe(SECRET);
  });
});

describe('refusals before a burner is made', () => {
  it('an unknown profile, a role collision, and a throttled burner', async () => {
    const r = await relay();
    const shower = track(Transfer.show(device([r.url]), 'receiver'));
    const params = parseUri((await until(shower, (v) => v.uri !== undefined)).uri!);
    const d = device([]);
    expect(Transfer.refusal(d, { ...params, profile: 'something-else' })).toBe('unknown-profile');
    // a device already set to receive scans a code that would make it... the Sender: fine
    expect(Transfer.refusal(d, params, 'sender')).toBeUndefined();
    // a device already set to receive scans another Receiver's code
    expect(Transfer.refusal(d, params, 'receiver')).toBe('role-collision');
    d.store.noteFailedSession([params.pub]);
    expect(Transfer.refusal(d, params)).toBe('blocked-peer');
  });
});

describe('the throttle is written by a failed session (§9.3)', () => {
  it('five wrong codes block that burner and count one failed session', async () => {
    const r = await relay();
    const receiver = track(Transfer.show(device([r.url]), 'receiver'));
    const params = parseUri((await until(receiver, (v) => v.uri !== undefined)).uri!);
    const d = device([]);
    const sender = track(Transfer.join(d, params, { viaCamera: true }, SECRET));
    const code = (await until(receiver, (v) => v.session.phase === 'code')).session.code!;
    await until(sender, (v) => v.session.phase === 'release');
    const bad = code === '00000' ? '00001' : '00000';
    for (let i = 0; i < 5; i++) sender.enterCode(bad);
    expect(sender.view().session.outcome).toBe('attempts-exhausted');
    expect(d.store.isBlocked(params.pub)).toBe(true);
    expect(d.store.shouldWarnOfInterference()).toBe(false);
    d.store.noteFailedSession([]);
    d.store.noteFailedSession([]);
    expect(d.store.shouldWarnOfInterference()).toBe(true);
    // The device that showed the code is told, and goes back to waiting for another answer.
    await until(receiver, (v) => v.session.phase === 'waiting' && v.log.some((l) => l.includes('ABORT')));
  });
});

describe('one relay cannot make another relay\'s delivery disappear', () => {
  it('junk under a real event id is not remembered as that event', async () => {
    const { Pool } = await import('../src/web/index.ts');
    const { Session, generateSecretKey, publicKey } = await import('../src/core/index.ts');
    const a = generateSecretKey(env.random);
    const b = generateSecretKey(env.random);
    const sender = new Session<string>({ role: 'sender', showing: false, profile: demoText, secretKey: a, peerPub: publicKey(b), token: '00'.repeat(16), payload: 'x', env });
    const wrap = sender.start().find((e) => e.t === 'publish')!;
    const event = (wrap as { event: { id: string; content: string } }).event;
    const got: unknown[] = [];
    const pool = new Pool({ filter: {}, signAuth: () => { throw new Error('unused'); }, onEvent: (e) => got.push(e) });
    const link = { url: 'wss://x' } as never;
    pool.incoming(link, { ...event, content: 'garbage' });
    pool.incoming(link, event);
    pool.incoming(link, event);
    expect(got).toEqual([event]);
    pool.close();
  });
});
