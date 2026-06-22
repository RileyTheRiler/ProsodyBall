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

/**
 * Foreground microphone service (milestone 10) — a keep-alive so voice capture
 * survives the screen turning off. It promotes itself with
 * FOREGROUND_SERVICE_TYPE_MICROPHONE (background mic access needs this), holds a
 * partial wake lock so the CPU keeps processing audio with the screen off, and
 * starts the shared [AudioHub] engine. The confidence-gated haptic alert loop runs
 * in the Activity (reliable foreground vibration); the FGS keeps the process + the
 * engine alive so that loop keeps running when the watch screen sleeps.
 */
class VoiceCaptureService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
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
        AudioHub.engine.start() // idempotent; the Activity may have started it already
        return START_NOT_STICKY
    }

    private fun stopTracking() {
        AudioHub.engine.stop()
        releaseWakeLock()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
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
