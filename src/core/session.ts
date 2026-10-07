// One transfer session: the state machine of spec §7 (Flow A) and §8 (Flow B), the
// commit-then-reveal exchange of §6, the consent rules of §9 that can be enforced in
// code, and the multiple-responder handling of §13.
//
// This file performs no I/O. It is handed gift wraps and user decisions, and it
// returns effects for a host to carry out: events to publish, a payload to keep, a
// record to write. Randomness and the clock are injected, so a whole flow replays
// byte for byte in a test.
//
// Vocabulary. The device that SHOWS the QR listens; the device that scans it is the
// CONTACTING party and speaks first. Which of them is the Sender is a separate
// question, and the code below never infers one from the other:
//
//                 shows the QR        contacts
//   Flow A        Receiver            Sender         QR says mode=offer
//   Flow B        Sender              Receiver       QR says mode=request

import { base64 } from '@scure/base';
import { bytesToHex, equalAscii, isHex32, wipe } from './bytes.ts';
import {
  ACK_WAIT_SECONDS,
  KINDS,
  MAX_ATTEMPTS,
  MAX_HELD,
  MAX_PENDING,
  SESSION_SECONDS,
  SLACK_SECONDS,
  VERSION,
} from './constants.ts';
import { type Env, type NostrEvent, type Rumor, firstTag, isValidPublicKey, publicKey, sign } from './event.ts';
import { type Profile, assertProfile } from './profile.ts';
import { commit as commitOf, sas as sasOf } from './sas.ts';
import type { Role } from './uri.ts';
import { type RumorInput, buildRumor, unwrap, wrap } from './wrap.ts';

export type Phase =
  /** Nobody has completed the nonce exchange with us yet. */
  | 'waiting'
  /** Sender: a peer is ready. Show the release prompt and take the code. */
  | 'release'
  /** Receiver: show the active peer's code. */
  | 'code'
  /** Receiver: the active peer's payload is held. Ask before keeping it. */
  | 'accept'
  /** Sender: the payload has been released. Waiting for the acknowledgement. */
  | 'sent'
  | 'ended';

export type Outcome =
  /** Sender: the Receiver acknowledged. */
  | 'delivered'
  /** Sender: released, but no acknowledgement arrived within 60 s. */
  | 'sent-unconfirmed'
  /** Receiver: the payload was kept. */
  | 'received'
  /** The local user refused: the Sender declined to release, or the Receiver discarded. */
  | 'declined'
  /** The local user left before any decision. */
  | 'cancelled'
  /** The other device ended the session. */
  | 'peer-aborted'
  /** Sender: five code entries failed. */
  | 'attempts-exhausted'
  /** Ten minutes passed. */
  | 'expired'
  /** Receiver: what arrived was not a payload of the declared profile (P4). */
  | 'bad-payload'
  /** Sender: the scanned code belongs to a burner this device recently failed against (§9.3). */
  | 'blocked-peer';

export interface TransferRecord {
  /** Seconds since the epoch. */
  ts: number;
  profile: string;
  role: Role;
  outcome: Outcome;
  /** The pairing code of the session. Belongs to this session only. */
  sas: string;
  /** The other device's burner public key. */
  peer: string;
  /** Whether more than one device responded to the code (§13). */
  multi: boolean;
}

export type Effect<T> =
  /** Publish this gift wrap to every relay of the session. `label` is for a debug log only. */
  | { t: 'publish'; event: NostrEvent; label: string }
  /** Receiver: the user confirmed. Keep this value. */
  | { t: 'commit'; value: T }
  /** §14: write this to the local transfer log. */
  | { t: 'record'; record: TransferRecord }
  /** §9.3: do not start a session with these burners for an hour. */
  | { t: 'failed-peers'; pubs: string[] }
  /** A line for a developer-facing log. Never contains a code, a nonce or a payload. */
  | { t: 'trace'; text: string }
  /** The session is over and its keys are gone. Close the relays once publishes have drained. */
  | { t: 'ended'; outcome: Outcome };

