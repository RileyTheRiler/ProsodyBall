package com.prosodyball.wear.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.ToggleChip
import androidx.wear.compose.material.Switch
import com.prosodyball.wear.data.CueStyle
import com.prosodyball.wear.data.FeedbackMode
import com.prosodyball.wear.data.MicSource
import com.prosodyball.wear.data.Settings
import com.prosodyball.wear.data.SettingsRepository
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(settingsRepository: SettingsRepository) {
    val settings by settingsRepository.settings.collectAsState(initial = Settings())
    val scope = rememberCoroutineScope()

    fun update(transform: (Settings) -> Settings) {
        scope.launch { settingsRepository.update(transform) }
    }

    ScalingLazyColumn(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        item { Text("Feedback", fontSize = 14.sp, color = Color.White) }
        item {
            Chip(
                onClick = {
                    update {
                        it.copy(
                            feedbackMode = when (it.feedbackMode) {
                                FeedbackMode.NORMAL -> FeedbackMode.DISCRETE
                                FeedbackMode.DISCRETE -> FeedbackMode.SILENT
                                FeedbackMode.SILENT -> FeedbackMode.NORMAL
                            },
                        )
                    }
                },
                label = { Text("Mode: ${settings.feedbackMode.name.lowercase()}") },
                secondaryLabel = {
                    Text(
                        when (settings.feedbackMode) {
                            FeedbackMode.NORMAL -> "haptics + audio aloud"
                            FeedbackMode.DISCRETE -> "haptics; no speaker ever"
                            FeedbackMode.SILENT -> "haptics only"
                        },
                    )
                },
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            Chip(
                onClick = {
                    update {
                        it.copy(
                            cueStyle = when (it.cueStyle) {
                                CueStyle.SPOKEN -> CueStyle.TONES
                                CueStyle.TONES -> CueStyle.OFF
                                CueStyle.OFF -> CueStyle.SPOKEN
                            },
                        )
                    }
                },
                label = { Text("Audio cues: ${settings.cueStyle.name.lowercase()}") },
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ToggleChip(
                checked = settings.earpieceAudioInDiscrete,
                onCheckedChange = { checked -> update { it.copy(earpieceAudioInDiscrete = checked) } },
                label = { Text("Earpiece audio in discrete", fontSize = 12.sp) },
                toggleControl = {
                    Switch(checked = settings.earpieceAudioInDiscrete)
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            Chip(
                onClick = {
                    update {
                        it.copy(
                            micSource = when (it.micSource) {
                                MicSource.BUILT_IN -> MicSource.BLUETOOTH
                                MicSource.BLUETOOTH -> MicSource.BUILT_IN
                            },
                        )
                    }
                },
                label = { Text("Mic: ${if (settings.micSource == MicSource.BUILT_IN) "watch" else "Bluetooth headset"}") },
                colors = ChipDefaults.secondaryChipColors(),
                modifier = Modifier.fillMaxWidth(),
            )
        }

        item { Text("Targets", fontSize = 14.sp, color = Color.White) }
        item {
            ToggleChip(
                checked = settings.pitchTargetEnabled,
                onCheckedChange = { checked -> update { it.copy(pitchTargetEnabled = checked) } },
                label = { Text("Pitch range", fontSize = 12.sp) },
                secondaryLabel = { Text("${settings.pitchMinHz.toInt()}–${settings.pitchMaxHz.toInt()} Hz", fontSize = 10.sp) },
                toggleControl = { Switch(checked = settings.pitchTargetEnabled) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (settings.pitchTargetEnabled) {
            item {
                Stepper(
                    label = "Low",
                    value = "${settings.pitchMinHz.toInt()} Hz",
                    onDecrement = { update { it.copy(pitchMinHz = (it.pitchMinHz - 10).coerceAtLeast(60.0)) } },
                    onIncrement = { update { it.copy(pitchMinHz = (it.pitchMinHz + 10).coerceAtMost(it.pitchMaxHz - 20)) } },
                )
            }
            item {
                Stepper(
                    label = "High",
                    value = "${settings.pitchMaxHz.toInt()} Hz",
                    onDecrement = { update { it.copy(pitchMaxHz = (it.pitchMaxHz - 10).coerceAtLeast(it.pitchMinHz + 20)) } },
                    onIncrement = { update { it.copy(pitchMaxHz = (it.pitchMaxHz + 10).coerceAtMost(500.0)) } },
                )
            }
        }
        item {
            ToggleChip(
                checked = settings.monotoneAlertEnabled,
                onCheckedChange = { checked -> update { it.copy(monotoneAlertEnabled = checked) } },
                label = { Text("Monotone alert", fontSize = 12.sp) },
                toggleControl = { Switch(checked = settings.monotoneAlertEnabled) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ToggleChip(
                checked = settings.volumeAlertEnabled,
                onCheckedChange = { checked -> update { it.copy(volumeAlertEnabled = checked) } },
                label = { Text("Volume alerts", fontSize = 12.sp) },
                toggleControl = { Switch(checked = settings.volumeAlertEnabled) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ToggleChip(
                checked = settings.weightAlertEnabled,
                onCheckedChange = { checked -> update { it.copy(weightAlertEnabled = checked) } },
                label = { Text("Vocal weight alerts", fontSize = 12.sp) },
                toggleControl = { Switch(checked = settings.weightAlertEnabled) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            ToggleChip(
                checked = settings.resonanceAlertEnabled,
                onCheckedChange = { checked -> update { it.copy(resonanceAlertEnabled = checked) } },
                label = { Text("Resonance alerts", fontSize = 12.sp) },
                toggleControl = { Switch(checked = settings.resonanceAlertEnabled) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        item {
            Stepper(
                label = "Cooldown",
                value = "${settings.cooldownSecs.toInt()}s",
                onDecrement = { update { it.copy(cooldownSecs = (it.cooldownSecs - 10).coerceAtLeast(10.0)) } },
                onIncrement = { update { it.copy(cooldownSecs = (it.cooldownSecs + 10).coerceAtMost(120.0)) } },
            )
        }

        item { Text("Haptic legend", fontSize = 14.sp, color = Color.White) }
        item {
            Text(
                "pitch low: 1 long · pitch high: 2 short\nmonotone: 3 short · loud: 2 long\nquiet: short-long · heavy: long-2 short\nlight: 2 short · dark: short-long-short",
                fontSize = 10.sp,
                color = Color.Gray,
                modifier = Modifier.padding(horizontal = 8.dp),
            )
        }
    }
}

@Composable
private fun Stepper(label: String, value: String, onDecrement: () -> Unit, onIncrement: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Button(onClick = onDecrement, modifier = Modifier.padding(end = 8.dp)) { Text("−") }
        Text("$label $value", fontSize = 12.sp, color = Color.White)
        Button(onClick = onIncrement, modifier = Modifier.padding(start = 8.dp)) { Text("+") }
    }
}
