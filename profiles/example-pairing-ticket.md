# Profile `example-pairing-ticket` (non-normative example)

An example of a profile for [QR_SECRET_TRANSFER.md](../QR_SECRET_TRANSFER.md) §5,
written for an app that **has a server of its own** and wants to add a device to
an account on it, such as a self-hosted save-sync server where each device holds
its own token.

It follows QRST §5.2: what moves is a single-use ticket, not anyone's credential.
The new device redeems the ticket with the server for a credential of its own, so
the Sender's own credential never leaves it, and either device can be removed
without touching the other.

It is a template, not a registered profile. An app copies it, changes the
identifier to its own (`mygame-pair`, say), and fills in the parts marked as the
app's choice. An app with no server should start from
[`example-sync-key`](example-sync-key.md) instead.

---

## The idea

A device already on the account asks the server for a ticket: a short random code
that the server will accept once, for a few minutes. The user scans a QR on one
device with the other, checks five digits, and the ticket travels to the new
device, which presents it to the server and receives a device credential of its
own.

Nothing that moved is worth keeping. A ticket that is never redeemed lapses; one
that is redeemed is spent. What the new device holds afterwards, the server issued
to it alone, and the server's device list is where it is removed.

The server's part is the app's business. This profile needs three things of it: an
authenticated way for an enrolled device to ask for a ticket, an unauthenticated way
to redeem one, and a device list.

## Requirements of QRST §5

| QRST §5 item | This profile |
|---|---|
| 1. Payload encoding | UTF-8 JSON, one object: `{"v":1,"app":"<app id>","server":"<origin>","account":"<label>","ticket":"<code>"}`. `server` is the `https` origin that redeems the ticket, with no path, at most 255 characters. `account` is the name of the account or profile on that server, at most 64 bytes of UTF-8, shown to the user and sent back on redeeming. `ticket` is the server's code, 6 to 64 characters of `[A-Za-z0-9_-]`. `app` identifies the app, at most 32 characters of `[a-z0-9-]`, so two apps that copy this template cannot accept each other's tickets. |
| 2. Maximum size | The default (2048 bytes). With the limits in row 3 the payload is at most 1024 bytes, even with every character of `account` escaped. |
| 3. P4 check | At most 1024 bytes; parses as JSON with exactly these five members; `v` is `1`; `app` equals the receiving app's own identifier; `ticket` and `account` are within the limits of row 1; `server` is an `https` origin **the Receiver is already configured to use** (QRST §5.2, item 4). A Receiver configured with no server shows `server` in the rendering of row 4, and redeems only once the user confirms it. |
| 4. P5 rendering | **"Join *account* on *server*?"**, and, if this device is already enrolled there, that its current access will be replaced. |
| 5. Sender's prompt | "Let *X* join *account* on this server." It MUST say that the other device will get access of its own, which lasts until it is removed from the device list, and that removing it recalls nothing it has already read. |
| 6. Additional tags | None. |
| 7. Lowest check level | `compare` (QRST §5.2, item 5). An app MAY always require `type`. |
| 8. Offline tier | Not permitted in this template. An app whose devices can reach its server but no relay may define one (QRST §10). |

## Issuing and redeeming

- The Sender asks the server for a ticket only once the user has asked to add a
  device, and asks again for each attempt. The server accepts a ticket once, and
  for at most 15 minutes. This template's choice is 10.
- The Receiver redeems only the payload it commits (QRST §9.4), after committing
  it. A candidate it holds and discards is never redeemed (QRST §5.2, item 3).
- On redeeming, the server issues the new device a credential of its own and shows
  it in the device list, under the name the new device gives itself.
- A device enrolled this way is receive-only by default (QRST §14): issuing a
  ticket for a further device needs the expiring toggle. This template does not
  waive that.

## Revoking

Removing the device from the server's device list revokes it. It keeps whatever it
has already read. A ticket that has not been redeemed can be cancelled from the
device that asked for it. Otherwise it lapses on its own.

## Choosing an identifier

A profile identifier matches `[a-z0-9-]{1,24}` and is hashed into the code of QRST
§6, so two devices disagree about it only by failing to pair. There is no registry.
Prefix it with the app's name so that it cannot collide with someone else's.
