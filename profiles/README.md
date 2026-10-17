# Profiles

QRST moves bytes it never looks at (P3). A **profile** is what gives those bytes a
meaning: what the payload is, how the Receiver recognises it, how each device
describes it to the person, and how carefully the code must be checked before it
moves. [QR_SECRET_TRANSFER.md](../QR_SECRET_TRANSFER.md) §5 lists what every
profile must state.

Profiles live outside the core specification so that the core never has to change
for a new kind of secret. Anyone can write one. The ones published here:

| Profile | What moves | Lowest check | Offline tier | Status |
|---|---|---|---|---|
| [`nostr-nsec`](nostr-nsec.md) | A whole Nostr identity key, between Nostr clients | `type` | No (NIP-49 `ncryptsec` instead) | Draft |
| [`frost-share`](frost-share.md) | One share of a FROSTR threshold-signing group, with its group package | `none` when the Sender read the Receiver's URI itself, otherwise `compare` | Yes, passphrase container | Draft |
| [`example-sync-key`](example-sync-key.md) | A random key that lets a second device share an app's saved state, with no account | `type`, or `compare` once the app can reset sync | No | Example, not for use as is |

The demo page in this repository uses a fourth, `qrst-demo-text`, defined in
[`src/core/profile.ts`](../src/core/profile.ts): a short piece of text, for trying
the mechanism with made-up values.

## Writing a profile

Copy [`example-sync-key.md`](example-sync-key.md) and answer each item of QRST §5:

1. The payload encoding and what it means.
2. Its maximum size, if larger than 2048 bytes. A larger maximum costs relays
   (QRST §4 P1, §11.6), and needs a test vector at exactly that size.
3. The P4 check: how the Receiver knows the bytes belong to this profile.
4. The P5 rendering: what the Receiver shows the person before keeping it.
5. The Sender's prompt: what it says is leaving the device, and whether it can be
   taken back (QRST §9.1).
6. Any extra message tags, avoiding the reserved names of QRST §11.4.
7. The lowest check level it permits, which may depend on how the pairing URI
   reached the Sender. Something that cannot be revoked SHOULD NOT permit `none`,
   and a profile that permits it should say over which channels (QRST §12.3).
8. Whether it permits the offline tier, and if so its passphrase encryption.

And, optionally: a platform credential check before release (QRST §9.1), as
`nostr-nsec` requires; a URI scheme of its own for pasting and deep links (QRST
§12.3), as `frost-share` registers `frost://`.

Choose an identifier matching `[a-z0-9-]{1,24}`, prefixed with your app's or
project's name. There is no registry, so the prefix is what prevents collisions.

To publish a profile here, open a pull request adding its file and a row to the
table above.
