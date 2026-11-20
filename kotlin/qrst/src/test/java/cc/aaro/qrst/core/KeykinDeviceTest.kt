package cc.aaro.qrst.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The `keykin-device` profile against the vectors the TypeScript side checks too. */
class KeykinDeviceTest {
    private val v = JSONObject(resource("keykin-device.json"))
    private val P = KeykinDeviceProfile

    private fun join(): KeykinGift.Join = v.getJSONObject("join").getJSONObject("value").let {
        KeykinGift.Join(it.getString("addr"), it.getString("boxKey"), it.getString("npub"), it.optString("loginPage").ifEmpty { null })
    }

    @Test fun encodesAsTheVectorsSay() {
        assertEquals(v.getJSONObject("join").getString("content"), P.encode(join()))
        assertEquals(v.getJSONObject("whole").getString("content"), P.encode(KeykinGift.Whole(v.getJSONObject("whole").getString("nsec").hexToBytes())))
    }

    @Test fun readsAndRenders() {
        val j = P.check(v.getJSONObject("join").getString("content"))
        assertEquals(Checked.Ok(join()), j)
        assertEquals(v.getJSONObject("join").getString("render"), P.render((j as Checked.Ok).value))
        val w = P.check(v.getJSONObject("whole").getString("content")) as Checked.Ok
        assertEquals(v.getJSONObject("whole").getString("nsec"), (w.value as KeykinGift.Whole).nsec.toHex())
        assertEquals(v.getJSONObject("whole").getString("render"), P.render(w.value))
    }

    @Test fun refusesTheBadOnes() {
        val bad = v.getJSONArray("bad")
        for (i in 0 until bad.length()) {
            val b = bad.getJSONObject(i)
            assertTrue(b.getString("why"), P.check(b.getString("content")) is Checked.Bad)
        }
    }

    @Test fun carriesTheInviteInTheLink() {
        val uri = v.getString("uri")
        val inv = P.inviteOf(uri)!!
        val want = JSONObject(v.getJSONObject("invite").getString("text")).getJSONObject("invite")
        assertEquals(want.getString("key"), inv.key)
        assertEquals("Galaxy Tab", inv.name)
        assertEquals(want.getString("chip"), inv.chip)
        val p = PairingUri.parse(uri)
        assertEquals("keykin-device", p.profile)
        assertEquals(Mode.OFFER, p.mode)
        assertEquals(CodeCheck.NONE, p.check)
        val base = uri.substringBefore("&invite=")
        assertEquals(uri, P.withInvite(base, v.getJSONObject("invite").getString("text")))
        assertNull(P.inviteOf(base))
        assertNull(P.inviteOf(uri + "&invite=" + uri.substringAfter("&invite=")))
        assertNull(P.inviteOf("$base&invite=bm90IGpzb24"))
    }
}
