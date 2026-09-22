package com.voxarcade.wear

import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeCapture(
    override val initialized: Boolean = true,
    private val startFailure: Throwable? = null,
    private val terminalRead: Int = -3,
) : WearAudioCapture {
    override val bufferSamples = 1024
    val started = CountDownLatch(1)
    private val finishRead = CountDownLatch(1)
    @Volatile var stopCalls = 0
    @Volatile var releaseCalls = 0

    override fun start() {
        startFailure?.let { throw it }
        started.countDown()
    }

    override fun read(buffer: ShortArray): Int {
        finishRead.await(2, TimeUnit.SECONDS)
        return terminalRead
    }

    fun disconnect() = finishRead.countDown()

    override fun stop() {
        stopCalls += 1
        finishRead.countDown()
    }

    override fun release() { releaseCalls += 1 }
}

private class CaptureQueue(vararg captures: FakeCapture) : WearAudioCaptureFactory {
    private val queue = ArrayDeque(captures.toList())
    var creates = 0

    override fun create(): WearAudioCapture {
        creates += 1
        return queue.removeFirst()
    }
}

private fun await(message: String, predicate: () -> Boolean) {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
    while (!predicate()) {
        if (System.nanoTime() >= deadline) throw AssertionError("Timed out: $message")
        Thread.sleep(2)
    }
}

private fun assertReleased(engine: MicEngine) {
    await("Wear microphone resources to release") {
        val snapshot = engine.resourceSnapshot()
        snapshot.audioRecorders == 0 && snapshot.captureThreads == 0 && snapshot.pendingStarts == 0
    }
}

class MicEngineLifecycleTest {
    @Test fun repeatedStartStopCreatesOnlyOneOwnerPerCycle() {
        val captures = Array(40) { FakeCapture() }
        val queue = CaptureQueue(*captures)
        val engine = MicEngine(queue)

        captures.forEachIndexed { index, capture ->
            assertTrue(engine.start())
            assertTrue(engine.start())
            assertTrue(capture.started.await(1, TimeUnit.SECONDS))
            await("cycle $index to run") { engine.state.value == WearMicState.RUNNING }
            assertEquals(1, engine.resourceSnapshot().audioRecorders)
            engine.stop()
            engine.stop()
            assertReleased(engine)
        }

        assertEquals(captures.size, queue.creates)
        captures.forEach { assertEquals(1, it.releaseCalls) }
    }

    @Test fun partialInitializationAndStartFailureReleaseAcquiredCapture() {
        val uninitialized = FakeCapture(initialized = false)
        val startFailed = FakeCapture(startFailure = IllegalStateException("start failed"))
        val queue = CaptureQueue(uninitialized, startFailed)
        val engine = MicEngine(queue)

        assertTrue(engine.start())
        await("uninitialized failure") { engine.state.value == WearMicState.FAILED }
        assertReleased(engine)
        assertEquals(1, uninitialized.releaseCalls)

        assertTrue(engine.start())
        await("start failure") { engine.state.value == WearMicState.FAILED }
        assertReleased(engine)
        assertEquals(1, startFailed.releaseCalls)
    }

    @Test fun cancellationDuringInitializationBlocksReplacementAndReleasesLateCapture() {
        val factoryEntered = CountDownLatch(1)
        val finishFactory = CountDownLatch(1)
        val lateCapture = FakeCapture()
        val nextCapture = FakeCapture()
        var call = 0
        val factory = WearAudioCaptureFactory {
            call += 1
            if (call == 1) {
                factoryEntered.countDown()
                // Model a platform constructor that does not honor interruption. The
                // generation guard must still reject its late result after stop().
                while (finishFactory.count > 0) {
                    try { finishFactory.await(2, TimeUnit.SECONDS) }
                    catch (_: InterruptedException) { /* deliberately non-cancellable */ }
                }
                lateCapture
            } else nextCapture
        }
        val engine = MicEngine(factory, joinTimeoutMs = 5)

        assertTrue(engine.start())
        assertTrue(factoryEntered.await(1, TimeUnit.SECONDS))
        engine.stop()
        assertFalse(engine.start()) // old attempt still owns the capture slot
        finishFactory.countDown()
        assertReleased(engine)
        assertEquals(WearMicState.IDLE, engine.state.value)
        assertEquals(1, lateCapture.releaseCalls)

        assertTrue(engine.start())
        assertTrue(nextCapture.started.await(1, TimeUnit.SECONDS))
        engine.stop()
        assertReleased(engine)
    }

