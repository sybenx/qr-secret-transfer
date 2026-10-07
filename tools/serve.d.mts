export function serve(options?: { port?: number; root?: string }): Promise<{ url: string; close(): Promise<void> }>;