export interface SessionOptions<T> {
  role: Role;
  /** True on the device that shows the QR. */
  showing: boolean;
  profile: Profile<T>;
  /** This session's burner. The session owns it from here and wipes it when it ends. */
  secretKey: Uint8Array;
  /** Contacting party only: the burner public key read from the QR. */
  peerPub?: string;
  /** Sender only: what to send. */
  payload?: T;
  env: Env;
  /** Sender only: true for a peer burner this device must not deal with again yet (§9.3). */
  isBlocked?: (pub: string) => boolean;
}

export interface SessionView {
  role: Role;
  showing: boolean;
  phase: Phase;
  outcome?: Outcome;
  /** Receiver, phase `code`: the five digits to show. The Sender never has this field. */
  code?: string;
  /** Receiver, phase `accept`: the P5 rendering of what arrived. */
  rendering?: string;
  /** Sender: code entries left. */
  attemptsLeft: number;
  /** Peers that have completed the nonce exchange. */
  ready: number;
  /** §13: a second distinct burner responded in this session. */
  multipleResponders: boolean;
  /** Responders turned away because the session was already holding its maximum. */
  dropped: number;
  /** Receiver that showed the QR: another candidate is waiting behind the active one. */
  canAdvance: boolean;
  /** Seconds since the epoch at which the session expires. */
  expiresAt: number;
  /** Sender, phase `sent`: when it stops waiting for the acknowledgement. */
  ackDeadline?: number;
  /** Sender: the payload has left this device. Stays true after the session ends. */
  released: boolean;
}

interface Peer<T> {
  pub: string;
  order: number;
  /** Showing side: the commitment this peer sent, checked when it reveals. */
  commit?: string;
  ownNonce: string;
  peerNonce?: string;
  sas?: string;
  /** Receiver: this peer's code has been on screen. */
  displayed: boolean;
  /** Receiver: the P4-checked value held for this peer. Never kept without confirmation. */
  held?: T;
  /** Sender: a code entry failed while this peer was ready. */
  failed: boolean;
}

const short = (pub: string) => `${pub.slice(0, 8)}…`;
const MAX_SEEN = 512;

export class Session<T> {
  readonly role: Role;
  readonly showing: boolean;
  readonly profile: Profile<T>;
  readonly pub: string;
  readonly startedAt: number;

  private readonly env: Env;
  private readonly secretKey: Uint8Array;
  private readonly peerPub: string | undefined;
  private readonly isBlocked: (pub: string) => boolean;
  private payloadContent: string | undefined;

  private phase: Phase = 'waiting';
  private outcome: Outcome | undefined;
  private readonly peers = new Map<string, Peer<T>>();
  private readonly seen = new Set<string>();
  /**
   * Every burner that has contacted this session, whether or not it is still held.
   * A burner gets one nonce exchange, and a slot is never handed out twice: a party
   * that learns our nonce before revealing its own must not be able to walk away and
   * ask again until it likes the code (§6: one attempt per session).
   */
  private readonly contacted = new Set<string>();
  /** Sender: burners a code entry failed against, kept even if the peer is later dropped (§9.3). */
  private readonly failedPeers = new Set<string>();
  private order = 0;
  private attempts = 0;
  private multipleResponders = false;
  private dropped = 0;
  /** Receiver: the peer whose code is on screen. */
  private active: string | undefined;
  /** Sender: the peer the payload went to. */
  private releasedTo: string | undefined;
  private releasedSas: string | undefined;
  private ackDeadline: number | undefined;
  private released = false;
  private started = false;

