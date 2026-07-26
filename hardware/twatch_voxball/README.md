# ProsodyBall — Standalone Voice Trainer for LilyGo T-Watch 2020 V3

A wearable, self-contained voice trainer. The watch listens with its **own** built-in PDM
microphone, runs pitch + energy + brightness analysis **on-device** (no phone, no browser,
no Bluetooth), and visualises it on its 240×240 screen. **Two views**, switchable with a
**swipe**:

- **Vox Ball** — a ball whose height & colour follow **pitch** (low=blue → high=pink) and
  that **hops on each syllable**; livelier intonation makes the hop taller. The ball sits on
  a **labelled Hz axis**, trailed by a **scrolling trace of your recent pitch**, with a dashed
  **target band** to train toward (green glow + buzz + on-target %).
- **Color** — the **whole screen** colours from a metric **you choose** (pitch, brightness,
  bounce, loudness, **perceived gender**, or **vocal weight**), blended between **two colours
  you pick**. Louder = brighter. *Gender* blends pitch + vocal-tract resonance
  (0 = masculine … 1 = feminine); *Weight* is breathy/light … pressed/heavy (H1–H2).

Both views sit under a **status bar** (clock, battery, current view, live mic-level meter, orb
link) and above a readout, so you can always tell the watch is on, charged, and hearing you.

A **walkthrough runs on first boot** to teach the four gestures, and every control confirms
itself with an on-screen toast. Everything is **customisable on-device and saved to flash**.

> The browser-driven LED orb lives in [`../prosodyball_orb`](../prosodyball_orb) and is a
> completely separate project — that one does no audio processing.

## Hardware

