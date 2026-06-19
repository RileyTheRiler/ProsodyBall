# Vox Ball for Wear OS (Galaxy Watch 7)

A thin Wear OS app that runs the existing ProsodyBall web app full-screen on your
watch and boots straight into the **Vox Ball** voice-training mode. It reuses the
exact same audio/DSP engine as the web app — there is no separate logic to maintain.

- **Target device:** Samsung Galaxy Watch 7 (Wear OS 5). Works on any Wear OS 3+
  watch (`minSdk 30`).
- **What it does:** opens a single full-screen WebView, asks for the microphone,
  shows a *Tap to start* screen, and launches Vox Ball — the ball reacts to the
  pitch and rhythm of your voice picked up by the watch mic.

## How it's put together

| Piece | Purpose |
|-------|---------|
| `app/src/main/java/com/voxarcade/wear/MainActivity.kt` | The whole native app: one full-screen `WebView`, mic-permission handling, keep-screen-on. |
| `assets-overlay/watch.css` + `watch-boot.js` | Watch adaptation layer injected at runtime. Hides menus/meters, fills the round screen, auto-launches Vox Ball. The canonical `index.html` is never edited. |
| `app/build.gradle.kts` (`copyWebApp` task) | Copies the root web app (`index.html`, `app.js`, `dsp-utils.js`, …) + the overlay into the APK's assets at build time. |

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
   microphone** when prompted. Tap *Tap to start* and speak — the ball responds to
   your pitch and rhythm.

### Troubleshooting

- **"Mic blocked — tap to retry":** the microphone permission was denied. Grant it
  in Settings → Apps → Vox Ball → Permissions, then reopen.
- **`adb connect` fails:** confirm both devices are on the same network and that
  *Debug over Wi-Fi* is still on (it can time out). Re-open Developer options to
  refresh the IP/port.
- **Battery:** continuous mic capture + rendering is power-hungry; expect notably
  faster drain during a session. The screen is kept awake on purpose while the app
  is open.
