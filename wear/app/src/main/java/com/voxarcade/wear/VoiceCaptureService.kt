package com.voxarcade.wear

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch

/**
 * Foreground microphone service (milestone 10) — keeps voice capture and the haptic
 * alert loop running with the screen off, which a plain Activity-scoped thread can't
 * (background mic access is cut off without a microphone foreground service).
 *
 * It promotes itself immediately with FOREGROUND_SERVICE_TYPE_MICROPHONE, holds a
 * partial wake lock so the CPU keeps processing audio while the watch screen sleeps,
 * then starts the shared [AudioHub] engine and drives the same confidence-gated,
 * directional alert loop the UI used to run. Tearing down uses
 * stopForeground(STOP_FOREGROUND_REMOVE) before stopSelf for a clean, predictable exit.
 */
class VoiceCaptureService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var haptics: Haptics
    @Volatile private var settings = NecklaceSettings()
    private var wakeLock: PowerManager.WakeLock? = null
    private var loopStarted = false

    override fun onCreate() {
        super.onCreate()
        haptics = Haptics(this)
        createChannel()
        // Keep a live copy of the persisted settings for the alert loop.
        SettingsStore(this).flow.onEach { settings = it }.launchIn(scope)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopTracking()
            return START_NOT_STICKY
        }

        // Promote to a microphone foreground service BEFORE touching the mic.
        ServiceCompat.startForeground(
            this,
            NOTIF_ID,
            buildNotification(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        )
        acquireWakeLock()
        AudioHub.engine.start()
        startAlertLoop()
        return START_NOT_STICKY
    }

    private fun stopTracking() {
        AudioHub.engine.stop()
        releaseWakeLock()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** The confidence-gated, two-metric directional alert loop (mirrors the old UI loop). */
    private fun startAlertLoop() {
        if (loopStarted) return
        loopStarted = true
        scope.launch {
            val engine = AudioHub.engine
            var lastPitch = 0L
            var lastRes = 0L
            var lastAny = 0L
            while (true) {
                val now = System.currentTimeMillis()
                if (AudioHub.necklaceActive.get() && now - lastAny >= 250L) {
                    val s = settings
                    val (resLow, resHigh) = s.resGoal.band(s.resBaseline)
                    val hz = engine.pitchHz.value
                    val pConf = engine.pitchConfidence.value
                    val rPct = engine.resonance.value * 100f
                    val rConf = engine.resonanceConfidence.value

                    var fired = false
                    if (hz > 0f && pConf > 0.45f) {
                        val dir = if (hz < s.lowHz) "below" else if (hz > s.highHz) "above" else null
                        if (dir != null && now - lastPitch >= 600L) {
                            haptics.buzz(
                                HapticPatterns.patternFor("pitch", dir, s.mode),
                                HapticPatterns.intensityToAmp(s.intensity, s.mode)
                            )
                            lastPitch = now; lastAny = now; fired = true
                        }
                    }
                    if (!fired && rConf > 0.45f) {
                        val dir = if (rPct < resLow) "below" else if (rPct > resHigh) "above" else null
                        if (dir != null && now - lastRes >= 600L) {
                            haptics.buzz(
                                HapticPatterns.patternFor("resonance", dir, s.mode),
                                HapticPatterns.intensityToAmp(s.intensity, s.mode)
                            )
                            lastRes = now; lastAny = now
                        }
                    }
                }
                delay(120)
            }
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(PowerManager::class.java) ?: return
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vox:capture").apply {
            setReferenceCounted(false)
            acquire(2 * 60 * 60 * 1000L) // safety cap; released on stop
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    override fun onDestroy() {
        scope.cancel()
        AudioHub.engine.stop()
        releaseWakeLock()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, VoiceCaptureService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Voice tracking active")
            .setContentText("Listening for pitch & resonance")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(open)
            .addAction(android.R.drawable.ic_delete, "Stop", stop)
            .setOngoing(true)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID, "Voice tracking", NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    companion object {
        const val ACTION_START = "com.voxarcade.wear.action.START"
        const val ACTION_STOP = "com.voxarcade.wear.action.STOP"
        private const val CHANNEL_ID = "voice_tracking"
        private const val NOTIF_ID = 1
    }
}
