// An in-memory stand-in for a relay: delivers each published wrap to the session it
// is addressed to, and lets a test look inside or interfere.

import { type CodeCheck, type Effect, type NostrEvent, type Profile, type Role, type Rumor, Session, firstTag, generateSecretKey, publicKey, unwrap } from '../src/core/index.ts';
import { FakeClock, seededRandom } from './helpers.ts';

export interface Node<T> {
  name: string;
  session: Session<T>;
  /** A copy of the burner, kept by the test so it can read traffic after the session wipes its own. */
  secret: Uint8Array;
  /** The array the session was given, to check that it is wiped. */
  ownedSecret: Uint8Array;
  pub: string;
  effects: Effect<T>[];
}

export interface Sent {
  from: string;
  to: string;
  rumor: Rumor;
  event: NostrEvent;
}

export class Net<T> {
  readonly clock = new FakeClock();
  readonly nodes: Node<T>[] = [];
  readonly sent: Sent[] = [];
  /** Return false to drop a message in transit. */
  filter: (m: Sent) => boolean = () => true;
  /** Deliver every wrap this many times, as several relays would. */
  copies = 1;
  private queue: { from: Node<T>; effects: Effect<T>[] }[] = [];
  private draining = false;

  constructor(private readonly profile: Profile<T>) {}

  /**
   * A contacting node reads the token and check from the QR of the node it names, as
   * a device that saw the code would, unless the test says otherwise.
   */
  add(
    name: string,
    role: Role,
    showing: boolean,
    extra: { peerPub?: string; payload?: T; isBlocked?: (pub: string) => boolean; profile?: Profile<T>; check?: CodeCheck; token?: string; peerCheck?: CodeCheck } = {},
  ): Node<T> {
    const random = seededRandom(`node:${name}`);
    const secret = generateSecretKey(random);
    const ownedSecret = secret.slice();
    const shower = extra.peerPub !== undefined ? this.nodes.find((n) => n.pub === extra.peerPub) : undefined;
    const token = extra.token ?? shower?.session.token;
    const peerCheck = extra.peerCheck ?? shower?.session.view().check;
    const session = new Session<T>({
      role,
      showing,
      profile: extra.profile ?? this.profile,
      secretKey: ownedSecret,
      env: { random, now: this.clock.now },
      ...(extra.peerPub !== undefined ? { peerPub: extra.peerPub } : {}),
      ...(extra.payload !== undefined ? { payload: extra.payload } : {}),
      ...(extra.isBlocked ? { isBlocked: extra.isBlocked } : {}),
      ...(extra.check ? { check: extra.check } : {}),
      ...(token !== undefined && extra.peerPub !== undefined ? { token } : {}),
      ...(peerCheck !== undefined && extra.peerPub !== undefined ? { peerCheck } : {}),
    });
    const node: Node<T> = { name, session, secret, ownedSecret, pub: publicKey(secret), effects: [] };
    this.nodes.push(node);
    return node;
  }

  /** Runs effects from `node` through the network until nothing is left in flight. */
  run(node: Node<T>, effects: Effect<T>[]): void {
    this.queue.push({ from: node, effects });
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length > 0) {
      const { from, effects: batch } = this.queue.shift()!;
      from.effects.push(...batch);
      for (const e of batch) {
        if (e.t !== 'publish') continue;
        const to = firstTag(e.event, 'p')!;
        const target = this.nodes.find((n) => n.pub === to);
        const opened = target ? unwrap(e.event, target.secret) : undefined;
        if (!target || !opened || !opened.ok) continue;
        const message: Sent = { from: from.name, to: target.name, rumor: opened.rumor, event: e.event };
        this.sent.push(message);
        if (!this.filter(message)) continue;
        for (let i = 0; i < this.copies; i++) this.queue.push({ from: target, effects: target.session.receive(e.event) });
      }
    }
    this.draining = false;
  }

  kinds(): number[] {
    return this.sent.map((m) => m.rumor.kind);
  }
}

export const outcomeOf = <T>(n: Node<T>) => n.session.view().outcome;
export const committed = <T>(n: Node<T>) => n.effects.filter((e) => e.t === 'commit').map((e) => (e as { value: T }).value);
export const records = <T>(n: Node<T>) => n.effects.filter((e) => e.t === 'record').map((e) => (e as Extract<Effect<T>, { t: 'record' }>).record);
