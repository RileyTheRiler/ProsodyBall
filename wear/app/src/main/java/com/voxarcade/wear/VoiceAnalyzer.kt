package com.voxarcade.wear

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Captures the microphone and analyzes the voice on a background thread, posting
 * results to the main thread. Pure on-device DSP (no WebView, no network):
 *
 *   - pitch via YIN (cumulative-mean-normalized difference) with parabolic
 *     interpolation, a median filter, and an octave-jump guard,
 *   - resonance via LPC formant estimation (Levinson-Durbin + spectral-envelope
 *     peak picking) reported as the mean of F1 and F2,
 *   - loudness via RMS (gates analysis so it ignores silence).
 *
 * Frames overlap 50% (hop = frame/2) for smoother, lower-latency tracking. The
 * pitch and formant math was validated against JS prototypes on synthetic tones
 * and vowels (within tens of Hz) before being ported here.
 */
class VoiceAnalyzer(
    private val sampleRate: Int = 16000,
    private val frame: Int = 2048,
) {
    data class Result(
        val voiced: Boolean,
        val pitchHz: Float,
        val resonanceHz: Float,
        val rms: Float,
    )

    /** RMS voicing threshold (sensitivity); lower = picks up quieter speech. */
    @Volatile var voiceGate: Float = 0.012f

    private val hop = frame / 2
    private val main = Handler(Looper.getMainLooper())

    @Volatile private var running = false
    private var thread: Thread? = null

    private val pitchHistory = ArrayDeque<Float>()
    private var resonanceEma = 0f

    // LPC config + precomputed envelope trig tables.
    private val lpcOrder = 16
    private val envGrid = 256
    private val envCos = Array(envGrid) { DoubleArray(lpcOrder + 1) }
    private val envSin = Array(envGrid) { DoubleArray(lpcOrder + 1) }

    init {
        for (g in 0 until envGrid) {
            val w = Math.PI * g / (envGrid - 1)
            for (k in 0..lpcOrder) {
                envCos[g][k] = cos(-w * k)
                envSin[g][k] = sin(-w * k)
            }
        }
    }

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
            val window = FloatArray(frame)
            val incoming = ShortArray(hop)
            var filled = 0
            while (running) {
                var read = 0
                while (read < hop && running) {
                    val r = record.read(incoming, read, hop - read)
                    if (r <= 0) break
                    read += r
                }
                if (read < hop) continue

                // Slide the window left by one hop and append the new samples.
                System.arraycopy(window, hop, window, 0, frame - hop)
                for (i in 0 until hop) window[frame - hop + i] = incoming[i] / 32768f
                if (filled < frame) { filled += hop; if (filled < frame) continue }

                var sumSq = 0.0
                for (i in 0 until frame) sumSq += (window[i] * window[i]).toDouble()
                val rms = sqrt(sumSq / frame).toFloat()
                val voiced = rms > voiceGate

                var pitch = 0f
                var resonance = resonanceEma
                if (voiced) {
                    pitch = smoothPitch(yin(window))
                    resonance = smoothResonance(formantResonance(window))
                }
                val result = Result(voiced && pitch > 0f, pitch, resonance, rms)
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
        resonanceEma = 0f
    }

    // ---- pitch (YIN) --------------------------------------------------------

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

    private fun smoothPitch(raw: Float): Float {
        if (raw <= 0f) return 0f
        var p = raw
        val med = currentMedian()
        if (med > 0f) {
            // Snap obvious octave errors back toward the running median.
            val ratio = (ln(p / med) / LN2).toFloat()
            if (abs(ratio - 1f) < 0.15f) p *= 0.5f
            else if (abs(ratio + 1f) < 0.15f) p *= 2f
        }
        pitchHistory.addLast(p)
        while (pitchHistory.size > 5) pitchHistory.removeFirst()
        return currentMedian()
    }

    private fun currentMedian(): Float {
        if (pitchHistory.isEmpty()) return 0f
        val s = pitchHistory.sorted()
        return s[s.size / 2]
    }

    // ---- resonance (LPC formants) -------------------------------------------

    private val pre = FloatArray(frame)

    private fun formantResonance(buf: FloatArray): Float {
        // Pre-emphasis + Hamming window.
        for (i in 0 until frame) {
            val emph = if (i > 0) buf[i] - 0.97f * buf[i - 1] else buf[i]
            val win = 0.54f - 0.46f * cos(2.0 * Math.PI * i / (frame - 1)).toFloat()
            pre[i] = emph * win
        }
        // Autocorrelation.
        val r = DoubleArray(lpcOrder + 1)
        for (lag in 0..lpcOrder) {
            var s = 0.0
            for (i in lag until frame) s += (pre[i] * pre[i - lag]).toDouble()
            r[lag] = s
        }
        if (r[0] <= 0.0) return 0f
        // Levinson-Durbin recursion → LPC coefficients a[0..order].
        val a = DoubleArray(lpcOrder + 1)
        val tmp = DoubleArray(lpcOrder + 1)
        a[0] = 1.0
        var err = r[0]
        for (i in 1..lpcOrder) {
            var acc = r[i]
            for (j in 1 until i) acc += a[j] * r[i - j]
            val k = -acc / err
            for (j in 0..i) tmp[j] = a[j]
            for (j in 1..i) a[j] = tmp[j] + k * tmp[i - j]
            err *= (1 - k * k)
            if (err <= 0) break
        }
        // Spectral envelope |1/A(e^jw)|; pick the first two peaks as F1, F2.
        var f1 = 0f
        var f2 = 0f
        var prevMag = 0.0
        var prevPrev = 0.0
        for (g in 0 until envGrid) {
            var re = 0.0
            var im = 0.0
            val cg = envCos[g]
            val sg = envSin[g]
            for (k in 0..lpcOrder) {
                re += a[k] * cg[k]
                im += a[k] * sg[k]
            }
            val mag = 1.0 / sqrt(re * re + im * im)
            if (g >= 2 && prevMag > prevPrev && prevMag >= mag) {
                val freq = ((g - 1).toDouble() / (envGrid - 1) * (sampleRate / 2.0)).toFloat()
                if (freq in 200f..5000f) {
                    if (f1 == 0f) f1 = freq
                    else if (f2 == 0f) { f2 = freq; break }
                }
            }
            prevPrev = prevMag
            prevMag = mag
        }
        return when {
            f1 > 0f && f2 > 0f -> (f1 + f2) / 2f
            f1 > 0f -> f1
            else -> 0f
        }
    }

    private fun smoothResonance(value: Float): Float {
        if (value <= 0f) return resonanceEma
        resonanceEma = if (resonanceEma <= 0f) value else resonanceEma * 0.7f + value * 0.3f
        return resonanceEma
    }

    companion object {
        private val LN2 = ln(2.0)
    }
}
