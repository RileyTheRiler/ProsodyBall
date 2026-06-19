package com.prosodyball.wear.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Text
import com.prosodyball.wear.service.MonitorService
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.min

/**
 * Discrete mode: looks like an ordinary digital watch face at a glance.
 * Two subtle elements encode live voice feedback:
 *
 * - The thin progress ring's hue drifts cool (blue, low pitch) to warm
 *   (amber, high pitch) with your pitch position.
 * - The small dot below the date brightens briefly when an alert fired.
 *
 * Haptic feedback continues normally; the speaker is hard-muted by
 * FeedbackPolicy while DISCRETE mode is selected in settings (this screen is
 * the visual half; the audio gating never depends on which screen is open).
 *
 * Long-press anywhere for two seconds to exit. Note: this is an app screen,
 * not a system watch face — leaving the app returns to the real watch face
 * (a real watch face cannot own a microphone foreground service).
 */
@Composable
fun DisguiseScreen(onExit: () -> Unit) {
    val state by MonitorService.state.collectAsState()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var alertFlashUntil by remember { mutableLongStateOf(0L) }
    var lastSeenAlertCount by remember { mutableStateOf(-1) }

    LaunchedEffect(Unit) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }

    val totalAlerts = state.alertCounts.values.sum()
    LaunchedEffect(totalAlerts) {
        if (lastSeenAlertCount in 0 until totalAlerts) {
            alertFlashUntil = System.currentTimeMillis() + 4000
        }
        lastSeenAlertCount = totalAlerts
    }

    val timeFormat = remember { SimpleDateFormat("HH:mm", Locale.getDefault()) }
    val dateFormat = remember { SimpleDateFormat("EEE d MMM", Locale.getDefault()) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .pointerInput(Unit) {
                detectTapGestures(onLongPress = { onExit() })
            },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val stroke = 3.dp.toPx()
            val radius = min(size.width, size.height) / 2 - stroke * 2

            // Seconds ring, like any minimal watch face — but its hue tracks pitch
            val seconds = ((now / 1000) % 60).toFloat()
            val pitchPosition = state.metrics.pitch.toFloat().coerceIn(0f, 1f)
            val ringColor = if (state.running && state.calibrated) {
                Color.hsv(220f - 175f * pitchPosition, 0.45f, 0.55f)
            } else {
                Color(0xFF3A3A46)
            }
            drawArc(
                color = ringColor,
                startAngle = -90f,
                sweepAngle = 360f * (seconds / 60f),
                useCenter = false,
                style = Stroke(stroke, cap = StrokeCap.Round),
                topLeft = Offset(center.x - radius, center.y - radius),
                size = androidx.compose.ui.geometry.Size(radius * 2, radius * 2),
            )

            // "Complication" dot: flashes gently for a few seconds after an alert
            val flashing = now < alertFlashUntil
            drawCircle(
                color = if (flashing) Color(0xFFCC8844) else Color(0xFF222230),
                radius = 3.dp.toPx(),
                center = Offset(center.x, center.y + radius * 0.55f),
            )
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(text = timeFormat.format(Date(now)), fontSize = 40.sp, color = Color(0xFFE8E8F0))
            Text(text = dateFormat.format(Date(now)), fontSize = 13.sp, color = Color(0xFF8A8A98))
        }
    }
}
