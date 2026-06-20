package com.voxarcade.wear

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import kotlin.math.roundToInt

/**
 * Thin eyes-free UI for the Galaxy Watch 7 necklace trainer. The actual mic
 * capture, analysis, alert vibration, and calibration live in [NecklaceService]
 * (a foreground service) so they keep running with the screen off. This activity
 * just binds to the service to render live state and forward button taps.
 */
class MainActivity : ComponentActivity(), NecklaceService.Listener {

    private lateinit var dot: View
    private lateinit var label: TextView
    private lateinit var pitchText: TextView
    private lateinit var brightText: TextView
    private lateinit var rangeText: TextView

    private var service: NecklaceService? = null
    private var bound = false
    private var pendingCalibrate = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val svc = (binder as NecklaceService.LocalBinder).service()
            service = svc
            bound = true
            svc.updateConfig(ConfigStore.load(this@MainActivity)) // pick up any settings changes
            svc.setListener(this@MainActivity)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
            bound = false
        }
    }

    private val requestMic =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) sendStart() else label.text = "Mic permission needed"
        }

    private val requestNotif =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* best effort */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)
        setLowBrightness(true)

        dot = findViewById(R.id.dot)
        label = findViewById(R.id.label)
        pitchText = findViewById(R.id.pitch)
        brightText = findViewById(R.id.bright)
        rangeText = findViewById(R.id.range)

        findViewById<View>(R.id.toggle).setOnClickListener { toggle() }
        findViewById<Button>(R.id.calibrate).setOnClickListener { calibrate() }
        findViewById<Button>(R.id.settings).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        renderConfig(ConfigStore.load(this))
        setDot(COLOR_OFF)
        maybeRequestNotifications()
    }

    override fun onStart() {
        super.onStart()
        // BIND_AUTO_CREATE makes the service object available (loads config) without
        // starting the mic; the mic only runs once we send ACTION_START.
        bindService(Intent(this, NecklaceService::class.java), connection, Context.BIND_AUTO_CREATE)
    }

    override fun onResume() {
        super.onResume()
        service?.updateConfig(ConfigStore.load(this))
    }

    override fun onStop() {
        super.onStop()
        if (bound) {
            service?.setListener(null)
            unbindService(connection)
            bound = false
            service = null
        }
    }

    // ---- actions ------------------------------------------------------------

    private fun toggle() {
        if (service?.currentMode() == NecklaceService.Mode.OFF || service == null) {
            startWithPermission()
        } else {
            sendStop()
        }
    }

    private fun calibrate() {
        val mode = service?.currentMode()
        if (mode == NecklaceService.Mode.LISTENING) {
            service?.startCalibration()
        } else {
            pendingCalibrate = true
            startWithPermission()
        }
    }

    private fun startWithPermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED
        ) {
            sendStart()
        } else {
            requestMic.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun sendStart() {
        val intent = Intent(this, NecklaceService::class.java).setAction(NecklaceService.ACTION_START)
        ContextCompat.startForegroundService(this, intent)
    }

    private fun sendStop() {
        startService(Intent(this, NecklaceService::class.java).setAction(NecklaceService.ACTION_STOP))
    }

    // ---- service callbacks (already on the main thread) ---------------------

    override fun onUpdate(
        pitchHz: Float,
        resonanceHz: Float,
        voiced: Boolean,
        tripped: Boolean,
        mode: NecklaceService.Mode,
    ) {
        when (mode) {
            NecklaceService.Mode.OFF -> {
                label.text = "Tap to listen"
                pitchText.text = "—"
                brightText.text = ""
                setDot(COLOR_OFF)
            }
            NecklaceService.Mode.CALIBRATING -> {
                label.text = "Speak now…"
                pitchText.text = if (pitchHz > 0f) "${pitchHz.roundToInt()} Hz" else "—"
                setDot(COLOR_CAL)
            }
            NecklaceService.Mode.LISTENING -> {
                if (pendingCalibrate) {
                    pendingCalibrate = false
                    service?.startCalibration()
                    return
                }
                label.text = if (tripped) "Adjust voice" else "Listening"
                pitchText.text = if (pitchHz > 0f) "${pitchHz.roundToInt()} Hz" else "—"
                val cfg = service?.currentConfig()
                brightText.text =
                    if (cfg?.resEnabled == true && resonanceHz > 0f) "${resonanceHz.roundToInt()} res" else ""
                setDot(if (!voiced) COLOR_OK_DIM else if (tripped) COLOR_ALERT else COLOR_OK)
            }
        }
    }

    override fun onConfigChanged(config: NecklaceConfig) {
        renderConfig(config)
    }

    // ---- helpers ------------------------------------------------------------

    private fun renderConfig(c: NecklaceConfig) {
        val pitch = if (c.pitchEnabled) "Pitch ${c.pitchLo.roundToInt()}–${c.pitchHi.roundToInt()} Hz" else "Pitch off"
        rangeText.text = if (c.resEnabled) {
            "$pitch\nRes ${c.resLo.roundToInt()}–${c.resHi.roundToInt()} Hz"
        } else {
            pitch
        }
    }

    private fun setDot(color: Int) {
        dot.background?.setTint(color)
    }

    private fun setLowBrightness(low: Boolean) {
        val lp = window.attributes
        lp.screenBrightness =
            if (low) 0.05f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        window.attributes = lp
    }

    private fun maybeRequestNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestNotif.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    companion object {
        private val COLOR_OFF = Color.parseColor("#555555")
        private val COLOR_OK = Color.parseColor("#6BCB77")
        private val COLOR_OK_DIM = Color.parseColor("#356B3B")
        private val COLOR_ALERT = Color.parseColor("#FFA03C")
        private val COLOR_CAL = Color.parseColor("#4D96FF")
    }
}