  constructor(options: SessionOptions<T>) {
    assertProfile(options.profile as Profile<unknown>);
    this.role = options.role;
    this.showing = options.showing;
    this.profile = options.profile;
    this.env = options.env;
    this.secretKey = options.secretKey;
    this.pub = publicKey(options.secretKey);
    this.startedAt = options.env.now();
    this.isBlocked = options.isBlocked ?? (() => false);

    if (this.showing) {
      if (options.peerPub !== undefined) throw new Error('session: the showing device has no peer yet');
    } else {
      if (!isHex32(options.peerPub)) throw new Error('session: the contacting device needs the key from the QR');
      if (options.peerPub === this.pub) throw new Error('session: a device cannot pair with itself');
      if (!isValidPublicKey(options.peerPub)) throw new Error('session: the key from the QR is not a valid key');
    }
    this.peerPub = options.peerPub;

    if (this.role === 'sender') {
      if (options.payload === undefined) throw new Error('session: the Sender needs something to send');
      // Encoded now so that a payload that does not fit fails before anything is on the wire.
      this.payloadContent = this.profile.encode(options.payload);
    } else if (options.payload !== undefined) {
      throw new Error('session: a Receiver sends no payload');
    }
  }

  /** The filter a relay subscription for this session uses (§11.5). */
  filter(): { kinds: number[]; '#p': string[]; since: number } {
    return { kinds: [KINDS.WRAP], '#p': [this.pub], since: this.startedAt - SLACK_SECONDS };
  }

  view(): SessionView {
    const ready = [...this.peers.values()].filter((p) => p.sas !== undefined);
    const activePeer = this.active ? this.peers.get(this.active) : undefined;
    const view: SessionView = {
      role: this.role,
      showing: this.showing,
      phase: this.phase,
      attemptsLeft: MAX_ATTEMPTS - this.attempts,
      ready: ready.length,
      multipleResponders: this.multipleResponders,
      dropped: this.dropped,
      canAdvance: this.role === 'receiver' && this.showing && ready.some((p) => p.pub !== this.active),
      expiresAt: this.startedAt + SESSION_SECONDS,
      released: this.released,
    };
    if (this.outcome) view.outcome = this.outcome;
    if (this.role === 'receiver' && activePeer?.sas && (this.phase === 'code' || this.phase === 'accept')) {
      view.code = activePeer.sas;
    }
    if (this.phase === 'accept' && activePeer?.held !== undefined) view.rendering = this.profile.render(activePeer.held);
    if (this.ackDeadline !== undefined && this.phase === 'sent') view.ackDeadline = this.ackDeadline;
    return view;
  }

  // ---- messages out -------------------------------------------------------------------

  private send(to: string, input: RumorInput, label: string): Effect<T> {
    const r = buildRumor(input, this.pub, this.env.now());
    return { t: 'publish', event: wrap(r, this.secretKey, to, this.env), label: `${label} → ${short(to)}` };
  }

  private abort(to: string): Effect<T> {
    return this.send(to, { kind: KINDS.ABORT }, 'ABORT');
  }

  /**
   * A wrap addressed to this session's own burner, carrying a PAYLOAD-shaped rumor of
   * the profile's maximum size: the loopback test a relay must pass before it is
   * listed. The host recognises it by event id and never hands it back.
   */
  probe(): NostrEvent {
    this.assertLive();
    const content = base64.encode(this.env.random(this.profile.maxPayloadBytes));
    const r = buildRumor({ kind: KINDS.PAYLOAD, content }, this.pub, this.env.now());
    return wrap(r, this.secretKey, this.pub, this.env);
  }

  /** NIP-42 authentication with the burner, the only identity a session ever shows a relay (§11.5). */
  signAuth(relayUrl: string, challenge: string): NostrEvent {
    this.assertLive();
    return sign(
      {
        pubkey: this.pub,
        created_at: this.env.now(),
        kind: KINDS.AUTH,
        tags: [
          ['relay', relayUrl],
          ['challenge', challenge],
        ],
        content: '',
      },
      this.secretKey,
      this.env.random,
    );
  }

  // ---- inputs -------------------------------------------------------------------------

