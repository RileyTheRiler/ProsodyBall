package com.prosodyball.wear.service

import com.prosodyball.dsp.model.VoiceFrame
import com.prosodyball.feedback.AlertType

/** Rolling aggregates for the session summary screen. */
class SessionStats {
    var durationSecs = 0.0
        private set
    var voicedSecs = 0.0
        private set
    val alertCounts = mutableMapOf<AlertType, Int>()

    private val pitchSamples = ArrayList<Double>()
    private var inBandSecs = 0.0
    private var bandComparableSecs = 0.0

    fun onFrame(frame: VoiceFrame, dt: Double, pitchMinHz: Double?, pitchMaxHz: Double?) {
        durationSecs += dt
        if (frame.pitchHz > 0 && frame.frameConfidence >= 0.35) {
            voicedSecs += dt
            pitchSamples.add(frame.pitchHz)
            if (pitchSamples.size > MAX_PITCH_SAMPLES) {
                // Keep memory bounded over multi-hour sessions: drop every other sample
                val thinned = ArrayList<Double>(pitchSamples.size / 2)
                for (i in pitchSamples.indices step 2) thinned.add(pitchSamples[i])
                pitchSamples.clear()
                pitchSamples.addAll(thinned)
            }
            if (pitchMinHz != null || pitchMaxHz != null) {
                bandComparableSecs += dt
                val aboveMin = pitchMinHz == null || frame.smoothPitchHz >= pitchMinHz
                val belowMax = pitchMaxHz == null || frame.smoothPitchHz <= pitchMaxHz
                if (aboveMin && belowMax) inBandSecs += dt
            }
        }
    }

    fun onAlert(alert: AlertType) {
        alertCounts[alert] = (alertCounts[alert] ?: 0) + 1
    }

    fun medianPitchHz(): Double {
        if (pitchSamples.isEmpty()) return 0.0
        val sorted = pitchSamples.sorted()
        return sorted[sorted.size / 2]
    }

    fun pitchRangeHz(): Pair<Double, Double> {
        if (pitchSamples.isEmpty()) return 0.0 to 0.0
        val sorted = pitchSamples.sorted()
        // p05/p95 mirrors the analyzer's outlier-trimmed range learning
        return sorted[(sorted.size * 0.05).toInt()] to sorted[minOf(sorted.size - 1, (sorted.size * 0.95).toInt())]
    }

    /** Fraction of voiced time spent inside the pitch target band, or null when no band set. */
    fun timeInBandFraction(): Double? =
        if (bandComparableSecs > 0) inBandSecs / bandComparableSecs else null

    fun reset() {
        durationSecs = 0.0
        voicedSecs = 0.0
        alertCounts.clear()
        pitchSamples.clear()
        inBandSecs = 0.0
        bandComparableSecs = 0.0
    }

    private companion object {
        const val MAX_PITCH_SAMPLES = 200_000
    }
}
