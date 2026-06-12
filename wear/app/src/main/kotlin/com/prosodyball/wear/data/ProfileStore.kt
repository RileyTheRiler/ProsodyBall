package com.prosodyball.wear.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.prosodyball.dsp.model.VoiceProfile
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.profileStore by preferencesDataStore(name = "voice_profile")

/**
 * Persists the analyzer's learned [VoiceProfile] (pitch/tilt ranges, mic tilt
 * baseline) so sessions don't re-learn from scratch — the web app re-learns
 * every session, but on a watch the calibration wizard shouldn't run daily.
 */
class ProfileStore(private val context: Context) {

    private object Keys {
        val pitchMin = doublePreferencesKey("pitchMinHz")
        val pitchMax = doublePreferencesKey("pitchMaxHz")
        val pitchLearned = booleanPreferencesKey("pitchLearned")
        val tiltMin = doublePreferencesKey("tiltMinDb")
        val tiltMax = doublePreferencesKey("tiltMaxDb")
        val tiltLearned = booleanPreferencesKey("tiltLearned")
        val noiseFloor = doublePreferencesKey("noiseFloor")
        val hfNoiseFloor = doublePreferencesKey("hfNoiseFloor")
        val micTiltBaseline = doublePreferencesKey("micTiltBaselineDb")
        val savedAtMillis = longPreferencesKey("savedAtMillis")
    }

    data class StoredProfile(val profile: VoiceProfile, val savedAtMillis: Long)

    val profile: Flow<StoredProfile?> = context.profileStore.data.map { p ->
        val savedAt = p[Keys.savedAtMillis] ?: return@map null
        StoredProfile(
            profile = VoiceProfile(
                pitchMinHz = p[Keys.pitchMin] ?: 80.0,
                pitchMaxHz = p[Keys.pitchMax] ?: 380.0,
                pitchLearned = p[Keys.pitchLearned] ?: false,
                tiltMinDb = p[Keys.tiltMin] ?: -34.0,
                tiltMaxDb = p[Keys.tiltMax] ?: -4.0,
                tiltLearned = p[Keys.tiltLearned] ?: false,
                noiseFloor = p[Keys.noiseFloor] ?: 0.015,
                hfNoiseFloor = p[Keys.hfNoiseFloor] ?: 0.0,
                micTiltBaselineDb = p[Keys.micTiltBaseline] ?: 0.0,
            ),
            savedAtMillis = savedAt,
        )
    }

    suspend fun save(profile: VoiceProfile) {
        context.profileStore.edit { p ->
            p[Keys.pitchMin] = profile.pitchMinHz
            p[Keys.pitchMax] = profile.pitchMaxHz
            p[Keys.pitchLearned] = profile.pitchLearned
            p[Keys.tiltMin] = profile.tiltMinDb
            p[Keys.tiltMax] = profile.tiltMaxDb
            p[Keys.tiltLearned] = profile.tiltLearned
            p[Keys.noiseFloor] = profile.noiseFloor
            p[Keys.hfNoiseFloor] = profile.hfNoiseFloor
            p[Keys.micTiltBaseline] = profile.micTiltBaselineDb
            p[Keys.savedAtMillis] = System.currentTimeMillis()
        }
    }

    suspend fun clear() {
        context.profileStore.edit { it.clear() }
    }
}
