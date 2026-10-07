// The demo: one page that is both a QRST client and the bounce page its own QR codes
// point at (spec §11.2a). It moves a short piece of text between two devices.
//
// Nothing here talks to a network until the visitor starts a transfer.

import {
  MAX_ATTEMPTS,
  type Outcome,
  type PairingParams,
  type Role,
  UriError,
  demoText,
  looksLikePairing,
  parseUri,
  relayPolicy,
  scannerRole,
  utf8Encode,
} from '../core/index.ts';
import { type RelayStatus, Store, Transfer, type TransferDeps, type TransferView, browserEnv, loopbackOnce } from '../web/index.ts';
import { adopterRelays, discoveryHints, seeds } from './config.ts';
import { type Child, append, copyText, h, replace } from './dom.ts';
import { BitField } from './field.ts';
import { qrSvg } from './qr.ts';
import { type ScanProblem, type Scanner, startScanner } from './scanner.ts';

const profile = demoText;
const env = browserEnv();
// A relay on this machine is usable only by a page served from this machine.
relayPolicy.loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
/** Inside someone else's frame this page does nothing: its prompts must not be dressed up by another site. */
const framed = window.top !== window.self;

function storage(): Storage | undefined {
  try {
    const s = window.localStorage;
    s.getItem('qrst.v1');
    return s;
  } catch {
    return undefined;
  }
}

const store = new Store(storage(), env.now, seeds(), adopterRelays());
const deps: TransferDeps<string> = {
  profile,
  store,
  env,
  baseUrl: `${location.origin}${location.pathname}`,
  origin: location.origin,
  discoveryHints: discoveryHints(),
};

const here = document.getElementById('here')!;
const there = document.getElementById('there')!;
const crossed = document.getElementById('crossed')!;
const drawer = document.getElementById('device')!;
const field = new BitField(document.getElementById('bits') as HTMLCanvasElement);

// ---- state ----------------------------------------------------------------------------

type Pairing = { params: PairingParams; viaCamera: boolean };

type Screen =
  | { name: 'home' }
  | { name: 'incoming'; pairing: Pairing; link: string }
  | { name: 'compose' }
  | { name: 'method' }
  | { name: 'scan' }
  | { name: 'paste' }
  | { name: 'interference'; proceed: () => void }
  | { name: 'refused'; title: string; detail: string }
  | { name: 'transfer' };

let screen: Screen = { name: 'home' };
let role: Role | undefined;
let secret = '';
/** A code that was read before there was anything to send. */
let pending: Pairing | undefined;
let transfer: Transfer<string> | undefined;
let scanner: Scanner | undefined;
let messages = 0;
let first = true;

// ---- small pieces ---------------------------------------------------------------------

const button = (label: string, onClick: () => void, kind: 'primary' | 'plain' | 'quiet' = 'plain', attrs: Record<string, string | boolean> = {}) =>
  h('button', { type: 'button', class: `btn btn-${kind}`, onClick, ...attrs }, label);

const title = (text: string) => h('h3', { class: 'state', tabindex: '-1' }, text);

const actions = (...buttons: (HTMLElement | false | undefined)[]) => h('div', { class: 'actions' }, ...buttons);

