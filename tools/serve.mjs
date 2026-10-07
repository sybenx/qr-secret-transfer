// A static file server for docs/, for local development and the browser tests.
//
//   node tools/serve.mjs [port]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** `head` is markup added at the top of index.html's <head>; the browser tests use it to configure the page. */
export async function serve({ port = 0, root = 'docs', head = '' } = {}) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(root, normalize(path === '/' ? '/index.html' : path));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    try {
      let body = await readFile(file);
      if (head && file === join(root, 'index.html')) {
        const html = body.toString('utf8');
        if (!html.includes('<head>')) throw new Error(`no <head> in ${file}`);
        body = html.replace('<head>', `<head>${head}`);
      }
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://localhost:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  serve({ port: Number(process.argv[2] ?? 8080) }).then((site) => console.log(`serving docs/ at ${site.url}`));
}
