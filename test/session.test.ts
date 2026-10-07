import { base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  ACK_WAIT_SECONDS,
  KINDS,
  MAX_ATTEMPTS,
  type Profile,
  SESSION_SECONDS,
  SLACK_SECONDS,
  buildRumor,
  demoText,
  sas,
} from '../src/core/index.ts';
import { Net, committed, outcomeOf, records } from './net.ts';

const SECRET = 'sk-live-4f9a0c1d2e3b';

const wrong = (code: string) => (code === '00000' ? '00001' : '00000');

/** Flow A: the Receiver shows the QR, the Sender scans it. */
function flowA(net = new Net<string>(demoText)) {
  const receiver = net.add('receiver', 'receiver', true);
  const sender = net.add('sender', 'sender', false, { peerPub: receiver.pub, payload: SECRET });
  net.run(sender, sender.session.start());
  return { net, receiver, sender };
}

/** Flow B: the Sender shows the QR, the Receiver scans it. */
function flowB(net = new Net<string>(demoText)) {
  const sender = net.add('sender', 'sender', true, { payload: SECRET });
  const receiver = net.add('receiver', 'receiver', false, { peerPub: sender.pub });
  net.run(receiver, receiver.session.start());
  return { net, receiver, sender };
}

describe('Flow A (§7): Receiver shows, Sender scans', () => {
  it('delivers after the Sender types the code shown on the Receiver', () => {
    const { net, receiver, sender } = flowA();
    expect(net.kinds()).toEqual([KINDS.HELLO, KINDS.NONCE, KINDS.REVEAL]);
    expect(sender.session.view().phase).toBe('release');
    expect(receiver.session.view().phase).toBe('code');

    const code = receiver.session.view().code!;
    expect(code).toMatch(/^[0-9]{5}$/);
    net.run(sender, sender.session.enterCode(code));
    expect(sender.session.view().phase).toBe('sent');
    expect(receiver.session.view().phase).toBe('accept');
    expect(receiver.session.view().rendering).toBe('20 characters, starting with “sk-”');
    // step 15: held, MUST NOT commit
    expect(committed(receiver)).toEqual([]);

    net.run(receiver, receiver.session.accept());
    expect(committed(receiver)).toEqual([SECRET]);
    expect(outcomeOf(receiver)).toBe('received');
    expect(outcomeOf(sender)).toBe('delivered');
    expect(net.kinds()).toEqual([KINDS.HELLO, KINDS.NONCE, KINDS.REVEAL, KINDS.PAYLOAD, KINDS.ACK]);
  });

  it('the code is the §6 transcript in role order', () => {
    const { net, receiver, sender } = flowA();
    const nonceS = net.sent.find((m) => m.rumor.kind === KINDS.REVEAL)!.rumor.tags[0]![1]!;
    const nonceR = net.sent.find((m) => m.rumor.kind === KINDS.NONCE)!.rumor.tags[0]![1]!;
    expect(receiver.session.view().code).toBe(
      sas({ v: 1, profile: 'qrst-demo-text', senderPub: sender.pub, receiverPub: receiver.pub, senderNonce: nonceS, receiverNonce: nonceR }),
    );
  });
});

describe('Flow B (§8): Sender shows, Receiver scans', () => {
  it('delivers after the Sender types the code shown on the Receiver', () => {
    const { net, receiver, sender } = flowB();
    expect(net.kinds()).toEqual([KINDS.REQUEST, KINDS.NONCE, KINDS.REVEAL]);
    expect(sender.session.view().phase).toBe('release');
    expect(receiver.session.view().phase).toBe('code');

    net.run(sender, sender.session.enterCode(receiver.session.view().code!));
    expect(receiver.session.view().phase).toBe('accept');
    net.run(receiver, receiver.session.accept());
    expect(committed(receiver)).toEqual([SECRET]);
    expect(outcomeOf(sender)).toBe('delivered');
    expect(net.kinds()).toEqual([KINDS.REQUEST, KINDS.NONCE, KINDS.REVEAL, KINDS.PAYLOAD, KINDS.ACK]);
  });

  it('the code is the §6 transcript in role order, though the Receiver made contact', () => {
    const { net, receiver, sender } = flowB();
    const nonceR = net.sent.find((m) => m.rumor.kind === KINDS.REVEAL)!.rumor.tags[0]![1]!;
    const nonceS = net.sent.find((m) => m.rumor.kind === KINDS.NONCE)!.rumor.tags[0]![1]!;
    expect(receiver.session.view().code).toBe(
      sas({ v: 1, profile: 'qrst-demo-text', senderPub: sender.pub, receiverPub: receiver.pub, senderNonce: nonceS, receiverNonce: nonceR }),
    );
  });
});

