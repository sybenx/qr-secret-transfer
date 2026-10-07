# Notes for the specification

Written while implementing `QR_SECRET_TRANSFER.md` 1.4-draft. Each entry is a place
where the text could be read two ways, or where following it literally would be
unsafe, with the reading this implementation took. They are in the form
`SPEC_ISSUES.md` asks for and are meant to be moved there.

## Proposed changes

### Three levels of check, where 1.4 has one

§9.2 allows one way to verify the code, typing it (or capturing it), and says
"Confirmation alone does not conform". That fixes one risk level for every payload.
How much checking a transfer deserves depends on what is moving, and that is for
whoever builds with the protocol to decide. This implementation offers three:

| `check` | Sender | Receiver |
|---|---|---|
| `type` | §9.2 as written: types the digits the Receiver shows | shows the code |
| `compare` | shows the code it derived; the user confirms both screens match | shows the code |
| `none` | release consent only, to a lone responder | shows no code |

**How it is agreed.** Each device has a setting. The showing device puts its own in
the QR as `check=`; the contacting device answers with the stricter of that and its
own, in a `check` tag on HELLO or REQUEST; the showing device takes the stricter of
that and its own, per responder. A Sender that showed the code applies the strictest
any responder asked for. A link with no `check`, or one a device does not know, reads
as `type`, and a responder that sends none is taken to want `type`. So either device
can raise the level and neither can lower it below the other's setting.

**`compare`.** A deliberate departure from §9.1 item 3 and §9.2. The Sender shows the
code of one responder at a time, the earliest first, and offers "the codes are
different", which spends an attempt and is remembered for §9.3 exactly like a wrong
entry. A Sender that showed the code then shows the next responder's code; one that
scanned has only one peer, and the user asks the Receiver for its next candidate as
before. A responder's code cannot be steered (commit-then-reveal), so a stranger's
code is random and a glance at a few digits catches it; what `compare` does not
survive is a user who does not look. When more than one device answered, the Sender
says so above the code.

**`none`.** Release on consent alone. Without a code nothing can tell two responders
apart, so a deliberate exception to §13: on a device that showed the code with its own
setting at `none`, a second responder ends the session on every device, with an ABORT
carrying `reason=second-responder` so the others can say why. If the text has already
gone, it is too late to stop, and the Sender says another device answered after it was
sent. What remains is a stranger who answers first and a user who releases before
their own device answers; that is the cost of the level, and the page says so.

**The token.** None of this is safe without one. The burner key in the QR is not a
secret: the showing device publishes its loopback probe (§11.3a) as a wrap addressed
to it, and subscribes with it, on the very relays the QR names. Anyone reading those
relays can contact the session without ever seeing the code. Under `type` and
`compare` that gains them nothing but a slot; under `none` it would win them the
secret. So every QR carries `token=` (16 random bytes, hex), every HELLO and REQUEST
echoes it inside the seal, and a contact without it is ignored and not counted as a
responder. This is §12.3's returned secret, applied to every session. It also means a
"another device answered" notice is evidence that someone saw the code.

**Suggested text.** Define `check` and `token` in §11.2 and §11.4; let §9.2 name the
three levels and let a profile (§5) set a minimum; restate §9.1 item 3 and §13 as
applying to `type` and `compare`.

## Suspected errors

### §6 and §13: the contacting party gets more than one attempt per session

§6 says "An attacker who is in the middle gets one attempt per session", and §15 that
commit-then-reveal means such an attacker "cannot grind a match". As written this
does not hold for the party that contacts.

The contacting party commits, receives the other side's nonce, and only then reveals.
At that point it already knows the code. It can decline to reveal, and contact again
from a fresh burner for a different code. §13 lets a Receiver hold three candidates
and §8 lets a Sender queue five, so a party in the middle gets three or five codes to
choose from per session, not one. Worse, nothing in the text says a slot is not freed
when a candidate goes away: an implementation that caps on candidates *currently
held* gives unlimited tries (an ABORT, a bad REVEAL, or the user advancing each free
a slot). The first version of this code did exactly that; an independent review found
it and demonstrated a hundred fresh codes from one burner in one session.

**Reading taken.** A burner gets one nonce exchange per session, ever. The cap (three
for a Receiver that showed the code, five for a Sender that showed it) counts every
burner that has contacted the session, not those still held. A dropped burner cannot
return.

**Suggested text.** State the cap as a total over the session, state that a burner is
answered once, and correct §6's table: the per-session bound for a party in the
middle is the cap divided by 100 000, not 1 in 100 000. Consider lowering the caps,
or having the showing device commit first so that neither side learns the code early.

### §13: what a Receiver does when the active candidate sends ABORT

§13 says a later responder MUST NOT abort the session, because "aborting would let
anyone who photographed the code deny every transfer with a single forged message".
The same is true of the *first* responder: if a stranger answers first and then sends
ABORT, a Receiver that ends its session has been denied by one message.

**Reading taken.** The device that showed the code never ends on a candidate's ABORT.
It shows the next candidate's code, or returns to waiting. (A stranger can still use
up the session's contacts; that is inherent in a cap.)

