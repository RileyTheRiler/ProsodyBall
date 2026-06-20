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
  resonance range (±350) from your voice. Saved across launches.
- **⚙ Settings** — turn each alert on/off, nudge the pitch/resonance ranges,
  and set **buzz strength** and **mic sensitivity** without re-calibrating.
- **Runs with the screen off:** a foreground microphone service keeps listening
  and buzzing when the screen sleeps or the app is backgrounded, so it works as a
  real necklace under your clothes. A persistent "Listening" notification shows
  while it's active. Tap the circle to stop (which releases the mic).
- The screen stays **dark and dim** (it's under your collar).

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

## DSP accuracy

- **Pitch:** YIN with parabolic interpolation, a 5-tap median filter, an
  octave-jump guard, and 50% frame overlap for smooth, low-latency tracking.
- **Resonance:** LPC formant estimation (pre-emphasis → Hamming → autocorrelation
  → Levinson-Durbin → spectral-envelope peak picking), reported as the mean of F1
  and F2. Validated against synthetic vowels (formants recovered within ~10–40 Hz).

## Roadmap

- Continuous battery use while listening — toggle off when you're not practicing.
- Session stats (time on target), directional "too high / too low" haptics, and a
  tile/complication for one-tap launch are natural next steps.