for (const [name, flow] of [['Flow A', flowA], ['Flow B', flowB]] as const) {
  describe(`${name}: what is and is not on the wire`, () => {
    it('messages carry exactly the fields §11.4 defines and nothing else', () => {
      const { net, receiver, sender } = flow();
      net.run(sender, sender.session.enterCode(receiver.session.view().code!));
      net.run(receiver, receiver.session.accept());
      for (const m of net.sent) {
        const { kind, tags, content } = m.rumor;
        if (kind === KINDS.HELLO || kind === KINDS.REQUEST) {
          expect(tags).toEqual([
            ['commit', expect.stringMatching(/^[0-9a-f]{64}$/)],
            ['token', expect.stringMatching(/^[0-9a-f]{32}$/)],
            ['check', 'type'],
          ]);
        }
        else if (kind === KINDS.NONCE || kind === KINDS.REVEAL) expect(tags).toEqual([['nonce', expect.stringMatching(/^[0-9a-f]{64}$/)]]);
        else expect(tags).toEqual([]);
        if (kind === KINDS.PAYLOAD) expect(content).toBe(base64.encode(new TextEncoder().encode(SECRET)));
        else expect(content).toBe('');
      }
    });

    it('nothing is released before the code is typed, and the Sender never shows a code', () => {
      const { net, receiver, sender } = flow();
      expect(net.kinds()).not.toContain(KINDS.PAYLOAD);
      expect(sender.session.view().code).toBeUndefined();
      net.run(sender, sender.session.enterCode(receiver.session.view().code!));
      expect(sender.session.view().code).toBeUndefined();
      expect(net.kinds().filter((k) => k === KINDS.PAYLOAD)).toHaveLength(1);
    });

    it('every wrap comes from a different one-time key and names only the recipient', () => {
      const { net, receiver, sender } = flow();
      net.run(sender, sender.session.enterCode(receiver.session.view().code!));
      net.run(receiver, receiver.session.accept());
      const outer = net.sent.map((m) => m.event.pubkey);
      expect(new Set(outer).size).toBe(outer.length);
      for (const m of net.sent) {
        const sentBy = m.from === 'sender' ? sender.pub : receiver.pub;
        expect(JSON.stringify(m.event)).not.toContain(sentBy);
      }
    });

    it('a wrong code releases nothing; five wrong codes end the session and name the burner (§9.2, §9.3)', () => {
      const { net, receiver, sender } = flow();
      const bad = wrong(receiver.session.view().code!);
      for (let i = 1; i < MAX_ATTEMPTS; i++) {
        net.run(sender, sender.session.enterCode(bad));
        expect(sender.session.view().attemptsLeft).toBe(MAX_ATTEMPTS - i);
        expect(sender.session.view().phase).toBe('release');
      }
      net.run(sender, sender.session.enterCode(bad));
      expect(outcomeOf(sender)).toBe('attempts-exhausted');
      expect(net.kinds()).not.toContain(KINDS.PAYLOAD);
      expect(net.kinds().at(-1)).toBe(KINDS.ABORT);
      expect(sender.effects).toContainEqual({ t: 'failed-peers', pubs: [receiver.pub] });
      // A device that scanned ends; a device that showed the code goes back to waiting (§13).
      if (receiver.session.showing) expect(receiver.session.view().phase).toBe('waiting');
      else expect(outcomeOf(receiver)).toBe('peer-aborted');
      // the session will not resume
      expect(sender.session.enterCode(receiver.session.view().code ?? '12345')).toEqual([]);
    });

    it('a typo followed by the right code still delivers, and blames nobody', () => {
      const { net, receiver, sender } = flow();
      const code = receiver.session.view().code!;
      net.run(sender, sender.session.enterCode(wrong(code)));
      net.run(sender, sender.session.enterCode(code));
      net.run(receiver, receiver.session.accept());
      expect(outcomeOf(sender)).toBe('delivered');
      expect(sender.effects.some((e) => e.t === 'failed-peers')).toBe(false);
    });

    it('rejects anything that is not exactly five digits', () => {
      const { sender } = flow();
      for (const bad of ['1234', '123456', '12a45', ' 1234', '']) expect(() => sender.session.enterCode(bad)).toThrow();
      expect(sender.session.view().attemptsLeft).toBe(MAX_ATTEMPTS);
    });

    it('the Sender declining releases nothing and tells the other device', () => {
      const { net, receiver, sender } = flow();
      net.run(sender, sender.session.decline());
      expect(outcomeOf(sender)).toBe('declined');
      if (receiver.session.showing) expect(receiver.session.view().phase).toBe('waiting');
      else expect(outcomeOf(receiver)).toBe('peer-aborted');
      expect(net.kinds()).not.toContain(KINDS.PAYLOAD);
    });

    it('the Receiver discarding keeps nothing and tells the Sender (§9.4)', () => {
      const { net, receiver, sender } = flow();
      net.run(sender, sender.session.enterCode(receiver.session.view().code!));
      net.run(receiver, receiver.session.decline());
      expect(committed(receiver)).toEqual([]);
      expect(outcomeOf(receiver)).toBe('declined');
      expect(outcomeOf(sender)).toBe('peer-aborted');
      // the secret did leave the Sender, so the Sender still owes itself a record (§14)
      expect(records(sender)).toHaveLength(1);
      expect(records(receiver)).toHaveLength(0);
    });

    it('writes the §14 record on both devices', () => {
      const { net, receiver, sender } = flow();
      const code = receiver.session.view().code!;
      net.run(sender, sender.session.enterCode(code));
      net.run(receiver, receiver.session.accept());
      expect(records(sender)).toEqual([
        { ts: net.clock.t, profile: 'qrst-demo-text', role: 'sender', outcome: 'delivered', sas: code, peer: receiver.pub, multi: false, check: 'type' },
      ]);
      expect(records(receiver)).toEqual([
        { ts: net.clock.t, profile: 'qrst-demo-text', role: 'receiver', outcome: 'received', sas: code, peer: sender.pub, multi: false, check: 'type' },
      ]);
    });

    it('wipes both burners when the session ends', () => {
      const { net, receiver, sender } = flow();
      net.run(sender, sender.session.enterCode(receiver.session.view().code!));
      net.run(receiver, receiver.session.accept());
      expect(sender.ownedSecret.every((b) => b === 0)).toBe(true);
      expect(receiver.ownedSecret.every((b) => b === 0)).toBe(true);
    });

    it('is unmoved by every wrap arriving three times, as several relays would deliver it', () => {
      const net = new Net<string>(demoText);
      net.copies = 3;
      const { receiver, sender } = flow(net);
      net.run(sender, sender.session.enterCode(receiver.session.view().code!));
      net.run(receiver, receiver.session.accept());
      expect(committed(receiver)).toEqual([SECRET]);
      expect(outcomeOf(sender)).toBe('delivered');
      expect(net.kinds()).toHaveLength(5);
    });

    it('expires after ten minutes', () => {
      const { net, receiver, sender } = flow();
      net.clock.advance(SESSION_SECONDS - 1);
      expect(sender.session.tick()).toEqual([]);
      net.clock.advance(1);
      // Each device runs its own clock; neither needs the other's ABORT to stop.
      net.filter = () => false;
      net.run(sender, sender.session.tick());
      net.run(receiver, receiver.session.tick());
      expect(outcomeOf(sender)).toBe('expired');
      expect(outcomeOf(receiver)).toBe('expired');
      expect(net.kinds().filter((k) => k === KINDS.ABORT)).toHaveLength(2);
    });

    it('stops waiting for the acknowledgement after 60 s, and records the release', () => {
      const { net, receiver, sender } = flow();
      net.filter = (m) => m.rumor.kind !== KINDS.ACK;
      net.run(sender, sender.session.enterCode(receiver.session.view().code!));
      net.run(receiver, receiver.session.accept());
      net.clock.advance(ACK_WAIT_SECONDS - 1);
      expect(sender.session.tick()).toEqual([]);
      net.clock.advance(1);
      net.run(sender, sender.session.tick());
      expect(outcomeOf(sender)).toBe('sent-unconfirmed');
      expect(records(sender)).toHaveLength(1);
    });

    it('is deterministic: the same randomness and clock give the same bytes', () => {
      const run = () => {
        const { net, receiver, sender } = flow();
        net.run(sender, sender.session.enterCode(receiver.session.view().code!));
        net.run(receiver, receiver.session.accept());
        return JSON.stringify(net.sent.map((m) => m.event));
      };
      expect(run()).toBe(run());
    });
  });
}

