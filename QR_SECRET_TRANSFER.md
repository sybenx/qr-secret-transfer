# QR Secret Transfer — Specification

Version 1.6-draft
Applies to: any two devices moving a secret between them under user supervision

Key words MUST, MUST NOT, SHOULD, MAY are normative.

---

## 0. Design principle

A secret moves between two devices over infrastructure that neither device
operates, registers with, or trusts. One device shows a QR code, a person
checks a short code across the two screens, and the secret travels encrypted.

Every addition MUST degrade to that base mechanism. Nothing in this
specification may prevent a transfer that the user has authorised and that both
devices are capable of performing.

## 1. Overview

The QR carries an address at which the showing device can be reached, plus
transport hints. It never carries the secret, except in the offline tier of §10 —
available only to a profile that defines its own passphrase encryption — which has
no transport to protect it. It does carry a one-time token (§11.2), which shows
that whoever answers it saw the code.

1. One device generates a burner keypair and shows its public half as a QR.
2. The other scans it and generates its own burner keypair.
3. The two exchange a commitment and two nonces, from which both derive the same
   five-digit code.
4. A person checks that code across the two screens, at one of three levels
   (§9.2): typing it, comparing it, or — where both devices allow it — confirming
   the release without one.
5. Only then does the secret travel, encrypted end to end.
6. Both burner keypairs are destroyed.

§§3–9 state what the mechanism needs without assuming how it is provided. §11
is the Nostr binding and is the only binding defined here.

## 2. Definitions

- **Sender** (`SND`) — the party that holds the secret and releases it.
- **Receiver** (`RCV`) — the party that obtains it.
- **Burner** — an ephemeral keypair created for one session and destroyed after.
  `SND.pub` and `RCV.pub` are the burner public keys.
- **Session** — one transfer attempt. Lifetime 10 minutes. Burners MUST NOT be
  reused across sessions.
- **Contacting party** — whichever party scans the QR and speaks first: the
  Sender in Flow A (§7), the Receiver in Flow B (§8).
- **Profile** — the definition of one kind of payload (§5).
- **Payload** — the secret being moved, as bytes, opaque to this specification.
- **Check level** — how the Sender makes sure it is releasing to the device in
  front of the user: `none`, `compare` or `type` (§9.2). Each party has a setting;
  the stricter of the two applies.
- **Token** — 16 random bytes in the QR, echoed by whoever answers it (§11.2).

Roles are named by what a party does with the secret, never by which party shows
the QR.

## 3. Transport contract

A conforming transport MUST provide:

- **T1 — Ephemeral addressing.** A party can be addressed at a freshly generated
  public key, with no prior registration and no relationship between that key and
  any long-lived identity.
- **T2 — No account.** Neither party holds an identity, credential, or
  relationship with the transport operator. Nothing is provisioned to begin a
  session.
- **T3 — Confidentiality.** Message contents are unreadable by the operator and
  by third parties.
- **T4 — Unlinkability to long-lived identity.** The operator cannot link a
  session to either party's long-lived identity. It is **not** a requirement that
  the operator be unable to pair the two halves of a session with each other; see
  §15.
- **T5 — Sender attribution.** Each delivered message carries a verifiable
  indication of which burner sent it, unforgeable by the operator or a third
  party. Every "verify attribution" step in §§6–8 depends on this.
- **T6 — Capacity.** A single message carries at least the maximum payload
  declared by the profile in use (§4, P1).
- **T7 — Untrusted operator.** The operator may drop, delay, and observe
  messages. It MUST NOT be able to forge or substitute them undetectably.
- **T8 — Expiry.** A message can be given a bounded lifetime.
- **T9 — Liveness within the session.** Best-effort delivery inside the
  ten-minute window. No ordering guarantee beyond what the flows enforce.

## 4. Payload requirements

### P1 — Bounded size

One payload, one message. The transport nests and re-encrypts the payload, which
expands it — under §11, ×3.4 for binary payloads and ×4.7 for hex-encoded ones,
so a 32-byte secret occupies about 1.7 KB on the wire (`tools/payload_ceiling.py`).

The default maximum payload is **2048 bytes binary**, which is carried by
operators at every limit observed (§11.6). A profile MAY declare a larger
maximum; where it does, the showing party MUST read the transport's
advertised limits while choosing relays (§11.3a) and MUST skip operators that
cannot carry the declared maximum.

Payloads SHOULD be base64 rather than hex, which costs roughly 40% of the budget
for no benefit. Profiles carrying tens of bytes MAY use hex.

A payload is measured in the bytes the profile defines, before any base64 or hex
encoding the profile applies to carry it in the PAYLOAD message. A profile whose
payload is already text measures the text, in UTF-8 bytes.

A conformance test vector MUST exist at exactly the declared maximum.

### P2 — Single-shot

One payload, one session. Chunking, fragmentation and resumption MUST NOT be
attempted, and a session carries exactly one message with meaning to the profile.

### P3 — Opaque to the carrier

The mechanism MUST NOT parse, validate, or depend on the structure of the
payload.

### P4 — Identifiable against the declared profile

The Receiver MUST be able to determine that what it received belongs to the
profile declared in the QR (§11.2, `p=`), and MUST abort if it does not. The
check is defined by the profile.

### P5 — Renderable to a person

A profile MUST define a human-meaningful rendering of the received payload, shown
for confirmation before the payload is committed to storage (§9). A payload that
cannot be meaningfully summarised to its recipient MUST NOT use this mechanism.

### P6 — Safe to hold and discard

A Receiver may hold several candidate payloads simultaneously (§13) and commits
at most one. A payload MUST tolerate being received, held, and wiped without side
effects. Implementations MUST bound the number held (§9, §13).

### P7 — Confidentiality from the transport, except offline

A payload need not encrypt itself; T3 covers it on the wire. The exception is the
offline tier (§10), which has no transport: a profile that permits offline transfer
MUST define its own passphrase-based encryption for that case (§5). A profile that
defines none simply has no offline tier.

## 5. Profiles

A profile defines one kind of payload. It is identified by a string matching
`[a-z0-9-]{1,24}`, carried in the QR, and MUST specify:

1. The payload encoding and its meaning.
2. Its maximum payload size, if larger than the P1 default.
3. The check satisfying P4.
4. The rendering satisfying P5.
5. Its confirmation copy for §9 — what the Sender's prompt says is being sent.
6. Any additional message tags, which MUST NOT collide with the reserved names
   in §11.4.
7. The lowest check level of §9.2 it permits. A profile whose payload cannot be
   revoked once released SHOULD NOT permit `none`. A profile that states nothing
   permits `compare` and above. The minimum MAY depend on how the pairing URI
   reached the Sender (§12.3). Whatever level applies, it replaces only the code
   check, never the consent of §9.
8. Whether it permits the offline tier (§10), and if so the passphrase encryption
   satisfying P7. A profile that permits it MUST forbid a raw, unencrypted offline
   encoding.

A profile MAY restrict which parties are permitted to act as Sender, MAY require
a platform credential or biometric check before the Sender releases (§9.1), and
MAY register a URI scheme of its own for its pairing URI (§12.3).
Implementations MUST ignore tags they do not recognise.

Profiles are defined outside this document, so that a new kind of payload never
requires a change to it. The profiles published with this specification are listed
in [`profiles/`](profiles/README.md): `nostr-nsec` for a whole Nostr identity key,
`frost-share` for one share of a FROSTR threshold-signing group, and a
non-normative example for an application's own secret.

### 5.1 Non-normative example

> **Profile `example-token`.** Payload: a bearer token, UTF-8, base64. Default
> size. P4 check: decodes as valid base64 and parses as a JWT with a recognised
> issuer. P5 rendering: "a token for *example.com*, issued 14 March, expiring 21
> March." Sender prompt: "Send your example.com token to …".

## 6. Session and short authentication string

The contacting party commits to a nonce before the other reveals its own. The
code derives from both burners and both nonces.

