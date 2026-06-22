package com.voxarcade.wear

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** How resonance/formants are estimated — mirrors the desktop app's selector. */
enum class ResonanceMethod { HARMONIC, CEPSTRAL, LPC, CENTROID }

/**
 * Native resonance / "brightness" estimator (milestones 4 & 7) — the second
 * biofeedback metric after pitch. A compact Kotlin port of the canonical web DSP's
 * resonance stage, with the same selectable measurement [method]s:
 *
 *   - HARMONIC : peak-pick F1/F2 on a 3-tap smoothed magnitude envelope.
 *   - CEPSTRAL : low-quefrency liftered cepstral envelope, then peak-pick.
 *   - LPC      : Levinson-Durbin all-pole spectral envelope, then peak-pick.
 *   - CENTROID : pure spectral-centroid brightness (no formant tracking).
 *
 * All paths run on one Hann-windowed radix-2 FFT (no external DSP lib). The 0..1
 * resonance score blends the method's formant cue with spectral tilt + centroid as
 * stabilizers (centroid-only for CENTROID). Output is EMA-smoothed and updates only
 * on confidently-voiced frames, decaying [confidence] otherwise so the alert loop
 * stays silent on silence/noise.
 */
class ResonanceEstimator(private val sampleRate: Int = 16_000) {

    /** Selected measurement method (set from settings; read on the audio thread). */
    @Volatile var method: ResonanceMethod = ResonanceMethod.HARMONIC

    /** 0..1 brightness: 0 = dark/low resonance, 1 = bright/forward. Neutral 0.5 at rest. */
    var resonance: Float = 0.5f
        private set

    /** 0 = unreliable, 1 = confident. */
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
    private lateinit var env: FloatArray   // method-specific spectral envelope (linear)
    private lateinit var cre: FloatArray   // scratch for cepstral IFFT/FFT (size N)
    private lateinit var cim: FloatArray
    private val lpcA = FloatArray(LPC_ORDER + 1)
    private var lpcGain = 0f

    fun reset() {
        resonance = 0.5f
        confidence = 0f
        f1Hz = 0f
        f2Hz = 0f
    }

