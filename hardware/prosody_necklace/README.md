# ProsodyBall Necklace — Standalone Haptic Prosody Trainer

A wearable pendant, built around a **Seeed Studio XIAO ESP32S3 Sense**, modeled loosely on the
public "ESP32 AI Wearable Pendant" tutorial but repurposed for ProsodyBall: it listens with its
**own** onboard PDM microphone, runs pitch/resonance/vocal-weight analysis **on-device**, and
**buzzes a vibration motor whenever your voice drifts outside a trained target**. No phone is
needed for the core loop — it's a corrective nudge you wear, not a recording/transcription
device.

> The watch-based wearable in [`../twatch_voxball`](../twatch_voxball) is the closest relative —
> same DSP (`dsp.cpp`/`dsp.h`, reused verbatim here), but that one rewards *entering* a target
> band with a single ping. **This device is the opposite**: it buzzes repeatedly (throttled by a
> cooldown) for as long as you stay *outside* your target, and goes silent the moment you're back
> in range or not speaking. Keep that distinction in mind if you're cross-referencing the two.

## Hardware

| Part | Notes |
|------|-------|
| Seeed Studio XIAO ESP32S3 Sense | ESP32-S3 + onboard PDM mic + JST battery/charge IC. Same chip family as the T-Watch, so `dsp.cpp`/`dsp.h` compile unmodified. |
| 3.7V 400mAh LiPo | Plugs into the XIAO's onboard JST connector; the onboard charge IC handles charging autonomously — no extra wiring. |
| SPDT slide switch | Wired in series with the LiPo's **+** lead → true hardware off. The XIAO has no broken-out power-switch pin, so this is the only way to fully kill power. |
| 10mm coin/pancake 3V vibration motor | Driven by a logic-level N-MOSFET (e.g. AO3400/2N7002): GPIO → 10kΩ pull-down → gate, drain → motor −, motor + → battery rail, with a 1N4148 flyback diode across the motor. A MOSFET is preferred here over a bare NPN (near-zero Vce(sat) loss at this voltage) and over a DRV2605L haptic IC (overkill for a simple on/off buzz). |
| Single WS2812B/SK6805 (data-only) | Status LED — boot self-test, idle, "outside target" flash, BLE-connected color. |

**Verify the mic pins before flashing.** `config.h`'s `MIC_CLOCK_PIN`/`MIC_DATA_PIN` (GPIO 42/41)
match Seeed's published PDM examples for the Sense board, but pin assignments have varied across
board revisions — check your specific revision's schematic first.

Enclosure: reuse the tutorial's Fusion 360 + FDM workflow, modified to add a motor pocket against
the chest, a sound port for the PDM mic, an LED light-pipe window, and a switch cutout.

## Flash the firmware (Arduino IDE)

