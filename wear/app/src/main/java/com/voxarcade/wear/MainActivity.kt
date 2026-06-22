package com.voxarcade.wear

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text

/**
 * Native Wear OS entry point (M1).
 *
 * This is the fresh, no-WebView foundation: a Compose-for-Wear app that launches,
 * requests the mic permission, and shows a live input level straight from
 * [AudioEngine]. It exists to prove the native shell runs on the Galaxy Watch 7 —
 * the exact thing the WebView build could not do. Pitch/resonance and the necklace
 * haptics are layered on this loop in later milestones.
 */
class MainActivity : ComponentActivity() {

    private val audio = AudioEngine()

    private var hasMic by mutableStateOf(false)

    private val requestMic =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            hasMic = granted
            if (granted) audio.start()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        hasMic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

        setContent {
            MaterialTheme {
                MicScreen(audio, hasMic) { requestMic.launch(Manifest.permission.RECORD_AUDIO) }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        if (hasMic) audio.start()
    }

    override fun onStop() {
        super.onStop()
        audio.stop()
    }
}

@Composable
private fun MicScreen(audio: AudioEngine, hasMic: Boolean, onRequestMic: () -> Unit) {
    val level by audio.level.collectAsStateWithLifecycle()
    val running by audio.running.collectAsStateWithLifecycle()
    val error by audio.error.collectAsStateWithLifecycle()

    Box(
        modifier = Modifier.fillMaxSize().background(Color.Black),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                text = "Vox Ball",
                color = Color(0xFF34D6C8),
                style = MaterialTheme.typography.title3
            )

            // Live level: a dot that grows with input loudness (24..96 dp).
            val dotSize = (24f + level * 72f).dp
            Box(
                modifier = Modifier
                    .size(96.dp),
                contentAlignment = Alignment.Center
            ) {
                Box(
                    modifier = Modifier
                        .size(dotSize)
                        .clip(CircleShape)
                        .background(levelColor(level))
                )
            }

            val status = when {
                error != null -> error!!
                !hasMic -> "Tap to allow mic"
                running -> "Listening — speak"
                else -> "Starting…"
            }
            Text(
                text = status,
                color = Color(0xFFB8B8C8),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.caption2,
                modifier = Modifier.padding(horizontal = 16.dp)
            )
        }

        // Whole-screen tap target to (re)request the mic when it isn't granted.
        if (!hasMic) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                        onClick = onRequestMic
                    )
            )
        }
    }
}

private fun levelColor(level: Float): Color {
    // Aqua → amber as the level rises, so loudness reads at a glance.
    val t = level.coerceIn(0f, 1f)
    val r = (0x34 + (0xFF - 0x34) * t).toInt()
    val g = (0xD6 + (0x8E - 0xD6) * t).toInt()
    val b = (0xC8 + (0x53 - 0xC8) * t).toInt()
    return Color(r, g, b)
}
