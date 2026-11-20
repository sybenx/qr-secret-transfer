import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, keykinDevice, keykinInviteOf, parseUri, readKeykinInvite, withKeykinInvite } from '../src/core/index.ts';

const v = JSON.parse(readFileSync(new URL('../vectors/keykin-device.json', import.meta.url), 'utf8'));

describe('profile keykin-device', () => {
  it('encodes the join text and the whole key as the vectors say', () => {
    expect(keykinDevice.encode({ join: v.join.value })).toBe(v.join.content);
    expect(keykinDevice.encode({ nsec: hexToBytes(v.whole.nsec) })).toBe(v.whole.content);
  });

  it('reads them back (P4) and renders them (P5)', () => {
    const j = keykinDevice.check(v.join.content);
    expect(j).toEqual({ ok: true, value: { join: v.join.value } });
    const w = keykinDevice.check(v.whole.content);
    expect(w.ok && 'nsec' in w.value && bytesToHex(w.value.nsec)).toBe(v.whole.nsec);
    if (j.ok) expect(keykinDevice.render(j.value)).toBe(v.join.render);
    if (w.ok) expect(keykinDevice.render(w.value)).toBe(v.whole.render);
  });

  it('refuses everything that is not one of the two', () => {
    for (const b of v.bad) expect(keykinDevice.check(b.content).ok, b.why).toBe(false);
  });

  it('carries the invite in the pairing link, and the link still parses', () => {
    expect(keykinInviteOf(v.uri)).toEqual(readKeykinInvite(v.invite.text));
    const p = parseUri(v.uri);
    expect(p.profile).toBe('keykin-device');
    expect(p.mode).toBe('offer');
    expect(p.check).toBe('none');
    expect(withKeykinInvite(v.uri.slice(0, v.uri.indexOf('&invite=')), v.invite.text)).toBe(v.uri);
  });

  it('takes no invite that is missing, doubled or malformed', () => {
    const base = v.uri.slice(0, v.uri.indexOf('&invite='));
    expect(keykinInviteOf(base)).toBeNull();
    expect(keykinInviteOf(`${v.uri}&invite=${v.uri.split('&invite=')[1]}`)).toBeNull();
    expect(keykinInviteOf(`${base}&invite=bm90IGpzb24`)).toBeNull();
    expect(readKeykinInvite(JSON.stringify({ keykin: 2, invite: { key: 'ab' } }))).toBeNull();
    expect(readKeykinInvite(JSON.stringify({ keykin: 2, invite: { key: JSON.parse(v.invite.text).invite.key, chip: 'nope' } }))).toBeNull();
    expect(() => withKeykinInvite(base, '{}')).toThrow();
  });

  it('names a device with no name', () => {
    const key = JSON.parse(v.invite.text).invite.key;
    expect(readKeykinInvite(JSON.stringify({ keykin: 2, invite: { key } }))?.name).toBe('A new device');
  });
});
