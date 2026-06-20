package com.voxarcade.wear

import android.content.Context

/** User-tunable alert config, persisted in SharedPreferences. */
data class NecklaceConfig(
    var pitchEnabled: Boolean = true,
    var pitchLo: Float = 150f,
    var pitchHi: Float = 250f,
    var resEnabled: Boolean = false,
    var resLo: Float = 0f,
    var resHi: Float = 0f,
    var voiceGate: Float = 0.012f,   // sensitivity (RMS gate)
    var buzzStrength: Int = 1,       // 0 = low, 1 = medium, 2 = high
)

object ConfigStore {
    private const val PREFS = "necklace"

    fun load(ctx: Context): NecklaceConfig {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return NecklaceConfig(
            pitchEnabled = p.getBoolean("pitchEnabled", true),
            pitchLo = p.getFloat("pitchLo", 150f),
            pitchHi = p.getFloat("pitchHi", 250f),
            resEnabled = p.getBoolean("resEnabled", false),
            resLo = p.getFloat("resLo", 0f),
            resHi = p.getFloat("resHi", 0f),
            voiceGate = p.getFloat("voiceGate", 0.012f),
            buzzStrength = p.getInt("buzzStrength", 1),
        )
    }

    fun save(ctx: Context, c: NecklaceConfig) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("pitchEnabled", c.pitchEnabled)
            .putFloat("pitchLo", c.pitchLo)
            .putFloat("pitchHi", c.pitchHi)
            .putBoolean("resEnabled", c.resEnabled)
            .putFloat("resLo", c.resLo)
            .putFloat("resHi", c.resHi)
            .putFloat("voiceGate", c.voiceGate)
            .putInt("buzzStrength", c.buzzStrength)
            .apply()
    }
}
