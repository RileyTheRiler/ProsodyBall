# ProsodyWear — Standalone Wear OS Voice Monitor

A native Wear OS companion to Vox Arcade that runs **entirely on the watch — no
phone required**. It listens continuously through the watch microphone (or a
Bluetooth earpiece), runs the same prosody analysis as the web app, and coaches
you with **haptic vibration patterns** and **spoken/tone audio cues** when your
voice drifts from your targets.

## What it monitors

All four metric families from the web analyzer:

| Family | Metrics | Alerts |
| --- | --- | --- |
| Pitch | level vs your target band (Hz) | pitch low / pitch high |
| Expressiveness | pitch variation (bounce), tempo, syllable separation | monotone, too fast, mushy |
| Vocal weight / resonance | spectral tilt (H1−H2), formants F1–F3 | too heavy/light, resonance dark/bright |
| Volume | energy vs your calibrated baseline | too loud / too quiet |

## Modes

- **Normal** — haptics + audio cues out loud (watch speaker or Bluetooth earpiece).
- **Discrete** — the disguised watch-face screen: looks like a plain digital
  clock; the seconds ring's hue subtly tracks your pitch and a small dot
  flashes after an alert. The watch speaker is hard-muted by `FeedbackPolicy`
  (not just UI state); audio cues go to a Bluetooth earpiece only if you opt
  in. Haptics always work. Long-press 2s to exit.
  Note: it's an app screen, not a system watch face — a real watch face cannot
  own a microphone foreground service, so leaving the app pauses the disguise
  (monitoring itself continues in the background service).
- **Silent** — haptics only, audio off everywhere.

Each alert type has a distinct vibration pattern (legend in Settings), so with
a little practice the watch can coach you eyes-free and in total silence.

## Architecture

```
wear/
├── dsp/   Pure-JVM Kotlin port of the web VoiceAnalyzer (app.js) + dsp-utils.js
│          — YIN pitch detection, AnalyserNode-emulating spectrum analysis,
│          spectral tilt, H1-H2, harmonic-envelope formants, syllable/vowel/
│          attack metrics, adaptive calibration, plus the FeedbackEngine
│          drift-detection state machine. Zero Android dependencies.
└── app/   Wear OS app: AudioRecord capture (16 kHz mono float, 16 ms hops),
           microphone foreground service, haptics/TTS/tone cues, Compose UI
           (monitor / disguise / calibration / settings / summary).
```

The DSP constants are carried over verbatim from `app.js:20-41` (each one
annotated with its source line in `AnalyzerConfig.kt`), and the
`SpectrumAnalyzer` replicates Web Audio `AnalyserNode` semantics (Blackman
window, per-frame EMA smoothing, dB float data, byte mapping over
[−100, −30] dB) so the web app's tuned thresholds behave identically.
16 kHz capture keeps every analysis band (tilt ≤ 5 kHz, formants ≤ 5.5 kHz,
articulation ≥ 2 kHz) under Nyquist at a third of the CPU of 48 kHz, and
matches Bluetooth SCO wideband.

`metrics.tempo` is implemented on-watch (`TempoTracker`) — the web analyzer
documents it but never wired it up.

## Building

```bash
cd wear
./gradlew :dsp:test          # DSP unit tests — pure JVM, no Android SDK needed
./gradlew :app:assembleDebug # Wear OS APK (needs the Android SDK)
adb install app/build/outputs/apk/debug/app-debug.apk
```

The DSP tests validate the port against the **same fixtures the web app's CI
uses**: `fixtures/audio-eval/reference-frames.json` (gating/normalization
math) and `rainbow_passage.wav` streamed end-to-end through the analyzer
(calibration timing, voiced-frame pitch plausibility, adaptive profile
learning, metric boundedness, narrowband degradation, per-hop CPU budget).

## Manual on-watch test checklist

These cannot run in CI — verify on a watch (or the Wear emulator, which can
use the host microphone) before a release:

1. **Permission flow**: first launch asks for microphone; denying shows the
   "Allow microphone" chip; granting enables Start.
2. **Live pitch**: start a session, hum a rising glide — the Hz readout and
   dial should track smoothly upward.
3. **Calibration wizard**: completes in a quiet room (quiet → "ahhh" → ~30s of
   speech); near a loud fan the quiet step still completes but pitch detection
   stays gated until you speak above the noise.
4. **Screen-off session**: start a session, lower your wrist for 10 minutes,
   keep talking periodically — the ongoing-activity chip stays on the watch
   face, and haptic alerts still fire with the screen off.
5. **Haptic legend**: trigger each alert deliberately (e.g. drone in a monotone
   for MONOTONE, speak below your pitch floor for PITCH_LOW) and confirm the
   patterns are distinguishable on-wrist; verify the cooldown prevents
   re-buzzing within 30s.
6. **Audio cues**: spoken cues play on the speaker in normal mode; switch to
   tones and confirm glide direction matches the correction; pair a Bluetooth
   earpiece and confirm cues route to it; pull the earpiece mid-session and
   confirm fallback.
7. **Bluetooth mic**: set Mic to Bluetooth headset with an earpiece paired —
   the monitor shows the "narrowband mic" badge and pitch still tracks.
8. **Discrete mode**: set mode to discrete, open the disguise screen, trigger
   alerts — zero sound from the speaker under any alert type; the ring hue and
   dot respond; long-press exits.
9. **Battery**: a 1-hour continuous session should drain well under ~10%
   (silence duty-cycling keeps the FFT path idle when you're not speaking).

## Known limitations

- The disguise screen pauses when you leave the app (see above); monitoring
  and haptics continue via the foreground service.
- Bluetooth SCO may negotiate 8 kHz narrowband: spectral tilt, articulation,
  and F3 degrade (every band is clamped under Nyquist automatically and the
  UI shows a badge), so prefer the watch mic for resonance work.
- Ambient (always-on) display integration is not yet wired; the system dims
  the screen normally.
- Watch-mic AGC/NS varies by OEM; `VOICE_RECOGNITION` capture plus the
  analyzer's own noise calibration absorbs most of it, but energy thresholds
  may deserve a tuning pass on your specific hardware.
