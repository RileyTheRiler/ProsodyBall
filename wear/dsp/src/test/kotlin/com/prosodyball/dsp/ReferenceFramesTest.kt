package com.prosodyball.dsp

import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.math.max

/**
 * Drives the same fixture the web app's CI uses
 * (fixtures/audio-eval/reference-frames.json, consumed by
 * tools/eval-audio-fixtures.mjs) against the Kotlin port, proving the
 * pure-math layer produces identical gating/normalization results.
 */
class ReferenceFramesTest {

    private fun fixturesDir(): File {
        val prop = System.getProperty("prosodyball.fixtures")
        val dir = if (prop != null) File(prop) else File("../../fixtures")
        assertTrue(dir.isDirectory, "fixtures directory not found at ${dir.absolutePath}")
        return dir
    }

    @Test
    fun `reference frames produce expected gates, energy, and articulation`() {
        val file = File(fixturesDir(), "audio-eval/reference-frames.json")
        val fixture = JSONObject(file.readText())
        val frames = fixture.getJSONArray("frames")
        assertTrue(frames.length() > 0, "fixture has no frames")

        for (i in 0 until frames.length()) {
            val frame = frames.getJSONObject(i)
            val name = frame.getString("name")

            val rel = computeFrameReliability(
                pitchConfidence = frame.getDouble("pitchConfidence"),
                formantConfidence = frame.getDouble("formantConfidence"),
                voicedStrength = frame.getDouble("voicedStrength"),
                spectralTiltConfidence = frame.getDouble("spectralTiltConfidence"),
            )

            // Mirrors tools/eval-audio-fixtures.mjs:29-35
            val energy = normalizeAgainstPercentiles(
                frame.getDouble("gatedRms"),
                frame.getDouble("energyP50"),
                frame.getDouble("energyP90"),
                1.1,
            )
            val hfNoiseFloor = frame.getDouble("hfNoiseFloor")
            val articulation = normalizeAgainstPercentiles(
                frame.getDouble("hfEnergy"),
                hfNoiseFloor,
                max(hfNoiseFloor + 0.02, hfNoiseFloor * 3.5),
                1.2,
            )

            val expected = frame.getJSONObject("expected")
            assertInRange(name, "confidenceGate", rel.confidenceGate, expected)
            assertInRange(name, "voicedGate", rel.voicedGate, expected)
            assertInRange(name, "energy", energy, expected)
            assertInRange(name, "articulation", articulation, expected)
        }
    }

    private fun assertInRange(frame: String, key: String, value: Double, expected: JSONObject) {
        val range = expected.getJSONArray(key)
        val min = range.getDouble(0)
        val max = range.getDouble(1)
        assertTrue(
            value in min..max,
            "FAIL $frame.$key: got ${"%.3f".format(value)} expected [$min, $max]",
        )
    }
}
