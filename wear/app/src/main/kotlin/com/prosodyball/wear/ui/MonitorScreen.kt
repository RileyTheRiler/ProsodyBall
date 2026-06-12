package com.prosodyball.wear.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Text
import com.prosodyball.dsp.model.VoiceMetrics
import com.prosodyball.wear.service.MonitorService
import com.prosodyball.wear.service.MonitorState
import kotlin.math.min

/**
 * Live monitor: central pitch readout with a confidence-tinted dial and a ring
 * of metric indicators, plus session controls and navigation.
 */
@Composable
fun MonitorScreen(
    hasMicPermission: Boolean,
    onRequestPermission: () -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onOpenDisguise: () -> Unit,
    onOpenCalibration: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenSummary: () -> Unit,
) {
    val state by MonitorService.state.collectAsState()

    ScalingLazyColumn(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        item { PitchDial(state) }
        item {
            Text(
                text = when {
                    !state.running -> "Stopped"
                    !state.calibrated -> "Calibrating… stay quiet"
                    state.narrowbandMic -> "Listening (narrowband mic)"
                    else -> "Listening"
                },
                fontSize = 12.sp,
                color = if (state.running) Color(0xFF7FE0A7) else Color.Gray,
                textAlign = TextAlign.Center,
            )
        }
        item { MetricRow(state.metrics) }
        state.lastAlert?.let { alert ->
            item {
                Text(
                    text = "Last cue: ${alert.name.replace('_', ' ').lowercase()}",
                    fontSize = 11.sp,
                    color = Color(0xFFFFB74D),
                )
            }
        }
        item {
            if (!hasMicPermission) {
                Chip(
                    onClick = onRequestPermission,
                    label = { Text("Allow microphone") },
                    colors = ChipDefaults.primaryChipColors(),
                )
            } else if (state.running) {
                Chip(
                    onClick = onStop,
                    label = { Text("Stop session") },
                    colors = ChipDefaults.secondaryChipColors(),
                )
            } else {
                Chip(
                    onClick = onStart,
                    label = { Text("Start session") },
                    colors = ChipDefaults.primaryChipColors(),
                )
            }
        }
        item {
            Chip(onClick = onOpenDisguise, label = { Text("Discrete mode") }, colors = ChipDefaults.secondaryChipColors())
        }
        item {
            Chip(onClick = onOpenCalibration, label = { Text("Calibrate") }, colors = ChipDefaults.secondaryChipColors())
        }
        item {
            Chip(onClick = onOpenSettings, label = { Text("Settings") }, colors = ChipDefaults.secondaryChipColors())
        }
        item {
            Chip(onClick = onOpenSummary, label = { Text("Session summary") }, colors = ChipDefaults.secondaryChipColors())
        }
    }
}

@Composable
private fun PitchDial(state: MonitorState) {
    Box(
        modifier = Modifier
            .padding(top = 20.dp)
            .size(110.dp),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val stroke = 8.dp.toPx()
            val radius = min(size.width, size.height) / 2 - stroke
            // Track arc
            drawArc(
                color = Color(0xFF333344),
                startAngle = 135f,
                sweepAngle = 270f,
                useCenter = false,
                style = Stroke(stroke, cap = StrokeCap.Round),
                topLeft = Offset(center.x - radius, center.y - radius),
                size = androidx.compose.ui.geometry.Size(radius * 2, radius * 2),
            )
            // Pitch position arc, hue shifting cool->warm with metric position
            val position = state.metrics.pitch.toFloat()
            if (state.running && state.smoothPitchHz > 0) {
                drawArc(
                    color = Color.hsv(200f + 130f * position, 0.75f, 1f),
                    startAngle = 135f,
                    sweepAngle = 270f * position.coerceIn(0.02f, 1f),
                    useCenter = false,
                    style = Stroke(stroke, cap = StrokeCap.Round),
                    topLeft = Offset(center.x - radius, center.y - radius),
                    size = androidx.compose.ui.geometry.Size(radius * 2, radius * 2),
                )
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = if (state.running && state.smoothPitchHz > 0) "${state.smoothPitchHz.toInt()}" else "—",
                fontSize = 28.sp,
                color = Color.White,
            )
            Text(text = "Hz", fontSize = 11.sp, color = Color.Gray)
        }
    }
}

@Composable
private fun MetricRow(metrics: VoiceMetrics) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(26.dp),
        horizontalArrangement = Arrangement.Center,
    ) {
        MetricDot("M", metrics.bounce) // melody
        MetricDot("T", metrics.tempo)
        MetricDot("A", metrics.articulation)
        MetricDot("V", metrics.energy) // volume
        MetricDot("W", metrics.weight)
        MetricDot("R", metrics.resonance)
    }
}

@Composable
private fun MetricDot(label: String, value: Double) {
    Column(
        modifier = Modifier.padding(horizontal = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Canvas(modifier = Modifier.size(10.dp)) {
            drawCircle(
                color = Color.hsv(120f * value.toFloat().coerceIn(0f, 1f), 0.7f, 0.95f),
                radius = size.minDimension / 2,
            )
        }
        Text(text = label, fontSize = 9.sp, color = Color.Gray)
    }
}
