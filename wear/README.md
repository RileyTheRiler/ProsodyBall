# Vox Arcade for Wear OS (Galaxy Watch 7)

A thin Wear OS app that runs the existing ProsodyBall web app full-screen on your
watch. It reuses the exact same audio/DSP engine as the web app — there is no
separate logic to maintain. On launch you pick one of two modes:

- **Vox Ball** — the visual voice-training game; the ball reacts to the pitch and
  rhythm of your voice picked up by the watch mic.
- **Necklace** — an eyes-free haptic mode for wearing the watch as a **pendant near
  your mouth**. The screen stays dark and the watch **buzzes when your voice drifts
  out of range** (pitch and/or resonance by default). Built for private practice or
  discreet use out in the world.

- **Target device:** Samsung Galaxy Watch 7 (Wear OS 5). Works on any Wear OS 3+
  watch (`minSdk 30`).

## Necklace mode (haptic biofeedback)

Wear the watch on a lanyard/pendant so the mic sits closer to your mouth, then pick
**Necklace** on the launch screen.

- **Big Start/Stop button** — tap to turn the mic on/off. The mic is **off by
  default** and **fully released when stopped**, so it saves battery and doesn't
  listen to other people in public. A single buzz confirms *on*; a double buzz
  confirms *off* — so you can tell eyes-free.
- **Status dot** — grey = mic off, green = listening & in range, orange = out of
  range (and buzzing).
- **Buzz when out of range** — uses the engine's own alert rules. It only fires
  **while you're actually speaking**, with a short cooldown so it nudges rather than
  nags. Defaults to **pitch 150–250 Hz** and **resonance 30–70%**.
- **⚙ Alerts** — opens the rule panel to change which metric(s) trigger, the
  direction (drops below / goes above), and the thresholds. Your custom rules are
  preserved across sessions.
- **Dark + dim** — the screen is pure black at low brightness (OLED pixels off ≈
  minimal power) since it's under your collar. Use the **Start/Stop toggle** as your
  main battery control.

> Note (v1): the app keeps running in the foreground while listening, so analysis
> continues with the screen dark but not while the watch goes fully to sleep. Toggle
> the mic off when you're not practicing. True screen-off background listening is a
> possible future enhancement (foreground mic service + off-render-loop analysis).

## How it's put together

| Piece | Purpose |
|-------|---------|
| `app/src/main/java/com/voxarcade/wear/MainActivity.kt` | The native shell: one full-screen `WebView`, mic-permission handling, keep-screen-on, a **native Vibrator bridge** (`AndroidHaptics`) so the page's `navigator.vibrate` produces strong, reliable buzzes, and a **brightness bridge** (`AndroidScreen`) for necklace mode. |
| `assets-overlay/watch.css` + `watch-boot.js` | Watch adaptation layer injected at runtime: the launch chooser, the Vox Ball layout, and the necklace UI (mic toggle, status dot, alert seeding). The canonical `index.html` is never edited. |
| `app/build.gradle.kts` (`copyWebApp` task) | Copies the root web app (`index.html`, `app.js`, `dsp-utils.js`, …) + the overlay into the APK's assets at build time. |

The biofeedback itself is the web app's existing vibration rule engine
(`window.voxGame.vibration`); the watch layer just seeds sensible defaults and routes
haptics to the system vibrator.

The copied web assets live under `app/src/main/assets/web/` and are **git-ignored**
— they're generated from the repo root on every build, so the web app stays the
single source of truth.

## Getting an installable APK (no Android Studio needed)

A GitHub Actions workflow builds the APK for you:

1. Push to the `claude/wear-os-smartwatch-support-*` branch (or run the
   **Build Wear OS APK** workflow manually from the Actions tab).
2. Open the finished run → **Artifacts** → download `vox-ball-wear-debug-apk`.
3. Unzip it to get `app-debug.apk`.

### Build locally instead (optional)

Requires the Android SDK + JDK 17:

```bash
cd wear
gradle :app:assembleDebug      # or ./gradlew if you generate a wrapper
# → app/build/outputs/apk/debug/app-debug.apk
```

## Sideloading onto the Galaxy Watch 7

You need [ADB](https://developer.android.com/tools/adb) (part of the Android
platform-tools) on a computer on the **same Wi-Fi network** as the watch.

1. **On the watch — enable developer + ADB:**
   - Settings → About watch → Software → tap **Software version** ~7 times until
     "Developer mode" turns on.
   - Settings → Developer options → enable **ADB debugging** and **Debug over Wi-Fi**.
   - Note the IP address shown under *Debug over Wi-Fi* (e.g. `192.168.1.42`).

2. **On your computer — connect and install:**
   ```bash
   adb connect 192.168.1.42:5555
   adb install -r app-debug.apk
   ```
   Accept the "Allow debugging?" prompt on the watch the first time.

3. **Launch it** from the watch's app list as **Vox Ball**, then **allow the
   microphone** when prompted. Pick **Vox Ball** (visual) or **Necklace** (eyes-free
   haptics) on the launch screen and speak.

### Troubleshooting

- **"Mic blocked — retry":** the microphone permission was denied. Grant it
  in Settings → Apps → Vox Ball → Permissions, then reopen.
- **No buzz in necklace mode:** confirm the watch isn't in a Do-Not-Disturb/theater
  mode that suppresses vibration, and that you're actually speaking (alerts only fire
  on voiced input). Use **⚙ Alerts** to check a rule is enabled.
- **`adb connect` fails:** confirm both devices are on the same network and that
  *Debug over Wi-Fi* is still on (it can time out). Re-open Developer options to
  refresh the IP/port.
- **Battery:** continuous mic capture + rendering is power-hungry; expect notably
  faster drain during a session. The screen is kept awake on purpose while the app
  is open.
