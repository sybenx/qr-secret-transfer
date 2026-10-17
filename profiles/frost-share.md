# Profile `frost-share`

A payload profile for [QR_SECRET_TRANSFER.md](../QR_SECRET_TRANSFER.md) §5. It
gives a joining device one share of a threshold-signing group: its own share, and
the description of the group that share belongs to.

Key words MUST, MUST NOT, SHOULD, MAY are normative.

*History.* Until QRST moved to this repository, this profile was §3.3 of
`NOSTR_KEY_MANAGEMENT.md` in
[sybenx/nostr-key-management](https://github.com/sybenx/nostr-key-management),
now an archive. This file supersedes that section.

- **The payload changed, incompatibly.** The published 9.2 version carried a share
  of a scheme that document defined for itself (a hex scalar plus `index`,
  `group_pub`, `commitment`, `epoch`, `group_secret` and `CK`). This version, taken
  from that document's unpublished 10.0 draft (branch `archive/no-server-10.0`),
  carries a [FROSTR](https://github.com/FROSTR-ORG/bifrost) credential pair
  unchanged. The identifier stayed `frost-share`. No implementation of the 9.2
  format is known; one would complete the code check and release before the
  Receiver's P4 check rejected its payload.
- **The lowest check level is tighter.** 9.2 permitted `none` over "its own
  camera, or a local same-user paste", on the grounds that a share is inert until
  admitted. Under FROSTR it is not, and a Sender that copies its own pairing URI
  at `none` hands out a bearer token for the share. `none` is now limited to a
  Sender that obtained the Receiver's URI itself.
- **Added here:** the `frost://` scheme, from QRST §12.3; the note on FROSTR's
  echo, from that draft's QRST §16; P4's checks on the threshold and member
  indices; how the offline container's `log_n` is read; and an explicit statement
  of what can and cannot be revoked.

---

## Why this profile exists

This profile does not specify threshold signing. It assumes FROSTR's: bifrost's
wire protocol and credential formats, and the `igloo` clients built on them.

FROSTR needs an out-of-band channel to hand a share to a new device and does not
specify one. Its own
[security model](https://github.com/FROSTR-ORG/bifrost/blob/main/docs/SECURITY.md)
lists "secure, authenticated channels (out-of-band)" as a trust assumption. Its
reference iOS client meets that assumption by scanning a `bfgroup` QR and then a
`bfshare` QR, **both in plaintext**
([`app/onboarding/scan.tsx`](https://github.com/FROSTR-ORG/igloo-ios/blob/main/app/onboarding/scan.tsx)).
Anyone who photographs those codes, or anything that keeps a copy of the photo,
holds the share. QRST exists to prevent exactly that. This profile is that
channel: the same credential pair, inside QRST's code-checked, end-to-end
encrypted envelope instead of a bare QR.

A joining device needs two things before it can speak to its group at all: its
own **share** and the **group** package that share belongs to. bifrost's own
onboarding (`/onboard`) returns the group package alone, because it assumes the
share already reached the peer some other way. This profile carries both, since
a new device has neither.

*Checked against bifrost's source as read on 2026-09-11 (`src/encoder/share.ts`,
`src/encoder/group.ts`, `docs/PROTOCOL.md`). FROSTR is moving; re-check the
formats below against the current bifrost before implementing.*

## Requirements of QRST §5

| QRST §5 item | This profile |
|---|---|
| 1. Payload encoding | Two bech32m strings, ASCII, joined by one space: the peer's own `bfshare1…`, then the group's `bfgroup1…`. `bfshare` is bifrost's `SharePackage`: a 4-byte member index and the 32-byte share scalar, 36 bytes. `bfgroup` is bifrost's `GroupPackage`: a 33-byte compressed group public key, a 4-byte threshold, and one `{index, pubkey}` per member, where `pubkey` is that member's own point `share_i·G`. Both formats are bifrost's. This profile defines no encoding of its own, only the pairing. |
| 2. Maximum size | The default (2048 bytes), measured as the payload string, which is text (QRST §4 P1). A share is always 72 characters. A group of `n` members runs from 133 characters at `n = 1` to 1968 at `n = 32`. **32 members is the largest group this profile carries**: at 33 the pair is 2100 bytes, over the default. At `n = 32` the wrapped event is 5998 bytes and the relay `EVENT` message 6008, inside every limit of QRST §11.6. No larger maximum is declared. |
| 3. P4 check | Both strings decode with bifrost's decoder, which rejects a wrong size (36 bytes for a share, `37 + 37·n` for a group of `n`). Member indices MUST be distinct, and the threshold MUST be at least 1 and at most the member count. The share's index MUST appear among the members, and `share·G` MUST equal that member's `pubkey`. |
| 4. P5 rendering | Derive the identity's npub by dropping the parity byte from the group public key (bifrost stores it compressed; a Nostr identity is the 32-byte x-only remainder), and resolve a display name if one is cached. Show **"share *N* of *M*, *K* needed to sign"** from the share's index, the member count and the group's threshold, and say plainly that this device will hold one share and cannot sign alone. |
| 5. Sender's prompt | "Give *X* a share of your key." Less severe than `nostr-nsec`, but the prompt MUST NOT present the share as inert: the receiving device can sign together with the group's other peers from the moment it holds it. Where the prompt says the share can be revoked, it MUST also say that revoking stops future signing and recalls nothing (QRST §9.1). See [What can be revoked](#what-can-be-revoked). |
| 6. Additional tags | None. A FROSTR peer's identity is its member `pubkey`, already in the group package. |
| 7. Lowest check level | `none` only where the Sender is the contacting party (Flow A: the Receiver shows the pairing URI) and obtained that URI itself, with its own camera or by pasting one copied on the same device. Otherwise `compare`. See [At `none`](#at-none). |
| 8. Offline tier | Permitted, as the passphrase-encrypted container below. A bare, unencrypted credential pair MUST NOT be shown or pasted. |

## What can be revoked

For QRST §5 item 7 and §9.1, a share is **revocable for signing** and **not
revocable for reconstruction**.

- **Signing, until stopped.** A share is a member credential. Its holder can ask
  the group's other peers to sign with it, and they will until each one's peer
  policy stops answering that member. Stopping it is each peer's own decision, so
  it takes effect only once every peer has done it. And because in FROSTR the
  share *is* the member's identity, stopping it also cuts off the legitimate
  device that holds the same share.
- **The whole key, permanently, with enough other shares.** A share and `K − 1`
  others reconstruct the group secret, which is the identity's private key.
  Nothing done afterwards undoes that. Peer policy governs who the group answers,
  not what anyone already holds, and FROSTR has as yet no way to re-share a group
  while keeping its key (the archived 10.0 draft proposed one).

That split is why `none` is permitted, and only over the channels below.

## At `none`

At `none` there is no code, so whoever answers the pairing URI first and is
released to gets the payload (QRST §9.2, §15). The token keeps out anyone who
never saw the URI. It does nothing against someone who did.

**Where `none` is permitted.** The Sender scans the Receiver's QR with its own
camera. A photograph of that QR gains an onlooker nothing: the payload is
encrypted to that QR's burner, and the Sender answers only the QR it read. The
remaining risk is substitution, a different QR put in front of the camera, which
needs access to the screen the user is looking at. Pasting a URI the Receiver
copied on the same device carries the same risk through the clipboard, which
another app on that device could overwrite.

A client that cannot tell where a pasted URI came from treats the paste as not
controlled, unless the user confirms that it was copied on this device.

**Where it is not.** A Sender that shows or copies **its own** pairing URI (Flow
B) releases at `none` to whoever answers first. For as long as that URI is on
screen, on a clipboard, in clipboard history, or synced to another device, it is
as good as the share. So a Sender that showed the URI always uses `compare` or
above. So does a Sender that received the URI through anyone else (a message, an
email, a chat) or by tapping a `frost://` link, which any app can claim (QRST
§12.3).

QRST's two consent steps still apply at `none`, in this profile's words: the
Sender's release prompt (QRST §9.1) and the Receiver's acceptance confirmation of
the P5 rendering (QRST §9.4).

## Pairing between camera-less devices

A share has no standalone encrypted export to fall back on, the way a whole key
has NIP-49 `ncryptsec`. Between two devices without cameras, copy-paste pairing
(QRST §12.1) is therefore the delivery: one device shows its pairing URI as text,
the other pastes it, and the code check and encrypted transfer run over relays as
after a scan, at `compare` or above.

## The `frost://` scheme

This profile registers `frost://` as its URI scheme under QRST §12.3. It reads as
a token to hand to an app, and opens the app when tapped, which an `https` link
does not.

```
frost://<npub>?v=1&mode=<offer|request>&p=frost-share&check=<level>&token=<hex>[&relay=<wss url>]*[&origin=<claimed-origin>]
```

The parameters are those of QRST §11.2. `p` is always `frost-share`. The QR form
stays the `https` fragment link of QRST §11.2; `frost://` is for pasting and deep
links. A `frost://` link that arrives by being tapped never counts as a channel
the Sender controls.

*History.* Through QRST 1.4 this form carried a 32-byte `secret` that the peer
echoed. That is now the 16-byte `token` of every pairing URI, and a 1.4
`frost://` URI, which has no `token`, is rejected (QRST §11.2).

## Offline container

Where no relay is reachable (QRST §10), the pair travels as a passphrase-encrypted
blob:

- **KDF:** scrypt with `r = 8`, `p = 1` (as NIP-49), over the passphrase and a
  random 16-byte salt. The Sender uses `log_n = 18`. The Receiver uses the
  `log_n` in the container, and MAY refuse a value it cannot afford to compute.
- **Cipher:** XChaCha20-Poly1305 with a random 24-byte nonce. The version byte is
  the associated data.
- **Plaintext:** the whole payload above, both strings, space-joined. Sealing the
  pair, not only the share, also hides which identity it belongs to.
- **Container:** `version (0x01) || log_n (1) || salt (16) || nonce (24) ||
  ciphertext || MAC (16)`, then encoded in bech32 (NIP-19's encoding, not
  bech32m) with HRP `frostshare` and no length limit. It is deliberately neither a
  `bfshare1…` nor an `ncryptsec1…` string: the `frostshare1…` prefix and its
  checksum mark it as an encrypted pair and catch paste errors.

The Receiver decrypts, applies the P4 check, renders P5 and asks before keeping it
(QRST §10 step 3). The passphrase is the only protection, so an intercepted blob
whose passphrase is guessed carries the same consequences as an intercepted share
([What can be revoked](#what-can-be-revoked)).

## Relationship to FROSTR's echo

*Non-normative.* FROSTR clients follow onboarding with an **echo**
([`igloo-core`'s `echo.ts`](https://github.com/FROSTR-ORG/igloo-core/blob/main/src/echo.ts),
FROSTR's `/echo/req` and `/echo/res`): a round trip confirming that the share
arrived and the new device can be reached on the group's relays.

Echo confirms **arrival**: the bytes shown on the first screen are the bytes now on
the second. It runs after the share has already crossed whatever channel carried
it, and a successful echo says nothing about who else saw that channel. QRST
answers the question echo cannot: it keeps the share off that channel in the first
place.

The two compose. A share delivered through this profile arrives as intact as one
scanned from a plaintext QR (the P4 check is the same decode and `share·G`
comparison), so a FROSTR client can run its own echo immediately afterwards.
**QRST delivers, echo confirms.**

## Test vectors

`vectors/frost-share-max.json` is this profile's payload at its maximum: a real
secp256k1 group of 32 members with threshold 2, from a seeded dealer. It holds the
encoded pair, the P4 check, and the size of every layer of wrapping, and records
that 33 members would exceed the default maximum. Its generator is not published,
so treat it as a fixture to check against, not one to regenerate. A real dealer
MUST NOT use a seeded generator.
