package com.voxarcade.wear

import android.Manifest
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import kotlin.math.roundToInt

/**
 * Native eyes-free "necklace" voice-feedback app for the Galaxy Watch 7 (which
 * has no WebView). Wear the watch on a lanyard near your mouth: tap to start
 * listening, and it buzzes when your pitch (or brightness/resonance) drifts out
 * of your target range. All analysis is on-device ([VoiceAnalyzer]); the mic is
 * off until you start it and is released when you stop it.
 */
class MainActivity : ComponentActivity() {

    private val analyzer = VoiceAnalyzer()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var prefs: SharedPreferences

    private lateinit var dot: View
    private lateinit var label: TextView
    private lateinit var pitchText: TextView
    private lateinit var brightText: TextView
    private lateinit var rangeText: TextView
    private lateinit var calibrateBtn: Button

    private var listening = false

    // Alert config (persisted).
    private var pitchLo = 150f
    private var pitchHi = 250f
    private var resLo = 0f
    private var resHi = 0f
    private var resEnabled = false

    // Alert cooldowns (ms, monotonic clock).
    private var lastBuzz = 0L

    // Calibration state.
    private var calibrating = false
    private val calPitch = ArrayList<Float>()
    private val calBright = ArrayList<Float>()

    private val vibrator: Vibrator? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    private val requestMic =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startListening() else label.text = "Mic permission needed"
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)
        setLowBrightness(true) // worn under a collar — keep it dim

        prefs = getSharedPreferences("necklace", Context.MODE_PRIVATE)
        loadConfig()

        dot = findViewById(R.id.dot)
        label = findViewById(R.id.label)
        pitchText = findViewById(R.id.pitch)
        brightText = findViewById(R.id.bright)
        rangeText = findViewById(R.id.range)
        calibrateBtn = findViewById(R.id.calibrate)

        findViewById<View>(R.id.toggle).setOnClickListener { toggleListening() }
        calibrateBtn.setOnClickListener { startCalibration() }

        renderRange()
        setDot(COLOR_OFF)
    }

    override fun onStop() {
        super.onStop()
        if (listening) stopListening() // release the mic if the watch is put away
    }

    // ---- listening ----------------------------------------------------------

    private fun toggleListening() {
        if (listening) {
            stopListening()
        } else if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED
        ) {
            startListening()
        } else {
            requestMic.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun startListening() {
        val ok = analyzer.start { onResult(it) }
        if (!ok) {
            label.text = "Mic unavailable"
            return
        }
        listening = true
        label.text = "Listening"
        buzz(longArrayOf(0, 90))          // one pulse = on
        setDot(COLOR_OK)
    }

    private fun stopListening() {
        analyzer.stop()
        listening = false
        calibrating = false
        label.text = "Tap to listen"
        pitchText.text = "—"
        brightText.text = ""
        buzz(longArrayOf(0, 55, 45, 55))  // two pulses = off
        setDot(COLOR_OFF)
    }

    private fun onResult(r: VoiceAnalyzer.Result) {
        if (!listening) return

        pitchText.text = if (r.pitchHz > 0f) "${r.pitchHz.roundToInt()} Hz" else "—"
        brightText.text = if (resEnabled && r.resonanceHz > 0f) "${r.resonanceHz.roundToInt()} res" else ""

        if (calibrating) {
            if (r.voiced && r.pitchHz > 0f) {
                calPitch.add(r.pitchHz)
                calBright.add(r.resonanceHz)
            }
            return
        }

        val pitchOut = r.voiced && (r.pitchHz < pitchLo || r.pitchHz > pitchHi)
        val resOut = r.voiced && resEnabled &&
            (r.resonanceHz < resLo || r.resonanceHz > resHi)
        val tripped = pitchOut || resOut

        when {
            !r.voiced -> setDot(COLOR_OK_DIM)
            tripped -> setDot(COLOR_ALERT)
            else -> setDot(COLOR_OK)
        }

        if (tripped) {
            val now = SystemClock.elapsedRealtime()
            if (now - lastBuzz >= ALERT_COOLDOWN_MS) {
                buzz(longArrayOf(0, 45, 30, 45))
                lastBuzz = now
            }
        }
    }

    // ---- calibration --------------------------------------------------------

    /** Speak in your target voice for a few seconds; ranges set to median ± tol. */
    private fun startCalibration() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestMic.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        if (!listening) startListening()
        calibrating = true
        calPitch.clear()
        calBright.clear()
        label.text = "Speak now…"
        setDot(COLOR_CAL)
        main.postDelayed({ finishCalibration() }, CALIBRATION_MS)
    }

    private fun finishCalibration() {
        calibrating = false
        if (calPitch.size < 8) {
            label.text = "Try again — speak"
            if (listening) setDot(COLOR_OK)
            return
        }
        val p = median(calPitch)
        pitchLo = p - PITCH_TOL
        pitchHi = p + PITCH_TOL

        val b = median(calBright)
        if (b > 0f) {
            resLo = b - BRIGHT_TOL
            resHi = b + BRIGHT_TOL
            resEnabled = true
        }
        saveConfig()
        renderRange()
        label.text = "Listening"
        if (listening) setDot(COLOR_OK)
        buzz(longArrayOf(0, 60, 40, 60, 40, 120)) // distinct "calibrated" pattern
    }

    private fun median(values: List<Float>): Float {
        val s = values.sorted()
        return s[s.size / 2]
    }

    // ---- config + UI helpers ------------------------------------------------

    private fun loadConfig() {
        pitchLo = prefs.getFloat("pitchLo", 150f)
        pitchHi = prefs.getFloat("pitchHi", 250f)
        resLo = prefs.getFloat("resLo", 0f)
        resHi = prefs.getFloat("resHi", 0f)
        resEnabled = prefs.getBoolean("resEnabled", false)
    }

    private fun saveConfig() {
        prefs.edit()
            .putFloat("pitchLo", pitchLo)
            .putFloat("pitchHi", pitchHi)
            .putFloat("resLo", resLo)
            .putFloat("resHi", resHi)
            .putBoolean("resEnabled", resEnabled)
            .apply()
    }

    private fun renderRange() {
        val pitch = "Pitch ${pitchLo.roundToInt()}–${pitchHi.roundToInt()} Hz"
        rangeText.text = if (resEnabled) {
            "$pitch\nRes ${resLo.roundToInt()}–${resHi.roundToInt()} Hz"
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

    private fun buzz(pattern: LongArray) {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        try {
            v.vibrate(VibrationEffect.createWaveform(pattern, -1))
        } catch (_: Exception) {
        }
    }

    companion object {
        private const val ALERT_COOLDOWN_MS = 600L
        private const val CALIBRATION_MS = 4000L
        private const val PITCH_TOL = 25f       // Hz around your median pitch
        private const val BRIGHT_TOL = 350f     // Hz around your median brightness

        private val COLOR_OFF = Color.parseColor("#555555")
        private val COLOR_OK = Color.parseColor("#6BCB77")
        private val COLOR_OK_DIM = Color.parseColor("#356B3B")
        private val COLOR_ALERT = Color.parseColor("#FFA03C")
        private val COLOR_CAL = Color.parseColor("#4D96FF")
    }
}
