package com.voxarcade.wear

/** Buzz strength selector. */
enum class Intensity { GENTLE, MEDIUM, STRONG }

/**
 * Directional haptic vocabulary. The metric is encoded as texture — PITCH is short,
 * crisp taps; RESONANCE is long, sustained buzzes — and the direction as rhythm/
 * contour, so the wearer can tell eyes-free both *what* to fix and *which way*.
 * Strength is the user's Gentle/Medium/Strong choice.
 *
 * Timings are `[on, off, on, …]` milliseconds (the shape the native [Haptics]
 * waveform builder expects).
 */
object HapticPatterns {
    // PITCH — short, crisp taps; the rhythm/contour encodes direction.
    private val pitchBelow = longArrayOf(30, 40, 30, 40, 80)   // rising: raise pitch
    private val pitchAbove = longArrayOf(80, 40, 30, 40, 30)   // falling: lower pitch
    // RESONANCE — long, sustained buzzes: a different texture from pitch's taps.
    private val resonanceBelow = longArrayOf(150, 70, 150)     // two long buzzes: open/brighten
    private val resonanceAbove = longArrayOf(240)              // one long sustain: settle/soften
    private val generic = longArrayOf(50, 50, 50)

    /** Timing array for a metric+direction, falling back metric -> generic. */
    fun patternFor(metric: String, direction: String): LongArray =
        when ("${metric}_$direction") {
            "pitch_below" -> pitchBelow
            "pitch_above" -> pitchAbove
            "resonance_below" -> resonanceBelow
            "resonance_above" -> resonanceAbove
            else -> generic
        }.copyOf()

    /** Amplitude (1..255) for the chosen strength. */
    fun intensityToAmp(intensity: Intensity): Int = when (intensity) {
        Intensity.GENTLE -> 90
        Intensity.MEDIUM -> 160
        Intensity.STRONG -> 230
    }
}
