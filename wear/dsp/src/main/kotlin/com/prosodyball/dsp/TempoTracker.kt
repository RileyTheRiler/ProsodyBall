package com.prosodyball.dsp

import kotlin.math.sqrt

/**
 * Watch-only extension: speech tempo from syllable onsets.
 *
 * The web analyzer declares TEMPO_TRANSITION_DIVISOR (app.js:23) and the
 * analyzer contract documents a tempo metric (docs/ANALYZER_API.md), but the
 * JS analyzer never implements it. This class fills that gap for the monitor:
 *
 * - [tempoMetric]: clamp01(onsets in the last 2s / TEMPO_TRANSITION_DIVISOR)
 * - [tempoRate]: onsets per second over the window
 * - [tempoVariance]: coefficient of variation of inter-onset intervals; near 0
 *   means metronomic/monotone pacing, higher means varied, expressive rhythm.
 */
class TempoTracker(private val windowSecs: Double = 2.0) {
    private val onsetTimes = ArrayDeque<Double>()
    private var now = 0.0

    var tempoMetric = 0.0
        private set
    var tempoRate = 0.0
        private set
    var tempoVariance = 0.0
        private set

    /** Call once per analysis frame; [syllableOnset] is true on a new syllable impulse. */
    fun update(dt: Double, syllableOnset: Boolean) {
        now += dt
        if (syllableOnset) onsetTimes.addLast(now)
        while (onsetTimes.isNotEmpty() && now - onsetTimes.first() > windowSecs) {
            onsetTimes.removeFirst()
        }

        val count = onsetTimes.size
        tempoRate = count / windowSecs
        tempoMetric = clamp01(count / AnalyzerConfig.TEMPO_TRANSITION_DIVISOR)

        if (count >= 3) {
            var prev = onsetTimes.first()
            var sum = 0.0
            var sqSum = 0.0
            var n = 0
            for (i in 1 until count) {
                val t = onsetTimes.elementAt(i)
                val interval = t - prev
                prev = t
                sum += interval
                sqSum += interval * interval
                n++
            }
            val mean = sum / n
            val variance = (sqSum / n) - mean * mean
            tempoVariance = if (mean > 1e-6) clamp01(sqrt(variance.coerceAtLeast(0.0)) / mean) else 0.0
        } else {
            tempoVariance *= 0.98
        }
    }

    fun reset() {
        onsetTimes.clear()
        now = 0.0
        tempoMetric = 0.0
        tempoRate = 0.0
        tempoVariance = 0.0
    }
}
