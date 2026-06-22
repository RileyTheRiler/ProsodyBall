package com.voxarcade.wear

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import kotlinx.coroutines.delay

private val ACCENT = Color(0xFF34D6C8)
private val ALERT = Color(0xFFFFA03C)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { VoxApp() }
    }
}

@Composable
private fun VoxApp() {
    val context = LocalContext.current
    val engine = remember { MicEngine() }
    val haptics = remember { Haptics(context) }

    var hasMic by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED
        )
    }
    var listening by remember { mutableStateOf(false) }
    var necklace by remember { mutableStateOf(false) }

    // Necklace settings (kept in-session for M3/M4; persistence comes next).
    var mode by remember { mutableStateOf(HapticMode.DISCREET) }
    var intensity by remember { mutableStateOf(Intensity.GENTLE) }
    var lowHz by remember { mutableStateOf(130) }
    var highHz by remember { mutableStateOf(200) }
    // Resonance band in % brightness (0 = dark, 100 = bright/forward).
    var resLow by remember { mutableStateOf(30) }
    var resHigh by remember { mutableStateOf(70) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasMic = granted
        if (granted) { engine.start(); listening = true }
    }

    val level by engine.level.collectAsState()
    val pitchHz by engine.pitchHz.collectAsState()
    val pitchConfidence by engine.pitchConfidence.collectAsState()
    val resonance by engine.resonance.collectAsState()
    val resonanceConfidence by engine.resonanceConfidence.collectAsState()
    val f1Hz by engine.f1Hz.collectAsState()
    val f2Hz by engine.f2Hz.collectAsState()

    DisposableEffect(Unit) { onDispose { engine.stop() } }

    val voiced = pitchHz > 0f && pitchConfidence > 0.4f
    val direction = when {
        !voiced -> null
        pitchHz < lowHz -> "below"
        pitchHz > highHz -> "above"
        else -> null
    }

    val resPct = resonance * 100f
    val resVoiced = resonanceConfidence > 0.45f
    val resDirection = when {
        !resVoiced -> null
        resPct < resLow -> "below"   // too dark → brighten
        resPct > resHigh -> "above"  // too bright → soften
        else -> null
    }

    // Confidence-gated directional alert loop — only active in necklace mode.
    // Two metrics: pitch takes priority (fix the fundamental first); resonance fires
    // when pitch is in range. A short global gap keeps the two buzzes from colliding.
    LaunchedEffect(necklace, listening, mode, intensity, lowHz, highHz, resLow, resHigh) {
        if (!necklace || !listening) return@LaunchedEffect
        var lastPitch = 0L
        var lastRes = 0L
        var lastAny = 0L
        while (true) {
            val now = System.currentTimeMillis()
            if (now - lastAny >= 250L) {
                val hz = engine.pitchHz.value
                val pConf = engine.pitchConfidence.value
                val rPct = engine.resonance.value * 100f
                val rConf = engine.resonanceConfidence.value

                var fired = false
                if (hz > 0f && pConf > 0.45f) {
                    val dir = if (hz < lowHz) "below" else if (hz > highHz) "above" else null
                    if (dir != null && now - lastPitch >= 600L) {
                        haptics.buzz(
                            HapticPatterns.patternFor("pitch", dir, mode),
                            HapticPatterns.intensityToAmp(intensity, mode)
                        )
                        lastPitch = now; lastAny = now; fired = true
                    }
                }
                if (!fired && rConf > 0.45f) {
                    val dir = if (rPct < resLow) "below" else if (rPct > resHigh) "above" else null
                    if (dir != null && now - lastRes >= 600L) {
                        haptics.buzz(
                            HapticPatterns.patternFor("resonance", dir, mode),
                            HapticPatterns.intensityToAmp(intensity, mode)
                        )
                        lastRes = now; lastAny = now
                    }
                }
            }
            delay(120)
        }
    }

    MaterialTheme {
        Box(
            modifier = Modifier.fillMaxSize().background(Color.Black),
            contentAlignment = Alignment.Center
        ) {
            Column(
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Spacer(Modifier.height(20.dp))

                // Mode switch
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Seg("Pitch", !necklace) { necklace = false }
                    Seg("Necklace", necklace) { necklace = true }
                }
                Spacer(Modifier.height(10.dp))

                if (!necklace) {
                    PitchMeter(voiced, pitchHz, level)
                } else {
                    NecklaceControls(
                        listening = listening,
                        voiced = voiced,
                        pitchHz = pitchHz,
                        direction = direction,
                        resVoiced = resVoiced,
                        resPct = resPct,
                        resDirection = resDirection,
                        f1Hz = f1Hz, f2Hz = f2Hz,
                        mode = mode, onMode = { mode = it },
                        intensity = intensity, onIntensity = { intensity = it },
                        lowHz = lowHz, highHz = highHz,
                        onLow = { lowHz = (lowHz + it).coerceIn(80, highHz - 10) },
                        onHigh = { highHz = (highHz + it).coerceIn(lowHz + 10, 350) },
                        resLow = resLow, resHigh = resHigh,
                        onResLow = { resLow = (resLow + it).coerceIn(0, resHigh - 5) },
                        onResHigh = { resHigh = (resHigh + it).coerceIn(resLow + 5, 100) },
                        onTestPitch = {
                            haptics.buzz(
                                HapticPatterns.patternFor("pitch", "below", mode),
                                HapticPatterns.intensityToAmp(intensity, mode)
                            )
                        },
                        onTestRes = {
                            haptics.buzz(
                                HapticPatterns.patternFor("resonance", "below", mode),
                                HapticPatterns.intensityToAmp(intensity, mode)
                            )
                        }
                    )
                }

                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = {
                        when {
                            !hasMic -> permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                            listening -> { engine.stop(); listening = false }
                            else -> { engine.start(); listening = true }
                        }
                    }
                ) { Text(if (listening) "Stop" else "Start") }

                Spacer(Modifier.height(20.dp))
            }
        }
    }
}

