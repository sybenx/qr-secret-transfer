import { chromium, expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qrVideo } from './camera.ts';
import { SECRET, type World, heading, pairingLink, shot, showAs, shownCode, typeCode, world } from './harness.ts';

let w: World;
test.beforeEach(async () => {
  w = await world();
});
test.afterEach(async () => {
  const problems = [...w.problems];
  await w.close();
  expect(problems, 'no script errors or blocked resources').toEqual([]);
});

test('scanning with this page’s own camera', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url]);
  const link = await showAs(laptop, 'receiver');

  // A second browser whose camera sees the laptop's code.
  const video = join(await mkdtemp(join(tmpdir(), 'qrst-')), 'code.y4m');
  await qrVideo(link, video);
  const withCamera = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  });
  try {
    const phone = await w.device(withCamera, [], { viewport: { width: 390, height: 844 } });
    await phone.click('#choose-send');
    await phone.fill('#secret', SECRET);
    await phone.click('#compose-next');
    await phone.click('#method-scan');
    await shot(phone, 'e1-phone-scanning');

    await expect(heading(phone)).toHaveText('This is not a login. You are about to give your text to another device.', { timeout: 20_000 });
    // Read by this page's camera, so the "arrived as a link" statement of §12.1 does not apply.
    await expect(phone.locator('#here')).not.toContainText('did not come from scanning');
    await expect(phone.locator('#here')).toContainText('says it is a web page at http://localhost');
    // The camera is released once the code is read.
    expect(await phone.locator('video').count()).toBe(0);

    const code = await shownCode(laptop);
    await typeCode(phone, code);
    await phone.check('#agree');
    await phone.click('#release-send');
    await laptop.click('#accept-keep');
    await laptop.click('#reveal');
    await expect(laptop.locator('#received')).toHaveText(SECRET);
    await expect(heading(phone)).toHaveText('Delivered');
  } finally {
    await withCamera.close();
  }
});

test('a camera that cannot be used is explained, and pasting still works', async ({ browser }) => {
  const laptop = await w.device(browser, []);
  await laptop.click('#choose-receive');
  await laptop.click('#method-scan');
  // Headless Chromium has no camera and nobody to grant one.
  await expect(laptop.locator('#here .problem')).toContainText('Paste the link instead');
  await laptop.getByRole('button', { name: 'Paste a link instead' }).click();
  await expect(heading(laptop)).toHaveText('Paste the link from the other device');
});

test('only relays that pass the loopback test go into the code (§11.3a)', async ({ browser }) => {
  const good = await w.relay();
  const closed = await w.relay({ rejectWrites: 'blocked: members only' });
  const swallow = await w.relay({ swallow: true });
  const laptop = await w.device(browser, [closed.url, 'ws://localhost:9', swallow.url, good.url]);
  const link = await showAs(laptop, 'receiver');
  const relays = new URLSearchParams(link.slice(link.indexOf('#') + 1)).getAll('relay');
  expect(relays).toEqual([good.url]);

  // The device says what it found, under "This device".
  await laptop.locator('.device details').first().locator('summary').click();
  const known = laptop.locator('#device .relays-known');
  await expect(known).toContainText('refused: blocked: members only');
  await expect(known).toContainText('accepted the event but did not deliver it');
  await expect(known).toContainText(/passed /);
  await shot(laptop, 'f1-laptop-relays-known');
});

test('with no relay that passes, it says so, keeps trying, and recovers', async ({ browser }) => {
  const relay = await w.relay({ rejectWrites: 'blocked: maintenance' });
  const laptop = await w.device(browser, [relay.url]);
  await laptop.click('#choose-receive');
  await laptop.click('#method-show');
  await expect(heading(laptop)).toHaveText('Finding a relay');
  await expect(laptop.locator('#here')).toContainText('did not pass: refused: blocked: maintenance');
  await expect(laptop.locator('#here')).toContainText('None has passed yet. Still trying.');
  // No code is shown that names an untested relay.
  expect(await laptop.locator('figure.qr').count()).toBe(0);
  await shot(laptop, 'f2-laptop-finding-relay');
  relay.set({});
  expect(await pairingLink(laptop)).toContain(`relay=${relay.url}`);
});

test('the page asks nothing of the network until a transfer is started (§11.2a)', async ({ browser }) => {
  const context = await w.context(browser);
  const page = await context.newPage();
  const requests: string[] = [];
  const sockets: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('websocket', (s) => sockets.push(s.url()));
  const violations: string[] = [];
  page.on('console', (m) => m.text().includes('Content Security Policy') && violations.push(m.text()));
  await page.goto(w.site.url);
  await page.waitForSelector('html.ready');
  await page.waitForTimeout(1500);
  const origin = new URL(w.site.url).origin;
  expect(requests.every((u) => u.startsWith(origin))).toBe(true);
  expect(sockets).toEqual([]);
  expect(violations).toEqual([]);
  // The whole page is these files and nothing else.
  const allowed = /^\/(|app\.js|style\.css|favicon\.svg|fonts\/atkinson-hyperlegible-(next|mono)-latin-\d00-normal\.woff2)$/;
  for (const url of requests) expect(new URL(url).pathname).toMatch(allowed);
  expect(requests.length).toBeGreaterThanOrEqual(3);
});

