# Profile `example-sync-key` (non-normative example)

An example of a profile for [QR_SECRET_TRANSFER.md](../QR_SECRET_TRANSFER.md) §5,
written for an app that wants a second device to share the first one's saved
state, such as a game's saves, **without anyone creating an account**.

It is a template, not a registered profile. An app copies it, changes the
identifier to its own (`mygame-sync`, say), and fills in the parts marked as the
app's choice. Nothing here is Nostr-specific: the app needs no Nostr identity, and
its users never see one.

---

## The idea

The first device generates a random **sync key** the first time it needs one. The
key is the account: whoever holds it can read and write that save. To add a
device, the user scans a QR on one device with the other, checks five digits, and
the sync key travels to the new device. The two devices now share a save, and no
server ever learned who either of them is.

What the key unlocks is the app's business. One shape that also needs no server
of the app's own: derive a storage keypair and an encryption key from the sync key
(for example with HKDF and distinct labels), and keep the encrypted save on Nostr
relays as a replaceable event signed by the derived keypair. Any device holding the
sync key can find, decrypt and update it, and the relays see only ciphertext under
a key that belongs to no one.

## Requirements of QRST §5

| QRST §5 item | This profile |
|---|---|
| 1. Payload encoding | UTF-8 JSON, one object: `{"v":1,"app":"<app id>","name":"<label>","key":"<base64>"}`. `key` is the 32-byte sync key, standard base64. `name` is a label the user gave the save or the player, at most 64 bytes of UTF-8. `app` identifies the app, at most 32 characters of `[a-z0-9-]`, so two apps that copy this template cannot accept each other's keys. |
| 2. Maximum size | The default (2048 bytes). With the limits in row 3 the payload is at most 512 bytes, even with every character of `name` escaped. |
| 3. P4 check | At most 512 bytes; parses as JSON with exactly these four members; `v` is `1`; `app` equals the receiving app's own identifier; `key` decodes to exactly 32 bytes; `name` is a string of at most 64 bytes of UTF-8. |
| 4. P5 rendering | **"Sync with *name*?"**, and, if this device already has a save, that it will be replaced by the other device's. |
| 5. Sender's prompt | "Let *X* sync your saves." It MUST say that the other device will be able to read and change your saves until you reset sync, and will keep any copy it already has. |
| 6. Additional tags | None. |
| 7. Lowest check level | `type` until the app can reset sync ([Revoking](#revoking)); `compare` once it can. A sync key gives full access to the save, so it is only once it can be revoked that the profile stops insisting on `type`. An app MAY always require `type`. |
| 8. Offline tier | Not permitted. Two devices with no network have nothing to sync through. |

## Revoking

Resetting sync is the app's to provide: generate a new sync key, move the save to
it, and hand the new key to every device the user still wants. A device left with
the old key keeps whatever copy of the save it already had and can no longer reach
the new one.

Until an app provides that, its sync key cannot be revoked: its Sender's prompt
MUST say so (QRST §9.1), and its lowest check level is `type` (row 7).

## Choosing an identifier

A profile identifier matches `[a-z0-9-]{1,24}` and is hashed into the code of QRST
§6, so two devices disagree about it only by failing to pair. There is no registry.
Prefix it with the app's name so that it cannot collide with someone else's.