describe('messages that do not belong (§11.4)', () => {
  it('a message outside the session window is discarded entirely', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    const late = (offset: number) =>
      buildRumor({ kind: KINDS.HELLO, tags: [['commit', '11'.repeat(32)], ['token', receiver.session.token]] }, '22'.repeat(32).replace(/^22/, '02'), net.clock.t + offset);
    expect(receiver.session.receiveRumor(late(-SLACK_SECONDS - 1)).some((e) => e.t === 'publish')).toBe(false);
    expect(receiver.session.receiveRumor(late(SESSION_SECONDS + SLACK_SECONDS + 1)).some((e) => e.t === 'publish')).toBe(false);
    expect(receiver.session.view().ready).toBe(0);
  });

  it('a message at the edge of the window is accepted', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    const other = net.add('other', 'sender', false, { peerPub: receiver.pub, payload: 'x' });
    const edge = buildRumor({ kind: KINDS.HELLO, tags: [['commit', '11'.repeat(32)], ['token', receiver.session.token]] }, other.pub, net.clock.t - SLACK_SECONDS);
    expect(receiver.session.receiveRumor(edge).some((e) => e.t === 'publish')).toBe(true);
  });

  it('the wrong message for the role is ignored', () => {
    const { receiver, sender, net } = flowA();
    const fromSender = (kind: number, tags: string[][] = []) => buildRumor({ kind, tags }, sender.pub, net.clock.t);
    const fromReceiver = (kind: number, tags: string[][] = [], content = '') => buildRumor({ kind, tags, content }, receiver.pub, net.clock.t);
    // a showing Receiver takes HELLO, never REQUEST; a Sender never takes a PAYLOAD
    expect(receiver.session.receiveRumor(fromSender(KINDS.REQUEST, [['commit', '11'.repeat(32)]]))).toEqual([]);
    expect(sender.session.receiveRumor(fromReceiver(KINDS.PAYLOAD, [], 'eA=='))).toEqual([]);
    // an ACK before anything was released means nothing
    expect(sender.session.receiveRumor(fromReceiver(KINDS.ACK))).toEqual([]);
    expect(sender.session.view().phase).toBe('release');
  });

  it('the contacting device takes a NONCE only from the burner in the QR', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    const sender = net.add('sender', 'sender', false, { peerPub: receiver.pub, payload: SECRET });
    net.filter = () => false; // the real NONCE never arrives
    net.run(sender, sender.session.start());
    const impostor = net.add('impostor', 'receiver', true);
    const forged = buildRumor({ kind: KINDS.NONCE, tags: [['nonce', '33'.repeat(32)]] }, impostor.pub, net.clock.t);
    expect(sender.session.receiveRumor(forged)).toEqual([]);
    expect(sender.session.view().phase).toBe('waiting');
  });

  it('a reveal that does not open the commitment drops that peer and derives no code', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    const sender = net.add('sender', 'sender', false, { peerPub: receiver.pub, payload: SECRET });
    net.filter = (m) => m.rumor.kind !== KINDS.REVEAL; // hold the honest reveal back
    net.run(sender, sender.session.start());
    const forged = buildRumor({ kind: KINDS.REVEAL, tags: [['nonce', '44'.repeat(32)]] }, sender.pub, net.clock.t);
    receiver.session.receiveRumor(forged);
    expect(receiver.session.view().phase).toBe('waiting');
    expect(receiver.session.view().code).toBeUndefined();
    expect(receiver.session.view().ready).toBe(0);
  });

  it('a payload that is not of the declared profile is refused and the Sender is told (P4)', () => {
    const notBase64: Profile<string> = { ...demoText, encode: (v) => `!!${v}!!` };
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    const sender = net.add('sender', 'sender', false, { peerPub: receiver.pub, payload: SECRET, profile: notBase64 });
    net.run(sender, sender.session.start());
    net.run(sender, sender.session.enterCode(receiver.session.view().code!));
    expect(committed(receiver)).toEqual([]);
    expect(outcomeOf(receiver)).toBe('bad-payload');
    expect(outcomeOf(sender)).toBe('peer-aborted');
  });
});

