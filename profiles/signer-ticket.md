# Profile `signer-ticket`

A profile for [QR_SECRET_TRANSFER.md](../QR_SECRET_TRANSFER.md) §5, in the shape of
§5.2, for **signing in to a Nostr site or app with a remote signer** — a phone app, a
browser extension, or a group of devices and servers that holds the key between them,
such as [Cosign](https://github.com/sybenx/cosign).

What moves is a single-use **ticket**, never a key. The site redeems it with the user's
signer as the secret of a NIP-46 `connect`, and from then on talks NIP-46 to that signer
with a client key of its own. That client key is the site's access: the signer can
remove it at any time, and nothing the user holds ever left the signer.

Any app may implement either side. The site's half needs QRST and NIP-46; the signer's
half needs QRST, NIP-46 and a way to accept the ticket.

---

## The idea

The site shows a code (Flow A, `mode=offer`: the site is the Receiver). The user scans
it with their signer app, which says who is asking and asks **"Let *site* sign as
you?"**. On yes, the signer mints a ticket, tells whatever answers its NIP-46 requests
to accept it once, and releases it to the site. The site shows whose account it is, the
user confirms, and the site sends `connect` with the ticket as its secret. It is signed
in.

Compared with a bare `nostrconnect://` code, the user's signer learns the site's origin
before anything is granted, the five-digit code of QRST §6 is available when the code was
not read by the signer's own camera, and the site learns the signer's relays from the
ticket rather than guessing.

## Requirements of QRST §5

| QRST §5 item | This profile |
|---|---|
| 1. Payload encoding | Standard padded base64 of UTF-8 JSON, one object: `{"v":1,"pubkey":"<hex>","signer":"<hex>","relays":["wss://…"],"t":"<hex>","expires":<unix seconds>}`. `pubkey` is the account the site will sign as (x-only, 64 lowercase hex). `signer` is the NIP-46 remote-signer pubkey the site will talk to (64 lowercase hex). `relays` are 1 to 6 `wss:` URLs where the signer listens. `t` is the ticket, 16 random bytes as 32 lowercase hex. `expires` is when the signer stops accepting `t`. |
| 2. Maximum size | The default (2048 bytes). |
| 3. P4 check | Decodes as above with exactly these six members; `v` is `1`; `pubkey`, `signer` and `t` are well-formed lowercase hex of the stated lengths; `relays` holds 1 to 6 `wss:` URLs; `expires` is an integer later than now. A site already configured with a signer rejects a ticket naming a different `signer` (QRST §5.2, item 4). |
| 4. P5 rendering | **"Sign in as *name or short npub*?"**, and, because a site normally has no signer configured beforehand, the signer it will use: *"through your signer `abcd1234…` on relay.example"* (QRST §5.2, item 4). |
| 5. Sender's prompt | **"Let *origin* sign as you?"** It MUST say that the site gets access of its own, that it is removed from the signer's list of sites, and that removing it stops future signing, not what was already signed (QRST §5.2, item 6). |
| 6. Additional tags | None. |
| 7. Lowest check level | `none`, **only** when the signer read the `https` code with its own camera, or received it by a verified App Link or Universal Link to that one app. `compare` for a pasted link, for the `qrst:` handoff (which §11.2c requires anyway) and for any custom scheme. See "Why `none`" below. |
| 8. Offline tier | Not permitted. A ticket is useless without the relays it names. |

QRST §5.2 item 7 (receive-only default) does not arise: a site enrolled by a ticket can
sign through the signer but cannot itself issue tickets.

## Issuing and redeeming

- The signer mints a fresh ticket for each attempt, only once the user has said yes, and
  sets `expires` no more than 15 minutes ahead (reference: 900 s).
- Whatever answers the signer's NIP-46 requests accepts `t` as a `connect` secret once,
  before `expires`, and binds the site's client key to the origin the user approved.
- The site redeems only the payload it committed (QRST §9.4), after committing it: it
  sends NIP-46 `connect` to `signer` on `relays`, with `t` as the secret. A site that
  does not get an answer re-sends until `expires`; the signer answers a repeat with the
  same result.
- After that it is ordinary NIP-46 between the site's client key and `signer`.

## Revoking

Removing the site from the signer's list of sites refuses its client key from then on. A
ticket that was never redeemed lapses at `expires`.

## The `nc` fallback

An `https` code MAY carry, after the QRST parameters in the fragment,
`&nc=<percent-encoded nostrconnect: URI>` for the same sign-in, so that one code serves
signers that implement NIP-46 but not this profile.

- A signer that implements this profile uses the ticket and ignores `nc`.
- One that does not MAY use `nc` as an ordinary NIP-46 `nostrconnect` code.
- A bounce page (QRST §11.2a) MAY offer `nc` as "use another signer app", and as a
  link to copy for signers that take pasted links. It is never shown as a QR of its own.
- The site listens for both, keeps whichever signs in first, and stops the other.

## Same-phone sign-in

When the site and the signer are on one device, the site shows a button instead of a
QR. Which link that button opens decides whether the site may skip its own "Sign in as
…?" (row 4):

- **A verified `https` App Link or Universal Link to one specific signer app**: the
  platform guarantees which app received the code, so the site MAY sign in without
  asking again once that signer's ticket arrives.
- **The `qrst:` handoff, or any custom scheme**: any app can claim these (§11.2c), so
  the site MUST ask "Sign in as …?" before redeeming.

## Why `none`

QRST §5.2 item 5 says a ticket profile SHOULD NOT permit `none`, because a stranger
released to at `none` redeems the ticket first. Here that risk is narrower:

- The signer answers only the code its own camera read, or one handed to it by a link
  the platform verified, and the ticket is sealed to that code's burner. A photograph of
  the code gains nothing.
- What remains is a substituted code, which needs control of the screen the user is
  looking at.
- What a stolen ticket buys is a site's access, which the user sees in their list of
  sites and removes.

`frost-share` permits `none` on the same reasoning.
