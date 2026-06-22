package com.voxarcade.wear

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlin.math.sqrt

/**
 * Native microphone capture + DSP for the no-WebView Wear OS app.
 *
 * Reads PCM frames from [AudioRecord] on a background thread and publishes, as
 * [StateFlow]s the UI observes: input level, YIN [pitchHz]/[pitchConfidence]
 * (milestone 2), and FFT [resonance]/[resonanceConfidence] with [f1Hz]/[f2Hz]
 * (milestone 4). All DSP runs on the same capture frame, so pitch and resonance
 * stay frame-aligned.
 */
class MicEngine {

    private val sampleRate = 16_000

    private val _level = MutableStateFlow(0f)
    val level: StateFlow<Float> = _level

    /** Median-filtered fundamental in Hz (0 when silent/unvoiced). */
    private val _pitchHz = MutableStateFlow(0f)
    val pitchHz: StateFlow<Float> = _pitchHz

    /** Pitch confidence 0..1 from the YIN CMND. */
    private val _pitchConfidence = MutableStateFlow(0f)
    val pitchConfidence: StateFlow<Float> = _pitchConfidence

    /** Resonance / brightness 0..1 (0.5 neutral at rest). */
    private val _resonance = MutableStateFlow(0.5f)
    val resonance: StateFlow<Float> = _resonance

    /** Resonance confidence 0..1 (high-band SNR + a found formant). */
    private val _resonanceConfidence = MutableStateFlow(0f)
    val resonanceConfidence: StateFlow<Float> = _resonanceConfidence

    /** Latest formant estimates in Hz for the readout (0 when not found). */
    private val _f1Hz = MutableStateFlow(0f)
    val f1Hz: StateFlow<Float> = _f1Hz
    private val _f2Hz = MutableStateFlow(0f)
    val f2Hz: StateFlow<Float> = _f2Hz

    /** True while a per-room noise-floor capture is in progress (milestone 8). */
    private val _calibrating = MutableStateFlow(false)
    val calibrating: StateFlow<Boolean> = _calibrating

    /** Emits the freshly measured floor (RMS) when a calibration completes; 0 at rest. */
    private val _calibratedFloor = MutableStateFlow(0f)
    val calibratedFloor: StateFlow<Float> = _calibratedFloor

    /** True while a resonance-baseline capture (sustained vowels) is in progress (M9). */
    private val _calibratingBaseline = MutableStateFlow(false)
    val calibratingBaseline: StateFlow<Boolean> = _calibratingBaseline

    /** Emits the measured baseline resonance % on completion; 0 = failed/too few frames. */
    private val _resonanceBaselineResult = MutableStateFlow(0f)
    val resonanceBaselineResult: StateFlow<Float> = _resonanceBaselineResult

    private val pitch = PitchDetector(sampleRate)
    private val resonanceEstimator = ResonanceEstimator(sampleRate)

    /**
     * DSP decimation (milestone 12 — battery): 1 = analyse every read (~10 Hz, smooth
     * for the visual pitch meter), 2 = every other read (~5 Hz) to roughly halve DSP
     * CPU during eyes-free / screen-off necklace sessions. Audio is still drained every
     * read; only the YIN+FFT analysis is skipped. Full rate is forced during baseline
     * capture. The level meter always updates.
     */
    @Volatile var analysisDecimation = 1

    @Volatile private var running = false
    private var thread: Thread? = null

    // Per-room calibration state (milestone 8).
    @Volatile private var noiseFloor = 0f      // calibrated ambient RMS (0 = uncalibrated)
    @Volatile private var calFramesLeft = 0    // reads remaining in an active capture
    private var calSum = 0.0
    private var calMax = 0f
    private var calCount = 0

    // Resonance-baseline capture state (milestone 9). baseSamples is touched only on
    // the audio thread; the UI thread just sets the volatile countdown + reset flag.
    @Volatile private var baseFramesLeft = 0
    @Volatile private var baseResetPending = false
    private val baseSamples = ArrayList<Float>()

    val isRunning: Boolean get() = running

    /** Switch the resonance measurement method (safe to call while running). */
    fun setResonanceMethod(m: ResonanceMethod) { resonanceEstimator.method = m }

    /** Apply a persisted/restored noise floor without re-emitting a calibration result. */
    fun setNoiseFloor(v: Float) { noiseFloor = v.coerceIn(0f, 0.2f) }

    /**
     * Begin a ~2 s ambient capture; the user should stay quiet. On completion the
     * measured floor raises the silence/voicing gate (so room noise stops triggering
     * false alerts) and is emitted via [calibratedFloor] for persistence.
     */
    fun startCalibration() {
        if (!running || _calibrating.value) return
        calSum = 0.0; calMax = 0f; calCount = 0
        calFramesLeft = CAL_FRAMES
        _calibrating.value = true
    }

