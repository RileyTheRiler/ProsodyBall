package com.voxarcade.wear

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import kotlinx.coroutines.launch

private val ACCENT = Color(0xFF34D6C8)
private val ALERT = Color(0xFFFFA03C)
// Deep, readable backgrounds for the Pitch screen's resonance state (white/cyan
// foreground stays legible): green = resonance in the chosen goal, yellow = out.
private val RES_GREEN_BG = Color(0xFF10401E)
private val RES_YELLOW_BG = Color(0xFF4A3D0A)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { VoxApp() }
    }
}

@Composable
private fun VoxApp() {
    val context = LocalContext.current
    // Shared engine owned by VoiceCaptureService (so capture/haptics survive screen-off).
    val engine = AudioHub.engine
    val haptics = remember { Haptics(context) }

    var hasMic by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED
        )
    }
    var listening by remember { mutableStateOf(engine.isRunning) }
    var necklace by remember { mutableStateOf(AudioHub.necklaceActive.get()) }

    // Necklace settings, persisted across restarts via DataStore (milestone 5).
    val store = remember { SettingsStore(context) }
    val scope = rememberCoroutineScope()
    val settings by store.flow.collectAsState(initial = NecklaceSettings())
    val intensity = settings.intensity
    val lowHz = settings.lowHz
    val highHz = settings.highHz
    // Resonance target chosen as Dark / Mid / Bright (clearer than raw %); the goal
    // maps to a green band that drives both the haptic alerts and the pitch-screen
    // colour. With a per-user baseline (M9) the band recenters on the user's own voice.
    val resGoal = settings.resGoal
    val (resLow, resHigh) = resGoal.band(settings.resBaseline)
    // Readout representation (milestone 6).
    val pitchDisplay = settings.pitchDisplay
    val resDisplay = settings.resDisplay
    val pitchRefHz = if (lowHz > 0 && highHz > 0)
        kotlin.math.sqrt((lowHz.toFloat() * highHz.toFloat())) else 0f
    // Resonance measurement method (milestone 7) — pushed to the engine when it changes.
    val resonanceMethod = settings.resonanceMethod
    LaunchedEffect(resonanceMethod) { engine.setResonanceMethod(resonanceMethod) }
    // Per-room calibration (milestone 8): restore the saved floor, and persist a new
    // one whenever a capture completes.
    LaunchedEffect(settings.noiseFloor) { engine.setNoiseFloor(settings.noiseFloor) }
    val calibrating by engine.calibrating.collectAsState()
    val calibratedFloor by engine.calibratedFloor.collectAsState()
    LaunchedEffect(calibratedFloor) { if (calibratedFloor > 0f) store.setNoiseFloor(calibratedFloor) }
    // Per-user resonance baseline (M9): persist a freshly measured baseline.
    val calibratingBaseline by engine.calibratingBaseline.collectAsState()
    val resonanceBaselineResult by engine.resonanceBaselineResult.collectAsState()
    LaunchedEffect(resonanceBaselineResult) { if (resonanceBaselineResult > 0f) store.setResBaseline(resonanceBaselineResult) }
    // Tell the capture service whether to emit haptics (eyes-free necklace mode), and
    // lower the DSP cadence there to save battery (the visual meter stays full-rate).
    LaunchedEffect(necklace) {
        AudioHub.necklaceActive.set(necklace)
        AudioHub.engine.analysisDecimation = if (necklace) 2 else 1
    }

    // Start/stop is driven through the foreground service rather than the engine
    // directly, so a tracking session keeps running when the screen turns off.
    fun startTrackingService() {
        engine.start() // start capture directly so it works even if the FGS is restricted
        ContextCompat.startForegroundService(
            context,
            Intent(context, VoiceCaptureService::class.java).apply { action = VoiceCaptureService.ACTION_START }
        )
        listening = true
    }
    fun stopTrackingService() {
        context.startService(
            Intent(context, VoiceCaptureService::class.java).apply { action = VoiceCaptureService.ACTION_STOP }
        )
        engine.stop()
        listening = false
    }
    // M11: request POST_NOTIFICATIONS (Android 13+) so the ongoing service notification
    // shows; start tracking regardless of the outcome (the FGS still runs).
    val notifLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { _ -> startTrackingService() }
    fun beginTracking() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
        ) {
            notifLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            startTrackingService()
        }
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasMic = granted
        if (granted) beginTracking()
    }

    val level by engine.level.collectAsState()
    val pitchHz by engine.pitchHz.collectAsState()
    val pitchConfidence by engine.pitchConfidence.collectAsState()
    val resonance by engine.resonance.collectAsState()
    val resonanceConfidence by engine.resonanceConfidence.collectAsState()
    val f1Hz by engine.f1Hz.collectAsState()
    val f2Hz by engine.f2Hz.collectAsState()

    // NB: don't stop the engine on dispose — the service owns the capture lifecycle,
    // so the session continues when the Activity is backgrounded / screen-off.

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

    // Confidence-gated, two-metric directional alert loop (necklace mode only). Runs in
    // the Activity for reliable foreground vibration; the foreground service keeps the
    // process + mic + CPU alive so this keeps firing when the screen is off.
    LaunchedEffect(necklace, listening, intensity, lowHz, highHz, resLow, resHigh) {
        if (!necklace || !listening) return@LaunchedEffect
        var lastPitch = 0L
        var lastRes = 0L
        var lastAny = 0L
        while (true) {
            val now = System.currentTimeMillis()
            // Stay silent while a room/baseline calibration is capturing.
            val isCalibrating = engine.calibrating.value || engine.calibratingBaseline.value
            if (!isCalibrating && now - lastAny >= 250L) {
                val hz = engine.pitchHz.value
                val pConf = engine.pitchConfidence.value
                val rPct = engine.resonance.value * 100f
                val rConf = engine.resonanceConfidence.value

                var fired = false
                if (hz > 0f && pConf > 0.45f) {
                    val dir = if (hz < lowHz) "below" else if (hz > highHz) "above" else null
                    if (dir != null && now - lastPitch >= 600L) {
                        haptics.buzz(
                            HapticPatterns.patternFor("pitch", dir),
                            HapticPatterns.intensityToAmp(intensity)
                        )
                        lastPitch = now; lastAny = now; fired = true
                    }
                }
                if (!fired && rConf > 0.45f) {
                    val dir = if (rPct < resLow) "below" else if (rPct > resHigh) "above" else null
                    if (dir != null && now - lastRes >= 600L) {
                        haptics.buzz(
                            HapticPatterns.patternFor("resonance", dir),
                            HapticPatterns.intensityToAmp(intensity)
                        )
                        lastRes = now; lastAny = now
                    }
                }
            }
            delay(120)
        }
    }

    // Pitch screen background reflects resonance vs the chosen goal — green in range,
    // yellow out — but only while resonance is confidently voiced. Necklace mode = black.
    val screenBg = if (!necklace && resVoiced) {
        if (resPct >= resLow && resPct <= resHigh) RES_GREEN_BG else RES_YELLOW_BG
    } else Color.Black

    MaterialTheme {
        Box(
            modifier = Modifier.fillMaxSize().background(screenBg),
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
                        pitchDisplay = pitchDisplay, resDisplay = resDisplay, pitchRefHz = pitchRefHz,
                        onPitchDisplay = { scope.launch { store.setPitchDisplay(it) } },
                        onResDisplay = { scope.launch { store.setResDisplay(it) } },
                        resGoal = resGoal,
                        onResGoal = { scope.launch { store.setResGoal(it) } },
                        resBaseline = settings.resBaseline,
                        calibratingBaseline = calibratingBaseline,
                        onSetBaseline = { engine.startResonanceBaseline() },
                        resonanceMethod = resonanceMethod,
                        onResonanceMethod = { scope.launch { store.setResonanceMethod(it) } },
                        noiseFloor = settings.noiseFloor,
                        calibrating = calibrating,
                        onCalibrate = { engine.startCalibration() },
                        intensity = intensity, onIntensity = { scope.launch { store.setIntensity(it) } },
                        lowHz = lowHz, highHz = highHz,
                        onLow = { scope.launch { store.setLowHz((lowHz + it).coerceIn(80, highHz - 10)) } },
                        onHigh = { scope.launch { store.setHighHz((highHz + it).coerceIn(lowHz + 10, 350)) } },
                        onTestPitch = {
                            haptics.buzz(
                                HapticPatterns.patternFor("pitch", "below"),
                                HapticPatterns.intensityToAmp(intensity)
                            )
                        },
                        onTestRes = {
                            haptics.buzz(
                                HapticPatterns.patternFor("resonance", "below"),
                                HapticPatterns.intensityToAmp(intensity)
                            )
                        }
                    )
                }

                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = {
                        when {
                            !hasMic -> permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                            listening -> stopTrackingService()
                            else -> beginTracking()
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
    pitchDisplay: PitchDisplay, resDisplay: ResDisplay, pitchRefHz: Float,
    onPitchDisplay: (PitchDisplay) -> Unit, onResDisplay: (ResDisplay) -> Unit,
    resGoal: ResGoal, onResGoal: (ResGoal) -> Unit,
    resBaseline: Float, calibratingBaseline: Boolean, onSetBaseline: () -> Unit,
    resonanceMethod: ResonanceMethod, onResonanceMethod: (ResonanceMethod) -> Unit,
    noiseFloor: Float, calibrating: Boolean, onCalibrate: () -> Unit,
    intensity: Intensity, onIntensity: (Intensity) -> Unit,
    lowHz: Int, highHz: Int,
    onLow: (Int) -> Unit, onHigh: (Int) -> Unit,
    onTestPitch: () -> Unit,
    onTestRes: () -> Unit
) {
    // Pitch readout — value formatted in the user's chosen representation.
    val pv = Readout.pitch(pitchHz, pitchDisplay, pitchRefHz)
    val pitchStatus = when {
        !listening -> "Tap Start"
        !voiced -> "Listening…"
        direction == "below" -> "$pv · Low ↑"
        direction == "above" -> "$pv · High ↓"
        else -> "$pv · In range"
    }
    Text(
        text = pitchStatus,
        color = if (direction != null) ALERT else if (voiced) ACCENT else Color(0xFFB8B8C8),
        style = MaterialTheme.typography.title3,
        textAlign = TextAlign.Center
    )
    // Resonance readout — proves the second metric is being measured.
    val rv = Readout.resonance(resPct, f1Hz, f2Hz, resDisplay)
    val resStatus = when {
        !listening -> ""
        !resVoiced -> "Res —"
        resDirection == "below" -> "Res $rv · Dark ↑"
        resDirection == "above" -> "Res $rv · Bright ↓"
        else -> "Res $rv · In range"
    }
    Text(
        text = resStatus,
        color = if (resDirection != null) ALERT else if (resVoiced) ACCENT else Color(0xFF8C8C9C),
        style = MaterialTheme.typography.caption1,
        textAlign = TextAlign.Center
    )
    // In % mode, still surface the raw formants beneath; FORMANTS mode already shows them.
    if (resVoiced && resDisplay == ResDisplay.PERCENT && f1Hz > 0f && f2Hz > 0f) {
        Text(
            text = "F1 ${f1Hz.toInt()} · F2 ${f2Hz.toInt()}",
            color = Color(0xFF6A6A7A),
            style = MaterialTheme.typography.caption2,
            textAlign = TextAlign.Center
        )
    }
    Spacer(Modifier.height(10.dp))

    // Representation toggles (milestone 6).
    Text("Pitch as", color = Color(0xFF6A6A7A), style = MaterialTheme.typography.caption2)
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Seg("Hz", pitchDisplay == PitchDisplay.HZ) { onPitchDisplay(PitchDisplay.HZ) }
        Seg("Note", pitchDisplay == PitchDisplay.NOTE) { onPitchDisplay(PitchDisplay.NOTE) }
        Seg("St", pitchDisplay == PitchDisplay.RANGE) { onPitchDisplay(PitchDisplay.RANGE) }
    }
    Spacer(Modifier.height(4.dp))
    Text("Res as", color = Color(0xFF6A6A7A), style = MaterialTheme.typography.caption2)
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Seg("%", resDisplay == ResDisplay.PERCENT) { onResDisplay(ResDisplay.PERCENT) }
        Seg("F1/F2", resDisplay == ResDisplay.FORMANTS) { onResDisplay(ResDisplay.FORMANTS) }
    }
    Spacer(Modifier.height(10.dp))
    // ---- Resonance Customization ----
    Text("Resonance Customization", color = ACCENT, style = MaterialTheme.typography.caption1)
    Spacer(Modifier.height(4.dp))
    Text("Goal resonance range", color = Color(0xFF6A6A7A), style = MaterialTheme.typography.caption2)
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Seg("Dark", resGoal == ResGoal.DARK) { onResGoal(ResGoal.DARK) }
        Seg("Mid", resGoal == ResGoal.MID) { onResGoal(ResGoal.MID) }
        Seg("Bright", resGoal == ResGoal.BRIGHT) { onResGoal(ResGoal.BRIGHT) }
    }
    Spacer(Modifier.height(6.dp))
    // Per-user baseline (M9): targets become relative to the user's own voice.
    Text(
        text = when {
            calibratingBaseline -> "Hold a steady vowel…"
            resBaseline > 0f -> "Baseline ${resBaseline.toInt()}% · targets personalized"
            else -> "Baseline not set · using defaults"
        },
        color = if (calibratingBaseline) ALERT else Color(0xFF6A6A7A),
        style = MaterialTheme.typography.caption2,
        textAlign = TextAlign.Center
    )
    Spacer(Modifier.height(2.dp))
    Seg(if (calibratingBaseline) "…" else "Set baseline", false) { if (!calibratingBaseline) onSetBaseline() }
    Spacer(Modifier.height(4.dp))
    Text("Method", color = Color(0xFF6A6A7A), style = MaterialTheme.typography.caption2)
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Seg("LPC", resonanceMethod == ResonanceMethod.LPC) { onResonanceMethod(ResonanceMethod.LPC) }
        Seg("Centroid", resonanceMethod == ResonanceMethod.CENTROID) { onResonanceMethod(ResonanceMethod.CENTROID) }
    }
    Spacer(Modifier.height(8.dp))

    Text("Vibration strength", color = Color(0xFF6A6A7A), style = MaterialTheme.typography.caption2)
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Seg("Gentle", intensity == Intensity.GENTLE) { onIntensity(Intensity.GENTLE) }
        Seg("Med", intensity == Intensity.MEDIUM) { onIntensity(Intensity.MEDIUM) }
        Seg("Strong", intensity == Intensity.STRONG) { onIntensity(Intensity.STRONG) }
    }
    Spacer(Modifier.height(8.dp))

    Text("Pitch band (Hz)", color = Color(0xFF6A6A7A), style = MaterialTheme.typography.caption2)
    StepperRow("Low", lowHz, { onLow(-5) }, { onLow(5) })
    StepperRow("High", highHz, { onHigh(-5) }, { onHigh(5) })

    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Seg("Test pitch", false, onTestPitch)
        Seg("Test res", false, onTestRes)
    }

    Spacer(Modifier.height(8.dp))
    // Per-room calibration (milestone 8): capture the ambient floor so the silence
    // gate adapts to this room / chest-mic placement.
    Text(
        text = when {
            calibrating -> "Calibrating… stay quiet"
            noiseFloor > 0f -> "Room set · gate ${(noiseFloor * 1000).toInt()}"
            else -> "Room: default gate"
        },
        color = if (calibrating) ALERT else Color(0xFF6A6A7A),
        style = MaterialTheme.typography.caption2,
        textAlign = TextAlign.Center
    )
    Spacer(Modifier.height(4.dp))
    Seg(if (calibrating) "…" else "Calibrate room", false) { if (!calibrating) onCalibrate() }
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
