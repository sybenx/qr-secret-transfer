// The three levels of check: type a code, compare a code, or no code. Each device
// has a setting, the stricter applies, and a second responder is never hidden.

import { describe, expect, it } from 'vitest';
import { type CodeCheck, KINDS, MAX_ATTEMPTS, buildRumor, demoText } from '../src/core/index.ts';
import { Net, committed, outcomeOf, records } from './net.ts';

const SECRET = 'sk-live-4f9a0c1d2e3b';

/** Flow A: the Receiver shows the QR, the Sender scans it. */
function flowA(receiverCheck: CodeCheck, senderCheck: CodeCheck, net = new Net<string>(demoText)) {
  const receiver = net.add('receiver', 'receiver', true, { check: receiverCheck });
  const sender = net.add('sender', 'sender', false, { peerPub: receiver.pub, payload: SECRET, check: senderCheck });
  net.run(sender, sender.session.start());
  return { net, receiver, sender };
}

/** Flow B: the Sender shows the QR, the Receiver scans it. */
function flowB(senderCheck: CodeCheck, receiverCheck: CodeCheck, net = new Net<string>(demoText)) {
  const sender = net.add('sender', 'sender', true, { payload: SECRET, check: senderCheck });
  const receiver = net.add('receiver', 'receiver', false, { peerPub: sender.pub, check: receiverCheck });
  net.run(receiver, receiver.session.start());
  return { net, receiver, sender };
}

const flows = [
  ['Flow A', (a: CodeCheck, b: CodeCheck) => flowA(a, b)],
  ['Flow B', (a: CodeCheck, b: CodeCheck) => flowB(a, b)],
] as const;

describe('the token: only a device that saw the code is a responder', () => {
  it('a contact that does not echo the token is ignored, not counted', () => {
    const net = new Net<string>(demoText);
    const sender = net.add('sender', 'sender', true, { payload: SECRET, check: 'none' });
    // Someone watching a relay learns the burner key from the loopback probe or a
    // subscription, but not the token, which is only in the QR.
    const watcher = net.add('watcher', 'receiver', false, { peerPub: sender.pub, token: 'ff'.repeat(16) });
    net.run(watcher, watcher.session.start());
    expect(sender.session.view().ready).toBe(0);
    expect(sender.session.view().multipleResponders).toBe(false);
    expect(net.kinds()).toEqual([KINDS.REQUEST]);

    // The real device still gets through, and with no code nothing was ended by the watcher.
    const receiver = net.add('receiver', 'receiver', false, { peerPub: sender.pub, check: 'none' });
    net.run(receiver, receiver.session.start());
    net.run(sender, sender.session.release());
    net.run(receiver, receiver.session.accept());
    expect(committed(receiver)).toEqual([SECRET]);
  });

  it('a contact with no token at all is ignored', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true);
    const bare = buildRumor({ kind: KINDS.HELLO, tags: [['commit', '11'.repeat(32)]] }, '02'.padEnd(64, '3'), net.clock.t);
    expect(receiver.session.receiveRumor(bare).some((e) => e.t === 'publish')).toBe(false);
  });
});

describe('the stricter setting applies', () => {
  for (const [name, flow] of flows) {
    it(`${name}: whichever device asks for typing gets typing`, () => {
      for (const [a, b] of [['none', 'type'], ['type', 'none'], ['compare', 'type'], ['type', 'compare']] as const) {
        const { receiver, sender } = flow(a, b);
        expect(sender.session.view().check).toBe('type');
        expect(receiver.session.view().check).toBe('type');
        expect(sender.session.view().compare).toBeUndefined();
        // Neither of the weaker actions does anything.
        expect(sender.session.release()).toEqual([]);
        expect(sender.session.confirmMatch()).toEqual([]);
        expect(receiver.session.view().code).toMatch(/^[0-9]{5}$/);
      }
    });

    it(`${name}: compare beats no code`, () => {
      for (const [a, b] of [['none', 'compare'], ['compare', 'none']] as const) {
        const { receiver, sender } = flow(a, b);
        expect(sender.session.view().check).toBe('compare');
        expect(receiver.session.view().check).toBe('compare');
        expect(sender.session.release()).toEqual([]);
        expect(sender.session.enterCode(receiver.session.view().code!)).toEqual([]);
      }
    });
  }

  it('a link with no check, or one this device does not know, means typing', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true, { check: 'none' });
    const sender = net.add('sender', 'sender', false, { peerPub: receiver.pub, payload: SECRET, check: 'none', peerCheck: 'loose' as CodeCheck });
    net.run(sender, sender.session.start());
    expect(sender.session.view().check).toBe('type');
    expect(receiver.session.view().check).toBe('type');
  });
});

