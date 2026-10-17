# Profile `nostr-nsec`

A payload profile for [QR_SECRET_TRANSFER.md](../QR_SECRET_TRANSFER.md) §5. It
moves a whole Nostr identity key from one client to another.

Key words MUST, MUST NOT, SHOULD, MAY are normative.

*History.* Until QRST moved to this repository, this profile was §3.1 of
`NOSTR_KEY_MANAGEMENT.md` in
[sybenx/nostr-key-management](https://github.com/sybenx/nostr-key-management),
now an archive. This file supersedes that section. The payload, the P4 check and
the minimum check level are unchanged. The `enroll` tag, which served that
document's threshold-signing design, is dropped.

---

## What moves

The identity itself. Nostr has no key rotation, so a device that receives this
payload holds a working copy of the identity permanently, and nothing the Sender
does later can take it back. Every requirement below follows from that.

## Requirements of QRST §5

| QRST §5 item | This profile |
|---|---|
| 1. Payload encoding | 64 lowercase hex characters: the 32-byte private scalar. **Not bech32** (`nsec1…`). |
| 2. Maximum size | The default (2048 bytes). A 32-byte key is about 1.7 KB on the wire. |
| 3. P4 check | 64 hex characters that decode to a scalar in range for secp256k1 and yield a valid x-only public key. |
| 4. P5 rendering | Derive the npub, resolve a display name if one is cached, and ask **"Log in as @name?"** |
| 5. Sender's prompt | "Send your key to *X*." The prompt MUST say that this is the identity itself and cannot be undone: a party that receives it keeps a working copy permanently. |
| 6. Additional tags | `lock`, optional, below. |
| 7. Lowest check level | `type`. The key cannot be revoked, so the user types the digits. A client MAY also offer reading the code by camera. |
| 8. Offline tier | **Not permitted.** See [Without a network](#without-a-network). |

## The `lock` tag

Optional, on the PAYLOAD message: `["lock", "<device|launch|idle:N>"]`.

It carries the Sender's unlock setting for this identity, so that a new device can
start from the same choice instead of asking again:

| `lock` | Meaning |
|---|---|
| `device` | The device's own login is the unlock. The client never prompts for ordinary signing. |
| `launch` | One prompt when the app starts, none until it exits. |
| `idle:N` | Prompt after `N` seconds without interaction. |

The Receiver MAY adopt it as its default and MUST let the user change it. A
Receiver that has no such setting ignores the tag, as QRST §11.4 requires for any
tag it does not recognise. The tag is a preference and never a security boundary:
the Receiver holds the whole key whatever it says.

## Sender restrictions

None beyond QRST §14.

If the sending device also holds a share of a threshold-signing group for this
identity (for example a [FROSTR](https://github.com/FROSTR-ORG/bifrost) group),
sending the whole key elsewhere brings back the single point of failure the group
exists to remove. Clients SHOULD warn before allowing it.

## Without a network

A whole key already has a standalone passphrase-encrypted form: NIP-49
`ncryptsec`. To move a key between two devices with no reachable relay, export it
as `ncryptsec` on one and import it on the other. That is why this profile defines
no offline tier of its own (QRST §10), and why copy-paste pairing (QRST §12.1)
adds little for it between two devices that can already pass text.

A client MUST NOT offer a bare, unencrypted key as text or as a QR in place of
either path.

## Test vectors

`vectors/qrst-sas.json` uses `nostr-nsec` as its profile identifier, so it covers
how this profile's identifier enters the code of QRST §6.
