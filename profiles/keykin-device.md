# Profile `keykin-device`

A profile for [QR_SECRET_TRANSFER.md](../QR_SECRET_TRANSFER.md) §5, for **adding a device to a
[Keykin](https://github.com/sybenx/keykin) account with one code**. Keykin is a Nostr signer
where an account is either one whole key on a phone, or pieces held by several devices and a
box, any two of which sign.

The new device shows one code. A device already in the account scans it and decides what the
newcomer gets, because only it knows how the account is set up. The new device never has to
choose between "receive my key" and "join my box".

Key words MUST, MUST NOT, SHOULD, MAY are normative.

---

## The idea

1. The new device shows a code (Flow A, `mode=offer`: the new device is the Receiver). Next to
   the usual parameters of §11.2 it carries one more, `invite`: the device's Keykin invite
   (Keykin SPEC 8b), its member key, its name and its chip key.
2. A device in the account (the Sender) scans it, asks **"Add *name*?"**, and on Add:
   - **The account has a box:** it adds the newcomer to the account (Keykin SPEC 7), so the box
     and the Sender each hold half of the newcomer's piece, and releases the account's **join
     text**. The newcomer then collects its piece from the box itself.
   - **The account has no box** (the whole key lives on the Sender): it releases the **whole
     key**.
3. The newcomer keeps what arrives and is signed in.

The rule is the Sender's, not the person's: a box means a piece, no box means the whole key. A
piece needs the box, because adding a member uses the box as one of its two helpers.

## Requirements of QRST §5

| QRST §5 item | This profile |
|---|---|
| 1. Payload encoding | Standard padded base64 of UTF-8 JSON, one of two objects. **Join:** `{"keykin":2,"join":{"addr":"<box address>","boxKey":"<hex>","npub":"<hex>","loginPage":"<origin>"}}`, Keykin's join text exactly (`loginPage` optional). **Whole key:** `{"keykin":2,"nsec":"<64 lowercase hex>"}`. |
| 2. Maximum size | The default (2048 bytes). |
| 3. P4 check | Decodes as above with exactly those members. Join: `addr` an `http(s)` URL with no user, password or fragment; `boxKey` 64 lowercase hex; `npub` 64 lowercase hex and a valid x-only key; `loginPage`, when present, a bare `https` origin (`http` only for `localhost` and `127.0.0.1`). Whole key: a scalar in range. |
| 4. P5 rendering | "Your account *short npub*". |
| 5. Sender's prompt | **"Add *name*?"** with **Add** and **Not now**. See "Departures" below. |
| 6. Additional tags | None in messages. The pairing URI carries one extra parameter, `invite`, below. |
| 7. Lowest check level | `none`, **only** when the Sender read the `https` code with its own camera, inside the app. `compare` for everything else: a pasted link, the `https` code opened as a link (an App Link proves which app opens it, not who wrote the link), the `qrst:` handoff and any custom scheme. |
| 8. Offline tier | Not permitted. |

## The `invite` parameter

`invite=<base64url, no padding, of the invite's JSON text>`, appended to the fragment of the
pairing URI (QRST §11.2 ignores parameters it does not know). The invite is Keykin's:

```json
{"keykin":2,"invite":{"key":"<64 hex member key>","name":"Galaxy Tab","chip":"<compressed P-256 key, hex>"}}
```

`key` is required and must be a valid x-only key. `name` is cut to 60 characters ("A new
device" when missing). `chip`, when present, is `02` or `03` and 64 hex. A URI with no
`invite`, two of them, or a bad one is refused before anything is added. The invite is not
secret, and it is not covered by the code of §6: it is as trustworthy as the way the code
reached the Sender, which is what item 7 is for.

The QR is the `https` form. Keykin's apps use `https://marble.syb.lol/add#…`, an App Link to the
Marble app.

## Departures from QRST §9

Aaron's decision (2026-11-19): adding a device shows no explanations and no warnings.

- **The Sender's prompt** is "Add *name*?" with Add and Not now. It does not use a heading that
  contradicts a login, and it does not say that a whole key cannot be taken back. Add is still a
  deliberate action, and the Sender asks for the fingerprint before anything moves.
- **The Receiver keeps what arrives without a second tap** (QRST §9.4). The person started it by
  pressing Sign in on that device. What §9.4 guards against, someone who photographed the code
  answering first and planting their own account, shows up as the new device being signed in to
  an account that is not theirs; the device shows whose account it signed in to.
- `none` is permitted for a payload that may be a whole key, which §5 item 7 advises against.
  It is limited to the Sender's own camera, as in `frost-share`.

## Test vectors

[`vectors/keykin-device.json`](../vectors/keykin-device.json): both payloads, their P5
renderings, a pairing URI with its invite, and payloads P4 must refuse.
