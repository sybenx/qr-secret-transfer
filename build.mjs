// Builds the static site into docs/, which is what GitHub Pages serves.
//
//   node build.mjs
//
// The output is five kinds of file and nothing else: one HTML page, one stylesheet,
// one script bundle (with its source map and the licences of what it bundles), the
// fonts, and an icon. Nothing in it is fetched from another origin.

import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const out = 'docs';
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/fonts`, { recursive: true });

await build({
  entryPoints: ['src/demo/main.ts'],
  outfile: `${out}/app.js`,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  legalComments: 'linked',
  logLevel: 'warning',
});

await cp('src/demo/index.html', `${out}/index.html`);
await cp('src/demo/style.css', `${out}/style.css`);

const fonts = [
  ['atkinson-hyperlegible-next', ['400', '700', '800']],
  ['atkinson-hyperlegible-mono', ['400', '700']],
];
for (const [family, weights] of fonts) {
  for (const weight of weights) {
    const file = `${family}-latin-${weight}-normal.woff2`;
    await cp(`node_modules/@fontsource/${family}/files/${file}`, `${out}/fonts/${file}`);
  }
  await cp(`node_modules/@fontsource/${family}/LICENSE`, `${out}/fonts/${family}-LICENSE.txt`);
}

// The Q of the wordmark: a ring, a dot and a tail, on a grid of square modules.
await writeFile(
  `${out}/favicon.svg`,
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 8" shape-rendering="crispEdges"><rect width="7" height="8" fill="#fff"/><path d="M1 1h5v1h-5zM1 2h1v3h-1zM5 2h1v3h-1zM3 3h1v1h-1zM1 5h5v1h-5zM5 6h1v1h-1z"/></svg>\n',
);
await writeFile(`${out}/robots.txt`, 'User-agent: *\nAllow: /\n');
// Tell GitHub Pages to serve the files as they are.
await writeFile(`${out}/.nojekyll`, '');

const js = await readFile(`${out}/app.js`);
console.log(`docs/app.js  ${(js.length / 1024).toFixed(1)} KB, ${(gzipSync(js).length / 1024).toFixed(1)} KB gzipped`);
