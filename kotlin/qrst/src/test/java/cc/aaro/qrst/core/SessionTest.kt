package cc.aaro.qrst.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Two sessions wired to each other through their wraps, with no relay in between. */
class SessionTest {
    private val env = SystemEnv

    private fun <T> deliver(effects: List<Effect<T>>, to: Session<*>): List<Effect<*>> {
        val out = mutableListOf<Effect<*>>()
        for (e in effects) if (e is Effect.Publish && e.to == to.pub) out += to.receive(e.event)
        return out
    }

    /** Runs messages back and forth until neither side has anything new to say. */
    private fun pump(a: Session<*>, b: Session<*>, first: List<Effect<*>>, firstFrom: Session<*>) {
        var pending = first
        var from = firstFrom
        repeat(20) {
            val to = if (from === a) b else a
            @Suppress("UNCHECKED_CAST")
            val next = deliver(pending as List<Effect<Any?>>, to)
            if (next.none { it is Effect.Publish }) return
            pending = next
            from = to
        }
    }

    private fun secret() = generateSecretKey(env)

    @Test fun flowA_receiverShows_senderTypes() {
        val key = Nip19.parseSecret("0000000000000000000000000000000000000000000000000000000000000003")
        val rcv = Session(Role.RECEIVER, true, NsecProfile, secret(), env, check = CodeCheck.COMPARE)
        val snd = Session(Role.SENDER, false, NsecProfile, secret(), env, peerPub = rcv.pub, payload = key, token = rcv.token, peerCheck = CodeCheck.COMPARE)
        pump(rcv, snd, snd.start(), snd)

        // nostr-nsec's minimum is `type`, whatever either device asked for.
        assertEquals(CodeCheck.TYPE, snd.view().check)
        assertEquals(Phase.RELEASE, snd.view().phase)
        assertNull(snd.view().compare)
        val code = rcv.view().code
        assertNotNull(code)

        // A wrong code spends an attempt.
        val wrong = ((code!!.toInt() + 1) % 100000).toString().padStart(5, '0')
        snd.enterCode(wrong)
        assertEquals(MAX_ATTEMPTS - 1, snd.view().attemptsLeft)

        val released = snd.enterCode(code)
        assertEquals(Phase.SENT, snd.view().phase)
        val afterPayload = deliver(released, rcv)
        assertEquals(Phase.ACCEPT, rcv.view().phase)
        assertEquals(Nip19.npub(publicKeyHex(key)), rcv.view().rendering)

        val accepted = rcv.accept()
        val commit = accepted.filterIsInstance<Effect.Commit<ByteArray>>().single()
        assertArrayEquals(key, commit.value)
        assertEquals(Outcome.RECEIVED, rcv.view().outcome)
        deliver(accepted, snd)
        assertEquals(Outcome.DELIVERED, snd.view().outcome)
        assertTrue(afterPayload.isEmpty() || afterPayload.none { it is Effect.Ended })
    }

    @Test fun flowB_senderShows_receiverScans() {
        val key = secret()
        // The key is handed over only at release, as the app does after the credential check.
        val snd = Session<ByteArray>(Role.SENDER, true, NsecProfile, secret(), env)
        val rcv = Session(Role.RECEIVER, false, NsecProfile, secret(), env, peerPub = snd.pub, token = snd.token, peerCheck = CodeCheck.TYPE)
        pump(snd, rcv, rcv.start(), rcv)
        assertEquals(Phase.CODE, rcv.view().phase)
        assertEquals(Phase.RELEASE, snd.view().phase)
        val released = snd.enterCode(rcv.view().code!!, key.copyOf())
        deliver(released, rcv)
        assertEquals(Phase.ACCEPT, rcv.view().phase)
        val accepted = rcv.accept()
        assertArrayEquals(key, accepted.filterIsInstance<Effect.Commit<ByteArray>>().single().value)
        deliver(accepted, snd)
        assertEquals(Outcome.DELIVERED, snd.view().outcome)
    }

    @Test fun contactWithoutTokenIsIgnored() {
        val rcv = Session(Role.RECEIVER, true, NsecProfile, secret(), env)
        val snd = Session(Role.SENDER, false, NsecProfile, secret(), env, peerPub = rcv.pub, payload = secret(), token = "00".repeat(16))
        val replies = deliver(snd.start(), rcv)
        assertTrue(replies.none { it is Effect.Publish })
        assertEquals(Phase.WAITING, rcv.view().phase)
    }

    @Test fun fiveMissesEndTheSession() {
        val rcv = Session(Role.RECEIVER, true, NsecProfile, secret(), env)
        val snd = Session(Role.SENDER, false, NsecProfile, secret(), env, peerPub = rcv.pub, payload = secret(), token = rcv.token)
        pump(rcv, snd, snd.start(), snd)
        val wrong = ((rcv.view().code!!.toInt() + 1) % 100000).toString().padStart(5, '0')
        var last: List<Effect<ByteArray>> = emptyList()
        repeat(MAX_ATTEMPTS) { last = snd.enterCode(wrong) }
        assertEquals(Outcome.ATTEMPTS_EXHAUSTED, snd.view().outcome)
        assertTrue(last.any { it is Effect.FailedPeers })
    }

    @Test fun demoTextAtNone() {
        val rcv = Session(Role.RECEIVER, true, DemoTextProfile, secret(), env, check = CodeCheck.NONE)
        val snd = Session(Role.SENDER, false, DemoTextProfile, secret(), env, peerPub = rcv.pub, payload = "hello there", token = rcv.token, peerCheck = CodeCheck.NONE, check = CodeCheck.NONE)
        pump(rcv, snd, snd.start(), snd)
        assertEquals(CodeCheck.NONE, snd.view().check)
        assertNull(rcv.view().code)
        deliver(snd.release(), rcv)
        assertEquals("hello there", rcv.accept().filterIsInstance<Effect.Commit<String>>().single().value)
    }

    @Test fun uriRoundTrip() {
        val pub = publicKeyHex(secret())
        val p = PairingParams(Mode.OFFER, "nostr-nsec", pub, CodeCheck.TYPE, "ab".repeat(16), listOf("wss://relay.damus.io", "wss://nos.lol/"))
        val uri = PairingUri.build("https://qrst.aaro.cc/", p)
        assertTrue(uri.startsWith("https://qrst.aaro.cc/#v=1&mode=offer&p=nostr-nsec&npub=npub1"))
        assertTrue(uri.contains("relay=wss://relay.damus.io&relay=wss://nos.lol"))
        assertEquals(p.copy(relays = listOf("wss://relay.damus.io", "wss://nos.lol")), PairingUri.parse(uri))
        // The qrst: handoff (§11.2c), as the reference's buildHandoffUri writes it.
        val npub = Nip19.npub(pub)
        val handoff = "qrst://$npub?" + uri.substringAfter('#').split('&').filter { !it.startsWith("npub=") }.joinToString("&")
        assertTrue(PairingUri.isHandoff(handoff))
        assertTrue(!PairingUri.isHandoff(uri))
        assertEquals(PairingUri.parse(uri), PairingUri.parse(handoff))
        try { PairingUri.parse(handoff.replace("qrst://", "frost://")); throw AssertionError("other scheme accepted") } catch (_: UriException) {}
        try { PairingUri.parse(handoff.replace("v=1", "v=2")); throw AssertionError("bad version accepted") } catch (_: UriException) {}
        assertTrue(PairingUri.isPrivateHost("100.86.253.33"))
        assertTrue(PairingUri.isPrivateHost("box.tail1234.ts.net"))
        assertTrue(!PairingUri.isPrivateHost("relay.damus.io"))
    }
}