describe('compare a code', () => {
  for (const [name, flow] of flows) {
    it(`${name}: both screens show the same five digits, and confirming sends`, () => {
      const { net, receiver, sender } = flow('compare', 'compare');
      const shown = sender.session.view().compare!;
      expect(shown).toMatch(/^[0-9]{5}$/);
      expect(receiver.session.view().code).toBe(shown);
      expect(net.kinds()).not.toContain(KINDS.PAYLOAD);

      net.run(sender, sender.session.confirmMatch());
      expect(sender.session.view().compare).toBeUndefined();
      net.run(receiver, receiver.session.accept());
      expect(committed(receiver)).toEqual([SECRET]);
      expect(outcomeOf(sender)).toBe('delivered');
      expect(records(sender)[0]!.check).toBe('compare');
      expect(records(receiver)[0]!.check).toBe('compare');
    });

    it(`${name}: "they differ" spends an attempt, and five end the session`, () => {
      const { net, receiver, sender } = flow('compare', 'compare');
      for (let i = 1; i < MAX_ATTEMPTS; i++) {
        net.run(sender, sender.session.rejectMatch());
        expect(sender.session.view().attemptsLeft).toBe(MAX_ATTEMPTS - i);
        // A Sender that showed the code has nobody else to compare, so it waits for another device.
        if (sender.session.showing) {
          expect(sender.session.view().phase).toBe('waiting');
          expect(sender.session.view().compare).toBeUndefined();
          return;
        }
      }
      net.run(sender, sender.session.rejectMatch());
      expect(outcomeOf(sender)).toBe('attempts-exhausted');
      expect(net.kinds()).not.toContain(KINDS.PAYLOAD);
      expect(sender.effects).toContainEqual({ t: 'failed-peers', pubs: [receiver.pub] });
    });
  }

  it('Flow B: the device that answered first is compared first; "they differ" moves to the next', () => {
    const net = new Net<string>(demoText);
    const sender = net.add('sender', 'sender', true, { payload: SECRET, check: 'compare' });
    const stranger = net.add('stranger', 'receiver', false, { peerPub: sender.pub, check: 'compare' });
    const receiver = net.add('receiver', 'receiver', false, { peerPub: sender.pub, check: 'compare' });
    net.run(stranger, stranger.session.start());
    net.run(receiver, receiver.session.start());
    // The race is reported, not hidden.
    expect(sender.session.view().multipleResponders).toBe(true);
    expect(sender.session.view().compare).toBe(stranger.session.view().code);

    net.run(sender, sender.session.rejectMatch());
    expect(sender.session.view().attemptsLeft).toBe(MAX_ATTEMPTS - 1);
    expect(sender.session.view().compare).toBe(receiver.session.view().code);
    net.run(sender, sender.session.confirmMatch());
    expect(net.sent.filter((m) => m.rumor.kind === KINDS.PAYLOAD).map((m) => m.to)).toEqual(['receiver']);
    expect(outcomeOf(stranger)).toBe('peer-aborted');
    net.run(receiver, receiver.session.accept());
    expect(committed(receiver)).toEqual([SECRET]);
  });

  it('Flow A: a stranger who answered first shows a code the real Sender does not', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true, { check: 'compare' });
    const stranger = net.add('stranger', 'sender', false, { peerPub: receiver.pub, payload: 'planted', check: 'compare' });
    const sender = net.add('sender', 'sender', false, { peerPub: receiver.pub, payload: SECRET, check: 'compare' });
    net.run(stranger, stranger.session.start());
    net.run(sender, sender.session.start());
    expect(receiver.session.view().multipleResponders).toBe(true);
    expect(receiver.session.view().code).not.toBe(sender.session.view().compare);

    net.run(sender, sender.session.rejectMatch());
    net.run(receiver, receiver.session.advance());
    expect(receiver.session.view().code).toBe(sender.session.view().compare);
    net.run(sender, sender.session.confirmMatch());
    net.run(receiver, receiver.session.accept());
    expect(committed(receiver)).toEqual([SECRET]);
  });
});

