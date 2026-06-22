package com.voxarcade.wear

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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

/** Teal used for normal/in-range readouts and the active meter. */
private val ACCENT = Color(0xFF34D6C8)

/** Amber used to flag an out-of-range pitch alert. */
private val ALERT = Color(0xFFFFA03C)

/** Resonance zone colors — fixed thirds of the 0..100% scale, independent of the
 *  user's configurable alert band, so the readout always shows where you actually
 *  are (forward/bright, neutral/mid, or backed-off/dark resonance). */
private val RES_BRIGHT = Color(0xFF34D6C8)
private val RES_MID = Color(0xFFE0B84A)
private val RES_DARK = Color(0xFF7C8CFF)

/** The three top-level views the watch face can show. */
private enum class ViewTab { VOICE, NECKLACE, SCREEN }

/** Resonance alert-band presets as (low%, high%) — each targets one third of the
 *  0..100 brightness scale. Tapping one sets the band; the user can still fine-tune. */
private val RES_PRESET_DARK = 10 to 35
private val RES_PRESET_MID = 38 to 62
private val RES_PRESET_BRIGHT = 65 to 90

/** Single-activity entry point; hosts the whole UI in one [VoxApp] composable. */
class MainActivity : ComponentActivity() {
    /** Sets the Compose content tree as the activity's view. */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { VoxApp() }
    }
}

