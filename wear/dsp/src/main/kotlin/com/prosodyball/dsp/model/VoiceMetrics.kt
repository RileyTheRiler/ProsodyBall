package com.prosodyball.dsp.model

/**
 * Normalized analyzer metrics in [0, 1], mirroring the contract in docs/ANALYZER_API.md.
 *
 * - [bounce]: pitch-variance expressiveness
 * - [tempo]: syllable transition-rate (watch-only extension; see TempoTracker)
 * - [vowel]: sustained voiced-vowel continuity
 * - [articulation]: high-frequency consonant clarity (noise-floor normalized)
 * - [syllable]: onset impulse for separated syllables
 * - [pitch]: user-adaptive pitch position within the learned range
 * - [energy]: adaptive energy position (P50/P90 normalized)
 * - [resonance]: smoothed formant-derived resonance signal
 * - [attack]: vocal onset hardness impulse
 * - [weight]: perceived heaviness (1 = heavy/pressed, 0 = light/breathy)
 */
data class VoiceMetrics(
    val bounce: Double = 0.0,
    val tempo: Double = 0.0,
    val vowel: Double = 0.0,
    val articulation: Double = 0.0,
    val syllable: Double = 0.0,
    val pitch: Double = 0.0,
    val energy: Double = 0.0,
    val resonance: Double = 0.0,
    val attack: Double = 0.0,
    val weight: Double = 0.0,
)
