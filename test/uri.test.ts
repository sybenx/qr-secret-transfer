import { describe, expect, it } from 'vitest';
import { UriError, buildUri, looksLikePairing, normalizeOrigin, normalizeRelayUrl, npubEncode, parseUri, scannerRole, showingMode } from '../src/core/index.ts';

const pub = '7208881482c8995728e76633bcdf0ebb65155c8f4979a4e766713f374a5d8152';
const params = {
  v: 1 as const,
  mode: 'offer' as const,
  profile: 'qrst-demo-text',
  pub,
  check: 'compare' as const,
  token: '0123456789abcdef0123456789abcdef',
  relays: ['wss://relay.example.com', 'wss://other.example.org/path'],
  origin: 'https://qrst.example',
};

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof UriError ? e.code : `threw ${String(e)}`;
  }
  return 'no error';
};

describe('pairing link (§11.2)', () => {
  it('round-trips', () => {
    const uri = buildUri('https://qrst.example/', params);
    expect(uri.startsWith('https://qrst.example/#v=1&mode=offer&p=qrst-demo-text&npub=npub1')).toBe(true);
    expect(parseUri(uri)).toEqual(params);
  });

  it('keeps every parameter in the fragment', () => {
    const uri = new URL(buildUri('https://qrst.example/x/', params));
    expect(uri.search).toBe('');
    expect(uri.pathname).toBe('/x/');
    expect(uri.hash.length).toBeGreaterThan(50);
  });

  it('replaces any fragment the base already had', () => {
    expect(buildUri('https://qrst.example/#old', params).split('#').length).toBe(2);
  });

  it('accepts the bare fragment and the parameters alone', () => {
    const uri = buildUri('https://qrst.example/', params);
    const fragment = uri.slice(uri.indexOf('#'));
    expect(parseUri(fragment)).toEqual(params);
    expect(parseUri(fragment.slice(1))).toEqual(params);
  });

  it('omits origin when the showing device is not a web client', () => {
    const { origin: _origin, ...native } = params;
    const parsed = parseUri(buildUri('https://qrst.example/', native));
    expect(parsed.origin).toBeUndefined();
  });

  it('rejects an unknown version, a missing mode and a missing profile', () => {
    const uri = buildUri('https://qrst.example/', params);
    expect(code(() => parseUri(uri.replace('v=1', 'v=2')))).toBe('unknown-version');
    expect(code(() => parseUri(uri.replace('mode=offer', 'mode=other')))).toBe('missing-mode');
    expect(code(() => parseUri(uri.replace('&mode=offer', '')))).toBe('missing-mode');
    expect(code(() => parseUri(uri.replace('&p=qrst-demo-text', '')))).toBe('missing-profile');
    expect(code(() => parseUri(uri.replace('p=qrst-demo-text', 'p=Not_Valid')))).toBe('missing-profile');
  });

  it('catches a transcription error in the key by its checksum', () => {
    const uri = buildUri('https://qrst.example/', params);
    const npub = npubEncode(pub);
    const flipped = npub.slice(0, 20) + (npub[20] === 'q' ? 'p' : 'q') + npub.slice(21);
    expect(code(() => parseUri(uri.replace(npub, flipped)))).toBe('bad-key');
  });

  it('needs at least one usable relay, and uses at most four', () => {
    const uri = buildUri('https://qrst.example/', params);
    const none = uri.replace(/&relay=[^&]+/g, '');
    expect(code(() => parseUri(none))).toBe('no-relays');
    expect(code(() => parseUri(none + '&relay=https://not-a-relay.example'))).toBe('bad-relay');
    expect(code(() => parseUri(none + '&relay=ws://plaintext.example'))).toBe('bad-relay');
    const many = none + [1, 2, 3, 4, 5, 6].map((n) => `&relay=wss://r${n}.example`).join('');
    expect(parseUri(many).relays).toHaveLength(4);
  });

  it('is not fooled by something that is not a pairing link', () => {
    expect(looksLikePairing('https://example.com/#section')).toBe(false);
    expect(code(() => parseUri('https://example.com/'))).toBe('not-a-pairing-link');
    expect(code(() => parseUri(''))).toBe('not-a-pairing-link');
  });

  it('ignores parameters it does not know', () => {
    expect(parseUri(buildUri('https://qrst.example/', params) + '&future=1')).toEqual(params);
  });
});

describe('check and token', () => {
  const without = (name: string) => buildUri('https://qrst.example/', params).replace(new RegExp(`&${name}=[^&]*`), '');

  it('a link with no check, or a check this device does not know, means typing', () => {
    expect(parseUri(without('check')).check).toBe('type');
    expect(parseUri(buildUri('https://qrst.example/', params).replace('check=compare', 'check=lenient')).check).toBe('type');
    for (const check of ['none', 'compare', 'type'] as const) expect(parseUri(buildUri('https://qrst.example/', { ...params, check })).check).toBe(check);
  });

  it('a link with no token, or a malformed one, is refused', () => {
    expect(code(() => parseUri(without('token')))).toBe('bad-token');
    expect(code(() => parseUri(buildUri('https://qrst.example/', params).replace(params.token, params.token.slice(2))))).toBe('bad-token');
    expect(code(() => parseUri(buildUri('https://qrst.example/', params).replace(params.token, params.token.toUpperCase())))).toBe('bad-token');
  });
});

describe('normalisation', () => {
  it('relay URLs', () => {
    expect(normalizeRelayUrl('wss://Relay.Example.com/')).toBe('wss://relay.example.com');
    expect(normalizeRelayUrl('wss://relay.example.com:443/x')).toBe('wss://relay.example.com/x');
    expect(normalizeRelayUrl('ws://localhost:7777')).toBe('ws://localhost:7777');
    expect(normalizeRelayUrl('ws://example.com')).toBeUndefined();
    expect(normalizeRelayUrl('https://example.com')).toBeUndefined();
    expect(normalizeRelayUrl('wss://user:pw@example.com')).toBeUndefined();
    expect(normalizeRelayUrl('not a url')).toBeUndefined();
  });

  it('shows a non-ASCII origin as punycode (§9.1)', () => {
    expect(normalizeOrigin('https://bücher.example')).toBe('https://xn--bcher-kva.example');
    expect(normalizeOrigin('https://аpple.com')).toMatch(/^https:\/\/xn--/); // Cyrillic а
    expect(normalizeOrigin('javascript:alert(1)')).toBeUndefined();
    expect(normalizeOrigin('https://example.com/path?x=1')).toBe('https://example.com');
  });

  it('roles and modes are complementary', () => {
    expect(scannerRole('offer')).toBe('sender');
    expect(scannerRole('request')).toBe('receiver');
    expect(showingMode('receiver')).toBe('offer');
    expect(showingMode('sender')).toBe('request');
  });
});

describe('relays on this machine', () => {
  it('are refused unless the host has said they may be used', async () => {
    const { relayPolicy, isPrivateHost } = await import('../src/core/index.ts');
    relayPolicy.loopback = false;
    try {
      expect(normalizeRelayUrl('ws://localhost:7777')).toBeUndefined();
      expect(normalizeRelayUrl('wss://127.0.0.1:8443')).toBeUndefined();
      expect(normalizeRelayUrl('wss://relay.example.com')).toBe('wss://relay.example.com');
    } finally {
      relayPolicy.loopback = true;
    }
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.20.0.1', '169.254.1.1', 'printer.local', '[::1]', '[fd00::1]']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ['relay.example.com', '8.8.8.8', '172.32.0.1']) expect(isPrivateHost(h), h).toBe(false);
  });
});