  /** Contacting party: speak first. The showing device has nothing to start. */
  start(): Effect<T>[] {
    if (this.phase === 'ended' || this.started) return [];
    this.started = true;
    if (this.showing || !this.peerPub) return [];
    if (this.role === 'sender' && this.isBlocked(this.peerPub)) return this.finish('blocked-peer', []);

    const ownNonce = bytesToHex(this.env.random(32));
    this.peers.set(this.peerPub, { pub: this.peerPub, order: this.order++, ownNonce, displayed: false, failed: false });
    const commitment = bytesToHex(commitOf(VERSION, this.pub, ownNonce));
    const kind = this.role === 'sender' ? KINDS.HELLO : KINDS.REQUEST;
    const label = this.role === 'sender' ? 'HELLO' : 'REQUEST';
    return [this.send(this.peerPub, { kind, tags: [['commit', commitment]] }, label)];
  }

  /** A gift wrap arrived from a relay. Anything that is not a valid message of this session is ignored. */
  receive(event: unknown): Effect<T>[] {
    if (this.phase === 'ended') return [];
    const opened = unwrap(event, this.secretKey);
    if (!opened.ok) return [{ t: 'trace', text: `ignored a wrap: ${opened.reason}` }];
    return this.receiveRumor(opened.rumor);
  }

  /** True once the ten minutes are up. Checked on every input, not only by the timer. */
  private expired(): boolean {
    return this.phase !== 'sent' && this.phase !== 'ended' && this.env.now() >= this.startedAt + SESSION_SECONDS;
  }

  /** Exposed for tests that drive the machine without the encryption layer. */
  receiveRumor(r: Rumor): Effect<T>[] {
    if (this.phase === 'ended') return [];
    if (this.expired()) return this.tick();
    if (r.pubkey === this.pub) return [];
    // §11.4: a rumor outside the widened window is discarded from the session entirely.
    if (r.created_at < this.startedAt - SLACK_SECONDS || r.created_at > this.startedAt + SESSION_SECONDS + SLACK_SECONDS) {
      return [{ t: 'trace', text: 'ignored a message outside the session window' }];
    }
    if (this.seen.has(r.id)) return [];
    // Bounded: a flood of distinct junk must not grow this without limit.
    if (this.seen.size < MAX_SEEN) this.seen.add(r.id);

    switch (r.kind) {
      case KINDS.HELLO:
        return this.showing && this.role === 'receiver' ? this.onContact(r) : [];
      case KINDS.REQUEST:
        return this.showing && this.role === 'sender' ? this.onContact(r) : [];
      case KINDS.NONCE:
        return !this.showing ? this.onNonce(r) : [];
      case KINDS.REVEAL:
        return this.showing ? this.onReveal(r) : [];
      case KINDS.PAYLOAD:
        return this.role === 'receiver' ? this.onPayload(r) : [];
      case KINDS.ACK:
        return this.role === 'sender' ? this.onAck(r) : [];
      case KINDS.ABORT:
        return this.onAbort(r);
      default:
        return [];
    }
  }

  /** Showing device: a HELLO (Flow A) or REQUEST (Flow B) from a burner we have not met. */
  private onContact(r: Rumor): Effect<T>[] {
    if (this.phase !== 'waiting' && this.phase !== 'release' && this.phase !== 'code') return [];
    const commitment = firstTag(r, 'commit');
    if (!isHex32(commitment)) return [];
    // A second message from a burner we have met is a retransmission, not a responder (§13),
    // and a burner that was dropped does not get a second nonce exchange.
    if (this.contacted.has(r.pubkey)) return [];
    if (this.role === 'sender' && this.isBlocked(r.pubkey)) {
      return [{ t: 'trace', text: `ignored ${short(r.pubkey)}: a code already failed against it` }];
    }
    if (this.contacted.size >= 1) this.multipleResponders = true;
    // The cap is on contacts over the whole session, not on how many are held right now.
    const cap = this.role === 'receiver' ? MAX_HELD : MAX_PENDING;
    if (this.contacted.size >= cap) {
      this.dropped++;
      return [{ t: 'trace', text: `turned away ${short(r.pubkey)}: this code has already been answered ${cap} times` }];
    }
    this.contacted.add(r.pubkey);
    const ownNonce = bytesToHex(this.env.random(32));
    this.peers.set(r.pubkey, {
      pub: r.pubkey,
      order: this.order++,
      commit: commitment,
      ownNonce,
      displayed: false,
      failed: false,
    });
    return [
      { t: 'trace', text: `${r.kind === KINDS.HELLO ? 'HELLO' : 'REQUEST'} ← ${short(r.pubkey)}` },
      this.send(r.pubkey, { kind: KINDS.NONCE, tags: [['nonce', ownNonce]] }, 'NONCE'),
    ];
  }

