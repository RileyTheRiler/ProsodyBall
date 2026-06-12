package com.prosodyball.wear.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status
import com.prosodyball.dsp.VoiceAnalyzer
import com.prosodyball.dsp.model.VoiceMetrics
import com.prosodyball.feedback.AlertType
import com.prosodyball.feedback.FeedbackEngine
import com.prosodyball.wear.MainActivity
import com.prosodyball.wear.R
import com.prosodyball.wear.audio.AudioCaptureEngine
import com.prosodyball.wear.audio.AudioRouteManager
import com.prosodyball.wear.audio.CuePlayer
import com.prosodyball.wear.data.CueStyle
import com.prosodyball.wear.data.MicSource
import com.prosodyball.wear.data.ProfileStore
import com.prosodyball.wear.data.Settings
import com.prosodyball.wear.data.SettingsRepository
import com.prosodyball.wear.feedback.FeedbackPolicy
import com.prosodyball.wear.feedback.HapticPatterns
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** Snapshot of the live session for the UI. */
data class MonitorState(
    val running: Boolean = false,
    val calibrated: Boolean = false,
    val pitchHz: Double = 0.0,
    val smoothPitchHz: Double = 0.0,
    val metrics: VoiceMetrics = VoiceMetrics(),
    val frameConfidence: Double = 0.0,
    val narrowbandMic: Boolean = false,
    val sessionSecs: Double = 0.0,
    val voicedSecs: Double = 0.0,
    val lastAlert: AlertType? = null,
    val alertCounts: Map<AlertType, Int> = emptyMap(),
    val medianPitchHz: Double = 0.0,
    val pitchP05Hz: Double = 0.0,
    val pitchP95Hz: Double = 0.0,
    val timeInBand: Double? = null,
    val pitchProfileLearned: Boolean = false,
    val tiltProfileLearned: Boolean = false,
)

/**
 * Microphone foreground service running the capture -> analyzer -> feedback
 * pipeline. Survives screen-off (partial wake lock + ongoing activity chip);
 * must be started while the app is visible (API 34+ mic-FGS restriction).
 */
class MonitorService : LifecycleService() {

    private var capture: AudioCaptureEngine? = null
    private var analyzer: VoiceAnalyzer? = null
    private val feedbackEngine = FeedbackEngine()
    private lateinit var haptics: HapticPatterns
    private lateinit var routeManager: AudioRouteManager
    private var cuePlayer: CuePlayer? = null
    private lateinit var settingsRepository: SettingsRepository
    private lateinit var profileStore: ProfileStore
    private val stats = SessionStats()
    private var wakeLock: PowerManager.WakeLock? = null

    @Volatile
    private var currentSettings = Settings()

    private var framesSinceUiPush = 0

    override fun onCreate() {
        super.onCreate()
        haptics = HapticPatterns(this)
        routeManager = AudioRouteManager(this)
        settingsRepository = SettingsRepository(this)
        profileStore = ProfileStore(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            ACTION_STOP -> {
                stopSession()
                stopSelf()
                return START_NOT_STICKY
            }
            else -> lifecycleScope.launch { startSession() }
        }
        return START_NOT_STICKY
    }

    private suspend fun startSession() {
        if (capture?.isRunning == true) return

        startForegroundWithOngoingActivity()

        currentSettings = settingsRepository.settings.first()
        feedbackEngine.config = currentSettings.toFeedbackConfig()
        feedbackEngine.reset()
        stats.reset()

        if (currentSettings.micSource == MicSource.BLUETOOTH) {
            routeManager.enableBluetoothMic()
        }

        val newAnalyzer = VoiceAnalyzer(sampleRate = SAMPLE_RATE.toDouble())
        // Restore learned pitch/tilt ranges; noise floor recalibrates each session
        profileStore.profile.first()?.let { stored ->
            val ageDays = (System.currentTimeMillis() - stored.savedAtMillis) / 86_400_000.0
            if (ageDays <= PROFILE_MAX_AGE_DAYS) newAnalyzer.importProfile(stored.profile)
        }
        analyzer = newAnalyzer

        cuePlayer = CuePlayer(this) { durationMs -> capture?.muteFor(durationMs) }

        // Keep config live while the session runs
        lifecycleScope.launch {
            settingsRepository.settings.collect { s ->
                currentSettings = s
                feedbackEngine.config = s.toFeedbackConfig()
            }
        }

        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "prosodywear:monitor")
            .apply { acquire(MAX_SESSION_MILLIS) }

