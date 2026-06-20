package com.voxarcade.wear

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * Foreground microphone service that runs the voice analysis, evaluates the
 * out-of-range alerts, and vibrates — independently of the UI. Because it's a
 * foreground service (type microphone), it keeps listening and buzzing with the
 * screen off / the app backgrounded. The UI binds to it for live readouts and to
 * start calibration, but unbinding (screen off) does not stop it.
 */
class NecklaceService : Service() {

    enum class Mode { OFF, LISTENING, CALIBRATING }

    interface Listener {
        fun onUpdate(pitchHz: Float, resonanceHz: Float, voiced: Boolean, tripped: Boolean, mode: Mode)
        fun onConfigChanged(config: NecklaceConfig)
    }

    private val analyzer = VoiceAnalyzer()
    private val main = Handler(Looper.getMainLooper())
    private val binder = LocalBinder()

    private lateinit var config: NecklaceConfig
    private var listener: Listener? = null
    private var mode = Mode.OFF
    private var lastBuzz = 0L

    private val calPitch = ArrayList<Float>()
    private val calRes = ArrayList<Float>()

    private val vibrator: Vibrator? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    inner class LocalBinder : Binder() {
        fun service(): NecklaceService = this@NecklaceService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        config = ConfigStore.load(this)
        analyzer.voiceGate = config.voiceGate
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopListening()
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            else -> startListening()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        analyzer.stop()
        super.onDestroy()
    }

    // ---- public API (via binder) -------------------------------------------

    fun setListener(l: Listener?) {
        listener = l
        l?.let {
            it.onConfigChanged(config)
            it.onUpdate(0f, 0f, false, false, mode)
        }
    }

    fun currentMode(): Mode = mode
    fun currentConfig(): NecklaceConfig = config

    fun updateConfig(c: NecklaceConfig) {
        config = c
        analyzer.voiceGate = c.voiceGate
        ConfigStore.save(this, c)
        listener?.onConfigChanged(c)
    }

    fun startCalibration() {
        if (mode == Mode.OFF) return
        mode = Mode.CALIBRATING
        calPitch.clear()
        calRes.clear()
        listener?.onUpdate(0f, 0f, false, false, mode)
        main.postDelayed({ finishCalibration() }, CALIBRATION_MS)
    }

    // ---- internals ----------------------------------------------------------

    private fun startListening() {
        if (mode != Mode.OFF) return
        startForegroundCompat()
        val ok = analyzer.start { onFrame(it) }
        if (!ok) {
            stopForegroundCompat()
            stopSelf()
            return
        }
        mode = Mode.LISTENING
        buzz(longArrayOf(0, 90))
        listener?.onUpdate(0f, 0f, false, false, mode)
    }

    private fun stopListening() {
        if (mode == Mode.OFF) return
        analyzer.stop()
        mode = Mode.OFF
        buzz(longArrayOf(0, 55, 45, 55))
        listener?.onUpdate(0f, 0f, false, false, mode)
    }

    private fun onFrame(r: VoiceAnalyzer.Result) {
        if (mode == Mode.CALIBRATING) {
            if (r.voiced && r.pitchHz > 0f) {
                calPitch.add(r.pitchHz)
                calRes.add(r.resonanceHz)
            }
            listener?.onUpdate(r.pitchHz, r.resonanceHz, r.voiced, false, mode)
            return
        }
        val c = config
        val pitchOut = r.voiced && c.pitchEnabled && (r.pitchHz < c.pitchLo || r.pitchHz > c.pitchHi)
        val resOut = r.voiced && c.resEnabled && (r.resonanceHz < c.resLo || r.resonanceHz > c.resHi)
        val tripped = pitchOut || resOut

        if (tripped) {
            val now = SystemClock.elapsedRealtime()
            if (now - lastBuzz >= ALERT_COOLDOWN_MS) {
                buzz(longArrayOf(0, 45, 30, 45))
                lastBuzz = now
            }
        }
        listener?.onUpdate(r.pitchHz, r.resonanceHz, r.voiced, tripped, mode)
    }

    private fun finishCalibration() {
        if (mode != Mode.CALIBRATING) return
        if (calPitch.size < 8) {
            mode = Mode.LISTENING
            listener?.onUpdate(0f, 0f, false, false, mode) // UI shows "try again"
            return
        }
        val p = median(calPitch)
        config.pitchLo = p - PITCH_TOL
        config.pitchHi = p + PITCH_TOL
        config.pitchEnabled = true

        val res = median(calRes)
        if (res > 0f) {
            config.resLo = res - RES_TOL
            config.resHi = res + RES_TOL
            config.resEnabled = true
        }
        ConfigStore.save(this, config)
        mode = Mode.LISTENING
        buzz(longArrayOf(0, 60, 40, 60, 40, 120))
        listener?.onConfigChanged(config)
        listener?.onUpdate(0f, 0f, false, false, mode)
    }

    private fun median(values: List<Float>): Float {
        val s = values.sorted()
        return s[s.size / 2]
    }

    private fun buzz(timings: LongArray) {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        val amp = when (config.buzzStrength) {
            0 -> 90
            2 -> 255
            else -> 170
        }
        try {
            if (v.hasAmplitudeControl()) {
                val amps = IntArray(timings.size) { if (it % 2 == 1) amp else 0 }
                v.vibrate(VibrationEffect.createWaveform(timings, amps, -1))
            } else {
                v.vibrate(VibrationEffect.createWaveform(timings, -1))
            }
        } catch (_: Exception) {
        }
    }

    private fun startForegroundCompat() {
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    @Suppress("DEPRECATION")
    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            stopForeground(true)
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)
            val ch = NotificationChannel(CHANNEL_ID, "Listening", NotificationManager.IMPORTANCE_LOW)
            ch.setShowBadge(false)
            mgr.createNotificationChannel(ch)
        }
    }

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Vox Necklace")
            .setContentText("Listening to your voice")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val ACTION_START = "com.voxarcade.wear.START"
        const val ACTION_STOP = "com.voxarcade.wear.STOP"
        private const val CHANNEL_ID = "necklace_listening"
        private const val NOTIF_ID = 1
        private const val ALERT_COOLDOWN_MS = 600L
        private const val CALIBRATION_MS = 4000L
        private const val PITCH_TOL = 25f
        private const val RES_TOL = 350f
    }
}
