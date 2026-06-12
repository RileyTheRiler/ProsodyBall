package com.prosodyball.wear.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.material.Text
import com.prosodyball.wear.service.MonitorService

@Composable
fun SummaryScreen() {
    val state by MonitorService.state.collectAsState()

    ScalingLazyColumn(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        item { Text("Session", fontSize = 16.sp, color = Color.White) }
        item {
            val mins = (state.sessionSecs / 60).toInt()
            val secs = (state.sessionSecs % 60).toInt()
            StatRow("Duration", "%d:%02d".format(mins, secs))
        }
        item {
            val voicedMins = (state.voicedSecs / 60).toInt()
            val voicedSecs = (state.voicedSecs % 60).toInt()
            StatRow("Speaking time", "%d:%02d".format(voicedMins, voicedSecs))
        }
        item {
            StatRow(
                "Median pitch",
                if (state.medianPitchHz > 0) "${state.medianPitchHz.toInt()} Hz" else "—",
            )
        }
        item {
            StatRow(
                "Pitch range",
                if (state.pitchP95Hz > 0) "${state.pitchP05Hz.toInt()}–${state.pitchP95Hz.toInt()} Hz" else "—",
            )
        }
        state.timeInBand?.let { fraction ->
            item { StatRow("Time in target", "${(fraction * 100).toInt()}%") }
        }
        item {
            Text(
                "Cues",
                fontSize = 14.sp,
                color = Color.White,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
        if (state.alertCounts.isEmpty()) {
            item { Text("None — clean session!", fontSize = 12.sp, color = Color(0xFF7FE0A7)) }
        } else {
            for ((alert, count) in state.alertCounts.entries.sortedByDescending { it.value }) {
                item { StatRow(alert.name.replace('_', ' ').lowercase(), "×$count") }
            }
        }
    }
}

@Composable
private fun StatRow(label: String, value: String) {
    Text(
        text = "$label: $value",
        fontSize = 12.sp,
        color = Color.LightGray,
    )
}