```
contacting party:  nonce_C ← random 32 B
                   commit  = SHA-256("qrst-commit" || v || C.pub || nonce_C)
                   sends { C.pub, commit }
other party:       nonce_O ← random 32 B;  sends { nonce_O }
contacting party:  sends { nonce_C }
both:              verify SHA-256("qrst-commit" || v || C.pub || nonce_C) == commit
                   code    = SHA-256("qrst-sas" || v || len(p) || p
                                     || SND.pub || RCV.pub || nonce_S || nonce_R)
                   digits  = (code[0..5] as u40 BE) mod 100_000, zero-padded to 5
```

`v` is the protocol version from the QR (§11.2) as a single byte — `0x01` for
`v=1` — hashed as a field rather than baked into the label, so that a future
version changes the transcript mechanically and no two implementations can
disagree on a domain-separator suffix. `SND.pub` and `RCV.pub` are the 32-byte
burner public keys in role order, regardless of flow. In Flow A the contacting
party `C` is the Sender, so `nonce_C = nonce_S`; in Flow B it is the Receiver.
`p` is the profile identifier from the QR (§11.2) as ASCII, preceded by its
length as a single byte.

The reduction `mod 100_000` over 40 bits carries a bias below 3×10⁻⁶, far under
the 10⁻⁵ per-session guess probability the code targets; it is not corrected.

The transcript binds the protocol version, the profile, both burners, the role
each holds, and both nonces. It does **not** bind the relay set or the chosen
transport: §11.3 permits the relay and local paths to be raced and permits
falling back between them mid-session, and a transcript committing to the
transport would render every such recovery indistinguishable from an attack.

Neither party transmits the code. Each derives it independently, and it reaches
the other device through a person (§9).

Each burner gets exactly **one** nonce exchange per session. The contacting party
learns the other's nonce before it reveals its own, so it knows the code first; if
it could walk away and contact again, it could ask for codes until one suited it.
A showing device therefore answers each burner once, ever, and caps the burners it
answers over the whole session — three for a Receiver, five for a Sender (§13) —
counting every burner that has contacted it, not those it still holds.

A party in the middle cannot steer any code's value, but it can hold several
candidates in one session, up to the cap, and each is a fresh 1 in 100 000 chance
of matching what the user checks. When the user checks one value, the per-session
bound is therefore the cap divided by 100 000: 3 in 100 000 against a Receiver that
showed the code, 5 in 100 000 against a Sender that did. Every *distinct* wrong
value the user types at `type` is compared with every ready candidate too (§9.2),
so a user who mistypes four times differently, against the full cap, raises the
worst case to about 1 in 5 000 for that session.

| Sessions | Cumulative risk, cap 5 | Cap 3 |
|---|---|---|
| 1 | 1 in 20 000 | 1 in 33 000 |
| 10 | 1 in 2 000 | 1 in 3 300 |
| 100 | 1 in 200 | 1 in 330 |

Fresh chances come only from fresh sessions, which the user has to start. §9.3's
throttle limits those that end in a miss; it does not see an attacker that walks
away before revealing, which costs it a cap slot but no miss. These figures assume
the code is actually checked: at `compare` they assume the user looks, and at
`none` they do not apply at all (§9.2).

Cost: one extra message on the contacting side. Both flows are four messages
before the payload moves.

## 7. Flow A — Receiver shows the QR

Used when the Receiver cannot scan (desktop, browser), or whenever the Sender is
a phone.

```
Receiver                                    Sender
--------                                    ------
1. gen burner RCV
2. begin listening at RCV.pub
3. show QR: mode=offer, p=<profile>,
   check=<own level>, token
                                            4. scan QR; verify it implements p,
                                               else abort before generating
                                               anything
                                            5. gen burner SND, nonce_S; agree the
                                               level: the stricter of own and QR
                                            6. send HELLO(SND.pub, commit, token,
                                               check) → RCV.pub
7. receive HELLO; verify attribution (T5)
   and token, else ignore; gen nonce_R
   for this SND; its level is the
   stricter of own and HELLO's
   (a HELLO from a second distinct burner
    → §13; keep each with its own nonce_R)
8. send NONCE(nonce_R) → SND.pub
                                            9. receive NONCE
                                           10. send REVEAL(nonce_S) → RCV.pub
                                           11. derive SAS; show the consent
                                               prompt of §9
12. receive REVEAL; verify commit; derive
    SAS for this SND; DISPLAY the active
    candidate's code (unless the level is
    none), advancing to the next held when
    the user says the Sender rejected it
    (§13)
                                           13. user checks the code at the agreed
                                               level (§9.2); match → 14
                                               declines or 5 failures → abort,
                                               zeroize SND
                                           14. send PAYLOAD → RCV.pub
15. receive payload; verify attribution;
    hold keyed by sending burner.
    MUST NOT commit
16. take the candidate whose code is on
    screen (§9.4); apply the P4 check;
    render per P5 ("Log in as @name?");
    ask to confirm
17. confirmed → commit payload; send ACK
    → SND.pub; zeroize RCV and every other
    held payload
    declined → discard this candidate,
    send it ABORT, and show the next held
    candidate's code or wait (§13)
                                           18. zeroize SND on ACK or after 60 s
```

Step 13 authorises *release*; steps 16–17 authorise *acceptance*. Both are
required.

## 8. Flow B — Sender shows the QR

Used when the Sender cannot scan (camera-less desktop, browser).

```
Sender                                      Receiver
------                                      --------
1. gen burner SND
2. begin listening at SND.pub
3. show QR: mode=request, p=<profile>,
   check=<own level>, token
                                            4. scan QR; verify it implements p,
                                               else abort
                                            5. gen burner RCV, nonce_R; agree the
                                               level: the stricter of own and QR
                                            6. send REQUEST(RCV.pub, commit,
                                               token, check) → SND.pub
7. receive REQUEST; verify attribution
   and token, else ignore; gen nonce_S
   for this RCV
8. send NONCE(nonce_S) → RCV.pub
                                            9. receive NONCE
                                           10. send REVEAL(nonce_R) → SND.pub
                                           11. derive SAS; DISPLAY own code,
                                               unless the level is none
12. receive REVEAL; verify commit; derive
    SAS; show the consent prompt of §9
13. user checks the code at the agreed
    level (§9.2); match → 14
    (declines → abort the session)
14. send PAYLOAD → RCV.pub
                                           15. receive payload; verify attribution
                                               and that the sending burner is the
                                               SND.pub from the QR, else discard
                                           16. apply P4 check; render per P5;
                                               ask to confirm
                                           17. confirmed → commit; send ACK
                                               → SND.pub; zeroize RCV
18. zeroize SND on ACK or after 60 s
```

Requests are queued by distinct Receiver burner in arrival order, capped at
**five per session** — counted over the whole session, not as held at once (§6);
further distinct requests are dropped with the §13 notice. Each queued request runs
its own nonce exchange. The Sender applies the strictest level any queued request
agreed (§9.2), and:

- at `type`, compares a typed value with the code of **every** ready request; a
  value matching exactly one releases to it, and anything else — no match, or more
  than one — is a miss and spends an attempt. The user types once, whichever
  request is real;
- at `compare`, shows one request's code at a time, the earliest ready first, and
  moves to the next when the user says the codes differ;
- at `none`, never chooses between requests: a second one ends the session (§13).

Declining at the release prompt ends the session, because the prompt is about the
transfer, not one request. Otherwise the session ends on release or at ten minutes.

In Flow B the Receiver has no independent screen to compare against before it
sends its request: the SAS is shown to it at step 11 and to the Sender at step
12, and the Sender acts on the comparison. The Receiver's acceptance
confirmation at step 16 remains required.

## 9. Consent and confirmation

Two distinct user actions, on two devices. Both are mandatory and neither may be
defaulted, remembered, or suppressed. Between them sits the **code check of §9.2**,
which has three levels; the lowest, `none`, has no code at all. The level is the one
thing here that varies. The two consent actions below are never waived.

### 9.1 Release consent, on the Sender

