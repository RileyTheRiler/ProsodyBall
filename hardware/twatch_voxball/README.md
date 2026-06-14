# ProsodyBall — Standalone Vox Ball for LilyGo T-Watch 2020 V3

A wearable, self-contained port of the web app's flagship **Vox Ball** mode. The watch
listens with its **own** built-in PDM microphone, runs pitch + energy analysis **on-device**
(no phone, no browser, no Bluetooth), and draws the ball on its 240×240 screen:

- **Pitch → height & colour** — a higher voice lifts the ball and shifts its colour
  blue → pink (the same pitch ramp the web app uses).
- **Syllables → bounces** — each syllable onset makes the ball hop; livelier intonation
  (more pitch variation) makes the hop taller.

This is the first milestone: **Vox Ball only**. Formant/resonance/gender cues and the other
arcade modes are intentionally left for later (see *Roadmap*).

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
3. **Tap the screen** any time to re-run noise-floor calibration (handy in a new room).

## How it works

| Layer | File | Notes |
|-------|------|-------|
| Mic capture + DSP (core 0) | `twatch_voxball.ino` `audioTask` | I2S PDM @ 16 kHz, 1024-sample frames |
| DSP (pitch/energy/bounce/syllable) | `dsp.cpp` / `dsp.h` | 1:1 port of `app.js` / `dsp-utils.js` |
| Physics + rendering (core 1) | `twatch_voxball.ino` `loop` | spring-to-pitch + syllable hop |

The two cores hand off through a 1-slot queue (`xQueueOverwrite`) — the same
producer/consumer shape as the orb sketch's `colorQueue`.

### DSP fidelity
`dsp.cpp` reuses the web app's **proven** algorithms and **identically-named constants** so
the two stay in sync: YIN pitch detection (`YIN_THRESHOLD`, octave-up guard, parabolic
interpolation, 7-frame median), the intonation **bounce** metric (`INTONATION_ST_DIVISOR`),
and the syllable-onset state machine (`SYLLABLE_ON_MULT` / `SYLLABLE_OFF_MULT` /
`SYLLABLE_DEBOUNCE_SECS` / `SYLLABLE_IMPULSE_DECAY`). Change a constant in one place and
mirror it in the other.

## Tuning & troubleshooting

All tunables are grouped near the top of each file:

- **Mic pins / rate** — `MIC_DATA` (GPIO 2), `MIC_CLOCK` (GPIO 0), `VOX_SAMPLE_RATE`
  (`dsp.h`). These match LilyGo's own `TwatcV3Special/Microphone` example.
- **Pitch band** — `VOX_PITCH_MIN_HZ` / `VOX_PITCH_MAX_HZ` (`dsp.h`). Narrow it to your
  voice for a more responsive ball; widen it if your range is being clipped.
- **Feel** — spring `K`/`DAMP`, hop strength, and `smoothHue`/`smoothR` rates in
  `updatePhysics()`.
- **Ball never moves / always "speak"** — confirm the mic by temporarily adding
  `Serial.printf("rms %.4f\n", res.rms);` in `audioTask`; values should rise when you speak.
- **Pitch reads wrong/jumpy** — `Serial.printf` `res.pitchHz`; hum a low vs. high note and
  compare against the web app's reading for the same voice.

## Battery note
The display backlight and continuous mic capture are the main draws. Brightness is left at
the library default; tap-to-sleep / dimming is a future addition.

## Roadmap
Formant/resonance/gender cues (need a 4096-pt FFT + cepstrum port), the other arcade modes,
an optional BLE companion mode (drive the existing orb from the watch), and power management
(tilt-to-wake, auto-dim).
