# Profile `frost-share`

A payload profile for [QR_SECRET_TRANSFER.md](../QR_SECRET_TRANSFER.md) §5. It
gives a joining device one share of a threshold-signing group: its own share, and
the description of the group that share belongs to.

Key words MUST, MUST NOT, SHOULD, MAY are normative.

*History.* Until QRST moved to this repository, this profile was §3.3 of
`NOSTR_KEY_MANAGEMENT.md` in
[sybenx/nostr-key-management](https://github.com/sybenx/nostr-key-management),
now an archive. This file supersedes that section. It takes the version written
for that document's unpublished 10.0 draft (branch `archive/no-server-10.0`),
which carries a [FROSTR](https://github.com/FROSTR-ORG/bifrost) credential pair
unchanged, rather than the 9.2 version, which carried a share of a scheme that
document defined for itself. It also takes over the `frost://` scheme from QRST
§12.3 and the note on FROSTR's echo from that draft's QRST §16.

---

## Why this profile exists

This profile does not specify threshold signing. It assumes FROSTR's: bifrost's
wire protocol and credential formats, and the `igloo` clients built on them.

FROSTR needs an out-of-band channel to hand a share to a new device and does not
specify one. Its own
[security model](https://github.com/FROSTR-ORG/bifrost/blob/main/docs/SECURITY.md)
lists "secure, authenticated channels (out-of-band)" as a trust assumption. Its
clients have met that assumption by showing a `bfgroup` QR and then a `bfshare`
QR, **both in plaintext**. Anyone who photographs those codes, or anything that
keeps a copy of the photo, holds the share. QRST exists to prevent exactly that.
This profile is that channel: the same credential pair, inside QRST's
code-checked, end-to-end encrypted envelope instead of a bare QR.

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
| 2. Maximum size | The default (2048 bytes). A share is always 72 characters. A group of `n` members runs from 133 characters at `n = 1` to 1968 at `n = 32`. **32 members is the largest group this profile carries**: at 33 the pair is 2100 bytes, over the default. At `n = 32` the wrapped event is 5998 bytes and the relay `EVENT` message 6008, inside every limit of QRST §11.6. No larger maximum is declared. |
| 3. P4 check | Both strings decode with bifrost's decoder, which rejects a wrong size (36 bytes for a share, `37 + 37·n` for a group of `n`). The share's index MUST appear among the group's members, and `share·G` MUST equal that member's `pubkey`. |
| 4. P5 rendering | Derive the identity's npub by dropping the parity byte from the group public key (bifrost stores it compressed; a Nostr identity is the 32-byte x-only remainder), and resolve a display name if one is cached. Show **"share *N* of *M*, *K* needed to sign"** from the share's index, the member count and the group's threshold, and say plainly that this device will hold one share and cannot sign alone. |
| 5. Sender's prompt | "Give *X* a share of your key." Less severe than `nostr-nsec`, and the prompt MUST NOT claim more than that: the receiving device can sign together with the group's other peers from the moment it holds the share, until they stop answering it. |
| 6. Additional tags | None. A FROSTR peer's identity is its member `pubkey`, already in the group package. |
| 7. Lowest check level | `none`, but **only** over a channel the Sender controls: its own camera, or a paste between apps of the same user on one device. Over any other channel, `compare`. See [At `none`](#at-none). |
| 8. Offline tier | Permitted, as the passphrase-encrypted container below. A bare, unencrypted credential pair MUST NOT be shown or pasted. |

## At `none`

At `none` there is no code, so whoever answers the pairing URI first and is
released to gets the payload (QRST §9.2, §15). The token keeps out anyone who
never saw the URI. It does nothing against someone who did.

What an intercepted share yields, under FROSTR:

- **Signing, until stopped.** It is a member credential. Its holder can ask the
  group's other peers to sign with it, and they will until each one's peer policy
  stops answering that member.
- **The whole key, permanently, with enough other shares.** It and `K − 1` other
  shares reconstruct the group secret, which is the identity's private key. Nothing
  done afterwards undoes that: stopping the peer, or re-sharing the group, changes
  who can sign from now on, not what a reconstructed key can do.

So `none` is for delivery where interception would already mean the Sender's own
device is compromised: its own camera reading the Receiver's QR, or a local paste.
A pairing URI that travels through anyone else (a message, an email, a chat) uses
`compare` or `type`.

QRST's two consent steps still apply at `none`, in this profile's words: the
Sender's release prompt (QRST §9.1) and the Receiver's acceptance confirmation of
the P5 rendering (QRST §9.4).

## Pairing between camera-less devices

A share has no standalone encrypted export to fall back on, the way a whole key
has NIP-49 `ncryptsec`. Between two devices without cameras, copy-paste pairing
(QRST §12.1) is therefore the delivery: one device shows its pairing URI as text,
the other pastes it, and the code check and encrypted transfer run over relays as
after a scan.

## The `frost://` scheme

This profile registers `frost://` as its URI scheme under QRST §12.3. It reads as
a token to hand to an app, and opens the app when tapped, which an `https` link
does not.

```
frost://<npub>?v=1&mode=<offer|request>&p=frost-share&check=<level>&token=<hex>&relay=<wss>
```

The parameters are those of QRST §11.2. `p` is always `frost-share`. The QR form
stays the `https` fragment link of QRST §11.2; `frost://` is for pasting and deep
links.

*History.* Through QRST 1.4 this form carried a 32-byte `secret` that the peer
echoed. That is now the 16-byte `token` of every pairing URI, and a 1.4
`frost://` URI, which has no `token`, is rejected (QRST §11.2).

## Offline container

Where no relay is reachable (QRST §10), the pair travels as a passphrase-encrypted
blob:

- **KDF:** scrypt with `r = 8`, `p = 1` (as NIP-49) and `log_n = 18`, over the
  passphrase and a random 16-byte salt.
- **Cipher:** XChaCha20-Poly1305 with a random 24-byte nonce. The version byte is
  the associated data.
- **Plaintext:** the whole payload above, both strings, space-joined. Sealing the
  pair, not only the share, also hides which identity it belongs to.
- **Container:** `version (0x01) || log_n (1) || salt (16) || nonce (24) ||
  ciphertext || MAC (16)`, then bech32 with HRP `frostshare` and no length limit.
  It is deliberately neither a `bfshare1…` nor an `ncryptsec1…` string: the
  `frostshare1…` prefix and its checksum mark it as an encrypted pair and catch
  paste errors.

The Receiver decrypts, applies the P4 check, renders P5 and asks before keeping it
(QRST §10 step 3). The passphrase is the only protection, so an intercepted blob
whose passphrase is guessed carries the same consequences as a share intercepted
at `none`, above.

## Relationship to FROSTR's echo

*Non-normative.* FROSTR clients follow onboarding with an **echo**: a
request/response round trip (`/echo/req`, `/echo/res`) confirming that the share
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
secp256k1 group of 32 members with threshold 2, built from a seeded dealer so the
file is reproducible. It holds the encoded pair, the P4 check, and the size of
every layer of wrapping, and records that 33 members would exceed the default
maximum. A real dealer MUST NOT use a seeded generator.
