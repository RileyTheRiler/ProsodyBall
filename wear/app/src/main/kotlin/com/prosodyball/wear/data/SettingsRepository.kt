package com.prosodyball.wear.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.prosodyball.feedback.FeedbackConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.settingsStore by preferencesDataStore(name = "settings")

/** How the watch is allowed to talk back to the user. */
enum class FeedbackMode {
    /** Haptics + audio cues out loud. */
    NORMAL,

    /** Disguised display, zero speaker audio; haptics always; earpiece audio only if opted in. */
    DISCRETE,

    /** Haptics only, no audio anywhere. */
    SILENT,
}

enum class CueStyle { SPOKEN, TONES, OFF }

enum class MicSource { BUILT_IN, BLUETOOTH }

data class Settings(
    val feedbackMode: FeedbackMode = FeedbackMode.NORMAL,
    val cueStyle: CueStyle = CueStyle.SPOKEN,
    /** In DISCRETE mode, allow audio cues through a connected BT earpiece. */
    val earpieceAudioInDiscrete: Boolean = false,
    val micSource: MicSource = MicSource.BUILT_IN,
    val pitchTargetEnabled: Boolean = false,
    val pitchMinHz: Double = 140.0,
    val pitchMaxHz: Double = 220.0,
    val monotoneAlertEnabled: Boolean = true,
    val volumeAlertEnabled: Boolean = false,
    val energyMin: Double = 0.1,
    val energyMax: Double = 0.85,
    val weightAlertEnabled: Boolean = false,
    val weightMin: Double = 0.25,
    val weightMax: Double = 0.75,
    val resonanceAlertEnabled: Boolean = false,
    val resonanceMin: Double = 0.25,
    val resonanceMax: Double = 0.75,
    val cooldownSecs: Double = 30.0,
) {
    fun toFeedbackConfig(): FeedbackConfig = FeedbackConfig(
        pitchMinHz = if (pitchTargetEnabled) pitchMinHz else null,
        pitchMaxHz = if (pitchTargetEnabled) pitchMaxHz else null,
        monotoneBounceFloor = if (monotoneAlertEnabled) 0.12 else null,
        energyMin = if (volumeAlertEnabled) energyMin else null,
        energyMax = if (volumeAlertEnabled) energyMax else null,
        weightMin = if (weightAlertEnabled) weightMin else null,
        weightMax = if (weightAlertEnabled) weightMax else null,
        resonanceMin = if (resonanceAlertEnabled) resonanceMin else null,
        resonanceMax = if (resonanceAlertEnabled) resonanceMax else null,
        cooldownSecs = cooldownSecs,
    )
}

class SettingsRepository(private val context: Context) {

    private object Keys {
        val feedbackMode = stringPreferencesKey("feedbackMode")
        val cueStyle = stringPreferencesKey("cueStyle")
        val earpieceAudioInDiscrete = booleanPreferencesKey("earpieceAudioInDiscrete")
        val micSource = stringPreferencesKey("micSource")
        val pitchTargetEnabled = booleanPreferencesKey("pitchTargetEnabled")
        val pitchMinHz = doublePreferencesKey("pitchMinHz")
        val pitchMaxHz = doublePreferencesKey("pitchMaxHz")
        val monotoneAlertEnabled = booleanPreferencesKey("monotoneAlertEnabled")
        val volumeAlertEnabled = booleanPreferencesKey("volumeAlertEnabled")
        val energyMin = doublePreferencesKey("energyMin")
        val energyMax = doublePreferencesKey("energyMax")
        val weightAlertEnabled = booleanPreferencesKey("weightAlertEnabled")
        val weightMin = doublePreferencesKey("weightMin")
        val weightMax = doublePreferencesKey("weightMax")
        val resonanceAlertEnabled = booleanPreferencesKey("resonanceAlertEnabled")
        val resonanceMin = doublePreferencesKey("resonanceMin")
        val resonanceMax = doublePreferencesKey("resonanceMax")
        val cooldownSecs = doublePreferencesKey("cooldownSecs")
    }

    val settings: Flow<Settings> = context.settingsStore.data.map(::read)

    suspend fun update(transform: (Settings) -> Settings) {
        context.settingsStore.edit { p ->
            val next = transform(read(p))
            p[Keys.feedbackMode] = next.feedbackMode.name
            p[Keys.cueStyle] = next.cueStyle.name
            p[Keys.earpieceAudioInDiscrete] = next.earpieceAudioInDiscrete
            p[Keys.micSource] = next.micSource.name
            p[Keys.pitchTargetEnabled] = next.pitchTargetEnabled
            p[Keys.pitchMinHz] = next.pitchMinHz
            p[Keys.pitchMaxHz] = next.pitchMaxHz
            p[Keys.monotoneAlertEnabled] = next.monotoneAlertEnabled
            p[Keys.volumeAlertEnabled] = next.volumeAlertEnabled
            p[Keys.energyMin] = next.energyMin
            p[Keys.energyMax] = next.energyMax
            p[Keys.weightAlertEnabled] = next.weightAlertEnabled
            p[Keys.weightMin] = next.weightMin
            p[Keys.weightMax] = next.weightMax
            p[Keys.resonanceAlertEnabled] = next.resonanceAlertEnabled
            p[Keys.resonanceMin] = next.resonanceMin
            p[Keys.resonanceMax] = next.resonanceMax
            p[Keys.cooldownSecs] = next.cooldownSecs
        }
    }

    private fun read(p: Preferences): Settings {
        val d = Settings()
        return Settings(
            feedbackMode = enumOrDefault(p[Keys.feedbackMode], d.feedbackMode),
            cueStyle = enumOrDefault(p[Keys.cueStyle], d.cueStyle),
            earpieceAudioInDiscrete = p[Keys.earpieceAudioInDiscrete] ?: d.earpieceAudioInDiscrete,
            micSource = enumOrDefault(p[Keys.micSource], d.micSource),
            pitchTargetEnabled = p[Keys.pitchTargetEnabled] ?: d.pitchTargetEnabled,
            pitchMinHz = p[Keys.pitchMinHz] ?: d.pitchMinHz,
            pitchMaxHz = p[Keys.pitchMaxHz] ?: d.pitchMaxHz,
            monotoneAlertEnabled = p[Keys.monotoneAlertEnabled] ?: d.monotoneAlertEnabled,
            volumeAlertEnabled = p[Keys.volumeAlertEnabled] ?: d.volumeAlertEnabled,
            energyMin = p[Keys.energyMin] ?: d.energyMin,
            energyMax = p[Keys.energyMax] ?: d.energyMax,
            weightAlertEnabled = p[Keys.weightAlertEnabled] ?: d.weightAlertEnabled,
            weightMin = p[Keys.weightMin] ?: d.weightMin,
            weightMax = p[Keys.weightMax] ?: d.weightMax,
            resonanceAlertEnabled = p[Keys.resonanceAlertEnabled] ?: d.resonanceAlertEnabled,
            resonanceMin = p[Keys.resonanceMin] ?: d.resonanceMin,
            resonanceMax = p[Keys.resonanceMax] ?: d.resonanceMax,
            cooldownSecs = p[Keys.cooldownSecs] ?: d.cooldownSecs,
        )
    }

    private inline fun <reified T : Enum<T>> enumOrDefault(name: String?, default: T): T =
        name?.let { runCatching { enumValueOf<T>(it) }.getOrNull() } ?: default
}
