package com.prosodyball.dsp

import kotlin.math.max
import kotlin.math.min

/**
 * Pure-math DSP helpers ported from dsp-utils.js. These mirror the JS source
 * line-for-line so the shared fixtures (fixtures/audio-eval) validate both ports.
 */

fun clamp(value: Double, minVal: Double = 0.0, maxVal: Double = 1.0): Double =
    max(minVal, min(maxVal, value))

fun clamp01(v: Double): Double = max(0.0, min(1.0, v))

/** dsp-utils.js:5 — weighted prosody blend of bounce/vowel/articulation. */
fun computeRawProsody(
    bounce: Double,
    vowel: Double,
    articulation: Double,
    wBounce: Double = 0.50,
    wVowel: Double = 0.30,
    wArtic: Double = 0.20,
): Double = bounce * wBounce + vowel * wVowel + articulation * wArtic

/** dsp-utils.js:16 */
fun smoothToward(current: Double, target: Double, factor: Double): Double =
    current + (target - current) * factor

/** dsp-utils.js:20 */
fun computeProsodyScore(
    previous: Double,
    bounce: Double,
    vowel: Double,
    articulation: Double,
    smoothing: Double = 0.12,
): Double {
    val raw = computeRawProsody(bounce, vowel, articulation)
    return clamp(smoothToward(previous, raw, smoothing))
}

/** dsp-utils.js:25 */
fun pitchHzToPosition(hz: Double, minHz: Double = 80.0, maxHz: Double = 300.0): Double {
    if (!hz.isFinite()) return 0.0
    return clamp((hz - minHz) / (maxHz - minHz))
}

/** dsp-utils.js:70 */
fun normalizeAgainstRange(value: Double, minVal: Double, maxVal: Double): Double {
    val denom = max(1e-6, maxVal - minVal)
    return clamp01((value - minVal) / denom)
}

/** dsp-utils.js:75 */
fun normalizeAgainstPercentiles(value: Double, p50: Double, p90: Double, gain: Double = 1.0): Double {
    val spread = max(0.0005, p90 - p50)
    return clamp01(((value - p50) / spread) * gain)
}

data class FrameReliability(
    val confidenceGate: Double,
    val voicedGate: Double,
    val reliableFrame: Boolean,
)

/** dsp-utils.js:80 — quality gates with on/off hysteresis. */
fun computeFrameReliability(
    pitchConfidence: Double = 0.0,
    formantConfidence: Double = 0.0,
    voicedStrength: Double = 0.0,
    spectralTiltConfidence: Double = 0.0,
    wasLastFrameReliable: Boolean = false,
): FrameReliability {
    val confidenceGate = clamp01(
        max(0.2, pitchConfidence * 0.55 + formantConfidence * 0.25 + spectralTiltConfidence * 0.2)
    )
    val voicedGate = clamp01(max(0.25, voicedStrength * 0.75 + pitchConfidence * 0.25))

    val reliableFrame = if (wasLastFrameReliable) {
        (pitchConfidence > 0.25 || formantConfidence > 0.30) && voicedStrength > 0.15
    } else {
        (pitchConfidence > 0.35 || formantConfidence > 0.40) && voicedStrength > 0.25
    }

    return FrameReliability(confidenceGate, voicedGate, reliableFrame)
}

/** dsp-utils.js:94 — confidence-weighted blend of heaviness cues. */
fun computeWeightTarget(
    tiltHeaviness: Double = 0.5,
    tiltWeight: Double = 1.0,
    h1h2Heaviness: Double = 0.5,
    h1h2Weight: Double = 0.0,
    f2Heaviness: Double = 0.5,
    f2Weight: Double = 0.0,
): Double {
    val wT = max(0.0, tiltWeight)
    val wH = max(0.0, h1h2Weight)
    val wF = max(0.0, f2Weight)
    val total = wT + wH + wF
    if (total <= 0) return clamp01(tiltHeaviness)
    return clamp01((tiltHeaviness * wT + h1h2Heaviness * wH + f2Heaviness * wF) / total)
}

/** dsp-utils.js:103 — onset hardness from rise rate, abruptness, and cleanliness. */
fun computeAttackHardness(
    risePeak: Double = 0.0,
    riseCeiling: Double = 0.5,
    cleanliness: Double = 1.0,
    onsetAbruptness: Double = 0.5,
    abruptWeight: Double = 0.0,
): Double {
    val ceil = max(0.02, riseCeiling)
    val riseHardness = clamp01(risePeak / ceil)
    val wA = clamp01(abruptWeight)
    val combined = riseHardness * (1 - wA) + clamp01(onsetAbruptness) * wA
    return clamp01(combined * (0.5 + 0.5 * clamp01(cleanliness)))
}
