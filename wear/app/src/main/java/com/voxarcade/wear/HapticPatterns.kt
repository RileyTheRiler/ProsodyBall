package com.voxarcade.wear

/** Public (Discreet) vs private (Practice) haptic behaviour. */
enum class HapticMode { DISCREET, PRACTICE }

/** Buzz strength for Practice mode (Discreet is always gentle). */
enum class Intensity { GENTLE, MEDIUM, STRONG }

/**
 * Directional haptic vocabulary — a Kotlin port of the web overlay's
 * `watch-haptics.cjs`. Each alert encodes its correction direction in the buzz
 * rhythm so the wearer can tell eyes-free what to fix; Discreet mode collapses
 * everything to a single short tap for public use.
 *
 * Timings are `[on, off, on, …]` milliseconds (the same shape the native
 * [Haptics] waveform builder expects).
 */
object HapticPatterns {
    // Practice (private) patterns — distinguishable by rhythm/texture.
    private val pitchBelow = longArrayOf(30, 40, 30, 40, 80)        // rising: raise pitch
    private val pitchAbove = longArrayOf(80, 40, 30, 40, 30)        // falling: lower pitch
    private val resonanceBelow = longArrayOf(20, 30, 20, 30, 20, 30, 20) // flutter: brighten
    private val resonanceAbove = longArrayOf(120)                  // sustain: darken
    private val generic = longArrayOf(50, 50, 50)
    private val discreetTap = longArrayOf(35)                      // single short tap (public)

    /** Timing array for a metric+direction in the given mode (Discreet → single tap). */
    fun patternFor(metric: String, direction: String, mode: HapticMode): LongArray {
        if (mode == HapticMode.DISCREET) return discreetTap.copyOf()
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
