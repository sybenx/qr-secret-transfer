package cc.aaro.qrst.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

fun resource(name: String): String = VectorsTest::class.java.classLoader!!.getResource(name)!!.readText()

class VectorsTest {
    @Test fun sasVectors() {
        val v = JSONObject(resource("qrst-sas.json"))
        val snd = v.getString("snd_pubkey"); val rcv = v.getString("rcv_pubkey")
        val ns = v.getString("nonce_s"); val nr = v.getString("nonce_r")
        val p = v.getString("profile")
        assertEquals(v.getJSONObject("commit_snd_contacting").getString("commit"), Sas.commit(1, snd, ns).toHex())
        assertEquals(v.getJSONObject("commit_rcv_contacting").getString("commit"), Sas.commit(1, rcv, nr).toHex())
        val code = Sas.code(1, p, snd, rcv, ns, nr)
        assertEquals(v.getString("code"), code.toHex())
        assertEquals(v.getString("digits"), Sas.digits(code))
        val transposed = Sas.code(1, p, rcv, snd, nr, ns).toHex()
        assertEquals(v.getJSONObject("code_with_roles_transposed").getString("code"), transposed)
        assertNotEquals(code.toHex(), transposed)
    }

    private val nip44 = JSONObject(resource("nip44.vectors.json")).getJSONObject("v2")

    @Test fun nip44ConversationKeys() {
        val list = nip44.getJSONObject("valid").getJSONArray("get_conversation_key")
        for (i in 0 until list.length()) {
            val c = list.getJSONObject(i)
            assertEquals(c.getString("conversation_key"), Nip44.conversationKey(c.getString("sec1").hexToBytes(), c.getString("pub2")).toHex())
        }
        val bad = nip44.getJSONObject("invalid").getJSONArray("get_conversation_key")
        for (i in 0 until bad.length()) {
            val c = bad.getJSONObject(i)
            try {
                Nip44.conversationKey(c.getString("sec1").hexToBytes(), c.getString("pub2"))
                fail("accepted: ${c.optString("note")}")
            } catch (_: Exception) {}
        }
    }

    @Test fun nip44Padding() {
        val list = nip44.getJSONObject("valid").getJSONArray("calc_padded_len")
        for (i in 0 until list.length()) {
            val pair = list.getJSONArray(i)
            assertEquals(pair.getInt(1), Nip44.paddedLength(pair.getInt(0)))
        }
    }

    @Test fun nip44EncryptDecrypt() {
        val list = nip44.getJSONObject("valid").getJSONArray("encrypt_decrypt")
        for (i in 0 until list.length()) {
            val c = list.getJSONObject(i)
            val sec1 = c.getString("sec1").hexToBytes()
            val pub2 = publicKeyHex(c.getString("sec2").hexToBytes())
            val key = Nip44.conversationKey(sec1, pub2)
            assertEquals(c.getString("conversation_key"), key.toHex())
            val payload = Nip44.encrypt(c.getString("plaintext"), key, c.getString("nonce").hexToBytes())
            assertEquals(c.getString("payload"), payload)
            assertEquals(c.getString("plaintext"), Nip44.decrypt(payload, key))
        }
    }

    @Test fun nip44InvalidDecrypt() {
        val list = nip44.getJSONObject("invalid").getJSONArray("decrypt")
        for (i in 0 until list.length()) {
            val c = list.getJSONObject(i)
            try {
                Nip44.decrypt(c.getString("payload"), c.getString("conversation_key").hexToBytes())
                fail("accepted: ${c.getString("note")}")
            } catch (_: Exception) {}
        }
    }

    @Test fun bech32RoundTrip() {
        val pub = publicKeyHex(ByteArray(32).also { it[31] = 1 })
        val npub = Nip19.npub(pub)
        assertTrue(npub.startsWith("npub1"))
        assertEquals(pub, Nip19.npubDecode(npub))
        // Known: secret key 1 is the generator, npub of G.
        assertEquals("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", pub)
        val broken = npub.dropLast(1) + (if (npub.last() == 'q') 'p' else 'q')
        try { Nip19.npubDecode(broken); fail("bad checksum accepted") } catch (_: Exception) {}
        val sec = ByteArray(32).also { it[31] = 7 }
        assertEquals(sec.toHex(), Nip19.parseSecret(Nip19.nsec(sec)).toHex())
    }

    @Test fun jsonMatchesJavaScript() {
        assertEquals("""["a\"b\\c\n\u0001é😀"]""", Json.stringify(listOf("a\"b\\c\n\u0001é😀")))
        assertEquals("""{"x":[1,"y"]}""", Json.stringify(mapOf("x" to listOf(1, "y"))))
    }
}
