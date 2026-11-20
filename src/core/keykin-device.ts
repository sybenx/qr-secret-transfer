// Profile `keykin-device` (profiles/keykin-device.md): adding a device to a Keykin account with one
// code. The new device shows the code (Flow A, mode=offer) with its Keykin invite in an extra
// fragment parameter, `invite`. A device already in the account scans it, adds the newcomer, and
// releases one of two things: the join text (the newcomer then collects its own piece from the
// box) or, for an account with no box, the whole key.

import { base64, base64urlnopad } from '@scure/base';
import { bytesToHex, hexToBytes, utf8Decode, utf8Encode } from './bytes.ts';
import { isValidPublicKey, npubEncode, publicKey } from './event.ts';
import type { Profile } from './profile.ts';

export const KEYKIN_DEVICE = 'keykin-device';

/** The account's join text (Keykin SPEC 8b), as the adding device made it. Nothing secret. */
export interface KeykinJoin { addr: string; boxKey: string; npub: string; loginPage?: string }
/** What the newcomer receives: the join text, or the whole key for an account with no box. */
export type KeykinGift = { join: KeykinJoin } | { nsec: Uint8Array };
/** The new device's invite (Keykin SPEC 8b): its member key, its name, and its chip key if it has one. */
export interface KeykinInvite { text: string; key: string; name: string; chip?: string }

const HEX64 = /^[0-9a-f]{64}$/;
/** A chip key: a P-256 public key, compressed, in hex (Keykin SPEC 4). */
const CHIP = /^0[23][0-9a-f]{64}$/;
const MAX_INVITE = 1024;

function addrOk(a: unknown): a is string {
  if (typeof a !== 'string' || a.length > 300) return false;
  try { const u = new URL(a); return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.hash; } catch { return false; }
}
function loginOk(a: unknown): a is string {
  if (typeof a !== 'string') return false;
  try { const u = new URL(a); return (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) && u.origin === a; } catch { return false; }
}
function validSecret(k: Uint8Array): boolean {
  if (k.length !== 32) return false;
  try { return isValidPublicKey(publicKey(k)); } catch { return false; }
}
const shortNpub = (hex: string) => { const n = npubEncode(hex); return `${n.slice(0, 12)}…${n.slice(-6)}`; };

export const keykinDevice: Profile<KeykinGift> = {
  id: KEYKIN_DEVICE,
  maxPayloadBytes: 2048,
  // The whole key cannot be taken back. A piece can (block, then cycle), but one profile carries both.
  revocable: false,
  // `none` only when the adding device's own camera read the code; `compare` for anything pasted or handed over.
  minCheck: 'none',

  encode(v) {
    let o: unknown;
    if ('join' in v) {
      const j = v.join;
      if (!addrOk(j.addr) || !HEX64.test(j.boxKey) || !HEX64.test(j.npub) || (j.loginPage !== undefined && !loginOk(j.loginPage))) throw new Error('not a join text');
      o = { keykin: 2, join: { addr: j.addr, boxKey: j.boxKey, npub: j.npub, ...(j.loginPage ? { loginPage: j.loginPage } : {}) } };
    } else {
      if (!validSecret(v.nsec)) throw new Error('not a valid key');
      o = { keykin: 2, nsec: bytesToHex(v.nsec) };
    }
    return base64.encode(utf8Encode(JSON.stringify(o)));
  },

  check(content) {
    let o: any;
    try { o = JSON.parse(utf8Decode(base64.decode(content))); } catch { return { ok: false, reason: 'not a keykin-device payload' }; }
    if (!o || typeof o !== 'object' || Array.isArray(o) || o.keykin !== 2) return { ok: false, reason: 'not a keykin-device payload' };
    const keys = Object.keys(o).sort().join();
    if (keys === 'join,keykin') {
      const j = o.join;
      if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, reason: 'malformed join text' };
      const extra = Object.keys(j).filter((k) => !['addr', 'boxKey', 'npub', 'loginPage'].includes(k));
      if (extra.length || !addrOk(j.addr) || !HEX64.test(j.boxKey) || !HEX64.test(j.npub) || !isValidPublicKey(j.npub)) return { ok: false, reason: 'malformed join text' };
      if (j.loginPage !== undefined && !loginOk(j.loginPage)) return { ok: false, reason: 'bad login page' };
      return { ok: true, value: { join: { addr: j.addr, boxKey: j.boxKey, npub: j.npub, ...(j.loginPage ? { loginPage: j.loginPage } : {}) } } };
    }
    if (keys === 'keykin,nsec') {
      if (typeof o.nsec !== 'string' || !HEX64.test(o.nsec)) return { ok: false, reason: 'malformed key' };
      const k = hexToBytes(o.nsec);
      if (!validSecret(k)) return { ok: false, reason: 'not a valid secp256k1 key' };
      return { ok: true, value: { nsec: k } };
    }
    return { ok: false, reason: 'not a keykin-device payload' };
  },

  render(v) { return 'join' in v ? `Your account ${shortNpub(v.join.npub)}` : `Your account ${shortNpub(publicKey(v.nsec))}`; },

  direction: { offer: 'Scan with your phone', request: '' },
  release: {
    heading: 'Add this device?',
    body: '',
    confirm: () => 'Add',
    decline: 'Not now',
  },
  accept: { heading: 'Signed in', confirm: 'OK', decline: 'Cancel' },
};

/** Reads an invite (Keykin SPEC 8b) from its JSON text, or returns null. */
export function readKeykinInvite(text: unknown): KeykinInvite | null {
  if (typeof text !== 'string' || text.length > MAX_INVITE) return null;
  let o: any;
  try { o = JSON.parse(text); } catch { return null; }
  const i = o && o.keykin === 2 && o.invite && typeof o.invite === 'object' && !Array.isArray(o.invite) ? o.invite : null;
  if (!i || typeof i.key !== 'string' || !HEX64.test(i.key) || !isValidPublicKey(i.key)) return null;
  if (i.chip !== undefined && (typeof i.chip !== 'string' || !CHIP.test(i.chip))) return null;
  const name = typeof i.name === 'string' ? i.name.trim().slice(0, 60) : '';
  return { text, key: i.key, name: name || 'A new device', ...(i.chip !== undefined ? { chip: i.chip } : {}) };
}

/** Adds the `invite` parameter to a pairing link: the invite's JSON text, base64url without padding. */
export function withKeykinInvite(uri: string, inviteText: string): string {
  if (!readKeykinInvite(inviteText)) throw new Error('not a Keykin invite');
  return `${uri}&invite=${base64urlnopad.encode(utf8Encode(inviteText))}`;
}

/** The invite a `keykin-device` pairing link carries, or null when it has none or a bad one. */
export function keykinInviteOf(uri: string): KeykinInvite | null {
  const text = uri.trim();
  const params = text.includes('#') ? text.slice(text.indexOf('#') + 1) : text.includes('?') ? text.slice(text.indexOf('?') + 1) : text;
  const found = params.split('&').filter((p) => p.startsWith('invite='));
  if (found.length !== 1) return null;
  try { return readKeykinInvite(utf8Decode(base64urlnopad.decode(decodeURIComponent(found[0]!.slice('invite='.length))))); } catch { return null; }
}