Before any payload is sent, the Sender MUST present a prompt that:

1. Names what is being sent, in the profile's words (§5, item 5). Where the
   profile's secret cannot be revoked once released, the prompt MUST say so, and
   MUST state that the secret itself leaves this device — not a session, not a
   revocable permission. Where it can be revoked, the prompt MUST NOT claim more
   than the software does: revoking stops future use and recalls nothing the
   other device has already read or done.
2. Names what the other party claims to be: for a browser, its origin; otherwise
   that it is a native application. These are unverified claims. Origins
   containing non-ASCII MUST be shown as punycode.
3. Presents the code check at the agreed level (§9.2). At `type` the Sender MUST
   NOT display the code it derived itself; at `compare` it displays it, and only
   then; at `none` it states that no code is checked.
4. Requires a deliberate action. The Sender MUST NOT release before it.

**The heading MUST contradict the expected mental model** — a person who has just
scanned a QR believes they are signing in. For example: *"This is not a login.
You are about to give this device your key."*

**Declining MUST be the prominent control.** The affirmative control MUST NOT be
visually dominant, MUST NOT be focused or default, and MUST NOT be activated by a
default keyboard action. Where the controls carry text, the affirmative one MUST
describe the transfer rather than express agreement: "Send my key to that device"
rather than "OK" or "Continue".

**Friction is graduated, and it fails closed.** The tier is set by what the other
party is *established* to be, and the default is the maximum:

- **Maximum friction** applies whenever the other party claims a web origin, **and
  whenever its nature is unestablished** — a pairing obtained by paste, or by any
  means other than this device's own camera reading the code (§11.2a), or with no
  positive native claim. An unlabelled peer gets web-tier friction, never the
  benefit of the doubt. The prompt SHOULD require an additional deliberate act
  beyond a single tap, and where an origin is claimed MUST name it in the
  affirmative control itself.
- **Standard friction** applies only when the peer positively presents as a native
  application *and* the pairing was read by this device's own camera — the one
  channel that proves the code was physically in front of the user. Deliberate and
  unambiguous, but not alarming.

This closes the gap where a party that never shows a QR — a web client that reaches
the Sender by a pasted request rather than a scanned code — would otherwise be
handled as native merely because it declared no origin. Its nature is
unestablished, so it gets the maximum.

A revocable payload draws the same tier as any other. It is usable from the
moment of release, so being able to withdraw it later lowers nothing here.

**Authorisation is scoped to one session and MUST NOT outlive it.** Consent, and
any platform credential or biometric check a profile requires alongside it (§5),
authorise exactly one transfer session. They MUST NOT be remembered, defaulted,
cached, or carried into a subsequent session, and MUST NOT open a period during
which further transfers proceed unchallenged.

### 9.2 Checking the code

The code is checked at one of three levels, weakest first:

| Level | Sender | Receiver | Stops a party in the middle |
|---|---|---|---|
| `none` | release consent only | shows no code | no: whoever answers first and is released to gets the payload |
| `compare` | shows its code; the user says whether the two screens match | shows its code | if the user looks |
| `type` | the user obtains the Receiver's code and the Sender matches it | shows its code | yes, at the §6 bound |

**Agreement.** Each party has a setting. The showing party puts its own in the QR
(`check`, §11.2). The contacting party takes the stricter of that and its own, and
states the result in its first message (§11.4). The showing party takes, per
responder, the stricter of that and its own. A QR without `check`, a value a client
does not recognise, and a first message that states no level all read as
`type`. Either
party can therefore raise the level and neither can lower it below the other's
setting. No level may fall below the profile's minimum (§5, item 7).

A Sender that showed the QR and holds several responders applies the strictest
level any of them agreed. Once a responder that asked for `type` has answered,
neither it nor a stranger in its place can be released to by a weaker check; a
stranger that answered before it, at a weaker level, is still subject only to that
level until it does.

The level is a setting, never a default the peer can choose for the user. Once
agreed for a pair it does not change. The level a showing Sender applies can only
rise as responders arrive, never fall; an implementation MUST re-present the check
when it rises. This specification does not say which level a
transfer deserves; it recommends `type` for what cannot be revoked, `compare` for
most things, and `none` for what can be revoked or is useless until a separate
admission step.

#### At `type`

**The Sender MUST obtain the Receiver's code from the Receiver's display and
verify it locally — regardless of which party showed the QR.** The direction is
invariant: the Receiver displays, the Sender reads and compares. It is never the
Receiver that types a code the Sender shows. The Sender is the party performing the
release, so the Sender is the party that must actively prove it read
the other screen; a code entered on the Sender and matched against the Sender's own
computed value is that proof.

Two conforming methods; an implementation MAY offer either or both:

- **Entry.** The user reads the digits and types them.
- **Capture.** The user points this device's camera at the Receiver's display and
  the code is read optically. A Receiver SHOULD render its code in a
  machine-readable form alongside the human-readable one.

At this level, a control that merely asks whether the codes match does not conform.

- Where entry is used, the field MUST show five discrete character positions, MUST
  accept exactly five digits, and MUST NOT silently accept more.
- The field MUST NOT be pre-filled and MUST NOT be auto-completed from the
  clipboard.
- Where capture is used, a captured code that does not match counts as an
  attempt.
- The obtained value is compared with the code of **every** ready candidate (§13).
  A value matching exactly one releases to it; a value matching none, or more than
  one, is a miss.

#### At `compare`

The Sender displays the code it derived for one candidate, and the user says
whether the Receiver's screen shows the same five digits.

- The Sender shows **one candidate's code at a time**, the earliest ready first. It
  is never all codes at once.
- "They match" releases to that candidate. "They differ" is a miss: it spends an
  attempt and counts against that burner for §9.3 exactly as a wrong entry does. A
  Sender that showed the QR then shows the next candidate's code, or returns to
  waiting; a Sender that scanned has only one candidate, and the user asks the
  Receiver to show its next candidate's code (§13).
- Where more than one device has answered, the Sender MUST say so beside the code,
  before the user confirms.
- The affirmative control is subject to §9.1 like any other release control.

A responder's code cannot be steered (§6), so a stranger's code is random and a
glance at a few digits catches it. What this level does not survive is a user who
does not look, which is the reason `type` exists.

#### At `none`

There is no code to check. The Sender releases on consent alone, and only to a
lone responder.

- A showing party MUST end the session, on every party it has heard from, when a
  second responder answers and either of them was agreed at `none` (§13). Nothing
  can tell two responders apart without a code, so it does not try. Where every
  responder was agreed at `compare` or above, the codes tell them apart and the
  session continues.
- A second responder that arrives after release cannot be stopped; the Sender MUST
  still say that another device answered.
- The release prompt MUST state that no code is checked and that the payload goes
  to whichever device answered.

What remains is a stranger who sees the QR, answers before the user's device, and
is released to before the user's device answers. That is the cost of the level.
The token (§11.2) confines it to parties who actually saw the QR; without it, any
reader of the relays named in the QR could answer.

#### At every level

- At most **five** attempts per session, across every candidate. On the fifth
  failure the Sender abandons the session and zeroizes its burner. Each
  candidate's code is fixed once it has revealed, and no party can steer its value;
  §6 states what several candidates and several attempts add up to.

**The code is never transmitted, and the comparison is never delegated.**

- The obtained value MUST NOT be sent to the peer, in any form, encrypted or not.
- The Sender MUST compare it against the value it computed itself. A comparison
  result asserted by the peer MUST NOT be accepted under any circumstances.
- A value that was obtained and did not match MUST NOT be written to logs,
  analytics, crash reports, or any storage that outlives the session. The code of
  a completed transfer is recorded under §14.

**It is not a PIN and MUST NOT be called one.**

- Interfaces MUST NOT label it "PIN", "passcode", or anything the user might
  possess independently. It belongs to one session: "pairing code" or "the digits"
  will do.
- The prompt MUST state where the code comes from — "the digits shown on your other
  device" — rather than asking for "your code".
- Implementations MUST NOT request this code anywhere outside an in-progress
  transfer.