describe('multiple responders (§13)', () => {
  it('Flow A: a stranger who answered first cannot make the real Sender release to them', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    const stranger = net.add('stranger', 'sender', false, { peerPub: receiver.pub, payload: 'planted' });
    const sender = net.add('sender', 'sender', false, { peerPub: receiver.pub, payload: SECRET });
    net.run(stranger, stranger.session.start());
    net.run(sender, sender.session.start());

    const v = receiver.session.view();
    expect(v.multipleResponders).toBe(true);
    expect(v.canAdvance).toBe(true);
    // A later responder MUST NOT abort the session.
    expect(v.phase).toBe('code');

    // The stranger's code is on screen. Typed into the real Sender, it does not match.
    const strangersCode = v.code!;
    net.run(sender, sender.session.enterCode(strangersCode));
    expect(sender.session.view().attemptsLeft).toBe(MAX_ATTEMPTS - 1);
    expect(net.kinds()).not.toContain(KINDS.PAYLOAD);

    // The user says so on the Receiver, which shows the next candidate's code instead.
    net.run(receiver, receiver.session.advance());
    const realCode = receiver.session.view().code!;
    expect(realCode).not.toBe(strangersCode);
    net.run(sender, sender.session.enterCode(realCode));
    expect(receiver.session.view().rendering).toContain('20 characters');
    net.run(receiver, receiver.session.accept());
    expect(committed(receiver)).toEqual([SECRET]);
    expect(records(receiver)[0]!.multi).toBe(true);
  });

  it('Flow A: a payload from a candidate whose code was never shown is dropped, not held', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    const sender = net.add('sender', 'sender', false, { peerPub: receiver.pub, payload: SECRET });
    const stranger = net.add('stranger', 'sender', false, { peerPub: receiver.pub, payload: 'planted' });
    net.run(sender, sender.session.start());
    net.run(stranger, stranger.session.start());
    // The stranger skips the comparison and pushes a payload straight at the Receiver.
    const planted = buildRumor({ kind: KINDS.PAYLOAD, content: demoText.encode('planted') }, stranger.pub, net.clock.t);
    receiver.session.receiveRumor(planted);
    expect(receiver.session.view().phase).toBe('code');
    expect(receiver.session.view().canAdvance).toBe(false);

    net.run(sender, sender.session.enterCode(receiver.session.view().code!));
    net.run(receiver, receiver.session.accept());
    expect(committed(receiver)).toEqual([SECRET]);
  });

  it('Flow A: a planted payload from the active candidate is shown for what it is and can be discarded', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    const stranger = net.add('stranger', 'sender', false, { peerPub: receiver.pub, payload: 'planted-by-a-stranger' });
    net.run(stranger, stranger.session.start());
    // The stranger knows the code for its own session and "types" it.
    net.run(stranger, stranger.session.enterCode(receiver.session.view().code!));
    expect(receiver.session.view().phase).toBe('accept');
    expect(receiver.session.view().rendering).toBe('21 characters, starting with “pla”');
    expect(committed(receiver)).toEqual([]);
    net.run(receiver, receiver.session.decline());
    expect(committed(receiver)).toEqual([]);
  });

  it('Flow A: holds three candidates and turns the fourth away', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    for (const name of ['a', 'b', 'c', 'd']) {
      const n = net.add(name, 'sender', false, { peerPub: receiver.pub, payload: name });
      net.run(n, n.session.start());
    }
    expect(receiver.session.view().ready).toBe(3);
    expect(receiver.session.view().dropped).toBe(1);
    expect(net.nodes.find((n) => n.name === 'd')!.session.view().phase).toBe('waiting');
  });

  it('Flow A: a retransmitted HELLO from the same burner is not a second responder', () => {
    const { net, receiver, sender } = flowA();
    const again = buildRumor({ kind: KINDS.HELLO, tags: [['commit', '55'.repeat(32)], ['token', receiver.session.token]] }, sender.pub, net.clock.t);
    expect(receiver.session.receiveRumor(again)).toEqual([]);
    expect(receiver.session.view().multipleResponders).toBe(false);
  });

  it('Flow B: with two requests pending, the code picks the Receiver whose screen was read', () => {
    const net = new Net<string>(demoText);
    const sender = net.add('sender', 'sender', true, { payload: SECRET });
    const stranger = net.add('stranger', 'receiver', false, { peerPub: sender.pub });
    const receiver = net.add('receiver', 'receiver', false, { peerPub: sender.pub });
    net.run(stranger, stranger.session.start());
    net.run(receiver, receiver.session.start());
    expect(sender.session.view().ready).toBe(2);
    expect(sender.session.view().multipleResponders).toBe(true);

    net.run(sender, sender.session.enterCode(receiver.session.view().code!));
    const payloads = net.sent.filter((m) => m.rumor.kind === KINDS.PAYLOAD);
    expect(payloads.map((m) => m.to)).toEqual(['receiver']);
    expect(outcomeOf(stranger)).toBe('peer-aborted');
    net.run(receiver, receiver.session.accept());
    expect(committed(receiver)).toEqual([SECRET]);
    expect(committed(stranger)).toEqual([]);
  });

  it('Flow B: queues five requests and turns the sixth away', () => {
    const net = new Net<string>(demoText);
    const sender = net.add('sender', 'sender', true, { payload: SECRET });
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const n = net.add(name, 'receiver', false, { peerPub: sender.pub });
      net.run(n, n.session.start());
    }
    expect(sender.session.view().ready).toBe(5);
    expect(sender.session.view().dropped).toBe(1);
  });
});

