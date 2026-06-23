package com.voxarcade.wear

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlin.math.log10
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
    private val resonanceEstimator = ResonanceEstimator(sampleRate)

    @Volatile private var running = false
    private var thread: Thread? = null

    // Per-room calibration state (milestone 8).
    @Volatile private var noiseFloor = 0f      // calibrated ambient RMS (0 = uncalibrated)
    @Volatile private var calFramesLeft = 0    // reads remaining in an active capture
    private var calSum = 0.0
    private var calMax = 0f
    private var calCount = 0
    private var snrDbSmoothed = DspConstants.SNR_GREEN_DB.toFloat() // capture-thread SNR EMA

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

    /** 0..1 trust from SNR(dB): 0 at/below the yellow edge, 1 at/above the green edge. */
    private fun trustFromSnrDb(db: Float): Float {
        val lo = DspConstants.SNR_YELLOW_DB.toFloat()
        val hi = DspConstants.SNR_GREEN_DB.toFloat()
        return ((db - lo) / (hi - lo)).coerceIn(0f, 1f)
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
            pitch.reset()
            resonanceEstimator.reset()
            snrDbSmoothed = DspConstants.SNR_GREEN_DB.toFloat()
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

                            // Resonance reuses the same frame; only updates on a
                            // confidently-voiced frame, otherwise coasts + decays.
                            val voiced = hz > 0f && pitch.confidence > 0.4f
                            _resonance.value = resonanceEstimator.detect(frame, frameRms, voiced)
                            _resonanceConfidence.value = resonanceEstimator.confidence
                            _f1Hz.value = resonanceEstimator.f1Hz
                            _f2Hz.value = resonanceEstimator.f2Hz
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
        _level.value = 0f
        _pitchHz.value = 0f
        _pitchConfidence.value = 0f
        _resonance.value = 0.5f
        _resonanceConfidence.value = 0f
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
