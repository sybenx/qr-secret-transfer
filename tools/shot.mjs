// Development aid: screenshots of the built page at a desktop and a phone size.
import { chromium } from '@playwright/test';
import { serve } from './serve.mjs';

const out = process.argv[2] ?? '.';
const site = await serve();
const browser = await chromium.launch();
for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: name === 'phone' ? 2 : 1 });
  page.on('console', (m) => m.type() === 'error' && console.log(`[${name} console]`, m.text()));
  page.on('pageerror', (e) => console.log(`[${name} error]`, e.message));
  await page.goto(site.url);
  await page.waitForSelector('html.ready');
  await page.screenshot({ path: `${out}/home-${name}.png` });
  await page.screenshot({ path: `${out}/home-${name}-full.png`, fullPage: true });
  await page.close();
}
await browser.close();
await site.close();
