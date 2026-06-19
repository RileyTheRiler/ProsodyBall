package com.prosodyball.wear

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import com.prosodyball.wear.service.MonitorService
import com.prosodyball.wear.ui.CalibrationScreen
import com.prosodyball.wear.ui.DisguiseScreen
import com.prosodyball.wear.ui.MonitorScreen
import com.prosodyball.wear.ui.SettingsScreen
import com.prosodyball.wear.ui.SummaryScreen

object Routes {
    const val MONITOR = "monitor"
    const val DISGUISE = "disguise"
    const val CALIBRATION = "calibration"
    const val SETTINGS = "settings"
    const val SUMMARY = "summary"
}

class MainActivity : ComponentActivity() {

    private var hasMicPermission by mutableStateOf(false)

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
            hasMicPermission = grants[Manifest.permission.RECORD_AUDIO] == true
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        hasMicPermission = ContextCompat.checkSelfPermission(
            this, Manifest.permission.RECORD_AUDIO,
        ) == PackageManager.PERMISSION_GRANTED

        setContent {
            MaterialTheme {
                val navController = rememberSwipeDismissableNavController()
                SwipeDismissableNavHost(navController = navController, startDestination = Routes.MONITOR) {
                    composable(Routes.MONITOR) {
                        MonitorScreen(
                            hasMicPermission = hasMicPermission,
                            onRequestPermission = ::requestPermissions,
                            onStart = { MonitorService.start(this@MainActivity) },
                            onStop = { MonitorService.stop(this@MainActivity) },
                            onOpenDisguise = { navController.navigate(Routes.DISGUISE) },
                            onOpenCalibration = { navController.navigate(Routes.CALIBRATION) },
                            onOpenSettings = { navController.navigate(Routes.SETTINGS) },
                            onOpenSummary = { navController.navigate(Routes.SUMMARY) },
                        )
                    }
                    composable(Routes.DISGUISE) {
                        DisguiseScreen(onExit = { navController.popBackStack() })
                    }
                    composable(Routes.CALIBRATION) {
                        CalibrationScreen(
                            hasMicPermission = hasMicPermission,
                            onRequestPermission = ::requestPermissions,
                            onStartSession = { MonitorService.start(this@MainActivity) },
                            onDone = { navController.popBackStack() },
                        )
                    }
                    composable(Routes.SETTINGS) {
                        SettingsScreen(settingsRepository = (application as ProsodyApp).settingsRepository)
                    }
                    composable(Routes.SUMMARY) {
                        SummaryScreen()
                    }
                }
            }
        }
    }

    private fun requestPermissions() {
        val permissions = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            add(Manifest.permission.BLUETOOTH_CONNECT)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        permissionLauncher.launch(permissions.toTypedArray())
    }
}
