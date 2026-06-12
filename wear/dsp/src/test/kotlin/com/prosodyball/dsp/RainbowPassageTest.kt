package com.prosodyball.dsp

import com.prosodyball.dsp.model.VoiceFrame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.math.roundToInt

/**
 * End-to-end invariants: streams the repo's rainbow_passage.wav (22050 Hz mono
 * PCM16, ~10s of read speech) through the full analyzer the way the capture
 * layer will on-watch, and checks the same properties the web analyzer
 * exhibits on this clip.
 */
class RainbowPassageTest {

    private fun loadWav(): WavData {
        val prop = System.getProperty("prosodyball.fixtures")
        val dir = if (prop != null) File(prop) else File("../../fixtures")
        return WavReader.read(File(dir, "audio-eval/rainbow_passage.wav"))
    }

    /**
     * The fixture starts speaking immediately, but a real session calibrates
     * the noise floor over ~1s of quiet first (the calibration wizard asks the
     * user to stay silent). Prepend 1.2s of silence to reproduce that flow.
     */
    private fun withLeadingSilence(wav: WavData): FloatArray {
        val silence = FloatArray((wav.sampleRate * 1.2).roundToInt())
        return silence + wav.samples
    }

    private fun runAnalyzer(): Pair<VoiceAnalyzer, List<VoiceFrame>> {
        val wav = loadWav()
        val samples = withLeadingSilence(wav)
        val analyzer = VoiceAnalyzer(sampleRate = wav.sampleRate)
        // ~16ms hops to match the web app's animation-frame cadence
        val hop = (wav.sampleRate * 0.016).roundToInt()
        val dt = hop / wav.sampleRate
        val frames = ArrayList<VoiceFrame>()
        var pos = 0
        val chunk = FloatArray(hop)
        while (pos + hop <= samples.size) {
            System.arraycopy(samples, pos, chunk, 0, hop)
            analyzer.processSamples(chunk, hop, dt)?.let { frames.add(it) }
            pos += hop
        }
        return analyzer to frames
    }

    @Test
    fun `analyzer processes the full passage with sane outputs`() {
        val (analyzer, frames) = runAnalyzer()
        assertTrue(frames.size > 400, "expected >400 frames over ~10s, got ${frames.size}")

        // Calibration completes within ~1.2s of audio
        val calibratedAt = frames.indexOfFirst { it.isCalibrated }
        assertTrue(calibratedAt in 0..((1.2 / 0.016).toInt()), "calibration finished at frame $calibratedAt")
        assertTrue(analyzer.isCalibrated)

        // Every metric is finite and in [0,1] on every frame — no NaN leaks
        for ((i, frame) in frames.withIndex()) {
            val m = frame.metrics
            for ((name, v) in listOf(
                "bounce" to m.bounce, "tempo" to m.tempo, "vowel" to m.vowel,
                "articulation" to m.articulation, "syllable" to m.syllable,
                "pitch" to m.pitch, "energy" to m.energy, "resonance" to m.resonance,
                "attack" to m.attack, "weight" to m.weight,
            )) {
                assertTrue(v.isFinite() && v in 0.0..1.0, "frame $i: $name=$v out of range")
            }
            assertTrue(frame.frameConfidence.isFinite() && frame.frameConfidence in 0.0..1.0)
            assertTrue(frame.pitchConfidence in 0.0..1.0)
        }
    }

    @Test
    fun `voiced speech is detected with plausible pitch`() {
        val (_, frames) = runAnalyzer()
        val voiced = frames.filter { it.pitchHz > 0 }
        assertTrue(
            voiced.size > frames.size * 0.2,
            "expected >20% voiced frames in read speech, got ${voiced.size}/${frames.size}",
        )
        val pitches = voiced.map { it.pitchHz }.sorted()
        val median = pitches[pitches.size / 2]
        assertTrue(median in 60.0..400.0, "median pitch $median Hz outside human speech range")
    }

    @Test
    fun `adaptive profiles learn from the passage`() {
        val (analyzer, _) = runAnalyzer()
        assertTrue(analyzer.pitchProfileLearned, "pitch range should learn from ~9s of speech")
        assertTrue(
            analyzer.pitchProfileMin >= 50.0 && analyzer.pitchProfileMax <= 800.0 &&
                analyzer.pitchProfileMin < analyzer.pitchProfileMax,
            "implausible learned pitch range ${analyzer.pitchProfileMin}..${analyzer.pitchProfileMax}",
        )
        assertTrue(analyzer.tiltProfileLearned, "tilt range should learn from voiced speech")
        assertTrue(
            analyzer.tiltProfileMax - analyzer.tiltProfileMin >= 16.0 - 1e-9,
            "tilt spread below the 16 dB minimum",
        )
    }

    @Test
    fun `syllable onsets and energy respond to speech`() {
        val (_, frames) = runAnalyzer()
        val active = frames.filter { it.isCalibrated }
        assertTrue(active.any { it.metrics.syllable > 0.5 }, "no syllable impulses on read speech")
        assertTrue(active.any { it.metrics.energy > 0.5 }, "energy never rose during speech")
        assertTrue(active.any { it.metrics.tempo > 0.0 }, "tempo tracker registered no onsets")
    }

    @Test
    fun `profile round-trips through export-import`() {
        val (analyzer, _) = runAnalyzer()
        val profile = analyzer.exportProfile()
        val fresh = VoiceAnalyzer(sampleRate = 22050.0)
        fresh.importProfile(profile)
        assertTrue(fresh.pitchProfileLearned)
        assertTrue(fresh.pitchProfileMin == analyzer.pitchProfileMin)
        assertTrue(fresh.pitchProfileMax == analyzer.pitchProfileMax)
        assertTrue(fresh.tiltProfileLearned)
    }

    @Test
    fun `narrowband 8kHz stream still produces bounded metrics`() {
        // Simulates a Bluetooth SCO narrowband mic: naive 2x-ish decimation of
        // the 22050 Hz fixture to ~11kHz, analyzed at that rate.
        val wav = loadWav()
        val padded = withLeadingSilence(wav)
        val factor = 2
        val dsRate = wav.sampleRate / factor
        val ds = FloatArray(padded.size / factor) { i ->
            (padded[i * factor] + padded[i * factor + 1]) * 0.5f
        }
        val analyzer = VoiceAnalyzer(sampleRate = dsRate)
        val hop = (dsRate * 0.016).roundToInt()
        val dt = hop / dsRate
        var pos = 0
        val chunk = FloatArray(hop)
        var voiced = 0
        var frameCount = 0
        while (pos + hop <= ds.size) {
            System.arraycopy(ds, pos, chunk, 0, hop)
            analyzer.processSamples(chunk, hop, dt)?.let { frame ->
                frameCount++
                if (frame.pitchHz > 0) voiced++
                val m = frame.metrics
                for (v in listOf(m.bounce, m.vowel, m.articulation, m.pitch, m.energy, m.resonance, m.attack, m.weight)) {
                    assertTrue(v.isFinite() && v in 0.0..1.0, "narrowband metric out of range: $v")
                }
            }
            pos += hop
        }
        assertTrue(voiced > frameCount * 0.15, "narrowband pitch detection collapsed: $voiced/$frameCount")
    }
}