### 9.3 Restart throttle

Within one session an attacker's chances are bounded by §6; every fresh chance
comes from a new session.

- On exhausting its attempts the Sender zeroizes its burner and ends the session.
  The client MUST return the user to the scan step. It MUST NOT offer to re-enter
  a code, reopen the entry field, or resume the session in any way.
- **The Sender MUST NOT begin a new session with a peer burner it has already
  failed a code entry against**, and MUST remember those burners for at least one
  hour.
- The Sender SHOULD send `ABORT` (§11.4) before zeroizing. Its absence means
  nothing and MUST NOT be relied on.
- After **three** failed sessions within one hour, the client MUST tell the user
  that repeated failures can indicate interference rather than mistyping, and
  SHOULD require an explicit acknowledgement before another attempt.
- A **failed session** is one that ends without a release after at least one miss.
  A **failed burner** is every burner a miss was counted against, whether or not it
  was still held when the session ended. A miss followed by a match blames nobody.

### 9.4 Acceptance confirmation, on the Receiver

Before a payload is committed, the Receiver MUST commit only a payload from the
candidate whose code is on its screen — at `none`, its sole responder. The Receiver
cannot know which code the Sender matched, since the Sender sends neither the code
nor the result; the only conforming Sender for any other candidate never saw that
candidate's code, so a payload from a candidate whose code has never been displayed
MUST be discarded together with that candidate. The Receiver MUST then show the P5
rendering, and MUST require confirmation.

This side MUST NOT be presented as alarming. The confirmation is nonetheless
mandatory: it is what prevents a party who photographed the QR from racing the
real Sender and planting their own payload.

## 10. Offline tier

Available only when no transport (§11.3) is reachable, the user confirms they are
offline, and **the profile defines the passphrase encryption below** (§5). Not
every profile does. A profile whose secret already has a standalone
passphrase-encrypted form elsewhere has no need to: `nostr-nsec` points instead to
NIP-49 `ncryptsec` export. A profile whose secret has no such form is the case this
tier exists for: `frost-share` defines its own container.

The payload travels inside the QR or the pasted text itself, so every transport
property of §3 is forfeited and the profile's passphrase encryption is all that
protects it (P7). There is no SAS and no token here — the artifact *is* the
transfer.

1. The Sender prompts for a passphrase, with the line **"Anyone who photographs
   this code or reads this text can try passwords against it forever; this
   passphrase is the only protection."**
2. The Sender renders the profile's passphrase-encrypted encoding of the payload —
   as a QR, or as selectable text. A QR screen sets the platform screenshot-block
   flag and auto-dismisses after 60 seconds; where no reliable flag exists (X11 has
   none, Wayland is compositor-dependent) the Sender MUST warn that screenshots
   cannot be blocked, and MAY then proceed.
3. The Receiver scans or pastes, prompts for the same passphrase, decrypts, applies
   the P4 check, renders per P5, and asks to confirm before committing.

**Raw, unencrypted payload MUST NOT be offered.** A profile's offline encoding is
passphrase-encrypted or it does not exist; a client MUST NOT hand over a bare
secret as text or QR, because a pasted secret persists in clipboard
history and platform clipboard sync beyond the user's control, where the token of
§11.2 and the passphrase of this tier do not.

## 11. Transport binding: Nostr

**This is the only Nostr-dependent section.** A different binding replaces this
section and nothing else.

### 11.1 How the contract is satisfied

| Requirement | Provided by |
|---|---|
| T1 ephemeral addressing | secp256k1 burner keypairs; wraps addressed by `p` tag |
| T2 no account | relays accept unauthenticated publishes; burners are unregistered |
| T3 confidentiality | NIP-44 v2, twice — rumor to seal, seal to wrap |
| T4 unlinkability to long-lived identity | burner keypairs; NIP-59 random one-time wrap signing key |
| T5 sender attribution | the seal (kind 13) is signed by the sending burner |
| T6 capacity | §11.6 |
| T7 untrusted operator | relays cannot forge a seal signature |
| T8 expiry | kind 21059, which relays MUST NOT store (NIP-59 §4); NIP-40 `expiration` as a backstop where a relay stores it anyway; the receiver's window check on the rumor's own timestamp (§11.4) |
| T9 liveness | relay subscription for the session's duration, with re-sending (§11.5) |

NIP-59's `created_at` randomisation maps to no row above and is **not** used; see
§11.4.

### 11.2 QR URI

The pairing address is a single `https` link. Every parameter lives in the URL
**fragment**, so that neither the burner key nor the relay list reaches the host's
server or its logs. This binding defines no custom URI scheme: "qrst" is the name
of the mechanism, not a `scheme://`, and MAY appear in `<path>`. A profile MAY
register one as a second carrier for pasting and deep links (§12.3); the QR is
always this `https` form.

```
https://<host>/<path>#v=1&mode=<offer|request>&p=<profile-id>&npub=<npub>&check=<none|compare|type>&token=<hex>[&relay=<wss url>]*[&origin=<claimed-origin>]
```

- `npub` — bech32 burner public key of the device showing the QR.
- `mode=offer` — the showing device is the Receiver (Flow A).
- `mode=request` — the showing device is the Sender (Flow B).
- `p` — profile identifier (§5). REQUIRED; it is hashed into the SAS (§6), so an
  optional field would need a canonical encoding for its absence and two
  implementations would choose differently.
- `check` — the showing device's own check level (§9.2). A missing or unrecognised
  value reads as `type`.
- `token` — 16 random bytes as 32 lowercase hex characters, fresh for each
  session. REQUIRED. The contacting party echoes it inside its first sealed message
  (§11.4), and the showing party ignores any contact that does not. The burner key
  is not secret — the showing device publishes to it and subscribes with it on the
  very relays the QR names — so the token, which appears only in the QR, is what
  shows that a responder saw the code. It is not key material and protects no
  payload; at `compare` and `type` it keeps responders who never saw the QR from
  using up the §13 cap, and at `none` it is the only thing that does.
- `relay` — 1–4 relay URLs the showing device is subscribed to, each a `wss:` URL
  (§11.3a). A URI naming none is rejected; one naming more than four is truncated
  to the first four. In the fragment, `:` and `/` MAY be written literally and
  everything else is percent-encoded; a parser accepts either form.
- `origin` — REQUIRED if and only if the showing device is a web client, and
  omitted otherwise. It is an unverified claim, and its absence does not buy
  leniency: §9's friction fails closed, so an unstated nature draws the web tier.

A client MUST reject URIs with unknown `v`, missing `mode`, missing `p`, or a
missing or malformed `token`, and MUST abort before generating a burner if it does
not implement the declared profile.

The URI is not payload material, but since 1.5 it is not entirely public either:
whoever holds it can answer it. It SHOULD be passed only to the user's own other
device.

**Role collision.** A client that has already committed to a role MUST reject a
URI whose `mode` implies that same role, and MUST say so rather than failing
later. A client that has not yet committed adopts the complementary role.

Profiles MAY register additional `mode` values.

### 11.2a The bounce page

The primary path never visits `<host>`: a client whose **own camera** reads the
code extracts the parameters from the fragment and pairs directly, making no HTTP
request. `<host>` matters only when a *generic* camera — the platform camera app —
scans the code and opens a browser.

Using `https` rather than a custom scheme costs nothing in reach. An app that has
claimed `<host>` through the platform's standard association — iOS Universal Links,
Android App Links — opens directly from the link on both platforms, the same
one-tap open a `scheme://` would give, but bound to a domain the app proved it owns
rather than a global string any app can register. The app already serving the
bounce page hosts that association file; nothing extra is stood up for it.

- The landing page SHOULD be a **bounce page**: it reads its own fragment, opens
  the associated app where App/Universal Links are set up, and otherwise offers the
  parameters as copyable text — acting as a party itself only if the visitor
  chooses that host's own client. Because the fragment never reaches the server,
  the page can be entirely static, and the host's server learns nothing. The
  page's own script does read the fragment, token included, so whoever controls
  that script could answer the code. At `compare` and `type` that gains it a code
  that does not match; at `none` it could gain the payload, which is one more
  reason `none` suits pairings read by the client's own camera.
