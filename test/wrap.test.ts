import { nip59 } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_PAYLOAD,
  KINDS,
  SESSION_SECONDS,
  buildRumor,
  demoText,
  eventId,
  firstTag,
  generateSecretKey,
  nip44,
  publicKey,
  sign,
  unwrap,
  verify,
  wrap,
} from '../src/core/index.ts';
import { testEnv } from './helpers.ts';

function pair(seed: string) {
  const env = testEnv(seed);
  const a = generateSecretKey(env.random);
  const b = generateSecretKey(env.random);
  return { env, a, b, aPub: publicKey(a), bPub: publicKey(b) };
}

describe('seal and gift wrap (§11.4)', () => {
  it('round-trips, and the opened rumor names the sending burner', () => {
    const { env, a, b, aPub, bPub } = pair('wrap-1');
    const r = buildRumor({ kind: KINDS.NONCE, tags: [['nonce', '11'.repeat(32)]] }, aPub, env.now());
    const w = wrap(r, a, bPub, env);
    const opened = unwrap(w, b);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.rumor).toEqual(r);
    expect(opened.rumor.pubkey).toBe(aPub);
  });

  it('wrap is kind 1059 from a one-time key, addressed by p tag, with true timestamps and an expiration', () => {
    const { env, a, aPub, bPub } = pair('wrap-2');
    const w = wrap(buildRumor({ kind: KINDS.ACK }, aPub, env.now()), a, bPub, env);
    expect(w.kind).toBe(1059);
    expect(verify(w)).toBe(true);
    expect(w.pubkey).not.toBe(aPub);
    expect(w.pubkey).not.toBe(bPub);
    expect(firstTag(w, 'p')).toBe(bPub);
    // §11.4, contrary to NIP-59: created_at is the true current time.
    expect(w.created_at).toBe(env.now());
    expect(firstTag(w, 'expiration')).toBe(String(env.now() + SESSION_SECONDS));
    // the sending burner appears nowhere in the outer event
    expect(JSON.stringify(w)).not.toContain(aPub);
  });

  it('two wraps of the same rumor use different one-time keys', () => {
    const { env, a, aPub, bPub } = pair('wrap-3');
    const r = buildRumor({ kind: KINDS.ACK }, aPub, env.now());
    expect(wrap(r, a, bPub, env).pubkey).not.toBe(wrap(r, a, bPub, env).pubkey);
  });

  it('is not openable by anyone but the recipient', () => {
    const { env, a, aPub, bPub } = pair('wrap-4');
    const stranger = generateSecretKey(env.random);
    const w = wrap(buildRumor({ kind: KINDS.ACK }, aPub, env.now()), a, bPub, env);
    expect(unwrap(w, stranger)).toEqual({ ok: false, reason: 'not-for-us' });
    // even if a relay rewrites the p tag to the stranger, the signature no longer holds
    const retagged = { ...w, tags: [['p', publicKey(stranger)]] };
    expect(unwrap(retagged, stranger)).toEqual({ ok: false, reason: 'bad-wrap-signature' });
  });

  it('rejects a tampered wrap', () => {
    const { env, a, b, aPub, bPub } = pair('wrap-5');
    const w = wrap(buildRumor({ kind: KINDS.ACK }, aPub, env.now()), a, bPub, env);
    expect(unwrap({ ...w, content: w.content.slice(0, -4) + 'AAAA' }, b).ok).toBe(false);
    expect(unwrap({ ...w, kind: 1 }, b)).toEqual({ ok: false, reason: 'not-a-wrap' });
    expect(unwrap('nonsense', b)).toEqual({ ok: false, reason: 'not-a-wrap' });
    expect(unwrap(null, b)).toEqual({ ok: false, reason: 'not-a-wrap' });
  });

  it('attribution: a rumor claiming another burner inside a valid seal is discarded', () => {
    const { env, a, b, bPub } = pair('wrap-6');
    const victim = publicKey(generateSecretKey(env.random));
    // The attacker (a) seals honestly with its own key, but the rumor inside says it is from `victim`.
    const forged = buildRumor({ kind: KINDS.PAYLOAD, content: 'x' }, victim, env.now());
    const w = wrap(forged, a, bPub, env);
    expect(unwrap(w, b)).toEqual({ ok: false, reason: 'attribution' });
  });

  it('a seal that is not signed by its pubkey is discarded', () => {
    const { env, a, b, aPub, bPub } = pair('wrap-7');
    const victimSecret = generateSecretKey(env.random);
    const victim = publicKey(victimSecret);
    const r = buildRumor({ kind: KINDS.ACK }, victim, env.now());
    // Build a seal that names the victim but is signed by the attacker.
    const sealTemplate = {
      pubkey: victim,
      created_at: env.now(),
      kind: KINDS.SEAL,
      tags: [],
      content: nip44.encrypt(JSON.stringify(r), nip44.conversationKey(a, bPub), env.random(32)),
    };
    const badSeal = { ...sign({ ...sealTemplate, pubkey: aPub }, a, env.random), pubkey: victim, id: eventId(sealTemplate) };
    const oneTime = generateSecretKey(env.random);
    const w = sign(
      {
        pubkey: publicKey(oneTime),
        created_at: env.now(),
        kind: KINDS.WRAP,
        tags: [['p', bPub]],
        content: nip44.encrypt(JSON.stringify(badSeal), nip44.conversationKey(oneTime, bPub), env.random(32)),
      },
      oneTime,
      env.random,
    );
    expect(unwrap(w, b)).toEqual({ ok: false, reason: 'bad-seal' });
  });

  it('interoperates with the NIP-59 implementation in nostr-tools, both ways', () => {
    const { env, a, b, aPub, bPub } = pair('wrap-8');
    const r = buildRumor({ kind: KINDS.HELLO, tags: [['commit', '22'.repeat(32)]] }, aPub, env.now());
    const ours = wrap(r, a, bPub, env);
    const theirsOpened = nip59.unwrapEvent(ours, b);
    expect(theirsOpened.id).toBe(r.id);
    expect(theirsOpened.pubkey).toBe(aPub);
    expect(theirsOpened.kind).toBe(KINDS.HELLO);

    const theirs = nip59.wrapEvent({ kind: KINDS.ACK, content: '', tags: [], created_at: env.now() }, a, bPub);
    const opened = unwrap(theirs, b);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.rumor.kind).toBe(KINDS.ACK);
      expect(opened.rumor.pubkey).toBe(aPub);
    }
  });
});

