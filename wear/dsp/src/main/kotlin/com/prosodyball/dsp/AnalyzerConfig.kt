package com.prosodyball.dsp

/**
 * DSP tuning constants ported verbatim from the web analyzer (app.js:20-41).
 * Keep these in sync with the JS source — they were tuned against real sessions.
 */
object AnalyzerConfig {
    /** CMND threshold for pitch detection (lower = stricter). app.js:20 */
    const val YIN_THRESHOLD = 0.15

    /** Maps CMND -> confidence: conf = 1 - cmnd * factor. app.js:21 */
    const val PITCH_CONFIDENCE_FACTOR = 3.3

    /** Hz std-dev mapped to [0,1] bounce. app.js:22 */
    const val BOUNCE_NORM_DIVISOR = 70.0

    /** Energy crossings -> [0,1] tempo. app.js:23 (unused by the JS analyzer; consumed by TempoTracker) */
    const val TEMPO_TRANSITION_DIVISOR = 12.0

    /** Seconds of sustain before vowel metric starts rising. app.js:24 */
    const val VOWEL_ONSET_SECS = 0.15

    /** Additional seconds to reach vowel = 1.0. app.js:25 */
    const val VOWEL_SATURATION_SECS = 0.6

    /** Energy percentile multiplier for vowel detection threshold. app.js:26 */
    const val VOWEL_SUSTAIN_MULT = 0.4

    /** Gain applied to articulation normalisation. app.js:27 */
    const val ARTIC_SENSITIVITY_GAIN = 1.2

    /** Minimum seconds between syllable onsets. app.js:28 */
    const val SYLLABLE_DEBOUNCE_SECS = 0.08

    /** Energy range multiplier for syllable-on threshold. app.js:29 */
    const val SYLLABLE_ON_MULT = 0.6

    /** Energy range multiplier for syllable-off threshold. app.js:30 */
    const val SYLLABLE_OFF_MULT = 0.15

    /** Per-frame decay of syllable impulse. app.js:31 */
    const val SYLLABLE_IMPULSE_DECAY = 0.88

    /** Small F2-darkness contribution to perceived weight. app.js:32 */
    const val WEIGHT_F2_BLEND = 0.15

    /** Baseline blend weight for spectral-tilt heaviness. app.js:33 */
    const val WEIGHT_TILT_BASE = 0.55

    /** Max blend weight for the H1-H2 breathiness cue (x confidence). app.js:34 */
    const val WEIGHT_H1H2_BLEND = 0.30

    /** H1-H2 (dB) anchor for pressed/heavy phonation. app.js:35 */
    const val H1H2_HEAVY_DB = -2.0

    /** H1-H2 (dB) anchor for breathy/light phonation. app.js:36 */
    const val H1H2_LIGHT_DB = 14.0

    /** Base EMA rate toward the weight target. app.js:37 */
    const val WEIGHT_SMOOTH_BASE = 0.10

    /** Capture peak energy-rise within 60ms of an onset. app.js:38 */
    const val ATTACK_RISE_WINDOW_SECS = 0.06

    /** Per-frame decay of the vocal-attack impulse. app.js:39 */
    const val ATTACK_IMPULSE_DECAY = 0.90

    /** EMA rate for the adaptive rise-rate ceiling. app.js:40 */
    const val ATTACK_RISE_LEARN_RATE = 0.02

    /** Blend weight for onset-abruptness vs amplitude-rise hardness. app.js:41 */
    const val ATTACK_ABRUPT_BLEND = 0.30
}