- A showing device with no host of its own still pairs by the peer's own camera;
  the `<host>` it names serves only the generic-camera fallback.
- The extra friction §12.1 requires for a pasted URI applies identically to an
  `https` code that reached the client by any route other than its own camera.
- A web client that implements the release prompt MUST refuse to run inside
  another origin's frame, where that origin could dress up what the prompt asks.

### 11.2b Presenting the code

**A QR MUST NOT be displayed bare.** It is accompanied by a line, in the user's
language, stating the direction and what will move: "Scanning this sends your key
to this device", "This device is receiving a key". The profile supplies the
wording (§5, item 5).

**Release and receipt MUST look different.** A `mode=offer` code, which makes
whoever scans it the Sender, is presented with visibly greater weight than a
`mode=request` code.

**Overlays.** Implementations MAY place a logo or wordmark at the centre of the
code. An implementation that overlays anything MUST raise error correction to
level **H**, MUST keep the overlay under 25% of the code's area, and SHOULD verify
its codes still scan at the smallest screen size it supports.

**No overlay may imply assurance.** Whatever sits in that space MUST NOT be a
badge, seal, shield, tick, padlock or ribbon, and MUST NOT be rendered in whatever
colour the implementation uses elsewhere for success, verified or trusted states.
This specification defines no mark of its own.

Implementations MUST NOT relax any consent step of §9 on the basis of anything
rendered on or beside the code.

### 11.3 Transport selection

Relays are the transport. Before showing transfer UI the client probes relay
reachability — a WebSocket open and `REQ` accepted on at least one configured
relay — with a 3 s timeout. An implementation MAY additionally offer the optional
local path of §11.7; where it does, it probes that concurrently and the first
payload successfully received on either completes the session and cancels the
other.

Where neither is reachable and **the profile permits it**, the client MAY fall
back to the offline tier of §10 — the payload passphrase-encrypted in the artifact,
no relay. Where the profile permits no offline tier, this specification offers no
fallback; the profile may name one outside it, as `nostr-nsec` names NIP-49
`ncryptsec` export.

**The probe is advisory, not selective.** A three-second probe MUST NOT close out
a ten-minute session: the client MUST show transfer UI, MUST keep re-attempting an
unreachable relay for the remaining lifetime of the session, MUST proceed as soon
as a relay becomes reachable, and MUST report failure only once the session has
expired.

### 11.3a Choosing the relays

Only the showing party chooses relays; the contacting party uses those the QR
names. No relay is depended on, and none is trusted.

**A relay is named in a QR only if it has passed a loopback test in this
session.** The showing party publishes a wrap addressed to its own burner, with a
PAYLOAD-shaped rumor padded to the profile's maximum payload, and the relay passes
only if the same event comes back on the session's subscription (§11.5) within
3 s, with its id and signature verified (§11.5). That is close to what a session
needs: the relay accepts a gift wrap from a key it has never seen, serves it to a
subscription filtering on a key it has never seen, and carries a payload of the
declared size. It does not prove that a second connection, from the peer, will be
served the same way. The showing party also reads NIP-11 (§11.6) and
skips a relay whose advertised limits cannot carry that payload. The loopback event
is never treated as a message of the session. The loopback wrap is of the session's
kind (§11.4), and each relay tested SHOULD get a probe made at the time of its test:
selection can run for minutes, and a relay may refuse an ephemeral event more than
60 s old.

Candidates SHOULD be tested in this order, a batch at a time, until enough pass
(implementations SHOULD aim for two or three, and name at most four):

1. relays the user, or the page or app, configured;
2. relays that passed on this device before;
3. relays named by a QR this device scanned, in a session that completed;
4. only if none of those passes: a short list of seeds shipped with the client,
   and relays that NIP-66 monitors report, read from relays the device already
   knows, the seeds first.

A report or a seed is a reason to test a relay, never a reason to name it. Where
nothing passes, the client keeps working through the list and retesting for the
life of the session, as §11.3 requires.

- A client MUST NOT use a relay on the user's own machine unless the client is
  itself served from that machine, whether the relay comes from a pairing link or
  anywhere else: a pairing link is attacker-chosen text, and must not point a
  client at a service on the user's computer. A client MUST NOT take a
  private-network address from a NIP-66 report, or carry one learned from a pairing
  link into later sessions. It MAY use one a pairing link names, since two devices
  on one network may legitimately share a relay there.
- Relays that pass SHOULD be remembered for later sessions, so that a device prefers
  what has worked for it; a relay that keeps failing SHOULD be forgotten unless the
  user put it there.

### 11.4 Messages

```jsonc
// HELLO — Sender → Receiver (Flow A): the Sender's commit, the QR's token, the agreed level
{ "kind": 24401, "content": "", "tags": [["commit","<hex>"],["token","<hex>"],["check","<level>"]] }

// REQUEST — Receiver → Sender (Flow B): the same, from the Receiver
{ "kind": 24402, "content": "", "tags": [["commit","<hex>"],["token","<hex>"],["check","<level>"]] }

// NONCE — non-contacting party → contacting party
{ "kind": 24403, "content": "", "tags": [["nonce","<hex>"]] }

// REVEAL — contacting party opens its commit
{ "kind": 24404, "content": "", "tags": [["nonce","<hex>"]] }

// PAYLOAD — Sender → Receiver
{ "kind": 24405, "content": "<profile-defined>", "tags": [] }

// ACK — Receiver → Sender, after the payload is committed
{ "kind": 24406, "content": "", "tags": [] }

// ABORT — either party → peer, this session is over (§9.3). `reason` is optional;
// the one value defined is "second-responder" (§13), which changes only what the
// recipient tells its user.
{ "kind": 24407, "content": "", "tags": [["reason","<reason>"]] }
```

These kinds are **provisional, not arbitrary**. They sit in the ephemeral range
(20000–29999), which suits gift-wrap rumors — relays never store them as such, and
one leaked unwrapped is dropped rather than kept — and they were checked free of
collision against the registered kinds as of 2026-09-02 (nearest neighbours: 24133
NIP-46, 24242 NIP-B7). They are not yet reserved by a NIP; a NIP submission would
formalise them, and they change only if that process asks or a later collision
appears. Interoperability is not promised before that NIP.

Reserved tag names: `commit`, `nonce`, `token`, `check`, `reason`. Profiles MAY add tags to any message;
implementations MUST ignore tags they do not recognise.

The session's protocol version is fixed by the QR's `v` (§11.2) and hashed as a
field into the commit and the SAS (§6). Messages carry no version tag. One session
carries one PAYLOAD; there is no side-channel for additional profile messages (P2).

These are unsigned rumors. **Every one of them** is sealed — kind 13, signed by
the sending burner, NIP-44 to the recipient burner — and gift-wrapped as an
**ephemeral gift wrap** — kind 21059 (NIP-59 §4), random one-time signing key, `p`
tag set to the recipient burner. There are no exceptions. A client MUST NOT publish
a session message as kind 1059, which relays store.

**Timestamps.** Contrary to NIP-59, no `created_at` is ever a randomised past value.
The rumor's and the seal's are the true time the message was first sent; the wrap's
is the true time that wrap was published, which for a re-send (§11.5) is later than
the seal's. The randomisation exists to
obscure authoring time for asynchronous correspondents; here every wrap is
published immediately, both parties are single-session burners, and the
randomisation buys nothing while forcing a 48-hour subscription window and a
second timestamp to reason about.

- The wrap SHOULD carry `["expiration","<wrap created_at + 600>"]` per NIP-40.
  NIP-40 does not apply to ephemeral events, so on a relay that honours kind 21059
  the tag does nothing; it is there for a relay that stores 21059 anyway, which then
  still has a reason to drop it.
