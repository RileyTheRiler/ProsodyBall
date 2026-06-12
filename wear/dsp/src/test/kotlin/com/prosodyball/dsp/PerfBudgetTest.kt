package com.prosodyball.dsp

import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.PI
import kotlin.math.sin

/**
 * JVM proxy for the watch CPU budget: the full pipeline must average well
 * under the 16ms hop interval. Watch cores are slower than CI machines, so
 * the budget here is deliberately tight (2ms; measured ~0.1ms on dev boxes).
 */
class PerfBudgetTest {

    @Test
    fun `full pipeline stays under budget per hop`() {
        val sampleRate = 16000.0
        val hop = 256
        val analyzer = VoiceAnalyzer(sampleRate)
        val dt = hop / sampleRate

        // Speech-like signal: 160 Hz sawtooth with vibrato and amplitude pulses
        val totalHops = 2000
        val chunk = FloatArray(hop)
        var phase = 0.0

        fun fillChunk(hopIndex: Int) {
            val f0 = 160.0 + 20 * sin(2 * PI * hopIndex * dt * 3)
            val amp = if ((hopIndex / 12) % 2 == 0) 0.3 else 0.05
            for (i in 0 until hop) {
                phase += f0 / sampleRate
                if (phase >= 1) phase -= 1
                chunk[i] = ((2 * phase - 1) * amp).toFloat()
            }
        }

        // Warmup (JIT)
        for (h in 0 until 500) {
            fillChunk(h)
            analyzer.processSamples(chunk, hop, dt)
        }

        var elapsed = 0L
        for (h in 0 until totalHops) {
            fillChunk(h)
            val start = System.nanoTime()
            analyzer.processSamples(chunk, hop, dt)
            elapsed += System.nanoTime() - start
        }
        val avgMs = elapsed / 1e6 / totalHops
        println("Average per-hop analysis time: ${"%.3f".format(avgMs)} ms (budget 2 ms, hop interval 16 ms)")
        assertTrue(avgMs < 2.0, "per-hop analysis too slow: ${avgMs} ms")
    }
}