    /**
     * Update from one [frame] of normalized (-1..1) samples. [rms] gates silence and
     * [voiced] gates to confidently-pitched frames (the caller's YIN decision).
     */
    fun detect(frame: FloatArray, rms: Float, voiced: Boolean): Float {
        val n = frame.size
        if (!voiced || rms < 0.012f || !isPowerOfTwo(n)) {
            confidence *= 0.9f
            return resonance
        }
        ensure(n)
        val m = method // snapshot the volatile once per frame

        for (i in 0 until n) {
            re[i] = frame[i] * window[i]
            im[i] = 0f
        }
        // LPC needs the windowed time signal (re) before the FFT overwrites it.
        val haveLpc = if (m == ResonanceMethod.LPC) computeLpc(re, n) else false

        fft(re, im, inverse = false)

        val half = n / 2
        val binHz = sampleRate.toFloat() / n
        var total = 0.0
        for (k in 0 until half) {
            val mg = sqrt(re[k] * re[k] + im[k] * im[k])
            mag[k] = mg
            total += mg.toDouble()
        }
        if (total < 1e-6) { confidence *= 0.9f; return resonance }

        // Spectral tilt (high vs low band) and centroid — cheap, method-independent.
        val low = bandEnergy(80f, 1200f, binHz, half)
        val high = bandEnergy(1200f, 5000f, binHz, half)
        val tilt = if (low + high > 1e-9) (high / (low + high)).toFloat() else 0f
        var cNum = 0.0; var cDen = 0.0
        for (k in 1 until half) { cNum += k * binHz * mag[k]; cDen += mag[k] }
        val centroid = if (cDen > 0) (cNum / cDen).toFloat() else 0f
        val centroidScore = norm(centroid, 700f, 2200f)
        val brightness = (0.55f * tilt + 0.45f * centroidScore).coerceIn(0f, 1f)

        // Build the method's spectral envelope into env[] for formant peak-picking.
        when (m) {
            ResonanceMethod.HARMONIC, ResonanceMethod.CENTROID -> smoothEnvelope(half)
            ResonanceMethod.CEPSTRAL -> cepstralEnvelope(n, half)
            ResonanceMethod.LPC -> if (haveLpc) lpcEnvelope(half, binHz) else smoothEnvelope(half)
        }

        f1Hz = peakHzInBand(250f, 1000f, binHz, half)
        f2Hz = peakHzInBand(900f, 2800f, binHz, half)
        val f1Found = f1Hz in 250f..1100f
        val f2Found = f2Hz in 900f..2800f
        val f1Score = norm(f1Hz, 300f, 900f)
        val f2Score = norm(f2Hz, 1100f, 2300f)
        val formantScore = when {
            f1Found && f2Found -> 0.4f * f1Score + 0.6f * f2Score
            f2Found -> f2Score
            f1Found -> f1Score
            else -> -1f
        }

        val raw: Float
        val conf: Float
        if (m == ResonanceMethod.CENTROID) {
            // Pure brightness — no formant requirement.
            raw = (0.6f * centroidScore + 0.4f * tilt).coerceIn(0f, 1f)
            val snr = (high / (low + 1e-9)).toFloat()
            conf = min(1f, snr * 1.6f).coerceIn(0f, 1f)
        } else {
            raw = if (formantScore < 0f) brightness
                  else (0.65f * formantScore + 0.35f * brightness).coerceIn(0f, 1f)
            val snr = (high / (low + 1e-9)).toFloat()
            conf = (min(1f, snr * 1.6f) * (if (f2Found) 1f else 0.4f)).coerceIn(0f, 1f)
        }
        confidence = conf
        resonance += (raw - resonance) * (0.08f + 0.12f * confidence)
        return resonance
    }

    // ---- envelopes ---------------------------------------------------------

    /** 3-tap moving average of |X| — the HARMONIC envelope. */
    private fun smoothEnvelope(half: Int) {
        for (k in 0 until half) {
            var s = mag[k]; var c = 1
            if (k > 0) { s += mag[k - 1]; c++ }
            if (k < half - 1) { s += mag[k + 1]; c++ }
            env[k] = s / c
        }
    }

    /** Low-quefrency liftered cepstral envelope: IFFT(log|X|) → lifter → FFT → exp. */
    private fun cepstralEnvelope(n: Int, half: Int) {
        for (k in 0..half) {
            val lm = ln(mag[k.coerceAtMost(half - 1)] + 1e-6f)
            cre[k] = lm
            if (k in 1 until half) cre[n - k] = lm // mirror for a real, even spectrum
            cim[k] = 0f
            if (k in 1 until half) cim[n - k] = 0f
        }
        fft(cre, cim, inverse = true)            // real cepstrum in cre
        for (q in 0 until n) {
            if (q in (CEPSTRAL_LIFTER + 1) until (n - CEPSTRAL_LIFTER)) cre[q] = 0f
            cim[q] = 0f
        }
        fft(cre, cim, inverse = false)           // smoothed log envelope in cre
        for (k in 0 until half) env[k] = exp(cre[k])
    }

    /** Evaluate the all-pole LPC spectral envelope |gain / A(e^jw)| across bins. */
    private fun lpcEnvelope(half: Int, binHz: Float) {
        for (k in 0 until half) {
            val w = PI * k / half
            var sr = 0.0; var si = 0.0
            for (mIdx in 0..LPC_ORDER) {
                val ang = w * mIdx
                sr += lpcA[mIdx] * cos(ang)
                si -= lpcA[mIdx] * sin(ang)
            }
            val denom = sqrt(sr * sr + si * si)
            env[k] = if (denom > 1e-9) (lpcGain / denom).toFloat() else 0f
        }
    }

