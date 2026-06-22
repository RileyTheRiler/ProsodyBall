package com.voxarcade.wear

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Native resonance / "brightness" estimator (milestone 4) — the second biofeedback
 * metric after pitch. A compact Kotlin port of the canonical web DSP's resonance
 * idea (`app.js` Stage-2 formant/resonance), adapted for the watch:
 *
 *   - Hann-window + radix-2 FFT of one capture frame (no external DSP lib).
 *   - Resonance score (0..1) from spectral *tilt* (high-band vs low-band energy) and
 *     the spectral *centroid* — both robust correlates of a forward/bright vs dark
 *     vocal resonance, and far cheaper/steadier on a noisy chest mic than tracking
 *     raw formants frame-to-frame.
 *   - F1/F2 peak-picks on a smoothed magnitude envelope, exposed only for the UI
 *     readout (so the user can see formants), not for the score itself.
 *
 * Output is EMA-smoothed (faster when [confidence] is high) and only updates on
 * confidently-voiced frames; otherwise it coasts and drops [confidence] so the
 * alert loop stays silent — mirroring the web engine's behaviour.
 */
class ResonanceEstimator(private val sampleRate: Int = 16_000) {

    /** 0..1 brightness: 0 = dark/low resonance, 1 = bright/forward. Neutral 0.5 at rest. */
    var resonance: Float = 0.5f
        private set

    /** 0 = unreliable, 1 = confident (enough high-band content + a clear F2). */
    var confidence: Float = 0f
        private set

    /** First/second formant estimates in Hz for the readout (0 when not found). */
    var f1Hz: Float = 0f
        private set
    var f2Hz: Float = 0f
        private set

    private var size = 0
    private lateinit var window: FloatArray
    private lateinit var re: FloatArray
    private lateinit var im: FloatArray
    private lateinit var mag: FloatArray   // magnitude, 0..N/2
    private lateinit var env: FloatArray   // smoothed magnitude envelope

    fun reset() {
        resonance = 0.5f
        confidence = 0f
        f1Hz = 0f
        f2Hz = 0f
    }

    /**
     * Update from one [frame] of normalized (-1..1) samples. [rms] gates silence and
     * [voiced] gates to confidently-pitched frames (the caller's YIN decision).
     * Returns the smoothed resonance 0..1.
     */
    fun detect(frame: FloatArray, rms: Float, voiced: Boolean): Float {
        val n = frame.size
        if (!voiced || rms < 0.012f || !isPowerOfTwo(n)) {
            confidence *= 0.9f      // decay so a stale value can't keep an alert alive
            return resonance
        }
        ensure(n)

        for (i in 0 until n) {
            re[i] = frame[i] * window[i]
            im[i] = 0f
        }
        fft(re, im)

        val half = n / 2
        val binHz = sampleRate.toFloat() / n
        var total = 0.0
        for (k in 0 until half) {
            val m = sqrt(re[k] * re[k] + im[k] * im[k])
            mag[k] = m
            total += m.toDouble()
        }
        if (total < 1e-6) { confidence *= 0.9f; return resonance }

        // --- Spectral tilt: high-band vs low-band energy (forward/bright cue) ---
        val low = bandEnergy(80f, 1200f, binHz, half)
        val high = bandEnergy(1500f, 5000f, binHz, half)
        val tiltDenom = low + high
        val tilt = if (tiltDenom > 1e-9) (high / tiltDenom).toFloat() else 0f

        // --- Spectral centroid (Hz) -> 0..1 over a speech-relevant span ---
        var cNum = 0.0
        var cDen = 0.0
        for (k in 1 until half) {
            val f = k * binHz
            cNum += f * mag[k]
            cDen += mag[k]
        }
        val centroid = if (cDen > 0) (cNum / cDen).toFloat() else 0f
        val centroidScore = norm(centroid, 700f, 2200f)

        // --- Formant peaks on a smoothed envelope — the actual resonance cue ---
        smoothEnvelope(half)
        f1Hz = peakHzInBand(250f, 1000f, binHz, half)
        f2Hz = peakHzInBand(900f, 2800f, binHz, half)

        // Formant-based score: higher F1/F2 = brighter/more forward resonance. This
        // mirrors the web engine's F1/F2 weighting (F2 dominant) and is the proper
        // resonance cue; tilt+centroid stabilize it on a noisy chest mic and stand in
        // when a formant isn't cleanly found.
        val f1Found = f1Hz in 250f..1100f
        val f2Found = f2Hz in 900f..2800f
        val f1Score = norm(f1Hz, 300f, 900f)
        val f2Score = norm(f2Hz, 1100f, 2300f)
        val formantScore = when {
            f1Found && f2Found -> 0.4f * f1Score + 0.6f * f2Score
            f2Found -> f2Score
            f1Found -> f1Score
            else -> -1f // no reliable formant this frame
        }

        val brightness = (0.55f * tilt + 0.45f * centroidScore).coerceIn(0f, 1f)
        val raw = if (formantScore < 0f) brightness
                  else (0.65f * formantScore + 0.35f * brightness).coerceIn(0f, 1f)

        // Confidence: real high-band SNR AND a clean F2 (the dominant resonance cue).
        val snr = (high / (low + 1e-9)).toFloat()
        confidence = (min(1f, snr * 1.6f) * (if (f2Found) 1f else 0.4f)).coerceIn(0f, 1f)

        resonance += (raw - resonance) * (0.08f + 0.12f * confidence)
        return resonance
    }