  /** Contacting party: the showing device answered with its nonce. Reveal ours and derive the code. */
  private onNonce(r: Rumor): Effect<T>[] {
    if (r.pubkey !== this.peerPub) return [];
    const peer = this.peers.get(r.pubkey);
    const nonce = firstTag(r, 'nonce');
    if (!peer || peer.peerNonce !== undefined || !isHex32(nonce)) return [];
    peer.peerNonce = nonce;
    peer.sas = this.codeFor(peer);
    const effects: Effect<T>[] = [
      { t: 'trace', text: `NONCE ← ${short(r.pubkey)}` },
      this.send(peer.pub, { kind: KINDS.REVEAL, tags: [['nonce', peer.ownNonce]] }, 'REVEAL'),
    ];
    if (this.role === 'sender') {
      this.phase = 'release';
    } else {
      this.active = peer.pub;
      peer.displayed = true;
      this.phase = 'code';
    }
    return effects;
  }

  /** Showing device: a peer opened its commitment. */
  private onReveal(r: Rumor): Effect<T>[] {
    const peer = this.peers.get(r.pubkey);
    const nonce = firstTag(r, 'nonce');
    if (!peer || peer.commit === undefined || peer.peerNonce !== undefined || !isHex32(nonce)) return [];
    if (!equalAscii(bytesToHex(commitOf(VERSION, peer.pub, nonce)), peer.commit)) {
      // The nonce is not the one committed to. This peer is done; the session is not.
      this.peers.delete(peer.pub);
      return [{ t: 'trace', text: `dropped ${short(peer.pub)}: reveal does not match its commitment` }];
    }
    peer.peerNonce = nonce;
    peer.sas = this.codeFor(peer);
    const effects: Effect<T>[] = [{ t: 'trace', text: `REVEAL ← ${short(peer.pub)}, commitment verified` }];
    if (this.role === 'sender') {
      if (this.phase === 'waiting') this.phase = 'release';
    } else if (this.active === undefined) {
      this.activateNext();
    }
    return effects;
  }

  /** The code for a peer, with the two burners in ROLE order whoever made contact (§6). */
  private codeFor(peer: Peer<T>): string {
    const iAmSender = this.role === 'sender';
    return sasOf({
      v: VERSION,
      profile: this.profile.id,
      senderPub: iAmSender ? this.pub : peer.pub,
      receiverPub: iAmSender ? peer.pub : this.pub,
      senderNonce: iAmSender ? peer.ownNonce : peer.peerNonce!,
      receiverNonce: iAmSender ? peer.peerNonce! : peer.ownNonce,
    });
  }

  /** Receiver: put the earliest ready candidate's code on screen. Returns false if there is none. */
  private activateNext(): boolean {
    const next = [...this.peers.values()].filter((p) => p.sas !== undefined).sort((a, b) => a.order - b.order)[0];
    if (!next) {
      this.active = undefined;
      this.phase = 'waiting';
      return false;
    }
    this.active = next.pub;
    next.displayed = true;
    this.phase = 'code';
    return true;
  }