### §9.2 against §14: is the code stored or not

§9.2: "The obtained value MUST NOT be written to logs, analytics, crash reports, or
any storage that outlives the session." §14: "Every transfer MUST write a local
record: timestamp, profile, transport, SAS, …". After a successful entry the obtained
value *is* the SAS.

**Reading taken.** The record holds the code the device computed, for completed
transfers only. A value that was typed and did not match is never stored. The Sender's
log on screen does not display the code (§9.1: "MUST NOT display the code it derived
itself").

## Ambiguities

### §8, §9.2, §13: what the Sender compares a typed code against in Flow B

§8 says the Sender "works one candidate at a time" and that "a no-match advances to
the next pending request". §9.2 says "a value the Sender obtains that matches none of
its held candidates advances the display".

- Reading A: compare with the active candidate only; on a miss, move to the next and
  ask the user to type the same digits again.
- Reading B: compare with every ready candidate; exactly one match selects it.

**Reading taken: B**, and a value matching more than one candidate is treated as a
miss rather than released to the first. The bound is the same as A (one chance per
held candidate) and the user types once. A consequence: "Don't send" ends the whole
session instead of discarding one request (§8 step 13), because the prompt is no
longer about one request.

### §7 step 12, §13: who advances the Receiver's display in Flow A

"DISPLAY the active candidate's code, advancing to the next held on no-match." The
miss happens on the Sender, which may not transmit the code or the result of the
comparison. The Receiver cannot know.

**Reading taken.** The user says so: when more than one device has responded, the
Receiver offers "The other device rejected this code. Show the next one."

### §9.4, §7 step 16: "the candidate whose code the Sender confirmed"

The Receiver has no way to know which candidate's code a Sender confirmed. The only
evidence is a PAYLOAD, and a stranger can send one unprompted.

**Reading taken.** Only the candidate whose code is on screen can have a payload
presented. A payload from a candidate whose code has never been shown is dropped
together with that candidate, since no conforming Sender could have released it. The
user's confirmation of the rendering remains the defence against a planted payload
from the candidate whose code *is* on screen.

### §13: which candidate is "first"

"The first distinct burner to send a HELLO" is the active candidate, but its code
cannot be shown until it has revealed. **Reading taken:** the earliest responder that
has completed the exchange is shown; one that stalls does not block the others.

### §9.3: what counts as a failed session and a failed burner

**Reading taken.** A session that ends without releasing, after at least one code
entry that did not match, is a failed session. Every burner a typed code was compared
against and missed is remembered for an hour, whether or not it was still held when
the session ended. A typo followed by the right code blames nobody.

### §11.4: which timestamps are "true", and where the window starts

Only the wrap's `created_at` is named. **Reading taken:** the rumor, the seal and the
wrap all carry the true current time. Each device measures the ten-minute window from
its own session start; for the showing device that is when its burner was made, which
precedes the code appearing by however long relay selection took.

### §14: a release that the Receiver then discards

**Reading taken.** The Sender still writes a record: the secret left the device.

### §9.1 item 2 against §11.2: a code with no `origin`

§9.1 says to name the other party as "a native application" when it is not a browser;
§11.2 says a missing origin "does not buy leniency". **Reading taken:** the prompt
says the device "presents itself as an app, not a web page. Nothing has verified
that", and the friction is the maximum regardless.

### §11.2: the contacting party cannot say what it is

Only the showing device has an `origin` field. In Flow B a web Receiver that scans has
nowhere to claim one, so the Sender can only say "The receiving device has not said
what it is." Consider an `origin` tag on HELLO and REQUEST.

### §11.2: encoding and count of `relay`

The grammar shows `[&relay=…]*` and the prose says one to four. **Reading taken:**
zero relays is rejected (a browser has no local path), more than four are truncated
to the first four, `:` and `/` are written literally and everything else is
percent-encoded, and a parser accepts either form.

### §11.6: who reads NIP-11

1.4 says clients read the limits "during the §11.3 probe", which both parties run.
**Reading taken:** only the showing device does, since only it chooses relays.

## Not implemented, and what that leaves open

- **§11.4 clock.** "A client that cannot [keep its clock within SLACK] MUST warn." A
  web page has no way to learn that its clock is wrong, so no warning is shown.
- **§9.2 capture**, and the machine-readable rendering of the code.
- **§10, §11.7, §12.3.**

## Things the specification might add

- **A relay on the user's own machine.** A pairing link is attacker-chosen text. This
  implementation refuses a relay on loopback unless the page is itself served from
  loopback, and never takes a private-network address from a NIP-66 report or carries
  one into later sessions.
- **Framing.** A page that implements the release prompt should refuse to run inside
  another origin's frame; this one does.
- **Text from relays.** `OK`, `CLOSED` and `NOTICE` messages are attacker-chosen and
  end up on screen and in storage. They are truncated here.
- **Dedupe after verification.** §11.5's "dedupe by event id" has to mean the id of an
  event whose signature holds, or one relay can send junk under a real id and have the
  genuine copy from another relay discarded.