    @Test fun deviceDisconnectFailsClosedAndAllowsCleanReconnect() {
        val disconnected = FakeCapture(terminalRead = -6)
        val replacement = FakeCapture()
        val engine = MicEngine(CaptureQueue(disconnected, replacement))

        assertTrue(engine.start())
        assertTrue(disconnected.started.await(1, TimeUnit.SECONDS))
        disconnected.disconnect()
        await("disconnect failure") { engine.state.value == WearMicState.FAILED }
        assertReleased(engine)
        assertTrue(engine.lastError.value?.contains("disconnected") == true)

        assertTrue(engine.start())
        assertTrue(replacement.started.await(1, TimeUnit.SECONDS))
        engine.stop()
        assertReleased(engine)
        assertEquals(1, disconnected.releaseCalls)
        assertEquals(1, replacement.releaseCalls)
    }

    @Test fun cancelledPermissionCallbackCannotRestoreStoppedOrLaterSession() {
        val capture = FakeCapture()
        val engine = MicEngine(CaptureQueue(capture))
        val session = WearMicSession(engine)
        var launches = 0

        assertTrue(session.start(hasPermission = false) { launches += 1 })
        assertEquals(1, session.resourceSnapshot().pendingPermissionAttempts)
        session.stop()
        assertFalse(session.onPermissionResult(granted = true))
        assertEquals(WearMicState.IDLE, engine.state.value)
        assertEquals(0, session.resourceSnapshot().pendingPermissionAttempts)

        assertTrue(session.start(hasPermission = false) { launches += 1 })
        assertTrue(session.onPermissionResult(granted = true))
        assertTrue(capture.started.await(1, TimeUnit.SECONDS))
        assertEquals(2, launches)
        session.stop()
        assertReleased(engine)
    }

    @Test fun permissionDenialAndLifecycleStopAreIdempotent() {
        val capture = FakeCapture()
        val engine = MicEngine(CaptureQueue(capture))
        val session = WearMicSession(engine)
        var launches = 0

        session.lifecycleListenerAttached()
        session.start(hasPermission = false) { launches += 1 }
        assertFalse(session.onPermissionResult(granted = false))
        assertEquals(0, engine.resourceSnapshot().audioRecorders)

        session.start(hasPermission = true) { launches += 1 }
        assertTrue(capture.started.await(1, TimeUnit.SECONDS))
        session.stop() // activity/page lifecycle equivalent
        session.stop()
        session.lifecycleListenerDetached()
        assertReleased(engine)
        val snapshot = session.resourceSnapshot()
        assertEquals(0, snapshot.pendingPermissionAttempts)
        assertEquals(0, snapshot.lifecycleListeners)
        assertEquals(1, launches)
    }

    @Test fun sessionRestartUsesOneFreshOwnerAndNoPriorResources() {
        val first = FakeCapture()
        val second = FakeCapture()
        val engine = MicEngine(CaptureQueue(first, second))
        val session = WearMicSession(engine)

        assertTrue(session.start(hasPermission = true) {})
        assertTrue(first.started.await(1, TimeUnit.SECONDS))
        await("first session to run") { engine.state.value == WearMicState.RUNNING }
        val firstGeneration = engine.resourceSnapshot().generation
        session.stop()
        assertReleased(engine)

        assertTrue(session.start(hasPermission = true) {})
        assertTrue(second.started.await(1, TimeUnit.SECONDS))
        await("restarted session to run") { engine.state.value == WearMicState.RUNNING }
        val restarted = engine.resourceSnapshot()
        assertTrue(restarted.generation > firstGeneration)
        assertEquals(1, restarted.audioRecorders)
        assertEquals(1, restarted.captureThreads)
        assertEquals(1, first.releaseCalls)

        session.stop()
        assertReleased(engine)
        assertEquals(1, second.releaseCalls)
    }

    @Test fun nativeDiagnosticsExplicitlyExcludeBrowserAndTransportResources() {
        val engine = MicEngine(CaptureQueue(FakeCapture()))
        val snapshot = engine.resourceSnapshot()
        assertEquals(0, snapshot.mediaStreams)
        assertEquals(0, snapshot.mediaStreamTracks)
        assertEquals(0, snapshot.audioContexts)
        assertEquals(0, snapshot.webAudioNodes)
        assertEquals(0, snapshot.transports)
        assertEquals(0, snapshot.timers)
        assertEquals(0, snapshot.retryLoops)
        assertEquals(0, snapshot.eventListeners)
    }
}
