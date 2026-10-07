# QR Secret Transfer (QRST)

Move a secret from one device to another by scanning a QR code. One device shows a
code, the other scans it, a person checks five digits across the two screens, and
only then does the secret travel, sealed, over public relays that neither device runs
and that cannot read it.

**Live demo: <https://sybenx.github.io/qr-secret-transfer/>** ·
[Specification](https://github.com/sybenx/nostr-key-management/blob/main/QR_SECRET_TRANSFER.md)

This repository is two things:

- **A live demo and landing page** (`docs/`, built from `src/demo/`). It moves a short
  piece of text between two devices. It is a static page: no server of its own, no
  analytics, nothing loaded from anywhere else, and no network activity until a
  transfer is started.
- **A protocol core** (`src/core/`) with no I/O, no DOM and no timers, plus the browser
  adapters that run it over relays (`src/web/`).

**Status: a draft protocol and unaudited code.** Use made-up values, not real secrets.
The event kinds are provisional and interoperability is not promised.

## Try it

```sh
npm install
npm run build        # writes docs/
npm run relay        # a local relay on ws://localhost:7777
npm run serve        # the page on http://localhost:8080
```

Open the page in two browser windows (or on two devices that can both reach the
relay). In each, open **This device: relays and past transfers** and add
`ws://localhost:7777`. Then choose **Receive a secret** in one and **Send a secret** in
the other.

On the public internet no setup is needed: the page finds relays itself (see
[Relays](#relays)).

## Put it online

`docs/` is the whole site. On GitHub: **Settings → Pages → Deploy from a branch →
`main` / `docs`**. Any static host works; the page uses only relative paths, so it can
live at a domain root or under a path. This repository's copy is live at
<https://sybenx.github.io/qr-secret-transfer/>.

The page is its own bounce page (spec §11.2a): the QR codes it shows point back at
whatever address it is served from, with every parameter in the fragment, so nothing
about a pairing ever reaches the host.

Three `<meta>` tags in `src/demo/index.html` are the configuration:

| Tag | Meaning |
|---|---|
| `qrst:relays` | Relays you supply, tried first. `content="wss://relay.example.com"` |
| `qrst:seeds` | Replaces the starting relays this build ships. `content="none"` ships none. |
| `qrst:discovery` | Relays to ask for NIP-66 discovery events. `content="none"` asks nobody extra. |

Before publishing, set a canonical URL and the three GitHub links in
`src/demo/index.html` to wherever the specification and this repository end up.

## What it implements

The wire protocol of `QR_SECRET_TRANSFER.md` 1.4-draft:

- the commit-then-reveal exchange and five-digit code of §6, reproducing the
  specification's own vectors (`vectors/qrst-sas.json`);
- Flow A and Flow B (§7, §8), with the roles never inferred from who showed the code;
- sealing and gift-wrapping (§11.4) over NIP-44 v2, with true timestamps and the
  attribution check, checked against the official NIP-44 vectors and against
  `nostr-tools` in both directions;
- the pairing link (§11.2), the bounce page (§11.2a), and how a code is presented
  (§11.2b);
- the release prompt, the code entry and the restart throttle (§9), as far as code can
  enforce them, and the acceptance confirmation;
- multiple responders (§13) and the local transfer record (§14);
- relay subscription, the session outbox, and NIP-42 with the burner (§11.5).

It goes beyond the specification in one place, on purpose: **three levels of check**
instead of one. The 1.4-draft allows only typing the code (§9.2). This implementation
also offers comparing it and no code at all, chosen on each device with a slider; the
stricter of the two devices' settings applies.

| Level | Sender | Receiver | For |
|---|---|---|---|
| Type a code | types the digits shown on the Receiver | shows five digits | what cannot be taken back |
| Compare a code (default) | shows five digits, the user confirms they match | shows five digits | most things |
| No code | consent only; a second responder ends the session | shows nothing | what can be revoked |

Every pairing link also carries a one-time token that a responder must echo inside its
first sealed message, so that only a device that saw the code can answer it. See
`SPEC_NOTES.md`, "Three levels of check", for the reasoning and the exact rules.

It also implements the relay selection drafted as §11.3a of the unpublished
standalone 1.5-draft, because the demo has to choose relays somehow and that draft
is the stated intent: see [Relays](#relays).

Not implemented: the offline tier (§10), the local network path (§11.7, which a
browser cannot do), the light flow (§12.3), and reading the code by camera (§9.2
"capture").

`SPEC_NOTES.md` lists every place the specification could be read two ways while
writing this, and which reading was taken.

## Relays

No relay is depended on. Before a device shows a code it sends itself a sealed
message, padded to the largest payload the profile allows, through each candidate
relay. A relay is named in the code only if that message comes back. That test is
exactly what a session needs: the relay accepts a gift wrap from a key it has never
seen, serves it to a subscriber it has never seen, and carries a payload of that size.

Candidates are tried in this order: relays you or the page configured; relays that
passed on this device before; relays named by a code this device scanned in a session
that completed; relays that NIP-66 monitors report; and last, a short list of seeds
shipped in `src/demo/config.ts`. A seed is where a device with nothing else starts.
After the first successful session a device prefers what it remembers, and tops that
memory up from discovery in the background about once a day.

## Layout

```
src/core/     pure protocol: no I/O, injected randomness and clock
  sas.ts        the commitment and the five digits (§6)
  nip44.ts      NIP-44 v2
  event.ts      Nostr events, BIP-340, npub
  wrap.ts       seal and gift wrap, and the attribution check (§11.4)
  uri.ts        the pairing link (§11.2)
  profile.ts    the profile interface (§5) and the demo's text profile
  session.ts    the state machine: flows, consent rules, responders (§7, §8, §9, §13)
src/web/      browser adapters
  pool.ts       relay links, outbox, NIP-42, the loopback test (§11.5)
  select.ts     relay selection, NIP-11 limits, NIP-66 discovery
  store.ts      what a device remembers: relays, throttle, transfer log
  transfer.ts   one transfer end to end, headless
src/demo/     the page
tools/        a local relay with fault injection, a static server
test/         unit, integration and browser tests
vectors/      the specification's §6 vectors
docs/         the built site
```

`src/core` depends on `@noble/curves`, `@noble/hashes`, `@noble/ciphers` and
`@scure/base`, and nothing else. The page adds `qr` for drawing and reading codes.
`nostr-tools` is a development dependency, used only as a second implementation to
test against.

A session is driven by handing it events and user decisions; it answers with effects
for the host to carry out (publish this, keep that, write this record). Nothing in it
touches a socket or a clock, which is why a whole flow replays byte for byte in a test.

## Tests

```sh
npm run check        # typecheck, unit and integration tests, build, browser tests
```

- **Core** (`test/*.test.ts`): the §6 vectors including the transposed-roles negative;
  the official NIP-44 vectors; gift wraps against `nostr-tools`; both flows as state
  machines, wrong codes, the attempt budget, expiry, multiple responders, planted
  payloads, the throttle, burners wiped at the end.
- **Relays** (`test/relays.test.ts`, `test/transfer.test.ts`): real WebSockets against
  a local relay that can refuse writes, swallow events, demand authentication, serve
  wraps only to their recipient, advertise limits, answer late, or drop every
  connection mid-session.
- **Browser** (`test/e2e`): two browser contexts as two devices, through both flows;
  the page's own camera reading a code from a fake video feed; the release prompt's
  rules; relay selection on screen; and that the page asks nothing of the network
  until a transfer starts.

Two independent reviews of the code against the specification were run before this
was handed over, one of the core and one of the page. They found one serious fault
(the pairing code could be ground: see the first entry of `SPEC_NOTES.md`) and about
twenty smaller ones. All are fixed and have regression tests, except those listed in
`SPEC_NOTES.md` as open readings.

### What has not been tested

- **Public relays.** The environment this was built in has no route to them. Everything
  above ran against local relays. Whether the shipped seeds accept a 7 KB gift wrap
  from an unknown key, today, is unverified; the loopback test exists so that the
  answer cannot silently be wrong, but the first thing to do with this page is to
  open it on two real devices.
- **Real cameras, and browsers other than Chromium.** The scanner was exercised with a
  synthetic video feed in headless Chromium.
- **Anything like an audit.**

## Licence

MIT. The specification itself is CC0. The bundled libraries are MIT and the fonts are
under the SIL Open Font License; their notices ship in `docs/`.