function clock(until: number): string {
  const left = Math.max(0, until - env.now());
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

const shortKey = (pub: string) => `${pub.slice(0, 8)}…${pub.slice(-4)}`;

function when(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---- navigation -----------------------------------------------------------------------

function go(next: Screen): void {
  scanner?.stop();
  scanner = undefined;
  screen = next;
  render();
}

function reset(): void {
  transfer?.dispose();
  transfer = undefined;
  secret = '';
  role = undefined;
  pending = undefined;
  messages = 0;
  go({ name: 'home' });
}

/** §9.3: after three failed sessions in an hour, say what that can mean before another try. */
function withInterferenceNotice(proceed: () => void): void {
  if (role === 'sender' && store.shouldWarnOfInterference()) go({ name: 'interference', proceed });
  else proceed();
}

function attach(t: Transfer<string>): void {
  transfer = t;
  messages = 0;
  t.onChange = () => {
    if (transfer === t) render();
  };
  t.onCross = (ciphertext, direction) => {
    if (transfer !== t) return;
    messages++;
    field.cross(ciphertext, direction);
  };
  go({ name: 'transfer' });
}

function startShowing(): void {
  withInterferenceNotice(() => {
    try {
      attach(Transfer.show(deps, role!, role === 'sender' ? secret : undefined));
    } catch (error) {
      go({ name: 'refused', title: 'That could not be started', detail: error instanceof Error ? error.message : String(error) });
    }
  });
}

function startJoining(pairing: Pairing): void {
  withInterferenceNotice(() => {
    try {
      attach(Transfer.join(deps, pairing.params, { viaCamera: pairing.viaCamera }, role === 'sender' ? secret : undefined));
    } catch (error) {
      go({ name: 'refused', title: 'That could not be started', detail: error instanceof Error ? error.message : String(error) });
    }
  });
}

const URI_PROBLEMS: Record<string, string> = {
  'not-a-pairing-link': 'That is not a QRST pairing code.',
  'unknown-version': 'That code is from a version of QRST this page does not speak.',
  'missing-mode': 'That code does not say which device sends and which receives.',
  'missing-profile': 'That code does not say what kind of secret it is for.',
  'bad-key': 'The key in that code is damaged. If you typed or pasted it, a character is wrong.',
  'no-relays': 'That code names no relay to meet on.',
  'bad-relay': 'That code names a relay address this page will not use.',
  'bad-origin': 'That code makes a claim about where it came from that is not a web address.',
};

/**
 * A pairing code arrived: scanned here, pasted, or opened as a link. Returns a message
 * if it cannot be used, and otherwise moves on.
 */
function onPairing(text: string, viaCamera: boolean, confirmFirst = false): string | undefined {
  let params: PairingParams;
  try {
    params = parseUri(text);
  } catch (error) {
    return error instanceof UriError ? URI_PROBLEMS[error.code] : 'That code could not be read.';
  }
  // Everything below happens before a throwaway key is generated (§11.2).
  const refusal = Transfer.refusal(deps, params, role);
  if (refusal === 'unknown-profile') {
    return `That code is for “${params.profile}”, which this page does not handle. It handles “${profile.id}”.`;
  }
  if (refusal === 'role-collision') {
    return role === 'sender'
      ? 'That code is from a device that is also sending. One of the two has to receive: start over on one of them.'
      : 'That code is from a device that is also receiving. One of the two has to send: start over on one of them.';
  }
  if (refusal === 'blocked-peer') {
    return 'A pairing code already failed against that device’s code within the last hour. Ask the other device for a new code.';
  }
  const pairing = { params, viaCamera };
  if (confirmFirst) {
    go({ name: 'incoming', pairing, link: text });
    return undefined;
  }
  proceedWith(pairing);
  return undefined;
}

function proceedWith(pairing: Pairing): void {
  role = scannerRole(pairing.params.mode);
  if (role === 'sender' && secret === '') {
    pending = pairing;
    go({ name: 'compose' });
  } else {
    startJoining(pairing);
  }
}

// ---- screens: before a transfer -------------------------------------------------------

function homeScreen(): Node[] {
  return [
    title('What should this device do?'),
    h(
      'div',
      { class: 'choices' },
      h(
        'button',
        { type: 'button', class: 'choice', id: 'choose-send', onClick: () => ((role = 'sender'), go({ name: 'compose' })) },
        h('strong', null, 'Send a secret'),
        h('span', null, 'It is on this device and should go to the other one.'),
      ),
      h(
        'button',
        { type: 'button', class: 'choice', id: 'choose-receive', onClick: () => ((role = 'receiver'), go({ name: 'method' })) },
        h('strong', null, 'Receive a secret'),
        h('span', null, 'It is on the other device and should come here.'),
      ),
    ),
    h('p', { class: 'fine' }, 'This is a demo of a draft protocol and the code has not been audited. Use something made up, not a real password.'),
  ];
}

function composeScreen(): Node[] {
  const max = profile.maxPayloadBytes;
  const count = h('span', { class: 'fine', id: 'bytes' });
  const next = button(pending ? 'Continue' : 'Choose how to pair', () => {
    secret = area.value;
    if (pending) {
      const p = pending;
      pending = undefined;
      startJoining(p);
    } else {
      go({ name: 'method' });
    }
  }, 'primary', { id: 'compose-next' });
  const area = h('textarea', {
    id: 'secret',
    rows: '4',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    'aria-describedby': 'bytes',
    onInput: () => update(),
  });
  area.value = secret;
  const update = () => {
    const bytes = utf8Encode(area.value).length;
    count.textContent = bytes > max ? `${bytes} bytes. The most this demo carries is ${max}.` : `${bytes} of ${max} bytes`;
    count.classList.toggle('over', bytes > max);
    next.disabled = bytes < 1 || bytes > max;
  };
  update();
  return [
    title('What do you want to send?'),
    h('label', { for: 'secret', class: 'label' }, 'The text to send'),
    area,
    count,
    h('p', { class: 'fine' }, 'It stays in this page’s memory until it is sent or you leave. It is not saved, and nothing is sent yet.'),
    actions(next, button('Back', reset, 'quiet')),
  ];
}

function methodScreen(): Node[] {
  const sending = role === 'sender';
  return [
    title(sending ? 'Pair with the device that should receive it' : 'Pair with the device that has the secret'),
    h(
      'div',
      { class: 'choices' },
      h(
        'button',
        { type: 'button', class: 'choice', id: 'method-show', onClick: startShowing },
        h('strong', null, 'Show a code here'),
        h('span', null, 'The other device scans this screen. Best when this device has no camera to point.'),
      ),
      h(
        'button',
        { type: 'button', class: 'choice', id: 'method-scan', onClick: () => go({ name: 'scan' }) },
        h('strong', null, 'Scan a code with this device'),
        h('span', null, 'The other device is already showing one.'),
      ),
      h(
        'button',
        { type: 'button', class: 'choice', id: 'method-paste', onClick: () => go({ name: 'paste' }) },
        h('strong', null, 'Paste a link'),
        h('span', null, 'Neither device can scan. The other one gives you its code as a link.'),
      ),
    ),
    actions(button('Back', reset, 'quiet')),
  ];
}

const SCAN_PROBLEMS: Record<ScanProblem, string> = {
  denied: 'This page was not allowed to use the camera. Allow it in the browser’s site settings, or paste the link instead.',
  'no-camera': 'This device has no camera this page can use. Paste the link instead.',
  insecure: 'A browser only lends its camera to a page loaded over https. Paste the link instead.',
  failed: 'The camera could not be started. Paste the link instead.',
};

function scanScreen(): Node[] {
  const video = h('video', { class: 'viewfinder', playsinline: true, muted: true, 'aria-label': 'Camera view' });
  const status = h('p', { class: 'fine', role: 'status' }, 'Point the camera at the code on the other device.');
  scanner = startScanner(
    video,
    (text) => {
      if (!looksLikePairing(text)) {
        status.textContent = 'That is a QR code, but not a QRST pairing code.';
        return false;
      }
      const problem = onPairing(text, true);
      if (problem) {
        status.textContent = problem;
        return false;
      }
      return true;
    },
    (problem) => {
      video.remove();
      status.textContent = SCAN_PROBLEMS[problem];
      status.classList.add('problem');
    },
  );
  return [
    title('Scan the code on the other device'),
    video,
    status,
    actions(button('Paste a link instead', () => go({ name: 'paste' })), button('Back', () => go({ name: 'method' }), 'quiet')),
  ];
}

function pasteScreen(): Node[] {
  const status = h('p', { class: 'fine problem', role: 'alert' });
  const input = h('textarea', {
    id: 'link',
    rows: '3',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    placeholder: 'https://…#v=1&mode=…',
  });
  const submit = () => {
    const problem = onPairing(input.value, false);
    if (problem) status.textContent = problem;
  };
  return [
    title('Paste the link from the other device'),
    h('label', { for: 'link', class: 'label' }, 'Pairing link'),
    input,
    status,
    h('p', { class: 'fine' }, 'On the other device, choose “Show a code here”, then “Copy the link”. The link is not secret: it holds a throwaway public key and relay addresses.'),
    actions(button('Use this link', submit, 'primary', { id: 'paste-go' }), button('Back', () => go({ name: 'method' }), 'quiet')),
  ];
}

/** The bounce page of §11.2a: say what this link is before acting on it. */
function incomingScreen(s: Extract<Screen, { name: 'incoming' }>): Node[] {
  const { params } = s.pairing;
  const becomes = scannerRole(params.mode);
  const copied = h('span', { class: 'fine', role: 'status' });
  return [
    title(becomes === 'sender' ? 'This link asks this device to send a secret' : 'This link offers this device a secret'),
    h(
      'p',
      null,
      becomes === 'sender'
        ? 'It is a QRST pairing code from a device that wants to receive. If you continue, you choose what to send, and nothing leaves this device until you type a code shown on that one.'
        : 'It is a QRST pairing code from a device that is sending. If you continue, this device shows you what arrived before keeping anything.',
    ),
    h(
      'p',
      { class: 'claim' },
      ...(params.origin
        ? ['The device that made it says it is a web page at ', h('strong', null, params.origin), '. Nothing has verified that.']
        : ['The device that made it presents itself as an app, not a web page. Nothing has verified that.']),
    ),
    h('p', { class: 'fine' }, 'This link was opened, not scanned with this page’s own camera, so this page has no evidence the code was ever in front of you.'),
    actions(
      button(becomes === 'sender' ? 'Continue as the sender' : 'Continue as the receiver', () => proceedWith(s.pairing), 'primary', { id: 'incoming-go' }),
      button('Copy the link', async () => {
        copied.textContent = (await copyText(s.link)) ? 'Copied.' : 'Copying is blocked here; select the address bar instead.';
      }),
      button('Leave it', reset, 'quiet'),
    ),
    copied,
  ];
}

function interferenceScreen(s: Extract<Screen, { name: 'interference' }>): Node[] {
  return [
    title('Three transfers have failed in the last hour'),
    h('p', null, 'Each ended with a pairing code that did not match. A mistyped code is the usual reason. Someone interfering with the connection is the other.'),
    h('p', null, 'If you are sure you typed the codes correctly, stop here and try again later from a different network.'),
    actions(button('Stop', reset, 'primary'), button('I understand. Try again', s.proceed, 'plain', { id: 'interference-go' })),
  ];
}

function refusedScreen(s: Extract<Screen, { name: 'refused' }>): Node[] {
  return [title(s.title), h('p', null, s.detail), actions(button('Start again', reset, 'primary'))];
}

// ---- screens: during a transfer -------------------------------------------------------

const RELAY_STATE: Record<RelayStatus['state'], string> = {
  testing: 'testing',
  failed: 'did not pass',
  spare: 'passed, not needed',
  connecting: 'connecting',
  open: 'connected',
  closed: 'not connected',
};

function relayList(relays: RelayStatus[]): HTMLElement {
  return h(
    'ul',
    { class: 'relays' },
    ...relays.map((r) =>
      h(
        'li',
        { class: `relay relay-${r.state}` },
        h('span', { class: 'relay-url' }, host(r.url)),
        h('span', { class: 'relay-state' }, RELAY_STATE[r.state] + (r.state === 'failed' && r.why ? `: ${r.why}` : '')),
      ),
    ),
  );
}

interface Built {
  nodes: Child[];
  update?(v: TransferView<string>): void;
}

function relaysScreen(v: TransferView<string>): Built {
  const list = h('div');
  const note = h('p', { class: 'fine' });
  const update = (view: TransferView<string>) => {
    replace(list, relayList(view.relays));
    const failed = view.relays.filter((r) => r.state === 'failed').length;
    note.textContent =
      view.relays.length === 0
        ? 'Looking for relays to test.'
        : failed === view.relays.length
          ? 'None has passed yet. Still trying. You can add a relay of your own under “This device” below.'
          : '';
  };
  update(v);
  return {
    nodes: [
      title('Finding a relay'),
      h('p', null, 'This device is sending itself a sealed message through each relay it knows. A relay goes into the code only if the message comes back.'),
      list,
      note,
      actions(button('Cancel', reset, 'quiet')),
    ],
    update,
  };
}

function qrScreen(v: TransferView<string>): Built {
  const uri = v.uri!;
  const heavy = v.mode === 'offer';
  const left = h('span', { class: 'clock', 'aria-hidden': 'true' }, clock(v.session.expiresAt));
  const relayLine = h('span');
  const linkBox = h('textarea', { class: 'link', id: 'pairing-link', readonly: true, rows: '3', 'aria-label': 'Pairing link' });
  linkBox.value = uri;
  const copied = h('span', { class: 'fine', role: 'status' });
  const update = (view: TransferView<string>) => {
    left.textContent = clock(view.session.expiresAt);
    const using = view.relays.filter((r) => r.inUse);
    const up = using.filter((r) => r.state === 'open').length;
    relayLine.textContent = `Listening on ${up} of ${using.length} relay${using.length === 1 ? '' : 's'}: ${using.map((r) => host(r.url)).join(', ')}.`;
  };
  update(v);
  return {
    nodes: [
      title(v.role === 'receiver' ? 'Scan this with the device that has the secret' : 'Scan this with the device that should receive it'),
      // §11.2b: a QR is never shown bare, and a code that makes its scanner a Sender carries more weight.
      h(
        'figure',
        { class: heavy ? 'qr qr-offer' : 'qr qr-request' },
        qrSvg(uri, 'QRST pairing code'),
        h('figcaption', null, profile.direction[v.mode]),
      ),
      h('p', { class: 'fine' }, 'This code works for ', left, ' more. ', relayLine),
      h(
        'details',
        { class: 'more' },
        h('summary', null, 'Can’t scan it? Copy the link instead'),
        linkBox,
        actions(
          button('Copy the link', async () => {
            copied.textContent = (await copyText(uri)) ? 'Copied. Paste it on the other device.' : 'Copying is blocked here; select the text above.';
          }, 'plain', { id: 'copy-link' }),
          copied,
        ),
        h('p', { class: 'fine' }, 'The link holds a throwaway public key and relay addresses. It is not secret, and it stops working when this code does.'),
      ),
      actions(button('Cancel', reset, 'quiet')),
    ],
    update,
  };
}

function contactingScreen(v: TransferView<string>): Built {
  const note = h('p', { class: 'fine', role: 'status' });
  const list = h('div');
  const since = Date.now();
  const update = (view: TransferView<string>) => {
    replace(list, relayList(view.relays));
    note.textContent = view.connected
      ? 'Connected. Waiting for the other device to answer.'
      : Date.now() - since > 3000
        ? 'Can’t reach the relays this code names yet. Still trying, for as long as the code is valid.'
        : 'Connecting to the relays the code names.';
  };
  update(v);
  return { nodes: [title('Contacting the other device'), note, list, actions(button('Cancel', reset, 'quiet'))], update };
}

/** The release prompt of §9.1 and the code entry of §9.2. */
function releaseScreen(v: TransferView<string>): Built {
  const origin = v.peerOrigin;
  const boxes: HTMLInputElement[] = [];
  const agree = h('input', { type: 'checkbox', id: 'agree' });
  const message = h('p', { class: 'mismatch', role: 'alert' });
  const tries = h('p', { class: 'fine' });
  const others = h('p', { class: 'claim' });

  const digits = () => boxes.map((b) => b.value).join('');
  const refresh = () => {
    send.disabled = !(digits().length === 5 && agree.checked);
  };
  // Described by what it does, never "OK" or "Continue"; names the claimed origin (§9.1).
  const send = button(profile.release.confirm(origin), () => {
    const typed = digits();
    if (!/^[0-9]{5}$/.test(typed) || !agree.checked || !transfer) return;
    const before = transfer.view().session.attemptsLeft;
    transfer.enterCode(typed);
    const after = transfer.view();
    if (after.session.phase === 'release' && after.session.attemptsLeft < before) {
      for (const b of boxes) b.value = '';
      refresh();
      message.textContent = 'That code does not match. Read the five digits on your other device again.';
      boxes[0]!.focus();
    }
  }, 'plain', { id: 'release-send', disabled: true });

  for (let i = 0; i < 5; i++) {
    const box = h('input', {
      type: 'text',
      inputmode: 'numeric',
      pattern: '[0-9]',
      maxlength: '1',
      // Not "one-time-code": that would invite the browser to fill it from somewhere else.
      autocomplete: 'off',
      class: 'digit',
      'aria-label': `Digit ${i + 1} of 5`,
      onInput: () => {
        box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
        if (box.value && i < 4) boxes[i + 1]!.focus();
        message.textContent = '';
        refresh();
      },
      onKeydown: (e) => {
        const key = (e as KeyboardEvent).key;
        if (key === 'Backspace' && !box.value && i > 0) {
          boxes[i - 1]!.value = '';
          boxes[i - 1]!.focus();
          refresh();
        }
      },
      // §9.2: never filled from the clipboard.
      onPaste: (e) => e.preventDefault(),
      onDrop: (e) => e.preventDefault(),
    });
    boxes.push(box);
  }
  agree.addEventListener('change', refresh);

  const claim = !v.showing
    ? origin
      ? ['The receiving device says it is a web page at ', h('strong', null, origin), '. That is its own claim. Nothing has verified it.']
      : ['The receiving device presents itself as an app, not a web page. Nothing has verified that.']
    : ['The receiving device has not said what it is.'];

  const update = (view: TransferView<string>) => {
    const left = view.session.attemptsLeft;
    tries.textContent = left < MAX_ATTEMPTS ? `${left} of ${MAX_ATTEMPTS} tries left. After that this code is finished and nothing is sent.` : '';
    const several = view.showing && (view.session.multipleResponders || view.session.dropped > 0);
    // §13, on the device that showed the code, in the specification's words.
    others.textContent = several
      ? 'Another device also responded to this code. If that wasn’t you, someone nearby may have scanned it. Nothing was shared with them. The digits you type decide which device gets the text: only the one whose screen shows them.'
      : '';
    others.hidden = !several;
  };
  update(v);

  return {
    nodes: [
      title(profile.release.heading),
      h('p', null, profile.release.body),
      h('p', { class: 'claim' }, ...claim),
      !v.viaCamera && h('p', { class: 'claim' }, 'This request did not come from scanning a code with this page’s camera. It arrived as a link.'),
      others,
      h('p', { class: 'label', id: 'code-label' }, 'Pairing code shown on your other device'),
      h('div', { class: 'code', role: 'group', 'aria-labelledby': 'code-label' }, ...boxes),
      message,
      tries,
      h('label', { class: 'check', for: 'agree' }, agree, h('span', null, 'I can see the receiving device, and I mean to give it this text.')),
      // §9.1: declining is the prominent control; the affirmative is neither default nor dominant.
      h('div', { class: 'actions actions-release' }, button(profile.release.decline, () => transfer?.decline(), 'primary', { id: 'release-decline' }), send),
    ],
    update,
  };
}

function codeScreen(v: TransferView<string>): Built {
  const code = v.session.code ?? '';
  const left = h('span', { class: 'clock', 'aria-hidden': 'true' }, clock(v.session.expiresAt));
  const notice = h('div', { class: 'notice' });
  const update = (view: TransferView<string>) => {
    left.textContent = clock(view.session.expiresAt);
    if (!view.session.multipleResponders) return replace(notice);
    replace(
      notice,
      // §13: soft, non-blocking, on the device that showed the code.
      h('p', null, 'Another device also responded to this code. If that wasn’t you, someone nearby may have scanned it. Nothing was shared with them.'),
      view.showing && view.session.canAdvance
        ? button('The other device rejected this code. Show the next one', () => transfer?.advance(), 'plain', { id: 'advance' })
        : false,
    );
  };
  update(v);
  return {
    nodes: [
      title('Type this code on your other device'),
      // Shown here and typed there, never the other way round (§9.2).
      h(
        'div',
        { class: 'code code-shown', role: 'img', 'aria-label': `Pairing code ${code.split('').join(' ')}`, id: 'code' },
        ...code.split('').map((d) => h('span', { class: 'digit', 'aria-hidden': 'true' }, d)),
      ),
      h('p', null, 'It is a pairing code for this one transfer. It is not a PIN, and nothing else will ever ask you for it.'),
      notice,
      h('p', { class: 'fine' }, 'This code works for ', left, ' more.'),
      actions(button('Cancel', reset, 'quiet')),
    ],
    update,
  };
}

function acceptScreen(v: TransferView<string>): Built {
  return {
    nodes: [
      title(profile.accept.heading),
      h('p', { class: 'rendering', id: 'rendering' }, v.session.rendering ?? ''),
      h('p', null, 'Keep it if this is what you just sent and your other device said the code matched.'),
      actions(
        button(profile.accept.confirm, () => transfer?.accept(), 'primary', { id: 'accept-keep' }),
        button(profile.accept.decline, () => transfer?.decline(), 'plain', { id: 'accept-discard' }),
      ),
    ],
  };
}

function sentScreen(v: TransferView<string>): Built {
  const left = h('span', { class: 'clock' });
  const update = (view: TransferView<string>) => {
    left.textContent = view.session.ackDeadline ? clock(view.session.ackDeadline) : '';
  };
  update(v);
  return {
    nodes: [
      title('Sent. Waiting for the other device to keep it'),
      h('p', null, 'The text has left this device. The other device is showing what arrived and asking before it keeps it.'),
      h('p', { class: 'fine' }, 'This device waits ', left, ' more for confirmation.'),
      actions(button('Stop waiting', () => transfer?.cancel(), 'quiet')),
    ],
    update,
  };
}

function receivedScreen(v: TransferView<string>): Node[] {
  const value = v.value ?? '';
  const shown = h('output', { class: 'secret', id: 'received' }, '•'.repeat(Math.min(24, Array.from(value).length)));
  let visible = false;
  const toggle = button('Show it', () => {
    visible = !visible;
    shown.textContent = visible ? value : '•'.repeat(Math.min(24, Array.from(value).length));
    shown.classList.toggle('visible', visible);
    toggle.textContent = visible ? 'Hide it' : 'Show it';
  }, 'plain', { id: 'reveal' });
  const copied = h('span', { class: 'fine', role: 'status' });
  return [
    title('Received'),
    shown,
    actions(
      toggle,
      button('Copy it', async () => {
        copied.textContent = (await copyText(value)) ? 'Copied.' : 'Copying is blocked here; show it and select it.';
      }, 'plain', { id: 'copy-secret' }),
      copied,
    ),
    h('p', { class: 'fine' }, 'This page has not saved it. Leaving or reloading the page erases it. Both throwaway keys have been destroyed.'),
    actions(button('Done', reset, 'primary', { id: 'done' })),
  ];
}

function endedScreen(v: TransferView<string>): Node[] {
  const outcome = v.session.outcome as Outcome;
  if (outcome === 'received') return receivedScreen(v);
  const sender = v.role === 'sender';
  const text: Record<Exclude<Outcome, 'received'>, [string, string]> = {
    delivered: ['Delivered', 'The other device confirmed it has the text. Both throwaway keys have been destroyed.'],
    'sent-unconfirmed': [
      'Sent, but not confirmed',
      'The text left this device, and the other device did not confirm in time. Look at that device: it may still be asking whether to keep it.',
    ],
    declined: sender ? ['Nothing was sent', 'You chose not to send. The other device has been told.'] : ['Discarded', 'Nothing was kept. The other device has been told.'],
    cancelled: ['Cancelled', 'Nothing was sent or kept.'],
    'peer-aborted': sender
      ? v.session.released
        ? ['The other device did not keep it', 'The text was delivered and the other device discarded it or could not use it.']
        : ['The other device cancelled', 'Nothing was sent.']
      : ['The other device cancelled', 'It stopped, or it chose a different device. Nothing arrived here.'],
    'attempts-exhausted': [
      'The code did not match five times',
      'Nothing was sent, and that code is finished. If you did not mistype, someone may be interfering: stop and try again from a different network. To try again at all, the receiving device has to show a new code.',
    ],
    expired: ['The code expired', 'A pairing code works for ten minutes. Nothing was sent or kept.'],
    'bad-payload': ['That was not a text', 'What arrived was not something this page can use, so it was discarded. The other device has been told.'],
    'blocked-peer': ['That code has already failed', 'Ask the other device for a new code.'],
  };
  const [heading, detail] = text[outcome];
  return [title(heading), h('p', { id: 'outcome' }, detail), actions(button('Start again', reset, 'primary', { id: 'again' }))];
}

function transferKey(v: TransferView<string>): string {
  if (v.stage === 'relays') return 'relays';
  if (v.stage === 'ended') return `ended:${v.session.outcome}`;
  switch (v.session.phase) {
    case 'waiting':
      return v.showing ? 'qr' : 'contacting';
    case 'code':
      return `code:${v.session.code}`;
    default:
      return v.session.phase;
  }
}

function transferScreen(v: TransferView<string>): Built {
  if (v.stage === 'relays') return relaysScreen(v);
  if (v.stage === 'ended') return { nodes: endedScreen(v) };
  switch (v.session.phase) {
    case 'waiting':
      return v.showing ? qrScreen(v) : contactingScreen(v);
    case 'release':
      return releaseScreen(v);
    case 'code':
      return codeScreen(v);
    case 'accept':
      return acceptScreen(v);
    case 'sent':
      return sentScreen(v);
    default:
      return { nodes: [] };
  }
}

// ---- the other device -----------------------------------------------------------------

/** What to do on the device this page is not running on, in step with this one. */
function otherDevice(v: TransferView<string> | undefined): Node[] {
  const p = (...children: (Node | string)[]) => h('p', null, ...children);
  const pageAddress = `${location.host}${location.pathname === '/' ? '' : location.pathname}`;
  if (screen.name === 'home') {
    return [
      p('You need two devices. Open this page on the other one:'),
      h('figure', { class: 'here-qr' }, qrSvg(deps.baseUrl, 'Address of this page'), h('figcaption', null, pageAddress)),
      p('This code is only this page’s address. Pairing codes come later and say what they do.'),
    ];
  }
  if (screen.name === 'compose') return [p('Open this page on the receiving device and choose ', h('strong', null, 'Receive a secret'), '.')];
  if (screen.name === 'method') {
    return role === 'sender'
      ? [p('On the receiving device, choose ', h('strong', null, 'Receive a secret'), '. One of the two shows a code and the other scans it. Either way round works.')]
      : [p('On the sending device, choose ', h('strong', null, 'Send a secret'), ' and type it in. One of the two shows a code and the other scans it. Either way round works.')];
  }
  if (screen.name === 'scan' || screen.name === 'paste') {
    return [p('On the other device, choose ', h('strong', null, 'Show a code here'), '.', screen.name === 'paste' ? ' Then open “Can’t scan it?” and copy the link.' : '')];
  }
  if (screen.name === 'incoming') return [p('The other device made this link and is waiting for an answer.')];
  if (!v || screen.name !== 'transfer') return [p('Nothing to do on the other device yet.')];

  if (v.stage === 'relays') return [p('Nothing to do there yet. This device is finding a relay both can reach.')];
  if (v.stage === 'ended') {
    return v.session.outcome === 'received' || v.session.outcome === 'delivered'
      ? [p('Done. It should say so too.')]
      : [p('This transfer is over. To try again, start again on both devices.')];
  }
  switch (v.session.phase) {
    case 'waiting':
      if (!v.showing) return [p('It is showing the code you just read. Leave it open.')];
      return v.role === 'receiver'
        ? [p('Choose ', h('strong', null, 'Send a secret'), ', type it in, then ', h('strong', null, 'Scan a code with this device'), ' and point it at this screen.')]
        : [p('Choose ', h('strong', null, 'Receive a secret'), ', then ', h('strong', null, 'Scan a code with this device'), ' and point it at this screen.')];
    case 'release':
      return [p('It is showing five digits. Read them from its screen and type them here.')];
    case 'code':
      return [p('It is asking for five digits. Type the ones shown here, then confirm there that you mean to send.')];
    case 'accept':
      return [p('It says the text is sent and is waiting for this device to keep it.')];
    case 'sent':
      return [p('It is showing what arrived. Choose ', h('strong', null, 'Keep it'), ' there to finish.')];
    default:
      return [];
  }
}

// ---- this device: relays and log ------------------------------------------------------

let drawnVersion = -1;

function deviceDrawer(): void {
  drawnVersion = store.version;
  const result = h('p', { class: 'fine', role: 'status' });
  const add = () => {
    const added = store.addConfigured(input.value);
    if (!added) {
      result.textContent = 'That is not a relay address this page can use. It should start with wss://';
      return;
    }
    deviceDrawer();
    document.getElementById('add-relay')?.focus();
  };
  const input = h('input', {
    type: 'url',
    id: 'add-relay',
    placeholder: 'wss://relay.example.com',
    autocomplete: 'off',
    spellcheck: 'false',
    onKeydown: (e) => (e as KeyboardEvent).key === 'Enter' && add(),
  });
  const sourceLabel: Record<string, string> = {
    configured: 'added here',
    remembered: 'passed here before',
    learned: 'named by a code you scanned',
    discovered: 'reported by a relay monitor',
    seed: 'a starting point shipped with this page',
  };
  const memos = store.memos();
  const fromPage = adopterRelays();
  const rows = store.candidates().map((c) => {
    const memo = memos.find((m) => m.url === c.url);
    const last = memo?.lastPass ? `passed ${when(memo.lastPass)}` : memo?.why ? `last time: ${memo.why}` : 'not tested yet';
    const removable = !fromPage.includes(c.url);
    return h(
      'li',
      { class: 'relay' },
      h('span', { class: 'relay-url' }, c.url),
      h('span', { class: 'relay-state' }, `${fromPage.includes(c.url) ? 'set by this page' : sourceLabel[c.source]}; ${last}`),
      button('Test', async () => {
        result.textContent = `Testing ${host(c.url)}…`;
        const r = await loopbackOnce(c.url, profile, env);
        if (r.ok) store.notePass(c.url, memo?.origin ?? (c.source === 'remembered' ? 'seed' : c.source));
        result.textContent = r.ok ? `${host(c.url)} passed: it carried a sealed message of the largest size back to this device.` : `${host(c.url)} did not pass: ${r.reason}.`;
      }, 'quiet'),
      removable &&
        button('Remove', () => {
          store.removeConfigured(c.url);
          store.removeSeed(c.url);
          store.forgetRelay(c.url);
          deviceDrawer();
        }, 'quiet'),
    );
  });
  const log = store.records().map((r) =>
    h(
      'li',
      null,
      `${when(r.ts)}: ${r.role === 'sender' ? 'sent' : 'received'} (${r.outcome}), other device ${shortKey(r.peer)}, via ${r.relays.map(host).join(', ')}`,
      r.multi ? '. More than one device responded to the code.' : '.',
    ),
  );
  replace(
    drawer,
    h('h3', null, 'Relays this device knows'),
    h('p', { class: 'fine' }, 'No relay is trusted or required. Before a code is shown, each candidate has to carry a sealed test message back to this device, and only those that do are named in the code.'),
    rows.length > 0 ? h('ul', { class: 'relays relays-known' }, ...rows) : h('p', { class: 'fine' }, 'None. Add one below.'),
    h(
      'div',
      { class: 'add' },
      h('label', { for: 'add-relay', class: 'label' }, 'Add a relay'),
      input,
      button('Add', add, 'plain', { id: 'add-relay-go' }),
    ),
    result,
    h('h3', null, 'Transfers on this device'),
    log.length > 0 ? h('ul', { class: 'log' }, ...log) : h('p', { class: 'fine' }, 'None yet. This list is kept on this device only and never holds a secret.'),
    actions(
      button('Restore the starting relays', () => {
        store.restoreSeeds();
        deviceDrawer();
      }, 'quiet'),
      button('Forget everything on this device', () => {
        store.clear();
        deviceDrawer();
      }, 'quiet', { id: 'forget' }),
    ),
  );
}

// ---- render ---------------------------------------------------------------------------

let builtKey = '';
let built: Built | undefined;

function render(): void {
  const view = screen.name === 'transfer' ? transfer?.view() : undefined;
  const key = screen.name === 'transfer' && view ? `transfer:${transferKey(view)}` : screen.name;

  if (key !== builtKey) {
    builtKey = key;
    built = undefined;
    let nodes: Child[];
    switch (screen.name) {
      case 'home':
        nodes = homeScreen();
        break;
      case 'compose':
        nodes = composeScreen();
        break;
      case 'method':
        nodes = methodScreen();
        break;
      case 'scan':
        nodes = scanScreen();
        break;
      case 'paste':
        nodes = pasteScreen();
        break;
      case 'incoming':
        nodes = incomingScreen(screen);
        break;
      case 'interference':
        nodes = interferenceScreen(screen);
        break;
      case 'refused':
        nodes = refusedScreen(screen);
        break;
      case 'transfer':
        built = view ? transferScreen(view) : { nodes: [] };
        nodes = built.nodes;
        break;
    }
    replace(here);
    append(here, nodes);
    // Something leaving this device is the one state that looks different from every other.
    here.classList.toggle('is-release', key === 'transfer:release');
    replace(there, ...otherDevice(view));
    if (!first) {
      here.querySelector<HTMLElement>('.state')?.focus({ preventScroll: true });
      // A tall screen replaced by a short one can leave the reader looking at nothing.
      if (here.getBoundingClientRect().top < 0) here.scrollIntoView({ block: 'start' });
    }
    first = false;
    if (view?.stage === 'ended' && view.role === 'sender') secret = '';
  } else if (view) {
    built?.update?.(view);
  }

  // Keep the open drawer current, but never redraw it under someone who is using it.
  if (drawer.closest('details')?.open && drawnVersion !== store.version && !drawer.contains(document.activeElement)) deviceDrawer();

  crossed.textContent =
    messages === 0
      ? 'What a relay sees: nothing yet.'
      : `What a relay sees: ${messages} sealed message${messages === 1 ? '' : 's'}, each from a different one-time key.`;
  const trace = document.getElementById('trace');
  if (trace) trace.textContent = view ? view.log.join('\n') : 'Nothing has happened yet.';
}

// ---- start ----------------------------------------------------------------------------

function readFragment(): void {
  const hash = location.hash;
  if (hash.length < 2 || !looksLikePairing(hash)) return;
  const link = location.href;
  // The parameters are in memory now; they need not sit in the address bar or the history.
  history.replaceState(null, '', location.pathname + location.search);
  // A link opened into a page that was already doing something starts that page over.
  transfer?.dispose();
  transfer = undefined;
  role = undefined;
  pending = undefined;
  // Text typed for some earlier purpose is not what this link is asking for.
  secret = '';
  messages = 0;
  const problem = onPairing(link, false, true);
  if (problem) go({ name: 'refused', title: 'That link can’t be used', detail: problem });
}

drawer.closest('details')?.addEventListener('toggle', (e) => {
  if ((e.target as HTMLDetailsElement).open) deviceDrawer();
});
window.addEventListener('hashchange', () => !framed && readFragment());
// Leaving erases, as the page says it does; so does coming back from the browser's page cache.
window.addEventListener('pagehide', () => reset());
window.addEventListener('pageshow', (e) => e.persisted && reset());
setInterval(() => {
  if (screen.name === 'transfer') render();
}, 1000);

if (framed) {
  screen = { name: 'refused', title: 'Open this page on its own', detail: 'It is inside another site’s frame, where that site could dress up what it asks you. It does nothing here.' };
}
render();
if (!framed) readFragment();
document.documentElement.classList.add('ready');
