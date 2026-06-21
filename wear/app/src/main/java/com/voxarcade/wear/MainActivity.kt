package com.voxarcade.wear

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text

/**
 * Native (no-WebView) entry point for the Wear OS app.
 *
 * The previous build hosted the web app in a [android.webkit.WebView], which the
 * Galaxy Watch 7 cannot instantiate (it throws UnsupportedOperationException — the
 * watch ships no usable WebView), so the app crashed on launch. This is the fresh
 * native rebuild. Milestone 1 just proves the foundation runs on the watch: it
 * requests the mic and shows a live input level. Pitch/resonance + necklace haptics
 * land in the following milestones (MicEngine already captures the audio frames).
 */
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

    var hasMic by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED
        )
    }
    var listening by remember { mutableStateOf(false) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasMic = granted
        if (granted) { engine.start(); listening = true }
    }

    val level by engine.level.collectAsState()

    DisposableEffect(Unit) {
        onDispose { engine.stop() }
    }

    MaterialTheme {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black),
            contentAlignment = Alignment.Center
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Text(
                    text = "Vox Native",
                    color = Color(0xFF34D6C8),
                    style = MaterialTheme.typography.title3
                )
                Text(
                    text = if (listening) "Listening" else "Tap to listen",
                    color = Color(0xFFB8B8C8),
                    style = MaterialTheme.typography.caption1
                )

                Box(
                    modifier = Modifier
                        .padding(top = 10.dp)
                        .size(96.dp),
                    contentAlignment = Alignment.Center
                ) {
                    // Scale the RMS up so quiet speech still moves the ring.
                    CircularProgressIndicator(
                        progress = (level * 6f).coerceIn(0f, 1f),
                        modifier = Modifier.fillMaxSize(),
                        indicatorColor = Color(0xFF34D6C8),
                        trackColor = Color(0xFF1A2A30)
                    )
                    Text(
                        text = "${(level * 100f).coerceIn(0f, 99f).toInt()}",
                        color = Color.White,
                        style = MaterialTheme.typography.title2
                    )
                }

                Button(
                    onClick = {
                        when {
                            !hasMic -> permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                            listening -> { engine.stop(); listening = false }
                            else -> { engine.start(); listening = true }
                        }
                    },
                    modifier = Modifier.padding(top = 12.dp)
                ) {
                    Text(if (listening) "Stop" else "Start")
                }
            }
        }
    }
}
