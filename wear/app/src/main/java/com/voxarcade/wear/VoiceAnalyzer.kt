package com.voxarcade.wear

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import kotlin.math.cos
import kotlin.math.sqrt

/**
 * Captures the microphone and analyzes the voice on a background thread, posting
 * results to the main thread. Pure on-device DSP (no WebView, no network):
 *
 *   - pitch via the YIN algorithm (cumulative-mean-normalized difference),
 *   - "brightness" via spectral centroid (a resonance proxy),
 *   - loudness via RMS (used to gate analysis so it ignores silence).
 *
 * The pitch/centroid math was validated against a JS prototype on synthetic
 * tones (accurate to a fraction of a Hz) before porting here.
 */
class VoiceAnalyzer(
    private val sampleRate: Int = 16000,
    private val frame: Int = 2048,
) {
    data class Result(
        val voiced: Boolean,
        val pitchHz: Float,
        val brightnessHz: Float,
        val rms: Float,
    )

    private val main = Handler(Looper.getMainLooper())
    private val fft = Fft(frame)

    @Volatile private var running = false
    private var thread: Thread? = null

    private val pitchHistory = ArrayDeque<Float>()
    private var brightnessEma = 0f

    private val re = FloatArray(frame)
    private val im = FloatArray(frame)

    val isRunning: Boolean get() = running

    /** Caller must hold RECORD_AUDIO. Returns false if the mic can't be opened. */
    @SuppressLint("MissingPermission")
    fun start(onResult: (Result) -> Unit): Boolean {
        if (running) return true

        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf <= 0) return false

        val record = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minBuf, frame * 4)
            )
        } catch (e: Exception) {
            return false
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            return false
        }

        running = true
        record.startRecording()
        thread = Thread {
            val shorts = ShortArray(frame)
            val buf = FloatArray(frame)
            while (running) {
                var read = 0
                while (read < frame && running) {
                    val r = record.read(shorts, read, frame - read)
                    if (r <= 0) break
                    read += r
                }
                if (read < frame) continue

                var sumSq = 0.0
                for (i in 0 until frame) {
                    val v = shorts[i] / 32768f
                    buf[i] = v
                    sumSq += (v * v).toDouble()
                }
                val rms = sqrt(sumSq / frame).toFloat()
                val voiced = rms > VOICE_GATE

                var pitch = 0f
                var brightness = brightnessEma
                if (voiced) {
                    pitch = smoothPitch(yin(buf))
                    brightness = smoothBrightness(centroid(buf))
                }
                val result = Result(voiced && pitch > 0f, pitch, brightness, rms)
                main.post { onResult(result) }
            }
            try {
                record.stop()
            } catch (_: Exception) {
            }
            record.release()
        }.apply {
            priority = Thread.MAX_PRIORITY
            start()
        }
        return true
    }

    fun stop() {
        running = false
        thread?.join(500)
        thread = null
        pitchHistory.clear()
        brightnessEma = 0f
    }

    // ---- DSP ----------------------------------------------------------------

    private fun yin(buf: FloatArray, threshold: Float = 0.12f): Float {
        val w = buf.size / 2
        val diff = FloatArray(w)
        for (tau in 0 until w) {
            var sum = 0f
            for (j in 0 until w) {
                val d = buf[j] - buf[j + tau]
                sum += d * d
            }
            diff[tau] = sum
        }
        val cmnd = FloatArray(w)
        cmnd[0] = 1f
        var running = 0f
        for (tau in 1 until w) {
            running += diff[tau]
            cmnd[tau] = if (running > 0f) diff[tau] * tau / running else 1f
        }
        var tauEst = -1
        var tau = 2
        while (tau < w) {
            if (cmnd[tau] < threshold) {
                while (tau + 1 < w && cmnd[tau + 1] < cmnd[tau]) tau++
                tauEst = tau
                break
            }
            tau++
        }
        if (tauEst == -1) return 0f

        var betterTau = tauEst.toFloat()
        if (tauEst in 1 until w - 1) {
            val s0 = cmnd[tauEst - 1]
            val s1 = cmnd[tauEst]
            val s2 = cmnd[tauEst + 1]
            val denom = 2f * (2f * s1 - s2 - s0)
            if (denom != 0f) betterTau = tauEst + (s2 - s0) / denom
        }
        val f = sampleRate / betterTau
        return if (f in 70f..400f) f else 0f
    }

    private fun centroid(buf: FloatArray): Float {
        for (i in 0 until frame) {
            val window = 0.5f - 0.5f * cos(2.0 * Math.PI * i / (frame - 1)).toFloat()
            re[i] = buf[i] * window
            im[i] = 0f
        }
        fft.transform(re, im)
        var num = 0.0
        var den = 0.0
        val half = frame / 2
        for (k in 1 until half) {
            val mag = sqrt((re[k] * re[k] + im[k] * im[k]).toDouble())
            val freq = k.toDouble() * sampleRate / frame
            num += freq * mag
            den += mag
        }
        return if (den > 0) (num / den).toFloat() else 0f
    }

    private fun smoothPitch(p: Float): Float {
        if (p <= 0f) return 0f
        pitchHistory.addLast(p)
        while (pitchHistory.size > 5) pitchHistory.removeFirst()
        val sorted = pitchHistory.sorted()
        return sorted[sorted.size / 2]
    }

    private fun smoothBrightness(b: Float): Float {
        brightnessEma = if (brightnessEma <= 0f) b else brightnessEma * 0.7f + b * 0.3f
        return brightnessEma
    }

    companion object {
        // RMS threshold (on normalized -1..1 samples) below which we treat the
        // frame as silence and skip analysis — so it won't buzz on quiet/no speech.
        private const val VOICE_GATE = 0.012f
    }
}
