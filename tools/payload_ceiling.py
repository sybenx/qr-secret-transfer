import json, math

def calc_padded_len(n):
    # NIP-44 v2 padding
    if n <= 32: return 32
    nextpower = 1 << (int(math.floor(math.log2(n - 1))) + 1)
    chunk = 32 if nextpower <= 256 else nextpower // 8
    return chunk * (int(math.floor((n - 1) / chunk)) + 1)

def nip44_ct_len(plaintext_len):
    """base64 length of a NIP-44 v2 ciphertext for a given plaintext length."""
    if plaintext_len < 1 or plaintext_len > 65535: return None
    padded = calc_padded_len(plaintext_len)
    raw = 1 + 32 + (2 + padded) + 32     # version + nonce + padded plaintext + MAC
    return 4 * math.ceil(raw / 3)

HEX64 = "a" * 64
SIG   = "a" * 128

def rumor_len(payload_chars):
    # QRST 1.6 §11.4 PAYLOAD rumor: kind 24405, no tags
    ev = {"id":HEX64,"pubkey":HEX64,"created_at":1700000000,"kind":24405,
          "tags":[],"content":"x"*payload_chars}
    return len(json.dumps(ev, separators=(',',':')))

def seal_len(ct_b64_len):
    ev = {"id":HEX64,"pubkey":HEX64,"created_at":1700000000,"kind":13,
          "tags":[],"content":"x"*ct_b64_len,"sig":SIG}
    return len(json.dumps(ev, separators=(',',':')))

def wrap_len(ct_b64_len):
    # QRST 1.6 §11.4: ephemeral gift wrap, kind 21059
    ev = {"id":HEX64,"pubkey":HEX64,"created_at":1700000000,"kind":21059,
          "tags":[["p",HEX64],["expiration","1700000600"]],
          "content":"x"*ct_b64_len,"sig":SIG}
    return len(json.dumps(ev, separators=(',',':')))

def chain(payload_bytes, encoding):
    chars = payload_bytes*2 if encoding=="hex" else 4*math.ceil(payload_bytes/3)
    R = rumor_len(chars)
    if R > 65535: return None
    inner = nip44_ct_len(R)
    S = seal_len(inner)
    if S > 65535: return None
    outer = nip44_ct_len(S)
    W = wrap_len(outer)
    relay_msg = len('["EVENT",') + W + len(']')
    return {"payload":payload_bytes,"rumor":R,"seal":S,"wrap_event":W,"relay_msg":relay_msg}

for enc in ("hex","base64"):
    print(f"\n=== payload encoded as {enc} ===")
    for cap_name, cap in (("NIP-44 only (seal<=65535)", None),
                          ("relay 65536", 65536),
                          ("relay 131072", 131072)):
        lo, hi, best = 1, 200000, None
        while lo <= hi:
            mid = (lo+hi)//2
            r = chain(mid, enc)
            ok = r is not None and (cap is None or r["relay_msg"] <= cap)
            if ok: best, lo = r, mid+1
            else: hi = mid-1
        if best:
            print(f"  {cap_name:26} -> max payload {best['payload']:6d} B  "
                  f"(rumor {best['rumor']}, seal {best['seal']}, wrap event {best['wrap_event']}, relay msg {best['relay_msg']})")

print("\n=== sanity: a 32-byte nsec, hex ===")
print(" ", chain(32,"hex"))

print("\n=== expansion at candidate normative ceilings ===")
print(f"  {'payload B':>9} {'enc':>7} {'rumor':>7} {'seal':>7} {'wrap ev':>8} {'relay msg':>10} {'ratio':>6}")
for pb in (512, 1024, 2048, 4096, 8192, 16384):
    for enc in ("hex","base64"):
        r = chain(pb, enc)
        if r:
            print(f"  {pb:9d} {enc:>7} {r['rumor']:7d} {r['seal']:7d} {r['wrap_event']:8d} {r['relay_msg']:10d} {r['relay_msg']/pb:6.1f}x")

# --- tiers against real, observed relay limits ---
# strfry default:            maxEventSize = 65536 (normalised event JSON)
#                            maxWebsocketPayloadSize = 131072
# NIP-11 example values:     max_message_length = 524288, max_content_length = 8196
def wrap_content_len(payload_bytes, enc):
    r = chain(payload_bytes, enc)
    if not r: return None
    # content is the outer NIP-44 ciphertext; recover it from the wrap event size
    return r["wrap_event"] - (wrap_len(0) - 0)

def solve(enc, event_cap=None, content_cap=None):
    lo, hi, best = 1, 200000, None
    while lo <= hi:
        mid = (lo+hi)//2
        r = chain(mid, enc)
        ok = r is not None
        if ok and event_cap   is not None: ok = r["wrap_event"] <= event_cap
        if ok and content_cap is not None: ok = (r["wrap_event"] - wrap_len(0)) <= content_cap
        if ok: best, lo = r, mid+1
        else: hi = mid-1
    return best

print("\n=== tiers against observed relay limits (payload base64-encoded) ===")
tiers = [
 ("content<=8196 (NIP-11 example max_content_length)", None, 8196),
 ("event<=65536 (strfry maxEventSize default)",       65536, None),
 ("event<=131072 (strfry maxWebsocketPayloadSize)",  131072, None),
]
for name, ec, cc in tiers:
    b = solve("base64", ec, cc)
    h = solve("hex", ec, cc)
    print(f"  {name}")
    print(f"      base64 -> {b['payload']:6d} B payload | wrap event {b['wrap_event']:6d} | content {b['wrap_event']-wrap_len(0):6d}")
    print(f"      hex    -> {h['payload']:6d} B payload | wrap event {h['wrap_event']:6d} | content {h['wrap_event']-wrap_len(0):6d}")

print("\n=== what 4096 B base64 actually needs ===")
r = chain(4096,"base64")
print(f"  wrap event {r['wrap_event']}  content {r['wrap_event']-wrap_len(0)}  ws frame {r['relay_msg']}")
