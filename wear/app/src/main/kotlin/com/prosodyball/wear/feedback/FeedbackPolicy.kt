package com.prosodyball.wear.feedback

import com.prosodyball.wear.data.CueStyle
import com.prosodyball.wear.data.FeedbackMode
import com.prosodyball.wear.data.Settings

/**
 * Decides which channels an alert may use. This is the hard gate that makes
 * discrete mode trustworthy: the speaker is excluded by mode logic here, not
 * by UI state, so no code path can play audio aloud while discrete.
 */
object FeedbackPolicy {

    data class Channels(
        val haptic: Boolean,
        /** Play an audio cue (TTS or tones per settings). */
        val audio: Boolean,
    )

    fun channelsFor(settings: Settings, bluetoothOutputConnected: Boolean): Channels {
        val audioWanted = settings.cueStyle != CueStyle.OFF
        return when (settings.feedbackMode) {
            FeedbackMode.NORMAL -> Channels(haptic = true, audio = audioWanted)
            FeedbackMode.DISCRETE -> Channels(
                haptic = true,
                // Never the watch speaker; earpiece only when connected AND opted in
                audio = audioWanted && bluetoothOutputConnected && settings.earpieceAudioInDiscrete,
            )
            FeedbackMode.SILENT -> Channels(haptic = true, audio = false)
        }
    }
}
