package com.prosodyball.wear

import android.app.Application
import com.prosodyball.wear.data.ProfileStore
import com.prosodyball.wear.data.SettingsRepository

class ProsodyApp : Application() {
    val settingsRepository by lazy { SettingsRepository(this) }
    val profileStore by lazy { ProfileStore(this) }
}
