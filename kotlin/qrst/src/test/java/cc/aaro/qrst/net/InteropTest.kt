package cc.aaro.qrst.net

import cc.aaro.qrst.core.CodeCheck
import cc.aaro.qrst.core.DemoTextProfile
import cc.aaro.qrst.core.NsecProfile
import cc.aaro.qrst.core.Outcome
import cc.aaro.qrst.core.PairingUri
import cc.aaro.qrst.core.Phase
import cc.aaro.qrst.core.Profile
import cc.aaro.qrst.core.Role
import cc.aaro.qrst.core.SystemEnv
import cc.aaro.qrst.core.generateSecretKey
import cc.aaro.qrst.core.toHex
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * This library's transfer against the TypeScript reference in this repository, over its
 * test relay, in both flows and both directions. Runs once `npm ci` has been run at the
 * repository root, or when QRST_REFERENCE points at another checkout with node_modules.
 */
class InteropTest {
    private val reference = System.getenv("QRST_REFERENCE")
        ?: File("../..").canonicalFile.takeIf { File(it, "node_modules").isDirectory }?.path
    private val procs = ArrayList<Process>()
    private lateinit var relay: String
    private lateinit var peer: Process
    private val lines = LinkedBlockingQueue<String>()

    private fun node(vararg args: String): Process =
        ProcessBuilder(listOf("node", "--experimental-transform-types", "--no-warnings") + args)
            .directory(File("..").canonicalFile).redirectErrorStream(true).start().also { procs += it }

    @Before fun setUp() {
        assumeTrue("run npm ci at the repository root, or set QRST_REFERENCE", reference != null)
        PairingUri.allowLoopback = true
        val r = node("interop/relay.mjs", reference!!)
        relay = r.inputStream.bufferedReader().readLine().removePrefix("RELAY ").trim()
        peer = node("interop/peer.ts", reference, relay)
        Thread {
            peer.inputStream.bufferedReader().forEachLine { println("  ts| $it"); lines.put(it) }
        }.apply { isDaemon = true }.start()
    }

    @After fun tearDown() {
        procs.forEach { it.destroy() }
        PairingUri.allowLoopback = false
    }

    private fun tell(line: String) {
        peer.outputStream.write("$line\n".toByteArray())
        peer.outputStream.flush()
    }

    private fun expect(prefix: String, ms: Long = 20_000, predicate: (String) -> Boolean = { true }): String {
        val deadline = System.currentTimeMillis() + ms
        while (true) {
            val left = deadline - System.currentTimeMillis()
            val line = lines.poll(maxOf(left, 1), TimeUnit.MILLISECONDS) ?: throw AssertionError("timed out waiting for $prefix")
            if (line.startsWith("ERROR")) throw AssertionError(line)
            if (line.startsWith(prefix) && predicate(line.removePrefix(prefix).trim())) return line.removePrefix(prefix).trim()
        }
    }

    private fun tsView(predicate: (JSONObject) -> Boolean) = JSONObject(expect("VIEW") { predicate(JSONObject(it)) })

    private fun <T> deps(profile: Profile<T>, check: CodeCheck) = TransferDeps(
        profile, Store(MemoryKeyValue()).apply { setConfigured(listOf(relay)) }, SystemEnv, "https://qrst.aaro.cc/", check,
    )

    private fun <T> until(t: Transfer<T>, ms: Long = 20_000, predicate: (TransferView<T>) -> Boolean): TransferView<T> {
        val deadline = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < deadline) {
            val v = t.view()
            if (predicate(v)) return v
            Thread.sleep(50)
        }
        throw AssertionError("timed out; ${t.view().session} ${t.view().log}")
    }

    @Test fun kotlinReceiverShows_tsSenderSendsNsec() {
        val key = generateSecretKey(SystemEnv)
        val kt = Transfer.show(deps(NsecProfile, CodeCheck.TYPE), Role.RECEIVER)
        val uri = until(kt) { it.uri != null }.uri!!
        tell("profile nostr-nsec")
        tell("join $uri ${key.toHex()}")
        val code = until(kt) { it.session.code != null }.session.code!!
        tsView { it.optString("phase") == "release" }
        tell("code $code")
        val v = until(kt) { it.session.phase == Phase.ACCEPT }
        assertEquals(NsecProfile.render(key), v.session.rendering)
        kt.accept()
        until(kt) { it.session.outcome == Outcome.RECEIVED }
        assertEquals(key.toHex(), kt.takeValue()!!.toHex())
        tsView { it.optString("outcome") == "delivered" }
    }

    @Test fun tsSenderShows_kotlinReceiverScans() {
        val key = generateSecretKey(SystemEnv)
        tell("profile nostr-nsec")
        tell("show sender type ${key.toHex()}")
        val uri = expect("URI")
        val params = PairingUri.parse(uri)
        val kt = Transfer.join(deps(NsecProfile, CodeCheck.TYPE), params, viaCamera = true)
        val code = until(kt) { it.session.code != null }.session.code!!
        tsView { it.optString("phase") == "release" }
        tell("code $code")
        until(kt) { it.session.phase == Phase.ACCEPT }
        kt.accept()
        until(kt) { it.session.outcome == Outcome.RECEIVED }
        assertEquals(key.toHex(), kt.takeValue()!!.toHex())
        tsView { it.optString("outcome") == "delivered" }
    }

    @Test fun tsReceiverShows_kotlinSenderCompares() {
        tell("profile qrst-demo-text")
        tell("show receiver compare")
        val params = PairingUri.parse(expect("URI"))
        val kt = Transfer.join(deps(DemoTextProfile, CodeCheck.COMPARE), params, viaCamera = true, payload = "hello from kotlin")
        val tsCode = tsView { it.has("code") }.getString("code")
        val v = until(kt) { it.session.compare != null }
        assertEquals(tsCode, v.session.compare)
        kt.confirmMatch()
        tsView { it.optString("phase") == "accept" }
        tell("accept")
        tsView { it.optString("value") == "hello from kotlin" }
        until(kt) { it.session.outcome == Outcome.DELIVERED }
    }

    @Test fun kotlinSenderShows_tsReceiverScans() {
        val kt = Transfer.show(deps(DemoTextProfile, CodeCheck.COMPARE), Role.SENDER, payload = "hello again")
        val uri = until(kt) { it.uri != null }.uri!!
        tell("profile qrst-demo-text")
        tell("join $uri _ compare")
        val tsCode = tsView { it.has("code") }.getString("code")
        assertEquals(tsCode, until(kt) { it.session.compare != null }.session.compare)
        kt.confirmMatch()
        tsView { it.optString("phase") == "accept" }
        tell("accept")
        tsView { it.optString("value") == "hello again" }
        until(kt) { it.session.outcome == Outcome.DELIVERED }
    }
}