describe('restart throttle (§9.3)', () => {
  it('a Sender will not contact a burner it failed a code against', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    const sender = net.add('sender', 'sender', false, { peerPub: receiver.pub, payload: SECRET, isBlocked: (p) => p === receiver.pub });
    net.run(sender, sender.session.start());
    expect(outcomeOf(sender)).toBe('blocked-peer');
    expect(net.sent).toHaveLength(0);
  });

  it('a Sender that showed the code ignores a request from such a burner', () => {
    const net = new Net<string>(demoText);
    let blocked = '';
    const sender = net.add('sender', 'sender', true, { payload: SECRET, isBlocked: (p) => p === blocked });
    const receiver = net.add('receiver', 'receiver', false, { peerPub: sender.pub });
    blocked = receiver.pub;
    net.run(receiver, receiver.session.start());
    expect(sender.session.view().ready).toBe(0);
    expect(net.kinds()).toEqual([KINDS.REQUEST]);
  });
});

describe('construction', () => {
  it('refuses a payload that does not fit before a burner is used', () => {
    const net = new Net<string>(demoText);
    expect(() => net.add('s', 'sender', true, { payload: 'x'.repeat(2049) })).toThrow();
  });
  it('refuses to pair a device with itself', () => {
    const net = new Net<string>(demoText);
    const a = net.add('a', 'receiver', true);
    expect(() => net.add('a', 'sender', false, { peerPub: a.pub, payload: 'x' })).toThrow();
  });
});

