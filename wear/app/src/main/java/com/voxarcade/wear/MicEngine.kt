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

    private val pitch = PitchDetector(sampleRate)
    private val resonanceEstimator = ResonanceEstimator(sampleRate)

    @Volatile private var running = false
    private var thread: Thread? = null

    val isRunning: Boolean get() = running

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
                            val hz = pitch.detect(frame, frameRms)
                            _pitchHz.value = hz
                            _pitchConfidence.value = pitch.confidence

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
        _level.value = 0f
        _pitchHz.value = 0f
        _pitchConfidence.value = 0f
        _resonance.value = 0.5f
        _resonanceConfidence.value = 0f
        _f1Hz.value = 0f
        _f2Hz.value = 0f
    }

    private companion object {
        /** ~64 ms window at 16 kHz — enough for ≥2 periods down to ~30 Hz. */
        const val PITCH_FRAME = 1024
    }
}
