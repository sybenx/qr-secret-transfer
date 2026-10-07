import { expect, test } from '@playwright/test';
import { SECRET, type World, heading, pasteAs, shot, showAs, shownCode, world } from './harness.ts';

let w: World;
test.beforeEach(async () => {
  w = await world();
});
test.afterEach(async () => {
  const problems = [...w.problems];
  await w.close();
  expect(problems, 'no script errors or blocked resources').toEqual([]);
});

test('the slider starts at “Compare a code” and remembers where it is left', async ({ browser }) => {
  const page = await w.device(browser, [], { check: null });
  const slider = page.locator('#check');
  await expect(slider).toHaveValue('1');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Compare a code, medium checking');
  await expect(page.locator('.slider-mark[data-check="none"] .slider-level')).toHaveText('Low');
  await expect(page.locator('.slider-mark[data-check="type"] .bar.is-full')).toHaveCount(3);
  await expect(page.locator('#check-detail')).toContainText('Suits most things');
  await shot(page, 'c0-slider');

  await slider.fill('0');
  await expect(page.locator('#check-detail')).toContainText('anyone who sees the code can race you for it');
  await page.locator('.slider-mark[data-check="type"]').click();
  await expect(slider).toHaveValue('2');
  await page.reload();
  await page.waitForSelector('html.ready');
  await expect(page.locator('#check')).toHaveValue('2');
});

test('compare: the sender shows the same digits as the receiver, and confirming sends', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url], { check: 'compare' });
  const phone = await w.device(browser, [], { viewport: { width: 390, height: 844 }, check: 'compare' });
  const link = await showAs(laptop, 'receiver');
  expect(link).toContain('check=compare');
  expect(link).toMatch(/token=[0-9a-f]{32}/);

  await pasteAs(phone, 'sender', link);
  const code = await shownCode(laptop);
  await expect(heading(laptop)).toHaveText('Compare this code with your other device');
  await phone.waitForSelector('#compare-code');
  await expect(phone.locator('#compare-code')).toHaveAttribute('aria-label', `Pairing code ${code.split('').join(' ')}`);
  // No boxes to type into; the send control waits for the confirmation.
  await expect(phone.locator('.code input.digit')).toHaveCount(0);
  await expect(phone.locator('#release-send')).toBeDisabled();
  await shot(phone, 'c1-phone-compare');
  await phone.check('#agree');
  await phone.click('#release-send');

  await expect(laptop.locator('#rendering')).toHaveText('20 characters, starting with “sk-”');
  await laptop.click('#accept-keep');
  await laptop.click('#reveal');
  await expect(laptop.locator('#received')).toHaveText(SECRET);
  await expect(heading(phone)).toHaveText('Delivered');
});

test('compare: a stranger who answers first is visible, and “The codes are different” moves on', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url], { check: 'compare' });
  const stranger = await w.device(browser, [], { check: 'compare' });
  const phone = await w.device(browser, [], { check: 'compare' });
  const link = await showAs(laptop, 'sender');

  await pasteAs(stranger, 'receiver', link);
  const strangersCode = await shownCode(stranger);
  await pasteAs(phone, 'receiver', link);
  const realCode = await shownCode(phone);
  expect(realCode).not.toBe(strangersCode);

  // The sender is told two devices answered, and shows the first one's code.
  await expect(laptop.locator('#here')).toContainText('Another device also responded to this code.');
  await expect(laptop.locator('#compare-code')).toHaveAttribute('aria-label', `Pairing code ${strangersCode.split('').join(' ')}`);
  await shot(laptop, 'c2-laptop-race');
  await laptop.click('#release-differ');
  await expect(laptop.locator('#compare-code')).toHaveAttribute('aria-label', `Pairing code ${realCode.split('').join(' ')}`);
  await expect(laptop.locator('.mismatch')).toContainText('Not sent.');
  await laptop.check('#agree');
  await laptop.click('#release-send');

  await phone.click('#accept-keep');
  await phone.click('#reveal');
  await expect(phone.locator('#received')).toHaveText(SECRET);
  await expect(heading(stranger)).toHaveText('The other device cancelled');
});

test('no code: consent alone sends, and the page says what that gives up', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url], { check: 'none' });
  const link = await showAs(laptop, 'sender');
  expect(link).toContain('check=none');
  await expect(laptop.locator('#here')).toContainText('anyone who sees this code can answer it');

  const phone = await w.device(browser, [], { viewport: { width: 390, height: 844 }, url: link, check: 'none' });
  await phone.click('#incoming-go');
  await expect(heading(phone)).toHaveText('Waiting for the other device to send');
  await expect(phone.locator('#code')).toHaveCount(0);
  await expect(laptop.locator('#no-code')).toContainText('No code is checked');
  await expect(laptop.locator('#release-send')).toBeDisabled();
  await shot(laptop, 'c3-laptop-no-code');
  await laptop.check('#agree');
  await laptop.click('#release-send');

  await phone.click('#accept-keep');
  await phone.click('#reveal');
  await expect(phone.locator('#received')).toHaveText(SECRET);
});

test('no code: a second device answering stops everything, on every device', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url], { check: 'none' });
  const stranger = await w.device(browser, [], { check: 'none' });
  const phone = await w.device(browser, [], { check: 'none' });
  const link = await showAs(laptop, 'sender');
  await pasteAs(stranger, 'receiver', link);
  await laptop.waitForSelector('.screen.is-release');
  await pasteAs(phone, 'receiver', link);

  for (const page of [laptop, stranger, phone]) await expect(heading(page)).toHaveText('Two devices answered the pairing code');
  await shot(laptop, 'c4-laptop-second-responder');
  expect(JSON.stringify(relay.stored)).not.toContain(SECRET);
});

test('the stricter device decides: a receiver set to type overrides a sender set to no code', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url], { check: 'type' });
  const phone = await w.device(browser, [], { check: 'none' });
  const link = await showAs(laptop, 'receiver');
  await pasteAs(phone, 'sender', link);
  await expect(heading(laptop)).toHaveText('Type this code on your other device');
  await phone.waitForSelector('.screen.is-release');
  await expect(phone.locator('.code input.digit')).toHaveCount(5);
  await expect(phone.locator('#compare-code')).toHaveCount(0);
});