- **Neither kind 21059 nor NIP-40 may be relied on for enforcement.** A relay may
  keep an ephemeral event for minutes (strfry keeps it about 300 s, and longer on a
  relay that receives no further writes), ignore `expiration`, or serve the event
  long after it has lapsed.
- Expiry is enforced by the receiver against **the rumor's own timestamp**, which
  is the one covered by the seal signature and therefore attributable to the
  sending burner.
- Session-window tests compare that timestamp against the session's ten-minute
  lifetime, which each party measures from its own session start (for the showing
  party, when its burner was made), with a tolerance of **`SLACK = 120` seconds**
  at each end. `SLACK` is
  normative: if one client accepts what another rejects, honest pairings fail
  between them.
- The window is enforced against absolute timestamps with no shared time origin,
  so clients MUST keep their wall clock within `SLACK` of true time — by NTP or
  the platform's network time. A client that knows it cannot MUST warn that
  transfers may fail (a web page usually cannot tell), and MUST NOT widen `SLACK` locally to compensate: a wider window is a
  larger cross-session grinding surface for the SAS (§6).
- A rumor whose timestamp falls outside that widened window MUST be **discarded
  from the session entirely** — never shown, never given a nonce exchange, never
  in the SAS candidate list, and not merely excluded from the §13 counter.

**Attribution check (T5).** The rumor's `pubkey` field MUST be set to the sending
burner and MUST equal the key that signed the seal; a rumor failing either test is
discarded. The sending burner appears in no other field.

### 11.5 Relay subscription

The receiving side subscribes:

```
{"kinds":[21059], "#p":["<own burner hex>"], "since": <session start − SLACK>}
```

Dedupe by the id of an event whose signature has been verified. An id alone is not
evidence: one relay can serve junk under a real event's id, and a client that
remembers the id before checking the signature discards the genuine copy from
another relay.

A re-send (below) arrives under a new event id, so a client MUST also dedupe
**rumors** by rumor id, and MUST act on a rumor at most once. A rumor that arrives
before the message it depends on (a PAYLOAD before the REVEAL that lets the
Receiver derive the code, which a relay serving stored events newest first can
cause) MUST NOT be remembered as seen, so that its re-send is taken once the earlier
message is in.

Text a relay sends — `OK`, `CLOSED` and `NOTICE` messages — is chosen by the relay
operator. A client that shows or stores it MUST bound its length and MUST NOT treat
it as anything but text.

**Publishing is parallel, not serial.** A client publishes each message to every
relay from the QR that it has an open socket to. If every relay rejects a publish
(allowlist, paid, unknown key), the client falls back to the local path.

**Clients MUST re-send what is unanswered.** A wrap reaches only the subscriptions
open when a relay receives it, so a message the peer was not listening for is lost
unless it is sent again. Every message published during a session is kept in an
outbox, and while it is **outstanding** it MUST be sent again, to every relay of the
session:

- at an interval of no more than 5 s (3 s RECOMMENDED);
- to a relay, whenever a socket to it opens and after a NIP-42 authentication with
  it succeeds (a relay may accept a publish and only then demand `AUTH`); and
- SHOULD be sent again at once when the client has reason to think it was not
  listening, such as a page returning to the foreground or the device regaining a
  network. A socket that is down SHOULD then reconnect at once rather than wait out
  any backoff.

**Every re-send is a new wrap**: the same seal, wrapped again under a fresh
one-time key, with `created_at` and `expiration` taken at that moment. It MUST NOT
be the same event again: a relay holding that id answers "duplicate" and delivers
nothing, and one may refuse an ephemeral event more than a minute old. The seal is
reused, not remade, so a re-send needs no burner and can follow the session's end
(below) without keeping the burner alive.

A message stops being outstanding when the peer has evidently received it. The
exchange between two burners is a strict alternation: contact (HELLO or REQUEST),
NONCE, REVEAL, PAYLOAD, ACK. A peer can send a message at one step only after it
has received everything sent to it at the steps before. A client that accepts a
message from a peer at step *n* therefore stops re-sending its own messages to that
peer at steps before *n*. An ABORT from a peer ends re-sending of everything to that
peer, and so does an ABORT the client sends it, apart from that ABORT itself. A
message the client ignored as out of turn settles nothing.

ACK and ABORT are answered by nothing. A client SHOULD re-send each of them for a
bounded time after sending it (20 s RECOMMENDED, well inside the `ACK_WAIT_SECONDS`
a Sender waits). These re-sends MAY continue after the session has ended and the
burner has been wiped, because they reuse the seal (above). When a session ends,
every other message in the outbox stops being outstanding.

Re-sends of the same rumor do not count as further responders (§13) or further
messages: the recipient sees one rumor.

A relay that refuses a publish as `rate-limited` SHOULD get timed re-sends less often
for a while (backing off from about 10 s to a minute); a new message still goes to it
at once.

If a relay returns `auth-required`, the client authenticates with its **burner**
under NIP-42. Neither side ever uses a long-lived identity for relay
authentication during a transfer.

### 11.6 Size

Measured expansion from raw payload to published event is **×3.4 for base64
payloads and ×4.7 for hex**. The figures below are computed by
`tools/payload_ceiling.py` for the 1.6 message shape (PAYLOAD rumor without tags,
seal, kind 21059 wrap).

| Limit | Where | Max payload (base64) |
|---|---|---|
| `max_content_length` = 8196 | NIP-11's example value | 2 145 B |
| `maxEventSize` = 65536 | strfry's default | 21 345 B |
| `maxWebsocketPayloadSize` = 131072 | strfry's default | 30 561 B |

`max_content_length` caps the `content` field alone, which is where the entire
nested ciphertext sits, and is the origin of the 2048 B default in P1. Note that
8196 is the *example* value printed in NIP-11 rather than a measured default;
strfry's stock configuration sets no content cap, and deployed enforcement is
unmeasured.

The showing party, which alone chooses relays, MUST read `max_message_length` and
`max_content_length` from NIP-11 while choosing them (§11.3a) and skip relays that
cannot carry the declared profile's maximum.

### 11.7 Local network path (optional, non-normative)

Relays are the transport (§11.3). An implementation MAY additionally offer a local
path for two devices on the same network, but it is not part of the conformance
surface and no client is required to implement or interoperate on it.

Where offered: the listening party opens a WebSocket on a random port ≥ 49152 and
advertises `_qrst._tcp` with TXT `npub=<burner npub>`; the other connects and sends
the wrap as a single text frame containing the kind 21059 event JSON. Everything
else — messages, seal, wrap, re-sending, SAS, cleanup — is exactly the relay path,
and the LAN is untrusted in the same way the wrap already assumes. A LAN socket is a
live channel with no storage, so a dropped connection loses whatever was in flight,
and the re-sending of §11.5 applies over it unchanged. Browsers cannot use this
path in either role.

## 12. Pairing without a camera

Wherever a flow says "scan the QR", the scanning party MAY instead obtain the same
URI by one of the substitutions below. Each replaces only the pairing step:
burners, SAS, messages, consent and cleanup are unchanged. The URI carries no
payload material, but whoever holds it can answer it (§11.2).

### 12.1 Copying the URI

The showing party offers its `https` URI (§11.2) as selectable text; the other
party pastes it.

- The URI MUST be validated before use; the bech32 checksum on the burner key
  catches transcription errors.
- A pasted URI never counts as read by the client's own camera, so its nature is
  unestablished and §9's friction fails closed to the web tier (§9.1).
- **Additional friction for URIs that make the local device the Sender.** Where a
  URI would make the local device the Sender (`mode=offer`) and did not come from
  the device's own camera, the client MUST present the release consent of §9 with
  an explicit statement that the request did not originate from a scan, and MUST
  NOT allow that consent to be remembered or defaulted.

For a profile whose secret has a standalone encrypted export (`nostr-nsec` has
NIP-49 `ncryptsec`), two devices that can already pass text gain little from this
path. Copy-paste pairing earns its place for a profile whose payload has no such
form, such as `frost-share`, where the SAS ceremony is the delivery.

