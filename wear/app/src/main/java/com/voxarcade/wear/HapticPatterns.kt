package com.voxarcade.wear

/** Public (Discreet) vs private (Practice) haptic behaviour. */
enum class HapticMode { DISCREET, PRACTICE }

/** Buzz strength for Practice mode (Discreet is always gentle). */
enum class Intensity { GENTLE, MEDIUM, STRONG }

/**
 * Directional haptic vocabulary. Two axes are encoded so the wearer can tell,
 * eyes-free, both *which metric* and *which direction*:
 *
 *   - Metric (pitch vs resonance) → texture. PITCH is short, crisp taps; RESONANCE
 *     is long, sustained buzzes. They feel categorically different in both modes.
 *   - Direction (below/above) → rhythm/contour within each metric (Practice mode).
 *
 * Discreet (public) mode stays subtle but still distinguishes the metric: a single
 * short tap for pitch vs a single longer buzz for resonance.
 *
 * Timings are `[on, off, on, …]` milliseconds (the shape the native [Haptics]
 * waveform builder expects).
 */
object HapticPatterns {
    // PITCH — short, crisp taps; the rhythm/contour encodes direction.
    private val pitchBelow = longArrayOf(30, 40, 30, 40, 80)        // rising: raise pitch
    private val pitchAbove = longArrayOf(80, 40, 30, 40, 30)        // falling: lower pitch
    // RESONANCE — long, sustained buzzes: a different texture from pitch's taps.
    private val resonanceBelow = longArrayOf(150, 70, 150)         // two long buzzes: open/brighten
    private val resonanceAbove = longArrayOf(240)                  // one long sustain: settle/soften
    private val generic = longArrayOf(50, 50, 50)
    // Discreet (public): one subtle cue per metric — distinguishable by length.
    private val pitchTap = longArrayOf(30)                         // short tap = pitch
    private val resonanceTap = longArrayOf(130)                    // longer buzz = resonance

    /**
     * Timing array for a metric+direction in the given mode. Discreet returns a
     * single per-metric cue (short tap for pitch, long buzz for resonance);
     * Practice returns the full directional pattern.
     */
    fun patternFor(metric: String, direction: String, mode: HapticMode): LongArray {
        if (mode == HapticMode.DISCREET) {
            return (if (metric == "resonance") resonanceTap else pitchTap).copyOf()
        }
        return when ("${metric}_$direction") {
            "pitch_below" -> pitchBelow
            "pitch_above" -> pitchAbove
            "resonance_below" -> resonanceBelow
            "resonance_above" -> resonanceAbove
            else -> generic
        }.copyOf()
    }

    /** Amplitude (1..255). Discreet is always gentle regardless of [intensity]. */
    fun intensityToAmp(intensity: Intensity, mode: HapticMode): Int {
        if (mode == HapticMode.DISCREET) return 70
        return when (intensity) {
            Intensity.GENTLE -> 90
            Intensity.MEDIUM -> 160
            Intensity.STRONG -> 230
        }
    }
}
