# Proposal: ephemeral gift wraps (kind 21059) and re-sending

Against [`QR_SECRET_TRANSFER.md`](https://github.com/sybenx/nostr-key-management/blob/main/QR_SECRET_TRANSFER.md)
1.5-draft. Touches §11.1 (the T8 row), §11.4, §11.5 and §11.7. This repository
implements it: see `src/core/wrap.ts`, `src/core/session.ts` (`settled`) and
`src/web/pool.ts`.

## Problem

§11.4 gift-wraps every message as kind 1059 with a NIP-40 `expiration` of now + 600,
and §11.1 rests T8 (expiry) on that tag. Relays treat kind 1059 as a stored direct
message (NIP-17), and NIP-40 is advisory. Measured on 2026-10-11: a strfry 1.1.0
relay and relay.snort.social both still served a kind 1059 wrap more than 95 s after
its `expiration` had passed. Every message of a session, PAYLOAD included, therefore
sits on public relays for as long as each operator chooses. The payload is
encrypted, but T8 promises a bounded lifetime and in practice the binding does not
provide one.

NIP-59 §4 now defines kind 21059, the *ephemeral gift wrap*: the same structure as
1059, in the ephemeral range, which relays MUST NOT store. On 2026-10-11, ditto
(syb.lol), a strfry 1.1.0 relay, damus, primal, offchain.pub and snort.social all
accepted 21059 and delivered it to a live subscriber in 80–250 ms.

Ephemeral delivery costs something. A relay passes an ephemeral event only to the
subscriptions open when it arrives. A peer whose socket is down at that moment never
sees it: a phone that locked, a tab in the background, or a relay that wanted AUTH
before it served the subscription. §11.5's outbox republishes only when *this* side's
socket opens or authenticates, so nothing helps when it is the *peer* that was away.
Relays also differ in what they do with an ephemeral event:

| Relay | Keeps it | A repeat of the same id | An old `created_at` |
|---|---|---|---|
| ditto, snort.social | nothing | delivered again | accepted |
| strfry (default config) | ~300 s, served to later `REQ`s | `OK true "duplicate: …"`, not delivered | refused after 60 s (`rejectEphemeralEventsOlderThanSeconds`) |

So a message has to go out again while it is unanswered. Each repeat has to be a
*new* wrap, with a new id and a current `created_at`, or strfry neither delivers it
nor, after a minute, accepts it.

## Proposed text

### §11.1, the T8 row

| Requirement | Provided by |
|---|---|
| T8 expiry | kind 21059, which relays MUST NOT store (NIP-59 §4); NIP-40 `expiration` as a backstop where a relay stores it anyway; the receiver's window check on the rumor's own timestamp (§11.4) |

Replace "NIP-40 `expiration` tag, advisory only; see §11.4" with the row above. T9
(liveness) gains: "…for the session's duration, with re-sending (§11.5)".

### §11.4, the wrap

Replace the sentence that begins "These are unsigned rumors" with:

> These are unsigned rumors. **Every one of them** is sealed (kind 13, signed by the
> sending burner, NIP-44 to the recipient burner) and gift-wrapped as an
> **ephemeral gift wrap**: kind 21059 (NIP-59 §4), a random one-time signing key,
> `p` tag set to the recipient burner. There are no exceptions. A client MUST NOT
> publish a session message as kind 1059, which relays store.

In **Timestamps**, replace the first sentence and the first two bullets with:

> Contrary to NIP-59, `created_at` is never a randomised past value. The rumor's and
> the seal's are the time the message was first sent; the wrap's is the time that
> wrap was published, which for a re-send (§11.5) is later than the seal's.
>
> - The wrap SHOULD carry `["expiration","<wrap created_at + 600>"]` per NIP-40.
>   NIP-40 does not apply to ephemeral events, so on a relay that honours kind 21059
>   the tag does nothing. It is there for a relay that stores 21059 anyway, which
>   then still has a reason to drop it.
> - **Neither kind 21059 nor NIP-40 may be relied on for enforcement.** A relay may
>   keep an ephemeral event for minutes (strfry keeps about 300 s), ignore
>   `expiration`, or serve the event long after it has lapsed.

The remaining bullets (expiry enforced against the rumor's timestamp, `SLACK`, the
wall clock, discarding outside the window) stand as they are.

The loopback test of §11.3a publishes a wrap of the same kind. Each relay tested
SHOULD get a probe made at the time of its test: selection can run for minutes, and a
relay may refuse an ephemeral event more than 60 s old.

### §11.5, subscription and re-sending

The filter becomes:

```
{"kinds":[21059], "#p":["<own burner hex>"], "since": <session start − SLACK>}
```

Keep "Dedupe by the id of an event whose signature has been verified…". Add after it:

> A re-send (below) arrives under a new event id, so a client MUST also dedupe
> **rumors** by rumor id, and MUST act on a rumor at most once. A rumor that arrives
> before the message it depends on (a PAYLOAD before the REVEAL that lets the
> Receiver derive the code, which a relay serving stored events newest first can
> cause) MUST NOT be remembered as seen, so that its re-send is taken once the earlier
> message is in.

Replace the paragraph "**Clients MUST keep a session outbox.** …" with:

> **Clients MUST re-send what is unanswered.** A wrap reaches only the subscriptions
> open when a relay receives it, so a message the peer was not listening for is lost
> unless it is sent again. Every message published during a session is kept in an
> outbox, and while it is **outstanding** it MUST be sent again, to every relay of
> the session:
>
> - at an interval of no more than 5 s (3 s RECOMMENDED);
> - to a relay, whenever a socket to it opens and after a NIP-42 authentication with
>   it succeeds (a relay may accept a publish and only then demand `AUTH`); and
> - SHOULD be sent again at once when the client has reason to think it was not
>   listening, such as a page returning to the foreground or the device regaining a
>   network. A socket that is down SHOULD then reconnect at once rather than wait out
>   any backoff.
>
> **Every re-send is a new wrap**: the same seal, wrapped again under a fresh
> one-time key, with `created_at` and `expiration` taken at that moment. It MUST NOT
> be the same event again: a relay holding that id answers "duplicate" and delivers
> nothing, and one may refuse an ephemeral event more than a minute old. The seal is
> reused, not remade, so a re-send needs no burner and can follow the session's end
> (below) without keeping the burner alive.
>
> A message stops being outstanding when the peer has evidently received it. The
> exchange between two burners is a strict alternation: contact (HELLO or REQUEST),
> NONCE, REVEAL, PAYLOAD, ACK. A peer can send a message at one step only after it
> has received everything sent to it at the steps before. A client that accepts a
> message from a peer at step *n* therefore stops re-sending its own messages to that
> peer at steps before *n*. An ABORT from a peer ends re-sending of everything to that
> peer. A message the client ignored as out of turn settles nothing.
>
> ACK and ABORT are answered by nothing. A client SHOULD re-send each of them for a
> bounded time after sending it (20 s RECOMMENDED, well inside the
> `ACK_WAIT_SECONDS` a Sender waits). These re-sends MAY continue after the session
> has ended and the burner has been wiped, because they reuse the seal (above). When
> a session ends, every other message in the outbox stops being outstanding.
>
> Re-sends of the same rumor do not count as further responders (§13) or further
> messages: the recipient sees one rumor.

The "Publishing is parallel, not serial" paragraph and the NIP-42 paragraph stand.

### §11.7, the frame

In "…sends the wrap as a single text frame containing the kind 1059 event JSON",
read **kind 21059**. A LAN socket is a live channel with no storage, so the same
re-sending rule applies over it: a dropped connection loses whatever was in flight.

### §15 (optional)

The bullet on P2 ("a burst of sequenced messages between two keys that have never
spoken before is not") now applies more strongly. A relay sees repeated wraps to the
same `p` tag every few seconds while a message is outstanding. The wraps are
unlinkable to each other except by recipient and timing, which a relay could
already pair (see "An operator sees both halves of a session").

### Status

Add to the history: "1.6 moves the wrap to kind 21059 (NIP-59 §4) so that T8 no
longer rests on NIP-40 alone, and replaces the replay-on-reconnect outbox with
re-sending until answered, each re-send a fresh wrap."

## Notes for review

- **Why not a fresh seal per re-send.** A fresh seal needs the sending burner's
  signature, and the final ACK or ABORT is re-sent after the session has wiped the
  burner (§7 step 18, §8 step 18). The seal is inside the NIP-44 layer, so no relay
  sees it, and the recipient dedupes by rumor id whatever the seal says. Only the
  outer layer needs to be new. If the specification prefers fresh seals while the
  burner is alive, the ACK and ABORT re-sends still need the reuse.
- **Interval.** 3 s puts the cost of a ten-minute wait at a few hundred small events
  per relay. If an operator rate-limits that, the 5 s ceiling still holds. A
  PAYLOAD is outstanding only until the ACK or the Sender's 60 s wait ends.
- **`expiration` kept, not dropped.** It costs about 40 bytes and reveals nothing
  that `created_at` does not. It covers a relay that does not know kind 21059 is
  ephemeral and stores it, which NIP-40 alone covered before.
- **NIP-66.** A monitor that lists accepted kinds rarely names an ephemeral kind, so a
  `k` tag of `21059` is weak evidence. `!21059` is still a reason to skip a relay.
- **Interop.** A 1.5 client subscribes to 1059 and publishes 1059, so it cannot pair
  with a client implementing this proposal. The event kinds are already provisional
  and the specification promises no interoperability before a NIP, so the change
  needs no version bump in the QR (`v=1`). A client that wanted both could subscribe
  to both kinds, but then it would publish 1059 too, which is the problem this
  proposal removes.

## Tested here

`test/retransmit.test.ts` runs two devices against a local relay in two modes:
`live` (keeps nothing; ditto and snort.social behave this way) and `strfry` (keeps
ephemeral events 300 s and serves them newest first, answers a repeated id with
`duplicate:` and does not deliver it, and refuses anything more than 60 s old). For
each step of both flows (HELLO or REQUEST, NONCE, REVEAL, PAYLOAD, ACK), the device
the message is addressed to loses its connection as the message goes out. The test
checks that the transfer completes once that device reconnects. On the `live` relay
it also checks that some wrap really reached no one. Separate tests cover: a PAYLOAD
served ahead of its REVEAL; a message that stops going out once it is answered; and
an immediate reconnect when the page returns to view. With the timed re-send
disabled, every `live` case fails.
