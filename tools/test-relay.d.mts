export interface Behaviour {
  rejectWrites?: string;
  rateLimitAfter?: number;
  rejectKinds?: number[];
  authRequired?: 'write' | 'read' | 'both';
  recipientOnly?: boolean;
  maxEventBytes?: number;
  swallow?: boolean;
  silent?: boolean;
  delayMs?: number;
  nip11?: Record<string, unknown> | false;
  ephemeral?: 'live' | 'strfry';
}

export interface RelayEvent {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface TestRelay {
  url: string;
  port: number;
  stats: { connections: number; events: number; accepted: number; rejected: number; reqs: number; auths: number };
  stored: RelayEvent[];
  /** Every event accepted, stored or not. */
  received: RelayEvent[];
  /** How many subscriptions each event id was sent to. */
  deliveries: Map<string, number>;
  set(next: Behaviour): void;
  inject(event: unknown): void;
  kick(): void;
  close(): Promise<void>;
}

export function startRelay(options?: { port?: number; host?: string; behaviour?: Behaviour }): Promise<TestRelay>;
