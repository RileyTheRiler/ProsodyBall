package com.voxarcade.wear

import java.util.Locale
import kotlin.math.ln
import kotlin.math.roundToInt

/** How the live pitch value is represented in the readout. */
enum class PitchDisplay { HZ, NOTE, RANGE }

/** How the live resonance value is represented in the readout. */
enum class ResDisplay { PERCENT, FORMANTS }

/**
 * User-chosen resonance *target*, replacing raw % thresholds with a clear, vocal
 * goal. This is a personalized target range (not an "objective" male/female cutoff):
 * the user picks the presentation they're working toward and the app gives green
 * (in range) / yellow (out) feedback against it.
 *
 * Ranges are sensible starting defaults over the estimator's 0..1 brightness score
 * (×100); per-user baseline calibration is the intended refinement.
 */
enum class ResGoal {
    DARK, MID, BRIGHT;

    /** Green band (low..high %) for this goal. Dark = one-sided low, Bright = one-sided high. */
    fun band(): Pair<Int, Int> = when (this) {
        DARK -> 0 to 45     // green when dark; alert only when too bright
        MID -> 35 to 65     // green in the middle; alert either way
        BRIGHT -> 55 to 100 // green when bright; alert only when too dark
    }
}

/**
 * Pure readout formatting (milestone 6) — mirrors the desktop app's per-metric
 * display selectors so the user can choose how pitch and resonance are *shown*
 * (independently of how they're measured). No Android/DSP deps, so it's trivially
 * testable and reusable.
 */
object Readout {

    private val NOTE_NAMES =
        arrayOf("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

    /** Nearest equal-tempered note name (e.g. 220 Hz → "A3"); "—" when unvoiced. */
    fun hzToNote(hz: Float): String {
        if (hz <= 0f) return "—"
        val midi = Math.round(69.0 + 12.0 * (ln(hz / 440.0) / ln(2.0))).toInt()
        val name = NOTE_NAMES[((midi % 12) + 12) % 12]
        val octave = midi / 12 - 1
        return "$name$octave"
    }

    /**
     * Format a pitch value in the chosen representation. RANGE shows semitones from
     * [refHz] (the centre of the target band) — the per-frame "how far / which way"
     * cue; falls back to Hz when no reference is available.
     */
    fun pitch(hz: Float, mode: PitchDisplay, refHz: Float): String {
        if (hz <= 0f) return "—"
        return when (mode) {
            PitchDisplay.NOTE -> hzToNote(hz)
            PitchDisplay.RANGE -> {
                if (refHz <= 0f) "${hz.roundToInt()} Hz"
                else {
                    val st = 12.0 * (ln(hz / refHz) / ln(2.0))
                    (if (st >= 0) "+" else "") + String.format(Locale.US, "%.1f st", st)
                }
            }
            PitchDisplay.HZ -> "${hz.roundToInt()} Hz"
        }
    }

    /** Format resonance as a brightness % or as raw F1/F2 formants (Hz). */
    fun resonance(pct: Float, f1: Float, f2: Float, mode: ResDisplay): String =
        when (mode) {
            ResDisplay.FORMANTS ->
                if (f1 > 0f && f2 > 0f) "${f1.roundToInt()}/${f2.roundToInt()}" else "—"
            ResDisplay.PERCENT -> "${pct.roundToInt()}%"
        }
}
