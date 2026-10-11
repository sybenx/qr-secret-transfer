// Wraps are ephemeral (kind 21059): a relay hands one to whoever is subscribed at that
// moment and keeps nothing, or keeps it a few minutes. A peer whose socket is down
// when a message is published never sees it, and only the sender's re-sends (§11.5)
// get the session through. Each test here cuts one device off at one step of the
// exchange, at the moment the message meant for it goes out, and checks that the
// transfer still completes once it is back, against both ways relays treat
// ephemeral events.

import { afterEach, describe, expect, it } from 'vitest';
import { type Env, KINDS, demoText, parseUri } from '../src/core/index.ts';
import { Store, Transfer, type TransferDeps, type TransferView } from '../src/web/index.ts';
import { type Behaviour, type TestRelay, startRelay } from '../tools/test-relay.mjs';
import { type Flaky, flaky } from './flaky.ts';

const env: Env = { random: (n) => crypto.getRandomValues(new Uint8Array(n)), now: () => Math.floor(Date.now() / 1000) };
const timing = { echoMs: 800, connectMs: 900, graceMs: 100, nip11Ms: 400, queryMs: 500, retryMs: 150, resendMs: 250, finalMs: 4000 };
const SECRET = 'correct horse battery staple';

const relays: TestRelay[] = [];
const transfers: Transfer<string>[] = [];
afterEach(async () => {
  for (const t of transfers.splice(0)) t.dispose();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

async function relay(behaviour: Behaviour) {
  const r = await startRelay({ behaviour });
  relays.push(r);
  return r;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, ms = 4000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error('timed out');
    await sleep(10);
  }
}

function until(t: Transfer<string>, predicate: (v: TransferView<string>) => boolean, ms = 10_000): Promise<TransferView<string>> {
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

function device(configured: string[], net: Flaky): TransferDeps<string> {
  return {
    profile: demoText,
    store: new Store(undefined, env.now, [], configured),
    env,
    baseUrl: 'https://qrst.example/',
    origin: 'https://qrst.example',
    replenish: false,
    timing,
    net: { WebSocketImpl: net.WebSocketImpl },
  };
}

const track = (t: Transfer<string>) => (transfers.push(t), t);

type Step = 'contact' | 'NONCE' | 'REVEAL' | 'PAYLOAD' | 'ACK';
const STEPS: Step[] = ['contact', 'NONCE', 'REVEAL', 'PAYLOAD', 'ACK'];

/**
 * Runs one transfer, cutting off the device a message at `step` is addressed to while
 * that message (and a few re-sends of it) goes out, then bringing it back.
 */
async function transferLosing(step: Step, flow: 'A' | 'B', r: TestRelay) {
  const showNet = flaky();
  const joinNet = flaky();
  const showRole = flow === 'A' ? 'receiver' : 'sender';
  const shower = track(Transfer.show(device([r.url], showNet), showRole, flow === 'B' ? SECRET : undefined));
  const params = parseUri((await until(shower, (v) => v.uri !== undefined)).uri!);
  const [sender, receiver] = flow === 'A' ? [() => joiner, () => shower] : [() => shower, () => joiner];
  const [senderNet, receiverNet] = flow === 'A' ? [joinNet, showNet] : [showNet, joinNet];

  /** The message for `victim` has reached the relay while `victim` was away, and so have some re-sends. */
  const lose = async (victim: Flaky, before: number) => {
    expect(victim.isDown).toBe(true);
    await waitFor(() => r.received.length > before);
    await sleep(3 * timing.resendMs);
    victim.up();
  };

  let lost: Promise<void> = Promise.resolve();
  // contact: the showing device is away when the contacting one speaks first.
  if (step === 'contact') showNet.down();
  // NONCE: the contacting device's first message gets out, and then it is gone.
  if (step === 'NONCE') lost = joinNet.downAfterSending().then(() => lose(joinNet, r.received.length));
  // REVEAL: the showing device answers with its NONCE, and then it is gone.
  if (step === 'REVEAL') lost = showNet.downAfterSending().then(() => lose(showNet, r.received.length));

  const before = r.received.length;
  const joiner = track(Transfer.join(device([], joinNet), params, { viaCamera: true }, flow === 'A' ? SECRET : undefined));
  if (step === 'contact') await lose(showNet, before);
  await lost;

  const code = (await until(receiver(), (v) => v.session.phase === 'code')).session.code!;
  await until(sender(), (v) => v.session.phase === 'release');
  if (step === 'PAYLOAD') {
    receiverNet.down();
    const at = r.received.length;
    sender().enterCode(code);
    await lose(receiverNet, at);
  } else {
    sender().enterCode(code);
  }

  await until(receiver(), (v) => v.session.phase === 'accept');
  if (step === 'ACK') {
    senderNet.down();
    const at = r.received.length;
    receiver().accept();
    await lose(senderNet, at);
  } else {
    receiver().accept();
  }

  const done = await until(sender(), (v) => v.stage === 'ended');
  return { done, receiver: receiver() };
}

describe.each([
  ['keeps nothing (ditto, snort.social)', 'live'],
  ['keeps ephemeral events five minutes and refuses repeats (strfry)', 'strfry'],
] as const)('over a relay that %s', (_, ephemeral) => {
  for (const flow of ['A', 'B'] as const) {
    for (const step of STEPS) {
      it(`Flow ${flow}: completes when the recipient of the ${step === 'contact' ? (flow === 'A' ? 'HELLO' : 'REQUEST') : step} is away as it goes out`, async () => {
        const r = await relay({ ephemeral });
        const { done, receiver } = await transferLosing(step, flow, r);
        expect(done.session.outcome).toBe('delivered');
        expect(receiver.view().session.outcome).toBe('received');
        expect(receiver.view().value).toBe(SECRET);
        expect(r.stored).toEqual([]);
        expect(r.received.every((e) => e.kind === KINDS.WRAP)).toBe(true);
        // On a relay that keeps nothing, some wrap really did reach no one: what got the
        // message through was a re-send.
        if (ephemeral === 'live') expect(r.received.some((e) => !r.deliveries.has(e.id))).toBe(true);
        // A strfry-like relay refuses a repeated id; every re-send was a fresh wrap.
        expect(new Set(r.received.map((e) => e.id)).size).toBe(r.received.length);
      });
    }
  }
});

describe('re-sending (§11.5)', () => {
  it('stops sending a message once the peer has answered it', async () => {
    const r = await relay({ ephemeral: 'live' });
    const shower = track(Transfer.show(device([r.url], flaky()), 'receiver'));
    const params = parseUri((await until(shower, (v) => v.uri !== undefined)).uri!);
    const joiner = track(Transfer.join(device([], flaky()), params, { viaCamera: true }, SECRET));
    await until(shower, (v) => v.session.phase === 'code');
    await until(joiner, (v) => v.session.phase === 'release');
    // Both now wait on the user. The Receiver's NONCE was answered by the REVEAL, so it
    // has nothing outstanding; the Sender's REVEAL has no answer until the ACK, so it
    // goes on going out.
    const count = () => r.received.filter((e) => e.tags.some((t) => t[0] === 'p' && t[1] === params.pub)).length;
    const toShower = count();
    const total = r.received.length;
    await sleep(6 * timing.resendMs);
    const fromJoiner = count() - toShower;
    expect(fromJoiner).toBeGreaterThanOrEqual(3);
    expect(r.received.length - total).toBe(fromJoiner);
  });

  it('takes a PAYLOAD that a relay serves ahead of the REVEAL it depends on', async () => {
    // With no code to read, the Sender can release while the Receiver is away. A relay
    // that kept both then serves them newest first, PAYLOAD before REVEAL, and the
    // PAYLOAD must still be taken when it comes round again.
    const r = await relay({ ephemeral: 'strfry' });
    const showNet = flaky();
    const shower = track(Transfer.show({ ...device([r.url], showNet), check: 'none' }, 'receiver'));
    const params = parseUri((await until(shower, (v) => v.uri !== undefined)).uri!);
    const away = showNet.downAfterSending(); // its NONCE gets out, and then it is gone
    const joiner = track(Transfer.join({ ...device([], flaky()), check: 'none' }, params, { viaCamera: true }, SECRET));
    await away;
    await until(joiner, (v) => v.session.phase === 'release');
    const before = r.received.length;
    joiner.release();
    await waitFor(() => r.received.length > before);
    showNet.up();
    await until(shower, (v) => v.session.phase === 'accept');
    expect(shower.view().log.some((l) => l.includes('arrived before its REVEAL'))).toBe(true);
    shower.accept();
    expect((await until(joiner, (v) => v.stage === 'ended')).session.outcome).toBe('delivered');
    expect(shower.view().value).toBe(SECRET);
  });

  it('reconnects at once when the page comes back, instead of waiting out its backoff', async () => {
    const r = await relay({ ephemeral: 'live' });
    const showNet = flaky();
    const shower = track(Transfer.show(device([r.url], showNet), 'receiver'));
    const params = parseUri((await until(shower, (v) => v.uri !== undefined)).uri!);
    showNet.down();
    track(Transfer.join(device([], flaky()), params, { viaCamera: true }, SECRET));
    await waitFor(() => r.received.length > 0 && !shower.view().connected);
    // Long enough for the reconnect backoff to have grown to several seconds.
    await sleep(3200);
    showNet.up();
    const started = Date.now();
    shower.wake(); // what visibilitychange to visible, or the browser's online event, does
    await until(shower, (v) => v.session.phase === 'code', 2000);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