**Two camera-less devices** pair this way and nothing else changes: one shows or
copies its `https` URI as text, the other pastes it, and the SAS, gift-wrap and
release ceremony then run over relays exactly as after a scan. Neither device needs
a camera, a shared local network, or a direct link between them — only a relay each
can reach. For a payload with no standalone encrypted export, it is the only
delivery between two camera-less devices.

Sending the URI through a third party is permitted; it leaks the metadata that a
pairing happened and which relays are involved, and it lets the third party answer
it. At `compare` and `type` that gains them a code that does not match; at `none`
it can gain them the payload, so a client SHOULD NOT offer `none` for a URI it
knows will be sent that way.

### 12.2 Channels this specification does not define

A burner key is 32 bytes, so a code-based pairing cannot convey one — it must
bootstrap a channel from a low-entropy shared secret, which requires a
password-authenticated key exchange and a rendezvous that neither party conveys.
That is a different protocol and is not specified here.

An implementation MAY build one. It hands off at a defined point: once both
parties hold the other's burner public key and the parameters of §11.2, Flow A or
Flow B proceeds unchanged from immediately after the scan, and every requirement
of §6 and §9 applies as written. Two clients implementing different bootstrapping
channels will not pair.

### 12.3 Profile URI schemes, and pairing URIs at `none`

**Carrier.** A profile MAY register a custom URI scheme as a second carrier for its
pairing URI (§5), for pasting and deep links, where a token to hand to an app and
tap-to-open matter and there is no host to protect. The QR form stays the `https`
fragment link of §11.2. A URI in a profile's scheme carries the parameters of
§11.2, in the same encoding, with the burner key in place of the host and path and
the rest as the query:

```
<scheme>://<npub>?v=1&mode=<mode>&p=<profile-id>&check=<level>&token=<hex>[&relay=<wss url>]*[&origin=<claimed-origin>]
```

It is validated as §11.2 requires, with one further rule: a URI in a profile's
scheme carries only that profile's identifier, and a client MUST reject one whose
`p` differs. Scheme names, like profile identifiers, are registered nowhere; a
profile chooses one unlikely to collide. A custom scheme is a global string that
any app can claim (§11.2a), so a URI that arrives by tapping one may have been
handed to, or sent from, an app the user did not intend. `frost-share` registers
`frost://`.

**Pairing URIs at `none`.** The token stops a party that never received the URI,
such as a reader of the relays it names. It does **not** stop interception of the
URI itself: whoever obtains it can answer, and at `none` (§9.2) can be released to
before the user's own device answers. A Sender that shows or copies its own URI at
`none` (Flow B) therefore releases to whoever answers it first, and for as long as
that URI is on a screen or a clipboard it is as good as the payload. A profile that
permits `none` SHOULD state over which channels it does, and what an intercepted
payload yields (§5, item 7). Whatever a profile says, a URI that reached the Sender
through a third party, or by a custom-scheme deep link, is not a channel the Sender
controls, and §12.1 already asks a client not to offer `none` for a URI it knows
will be sent through a third party.

**Consent still applies.** The Sender's release consent (§9.1) is still shown and
still fails closed on friction tier, in the profile's words. The Receiver's
acceptance confirmation (§9.4) still shows the P5 rendering and still requires a
tap.

## 13. Multiple responders

A **responder** is a distinct burner whose HELLO (Flow A) or REQUEST (Flow B)
carries the QR's token (§11.2). A contact without it never saw the code: it is
ignored, gets no nonce exchange, and is not counted here. Neither is the same
message delivered by more than one route, a retransmission from the same burner, a
message that fails to decrypt or to verify, or a message discarded by the
session-window test of §11.4.

**Every responder gets one nonce exchange, ever, and the cap is over the whole
session** (§6): at most three responders for a Receiver that showed the QR, five
for a Sender. A burner that has been dropped, or that sent ABORT, cannot contact
again; a slot is never handed out twice. Further responders are turned away and
counted, and the notice below is shown.

If, within the same session, a **second or later responder** arrives, the client:

- holds it as a further candidate, within the cap;
- shows a notice on the device that displayed the QR:

  > Another device also answered this code. If that wasn't you, someone nearby
  > may have scanned it. Nothing was shared with them.

  A Sender MUST show it beside the release controls whenever it is choosing between
  candidates (§9.2). Who else answered is something the user should know, not
  something resolved out of their sight;
- records the multiple-responder flag in the transfer record (§14).

A responder that arrives after a candidate has been chosen — the payload released,
or held for acceptance — takes no part, but is still reported and flagged.

**At `compare` and `type`, no responder can end the session for the device that
showed the QR** — not a later one, and not the first, by ABORT, by a payload the
user declines, or otherwise.
Seeing the QR is not evidence of an attack, and ending the session would let anyone
who photographed the code deny every transfer with a single message. A candidate
that sends ABORT is dropped; the session continues with the others, or returns to
waiting. (A stranger can still use up the cap; that is inherent in having one.)

**Where a pairing was agreed at `none`, a second responder ends the session.** With
no code, nothing can tell two responders apart. A showing party ends the session
when a second responder answers and either of the two was agreed at `none` (§9.2), sends ABORT with `reason=second-responder` to every
party it has heard from, and tells its user why; a contacting party that receives
that ABORT tells its user the same. A responder that arrives after the payload has
been released cannot be stopped, but is still reported.

**The code decides which candidate is real, and the display is lazy.** The
**active candidate** is the earliest responder that has completed the nonce
exchange; one that stalls does not hold up the others. A Receiver that showed the
QR shows the active candidate's code alone. It cannot learn that the Sender
rejected it — the Sender transmits neither the code nor the result (§9.2) — so the
user tells it: the Receiver offers "the other device rejected this code; show the
next one", and advances to the next held candidate when asked. The Receiver commits
only the candidate whose code is on screen (§9.4). A candidate that fails its P4
check (§4) at acceptance is discarded and the client advances to the next held
candidate, or aborts if none remain.

## 14. Policy

- Any party holding a secret MAY act as Sender, subject to profile restrictions
  (§5).