1. Install the **Arduino IDE**.
2. Add ESP32 support: *File → Preferences → Additional Boards Manager URLs* →
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`, then
   *Boards Manager → install "esp32"*.
3. *Boards Manager* (same `esp32` package) → select **"XIAO_ESP32S3"** as the board.
4. *Library Manager* → install **"Adafruit NeoPixel"**.
5. Open `prosody_necklace.ino`. Keep all four files in the folder: `prosody_necklace.ino`,
   `config.h`, `dsp.h`, `dsp.cpp`.
6. Select your board/port and click **Upload**.

## Using it

1. On boot the status LED flashes **teal** (self-test), then settles to a **dim white** once the
   mic + audio task + BLE are all up.
2. The firmware spends ~1 second measuring the room's noise floor on every boot (and again on
   every BLE calibration write) — no button needed.
3. Speak normally. While your selected metric is **inside** its target/threshold, the LED stays
   dim white (or blue if a phone is connected) and the motor stays silent.
4. The moment you drift **outside** the target while speaking, the LED flashes **amber** and the
   motor buzzes — repeating at a throttled rate (`cooldownMs10`, default 250ms) for as long as
   you remain outside. It goes silent again as soon as you're back in range or stop talking.

### Haptic modes (`hapticSrc`)

| Mode | "In range" while... |
|------|----------------------|
| **Pitch** (default) | `pitchHz` sits inside `[targetLoHz, targetHiHz]` (default 145–175 Hz, the same androgynous band the T-Watch defaults to). |
| **Resonance** | `res.resonance` (the formant/vocal-tract-length field — see `docs/ANALYZER_API.md`; deliberately *not* `res.brightness`, the spectral-centroid proxy the T-Watch's `HAP_BRIGHT` trigger uses) stays **at or below** `hapticThr`. |
| **Weight** | `res.weight` (H1–H2 breathiness-based vocal weight) stays **at or below** `hapticThr`. |

All settings persist across power cycles via NVS (`Preferences` namespace `"necklace"`) and are
sanitized on load/write so a stale or corrupt value can't brick a session.

### BLE calibration (optional)

The necklace advertises as **`ProsodyBall-Necklace`** and exposes one GATT service for the phone
app (`necklace-controller.js`) to push calibration — it never streams live audio or per-frame
control data, since the necklace makes its own buzz decisions locally:

```
Service:        5b1e0010-8a0e-4f1b-9c5a-2f3d4e5a6b7c
Calib char (W):  5b1e0011-8a0e-4f1b-9c5a-2f3d4e5a6b7c   phone -> necklace, 6 bytes
Status char (N): 5b1e0012-8a0e-4f1b-9c5a-2f3d4e5a6b7c   necklace -> phone, notify, ~1 Hz, 8 bytes
```

Calibration packet (6 bytes, fixed-length — new protocol, no legacy clients):
`[hapticSrc(u8), hapticThrPct(u8), targetLoHz(u16 LE), targetHiHz(u16 LE)]`. Writing it
sanitizes + saves to NVS and immediately re-runs noise-floor calibration.

Status notify packet (8 bytes): `[flags(u8: micOk|calibrating|sessionActive),
onTargetPct(u8), voicedSeconds(u16 LE), currentMetricVal(u8, 0-100), batteryPct(u8, 0xFF=n/a),
reserved x2]`. `currentMetricVal` is whichever metric `hapticSrc` selects (pitch position,
resonance, or weight), scaled 0–100.

## How it works

| Layer | File | Notes |
|-------|------|-------|
| Mic capture + DSP (core 0) | `prosody_necklace.ino` `audioTask` | I2S PDM, same frame contract as `twatch_voxball` |
| DSP (pitch/resonance/weight) | `dsp.cpp` / `dsp.h` | copied verbatim from `../twatch_voxball` — hardware-agnostic, no changes needed |
| Settings + persistence (NVS) | `prosody_necklace.ino` `NecklaceSettings` | `Preferences` namespace `"necklace"` |
| Haptic decision + motor + LED (core 1) | `prosody_necklace.ino` `loop` / `isInRange` / `evalHaptic` | corrective (buzz-while-outside), not reward (buzz-on-entry) |
| BLE peripheral (core 1) | `prosody_necklace.ino` `initBle` / `CalibCallbacks` | server role — the necklace *is* the device the phone connects to, unlike the T-Watch's BLE client mode |

The two cores hand off through a 1-slot queue (`xQueueOverwrite`) — the same producer/consumer
shape used by `twatch_voxball`.

## Tuning & troubleshooting

- **Mic pins** — `MIC_CLOCK_PIN` / `MIC_DATA_PIN` (`config.h`). Re-verify against your board
  revision's schematic if the mic never produces data.
- **Mic sanity** — temporarily add `Serial.printf("rms %.4f\n", res.rms);` in `audioTask`;
  the value should rise when you speak and the printed noise floor should settle within ~1s of
  quiet.
- **Pitch sanity** — `Serial.printf("pitch %.1f\n", res.pitchHz);`; hum a low vs. high note and
  compare against the web app's reading for the same voice.
- **Motor bench test** — before final assembly, pulse `MOTOR_GATE_PIN` directly (independent of
  DSP) to confirm the MOSFET + motor + flyback diode wiring in isolation.
- **Threshold-crossing test** — log `evalHaptic()`'s return value while manually crossing each
  target/threshold; you should get a buzz roughly every `cooldownMs10 * 10` ms while outside, and
  none while inside.
- **BLE round-trip** — connect via the web app (or nRF Connect), write a calibration packet,
  confirm via Serial log it parsed correctly, and power-cycle to confirm it persisted (NVS).

## Roadmap

Session logging back to the phone app, a battery-percentage read (the XIAO's charge IC doesn't
expose one directly — needs a resistor-divider ADC pin), and a recalibrate gesture (e.g. a double
tap detected via the accelerometer-free fallback of a brief loud clap) for v2.