  /** Receiver: a payload arrived. It is held, never kept, until the user confirms (§9.4). */
  private onPayload(r: Rumor): Effect<T>[] {
    const peer = this.peers.get(r.pubkey);
    if (!peer || peer.sas === undefined || peer.held !== undefined) return [];
    if (this.phase !== 'code') return [];

    if (peer.pub !== this.active || !peer.displayed) {
      // A Sender releases only after reading this peer's code from this screen (§9.2),
      // and that code has never been shown. Whoever sent this did not follow the flow.
      this.peers.delete(peer.pub);
      return [{ t: 'trace', text: `dropped ${short(peer.pub)}: payload arrived before its code was shown` }];
    }

    const checked = this.profile.check(r.content);
    if (!checked.ok) {
      // P4. Discard the candidate and advance, or abort if none remain (§13).
      this.peers.delete(peer.pub);
      const effects: Effect<T>[] = [
        { t: 'trace', text: `dropped ${short(peer.pub)}: payload is not a ${this.profile.id} (${checked.reason})` },
        this.abort(peer.pub),
      ];
      if (this.activateNext()) return effects;
      return this.finish('bad-payload', effects);
    }
    peer.held = checked.value;
    this.phase = 'accept';
    return [{ t: 'trace', text: `PAYLOAD ← ${short(peer.pub)}, held for confirmation` }];
  }

  private onAck(r: Rumor): Effect<T>[] {
    if (this.phase !== 'sent' || r.pubkey !== this.releasedTo) return [];
    return this.finish('delivered', [{ t: 'trace', text: `ACK ← ${short(r.pubkey)}` }]);
  }

  private onAbort(r: Rumor): Effect<T>[] {
    const peer = this.peers.get(r.pubkey);
    if (!peer) return [];
    const effects: Effect<T>[] = [{ t: 'trace', text: `ABORT ← ${short(r.pubkey)}` }];

    if (!this.showing || r.pubkey === this.releasedTo) return this.finish('peer-aborted', effects);

    this.peers.delete(peer.pub);
    if (this.role === 'sender') {
      if (this.phase === 'release' && ![...this.peers.values()].some((p) => p.sas !== undefined)) this.phase = 'waiting';
      return effects;
    }
    if (peer.pub !== this.active) return effects;
    // The device whose code was on screen has gone. Show the next candidate's, or go
    // back to waiting: one message from a stranger must not end the session (§13).
    this.activateNext();
    return effects;
  }

  /**
   * Sender: the user typed the five digits shown on the Receiver.
   *
   * The comparison happens here and only here (§9.2). The typed value is checked
   * against the code this device computed for each ready peer; it is never sent, and a
   * result asserted by a peer is never accepted. A value that matches exactly one peer
   * releases to that peer. Anything else spends one attempt.
   */
  enterCode(digits: string): Effect<T>[] {
    if (this.phase !== 'release' || this.role !== 'sender') return [];
    if (this.expired()) return this.tick();
    if (!/^[0-9]{5}$/.test(digits)) throw new Error('session: a pairing code is exactly five digits');

    const ready = [...this.peers.values()].filter((p) => p.sas !== undefined);
    const matches = ready.filter((p) => equalAscii(p.sas!, digits));
    if (matches.length === 1) {
      const target = matches[0]!;
      const effects: Effect<T>[] = [this.send(target.pub, { kind: KINDS.PAYLOAD, content: this.payloadContent! }, 'PAYLOAD')];
      for (const other of this.peers.values()) if (other.pub !== target.pub) effects.push(this.abort(other.pub));
      this.releasedTo = target.pub;
      this.releasedSas = target.sas;
      this.released = true;
      this.payloadContent = undefined;
      this.ackDeadline = this.env.now() + ACK_WAIT_SECONDS;
      this.phase = 'sent';
      return effects;
    }

    this.attempts++;
    for (const p of ready) {
      p.failed = true;
      this.failedPeers.add(p.pub);
    }
    const effects: Effect<T>[] = [{ t: 'trace', text: `code did not match (attempt ${this.attempts} of ${MAX_ATTEMPTS})` }];
    if (this.attempts < MAX_ATTEMPTS) return effects;
    for (const p of this.peers.values()) effects.push(this.abort(p.pub));
    return this.finish('attempts-exhausted', effects);
  }

