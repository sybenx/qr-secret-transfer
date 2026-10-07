// Relay transport for one session (spec §11.5).
//
// A RelayLink is one WebSocket to one relay, subscribed to wraps addressed to this
// session's burner. A Pool is the set of links a session uses, with the two things
// §11.5 requires of it: publishes go to every relay in parallel, and every message
// published during the session is kept in an outbox and sent again whenever a socket
// opens or a NIP-42 authentication succeeds.

import { type NostrEvent, verify } from '../core/index.ts';

export type LinkState = 'connecting' | 'open' | 'closed';

export interface PoolOptions {
  /** The subscription filter (§11.5): kind 1059, p-tagged to the burner, since session start minus slack. */
  filter: Record<string, unknown>;
  /** Signs a NIP-42 authentication with the session's burner, never with anything longer-lived. */
  signAuth(url: string, challenge: string): NostrEvent;
  /** A wrap arrived. Called once per event id, however many relays delivered it. */
  onEvent(event: unknown, url: string): void;
  onChange?(): void;
  log?(text: string): void;
  WebSocketImpl?: typeof WebSocket;
}

export interface Ack {
  ok: boolean;
  message: string;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

/** Text from a relay is shown and stored, so it is cut short and stripped of control characters. */
function tidy(text: unknown, fallback: string): string {
  if (typeof text !== 'string' || text === '') return fallback;
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
}

export class RelayLink {
  state: LinkState = 'connecting';
  /** The relay's most recent refusal or notice, for the person looking at the relay list. */
  lastReason: string | undefined;
  readonly acks = new Map<string, Ack>();
  private ws: WebSocket | undefined;
  private readonly subId = `q${Math.random().toString(36).slice(2, 10)}`;
  private challenge: string | undefined;
  private authId: string | undefined;
  private authed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closedByUs = false;
  /** Events for this relay alone: the loopback probe, until it has passed. */
  private local: NostrEvent[] = [];

  constructor(
    readonly url: string,
    private readonly pool: Pool,
    private readonly options: PoolOptions,
    public reconnect: boolean,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.closedByUs) return;
    this.state = 'connecting';
    this.authed = false;
    this.authId = undefined;
    this.challenge = undefined;
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(this.url);
    } catch (e) {
      this.lastReason = e instanceof Error ? e.message : 'could not connect';
      this.onClose();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.state = 'open';
      this.attempt = 0;
      this.subscribe();
      this.republish();
      this.pool.changed();
    };
    ws.onmessage = (m) => {
      if (this.ws === ws) this.onMessage(m.data);
    };
    ws.onerror = () => {
      // The close event that follows carries the consequence.
    };
    ws.onclose = () => {
      if (this.ws === ws) this.onClose();
    };
  }

  private onClose(): void {
    this.ws = undefined;
    this.state = 'closed';
    this.pool.changed();
    if (this.closedByUs || !this.reconnect) return;
    // §11.3: keep re-attempting an unreachable relay for the remaining lifetime of the session.
    const wait = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]!;
    this.timer = setTimeout(() => this.connect(), wait);
  }

  private raw(message: unknown[]): void {
    if (this.ws && this.state === 'open') {
      try {
        this.ws.send(JSON.stringify(message));
      } catch {
        // A socket that died between the check and the send will close and be retried.
      }
    }
  }

  private subscribe(): void {
    this.raw(['REQ', this.subId, this.options.filter]);
  }

  private republish(): void {
    for (const event of this.pool.outbox) this.raw(['EVENT', event]);
    for (const event of this.local) this.raw(['EVENT', event]);
  }

  private authenticate(): void {
    if (!this.challenge || this.authId) return;
    let event: NostrEvent;
    try {
      event = this.options.signAuth(this.url, this.challenge);
    } catch {
      return; // the session has ended and its burner is gone
    }
    this.authId = event.id;
    this.raw(['AUTH', event]);
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(message)) return;
    const [type, a, b, c] = message as [unknown, unknown, unknown, unknown];
    switch (type) {
      case 'EVENT':
        if (a === this.subId) this.pool.incoming(this, b);
        return;
      case 'OK': {
        if (typeof a !== 'string') return;
        const ok = b === true;
        const text = tidy(c, '');
        if (a === this.authId) {
          if (ok) {
            // §11.5: a relay may take a publish and only then demand AUTH, so everything goes again.
            this.authed = true;
            this.subscribe();
            this.republish();
          } else {
            this.lastReason = text || 'authentication refused';
            this.authId = undefined;
          }
          this.pool.changed();
          return;
        }
        this.acks.set(a, { ok, message: text });
        if (!ok) {
          this.lastReason = text || 'refused';
          const wantsAuth = text.startsWith('auth-required') && !this.authed;
          if (wantsAuth) this.authenticate();
          // Refused for good, as far as this relay is concerned: no need to wait for an echo.
          else this.pool.refused(this, a);
        }
        this.pool.changed();
        return;
      }
      case 'CLOSED':
        if (a !== this.subId) return;
        this.lastReason = tidy(b, 'subscription closed');
        if (this.lastReason.startsWith('auth-required') && !this.authed) this.authenticate();
        this.pool.changed();
        return;
      case 'AUTH':
        if (typeof a !== 'string') return;
        this.challenge = a;
        this.authId = undefined;
        // The burner is the only identity this session has and it means nothing to the
        // relay, so there is no reason to wait to be refused before authenticating.
        this.authenticate();
        return;
      case 'NOTICE':
        this.lastReason = tidy(a, 'notice');
        return;
      default:
        return;
    }
  }

  /** Publishes one of the session's messages. The pool's outbox owns it. */
  publish(event: NostrEvent): void {
    this.raw(['EVENT', event]);
  }

  /** Publishes to this relay only, and again after a reconnect or an authentication. */
  publishLocal(event: NostrEvent): void {
    this.local.push(event);
    this.raw(['EVENT', event]);
  }

  clearLocal(): void {
    this.local = [];
  }

  close(): void {
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = undefined;
    this.state = 'closed';
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        // already gone
      }
    }
  }
}

