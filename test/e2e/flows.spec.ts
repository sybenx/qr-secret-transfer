import { expect, test } from '@playwright/test';
import { SECRET, type World, heading, pasteAs, release, shot, showAs, shownCode, typeCode, world } from './harness.ts';

let w: World;
test.beforeEach(async () => {
  w = await world();
});
test.afterEach(async () => {
  const problems = [...w.problems];
  await w.close();
  expect(problems, 'no script errors or blocked resources').toEqual([]);
});

test('Flow A: the receiver shows a code, the sender pastes its link', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url]);
  const phone = await w.device(browser, [], { viewport: { width: 390, height: 844 } });

  const link = await showAs(laptop, 'receiver');
  expect(link).toContain('#v=1&mode=offer&p=qrst-demo-text&npub=npub1');
  expect(link).toContain(`relay=${relay.url}`);
  // §11.2b: never bare, and a code that makes its scanner a Sender is the heavy one.
  await expect(laptop.locator('figure.qr.qr-offer figcaption')).toHaveText('Scanning this QR code sends a text from your other device to this one.');
  await shot(laptop, 'a1-laptop-offer-code');

  await pasteAs(phone, 'sender', link);
  await expect(heading(phone)).toHaveText('This is not a login. You are about to give your text to another device.');
  // §9.1: the claimed origin, as a claim; §12.1: this did not come from a scan.
  await expect(phone.locator('#here')).toContainText('says it is a web page at http://localhost');
  await expect(phone.locator('#here')).toContainText('did not come from scanning a QR code with this page’s camera');
  // The Sender never shows a code of its own, and its send control starts unavailable.
  await expect(phone.locator('#code')).toHaveCount(0);
  await expect(phone.locator('#release-send')).toBeDisabled();
  await expect(phone.locator('#release-send')).toContainText('Send my text to the device at http://localhost');
  await shot(phone, 'a2-phone-release-prompt');

  const code = await shownCode(laptop);
  await shot(laptop, 'a3-laptop-shows-code');
  await typeCode(phone, code);
  // Five digits alone are not enough at this friction tier.
  await expect(phone.locator('#release-send')).toBeDisabled();
  // Enter does nothing: the affirmative control has no default keyboard action.
  await phone.keyboard.press('Enter');
  await expect(phone.locator('.screen.is-release')).toBeVisible();
  await phone.check('#agree');
  await shot(phone, 'a4-phone-code-typed');
  await phone.click('#release-send');

  await expect(heading(laptop)).toHaveText('Your other device sent a text');
  await expect(laptop.locator('#rendering')).toHaveText('20 characters, starting with “sk-”');
  await shot(laptop, 'a5-laptop-accept');
  await expect(heading(phone)).toHaveText('Sent. Waiting for the other device to keep it');
  await laptop.click('#accept-keep');

  await expect(heading(laptop)).toHaveText('Received');
  await expect(laptop.locator('#received')).not.toContainText(SECRET);
  await laptop.click('#reveal');
  await expect(laptop.locator('#received')).toHaveText(SECRET);
  await shot(laptop, 'a6-laptop-received');
  await expect(heading(phone)).toHaveText('Delivered');
  await shot(phone, 'a7-phone-delivered');

  // What the relay was given: gift wraps and nothing readable.
  expect(relay.stored.length).toBeGreaterThanOrEqual(5);
  expect(relay.stored.every((e) => e.kind === 1059)).toBe(true);
  const everything = JSON.stringify(relay.stored);
  expect(everything).not.toContain(SECRET);
  expect(everything).not.toContain(Buffer.from(SECRET).toString('base64'));
  expect(everything).not.toContain(code);

  // Nothing secret was written to either device's storage.
  for (const page of [laptop, phone]) {
    const stored = await page.evaluate(() => Object.values({ ...localStorage, ...sessionStorage }).join('\n'));
    expect(stored).not.toContain(SECRET);
    // ...while the §14 record was: who, when, over what, and the multiple-responder flag.
    const log = JSON.parse(await page.evaluate(() => localStorage.getItem('qrst.v1')!)).log;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ profile: 'qrst-demo-text', transport: 'relay', relays: [relay.url], sas: code, multi: false });
  }
});

test('Flow B: the sender shows a code, the receiver opens its link', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url]);
  const link = await showAs(laptop, 'sender');
  expect(link).toContain('mode=request');
  await expect(laptop.locator('figure.qr.qr-request figcaption')).toHaveText('This device is sending a text. Scan this QR code to receive it.');
  await shot(laptop, 'b1-laptop-request-code');

  // The other device's camera app opens the link: this page is its own bounce page (§11.2a).
  const phone = await w.device(browser, [], { viewport: { width: 390, height: 844 }, url: link });
  await expect(heading(phone)).toHaveText('This link offers this device a secret');
  // The parameters are gone from the address bar once read.
  expect(new URL(phone.url()).hash).toBe('');
  await shot(phone, 'b2-phone-bounce');
  await phone.click('#incoming-go');

  const code = await shownCode(phone);
  await shot(phone, 'b3-phone-shows-code');
  await expect(heading(laptop)).toHaveText('This is not a login. You are about to give your text to another device.');
  await expect(laptop.locator('#here')).toContainText('The receiving device has not said what it is.');
  await expect(laptop.locator('#release-send')).toHaveText('Send my text to that device');
  await shot(laptop, 'b4-laptop-release-prompt');
  await release(laptop, code);

  await expect(phone.locator('#rendering')).toHaveText('20 characters, starting with “sk-”');
  await phone.click('#accept-keep');
  await phone.click('#reveal');
  await expect(phone.locator('#received')).toHaveText(SECRET);
  await expect(heading(laptop)).toHaveText('Delivered');
});

