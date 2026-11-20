package cc.aaro.qrst.core

import java.net.URI
import java.net.URLDecoder
import java.util.Base64

/**
 * QRST profile `keykin-device` (profiles/keykin-device.md): adding a device to a Keykin account with
 * one code. The new device shows it (Flow A, mode=offer) with its Keykin invite in the extra fragment
 * parameter `invite`. A device already in the account scans it, adds the newcomer, and releases the
 * join text (the newcomer then collects its own piece from the box) or, for an account with no box,
 * the whole key.
 *
 * Payload: standard base64 of UTF-8 JSON, `{"keykin":2,"join":{addr,boxKey,npub[,loginPage]}}` or
 * `{"keykin":2,"nsec":"<64 hex>"}`. Lowest check: `none`, only for a code the adding device's own
 * camera read; `compare` otherwise.
 */
sealed class KeykinGift {
    /** The account's join text (Keykin SPEC 8b). Nothing secret. */
    data class Join(val addr: String, val boxKey: String, val npub: String, val loginPage: String? = null) : KeykinGift()
    /** The whole key, for an account with no box. */
    class Whole(val nsec: ByteArray) : KeykinGift()
}

/** The new device's invite (Keykin SPEC 8b), with its JSON text as it came. */
data class KeykinInvite(val text: String, val key: String, val name: String, val chip: String?)

object KeykinDeviceProfile : Profile<KeykinGift> {
    override val id = "keykin-device"
    override val maxPayloadBytes = 2048
    override val revocable = false
    override val minCheck = CodeCheck.NONE

    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val CHIP = Regex("^0[23][0-9a-f]{64}$")
    private const val MAX_INVITE = 1024

    private fun addrOk(a: Any?): Boolean {
        if (a !is String || a.length > 300) return false
        val u = try { URI(a) } catch (_: Exception) { return false }
        return (u.scheme == "https" || u.scheme == "http") && u.host != null && u.rawUserInfo == null && u.rawFragment == null
    }
    private fun loginOk(a: Any?): Boolean {
        if (a !is String) return false
        val u = try { URI(a) } catch (_: Exception) { return false }
        val local = u.host == "localhost" || u.host == "127.0.0.1"
        if (!(u.scheme == "https" || (u.scheme == "http" && local)) || u.host == null || u.rawUserInfo != null) return false
        return u.rawPath.isNullOrEmpty() && u.rawQuery == null && u.rawFragment == null && a == a.lowercase()
    }
    private fun keyOk(k: Any?) = k is String && HEX64.matches(k) && Secp.isValidPublicKey(k.hexToBytes())
    private fun shortNpub(hex: String) = Nip19.npub(hex).let { "${it.take(12)}…${it.takeLast(6)}" }

    override fun encode(value: KeykinGift): String {
        val o: Map<String, Any> = when (value) {
            is KeykinGift.Join -> {
                require(addrOk(value.addr) && HEX64.matches(value.boxKey) && HEX64.matches(value.npub) && (value.loginPage == null || loginOk(value.loginPage))) { "not a join text" }
                mapOf("keykin" to 2, "join" to LinkedHashMap<String, String>().apply {
                    put("addr", value.addr); put("boxKey", value.boxKey); put("npub", value.npub); value.loginPage?.let { put("loginPage", it) }
                })
            }
            is KeykinGift.Whole -> {
                require(Secp.isValidSecret(value.nsec)) { "not a valid key" }
                mapOf("keykin" to 2, "nsec" to value.nsec.toHex())
            }
        }
        return Base64.getEncoder().encodeToString(Json.stringify(o).toByteArray(Charsets.UTF_8))
    }

    override fun check(content: String): Checked<KeykinGift> {
        val o = try { Json.parse(String(Base64.getDecoder().decode(content), Charsets.UTF_8)) as? Map<*, *> } catch (_: Exception) { null }
            ?: return Checked.Bad("not a keykin-device payload")
        if (o["keykin"] != 2L) return Checked.Bad("not a keykin-device payload")
        return when (o.keys.map { it.toString() }.sorted()) {
            listOf("join", "keykin") -> {
                val j = o["join"] as? Map<*, *> ?: return Checked.Bad("malformed join text")
                if (j.keys.any { it !in setOf("addr", "boxKey", "npub", "loginPage") } || !addrOk(j["addr"]) || !(j["boxKey"] is String && HEX64.matches(j["boxKey"] as String)) || !keyOk(j["npub"]))
                    return Checked.Bad("malformed join text")
                if (j.containsKey("loginPage") && !loginOk(j["loginPage"])) return Checked.Bad("bad login page")
                Checked.Ok(KeykinGift.Join(j["addr"] as String, j["boxKey"] as String, j["npub"] as String, j["loginPage"] as String?))
            }
            listOf("keykin", "nsec") -> {
                val n = o["nsec"] as? String
                if (n == null || !HEX64.matches(n)) return Checked.Bad("malformed key")
                val k = n.hexToBytes()
                if (!Secp.isValidSecret(k)) return Checked.Bad("not a valid secp256k1 key")
                Checked.Ok(KeykinGift.Whole(k))
            }
            else -> Checked.Bad("not a keykin-device payload")
        }
    }

    override fun render(value: KeykinGift): String = when (value) {
        is KeykinGift.Join -> "Your account ${shortNpub(value.npub)}"
        is KeykinGift.Whole -> "Your account ${shortNpub(publicKeyHex(value.nsec))}"
    }

    /** Reads an invite (Keykin SPEC 8b) from its JSON text, or null. */
    fun readInvite(text: String?): KeykinInvite? {
        if (text == null || text.length > MAX_INVITE) return null
        val o = Json.parse(text) as? Map<*, *> ?: return null
        if (o["keykin"] != 2L) return null
        val i = o["invite"] as? Map<*, *> ?: return null
        val key = i["key"]
        if (!keyOk(key)) return null
        val chip = i["chip"]
        if (i.containsKey("chip") && !(chip is String && CHIP.matches(chip))) return null
        val name = (i["name"] as? String)?.trim()?.take(60).orEmpty().ifEmpty { "A new device" }
        return KeykinInvite(text, key as String, name, chip as String?)
    }

    /** Adds the `invite` parameter to a pairing link: the invite's JSON text, base64url without padding. */
    fun withInvite(uri: String, inviteText: String): String {
        require(readInvite(inviteText) != null) { "not a Keykin invite" }
        return uri + "&invite=" + Base64.getUrlEncoder().withoutPadding().encodeToString(inviteText.toByteArray(Charsets.UTF_8))
    }

    /** The invite a `keykin-device` pairing link carries, or null when it has none, two, or a bad one. */
    fun inviteOf(uri: String): KeykinInvite? {
        val t = uri.trim()
        val params = if ('#' in t) t.substringAfter('#') else if ('?' in t) t.substringAfter('?') else t
        val found = params.split('&').filter { it.startsWith("invite=") }
        if (found.size != 1) return null
        return try {
            val raw = URLDecoder.decode(found[0].removePrefix("invite="), "UTF-8")
            readInvite(String(Base64.getUrlDecoder().decode(raw), Charsets.UTF_8))
        } catch (_: Exception) { null }
    }
}
