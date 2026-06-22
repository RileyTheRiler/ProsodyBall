package com.voxarcade.wear

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Minimal native microphone engine (M1). Opens an [AudioRecord] on a background
 * thread, reads 16-bit PCM mono frames, and publishes a smoothed 0..1 input
 * level so the UI can prove the no-WebView foundation actually captures audio on
 * the watch. Pitch/resonance DSP lands on top of this loop in later milestones.
 */
class AudioEngine {

    /** Smoothed input level, 0 (silence) .. 1 (loud). Observed by the UI. */
    val level: StateFlow<Float> get() = _level
    private val _level = MutableStateFlow(0f)

    /** True while the capture loop is running and the mic is open. */
    val running: StateFlow<Boolean> get() = _running
    private val _running = MutableStateFlow(false)

    /** Non-null when the last start() failed, so the UI can explain why. */
    val error: StateFlow<String?> get() = _error
    private val _error = MutableStateFlow<String?>(null)

    @Volatile private var keepGoing = false
    private var thread: Thread? = null

    fun start() {
        if (thread != null) return
        keepGoing = true
        _error.value = null
        thread = Thread({ runLoop() }, "vox-audio").also { it.start() }
    }

    fun stop() {
        keepGoing = false
        thread?.join(300)
        thread = null
        _running.value = false
        _level.value = 0f
    }

    @SuppressLint("MissingPermission") // caller starts the engine only after RECORD_AUDIO is granted
    private fun runLoop() {
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        if (minBuf <= 0) {
            _error.value = "Mic unavailable on this device."
            return
        }
        // A ~100 ms buffer keeps latency low while leaving headroom over the minimum.
        val bufSamples = maxOf(minBuf / 2, SAMPLE_RATE / 10)
        val record = try {
            AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, CHANNEL, ENCODING, bufSamples * 2)
        } catch (e: SecurityException) {
            _error.value = "Microphone permission denied."
            return
        } catch (e: IllegalArgumentException) {
            _error.value = "Could not open the microphone."
            return
        }

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            _error.value = "Microphone failed to initialize."
            return
        }

        val buffer = ShortArray(bufSamples)
        try {
            record.startRecording()
            _running.value = true
            while (keepGoing) {
                val n = record.read(buffer, 0, buffer.size)
                if (n <= 0) continue
                _level.value = smooth(_level.value, rms01(buffer, n))
            }
        } catch (e: IllegalStateException) {
            _error.value = "Microphone read failed."
        } finally {
            try { record.stop() } catch (_: Exception) {}
            record.release()
            _running.value = false
            _level.value = 0f
        }
    }

    companion object {
        private const val SAMPLE_RATE = 16_000
        private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT

        /** Root-mean-square of the frame, mapped to a roughly perceptual 0..1 level. */
        private fun rms01(buf: ShortArray, n: Int): Float {
            var sumSq = 0.0
            for (i in 0 until n) {
                val s = buf[i] / 32768.0
                sumSq += s * s
            }
            val rms = sqrt(sumSq / n)
            // ~ -50 dBFS floor .. 0 dBFS ceiling, normalized into 0..1.
            val db = 20.0 * Math.log10(rms + 1e-9)
            return min(1.0, maxOf(0.0, (db + 50.0) / 50.0)).toFloat()
        }

        /** Asymmetric smoothing: snap up to transients, ease down so the bar reads cleanly. */
        private fun smooth(prev: Float, next: Float): Float {
            val a = if (next > prev) 0.6f else 0.2f
            return prev + (next - prev) * a
        }
    }
}