        val engine = AudioCaptureEngine(SAMPLE_RATE, HOP_SIZE, ::onHop)
        capture = engine
        if (engine.start()) {
            haptics.confirm()
            stateFlow.value = stateFlow.value.copy(running = true, narrowbandMic = routeManager.isNarrowband)
        } else {
            stopSession()
            stopSelf()
        }
    }

    private fun onHop(samples: FloatArray, count: Int, dt: Double) {
        val currentAnalyzer = analyzer ?: return
        val frame = currentAnalyzer.processSamples(samples, count, dt) ?: return
        val settings = currentSettings

        stats.onFrame(
            frame, dt,
            if (settings.pitchTargetEnabled) settings.pitchMinHz else null,
            if (settings.pitchTargetEnabled) settings.pitchMaxHz else null,
        )

        var firedAlert: AlertType? = null
        for (alert in feedbackEngine.onFrame(frame, dt)) {
            firedAlert = alert
            stats.onAlert(alert)
            deliver(alert, settings)
        }

        // Persist newly learned calibration once both profiles land
        if (frame.isCalibrated && currentAnalyzer.pitchProfileLearned && currentAnalyzer.tiltProfileLearned && !profileSaved) {
            profileSaved = true
            lifecycleScope.launch { profileStore.save(currentAnalyzer.exportProfile()) }
        }

        // Throttle UI updates to ~10Hz; alerts push immediately
        framesSinceUiPush++
        if (firedAlert != null || framesSinceUiPush >= 6) {
            framesSinceUiPush = 0
            val (p05, p95) = stats.pitchRangeHz()
            stateFlow.value = MonitorState(
                running = true,
                calibrated = frame.isCalibrated,
                pitchHz = frame.pitchHz,
                smoothPitchHz = frame.smoothPitchHz,
                metrics = frame.metrics,
                frameConfidence = frame.frameConfidence,
                narrowbandMic = routeManager.isNarrowband,
                sessionSecs = stats.durationSecs,
                voicedSecs = stats.voicedSecs,
                lastAlert = firedAlert ?: stateFlow.value.lastAlert,
                alertCounts = stats.alertCounts.toMap(),
                medianPitchHz = stats.medianPitchHz(),
                pitchP05Hz = p05,
                pitchP95Hz = p95,
                timeInBand = stats.timeInBandFraction(),
                pitchProfileLearned = currentAnalyzer.pitchProfileLearned,
                tiltProfileLearned = currentAnalyzer.tiltProfileLearned,
            )
        }
    }

    @Volatile
    private var profileSaved = false

    private fun deliver(alert: AlertType, settings: Settings) {
        val channels = FeedbackPolicy.channelsFor(settings, routeManager.hasBluetoothOutput())
        if (channels.haptic) haptics.play(alert)
        if (channels.audio) {
            when (settings.cueStyle) {
                CueStyle.SPOKEN -> cuePlayer?.speak(alert)
                CueStyle.TONES -> cuePlayer?.tone(alert)
                CueStyle.OFF -> Unit
            }
        }
    }

    private fun stopSession() {
        capture?.stop()
        capture = null
        cuePlayer?.shutdown()
        cuePlayer = null
        routeManager.disableBluetoothMic()
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        analyzer = null
        profileSaved = false
        stateFlow.value = stateFlow.value.copy(running = false)
    }

    override fun onDestroy() {
        stopSession()
        super.onDestroy()
    }

    private fun startForegroundWithOngoingActivity() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.monitor_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )

        val contentIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(getString(R.string.monitor_notification_title))
            .setContentText(getString(R.string.monitor_notification_text))
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)

        // Surface the running session on the watch face / recents
        OngoingActivity.Builder(this, NOTIFICATION_ID, builder)
            .setStaticIcon(android.R.drawable.ic_btn_speak_now)
            .setTouchIntent(contentIntent)
            .setStatus(Status.Builder().addTemplate(getString(R.string.monitor_notification_title)).build())
            .build()
            .apply(this)

        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, builder.build(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
        )
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        const val HOP_SIZE = 256
        const val CHANNEL_ID = "monitor"
        const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "com.prosodyball.wear.STOP"
        const val PROFILE_MAX_AGE_DAYS = 7.0
        private const val MAX_SESSION_MILLIS = 4 * 60 * 60 * 1000L

        private val stateFlow = MutableStateFlow(MonitorState())

        /** Live session state for the UI. */
        val state: StateFlow<MonitorState> = stateFlow.asStateFlow()

        fun start(context: Context) {
            context.startForegroundService(Intent(context, MonitorService::class.java))
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, MonitorService::class.java).setAction(ACTION_STOP),
            )
        }
    }
}
