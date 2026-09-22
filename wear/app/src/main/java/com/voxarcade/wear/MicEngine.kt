package com.voxarcade.wear

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.log10
import kotlin.math.sqrt

/** Terminal and transitional states for the one native Wear microphone owner. */
enum class WearMicState { IDLE, STARTING, RUNNING, FAILED }

/**
 * Deterministic resource counts for the native Wear microphone path.
 *
 * Browser resources are included as explicit zeroes because Wear v2 is a standalone
 * [AudioRecord] application: it has no MediaStream, Web Audio graph, or relay transport.
 */
data class WearMicResourceSnapshot(
    val generation: Long,
    val state: WearMicState,
    val audioRecorders: Int,
    val captureThreads: Int,
    val pendingStarts: Int,
    val calibrationCaptures: Int,
    val mediaStreams: Int = 0,
    val mediaStreamTracks: Int = 0,
    val audioContexts: Int = 0,
    val webAudioNodes: Int = 0,
    val transports: Int = 0,
    val timers: Int = 0,
    val retryLoops: Int = 0,
    val eventListeners: Int = 0,
)

/** Small seam around [AudioRecord] so lifecycle failures can be tested on the JVM. */
internal interface WearAudioCapture {
    val initialized: Boolean
    val bufferSamples: Int
    fun start()
    fun read(buffer: ShortArray): Int
    fun stop()
    fun release()
}

internal fun interface WearAudioCaptureFactory {
    fun create(): WearAudioCapture
}

private class AndroidWearAudioCapture(
    private val recorder: AudioRecord,
    override val bufferSamples: Int,
) : WearAudioCapture {
    override val initialized: Boolean get() = recorder.state == AudioRecord.STATE_INITIALIZED
    override fun start() = recorder.startRecording()
    override fun read(buffer: ShortArray): Int = recorder.read(buffer, 0, buffer.size)
    override fun stop() = recorder.stop()
    override fun release() = recorder.release()
}

/**
 * Native microphone capture + DSP for the no-WebView Wear OS app.
 *
 * Reads PCM frames from [AudioRecord] on a background thread and publishes, as
 * [StateFlow]s the UI observes: input level, YIN [pitchHz]/[pitchConfidence]
 * (milestone 2), and FFT [spectralBrightness]/[spectralBrightnessConfidence] with [f1Hz]/[f2Hz]
 * (milestone 4). All DSP runs on the same capture frame, so pitch and brightness
 * stay frame-aligned.
 *
 * [spectralBrightness] is brightness-primary and is NOT the app's resonance metric — see
 * [SpectralBrightnessEstimator] for what that means and what must not be done with it.
 */