test('a pairing link opened in a page that makes this device the sender', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url]);
  const link = await showAs(laptop, 'receiver');
  const phone = await w.device(browser, [], { viewport: { width: 390, height: 844 }, url: link });
  await expect(heading(phone)).toHaveText('This link asks this device to send a secret');
  await expect(phone.locator('#here')).toContainText('says it is a web page at http://localhost');
  await expect(phone.locator('#here')).toContainText('opened, not scanned');
  await shot(phone, 'g1-phone-bounce-sender');
  await phone.click('#incoming-go');
  // Nothing to send yet: it asks, and only then contacts the other device.
  await expect(heading(phone)).toHaveText('What do you want to send?');
  expect(relay.stats.connections).toBe(1);
  await phone.fill('#secret', SECRET);
  await phone.click('#compose-next');
  const code = await shownCode(laptop);
  await typeCode(phone, code);
  await phone.check('#agree');
  await phone.click('#release-send');
  await laptop.click('#accept-keep');
  await expect(heading(phone)).toHaveText('Delivered');
});

test('the Receiver discarding what arrived keeps nothing', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url]);
  const link = await showAs(laptop, 'receiver');
  const phone = await w.device(browser, [], { url: link });
  await phone.click('#incoming-go');
  await phone.fill('#secret', SECRET);
  await phone.click('#compose-next');
  await typeCode(phone, await shownCode(laptop));
  await phone.check('#agree');
  await phone.click('#release-send');
  await laptop.click('#accept-discard');
  await expect(heading(laptop)).toHaveText('Discarded');
  await expect(heading(phone)).toHaveText('The other device did not keep it');
  expect(await laptop.content()).not.toContain(SECRET);
});

test('an over-long secret is refused before any pairing', async ({ browser }) => {
  const laptop = await w.device(browser, []);
  await laptop.click('#choose-send');
  await laptop.fill('#secret', 'x'.repeat(2049));
  await expect(laptop.locator('#bytes')).toContainText('2049 bytes. The most this demo carries is 2048.');
  await expect(laptop.locator('#compose-next')).toBeDisabled();
  await laptop.fill('#secret', 'é'.repeat(1024)); // 2048 bytes of UTF-8
  await expect(laptop.locator('#bytes')).toHaveText('2048 of 2048 bytes');
  await expect(laptop.locator('#compose-next')).toBeEnabled();
});

test('a long claimed origin cannot push “Don’t send” off a small screen (§9.1)', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url]);
  const link = await showAs(laptop, 'receiver');
  const long = `https://this-is-your-own-phone.${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example`;
  const phone = await w.device(browser, [], { viewport: { width: 320, height: 640 }, url: link.replace(/origin=[^&]+/, `origin=${long}`) });
  await phone.click('#incoming-go');
  await phone.fill('#secret', SECRET);
  await phone.click('#compose-next');
  await phone.waitForSelector('.screen.is-release');
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const decline = await phone.locator('#release-decline').boundingBox();
  expect(decline!.x).toBeGreaterThanOrEqual(0);
  expect(decline!.x + decline!.width).toBeLessThanOrEqual(320);
  await shot(phone, 'h1-phone-long-origin');
});

test('Flow B: the Sender that showed the code is told when a second device answers (§13)', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url]);
  const link = await showAs(laptop, 'sender');
  const stranger = await w.device(browser, [], { url: link });
  await stranger.click('#incoming-go');
  const phone = await w.device(browser, [], { url: link });
  await phone.click('#incoming-go');
  await expect(laptop.locator('#here')).toContainText('Another device also answered this QR code. If that wasn’t you, someone nearby may have scanned it. Nothing was shared with them.');
  await typeCode(laptop, await shownCode(phone));
  await laptop.check('#agree');
  await laptop.click('#release-send');
  await phone.click('#accept-keep');
  await expect(heading(laptop)).toHaveText('Delivered');
  await expect(heading(stranger)).toHaveText('The other device cancelled');
});

test('inside another site’s frame the page does nothing', async ({ browser }) => {
  const context = await w.context(browser);
  const page = await context.newPage();
  // Another origin on this machine: the same server by its other name, on a path it does not serve.
  await page.goto(w.site.url.replace('localhost', '127.0.0.1') + 'outer');
  await page.evaluate((src) => {
    const frame = document.createElement('iframe');
    frame.src = src;
    frame.width = '900';
    frame.height = '900';
    document.body.append(frame);
  }, w.site.url);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#here .state')).toHaveText('Open this page on its own');
  await expect(frame.locator('#choose-send')).toHaveCount(0);
});