- A party that received a secret by transfer defaults to **receive-only**. The
  toggle is one action, unguarded, and the transfer screen shows it inline ("This
  device is receive-only — allow sending?") rather than hiding it.
- **Enabling sending MUST expire.** It authorises the transfer at hand, or a
  bounded period the user is shown, and then reverts. It MUST NOT be a permanent
  setting.
- Every transfer that moved a secret MUST write a local record: timestamp,
  profile, transport, the code this device computed for the peer it completed
  with, that peer's burner, the check level, and the multiple-responder flag. A
  Sender writes it from the moment of release, whatever happens afterwards; a
  Receiver writes it when it commits. A code that was obtained and did not match is
  never recorded (§9.2).
- This mechanism has no remote revocation of its own. A device list, if shown,
  MUST label removal as deleting the local copy only, unless the control performs
  a revocation the profile's own system provides and reports that it succeeded.

## 15. Security properties and residual risks

- The transport never sees plaintext payload material.
- At `compare` and `type`, a photographed or substituted QR yields nothing on its
  own: it carries a public key and a token; the SAS is commit-then-reveal, so an
  attacker in the middle cannot grind a match beyond the §6 bound; the Sender
  releases only after the code is checked locally; and the Receiver accepts only
  the candidate whose code is on its screen, after the user confirms the P5
  rendering.
- **The token keeps out anyone who did not see the QR.** The burner key is
  visible to the relays the QR names, and to anyone reading them; the token is
  not, so a contact from them is ignored.
- **`compare` is only as good as the user's glance.** A stranger's code is random,
  so a glance at a few digits catches it, and the Sender says when more than one
  device answered. A user who confirms without looking is not protected; `type`
  exists for that.
- **`none` gives the payload to whoever answers first and is released to.** A
  second responder stops the session and both are told, but a party who sees the
  QR, answers before the user's device, and is released to before the user's
  device answers, receives the payload. The level is for what can be revoked or is
  inert until admitted, over a channel the Sender controls (§12.3).
- **A hostile party acting as Receiver is not stopped by the SAS.** Such a party
  holds a real burner, receives the real messages, and displays a matching code.
  It is stopped only by a user declining the release prompt of §9. This is the
  mechanism's principal residual risk. Implementations MUST document it and MUST
  NOT describe the SAS as protecting against it.
- **A Receiver may be hostile conditionally.** A web origin serves whatever code
  it chooses to whichever visitor it chooses, so a site's good standing carries no
  information about how it will behave toward one particular user. The structural
  answer is not to give such a party a usable secret: a profile whose payload is a
  threshold share rather than a whole key converts permanent silent theft into
  bounded, revocable use. The loss is not repairable after the fact — splitting a
  key does not change it — so such protections must be in place before the first
  release.
- **Pairing by copied URI widens the delivery channel for that risk**, since a URI
  can be sent in a message while a QR must be placed in front of the user. §12.1
  requires extra friction on the direction where this matters.
- **A payload at `none` (§12.3)** does not survive interception of the URI
  itself, and a Sender that shows or copies its own URI at `none` releases to
  whoever answers it first. What that costs is the profile's to state; for a
  threshold share, an intercepted share plus enough others is the key, which no
  later revocation undoes.
- **An operator sees both halves of a session.** T4 covers unlinkability to
  long-lived identity only. A relay carrying both parties observes a subscription
  for one burner and wraps addressed to the other, seconds apart, and can pair
  them. Nothing in this specification prevents that; the burners it links are
  ephemeral and carry no identity.
- Burners are per-session and destroyed, so a session cannot be linked to a
  long-lived identity by the transport — provided the same infrastructure is not
  also carrying that identity's other traffic in a correlatable way.
- P2's single-message rule keeps a transfer indistinguishable from ordinary
  encrypted traffic; a burst of sequenced messages between two keys that have
  never spoken before is not. Re-sending (§11.5) makes the burst denser: a relay
  sees a fresh wrap to the same `p` tag every few seconds while a message is
  outstanding. The wraps are unlinkable to one another except by recipient and
  timing, which a relay could already pair.
- Availability comes from the interchangeability of operators, not from any one of
  them. This is deployment advice, not a conformance requirement.
- **The offline tier (§10) forfeits every transport property**; its security is the
  passphrase and the physical proximity of the two screens. It is meant for a
  profile with no standalone encrypted export of its own (such as `frost-share`), and it
  refuses a raw payload precisely because a bare secret pasted or shown persists
  where a passphrase-sealed one does not.
- A compromised device yields whatever that device holds.

## Appendix A — References

NIP-11, NIP-40, NIP-42, NIP-44, NIP-49, NIP-59. BIP-340. ZRTP (RFC 6189), the
source of the commit-then-reveal construction of §6, by way of Matrix.
The profiles published with this specification are in [`profiles/`](profiles/README.md).

## Status

Version 1.6-draft. 1.6 moves the wrap to kind 21059, the ephemeral gift wrap of
NIP-59 §4 (§11.4), so that T8 no longer rests on NIP-40 alone: measured on
2026-10-11, relays kept kind 1059 wraps well after their `expiration`, so every
message of a session, PAYLOAD included, stayed on public relays for as long as each
operator chose. Ephemeral delivery reaches only subscriptions open at that moment,
so 1.6 also replaces the replay-on-reconnect outbox with re-sending until answered,
each re-send a fresh wrap of the same seal (§11.5); §11.3a's loopback test, §11.7
and §15 follow. A 1.5 client publishes and subscribes to 1059 and cannot pair with
a 1.6 client; the QR's `v` is unchanged, since the kinds were already provisional
and no interoperability was promised before a NIP.

1.5 was the first revision written against a running implementation, and folded in
what building it found:

- **Three check levels** (§9.2): `type` as before, `compare`, and `none`, agreed
  per pairing as the stricter of the two parties' settings, with a profile minimum
  (§5). The 1.4 light flow, a returned secret in place of the code for `frost-share`, is now the `none` level.
- **A token in every QR** (§11.2), echoed in the first message (§11.4), because the
  burner key is visible on the relays the QR names.
- **The per-session bound of §6 corrected.** 1.4 said a party in the middle gets
  one attempt per session; the contacting party learns the code before revealing,
  so it gets as many as the showing party admits. Each burner now gets one nonce
  exchange ever, the caps of §13 count over the whole session, and §6 states the
  real bound.
- **§13 restated**: what counts as a responder, that no responder's ABORT ends a
  session for the device that showed the QR, that the user advances the Receiver's
  display, and the `none` exception.
- **§11.3a, choosing the relays**: a relay is named only after a loopback test.
- Clarifications from the implementation: what the Sender compares a typed code
  against in Flow B (§8, §9.2); that declining ends the session (§8); what the
  Receiver commits (§9.4); failed sessions and burners (§9.3); that all three
  timestamps are true time and whose session start the window is measured from
  (§11.4); that only the showing party reads NIP-11 (§11.6); deduplication after
  signature verification and untrusted relay text (§11.5); frames (§11.2a); and that
  the record holds the code of completed transfers only (§14).

1.4 restored the offline tier (§10) as a profile-gated, passphrase-encrypted
fallback, and stopped assuming every payload is irrevocable; 1.3 added the
`frost://` scheme.

On 2026-10-17 this document moved from
[sybenx/nostr-key-management](https://github.com/sybenx/nostr-key-management) to
this repository, beside its reference implementation, and the two profiles it had
relied on that repository for moved into [`profiles/`](profiles/README.md). The
core protocol's messages did not change, and 1.6 clients before and after the move
pair. The text changed as follows:

- §5 points to `profiles/`, and lets a profile register a URI scheme (§12.3),
  require a platform credential before release (§9.1 already referred to one), and
  set a lowest check level that depends on how the pairing URI reached the Sender.
- §10, §11.3, §12.1 and §15 cite profiles only as examples.
- §11.2 allows a profile's own scheme; §12.3 defines it for any profile, with one
  new rule: a URI in a profile's scheme MUST carry that profile's identifier.
  `frost://` moves to `frost-share` unchanged. The rule that a share at `none`
  needs a channel the Sender controls moves to `frost-share` too, and is tightened
  there. The core now says that a profile permitting `none` SHOULD state over which
  channels, which channels never count as controlled, and that a Sender's own URI
  at `none` is as good as the payload.
- P1 says how a payload is measured. Its figure for a 32-byte secret (1.7 KB, not
  1.9) and the §11.6 table are recomputed for the 1.6 message shape.
- §12.3 no longer says `nostr-nsec` permits `compare`: the profile's own minimum is
  `type`, and the profile governs.

The profiles changed as they moved, and each file's History says how. One change is
incompatible: `frost-share` now carries FROSTR's own credential pair (`bfshare1…`
and `bfgroup1…`) in place of the share format of the old storage specification's
9.2, under the same identifier. No implementation of the 9.2 format is known.

Two things are still open: the event kinds of §11.4 are provisional — chosen from
the ephemeral range and verified non-conflicting (2026-09-02), but not yet reserved
by a NIP — and the test vectors are incomplete. The SAS of §6 is covered in
`vectors/`, and `vectors/frost-share-max.json` covers the `frost-share` profile at
the largest payload it can produce under the default maximum (2041 of 2048 bytes);
a vector at exactly 2048 bytes, which P1 requires, is not yet published.
The caps of §13 set the per-session bound of §6; lowering them, or having the
showing party commit first so that neither side learns the code early, would
tighten it, and is open.

The reference implementation of 1.6 is in this repository (`src/`), with a live
demo at <https://sybenx.github.io/qr-secret-transfer/>. It has not been audited,
and neither has this document. Review is more useful than deployment at this stage.
Report anything this document or a profile gets wrong, or that can be read two
ways, as an
[issue](https://github.com/sybenx/qr-secret-transfer/issues/new?template=spec-issue.yml). [SPEC_ISSUES.md](SPEC_ISSUES.md) records what has been resolved.
