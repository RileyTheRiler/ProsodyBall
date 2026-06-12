package com.prosodyball.wear.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.atomic.AtomicLong

/**
 * Continuous microphone capture feeding the analyzer in ~16ms hops.
 *
 * Uses VOICE_RECOGNITION to avoid vendor AGC/noise-suppression fighting the
 * analyzer's own calibration (the analyzer learns the noise floor itself, and
 * AGC would corrupt the volume metric). PCM float mono at 16kHz: every
 * analysis band the DSP uses fits below the 8kHz Nyquist, and it matches
 * Bluetooth SCO wideband so both mic paths run the identical pipeline.
 */
class AudioCaptureEngine(
    private val sampleRate: Int = 16_000,
    private val hopSize: Int = 256,
    private val onHop: (samples: FloatArray, count: Int, dt: Double) -> Unit,
) {
    private var thread: Thread? = null
    @Volatile
    private var running = false

    /** Capture is suppressed until this uptime (ms) — set while cues play. */
    private val muteUntilMillis = AtomicLong(0)

    val isRunning: Boolean get() = running

    /** Suppress analysis for [durationMillis] so speaker cues don't feed back into metrics. */
    fun muteFor(durationMillis: Long) {
        val until = SystemClock.uptimeMillis() + durationMillis
        muteUntilMillis.updateAndGet { maxOf(it, until) }
    }

    @SuppressLint("MissingPermission") // RECORD_AUDIO checked by MainActivity before start
    fun start(): Boolean {
        if (running) return true
        val minBuffer = AudioRecord.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_FLOAT,
        )
        if (minBuffer <= 0) {
            Log.e(TAG, "AudioRecord.getMinBufferSize failed: $minBuffer")
            return false
        }
        val record = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_FLOAT,
                maxOf(minBuffer, hopSize * 8 * 4),
            )
        } catch (e: IllegalArgumentException) {
            Log.e(TAG, "AudioRecord init failed", e)
            return false
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord not initialized")
            record.release()
            return false
        }

        running = true
        thread = Thread({
            val chunk = FloatArray(hopSize)
            val silentChunk = FloatArray(hopSize)
            val dt = hopSize.toDouble() / sampleRate
            record.startRecording()
            try {
                while (running) {
                    var filled = 0
                    while (filled < hopSize && running) {
                        val n = record.read(chunk, filled, hopSize - filled, AudioRecord.READ_BLOCKING)
                        if (n <= 0) {
                            Log.w(TAG, "AudioRecord.read returned $n")
                            Thread.sleep(20)
                            break
                        }
                        filled += n
                    }
                    if (filled == hopSize) {
                        // While a cue is playing, feed silence so the analyzer's
                        // clock advances but the cue audio never reaches metrics.
                        val muted = SystemClock.uptimeMillis() < muteUntilMillis.get()
                        onHop(if (muted) silentChunk else chunk, hopSize, dt)
                    }
                }
            } finally {
                try {
                    record.stop()
                } catch (_: IllegalStateException) {
                }
                record.release()
            }
        }, "prosody-capture").apply {
            priority = Thread.MAX_PRIORITY
            start()
        }
        return true
    }

    fun stop() {
        running = false
        thread?.join(1000)
        thread = null
    }

    private companion object {
        const val TAG = "AudioCaptureEngine"
    }
}
