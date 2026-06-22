package com.voxarcade.wear

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import java.io.IOException

/** One process-wide Preferences DataStore, created via the standard top-level delegate. */
private val Context.necklaceDataStore: DataStore<Preferences> by preferencesDataStore(name = "vox_necklace")

/** The persisted necklace configuration (mode/intensity + the two metric bands). */
data class NecklaceSettings(
    val mode: HapticMode = HapticMode.DISCREET,
    val intensity: Intensity = Intensity.GENTLE,
    val lowHz: Int = 130,
    val highHz: Int = 200,
    val resLow: Int = 30,
    val resHigh: Int = 70,
    val pitchDisplay: PitchDisplay = PitchDisplay.HZ,
    val resDisplay: ResDisplay = ResDisplay.PERCENT,
    val resonanceMethod: ResonanceMethod = ResonanceMethod.HARMONIC,
    // Calibrated ambient noise floor (RMS); 0 = uncalibrated, use built-in defaults.
    val noiseFloor: Float = 0f,
)

/**
 * Milestone 5 — settings persistence. Backs the necklace controls with Jetpack
 * DataStore so the user's mode, intensity, and pitch/resonance bands survive app
 * restarts instead of resetting every launch. Enums are stored by [Enum.name] so a
 * future reorder can't silently remap a saved value; unknown/missing keys fall back
 * to the [NecklaceSettings] defaults.
 */
class SettingsStore(private val context: Context) {

    private object Keys {
        val MODE = stringPreferencesKey("mode")
        val INTENSITY = stringPreferencesKey("intensity")
        val LOW_HZ = intPreferencesKey("low_hz")
        val HIGH_HZ = intPreferencesKey("high_hz")
        val RES_LOW = intPreferencesKey("res_low")
        val RES_HIGH = intPreferencesKey("res_high")
        val PITCH_DISPLAY = stringPreferencesKey("pitch_display")
        val RES_DISPLAY = stringPreferencesKey("res_display")
        val RES_METHOD = stringPreferencesKey("res_method")
        val NOISE_FLOOR = floatPreferencesKey("noise_floor")
    }

    // Single source of truth for defaults, referenced below so the fallbacks can't
    // drift from the NecklaceSettings declaration.
    private val defaults = NecklaceSettings()

    // .catch keeps a transient DataStore read failure (IOException) from tearing down
    // the flow — and the UI collecting it — by falling back to empty (= all defaults).
    val flow: Flow<NecklaceSettings> = context.necklaceDataStore.data
        .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
        .map { p ->
            NecklaceSettings(
                mode = p[Keys.MODE]?.let { runCatching { HapticMode.valueOf(it) }.getOrNull() }
                    ?: defaults.mode,
                intensity = p[Keys.INTENSITY]?.let { runCatching { Intensity.valueOf(it) }.getOrNull() }
                    ?: defaults.intensity,
                lowHz = p[Keys.LOW_HZ] ?: defaults.lowHz,
                highHz = p[Keys.HIGH_HZ] ?: defaults.highHz,
                resLow = p[Keys.RES_LOW] ?: defaults.resLow,
                resHigh = p[Keys.RES_HIGH] ?: defaults.resHigh,
                pitchDisplay = p[Keys.PITCH_DISPLAY]?.let { runCatching { PitchDisplay.valueOf(it) }.getOrNull() }
                    ?: defaults.pitchDisplay,
                resDisplay = p[Keys.RES_DISPLAY]?.let { runCatching { ResDisplay.valueOf(it) }.getOrNull() }
                    ?: defaults.resDisplay,
                resonanceMethod = p[Keys.RES_METHOD]?.let { runCatching { ResonanceMethod.valueOf(it) }.getOrNull() }
                    ?: defaults.resonanceMethod,
                noiseFloor = p[Keys.NOISE_FLOOR] ?: defaults.noiseFloor,
            )
        }

    suspend fun setMode(v: HapticMode) = context.necklaceDataStore.edit { it[Keys.MODE] = v.name }
    suspend fun setIntensity(v: Intensity) = context.necklaceDataStore.edit { it[Keys.INTENSITY] = v.name }
    suspend fun setLowHz(v: Int) = context.necklaceDataStore.edit { it[Keys.LOW_HZ] = v }
    suspend fun setHighHz(v: Int) = context.necklaceDataStore.edit { it[Keys.HIGH_HZ] = v }
    suspend fun setResLow(v: Int) = context.necklaceDataStore.edit { it[Keys.RES_LOW] = v }
    suspend fun setResHigh(v: Int) = context.necklaceDataStore.edit { it[Keys.RES_HIGH] = v }
    suspend fun setPitchDisplay(v: PitchDisplay) = context.necklaceDataStore.edit { it[Keys.PITCH_DISPLAY] = v.name }
    suspend fun setResDisplay(v: ResDisplay) = context.necklaceDataStore.edit { it[Keys.RES_DISPLAY] = v.name }
    suspend fun setResonanceMethod(v: ResonanceMethod) = context.necklaceDataStore.edit { it[Keys.RES_METHOD] = v.name }
    suspend fun setNoiseFloor(v: Float) = context.necklaceDataStore.edit { it[Keys.NOISE_FLOOR] = v }
}
