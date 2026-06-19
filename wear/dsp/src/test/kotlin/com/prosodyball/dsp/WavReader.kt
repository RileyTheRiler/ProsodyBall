package com.prosodyball.dsp

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

data class WavData(val sampleRate: Double, val samples: FloatArray)

/**
 * Minimal RIFF PCM16 mono WAV reader for the repo's audio fixtures.
 * Walks chunks generically (the fixture's fmt chunk is 18 bytes, not 16).
 */
object WavReader {
    fun read(file: File): WavData {
        val bytes = file.readBytes()
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        require(bytes.size > 44) { "Not a WAV file: too short" }
        require(String(bytes, 0, 4) == "RIFF" && String(bytes, 8, 4) == "WAVE") {
            "Not a RIFF/WAVE file: ${file.path}"
        }

        var sampleRate = 0
        var bitsPerSample = 0
        var channels = 0
        var dataOffset = -1
        var dataSize = 0

        var pos = 12
        while (pos + 8 <= bytes.size) {
            val id = String(bytes, pos, 4)
            val size = buf.getInt(pos + 4)
            when (id) {
                "fmt " -> {
                    val format = buf.getShort(pos + 8).toInt()
                    require(format == 1) { "Only PCM WAV supported, got format $format" }
                    channels = buf.getShort(pos + 10).toInt()
                    sampleRate = buf.getInt(pos + 12)
                    bitsPerSample = buf.getShort(pos + 22).toInt()
                }
                "data" -> {
                    dataOffset = pos + 8
                    dataSize = size
                }
            }
            pos += 8 + size + (size and 1)
        }

        require(dataOffset > 0) { "No data chunk found" }
        require(bitsPerSample == 16) { "Only 16-bit PCM supported, got $bitsPerSample" }
        require(channels == 1) { "Only mono supported, got $channels channels" }

        val numSamples = dataSize / 2
        val samples = FloatArray(numSamples)
        for (i in 0 until numSamples) {
            samples[i] = buf.getShort(dataOffset + i * 2) / 32768f
        }
        return WavData(sampleRate.toDouble(), samples)
    }
}