// §4 P1 asks for a conformance vector at exactly the declared maximum, because NIP-44's
// power-of-two padding makes an off-by-one-chunk error invisible everywhere else. This is
// not that normative vector, but it pins the sizes the specification quotes.
describe('payload ceiling (§4 P1, §11.6)', () => {
  it('a payload of exactly the default maximum fits the smallest limit the spec names', () => {
    const { env, a, b, aPub, bPub } = pair('ceiling');
    const text = 'k'.repeat(DEFAULT_MAX_PAYLOAD);
    const content = demoText.encode(text);
    const w = wrap(buildRumor({ kind: KINDS.PAYLOAD, content }, aPub, env.now()), a, bPub, env);
    // NIP-11's example max_content_length, the origin of the 2048 B default.
    expect(w.content.length).toBeLessThanOrEqual(8196);
    const ratio = JSON.stringify(w).length / DEFAULT_MAX_PAYLOAD;
    expect(ratio).toBeGreaterThan(3.2);
    expect(ratio).toBeLessThan(3.7);
    const opened = unwrap(w, b);
    expect(opened.ok && demoText.check(opened.rumor.content)).toEqual({ ok: true, value: text });
  });

  it('one byte over the maximum is refused before anything is built', () => {
    expect(() => demoText.encode('k'.repeat(DEFAULT_MAX_PAYLOAD + 1))).toThrow();
    expect(() => demoText.encode('')).toThrow();
  });
});
