# ProsodyBall — Standalone Voice Trainer for LilyGo T-Watch 2020 V3

A wearable, self-contained voice trainer. The watch listens with its **own** built-in PDM
microphone, runs pitch + energy + brightness analysis **on-device** (no phone, no browser,
no Bluetooth), and visualises it on its 240×240 screen. **Two visualisations**, switchable
in Settings:

- **Vox Ball** — a ball whose height & colour follow **pitch** (low=blue → high=pink) and
  that **hops on each syllable**; livelier intonation makes the hop taller. A dashed
  **target band** lets you train toward a pitch range (green glow + buzz + on-target %).
- **Color** — the **whole screen** colours from a metric **you choose** (pitch, brightness,
  bounce, loudness, or **perceived gender**), blended between **two colours you pick**.
  Louder = brighter. *Gender* blends pitch + vocal-tract resonance (0 = masculine … 1 = feminine).

Everything is **customisable on-device and saved to flash**: mode, the metric that drives
colour, the two colours, the haptic trigger + threshold, and the target band.

> The browser-driven LED orb lives in [`../prosodyball_orb`](../prosodyball_orb) and is a
> completely separate project — that one does no audio processing.

## Hardware

Only the **T-Watch 2020 V3** is supported — it is the variant that added the on-board
**PDM microphone** ([product page](https://lilygo.cc/products/t-watch-2020-v3)). The V1/V2
have no microphone and will not work. Nothing to wire — mic, display, touch, and battery
are all on the watch.

## Flash the firmware (Arduino IDE)

1. Install the **Arduino IDE**.
2. Add ESP32 support: *File → Preferences → Additional Boards Manager URLs* →
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`, then
   *Boards Manager → install "esp32"*.
3. *Library Manager → install **"TTGO TWatch Library"*** (by Lewis He / LilyGo). This wraps
   the display (TFT_eSPI), the AXP202 power chip, touch, and exposes the V3 PDM mic.
4. Open `twatch_voxball/twatch_voxball.ino`. Keep all four files in the folder:
   `twatch_voxball.ino`, `config.h`, `dsp.h`, `dsp.cpp`.
5. Select board **"TTGO T-Watch"**, choose your port, and click **Upload**.

`config.h` already sets `#define LILYGO_WATCH_2020_V3` before including the library, so the
correct (V3) pin map and microphone support are compiled in.

## Power-on self-test

On boot the screen flashes **soft teal** (mirroring the orb sketch's self-test), then shows
*"Vox Ball — calibrating mic…"*. Use the splash to sanity-check the build *before* speaking:

- Nothing lights up → check the board is powered/charged and the correct board is selected.
- It boots but never leaves "Calibrating… stay quiet" → the mic isn't producing data; see
  *Tuning & troubleshooting*.

## Using it

1. After the splash, the firmware spends ~1 second measuring the room's **noise floor** —
   stay quiet during "Calibrating… stay quiet".
2. Speak. The ball rises with pitch, hops on each syllable, and shifts blue → pink.
3. **Train toward the target band.** Two dashed lines mark a target pitch range. When your
   voice sits inside it, the ball **glows green, the motor buzzes once**, and the bottom HUD
   tracks your **% of voiced time on target** for the session.

### Controls

**Short tap** (while running):

| Tap zone | Action |
|----------|--------|
| **Top third** | Raise the target band (+5 Hz) |
| **Bottom third** | Lower the target band (−5 Hz) |
| **Middle third** | Re-run noise-floor calibration **and** reset the session score |

The band defaults to **145–175 Hz** (the androgynous zone) and keeps a constant width.

**Long press** (hold ~0.8 s) opens **Settings**. Tap a row to cycle its value; tap
**Done** to save and exit (settings persist across reboots via flash/NVS):

| Row | Options |
|-----|---------|
| **Mode** | Vox Ball / Color |
| **Color from** | Pitch / Brightness / Bounce / Loudness / **Gender** *(Color mode)* |
| **Low color / High color** | Blue, Teal, Green, Purple, Red, Orange, Pink, White |
| **Haptics** | Off / On-target / Syllables / Bright / Loud |
| **Haptic thr** | 25 / 50 / 75% (threshold for the Bright/Loud triggers) |

### Haptic feedback
The vibration motor buzzes once on the chosen trigger: entering the target band
(*On-target*), each syllable onset (*Syllables*), or when brightness/loudness crosses the
*Haptic thr* (*Bright* / *Loud*). Set **Off** for silent training.

## How it works

| Layer | File | Notes |
|-------|------|-------|
| Mic capture + DSP (core 0) | `twatch_voxball.ino` `audioTask` | I2S PDM @ 16 kHz, 1024-sample frames |
| DSP (pitch/energy/bounce/syllable/brightness) | `dsp.cpp` / `dsp.h` | port of `app.js` / `dsp-utils.js` |
| Settings + persistence (NVS) | `twatch_voxball.ino` `Settings` | `Preferences` namespace `voxball` |
| Visualisation + input (core 1) | `twatch_voxball.ino` `loop` | Vox Ball / Color, touch + long-press |

The two cores hand off through a 1-slot queue (`xQueueOverwrite`) — the same
producer/consumer shape as the orb sketch's `colorQueue`.

### DSP fidelity
`dsp.cpp` reuses the web app's **proven** algorithms and **identically-named constants** so
the two stay in sync: YIN pitch detection (`YIN_THRESHOLD`, octave-up guard, parabolic
interpolation, 7-frame median), the intonation **bounce** metric (`INTONATION_ST_DIVISOR`),
the syllable-onset state machine (`SYLLABLE_ON_MULT` / `SYLLABLE_OFF_MULT` /
`SYLLABLE_DEBOUNCE_SECS` / `SYLLABLE_IMPULSE_DECAY`), a **brightness** proxy from the
spectral centroid, and **harmonic-envelope formant estimation** (F1/F2/F3 via
`_resonanceHarmonicEnvelope` + `_peakPickFormants`) feeding a **resonance** (formant
dispersion → vocal-tract length) and a **perceived-gender** blend of pitch + resonance
(`computeGenderScore`). A single radix-2 FFT per frame is shared by the centroid and formant
stages. Host-tested on synthetic vowels: masculine → 0.22 (blue), androgynous → 0.57
(purple), feminine → 0.95 (pink), with F1/F2/F3 within ~50–100 Hz of target. Change a
constant in one place and mirror it in the other.

## Tuning & troubleshooting

All tunables are grouped near the top of each file:

- **Mic pins / rate** — `MIC_DATA` (GPIO 2), `MIC_CLOCK` (GPIO 0), `VOX_SAMPLE_RATE`
  (`dsp.h`). These match LilyGo's own `TwatcV3Special/Microphone` example.
- **Pitch band** — `VOX_PITCH_MIN_HZ` / `VOX_PITCH_MAX_HZ` (`dsp.h`). Narrow it to your
  voice for a more responsive ball; widen it if your range is being clipped.
- **Brightness mapping** — `VOX_BRIGHT_MIN_HZ` / `VOX_BRIGHT_MAX_HZ` (`dsp.h`) set the
  spectral-centroid range mapped to brightness 0..1.
- **Feel** — spring `K`/`DAMP`, hop strength, and `smoothHue`/`smoothR` rates in
  `updateBallPhysics()`; the colour palette is the `PALETTE[]` table in the sketch.
- **Ball never moves / always "speak"** — confirm the mic by temporarily adding
  `Serial.printf("rms %.4f\n", res.rms);` in `audioTask`; values should rise when you speak.
- **Pitch reads wrong/jumpy** — `Serial.printf` `res.pitchHz`; hum a low vs. high note and
  compare against the web app's reading for the same voice.

## Power saving
The screen **auto-dims after ~20 s** of no activity and brightens again on **touch, voice,
or a wrist tilt** (BMA423 accelerometer). Tune `DIM_AFTER_MS`, `DIM_LEVEL`, and
`MOTION_THRESH` in `loop()`. The backlight and continuous mic capture remain the main battery
draws; deeper light-sleep is a future addition.

## Roadmap
Cepstral/CPP breathiness ("vocal weight") cue, more visualisations, an optional BLE companion
mode (drive the existing orb from the watch), and deeper sleep. *(Done: brightness/resonance
cue, harmonic-envelope formants + perceived-gender, Color mode, on-device customisation,
persistence, auto-dim + tilt-wake.)*
