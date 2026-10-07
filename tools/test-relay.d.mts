export interface Behaviour {
  rejectWrites?: string;
  rejectKinds?: number[];
  authRequired?: 'write' | 'read' | 'both';
  recipientOnly?: boolean;
  maxEventBytes?: number;
  swallow?: boolean;
  silent?: boolean;
  delayMs?: number;
  nip11?: Record<string, unknown> | false;
}

export interface TestRelay {
  url: string;
  port: number;
  stats: { connections: number; events: number; accepted: number; rejected: number; reqs: number; auths: number };
  stored: { id: string; kind: number; pubkey: string; created_at: number; tags: string[][]; content: string; sig: string }[];
  set(next: Behaviour): void;
  inject(event: unknown): void;
  kick(): void;
  close(): Promise<void>;
}

export function startRelay(options?: { port?: number; host?: string; behaviour?: Behaviour }): Promise<TestRelay>;