/**
 * Root composable: owns the [MicEngine] lifecycle and RECORD_AUDIO permission,
 * collects the live pitch/resonance flows, persists necklace settings, and renders
 * the meter plus [NecklaceControls]. Stops the engine on teardown.
 */
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
    var viewTab by remember { mutableStateOf(ViewTab.VOICE) }

    // Necklace settings, persisted across restarts via DataStore (milestone 5).
    val store = remember { SettingsStore(context) }
    val scope = rememberCoroutineScope()
    val settings by store.flow.collectAsState(initial = NecklaceSettings())
    val mode = settings.mode
    val intensity = settings.intensity
    val lowHz = settings.lowHz
    val highHz = settings.highHz
    // Resonance band in % brightness (0 = dark, 100 = bright/forward).
    val resLow = settings.resLow
    val resHigh = settings.resHigh
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

    // Confidence-gated directional alert loop — runs across all three views (Voice,
    // Necklace, Screen), since out-of-range feedback shouldn't depend on which view
    // is on screen. Two metrics: pitch takes priority (fix the fundamental first);
    // resonance fires when pitch is in range. A short global gap keeps the two
    // buzzes from colliding.
    LaunchedEffect(listening, mode, intensity, lowHz, highHz, resLow, resHigh) {
        if (!listening) return@LaunchedEffect
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
                    Seg("Voice", viewTab == ViewTab.VOICE) { viewTab = ViewTab.VOICE }
                    Seg("Necklace", viewTab == ViewTab.NECKLACE) { viewTab = ViewTab.NECKLACE }
                    Seg("Screen", viewTab == ViewTab.SCREEN) { viewTab = ViewTab.SCREEN }
                }
                Spacer(Modifier.height(10.dp))

                when (viewTab) {
                    ViewTab.VOICE -> PitchMeter(voiced, pitchHz, level)
                    ViewTab.SCREEN -> ScreenView()
                    ViewTab.NECKLACE -> NecklaceControls(
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
                        resonanceMethod = resonanceMethod,
                        onResonanceMethod = { scope.launch { store.setResonanceMethod(it) } },
                        noiseFloor = settings.noiseFloor,
                        calibrating = calibrating,
                        onCalibrate = { engine.startCalibration() },
                        mode = mode, onMode = { scope.launch { store.setMode(it) } },
                        intensity = intensity, onIntensity = { scope.launch { store.setIntensity(it) } },
                        lowHz = lowHz, highHz = highHz,
                        onLow = { scope.launch { store.setLowHz((lowHz + it).coerceIn(80, highHz - 10)) } },
                        onHigh = { scope.launch { store.setHighHz((highHz + it).coerceIn(lowHz + 10, 350)) } },
                        resLow = resLow, resHigh = resHigh,
                        onResLow = { scope.launch { store.setResLow((resLow + it).coerceIn(0, resHigh - 5)) } },
                        onResHigh = { scope.launch { store.setResHigh((resHigh + it).coerceIn(resLow + 5, 100)) } },
                        onResPreset = { lo, hi -> scope.launch { store.setResLow(lo); store.setResHigh(hi) } },
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

/**
 * Circular progress ring driven by pitch when [voiced] (mapped across the speech
 * range), otherwise by input [level] — a quick visual that the mic is live.
 */
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

/**
 * Screen mode: shows a full-size image instead of the pitch meter or necklace panel —
 * useful when the watch should display something innocuous while haptic feedback
 * (driven by the same alert loop as Voice/Necklace, using the user's set ranges) keeps
 * running in the background. Swap [R.drawable.screen_image] for your own photo; see
 * the comment in that file for how.
 */
@Composable
private fun ScreenView() {
    Image(
        painter = painterResource(id = R.drawable.screen_image),
        contentDescription = null,
        modifier = Modifier.size(160.dp).clip(RoundedCornerShape(80.dp)),
        contentScale = ContentScale.Crop
    )
}

/**
 * The necklace-mode control panel: live pitch/resonance readouts (formatted per the
 * chosen representation), the mode/intensity/band selectors, resonance method and
 * per-room calibration controls, and test-buzz buttons. All state is hoisted — this
 * composable only renders and forwards user actions to the supplied callbacks.
 */
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
    resonanceMethod: ResonanceMethod, onResonanceMethod: (ResonanceMethod) -> Unit,
    noiseFloor: Float, calibrating: Boolean, onCalibrate: () -> Unit,
    mode: HapticMode, onMode: (HapticMode) -> Unit,
    intensity: Intensity, onIntensity: (Intensity) -> Unit,
    lowHz: Int, highHz: Int,
    onLow: (Int) -> Unit, onHigh: (Int) -> Unit,
    resLow: Int, resHigh: Int,
    onResLow: (Int) -> Unit, onResHigh: (Int) -> Unit,
    onResPreset: (Int, Int) -> Unit,
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
    // Resonance readout — proves the second metric is being measured. The zone
    // (Bright/Mid/Dark) is fixed thirds of the 0..100% scale, so it always reflects
    // where the voice actually sits; the ↑/↓ arrow layers on top when that's also
    // outside the user's configured alert band (resLow/resHigh).
    val rv = Readout.resonance(resPct, f1Hz, f2Hz, resDisplay)
    val resZone = when {
        resPct >= 66f -> "Bright"
        resPct < 34f -> "Dark"
        else -> "Mid"
    }
    val resColor = when {
        resPct >= 66f -> RES_BRIGHT
        resPct < 34f -> RES_DARK
        else -> RES_MID
    }
    val resStatus = when {
        !listening -> ""
        !resVoiced -> "Res —"
        resDirection == "below" -> "Res $rv · $resZone ↑"
        resDirection == "above" -> "Res $rv · $resZone ↓"
        else -> "Res $rv · $resZone"
    }
    Text(
        text = resStatus,
        color = if (resVoiced) resColor else Color(0xFF8C8C9C),
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
    Spacer(Modifier.height(4.dp))
    // Resonance measurement method (milestone 7) — how F1/F2 are derived.
    Text("Res method", color = Color(0xFF6A6A7A), style = MaterialTheme.typography.caption2)
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Seg("Harm", resonanceMethod == ResonanceMethod.HARMONIC) { onResonanceMethod(ResonanceMethod.HARMONIC) }
        Seg("Ceps", resonanceMethod == ResonanceMethod.CEPSTRAL) { onResonanceMethod(ResonanceMethod.CEPSTRAL) }
    }
    Spacer(Modifier.height(4.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Seg("LPC", resonanceMethod == ResonanceMethod.LPC) { onResonanceMethod(ResonanceMethod.LPC) }
        Seg("Centr", resonanceMethod == ResonanceMethod.CENTROID) { onResonanceMethod(ResonanceMethod.CENTROID) }
    }
    Spacer(Modifier.height(8.dp))

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
    // Quick presets that drop the alert band onto the dark / mid / bright third of the
    // scale; the steppers below still let the user fine-tune from there.
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Seg("Dark", resLow == RES_PRESET_DARK.first && resHigh == RES_PRESET_DARK.second) {
            onResPreset(RES_PRESET_DARK.first, RES_PRESET_DARK.second)
        }
        Seg("Mid", resLow == RES_PRESET_MID.first && resHigh == RES_PRESET_MID.second) {
            onResPreset(RES_PRESET_MID.first, RES_PRESET_MID.second)
        }
        Seg("Bright", resLow == RES_PRESET_BRIGHT.first && resHigh == RES_PRESET_BRIGHT.second) {
            onResPreset(RES_PRESET_BRIGHT.first, RES_PRESET_BRIGHT.second)
        }
    }
    Spacer(Modifier.height(4.dp))
    StepperRow("Dark", resLow, { onResLow(-5) }, { onResLow(5) })
    StepperRow("Brt", resHigh, { onResHigh(-5) }, { onResHigh(5) })

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

/** A compact segmented-button chip; [selected] tints it with the accent colour. */
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

/** Labelled −/value/+ row for nudging an integer band edge up or down. */
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

/** Small square +/− button used by [StepperRow]. */
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