  /** Receiver: the user confirmed the rendering. Keep the payload and acknowledge. */
  accept(): Effect<T>[] {
    const peer = this.active ? this.peers.get(this.active) : undefined;
    if (this.phase !== 'accept' || !peer || peer.held === undefined) return [];
    if (this.expired()) return this.tick();
    const value = peer.held;
    return this.finish(
      'received',
      [{ t: 'commit', value }, this.send(peer.pub, { kind: KINDS.ACK }, 'ACK')],
      { peer: peer.pub, sas: peer.sas! },
    );
  }

  /** The user refused: a Sender declining to release, or a Receiver discarding what arrived. */
  decline(): Effect<T>[] {
    return this.leave('declined');
  }

  /** The user left the flow. */
  cancel(): Effect<T>[] {
    return this.leave('cancelled');
  }

  private leave(outcome: 'declined' | 'cancelled'): Effect<T>[] {
    if (this.phase === 'ended') return [];
    // Nothing can be un-sent once released; the session simply stops waiting.
    if (this.phase === 'sent') return this.finish('sent-unconfirmed', []);
    const effects: Effect<T>[] = [];
    for (const p of this.peers.values()) effects.push(this.abort(p.pub));
    return this.finish(outcome, effects);
  }

  /**
   * Receiver that showed the QR: the device being paired says this code is wrong, so
   * the code on screen belongs to someone else. Discard that candidate and show the
   * next one (§13). With nobody behind it, go back to waiting.
   */
  advance(): Effect<T>[] {
    if (this.role !== 'receiver' || !this.showing || this.phase !== 'code' || !this.active) return [];
    const gone = this.active;
    this.peers.delete(gone);
    this.activateNext();
    return [{ t: 'trace', text: `set ${short(gone)} aside; ${this.active ? 'showing the next code' : 'waiting'}` }];
  }

  /** Call about once a second. Enforces the ten-minute lifetime and the acknowledgement wait. */
  tick(): Effect<T>[] {
    if (this.phase === 'ended') return [];
    const now = this.env.now();
    if (this.phase === 'sent') {
      return this.ackDeadline !== undefined && now >= this.ackDeadline ? this.finish('sent-unconfirmed', []) : [];
    }
    if (now < this.startedAt + SESSION_SECONDS) return [];
    const effects: Effect<T>[] = [];
    for (const p of this.peers.values()) effects.push(this.abort(p.pub));
    return this.finish('expired', effects);
  }

  // ---- ending -------------------------------------------------------------------------

  private finish(outcome: Outcome, effects: Effect<T>[], done?: { peer: string; sas: string }): Effect<T>[] {
    // A record is owed whenever a secret moved: when a Receiver kept one, and from the
    // moment a Sender released one, whatever happened to it afterwards (§14).
    const completed =
      done ?? (this.releasedTo && this.releasedSas ? { peer: this.releasedTo, sas: this.releasedSas } : undefined);
    if (completed) {
      effects.push({
        t: 'record',
        record: {
          ts: this.env.now(),
          profile: this.profile.id,
          role: this.role,
          outcome,
          sas: completed.sas,
          peer: completed.peer,
          multi: this.multipleResponders,
        },
      });
    } else if (this.role === 'sender' && this.failedPeers.size > 0) {
      effects.push({ t: 'failed-peers', pubs: [...this.failedPeers] });
    }

    this.phase = 'ended';
    this.outcome = outcome;
    this.active = undefined;
    this.payloadContent = undefined;
    this.peers.clear();
    this.seen.clear();
    this.contacted.clear();
    this.failedPeers.clear();
    // Every wrap this session will ever send has been built above; the burner can go.
    wipe(this.secretKey);
    effects.push({ t: 'ended', outcome });
    return effects;
  }

  private assertLive(): void {
    if (this.phase === 'ended') throw new Error('session: ended');
  }
}