@Composable
private fun PitchMeter(voiced: Boolean, pitchHz: Float, level: Float) {
    val ring = if (voiced) ((pitchHz - 70f) / (400f - 70f)).coerceIn(0f, 1f)
               else (level * 6f).coerceIn(0f, 1f)
    Box(modifier = Modifier.size(104.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(
            progress = ring,
            modifier = Modifier.fillMaxSize(),
            indicatorColor = if (voiced) ACCENT else Color(0xFF3A6E78),
            trackColor = Color(0xFF1A2A30)
        )
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = if (voiced) "${pitchHz.toInt()}" else "—",
                color = Color.White,
                style = MaterialTheme.typography.title1
            )
            Text(text = "Hz", color = Color(0xFF8C8C9C), style = MaterialTheme.typography.caption2)
        }
    }
}

@Composable
private fun NecklaceControls(
    listening: Boolean,
    voiced: Boolean,
    pitchHz: Float,
    direction: String?,
    resVoiced: Boolean,
    resPct: Float,
    resDirection: String?,
    f1Hz: Float, f2Hz: Float,
    mode: HapticMode, onMode: (HapticMode) -> Unit,
    intensity: Intensity, onIntensity: (Intensity) -> Unit,
    lowHz: Int, highHz: Int,
    onLow: (Int) -> Unit, onHigh: (Int) -> Unit,
    resLow: Int, resHigh: Int,
    onResLow: (Int) -> Unit, onResHigh: (Int) -> Unit,
    onTestPitch: () -> Unit,
    onTestRes: () -> Unit
) {
    // Pitch readout
    val pitchStatus = when {
        !listening -> "Tap Start"
        !voiced -> "Listening…"
        direction == "below" -> "${pitchHz.toInt()} Hz · Low ↑"
        direction == "above" -> "${pitchHz.toInt()} Hz · High ↓"
        else -> "${pitchHz.toInt()} Hz · In range"
    }
    Text(
        text = pitchStatus,
        color = if (direction != null) ALERT else if (voiced) ACCENT else Color(0xFFB8B8C8),
        style = MaterialTheme.typography.title3,
        textAlign = TextAlign.Center
    )
    // Resonance readout — proves the second metric is being measured.
    val resStatus = when {
        !listening -> ""
        !resVoiced -> "Res —"
        resDirection == "below" -> "Res ${resPct.toInt()}% · Dark ↑"
        resDirection == "above" -> "Res ${resPct.toInt()}% · Bright ↓"
        else -> "Res ${resPct.toInt()}% · In range"
    }
    Text(
        text = resStatus,
        color = if (resDirection != null) ALERT else if (resVoiced) ACCENT else Color(0xFF8C8C9C),
        style = MaterialTheme.typography.caption1,
        textAlign = TextAlign.Center
    )
    if (resVoiced && f1Hz > 0f && f2Hz > 0f) {
        Text(
            text = "F1 ${f1Hz.toInt()} · F2 ${f2Hz.toInt()}",
            color = Color(0xFF6A6A7A),
            style = MaterialTheme.typography.caption2,
            textAlign = TextAlign.Center
        )
    }
    Spacer(Modifier.height(10.dp))

    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Seg("Discreet", mode == HapticMode.DISCREET) { onMode(HapticMode.DISCREET) }
        Seg("Practice", mode == HapticMode.PRACTICE) { onMode(HapticMode.PRACTICE) }
    }
    Spacer(Modifier.height(6.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Seg("Gentle", intensity == Intensity.GENTLE) { onIntensity(Intensity.GENTLE) }
        Seg("Med", intensity == Intensity.MEDIUM) { onIntensity(Intensity.MEDIUM) }
        Seg("Strong", intensity == Intensity.STRONG) { onIntensity(Intensity.STRONG) }
    }
    Spacer(Modifier.height(8.dp))

    Text("Pitch band (Hz)", color = Color(0xFF6A6A7A), style = MaterialTheme.typography.caption2)
    StepperRow("Low", lowHz, { onLow(-5) }, { onLow(5) })
    StepperRow("High", highHz, { onHigh(-5) }, { onHigh(5) })

    Spacer(Modifier.height(6.dp))
    Text("Resonance band (%)", color = Color(0xFF6A6A7A), style = MaterialTheme.typography.caption2)
    StepperRow("Dark", resLow, { onResLow(-5) }, { onResLow(5) })
    StepperRow("Brt", resHigh, { onResHigh(-5) }, { onResHigh(5) })

    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Seg("Test pitch", false, onTestPitch)
        Seg("Test res", false, onTestRes)
    }
}

@Composable
private fun Seg(text: String, selected: Boolean, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(12.dp))
            .background(if (selected) Color(0xFF234A52) else Color(0xFF18181F))
            .clickable(onClick = onClick)
            .padding(horizontal = 11.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = text,
            color = if (selected) Color.White else Color(0xFF9595A6),
            style = MaterialTheme.typography.caption1
        )
    }
}

@Composable
private fun StepperRow(label: String, value: Int, onMinus: () -> Unit, onPlus: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier.padding(vertical = 2.dp)
    ) {
        Text(label, color = Color(0xFF9595A6), style = MaterialTheme.typography.caption2,
            modifier = Modifier.width(34.dp))
        StepBtn("−", onMinus)
        Text("$value", color = Color.White, style = MaterialTheme.typography.caption1,
            textAlign = TextAlign.Center, modifier = Modifier.width(38.dp))
        StepBtn("+", onPlus)
    }
}

@Composable
private fun StepBtn(label: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(30.dp)
            .clip(RoundedCornerShape(15.dp))
            .background(Color(0xFF20202A))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Text(label, color = Color.White, style = MaterialTheme.typography.title3)
    }
}
