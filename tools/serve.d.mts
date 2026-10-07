export function serve(options?: { port?: number; root?: string; head?: string }): Promise<{ url: string; close(): Promise<void> }>;