    // ---- internals ---------------------------------------------------------

    private fun ensure(n: Int) {
        if (n == size) return
        size = n
        window = FloatArray(n) { (0.5 - 0.5 * cos(2.0 * PI * it / (n - 1))).toFloat() } // Hann
        re = FloatArray(n)
        im = FloatArray(n)
        mag = FloatArray(n / 2)
        env = FloatArray(n / 2)
    }

    private fun bandEnergy(loHz: Float, hiHz: Float, binHz: Float, half: Int): Double {
        val lo = (loHz / binHz).toInt().coerceIn(0, half - 1)
        val hi = (hiHz / binHz).toInt().coerceIn(lo, half - 1)
        var sum = 0.0
        for (k in lo..hi) sum += mag[k].toDouble()
        return sum
    }

    /** 3-tap moving average of [mag] into [env] to tame per-harmonic spikiness. */
    private fun smoothEnvelope(half: Int) {
        for (k in 0 until half) {
            var s = mag[k]
            var c = 1
            if (k > 0) { s += mag[k - 1]; c++ }
            if (k < half - 1) { s += mag[k + 1]; c++ }
            env[k] = s / c
        }
    }

    private fun peakHzInBand(loHz: Float, hiHz: Float, binHz: Float, half: Int): Float {
        val lo = (loHz / binHz).toInt().coerceIn(1, half - 1)
        val hi = (hiHz / binHz).toInt().coerceIn(lo, half - 1)
        var bestK = -1
        var bestV = 0f
        for (k in lo..hi) if (env[k] > bestV) { bestV = env[k]; bestK = k }
        if (bestK < 1 || bestK >= half - 1) return if (bestK >= 0) bestK * binHz else 0f
        // Parabolic interpolation for sub-bin accuracy.
        val a = env[bestK - 1]; val b = env[bestK]; val c = env[bestK + 1]
        val denom = (a - 2 * b + c)
        val offset = if (kotlin.math.abs(denom) > 1e-9f) 0.5f * (a - c) / denom else 0f
        return (bestK + offset) * binHz
    }

    private fun norm(v: Float, lo: Float, hi: Float): Float =
        ((v - lo) / (hi - lo)).coerceIn(0f, 1f)

    private fun isPowerOfTwo(x: Int): Boolean = x > 0 && (x and (x - 1)) == 0

    /** In-place iterative radix-2 Cooley–Tukey FFT. [re]/[im] length must be a power of two. */
    private fun fft(re: FloatArray, im: FloatArray) {
        val n = re.size
        // Bit-reversal permutation.
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) { j = j xor bit; bit = bit shr 1 }
            j = j or bit
            if (i < j) {
                val tr = re[i]; re[i] = re[j]; re[j] = tr
                val ti = im[i]; im[i] = im[j]; im[j] = ti
            }
        }
        var len = 2
        while (len <= n) {
            val ang = -2.0 * PI / len
            val wLenRe = cos(ang).toFloat()
            val wLenIm = sin(ang).toFloat()
            var i = 0
            while (i < n) {
                var wRe = 1f
                var wIm = 0f
                val halfLen = len / 2
                for (k in 0 until halfLen) {
                    val ik = i + k
                    val jk = i + k + halfLen
                    val vRe = re[jk] * wRe - im[jk] * wIm
                    val vIm = re[jk] * wIm + im[jk] * wRe
                    re[jk] = re[ik] - vRe
                    im[jk] = im[ik] - vIm
                    re[ik] += vRe
                    im[ik] += vIm
                    val nwRe = wRe * wLenRe - wIm * wLenIm
                    wIm = wRe * wLenIm + wIm * wLenRe
                    wRe = nwRe
                }
                i += len
            }
            len = len shl 1
        }
    }
}