    /** Autocorrelation + Levinson-Durbin into [lpcA]/[lpcGain]. Returns false if degenerate. */
    private fun computeLpc(sig: FloatArray, n: Int): Boolean {
        val p = LPC_ORDER
        val r = DoubleArray(p + 1)
        for (lag in 0..p) {
            var s = 0.0
            for (i in 0 until n - lag) s += sig[i].toDouble() * sig[i + lag]
            r[lag] = s
        }
        if (r[0] <= 0.0) return false
        val a = DoubleArray(p + 1)
        a[0] = 1.0
        var e = r[0]
        for (i in 1..p) {
            var acc = r[i]
            for (j in 1 until i) acc += a[j] * r[i - j]
            val k = -acc / e
            var j = 1
            val mid = i / 2
            while (j <= mid) {
                val tmp = a[j] + k * a[i - j]
                a[i - j] += k * a[j]
                a[j] = tmp
                j++
            }
            a[i] = k
            e *= (1 - k * k)
            if (e <= 0.0) return false
        }
        for (idx in 0..p) lpcA[idx] = a[idx].toFloat()
        lpcGain = sqrt(if (e > 1e-9) e else 1e-9).toFloat()
        return true
    }

    // ---- shared helpers ----------------------------------------------------

    private fun ensure(n: Int) {
        if (n == size) return
        size = n
        window = FloatArray(n) { (0.5 - 0.5 * cos(2.0 * PI * it / (n - 1))).toFloat() }
        re = FloatArray(n); im = FloatArray(n)
        mag = FloatArray(n / 2); env = FloatArray(n / 2)
        cre = FloatArray(n); cim = FloatArray(n)
    }

    private fun bandEnergy(loHz: Float, hiHz: Float, binHz: Float, half: Int): Double {
        val lo = (loHz / binHz).toInt().coerceIn(0, half - 1)
        val hi = (hiHz / binHz).toInt().coerceIn(lo, half - 1)
        var sum = 0.0
        for (k in lo..hi) sum += mag[k].toDouble()
        return sum
    }

    private fun peakHzInBand(loHz: Float, hiHz: Float, binHz: Float, half: Int): Float {
        val lo = (loHz / binHz).toInt().coerceIn(1, half - 1)
        val hi = (hiHz / binHz).toInt().coerceIn(lo, half - 1)
        var bestK = -1
        var bestV = 0f
        for (k in lo..hi) if (env[k] > bestV) { bestV = env[k]; bestK = k }
        if (bestK < 1 || bestK >= half - 1) return if (bestK >= 0) bestK * binHz else 0f
        val a = env[bestK - 1]; val b = env[bestK]; val c = env[bestK + 1]
        val denom = (a - 2 * b + c)
        val offset = if (kotlin.math.abs(denom) > 1e-9f) 0.5f * (a - c) / denom else 0f
        return (bestK + offset) * binHz
    }

    private fun norm(v: Float, lo: Float, hi: Float): Float =
        ((v - lo) / (hi - lo)).coerceIn(0f, 1f)

    private fun isPowerOfTwo(x: Int): Boolean = x > 0 && (x and (x - 1)) == 0

    /**
     * In-place iterative radix-2 Cooley–Tukey FFT (or inverse when [inverse], which
     * also scales by 1/N). [re]/[im] length must be a power of two.
     */
    private fun fft(re: FloatArray, im: FloatArray, inverse: Boolean) {
        val n = re.size
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
        val sign = if (inverse) 1.0 else -1.0
        while (len <= n) {
            val ang = sign * 2.0 * PI / len
            val wLenRe = cos(ang).toFloat()
            val wLenIm = sin(ang).toFloat()
            var i = 0
            while (i < n) {
                var wRe = 1f; var wIm = 0f
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
        if (inverse) {
            val inv = 1f / n
            for (i in 0 until n) { re[i] *= inv; im[i] *= inv }
        }
    }

    private companion object {
        const val LPC_ORDER = 14          // ~ 2 + fs/1000 for 16 kHz speech
        const val CEPSTRAL_LIFTER = 24    // low-quefrency cutoff for the smooth envelope
    }
}