Only the **T-Watch 2020 V3** is supported — it is the variant that added the on-board
**PDM microphone** ([product page](https://lilygo.cc/products/t-watch-2020-v3)). The V1/V2
have no microphone and will not work. Nothing to wire — mic, display, touch, and battery
are all on the watch.

## Flash the firmware (Arduino IDE)

> **New here? Follow [`SETUP.md`](./SETUP.md)** — a full, hand-holding flashing walkthrough
> (USB driver, exact board settings, troubleshooting). The steps below are the short version.

> ⚠️ **Use ESP32 Arduino core `2.0.14`, not the newest (`3.x`).** The TTGO TWatch Library only
> compiles on core 2.0.x; installing the default latest core makes the build fail with a wall
> of errors inside `TFT_eSPI`/`lvgl`. This is the single most common first-time mistake.

1. Install the **Arduino IDE**.
2. Add ESP32 support: *File → Preferences → Additional Boards Manager URLs* →
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`, then *Boards Manager*
   → search **esp32** → **pick version `2.0.14` in the dropdown** before clicking **Install**.
3. Install the **"TTGO TWatch Library"** (by Lewis He / LilyGo) — it wraps the display
   (TFT_eSPI), the AXP202 power chip, touch, and exposes the V3 PDM mic. If it isn't in the
   *Library Manager*, download the ZIP from
   [the repo](https://github.com/Xinyuan-LilyGO/TTGO_TWatch_Library) and use *Sketch → Include
   Library → Add .ZIP Library*.
4. Open `twatch_voxball/twatch_voxball.ino`. Keep all six files in the folder:
   `twatch_voxball.ino`, `config.h`, `dsp.h`, `dsp.cpp`, `ui.h`, `ui.cpp`. (The `test/`
   subfolder is host-only and is ignored by the Arduino build.)
5. Select board **"TTGO T-Watch"**, set **Board Revision → "T-Watch-2020-V3"**, choose your
   port, and click **Upload**.

`config.h` already sets `#define LILYGO_WATCH_2020_V3` before including the library, so the
correct (V3) pin map and microphone support are compiled in.

> Both the on-device firmware and the hardware-free logic are checked in CI on every push
> (`.github/workflows/twatch-build.yml`): a fast host build runs the DSP unit tests
> (`test/dsp_host_test.cpp`) and the UI model unit tests (`test/ui_host_test.cpp`), and a full
> Arduino build (esp32 core 2.0.14 + the TTGO library, pinned) catches breakage before you
> flash.

## Power-on self-test

On boot the screen flashes **soft teal** (mirroring the orb sketch's self-test), then shows
*"ProsodyBall — calibrating mic…"*. Use the splash to sanity-check the build *before* speaking:

- Nothing lights up → check the board is powered/charged and the correct board is selected.
- **"Startup failed"** → the microphone or the audio task didn't come up; the mic is the usual
  cause. See *Tuning & troubleshooting*.
- It boots but the status bar never stops reading *CALIBRATING* → the mic isn't producing
  data; see *Tuning & troubleshooting*.

## Using it

1. **First boot shows a four-card walkthrough** of the gestures. Tap the right half for the
   next card, the left half to go back, *Skip* to dismiss it. It never appears again — reopen
   it any time from **Settings → How to use**.
2. After the splash, the firmware spends ~1 second measuring the room's **noise floor** —
   stay quiet while the status bar reads *CALIBRATING*.
3. Speak. The ball rises with pitch, hops on each syllable, and shifts blue → pink, leaving a
   trace of the last ~1.2 s behind it. The mic-level line under the status bar moves whenever
   the microphone hears anything — if it never moves, the mic is the problem, not your voice.
4. **Train toward the target band.** Two dashed lines mark a target pitch range. When your
   voice sits inside it, the ball **glows green**, the trace turns green, the motor **buzzes
   once**, and the bar above the readout fills with your **% of voiced time on target**.

### Controls

Four gestures, and the watch tells you about all of them: the walkthrough on first boot, a
hint overlay that fades in the first few seconds of each session, and a toast confirming every
action.

| Gesture | Action |
|---------|--------|
| **Tap top third** | Raise the target band (+5 Hz) — *Ball view with the band on* |
| **Tap bottom third** | Lower the target band (−5 Hz) — *Ball view with the band on* |
| **Tap middle** | Open the **quick menu** |
| **Swipe left / right** | Switch between the **Ball** and **Color** views |
| **Long press** (~0.7 s) | Jump straight to **Settings** |

The band defaults to **145–175 Hz** (the androgynous zone) and keeps a constant width as you
move it, right up to the ends of the analysed range. When the band is switched off — or you
are in Color view, where it isn't drawn — *any* tap opens the quick menu instead, so a tap
never silently changes something you cannot see.

### Quick menu

Six finger-sized buttons; it closes itself after 10 s if you walk away.

| Button | Action |
|--------|--------|
| **View** | Switch Ball ⇄ Color (the button relabels itself so you can see what you got) |
| **Recalibrate** | Re-measure the room's noise floor |
| **Reset score** | Start the session scoreboard over |
| **Stats** | Session summary — on-target %, best ever, average pitch, range, voiced time, syllables/min |
| **Settings** | Full settings |
| **Close** | Back to the visualisation |

### Settings

Tap a row to cycle its value (each row shows its value and a **›** chevron); the footer has
**‹ ›** to page and **Done** to save and exit. Swiping left/right pages too. Settings persist
across reboots via flash/NVS.

**Rows are filtered to what applies right now** — the Color rows are hidden in Ball view, the
Ball rows are hidden in Color view, and the haptic threshold only appears for the triggers
that use one. That is what keeps a 15-option menu down to two short pages.

| Row | Options |
|-----|---------|
| **View** | Vox Ball / Color |
| **Color from** | Pitch / Brightness / Bounce / Loudness / **Gender** / **Weight** *(Color view)* |
| **Preset** | Gradient presets — Trans, Fire, Ocean, Forest, Sunset, Mono, Candy (sets both colours) *(Color view)* |
| **Low color / High color** | 14 colours: Blue, Teal, Green, Purple, Red, Orange, Pink, White, Cyan, Magenta, Yellow, Lime, Indigo, Rose *(Color view)* |
| **Effect** | None / Pulse / Gradient / Meter *(Color view)* |
| **Target band** | On / Off (training guides, glow, on-target score) *(Ball view)* |
| **Pitch trace** | On / Off (the scrolling pitch history) *(Ball view)* |
| **Buzz on** | Off / On target / Syllables / Bright / Loud |
| **Buzz above** | 25 / 50 / 75% *(only for the Bright and Loud triggers)* |
| **Brightness** | Low / Medium / High (backlight) |
| **Auto-dim** | On / Off (screen dimming + tilt-wake) |
| **Text + bars** | On / Off (status bar, readout and meters — turn off for pure visuals) |
| **LED orb** | On / Off (drive the LED orb — see *BLE companion* below) |
| **How to use** | Replay the walkthrough |
| **Signal check** | Live diagnostic readout — see below |

### Signal check (diagnostics)

**Settings → Signal check.** Every other screen shows an *interpretation* of your voice. When
one looks wrong, the ball alone can't tell you whether the pitch estimate is bad, or the pitch
is simply outside what the plot can draw, or the mic is quiet. This screen shows the raw
analysis, updated ~5×/s, so that question has an answer:

| Row | What it tells you |
|-----|-------------------|
| **mic level** (+ peak) | Non-zero when the mic works. Flat zero = no audio, and nothing downstream can be right. |
| **noise floor** | What calibration measured. If it's near your speech level, the gate is swallowing you — recalibrate somewhere quieter. |
| **voiced** + conf | Whether this frame was pitched, and how sure YIN is. |
| **pitch** | The current estimate in Hz. |
| **range seen** | Lowest and highest pitch since the last reset. |
| **above / below range** | **The important one.** The share of voiced time sitting at the ends of the analysed range. |
| **centroid**, **brightness** | Spectral centre of gravity, and it mapped to 0–1. This is what the *Brightness* colour source shows. |
| **F1 F2 F3** | Estimated formants. Greyed out when formant confidence is low. |
| **resonance** + conf | Formant-dispersion resonance — the real vocal-tract measure. **Not the same as brightness.** |
| **gender / weight** | The blended perceived-gender score and the H1–H2 vocal weight. |
| **bounce** | Intonation variability. |

**Reading "above range".** The pitch band is `VOX_PITCH_MIN_HZ`–`VOX_PITCH_MAX_HZ` (80–300 Hz)
and both the analysis and the plot stop there. A voice above the top flattens against the top
edge of the screen, which looks exactly like a tracking failure but isn't. If this row shows
more than a few percent, the range is too low for your voice — widen it in `dsp.h` and
reflash. If it reads 0% while the trace still looks wrong, the range is not your problem.

**Brightness is not resonance.** *Brightness* is the spectral centroid, which every /s/ and
/f/ drags to the top — it is a crude proxy. The DSP separately computes a real formant-based
`resonance`, shown on this screen. Compare the two rows while you speak: if brightness leaps
around on consonants while resonance stays steady, that's the metric behaving as designed,
not a bug.

### Color-mode effects
*None* — flat fill. *Pulse* — whole-screen brightness pulse that quickens with loudness and
flashes on each syllable. *Gradient* — vertical low→high colour gradient with a white marker
line at the current metric. *Meter* — a bottom-up level bar whose height tracks the metric.

### BLE companion (drive the LED orb)
Turn **LED orb** on in Settings to have the watch also drive the DIY LED orb in
[`../prosodyball_orb`](../prosodyball_orb) — no phone needed. The watch acts as a BLE
**client**: it scans for `ProsodyBall-Orb`, connects, and streams 5-byte `[R,G,B,Res,Weight]`
packets at ~20 Hz from its own DSP — the orb's colour, its **pulse** (from brightness), and
its **body** (from vocal weight) all follow your live voice. A dot in the status bar shows
link status (grey = searching, green = connected). The protocol matches
`prosodyball_orb.ino` exactly, so the same orb works from either the browser or the watch
(one at a time). *Note:* enabling BLE brings up the Bluetooth stack (extra RAM); leave it
**Off** if you don't use the orb.

Every feature can be turned **off**: haptics, auto-dim, the target band/training, the pitch
trace, and all text and meters have toggles, so you can run anything from full-feedback
training down to a silent, text-free colour field.

### Haptic feedback
The vibration motor buzzes once on the chosen trigger: entering the target band
(*On target*), each syllable onset (*Syllables*), or when brightness/loudness crosses
*Buzz above* (*Bright* / *Loud*). Set **Off** for silent training. UI taps get their own,
much shorter tick so they never feel like training feedback.

## How it works

| Layer | File | Notes |
|-------|------|-------|
| Mic capture + DSP (core 0) | `twatch_voxball.ino` `audioTask` | I2S PDM @ 16 kHz, 1024-sample frames |
| DSP (pitch/energy/bounce/syllable/brightness/formants/gender/weight) | `dsp.cpp` / `dsp.h` | port of `app.js` / `dsp-utils.js` |
| UI model — settings, menus, gestures, toasts, scoreboard | `ui.cpp` / `ui.h` | pure C++, no hardware; host-tested |
| Rendering + hardware (core 1) | `twatch_voxball.ino` `loop` | screens, touch, TFT, PMU, RTC, haptics |
| Persistence (NVS) | `twatch_voxball.ino` `loadSettings`/`saveSettings` | `Preferences` namespace `voxball` |
| BLE companion (core 1) | `twatch_voxball.ino` `bleTask` | client → orb, 5-byte `[R,G,B,Res,Weight]` |

The two cores hand off through a 1-slot queue (`xQueueOverwrite`) — the same
producer/consumer shape as the orb sketch's `colorQueue`.

### Why `ui.cpp` exists
`ui.cpp` is split out for the same reason `dsp.cpp` is: it holds no hardware, so the exact
translation unit the watch runs also compiles and runs on a normal computer. The bugs that
hurt in a watch UI are not the pixels — they're the rules underneath. Which menu rows apply
right now, whether a smeared finger counted as a tap or a swipe, whether a byte from NVS is
in range before it indexes a table, whether the scoreboard adds up, whether the target band
keeps its width at the ends of the pitch range. `test/ui_host_test.cpp` checks all of that in
CI, in seconds, with no watch involved.

The screen is redrawn **incrementally**: the ball and the pitch trace are erased stroke for
stroke rather than by clearing the plot, the readout only repaints when its text actually
changes, and the status bar polls the I2C clock and PMU at 1 Hz. Only the Color view fills a
large area per frame, and even that leaves the status bar and readout strips alone.

### DSP fidelity
`dsp.cpp` reuses the web app's **proven** algorithms and **identically-named constants** so
the two stay in sync: YIN pitch detection (`YIN_THRESHOLD`, octave-up guard, parabolic
interpolation, 7-frame median), the intonation **bounce** metric (`INTONATION_ST_DIVISOR`),
the syllable-onset state machine (`SYLLABLE_ON_MULT` / `SYLLABLE_OFF_MULT` /
`SYLLABLE_DEBOUNCE_SECS` / `SYLLABLE_IMPULSE_DECAY`), a **brightness** proxy from the
spectral centroid, and **harmonic-envelope formant estimation** (F1/F2/F3 via
`_resonanceHarmonicEnvelope` + `_peakPickFormants`) feeding a **resonance** (formant
dispersion → vocal-tract length) and a **perceived-gender** blend of pitch + resonance
(`computeGenderScore`), plus a **vocal-weight** cue from the H1–H2 breathiness measure
(`computeWeightTarget`'s h1h2Heaviness). A single radix-2 FFT per frame is shared by the
centroid, formant, and weight stages. Host-tested on synthetic vowels: gender masculine →
0.22 (blue), androgynous → 0.57 (purple), feminine → 0.95 (pink), F1/F2/F3 within ~50–100 Hz
of target; weight breathy → 0.01, modal → 0.54, pressed → 0.85. Change a constant in one
place and mirror it in the other.

## Tuning & troubleshooting

All tunables are grouped near the top of each file:

- **Mic pins / rate** — `MIC_DATA` (GPIO 2), `MIC_CLOCK` (GPIO 0), `VOX_SAMPLE_RATE`
  (`dsp.h`). These match LilyGo's own `TwatcV3Special/Microphone` example.
- **Pitch band** — `VOX_PITCH_MIN_HZ` / `VOX_PITCH_MAX_HZ` (`dsp.h`). Narrow it to your
  voice for a more responsive ball; widen it if your range is being clipped.
- **Brightness mapping** — `VOX_BRIGHT_MIN_HZ` / `VOX_BRIGHT_MAX_HZ` (`dsp.h`) set the
  spectral-centroid range mapped to brightness 0..1.
- **Feel** — spring `K`/`DAMP`, hop strength, and `smoothHue`/`smoothR` rates in
  `updateBallPhysics()`; the colour palette is the `PALETTE[]` table in `ui.cpp`.
- **Layout / gestures** — the screen geometry (`UI_PLOT_TOP`, `UI_BALL_X`, `UI_TRACE_*`, …),
  the long-press and swipe thresholds (`UI_LONG_PRESS_MS`, `UI_SWIPE_MIN_PX`,
  `UI_TAP_SLOP_PX`) and the toast duration are all constants at the top of `ui.h`. The host
  tests assert the layout stays self-consistent, so a bad edit fails in CI rather than on the
  wrist.
- **Anything looks like it isn't tracking your voice** — open **Settings → Signal check**
  before changing anything. It distinguishes a dead mic from a swallowed noise gate from a
  pitch outside the drawable range from a genuinely bad estimate, which all look identical on
  the ball.
- **Ball never moves / always "speak"** — check the mic-level line under the status bar
  first: if it never moves, no audio is arriving. *Signal check* → **mic level** confirms it.
- **Trace flattens against the top of the screen** — that is the 300 Hz ceiling, not a
  detector failure. *Signal check* → **above range** quantifies it; raise
  `VOX_PITCH_MAX_HZ` in `dsp.h` if it's more than a few percent.
- **Pitch reads wrong/jumpy** — check **conf** on *Signal check*; a low confidence with a
  wild pitch usually means the noise floor is too high. Hum a low vs. high note and compare
  against the web app's reading for the same voice.
- **Settings look wrong / a row is missing** — rows are filtered by context, so a Color row
  genuinely does not exist while you are in Ball view. Switch views and look again.

## Power saving
The screen **auto-dims after ~20 s** of no activity and brightens again on **touch, voice,
or a wrist tilt** (BMA423 accelerometer). Tune `DIM_AFTER_MS`, `DIM_LEVEL`, and
`MOTION_THRESH` in `loop()`. The backlight and continuous mic capture remain the main battery
draws; deeper light-sleep is a future addition.

## Roadmap
More visualisations, a longer-term progress history, and deeper sleep. *(Done:
brightness/resonance cue, harmonic-envelope formants + perceived-gender, H1–H2 vocal-weight
cue, Color view with palettes/presets/effects, on-device customisation, persistence, auto-dim
+ tilt-wake, per-feature on/off toggles, a BLE companion mode that drives the LED orb, and the
UX pass: status bar, pitch axis + trace, first-run walkthrough, quick menu, stats screen,
swipe-to-switch, toasts, context-filtered settings, and a host-tested UI model.)*
