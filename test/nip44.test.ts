import { nip44 as reference } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, nip44, publicKey } from '../src/core/index.ts';
import official from './nip44.vectors.json' with { type: 'json' };
import { seededRandom } from './helpers.ts';

const v2 = official.v2;

// The official NIP-44 vector file (paulmillr/nip44), unmodified.
describe('NIP-44 v2 official vectors', () => {
  it('conversation keys', () => {
    for (const c of v2.valid.get_conversation_key) {
      expect(bytesToHex(nip44.conversationKey(hexToBytes(c.sec1), c.pub2))).toBe(c.conversation_key);
    }
    expect(v2.valid.get_conversation_key.length).toBeGreaterThan(30);
  });

  it('padded lengths', () => {
    for (const [length, padded] of v2.valid.calc_padded_len) expect(nip44.paddedLength(length!)).toBe(padded);
  });

  it('encrypts to the exact payload and decrypts it', () => {
    for (const c of v2.valid.encrypt_decrypt) {
      const key = nip44.conversationKey(hexToBytes(c.sec1), publicKey(hexToBytes(c.sec2)));
      expect(bytesToHex(key)).toBe(c.conversation_key);
      expect(nip44.encrypt(c.plaintext, key, hexToBytes(c.nonce))).toBe(c.payload);
      expect(nip44.decrypt(c.payload, key)).toBe(c.plaintext);
    }
  });

  it('rejects every invalid payload', () => {
    for (const c of v2.invalid.decrypt) {
      expect(() => nip44.decrypt(c.payload, hexToBytes(c.conversation_key)), c.note).toThrow();
    }
    expect(v2.invalid.decrypt.length).toBeGreaterThan(5);
  });

  it('rejects invalid keys', () => {
    for (const c of v2.invalid.get_conversation_key) {
      expect(() => nip44.conversationKey(hexToBytes(c.sec1), c.pub2), c.note).toThrow();
    }
  });

  it('rejects plaintext lengths out of range', () => {
    const key = hexToBytes(v2.valid.encrypt_decrypt[0]!.conversation_key);
    for (const n of v2.invalid.encrypt_msg_lengths) {
      expect(() => nip44.encrypt('a'.repeat(n), key, new Uint8Array(32))).toThrow();
    }
  });
});

// A second implementation agreeing on random inputs.
describe('NIP-44 v2 against nostr-tools', () => {
  it('agrees on 200 random messages in both directions', () => {
    const random = seededRandom('nip44-cross');
    for (let i = 0; i < 200; i++) {
      const a = random(32);
      const b = random(32);
      const nonce = random(32);
      const length = 1 + (random(2)[0]! * 256 + random(1)[0]!) % 9000;
      const text = Array.from(random(length), (x) => String.fromCharCode(32 + (x % 90))).join('');
      const ours = nip44.conversationKey(a, publicKey(b));
      const theirs = reference.v2.utils.getConversationKey(a, publicKey(b));
      expect(bytesToHex(ours)).toBe(bytesToHex(theirs));
      const payload = nip44.encrypt(text, ours, nonce);
      expect(payload).toBe(reference.v2.encrypt(text, theirs, nonce));
      expect(reference.v2.decrypt(payload, theirs)).toBe(text);
      // the key agreed from the other side opens it too
      expect(nip44.decrypt(payload, nip44.conversationKey(b, publicKey(a)))).toBe(text);
    }
  });
});
