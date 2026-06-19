package com.prosodyball.wear.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.speech.tts.TextToSpeech
import android.util.Log
import com.prosodyball.feedback.AlertType
import kotlin.math.PI
import kotlin.math.sin

/**
 * Auditory feedback: short spoken phrases (TTS) or synthesized tone cues.
 * Tones encode direction without words — a rising glide means "bring pitch up",
 * a falling glide "bring it down", a double blip "add melody".
 *
 * Callers must invoke [onCuePlayed] -> AudioCaptureEngine.muteFor so the cue
 * doesn't feed back into the analyzer through the mic.
 */
class CuePlayer(
    context: Context,
    private val onCuePlayed: (durationMillis: Long) -> Unit,
) {
    private var tts: TextToSpeech? = null
    private var ttsReady = false

    private val audioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    init {
        tts = TextToSpeech(context) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) {
                tts?.setAudioAttributes(audioAttributes)
            } else {
                Log.w(TAG, "TTS init failed: $status")
            }
        }
    }

    fun speak(alert: AlertType) {
        val phrase = phraseFor(alert)
        val cue = tts?.takeIf { ttsReady } ?: return
        onCuePlayed(phrase.length * 90L + 600L)
        cue.speak(phrase, TextToSpeech.QUEUE_FLUSH, null, "prosody-cue")
    }

    fun tone(alert: AlertType) {
        val spec = toneFor(alert)
        onCuePlayed(spec.sumOf { it.durationMs }.toLong() + 350L)
        Thread({ playTones(spec) }, "prosody-tone").start()
    }

    fun shutdown() {
        tts?.shutdown()
        tts = null
        ttsReady = false
    }

    private data class Tone(val startHz: Double, val endHz: Double, val durationMs: Int, val gapMs: Int = 0)

    private fun phraseFor(alert: AlertType): String = when (alert) {
        AlertType.PITCH_LOW -> "pitch up"
        AlertType.PITCH_HIGH -> "pitch down"
        AlertType.MONOTONE -> "more melody"
        AlertType.TOO_FAST -> "slow down"
        AlertType.MUSHY -> "crisper words"
        AlertType.TOO_LOUD -> "softer"
        AlertType.TOO_QUIET -> "louder"
        AlertType.TOO_HEAVY -> "lighter voice"
        AlertType.TOO_LIGHT -> "fuller voice"
        AlertType.RESONANCE_DARK -> "brighter"
        AlertType.RESONANCE_BRIGHT -> "darker"
    }

    private fun toneFor(alert: AlertType): List<Tone> = when (alert) {
        AlertType.PITCH_LOW -> listOf(Tone(440.0, 880.0, 180))
        AlertType.PITCH_HIGH -> listOf(Tone(880.0, 440.0, 180))
        AlertType.MONOTONE -> listOf(Tone(660.0, 660.0, 70, 60), Tone(660.0, 660.0, 70))
        AlertType.TOO_FAST -> listOf(Tone(550.0, 550.0, 220))
        AlertType.MUSHY -> listOf(Tone(550.0, 550.0, 70, 50), Tone(550.0, 550.0, 70, 50), Tone(550.0, 550.0, 70))
        AlertType.TOO_LOUD -> listOf(Tone(740.0, 520.0, 150))
        AlertType.TOO_QUIET -> listOf(Tone(520.0, 740.0, 150))
        AlertType.TOO_HEAVY -> listOf(Tone(392.0, 523.0, 160))
        AlertType.TOO_LIGHT -> listOf(Tone(523.0, 392.0, 160))
        AlertType.RESONANCE_DARK -> listOf(Tone(587.0, 784.0, 160))
        AlertType.RESONANCE_BRIGHT -> listOf(Tone(784.0, 587.0, 160))
    }

    private fun playTones(tones: List<Tone>) {
        val sampleRate = 22050
        var totalSamples = 0
        for (t in tones) totalSamples += (t.durationMs + t.gapMs) * sampleRate / 1000
        if (totalSamples == 0) return

        val pcm = ShortArray(totalSamples)
        var pos = 0
        for (t in tones) {
            val n = t.durationMs * sampleRate / 1000
            var phase = 0.0
            for (i in 0 until n) {
                val progress = i.toDouble() / n
                val freq = t.startHz + (t.endHz - t.startHz) * progress
                phase += 2 * PI * freq / sampleRate
                // Quick attack/release envelope avoids clicks
                val env = minOf(1.0, i / (0.01 * sampleRate), (n - i) / (0.02 * sampleRate))
                pcm[pos + i] = (sin(phase) * env * 0.5 * Short.MAX_VALUE).toInt().toShort()
            }
            pos += n + t.gapMs * sampleRate / 1000
        }

        val track = AudioTrack.Builder()
            .setAudioAttributes(audioAttributes)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(pcm.size * 2)
            .build()
        try {
            track.write(pcm, 0, pcm.size)
            track.play()
            Thread.sleep(totalSamples * 1000L / sampleRate + 50)
        } catch (e: Exception) {
            Log.w(TAG, "Tone playback failed", e)
        } finally {
            track.release()
        }
    }

    private companion object {
        const val TAG = "CuePlayer"
    }
}