test('a wrong code sends nothing; five end the session and block that code (§9.2, §9.3)', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url]);
  const phone = await w.device(browser, []);
  const link = await showAs(laptop, 'receiver');
  await pasteAs(phone, 'sender', link);
  const code = await shownCode(laptop);
  const wrong = code === '11111' ? '22222' : '11111';

  await phone.waitForSelector('.screen.is-release');
  await phone.check('#agree');
  for (let attempt = 1; attempt <= 4; attempt++) {
    await typeCode(phone, wrong);
    await phone.click('#release-send');
    await expect(phone.locator('.mismatch')).toHaveText('Those digits do not match. Read the five digits on your other device again.');
    await expect(phone.locator('#here')).toContainText(`${5 - attempt} of 5 tries left`);
    // the boxes are cleared, never pre-filled
    expect(await phone.locator('.code input.digit').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(''))).toBe('');
  }
  await shot(phone, 'c1-phone-mismatch');
  await typeCode(phone, wrong);
  await phone.click('#release-send');
  await expect(heading(phone)).toHaveText('The digits did not match five times');
  // The device that showed the code is not ended by this: it goes back to showing it (§13).
  await expect(heading(laptop)).toHaveText('Scan this with the device that has the secret');
  expect(relay.stored.length).toBeLessThan(6); // HELLO, NONCE, REVEAL, ABORT: no payload

  // The same code will not be tried again from this device for an hour.
  await phone.click('#again');
  await pasteAs(phone, 'sender', link);
  await expect(phone.locator('#here .problem')).toContainText('already failed');
});

test('the code entry takes digits only, one per box, and never from the clipboard (§9.2)', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url]);
  const phone = await w.device(browser, []);
  const link = await showAs(laptop, 'receiver');
  await pasteAs(phone, 'sender', link);
  await phone.waitForSelector('.screen.is-release');
  const boxes = phone.locator('.code input.digit');
  await expect(boxes).toHaveCount(5);
  await boxes.first().click();
  await phone.keyboard.type('a1b2c3d4e5f6g7');
  expect(await boxes.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(['1', '2', '3', '4', '5']);
  // paste is refused
  await boxes.first().fill('');
  await boxes.first().focus();
  await phone.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', '99999');
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  expect(await boxes.first().inputValue()).toBe('');
  for (const box of await boxes.all()) {
    expect(await box.getAttribute('autocomplete')).toBe('off');
    expect(await box.getAttribute('maxlength')).toBe('1');
  }
  // Declining is first in the tab order after the form, and is the visually dominant control.
  const decline = await phone.locator('#release-decline').boundingBox();
  const send = await phone.locator('#release-send').boundingBox();
  expect(decline!.y).toBeLessThan(send!.y);
  expect(await phone.locator('#release-decline').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(0, 0, 0)');
  await phone.click('#release-decline');
  await expect(heading(phone)).toHaveText('Nothing was sent');
  // The device that showed the code is not ended by this: it goes back to showing it (§13).
  await expect(heading(laptop)).toHaveText('Scan this with the device that has the secret');
});

test('a stranger who answers first gets nothing, and the real device still gets through (§13)', async ({ browser }) => {
  const relay = await w.relay();
  const laptop = await w.device(browser, [relay.url]);
  const stranger = await w.device(browser, []);
  const phone = await w.device(browser, []);
  const link = await showAs(laptop, 'receiver');

  await pasteAs(stranger, 'sender', link, 'planted');
  const strangersCode = await shownCode(laptop);
  await pasteAs(phone, 'sender', link);
  await expect(laptop.locator('.notice')).toContainText('Another device also answered this QR code.');
  await shot(laptop, 'd1-laptop-two-responders');

  // The code on screen belongs to the stranger's session. On the real phone it does not match.
  await phone.waitForSelector('.screen.is-release');
  await phone.check('#agree');
  await typeCode(phone, strangersCode);
  await phone.click('#release-send');
  await expect(phone.locator('.mismatch')).toContainText('do not match');

  await laptop.click('#advance');
  await expect(laptop.locator('#code')).not.toHaveAttribute('aria-label', `Digits ${strangersCode.split('').join(' ')}`);
  const realCode = await shownCode(laptop);
  expect(realCode).not.toBe(strangersCode);
  await typeCode(phone, realCode);
  await phone.click('#release-send');
  await expect(laptop.locator('#rendering')).toHaveText('20 characters, starting with “sk-”');
  await laptop.click('#accept-keep');
  await laptop.click('#reveal');
  await expect(laptop.locator('#received')).toHaveText(SECRET);
});

test('role collision and foreign profiles are refused before anything is generated (§11.2)', async ({ browser }) => {
  const relay = await w.relay();
  const a = await w.device(browser, [relay.url]);
  const b = await w.device(browser, [relay.url]);
  const offer = await showAs(a, 'receiver');
  // A device set to receive is handed another Receiver's code.
  await pasteAs(b, 'receiver', offer);
  await expect(b.locator('#here .problem')).toContainText('also receiving');
  await b.fill('#link', offer.replace('p=qrst-demo-text', 'p=something-else'));
  await b.click('#paste-go');
  await expect(b.locator('#here .problem')).toContainText('“something-else”, which this page does not handle');
  await b.fill('#link', offer.replace('v=1', 'v=9'));
  await b.click('#paste-go');
  await expect(b.locator('#here .problem')).toContainText('version of QRST this page does not speak');
  expect(relay.stats.connections).toBe(1); // only the device showing the code ever connected
});