describe('no code', () => {
  for (const [name, flow] of flows) {
    it(`${name}: consent alone sends, and no digits are shown anywhere`, () => {
      const { net, receiver, sender } = flow('none', 'none');
      expect(sender.session.view().phase).toBe('release');
      expect(sender.session.view().compare).toBeUndefined();
      expect(receiver.session.view().code).toBeUndefined();
      expect(net.kinds()).not.toContain(KINDS.PAYLOAD);

      net.run(sender, sender.session.release());
      expect(receiver.session.view().phase).toBe('accept');
      expect(receiver.session.view().code).toBeUndefined();
      net.run(receiver, receiver.session.accept());
      expect(committed(receiver)).toEqual([SECRET]);
      expect(records(sender)[0]!.check).toBe('none');
    });
  }

  it('Flow B: a second device answering ends the session on all three, and nothing moves', () => {
    const net = new Net<string>(demoText);
    const sender = net.add('sender', 'sender', true, { payload: SECRET, check: 'none' });
    const receiver = net.add('receiver', 'receiver', false, { peerPub: sender.pub, check: 'none' });
    const stranger = net.add('stranger', 'receiver', false, { peerPub: sender.pub, check: 'none' });
    net.run(stranger, stranger.session.start());
    expect(sender.session.view().phase).toBe('release');
    net.run(receiver, receiver.session.start());

    expect(outcomeOf(sender)).toBe('second-responder');
    expect(outcomeOf(receiver)).toBe('second-responder');
    expect(outcomeOf(stranger)).toBe('second-responder');
    expect(net.kinds()).not.toContain(KINDS.PAYLOAD);
    expect(sender.session.release()).toEqual([]);
  });

  it('Flow A: a second Sender ends the session before anything planted can be kept', () => {
    const net = new Net<string>(demoText);
    const receiver = net.add('receiver', 'receiver', true, { check: 'none' });
    const stranger = net.add('stranger', 'sender', false, { peerPub: receiver.pub, payload: 'planted', check: 'none' });
    net.run(stranger, stranger.session.start());
    net.run(stranger, stranger.session.release());
    expect(receiver.session.view().phase).toBe('accept');

    const sender = net.add('sender', 'sender', false, { peerPub: receiver.pub, payload: SECRET, check: 'none' });
    net.run(sender, sender.session.start());
    expect(outcomeOf(receiver)).toBe('second-responder');
    expect(outcomeOf(sender)).toBe('second-responder');
    expect(committed(receiver)).toEqual([]);
    expect(net.sent.filter((m) => m.rumor.kind === KINDS.PAYLOAD).map((m) => m.from)).toEqual(['stranger']);
  });

  it('a device answering after the text has gone is still reported', () => {
    const { net, sender } = flowB('none', 'none');
    net.run(sender, sender.session.release());
    const late = net.add('late', 'receiver', false, { peerPub: sender.pub, check: 'none' });
    net.run(late, late.session.start());
    expect(sender.session.view().phase).toBe('sent');
    expect(sender.session.view().multipleResponders).toBe(true);
  });

  it('typing and comparing do nothing when there is no code', () => {
    const { receiver, sender } = flowA('none', 'none');
    expect(sender.session.enterCode('12345')).toEqual([]);
    expect(sender.session.confirmMatch()).toEqual([]);
    expect(sender.session.rejectMatch()).toEqual([]);
    expect(receiver.session.view().phase).toBe('code');
  });
});