class MicEngine internal constructor(
    private val captureFactory: WearAudioCaptureFactory = WearAudioCaptureFactory {
        val sampleRate = 16_000
        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        require(minBuf > 0) { "No usable Wear microphone buffer" }
        val bufferBytes = maxOf(minBuf, sampleRate / 10 * 2)
        AndroidWearAudioCapture(
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferBytes,
            ),
            bufferBytes / 2,
        )
    },
    private val joinTimeoutMs: Long = 1_000,
) {

    private val sampleRate = 16_000

    private val _level = MutableStateFlow(0f)
    val level: StateFlow<Float> = _level

    /** Median-filtered fundamental in Hz (0 when silent/unvoiced). */
    private val _pitchHz = MutableStateFlow(0f)
    val pitchHz: StateFlow<Float> = _pitchHz

    /** Pitch confidence 0..1 from the YIN CMND. */
    private val _pitchConfidence = MutableStateFlow(0f)
    val pitchConfidence: StateFlow<Float> = _pitchConfidence

    /** Spectral brightness 0..1 (0.5 neutral at rest). Not `resonanceScore`; not comparable
     *  with the web/firmware value of that name, and not for shared session statistics. */
    private val _spectralBrightness = MutableStateFlow(0.5f)
    val spectralBrightness: StateFlow<Float> = _spectralBrightness

    /** Brightness confidence 0..1 (high-band SNR + a found formant). */
    private val _spectralBrightnessConfidence = MutableStateFlow(0f)
    val spectralBrightnessConfidence: StateFlow<Float> = _spectralBrightnessConfidence

    /** Latest formant estimates in Hz for the readout (0 when not found). */
    private val _f1Hz = MutableStateFlow(0f)
    val f1Hz: StateFlow<Float> = _f1Hz
    private val _f2Hz = MutableStateFlow(0f)
    val f2Hz: StateFlow<Float> = _f2Hz

    /** Per-frame broadband a-posteriori SNR (dB) vs the calibrated ambient floor, smoothed.
     *  Optimistic at rest so nothing reads "noisy" before a floor is measured. */
    private val _snrDb = MutableStateFlow(DspConstants.SNR_GREEN_DB.toFloat())
    val snrDb: StateFlow<Float> = _snrDb
    /** 0..1 noise-relative trust derived from [snrDb]; gates + grades the alert haptics. */
    private val _snrConfidence = MutableStateFlow(1f)
    val snrConfidence: StateFlow<Float> = _snrConfidence

    /** True while a per-room noise-floor capture is in progress (milestone 8). */
    private val _calibrating = MutableStateFlow(false)
    val calibrating: StateFlow<Boolean> = _calibrating

    /** Emits the freshly measured floor (RMS) when a calibration completes; 0 at rest. */
    private val _calibratedFloor = MutableStateFlow(0f)
    val calibratedFloor: StateFlow<Float> = _calibratedFloor

    private val pitch = PitchDetector(sampleRate)
    private val brightnessEstimator = SpectralBrightnessEstimator(sampleRate)

    private val lifecycleLock = Any()
    private val generationCounter = AtomicLong(0)
    @Volatile private var activeGeneration = 0L
    private var thread: Thread? = null
    private var capture: WearAudioCapture? = null
    private var stopping = false
    @Volatile private var liveCaptureCount = 0
    @Volatile private var pendingStartCount = 0

    private val _state = MutableStateFlow(WearMicState.IDLE)
    val state: StateFlow<WearMicState> = _state
    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError

    // Per-room calibration state (milestone 8).
    @Volatile private var noiseFloor = 0f      // calibrated ambient RMS (0 = uncalibrated)
    @Volatile private var calFramesLeft = 0    // reads remaining in an active capture
    private var calSum = 0.0
    private var calMax = 0f
    private var calCount = 0
    private var snrDbSmoothed = DspConstants.SNR_GREEN_DB.toFloat() // capture-thread SNR EMA

    val isRunning: Boolean get() = _state.value == WearMicState.RUNNING

    /** Switch the brightness measurement method (safe to call while running). */
    fun setBrightnessMethod(m: BrightnessMethod) { brightnessEstimator.method = m }

    /** Apply a persisted/restored noise floor without re-emitting a calibration result. */
    fun setNoiseFloor(v: Float) { noiseFloor = v.coerceIn(0f, 0.2f) }

    /**
     * Begin a ~2 s ambient capture; the user should stay quiet. On completion the
     * measured floor raises the silence/voicing gate (so room noise stops triggering
     * false alerts) and is emitted via [calibratedFloor] for persistence.
     */
    fun startCalibration() {
        synchronized(lifecycleLock) {
            if (!isRunning || _calibrating.value) return
            calSum = 0.0; calMax = 0f; calCount = 0
            calFramesLeft = CAL_FRAMES
            _calibrating.value = true
        }
    }

    /** 0..1 trust from SNR(dB): 0 at/below the yellow edge, 1 at/above the green edge. */
    private fun trustFromSnrDb(db: Float): Float {
        val lo = DspConstants.SNR_YELLOW_DB.toFloat()
        val hi = DspConstants.SNR_GREEN_DB.toFloat()
        return ((db - lo) / (hi - lo)).coerceIn(0f, 1f)
    }

    /**
     * Starts one capture generation. Repeated calls are idempotent. If an earlier
     * capture has not released within the bounded stop wait, a replacement is refused
     * rather than allowing two recorders to own the microphone.
     */
    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        val newThread: Thread
        synchronized(lifecycleLock) {
            if (stopping) return false
            thread?.takeIf { !it.isAlive }?.let { thread = null }
            if (thread?.isAlive == true) {
                return _state.value == WearMicState.STARTING || _state.value == WearMicState.RUNNING
            }
            val generation = generationCounter.incrementAndGet()
            activeGeneration = generation
            pendingStartCount = 1
            _lastError.value = null
            _state.value = WearMicState.STARTING
            newThread = Thread({ runCapture(generation) }, "WearMic-$generation").also {
                it.isDaemon = true
                thread = it
            }
        }
        newThread.start()
        return true
    }

    private fun runCapture(generation: Long) {
        var ownedCapture: WearAudioCapture? = null
        try {
            val localCapture = captureFactory.create()
            ownedCapture = localCapture
            synchronized(lifecycleLock) {
                if (!isCurrent(generation)) return
                capture = localCapture
                liveCaptureCount = 1
                pendingStartCount = 0
            }
            check(localCapture.initialized) { "Wear microphone failed to initialize" }

            val buf = ShortArray(localCapture.bufferSamples)
            val frame = FloatArray(PITCH_FRAME)
            var smoothed = 0f
            pitch.reset()
            brightnessEstimator.reset()
            snrDbSmoothed = DspConstants.SNR_GREEN_DB.toFloat()
            localCapture.start()
            synchronized(lifecycleLock) {
                if (!isCurrent(generation)) return
                _state.value = WearMicState.RUNNING
            }

            while (isCurrent(generation) && !Thread.currentThread().isInterrupted) {
                val n = localCapture.read(buf)
                if (!isCurrent(generation)) break
                check(n >= 0) { "Wear microphone disconnected (read error $n)" }
                if (n > 0) {
                    synchronized(lifecycleLock) {
                        if (!isCurrent(generation)) return@synchronized
                        var sum = 0.0
                        for (i in 0 until n) {
                            val v = buf[i] / 32768.0
                            sum += v * v
                        }
                        val rms = sqrt(sum / n).toFloat()
                        // Light attack/release smoothing so the meter isn't jittery.
                        smoothed += (rms - smoothed) * 0.35f
                        _level.value = smoothed

                        // Per-room calibration: while capturing, fold each read's RMS
                        // into the ambient estimate; finish once enough quiet frames seen.
                        if (calFramesLeft > 0) {
                            calSum += rms; if (rms > calMax) calMax = rms; calCount++
                            calFramesLeft--
                            if (calFramesLeft == 0 && calCount > 0) {
                                val mean = (calSum / calCount).toFloat()
                                val floor = maxOf(mean * 1.8f, calMax * 1.2f)
                                    .coerceIn(0.004f, 0.08f)
                                noiseFloor = floor
                                _calibratedFloor.value = floor
                                _calibrating.value = false
                            }
                        }
                        // Calibrated gate: never below the built-in floor, raised to sit
                        // above measured room noise so silence stays silent.
                        val noiseGate = maxOf(BASE_GATE, noiseFloor * 1.5f)

                        // YIN on the most recent PITCH_FRAME samples of this read.
                        if (n >= PITCH_FRAME) {
                            val start = n - PITCH_FRAME
                            var frameSum = 0.0
                            for (i in 0 until PITCH_FRAME) {
                                val s = (buf[start + i] / 32768.0).toFloat()
                                frame[i] = s
                                frameSum += (s * s).toDouble()
                            }
                            // Frame-local RMS so the DSP silence gate matches the exact
                            // samples being analysed (not the whole read buffer).
                            val frameRms = sqrt(frameSum / PITCH_FRAME).toFloat()
                            // Per-frame broadband a-posteriori SNR: frame energy vs the
                            // calibrated ambient floor. Held at the optimistic default until a
                            // floor exists, so it never flashes "noisy" during calibration.
                            if (!_calibrating.value && noiseFloor > 0f) {
                                val snr = (20.0 * log10(maxOf(frameRms, 1e-6f) / maxOf(noiseFloor, BASE_GATE))).toFloat()
                                snrDbSmoothed += (snr - snrDbSmoothed) * 0.2f
                                _snrDb.value = snrDbSmoothed
                                _snrConfidence.value = trustFromSnrDb(snrDbSmoothed)
                            }
                            // Below the calibrated floor (or mid-calibration) → treat as
                            // silence so room noise can't read as voiced.
                            val gated = frameRms < noiseGate || _calibrating.value
                            val hz = if (gated) 0f else pitch.detect(frame, frameRms)
                            _pitchHz.value = hz
                            _pitchConfidence.value = if (gated) 0f else pitch.confidence

                            // Brightness reuses the same frame; only updates on a
                            // confidently-voiced frame, otherwise coasts + decays.
                            val voiced = hz > 0f && pitch.confidence > 0.4f
                            _spectralBrightness.value = brightnessEstimator.detect(frame, frameRms, voiced)
                            _spectralBrightnessConfidence.value = brightnessEstimator.confidence
                            _f1Hz.value = brightnessEstimator.f1Hz
                            _f2Hz.value = brightnessEstimator.f2Hz
                        }
                    }
                }
            }
        } catch (error: Throwable) {
            synchronized(lifecycleLock) {
                if (isCurrent(generation)) {
                    activeGeneration = generationCounter.incrementAndGet()
                    _lastError.value = error.message ?: error::class.java.simpleName
                    _state.value = WearMicState.FAILED
                }
            }
        } finally {
            try { ownedCapture?.stop() } catch (_: Throwable) {}
            try { ownedCapture?.release() } catch (_: Throwable) {}
            synchronized(lifecycleLock) {
                if (capture === ownedCapture) capture = null
                liveCaptureCount = 0
                pendingStartCount = 0
                if (thread === Thread.currentThread()) thread = null
            }
        }
    }

    /** Invalidates callbacks first, then unblocks and releases the generation owner. */
    fun stop() {
        val ownedCapture: WearAudioCapture?
        val ownedThread: Thread?
        synchronized(lifecycleLock) {
            if (stopping) return
            stopping = true
            activeGeneration = generationCounter.incrementAndGet()
            _state.value = WearMicState.IDLE
            _lastError.value = null
            ownedCapture = capture
            ownedThread = thread
        }
        try {
            try { ownedCapture?.stop() } catch (_: Throwable) {}
            ownedThread?.interrupt()
            if (ownedThread !== Thread.currentThread()) {
                try { ownedThread?.join(joinTimeoutMs) }
                catch (_: InterruptedException) { Thread.currentThread().interrupt() }
            }
        } finally {
            synchronized(lifecycleLock) {
                if (thread === ownedThread && ownedThread?.isAlive == false) thread = null
                resetPublishedValues()
                stopping = false
            }
        }
    }

    /** Safe for tests and a developer diagnostics panel; does not retain resources. */
    fun resourceSnapshot(): WearMicResourceSnapshot = synchronized(lifecycleLock) {
        WearMicResourceSnapshot(
            generation = activeGeneration,
            state = _state.value,
            audioRecorders = liveCaptureCount,
            captureThreads = if (thread?.isAlive == true) 1 else 0,
            pendingStarts = pendingStartCount,
            calibrationCaptures = if (_calibrating.value) 1 else 0,
        )
    }

    private fun isCurrent(generation: Long): Boolean = activeGeneration == generation

    private fun resetPublishedValues() {
        calFramesLeft = 0
        _calibrating.value = false
        _level.value = 0f
        _pitchHz.value = 0f
        _pitchConfidence.value = 0f
        _spectralBrightness.value = 0.5f
        _spectralBrightnessConfidence.value = 0f
        _f1Hz.value = 0f
        _f2Hz.value = 0f
        _snrDb.value = DspConstants.SNR_GREEN_DB.toFloat()
        _snrConfidence.value = 1f
        snrDbSmoothed = DspConstants.SNR_GREEN_DB.toFloat()
    }

    private companion object {
        /** ~64 ms window at 16 kHz — enough for ≥2 periods down to ~30 Hz. */
        const val PITCH_FRAME = 1024

        /** Built-in silence gate (RMS) used when uncalibrated; matches the DSP floor. */
        const val BASE_GATE = 0.012f

        /** ~2 s of ~100 ms reads — the quiet-capture window for calibration. */
        const val CAL_FRAMES = 20
    }
}
