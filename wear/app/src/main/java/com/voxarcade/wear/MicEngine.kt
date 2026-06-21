package com.voxarcade.wear

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlin.math.sqrt

/**
 * Minimal native microphone capture for the no-WebView Wear OS app (milestone 1).
 *
 * Reads PCM frames from [AudioRecord] on a background thread and publishes a
 * smoothed input level (0..1) as a [StateFlow] the UI can observe. This exists to
 * prove the native foundation — mic capture + a live signal — runs on the Galaxy
 * Watch 7 where the old WebView shell could not. Pitch/resonance DSP (milestone 2)
 * will consume the same frames; only the level meter is wired up for now.
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

    private val pitch = PitchDetector(sampleRate)

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
                            for (i in 0 until PITCH_FRAME) {
                                frame[i] = (buf[start + i] / 32768.0).toFloat()
                            }
                            _pitchHz.value = pitch.detect(frame, rms)
                            _pitchConfidence.value = pitch.confidence
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
    }

    private companion object {
        /** ~64 ms window at 16 kHz — enough for ≥2 periods down to ~30 Hz. */
        const val PITCH_FRAME = 1024
    }
}
