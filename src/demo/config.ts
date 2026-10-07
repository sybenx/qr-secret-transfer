// The few things an adopter of this page would change.

/**
 * Seed relays: where a device with nothing configured and nothing remembered starts.
 *
 * A seed is never trusted and never listed untested. It is tried only when the
 * sources ahead of it yield nothing, it has to pass the loopback test like any other
 * relay, and the user can remove it. Once anything has passed on a device, that
 * device prefers what it remembers.
 *
 * This list could not be exercised from the environment the demo was built in, which
 * has no route to public relays. It is a starting point, not a recommendation.
 */
export const SEEDS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.nostr.net',
  'wss://offchain.pub',
  'wss://nostr.oxtr.dev',
  'wss://relay.0xchat.com',
];

/** Relays to ask for NIP-66 relay discovery events, in addition to every relay this device knows. */
export const DISCOVERY_HINTS: readonly string[] = ['wss://relay.nostr.watch'];

function meta(name: string): string | undefined {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content.trim();
  return value ? value : undefined;
}

const list = (value: string | undefined) =>
  value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Relays the page's publisher supplies: `<meta name="qrst:relays" content="wss://a, wss://b">`. */
export const adopterRelays = (): string[] => list(meta('qrst:relays')) ?? [];

/** `<meta name="qrst:seeds" content="...">` replaces the seed list; an empty-looking "none" removes it. */
export const seeds = (): readonly string[] => {
  const value = meta('qrst:seeds');
  if (value === undefined) return SEEDS;
  return value === 'none' ? [] : (list(value) ?? []);
};

export const discoveryHints = (): readonly string[] => {
  const value = meta('qrst:discovery');
  if (value === undefined) return DISCOVERY_HINTS;
  return value === 'none' ? [] : (list(value) ?? []);
};