// Found in review. The contacting party learns the other side's nonce before it reveals
// its own, so it knows the code first. It must not be able to walk away and ask again.
describe('one nonce exchange per burner, and a cap for the whole session (§6, §13)', () => {
  const hello = (net: Net<string>, pub: string, n: number) =>
    buildRumor({ kind: KINDS.HELLO, tags: [['commit', String(n).padStart(64, '0')], ['token', net.nodes[0]!.session.token]] }, pub, net.clock.t + n);
  const abort = (net: Net<string>, pub: string, n: number) => buildRumor({ kind: KINDS.ABORT }, pub, net.clock.t + n);

  it('a burner that aborts cannot contact again for a fresh code', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    const grinder = net.add('grinder', 'sender', false, { peerPub: receiver.pub, payload: 'x' });
    let nonces = 0;
    for (let i = 0; i < 20; i++) {
      nonces += receiver.session.receiveRumor(hello(net, grinder.pub, i)).filter((e) => e.t === 'publish').length;
      receiver.session.receiveRumor(abort(net, grinder.pub, 100 + i));
    }
    expect(nonces).toBe(1);
  });

  it('fresh burners are capped over the session, not by how many are held at once', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    let nonces = 0;
    for (let i = 0; i < 10; i++) {
      const g = net.add(`g${i}`, 'sender', false, { peerPub: receiver.pub, payload: 'x' });
      nonces += receiver.session.receiveRumor(hello(net, g.pub, i)).filter((e) => e.t === 'publish').length;
      receiver.session.receiveRumor(abort(net, g.pub, 100 + i));
    }
    expect(nonces).toBe(3);
    expect(receiver.session.view().dropped).toBe(7);
    expect(receiver.session.view().multipleResponders).toBe(true);
  });

  it('one ABORT from a stranger does not end a session that showed the code', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    const stranger = net.add('stranger', 'sender', false, { peerPub: receiver.pub, payload: 'x' });
    net.run(stranger, stranger.session.start());
    net.run(stranger, stranger.session.decline());
    expect(receiver.session.view().phase).toBe('waiting');
    const sender = net.add('sender', 'sender', false, { peerPub: receiver.pub, payload: SECRET });
    net.run(sender, sender.session.start());
    expect(receiver.session.view().multipleResponders).toBe(true);
    net.run(sender, sender.session.enterCode(receiver.session.view().code!));
    net.run(receiver, receiver.session.accept());
    expect(committed(receiver)).toEqual([SECRET]);
  });
});

