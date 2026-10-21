# Specification Issues

**To report something, [open an issue](https://github.com/sybenx/qr-secret-transfer/issues/new?template=spec-issue.yml).** The form asks for the same
fields as the format below. This file is the permanent record of every settled
issue, with how it was resolved.

This file records disagreements with [QR_SECRET_TRANSFER.md](QR_SECRET_TRANSFER.md)
and the profiles in [`profiles/`](profiles/README.md). It exists because the
alternative is worse: an implementer who finds a passage ambiguous, or believes
a requirement is wrong, will otherwise resolve it privately and ship a client
that differs from every other client in a way nobody can see. A deviation
written down here is reviewable; a deviation made in silence is only
discoverable when two implementations fail to interoperate in the field.

Until 2026-10-17 the specification lived in
[sybenx/nostr-key-management](https://github.com/sybenx/nostr-key-management),
and so did this file. The entries below that concern QRST came with it; the rest
stayed there with the documents they concern.

Two kinds of entry belong here.

An **ambiguity** is a passage that admits more than one reading, where both
readings produce working code but the two do not interoperate, or where the
specification simply does not say what to do in a case that will occur. Say
which readings you found and which one you took.

A **suspected error** is a requirement you believe is wrong: a construction
that does not achieve what the surrounding text claims for it, a parameter that
does not match its stated cost, an invariant that some other section breaks, or
a flow that cannot be completed as written. Say what breaks and under what
conditions.

Design disagreements — cases where the specification is clear and internally
consistent and you would have chosen differently — are welcome too, but say so
explicitly, because several of the defaults that look weak were chosen
deliberately after review and are argued for in the document itself. An entry
that engages with the stated argument is useful; one that does not will
probably be answered by a pointer back to it.

## Format

The issue form asks for these fields. When an issue is settled, it is recorded
here under its own heading, newest at the bottom, in this shape, with a link to
the issue:

```
### <short title>

**Document:** QR_SECRET_TRANSFER.md | profiles/<profile>.md
**Section:** §<number> (and any others it touches)
**Kind:** ambiguity | suspected error | design disagreement

<What the specification says, quoted or cited closely enough that a reader can
find it without searching.>

<What is wrong or unclear about it, and the concrete circumstances under which
it matters.>

**Proposed fix:** <the change you would make, in the specification's own
normative language where you can manage it. "This should be clarified" is not a
proposed fix; "§4 step 13 should say the Joiner discards wraps whose seal
signer is not among the burners it issued a nonce to" is.>
```

Every entry needs a section number and a proposed fix. Both are what make an
entry actionable rather than a note that something felt off.

Issues concerning the two gaps already named in the specification's Status — the
placeholder event kinds and the incomplete test vectors — do not need to be
filed here. They are known and tracked.

---

## Open

Open reports are [GitHub issues](https://github.com/sybenx/qr-secret-transfer/issues?q=is%3Aissue+is%3Aopen+label%3Aspec)
labelled `spec`.

## Resolved

### A failed probe can leave a browser Holder with no transport at all

Resolved in [QR_SECRET_TRANSFER.md](QR_SECRET_TRANSFER.md) §11.3, which makes the
probe advisory rather than selective for a client with only one transport
available in its current role. The section it was filed against
(`NOSTR_KEY_MANAGEMENT.md` §3.1) no longer exists.

The entries from here to the end were found while building the reference
implementation in this repository, and are resolved in QR_SECRET_TRANSFER.md
1.5-draft.

### The contacting party gets more than one code per session

**Document:** QR_SECRET_TRANSFER.md · **Section:** §6, §13 · **Kind:** suspected error

1.4 §6 said a party in the middle "gets one attempt per session". The contacting
party learns the other's nonce before revealing its own, so it knows the code
first, and can walk away and contact again from a fresh burner. With §13's caps it
got three or five codes per session; with a cap counted on candidates *currently
held*, unlimited. The implementation's first version did exactly that, and review
demonstrated a hundred codes from one burner in one session.

Resolved in §6 and §13: one nonce exchange per burner, ever; caps count every
contact over the session; §6 states the bound as the cap over 100 000. Lowering the
caps, or having the showing party commit first, is left open in Status.

### The burner key is not secret, so anyone reading a relay can respond

**Document:** QR_SECRET_TRANSFER.md · **Section:** §11.2, §11.3a, §13 · **Kind:** suspected error

The showing party publishes and subscribes with its burner key on the relays its
QR names, so a reader of those relays can contact the session without seeing the
QR. At `type` that only uses up §13's cap; at a level with no code it would win the
payload.

Resolved in §11.2 and §11.4: every QR carries a one-time `token`, echoed inside the
first sealed message; a contact without it is not a responder.

### One check level for every payload

**Document:** QR_SECRET_TRANSFER.md · **Section:** §9.2, §12.3 · **Kind:** design disagreement

1.4 allowed only a typed or captured code, plus the light flow for one profile.
How much checking a transfer deserves depends on what is moving.

Resolved in §9.2: `none`, `compare` and `type`, agreed per pairing as the stricter
of the two parties' settings, with a profile minimum (§5). The light flow is now
the `none` level.

### What ends a session when a candidate sends ABORT

**Document:** QR_SECRET_TRANSFER.md · **Section:** §13 · **Kind:** suspected error

§13 forbade a *later* responder from aborting the session, for fear of denial by
one forged message. The same holds for the first: a stranger who answers first and
then sends ABORT denied the session just as well.

The same held for a Receiver that showed the QR and declined a payload: §7 step 17
said "discard all, abort", so a stranger who answered first and sent something
ended the session by being declined.

Resolved in §7 and §13: at `compare` and `type` no responder ends the session for
the device that showed the QR, by ABORT or by a declined payload; the Receiver
drops that candidate and moves on.

### Flow B: what a typed code is compared against, and what declining does

**Document:** QR_SECRET_TRANSFER.md · **Section:** §8, §9.2 · **Kind:** ambiguity

"Works one candidate at a time" and "a value matching none of its held candidates
advances" admitted comparing with the active candidate only, or with all of them.

Resolved in §8 and §9.2: at `type`, compare with every ready candidate; exactly one
match releases, more than one is a miss. Declining ends the session.

### Flow A: who advances the Receiver's display, and which payload it may keep

**Document:** QR_SECRET_TRANSFER.md · **Section:** §7 steps 12 and 16, §9.4, §13 · **Kind:** ambiguity

The miss happens on the Sender, which transmits neither the code nor the result, so
the Receiver cannot know to advance or which candidate "the Sender confirmed".

Resolved in §9.4 and §13: the user tells the Receiver to show the next code; the
Receiver keeps only a payload from the candidate whose code is on screen, and drops
one from a candidate whose code was never shown.

### Smaller readings

**Document:** QR_SECRET_TRANSFER.md · **Section:** various · **Kind:** ambiguity

Resolved in 1.5: §9.2 against §14 on storing the code (completed transfers only);
§9.3's failed session and failed burner; §11.4's timestamps (all three true) and
window start (each party's own); §11.2's relay encoding and count; §11.6 (only the
showing party reads NIP-11); §11.5's dedupe (after signature verification) and
relay text (untrusted, bounded); §11.2a framing; §11.4's clock warning (only where
a client can tell).

---

The entries below were found while moving the specification to this repository
on 2026-10-17, and by an independent review of the move.

### §12.3 and `nostr-nsec` disagreed on the lowest check level

**Document:** QR_SECRET_TRANSFER.md, profiles/nostr-nsec.md · **Section:** §12.3, §5 item 7 · **Kind:** suspected error

QRST §12.3 said `nostr-nsec` "uses `compare` or `type`". The profile, then
`NOSTR_KEY_MANAGEMENT.md` §3.1, said its lowest level is `type`.

Resolved: the core no longer describes particular profiles. The profile states
`type`, and a profile governs its own minimum (§5, item 7).

### A share at `none` was permitted where the Sender copies its own pairing URI

**Document:** profiles/frost-share.md, QR_SECRET_TRANSFER.md · **Section:** §12.3, §5 item 7 · **Kind:** suspected error

`frost-share` permitted `none` over "a local same-user paste", justified by the
share being inert until admitted. Under FROSTR a share is a working member
credential and, with enough others, the key. And a Sender that copies its own URI
(Flow B) at `none` releases to whoever answers first, so the URI is a bearer token
for the share wherever the clipboard goes: history, sync, other apps.

Resolved: `frost-share` permits `none` only where the Sender is the contacting
party and obtained the Receiver's URI itself. §5 item 7 lets a profile's minimum
depend on how the URI reached the Sender, and §12.3 says which channels never count
as controlled (a third party, a custom-scheme deep link) and that a Sender's own
URI at `none` is as good as the payload.

### `frost-share` changed its payload under the same identifier

**Document:** profiles/frost-share.md · **Section:** §5 item 1 · **Kind:** design disagreement

The published 9.2 `frost-share` carried a share of a scheme the old storage
specification defined for itself. The profile now carries FROSTR's `bfshare1…` and
`bfgroup1…` pair, which is what a FROSTR client can use, under the same identifier.

Resolved as a note: no implementation of the 9.2 format is known, so the
identifier is kept and the change is recorded in the profile's History. If one
turns up, a new identifier is the fix.

### "Private-network address" was undefined

**Document:** QR_SECRET_TRANSFER.md · **Section:** §11.3a · **Kind:** ambiguity · [#8](https://github.com/sybenx/qr-secret-transfer/issues/8)

§11.3a forbids taking a private-network address from a NIP-66 report, or carrying
one learned from a pairing link into later sessions, without saying what one is.
The obvious reading, and the reference implementation, covered RFC 1918, loopback
and link-local, and missed the shared space `100.64/10` that carrier-grade NAT and
Tailscale use, and names such as `.home.arpa` that resolve only on a private
network. A tailnet relay could be learned from a report and remembered.

Resolved: §11.3a defines the term, adding `100.64/10`, `.home.arpa` and IPv4-mapped
IPv6 addresses, and lets a client treat an overlay network's domain, such as
`*.ts.net`, as private. `isPrivateHost` matches.

### No guidance for a payload that is a ticket redeemed with a server

**Document:** QR_SECRET_TRANSFER.md, profiles/README.md · **Section:** §5, §4 P4 and P6, §9.2 · **Kind:** ambiguity · [#5](https://github.com/sybenx/qr-secret-transfer/issues/5)

The only template, `example-sync-key`, moves the secret itself. An app with a
server of its own should instead move a single-use ticket that the Receiver
redeems for access of its own. Nothing said three things that shape doesn't make
obvious: that P4 must pin the redeeming server to the Receiver's own configuration,
or the Sender chooses where the device enrols; that P6 then rests on the ticket
lapsing, so the Receiver must redeem only what it commits; and which check level a
ticket deserves, since it is revocable only after a stranger has redeemed it.

Resolved: §5.2 states what a profile carrying a ticket adds: single use, a
lifetime of at most 15 minutes recommended, redeeming only after commit, the P4
server check, `compare` and above, and a prompt that doesn't present the lifetime
as limiting the access. `profiles/example-pairing-ticket.md` is a template in that
shape, and `profiles/README.md` says which example to start from.

### Installed web apps can't claim `<host>`, and fragments can collide

**Document:** QR_SECRET_TRANSFER.md · **Section:** §11.2a, §12.1 · **Kind:** ambiguity · [#6](https://github.com/sybenx/qr-secret-transfer/issues/6)

§11.2a said `https` "costs nothing in reach", assuming the app claims `<host>`
through App Links or Universal Links. A web client installed to a home screen
often can't, so a generic-camera scan lands in a browser tab, where the client may
or may not share storage with the installed app. The section also didn't say to
keep a pairing URI's fragment apart from fragment parameters the app reads itself.

Resolved: the claim is limited to apps that can claim `<host>`. A client that
can't MAY act as the party in the tab, SHOULD say before pairing where the payload
will be kept when it can't confirm the tab shares storage with the installed app,
and gets §9.1's maximum friction. The bounce page SHOULD have a path of its own,
and a client MUST NOT confuse the two kinds of fragment.

### The receive-only default, when the Sender issues a fresh payload

**Document:** QR_SECRET_TRANSFER.md · **Section:** §14, §5.2 · **Kind:** ambiguity · [#7](https://github.com/sybenx/qr-secret-transfer/issues/7)

§14 made "a party that received a secret by transfer" receive-only by default.
For a profile whose Sender issues something fresh each time, such as a ticket
(§5.2), there were two readings. In one, a device enrolled by transfer needs the
expiring toggle to issue a ticket, so access spreads one deliberate step at a time.
In the other, the device never received anything it could pass on, so issuing is
unrestricted.

Resolved: the default covers a party that obtained its access by transfer,
whatever it would send. A profile whose payload is issued fresh for each transfer
MAY waive it, and must say so (§5.2, item 7). The record §14 requires covers every
payload moved, not only secrets.
