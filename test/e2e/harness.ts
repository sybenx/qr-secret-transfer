// Two "devices" are two browser contexts: separate storage, separate pages, and the
// only thing they share is a relay, exactly as two real devices would.

import { type Browser, type BrowserContext, type BrowserContextOptions, type Page, expect } from '@playwright/test';
import { type Behaviour, type TestRelay, startRelay } from '../../tools/test-relay.mjs';
import { serve } from '../../tools/serve.mjs';

export const SECRET = 'sk-live-4f9a0c1d2e3b';
export const SHOTS = process.env.QRST_SHOTS;

export interface World {
  site: { url: string; close(): Promise<void> };
  relays: TestRelay[];
  contexts: BrowserContext[];
  problems: string[];
  relay(behaviour?: Behaviour): Promise<TestRelay>;
  /** A browser context that cannot leave this machine; see `sealed`. */
  context(browser: Browser, options?: BrowserContextOptions): Promise<BrowserContext>;
  /** `check` defaults to `type`, the strictest; `null` leaves it unset, as on a first visit. */
  device(browser: Browser, relayUrls: string[], options?: { viewport?: { width: number; height: number }; url?: string; check?: string | null }): Promise<Page>;
  close(): Promise<void>;
}

// The tests run against relays on this machine and nothing else. The page as shipped
// asks public relays for NIP-66 discovery and falls back to public seeds, so a test
// whose local relays all fail would reach the internet, and pass or fail on whatever
// answered. Two guards keep it here:
//   - the page is served with discovery and seeds set to "none", as an adopter would set
//     them, so the page never tries; and
//   - any WebSocket to anywhere else is cut off before it leaves and reported as a
//     problem, which every spec's afterEach fails on.
const OFFLINE = '<meta name="qrst:discovery" content="none"><meta name="qrst:seeds" content="none">';
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

async function sealed(context: BrowserContext, problems: string[]): Promise<void> {
  await context.routeWebSocket(
    (url) => !LOCAL.has(url.hostname),
    (ws) => {
      problems.push(`left this machine: WebSocket to ${ws.url()}`);
      void ws.close();
    },
  );
}

export async function world(): Promise<World> {
  const site = await serve({ head: OFFLINE });
  const w: World = {
    site,
    relays: [],
    contexts: [],
    problems: [],
    async relay(behaviour = {}) {
      const r = await startRelay({ behaviour });
      w.relays.push(r);
      return r;
    },
    async context(browser, options = {}) {
      const context = await browser.newContext(options);
      w.contexts.push(context);
      await sealed(context, w.problems);
      return context;
    },
    async device(browser, relayUrls, options = {}) {
      const context = await w.context(browser, { viewport: options.viewport ?? { width: 1100, height: 900 } });
      // Configure the page as a visitor would under "This device": these relays, and no seeds.
      const check = options.check === undefined ? 'type' : options.check;
      await context.addInitScript(
        ({ urls, check }) => {
          if (!localStorage.getItem('qrst.v1')) {
            localStorage.setItem(
              'qrst.v1',
              JSON.stringify({ configured: urls, seeds: [], discoveredAt: Math.floor(Date.now() / 1000), ...(check ? { check } : {}) }),
            );
          }
        },
        { urls: relayUrls, check },
      );
      const page = await context.newPage();
      page.on('pageerror', (e) => w.problems.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        // A relay that is down on purpose makes the browser log a failed connection; that is the test, not a fault.
        if (m.type() === 'error' && !/WebSocket connection|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) {
          w.problems.push(`console: ${m.text()}`);
        }
      });
      await page.goto(options.url ?? site.url);
      await page.waitForSelector('html.ready');
      return page;
    },
    async close() {
      await Promise.all(w.contexts.map((c) => c.close()));
      await Promise.all(w.relays.map((r) => r.close()));
      await site.close();
    },
  };
  return w;
}

export async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** On a device showing a code: the pairing link behind the QR. */
export async function pairingLink(page: Page): Promise<string> {
  await page.waitForSelector('figure.qr');
  await page.locator('details.more summary').click();
  return page.locator('#pairing-link').inputValue();
}

export async function showAs(page: Page, role: 'sender' | 'receiver', secret = SECRET): Promise<string> {
  if (role === 'sender') {
    await page.click('#choose-send');
    await page.fill('#secret', secret);
    await page.click('#compose-next');
  } else {
    await page.click('#choose-receive');
  }
  await page.click('#method-show');
  return pairingLink(page);
}

export async function pasteAs(page: Page, role: 'sender' | 'receiver', link: string, secret = SECRET): Promise<void> {
  if (role === 'sender') {
    await page.click('#choose-send');
    await page.fill('#secret', secret);
    await page.click('#compose-next');
  } else {
    await page.click('#choose-receive');
  }
  await page.click('#method-paste');
  await page.fill('#link', link);
  await page.click('#paste-go');
}

export async function shownCode(page: Page): Promise<string> {
  await page.waitForSelector('#code');
  const digits = await page.locator('#code .digit').allTextContents();
  expect(digits).toHaveLength(5);
  return digits.join('');
}

export async function typeCode(page: Page, code: string): Promise<void> {
  await page.waitForSelector('.screen.is-release');
  const boxes = page.locator('.code input.digit');
  await boxes.first().click();
  await page.keyboard.type(code, { delay: 20 });
}

export async function release(page: Page, code: string): Promise<void> {
  await typeCode(page, code);
  await page.check('#agree');
  await page.click('#release-send');
}

export const heading = (page: Page) => page.locator('#here .state');
