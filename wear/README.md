# Vox Necklace — native Wear OS app (Galaxy Watch 7)

An eyes-free, on-device voice-feedback app for wearing the watch as a **pendant
near your mouth**. Tap to start listening; the watch **buzzes when your voice
drifts out of your target range** (pitch, and optionally brightness/resonance).
For private practice or discreet use out in the world.

> **Why native (not the web app)?** The Galaxy Watch 7 — like other Samsung
> Galaxy Watches — **ships without Android System WebView**, so a WebView-based
> wrapper crashes on launch (`WebViewFactory.getProvider` →
> `UnsupportedOperationException`). This app therefore does all voice analysis
> natively in Kotlin, with no WebView and no network.

- **Target device:** Samsung Galaxy Watch 7 (Wear OS 5). Works on any Wear OS 3+
  watch (`minSdk 30`).

## 📲 Install it

See **[SETUP.md](SETUP.md)** for the full step-by-step sideload guide (install
ADB → download the APK → pair over Wi-Fi → `adb install`). The app appears on the
watch as **Vox Necklace**.

## Using it

- **Tap the big circle** to start/stop listening. The mic is **off until you
  start it** and is **released when you stop** (saves battery, and it isn't
  hearing other people). One buzz = on, two buzzes = off — so you know eyes-free.
- **Status dot:** grey = off, green = listening & in range, orange = out of range
  (buzzing). It only buzzes **while you're actually speaking**, with a short
  cooldown so it nudges rather than nags.
- **Pitch range** defaults to **150–250 Hz**.
- **Calibrate** — tap *Calibrate* and speak in your target voice for ~4 seconds.
  It sets your pitch range to your own median ±25 Hz and enables a
  brightness/resonance range (±350) from your voice. Saved across launches.
- The screen stays **dark and dim** (it's under your collar); use the on-screen
  toggle as your main battery control.

## How it's built

| File | Purpose |
|------|---------|
| `app/src/main/java/com/voxarcade/wear/VoiceAnalyzer.kt` | Captures the mic (`AudioRecord`, 16 kHz) on a background thread and computes **pitch** (YIN), **brightness** (spectral centroid via `Fft`), and **loudness** (RMS gate). |
| `app/src/main/java/com/voxarcade/wear/Fft.kt` | Small radix-2 FFT used for the spectral centroid. |
| `app/src/main/java/com/voxarcade/wear/MainActivity.kt` | UI (dark round layout, toggle, status dot, readouts), permission handling, the out-of-range **alert + vibration** logic, and voice **calibration** with `SharedPreferences` persistence. |
| `app/src/main/res/layout/activity_main.xml` | The watch UI. |

The DSP (YIN pitch + centroid) was validated against a JavaScript prototype on
synthetic tones (accurate to a fraction of a Hz) before being ported to Kotlin.

## Building locally (optional)

Requires the Android SDK + JDK 17:
```bash
cd wear
gradle :app:assembleDebug      # or ./gradlew if you generate a wrapper
# → app/build/outputs/apk/debug/app-debug.apk
```
Or just download the APK artifact from the **Build Wear OS APK** GitHub Actions run.

## Roadmap / known limitations (v1)

- **Foreground only:** it listens while the app is open with the screen dark, not
  while the watch fully sleeps. Toggle the mic off when you're not practicing.
  (A foreground microphone service for true screen-off use is a future step.)
- **Resonance is a proxy:** "brightness" (spectral centroid) is a simpler stand-in
  for the web app's formant-based resonance. Calibration makes it personal and
  useful; a fuller formant analysis could be ported later.