describe('the ten minutes hold without a timer', () => {
  it('a code typed, a payload accepted or a message received after expiry ends the session instead', () => {
    for (const act of ['enter', 'accept', 'receive'] as const) {
      const { net, receiver, sender } = flowA();
      const code = receiver.session.view().code!;
      if (act === 'accept') net.run(sender, sender.session.enterCode(code));
      net.clock.advance(SESSION_SECONDS + 1);
      net.filter = () => false;
      if (act === 'enter') {
        net.run(sender, sender.session.enterCode(code));
        expect(outcomeOf(sender)).toBe('expired');
        expect(net.kinds()).not.toContain(KINDS.PAYLOAD);
      } else if (act === 'accept') {
        net.run(receiver, receiver.session.accept());
        expect(outcomeOf(receiver)).toBe('expired');
        expect(committed(receiver)).toEqual([]);
      } else {
        receiver.session.receiveRumor(buildRumor({ kind: KINDS.ACK }, sender.pub, net.clock.t));
        expect(outcomeOf(receiver)).toBe('expired');
      }
    }
  });
});

describe('text survives exactly', () => {
  it('a leading byte-order mark is not eaten', () => {
    const text = '\ufeffsecret';
    expect(demoText.check(demoText.encode(text))).toEqual({ ok: true, value: text });
  });
});