    /**
     * Begin a ~5 s resonance-baseline capture (milestone 9): the user sustains a few
     * comfortable vowels. Only stable, confidently-voiced frames are collected; the
     * median becomes the personal baseline used to recenter the Dark/Mid/Bright goal
     * bands. Emitted via [resonanceBaselineResult] (0 if too few stable frames).
     */
    fun startResonanceBaseline() {
        if (!running || _calibratingBaseline.value) return
        baseResetPending = true
        baseFramesLeft = BASELINE_FRAMES
        _calibratingBaseline.value = true
    }

    /** Caller must hold RECORD_AUDIO permission before invoking. */
    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return
        running = true
        thread = Thread {
            val minBuf = AudioRecord.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            if (minBuf <= 0) { running = false; return@Thread }
            // ~100 ms read window, but never smaller than the device minimum.
            val bufSize = maxOf(minBuf, sampleRate / 10 * 2)

            val recorder = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufSize
            )
            if (recorder.state != AudioRecord.STATE_INITIALIZED) {
                recorder.release()
                running = false
                return@Thread
            }

            val buf = ShortArray(bufSize / 2)
            val frame = FloatArray(PITCH_FRAME)
            var smoothed = 0f
            var analysisTick = 0
            pitch.reset()
            resonanceEstimator.reset()
            recorder.startRecording()
            try {
                while (running) {
                    val n = recorder.read(buf, 0, buf.size)
                    if (n > 0) {
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

                        // Analysis cadence: decimate the DSP in low-power mode to save
                        // CPU; full rate during baseline capture and the visual meter.
                        analysisTick++
                        val decim = if (analysisDecimation < 1) 1 else analysisDecimation
                        val runDsp = n >= PITCH_FRAME &&
                            (analysisTick % decim == 0 || _calibratingBaseline.value)
                        if (runDsp) {
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
                            // Below the calibrated floor (or mid-calibration) → treat as
                            // silence so room noise can't read as voiced.
                            val gated = frameRms < noiseGate || _calibrating.value
                            val hz = if (gated) 0f else pitch.detect(frame, frameRms)
                            _pitchHz.value = hz
                            _pitchConfidence.value = if (gated) 0f else pitch.confidence

                            // Resonance reuses the same frame; only updates on a
                            // confidently-voiced frame, otherwise coasts + decays.
                            val voiced = hz > 0f && pitch.confidence > 0.4f
                            _resonance.value = resonanceEstimator.detect(frame, frameRms, voiced)
                            _resonanceConfidence.value = resonanceEstimator.confidence
                            _f1Hz.value = resonanceEstimator.f1Hz
                            _f2Hz.value = resonanceEstimator.f2Hz

                            // Resonance baseline capture: collect only stable, confidently
                            // -voiced frames (sustained vowels), then take the median.
                            if (baseFramesLeft > 0) {
                                if (baseResetPending) { baseSamples.clear(); baseResetPending = false }
                                if (voiced && resonanceEstimator.confidence > 0.55f) {
                                    baseSamples.add(_resonance.value * 100f)
                                }
                                baseFramesLeft--
                                if (baseFramesLeft == 0) {
                                    _resonanceBaselineResult.value = medianOf(baseSamples)
                                    _calibratingBaseline.value = false
                                }
                            }
                        }
                    }
                }
            } finally {
                try { recorder.stop() } catch (_: Exception) {}
                recorder.release()
            }
        }.also { it.isDaemon = true; it.start() }
    }

    fun stop() {
        running = false
        // Join the capture thread (bounded) so its AudioRecord is fully released
        // before a subsequent start() opens a new one — avoids overlapping
        // recorders / ERROR_INVALID_OPERATION on rapid stop→start.
        val t = thread
        thread = null
        try { t?.join(400) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
        calFramesLeft = 0
        _calibrating.value = false
        baseFramesLeft = 0
        _calibratingBaseline.value = false
        _level.value = 0f
        _pitchHz.value = 0f
        _pitchConfidence.value = 0f
        _resonance.value = 0.5f
        _resonanceConfidence.value = 0f
        _f1Hz.value = 0f
        _f2Hz.value = 0f
    }

    /** Median of collected baseline samples; 0 when too few stable frames were seen. */
    private fun medianOf(xs: List<Float>): Float {
        if (xs.size < 8) return 0f
        val s = xs.sorted()
        return s[s.size / 2]
    }

    private companion object {
        /** ~64 ms window at 16 kHz — enough for ≥2 periods down to ~30 Hz. */
        const val PITCH_FRAME = 1024

        /** Built-in silence gate (RMS) used when uncalibrated; matches the DSP floor. */
        const val BASE_GATE = 0.012f

        /** ~2 s of ~100 ms reads — the quiet-capture window for calibration. */
        const val CAL_FRAMES = 20

        /** ~5 s of reads — enough to sustain a few vowels for a baseline. */
        const val BASELINE_FRAMES = 50
    }
}