export interface LoopbackResult {
  ok: boolean;
  /** Why it failed, in words a person can read. */
  reason?: string;
}

export class Pool {
  readonly outbox: NostrEvent[] = [];
  private readonly links = new Map<string, RelayLink>();
  private readonly seen = new Set<string>();
  private readonly ignored = new Set<string>();
  private readonly waiters = new Map<string, (echoed: boolean) => void>();
  private closed = false;

  constructor(private readonly options: PoolOptions) {}

  get isClosed(): boolean {
    return this.closed;
  }

  changed(): void {
    if (!this.closed) this.options.onChange?.();
  }

  add(url: string, reconnect: boolean): RelayLink {
    const existing = this.links.get(url);
    if (existing) {
      existing.reconnect ||= reconnect;
      return existing;
    }
    const link = new RelayLink(url, this, this.options, reconnect);
    this.links.set(url, link);
    return link;
  }

  remove(url: string): void {
    this.links.get(url)?.close();
    this.links.delete(url);
    this.changed();
  }

  get(url: string): RelayLink | undefined {
    return this.links.get(url);
  }

  all(): RelayLink[] {
    return [...this.links.values()];
  }

  /** Publishes to every relay in parallel and keeps the event for replay (§11.5). */
  publish(event: NostrEvent): void {
    if (this.closed) return;
    this.outbox.push(event);
    for (const link of this.links.values()) link.publish(event);
  }

  /** An event id this pool must never hand to the session: a loopback probe. */
  ignore(id: string): void {
    this.ignored.add(id);
  }

  incoming(link: RelayLink, event: unknown): void {
    if (this.closed || typeof event !== 'object' || event === null) return;
    const id = (event as { id?: unknown }).id;
    if (typeof id !== 'string') return;
    // A loopback probe passes only if what came back is the event that went out: an id
    // alone is something any relay can repeat (§11.5).
    const waiter = this.waiters.get(`${link.url} ${id}`);
    if (waiter && verify(event)) waiter(true);
    // A probe is recognised by its id and never handed to the session (§11.3a).
    if (this.ignored.has(id)) return;
    // Dedupe by event id: several relays deliver the same wrap (§11.5). Only a wrap
    // whose id and signature hold is remembered, or one relay could send junk under a
    // real id and have the genuine copy from another relay thrown away.
    if (this.seen.has(id)) return;
    if (!verify(event)) return;
    this.seen.add(id);
    this.options.onEvent(event, link.url);
  }

  /** A relay answered a publish with a final refusal. */
  refused(link: RelayLink, id: string): void {
    this.waiters.get(`${link.url} ${id}`)?.(false);
  }

  /**
   * The loopback test of §11.3a. Opens a link, publishes `probe` (a wrap addressed to
   * the session's own burner) to that relay alone, and passes only if the same event
   * comes back on the subscription. A relay that passes stays in the pool as a
   * session relay; one that fails is removed.
   */
  async loopback(url: string, probe: NostrEvent, echoMs = 3000, connectMs = 5000): Promise<LoopbackResult> {
    if (this.closed) return { ok: false, reason: 'cancelled' };
    const link = this.add(url, false);
    const fail = (reason: string): LoopbackResult => {
      this.remove(url);
      return { ok: false, reason };
    };

    const opened = await this.until(() => link.state === 'open' || (link.state === 'closed' && !link.reconnect), connectMs);
    if (this.closed) return { ok: false, reason: 'cancelled' };
    if (!opened || link.state !== 'open') return fail('could not connect');

    const key = `${url} ${probe.id}`;
    const echoed = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        resolve(false);
      }, echoMs);
      this.waiters.set(key, (echo) => {
        clearTimeout(timer);
        this.waiters.delete(key);
        resolve(echo);
      });
    });
    link.publishLocal(probe);
    const ok = await echoed;
    if (this.closed) return { ok: false, reason: 'cancelled' };
    if (!ok) {
      const ack = link.acks.get(probe.id);
      if (ack && !ack.ok) return fail(`refused: ${ack.message || 'no reason given'}`);
      if (ack?.ok) return fail('accepted the event but did not deliver it');
      return fail(link.lastReason ? `no answer (${link.lastReason})` : 'no answer');
    }
    link.clearLocal();
    link.reconnect = true;
    this.changed();
    return { ok: true };
  }

  private until(condition: () => boolean, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (condition()) return resolve(true);
        if (this.closed || Date.now() - started >= ms) return resolve(false);
        setTimeout(check, 25);
      };
      check();
    });
  }

  /** Resolves once every published event was accepted by some relay, or after `ms`. */
  drain(ms: number): Promise<boolean> {
    return this.until(
      () => this.outbox.every((e) => this.all().some((l) => l.acks.get(e.id)?.ok === true)),
      ms,
    );
  }

  close(): void {
    this.closed = true;
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.waiters.clear();
  }
}
