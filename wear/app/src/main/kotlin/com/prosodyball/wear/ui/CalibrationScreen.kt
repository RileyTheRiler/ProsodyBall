package com.prosodyball.wear.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.Text
import com.prosodyball.wear.service.MonitorService
import kotlinx.coroutines.delay

private enum class CalibrationStep { INTRO, QUIET, VOWEL, READING, DONE }

/**
 * On-watch port of the web calibration wizard (calibration-wizard.js):
 * 1. QUIET — the analyzer's 1s noise-floor calibration runs (stay silent)
 * 2. VOWEL — hold "ahhh" until vowel > 0.28 and energy > 0.05 stay stable
 *    for 1.2s (thresholds from calibration-wizard.js:241-269)
 * 3. READING — speak naturally ~30s so the adaptive pitch/tilt range
 *    learning (5s of voiced speech) completes; profile then persists
 */
@Composable
fun CalibrationScreen(
    hasMicPermission: Boolean,
    onRequestPermission: () -> Unit,
    onStartSession: () -> Unit,
    onDone: () -> Unit,
) {
    val state by MonitorService.state.collectAsState()
    var step by remember { mutableStateOf(CalibrationStep.INTRO) }
    var vowelStableSecs by remember { mutableDoubleStateOf(0.0) }

    // Step transitions driven by analyzer state
    LaunchedEffect(step, state.calibrated, state.metrics.vowel, state.pitchProfileLearned, state.tiltProfileLearned) {
        when (step) {
            CalibrationStep.QUIET -> if (state.running && state.calibrated) step = CalibrationStep.VOWEL
            CalibrationStep.READING ->
                if (state.pitchProfileLearned && state.tiltProfileLearned) step = CalibrationStep.DONE
            else -> Unit
        }
    }

    // Vowel stability accumulator (pass criteria per calibration-wizard.js:267-269)
    LaunchedEffect(step) {
        if (step != CalibrationStep.VOWEL) return@LaunchedEffect
        vowelStableSecs = 0.0
        while (vowelStableSecs < 1.2) {
            delay(100)
            val s = MonitorService.state.value
            vowelStableSecs = if (s.metrics.vowel > 0.28 && s.metrics.energy > 0.05) {
                vowelStableSecs + 0.1
            } else {
                maxOf(0.0, vowelStableSecs - 0.05)
            }
        }
        step = CalibrationStep.READING
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        when (step) {
            CalibrationStep.INTRO -> {
                Text("Calibration", fontSize = 16.sp, color = Color.White)
                Text(
                    "Three quick steps: stay quiet, hold a vowel, then speak naturally.",
                    fontSize = 12.sp, color = Color.Gray, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
                if (!hasMicPermission) {
                    Chip(
                        onClick = onRequestPermission,
                        label = { Text("Allow microphone") },
                        colors = ChipDefaults.primaryChipColors(),
                    )
                } else {
                    Chip(
                        onClick = {
                            onStartSession()
                            step = CalibrationStep.QUIET
                        },
                        label = { Text("Begin") },
                        colors = ChipDefaults.primaryChipColors(),
                    )
                }
            }

            CalibrationStep.QUIET -> {
                CircularProgressIndicator(modifier = Modifier.padding(8.dp))
                Text("Step 1 of 3", fontSize = 12.sp, color = Color.Gray)
                Text(
                    "Stay quiet for a moment…",
                    fontSize = 14.sp, color = Color.White, textAlign = TextAlign.Center,
                )
            }

            CalibrationStep.VOWEL -> {
                CircularProgressIndicator(
                    progress = (vowelStableSecs / 1.2).toFloat().coerceIn(0f, 1f),
                    modifier = Modifier.padding(8.dp),
                )
                Text("Step 2 of 3", fontSize = 12.sp, color = Color.Gray)
                Text(
                    "Hold a steady \"ahhh\"",
                    fontSize = 14.sp, color = Color.White, textAlign = TextAlign.Center,
                )
                Text(
                    if (state.metrics.vowel > 0.28) "Good — keep going" else "A bit louder and steadier",
                    fontSize = 11.sp,
                    color = if (state.metrics.vowel > 0.28) Color(0xFF7FE0A7) else Color.Gray,
                )
            }

            CalibrationStep.READING -> {
                CircularProgressIndicator(modifier = Modifier.padding(8.dp))
                Text("Step 3 of 3", fontSize = 12.sp, color = Color.Gray)
                Text(
                    "Now speak naturally for about 30 seconds — describe your day.",
                    fontSize = 13.sp, color = Color.White, textAlign = TextAlign.Center,
                )
                Text(
                    buildString {
                        if (state.pitchProfileLearned) append("✓ pitch range  ") else append("… pitch range  ")
                        if (state.tiltProfileLearned) append("✓ voice weight") else append("… voice weight")
                    },
                    fontSize = 11.sp, color = Color.Gray,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }

            CalibrationStep.DONE -> {
                Text("All set! 🎉", fontSize = 16.sp, color = Color(0xFF7FE0A7))
                Text(
                    "Your voice profile is saved and will be reused next session.",
                    fontSize = 12.sp, color = Color.Gray, textAlign = TextAlign.Center,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
                Chip(
                    onClick = onDone,
                    label = { Text("Done") },
                    colors = ChipDefaults.primaryChipColors(),
                )
            }
        }
    }
}
