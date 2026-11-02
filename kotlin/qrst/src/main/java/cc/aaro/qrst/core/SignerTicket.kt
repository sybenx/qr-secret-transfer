package cc.aaro.qrst.core

import java.util.Base64

/**
 * QRST profile `signer-ticket` (profiles/signer-ticket.md): what a signer hands a site
 * so it can sign as you. A one-time ticket the site redeems with the signer for access
 * of its own, which the signer can remove. Nothing secret of yours.
 *
 * Payload: base64 of JSON { v, pubkey, signer, relays, t, expires }.
 * Lowest check: `none`, for a code the signer's own camera read (the profile's "Why `none`").
 */
data class SignerTicket(val pubkey: String, val signer: String, val relays: List<String>, val t: String, val expires: Long)

object SignerTicketProfile : Profile<SignerTicket> {
    override val id = "signer-ticket"
    override val maxPayloadBytes = 2048
    override val revocable = true
    override val minCheck = CodeCheck.NONE
    private val HEX32 = Regex("^[0-9a-f]{64}$")

    override fun encode(value: SignerTicket): String {
        val json = Json.stringify(mapOf("v" to 1, "pubkey" to value.pubkey, "signer" to value.signer, "relays" to value.relays, "t" to value.t, "expires" to value.expires))
        require(json.length <= maxPayloadBytes) { "ticket too large" }
        return Base64.getEncoder().encodeToString(json.toByteArray(Charsets.UTF_8))
    }

    override fun check(content: String): Checked<SignerTicket> {
        val m = try { Json.parse(String(Base64.getDecoder().decode(content), Charsets.UTF_8)) as? Map<*, *> } catch (_: Exception) { null }
            ?: return Checked.Bad("not a ticket")
        val pubkey = m["pubkey"] as? String; val signer = m["signer"] as? String; val t = m["t"] as? String
        val relays = (m["relays"] as? List<*>)?.filterIsInstance<String>()
        val expires = m["expires"] as? Long
        if (m["v"] != 1L || pubkey == null || !HEX32.matches(pubkey) || signer == null || !HEX32.matches(signer) || t == null || !Regex("^[0-9a-f]{32}$").matches(t) || expires == null)
            return Checked.Bad("malformed ticket")
        if (relays.isNullOrEmpty() || relays.size > 6 || !relays.all { Regex("^wss://\\S+$").matches(it) }) return Checked.Bad("bad relays")
        if (expires < System.currentTimeMillis() / 1000) return Checked.Bad("expired")
        return Checked.Ok(SignerTicket(pubkey, signer, relays, t, expires))
    }

    override fun render(value: SignerTicket): String = "Sign in as ${Nip19.npub(value.pubkey).take(14)}…"
}
