# ProsodyBall DIY Orb (ESP32 + WS2812B)

Turn a cheap ESP32 + an addressable LED strip into an open, router-free "smart
bulb" that ProsodyBall drives directly from the browser over Bluetooth LE. You
control both ends, so there's no app, no hub, no Wi-Fi, and no protocol to
reverse-engineer.

## Parts

| Role | Example | Notes |
|------|---------|-------|
| Brain | ESP32 dev board (e.g. SunFounder kit) | Must be a classic **ESP32** (has BLE). ESP32-**S2** has no Bluetooth — avoid. |
| Light | WS2812B 5V addressable strip | ~160 px/m. 3-pin: 5V / GND / DIN. |
| Diffuser | Opal glass globe (3.25" fitter) | Purely mechanical — hides the electronics, softens the pixels. |

## Wiring (breadboard, no soldering)

| Strip wire | Connect to |
|------------|-----------|
| 5V / `+` (red) | ESP32 **5V / VIN** rail |
| GND / `-` (white/black) | ESP32 **GND** rail |
| DIN / data (green) | ESP32 **GPIO 4** (matches `LED_PIN` in the sketch) |

Optional but recommended for clean signals: a **330 Ω** resistor in series on the
data wire, and a **1000 µF** capacitor across the strip's 5V/GND.

### ⚡ Power — read this
160 WS2812B pixels at full white want ~**9.6 A**; a laptop USB port gives only
~0.5–0.9 A. **This sketch has no automatic power cap** — it drives NeoPixelBus
directly — so it relies on never lighting every pixel at full white: the animation
clamps its brightness multiplier to ≤ 1.0 (`MULT_CEILING`), and the app sends
saturated hues rather than white. Even so, a heavy/bright voice holds the LEDs near
their baseline continuously, so on a bare laptop USB port keep brightness modest
(lower `MULT_CEILING` or the `BASE_BRIGHT_*` constants if your port browns out). For
full brightness, power the strip from a dedicated **5V/3A+** USB brick or supply
(common 5V to the strip and ESP32, common ground).

## Flash the firmware

1. Install the **Arduino IDE**.
2. Add ESP32 support: *File → Preferences → Additional Boards Manager URLs* →
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`, then
   *Boards Manager → install "esp32"*.
3. *Library Manager → install "NeoPixelBus" by Makuna*.
4. Open `prosodyball_orb/prosodyball_orb.ino`. Set `NUM_LEDS` / `DATA_PIN` to your
   build if different. Select your board + port, click **Upload**.

## Power-on self-test

Every time the ESP32 powers up, the firmware runs a quick boot splash showing a
soft teal color across the whole strip. Use it to sanity-check the build
*before* touching the app:

- Nothing lights up → check the data wire is on GPIO 4 and 5V/GND aren't swapped.
- It flickers, dims hard, or the board resets → check connections or add
  external 5V power.

## Connect from ProsodyBall

1. Open ProsodyBall in **Chrome, Edge, or Opera** (Web Bluetooth; not Safari).
2. Settings → Smart Bulb → **Connection: DIY ESP32 orb**.
3. Click **Connect bulb** → pick **ProsodyBall-Orb** in the OS picker.
4. Leave **"Reconnect automatically next session"** checked (default). From now
   on, ProsodyBall silently re-links this orb when the page loads — staff just
   open the app, no picker click. (Chromium browsers only; if unavailable it
   falls back to the manual **Connect bulb** button.)
5. **Test connection** lights the orb. Turn on **"Mirror ball color"** — speak
   low → blue, high → pink, in sync with the on-screen ball.

## Protocol (for reference)

- Service UUID: `5b1e0001-8a0e-4f1b-9c5a-2f3d4e5a6b7c`
- Color characteristic: `5b1e0002-8a0e-4f1b-9c5a-2f3d4e5a6b7c` — write **5 bytes
  `[R, G, B, Resonance, Weight]`** (0–255 each). `[0,0,0,0,0]` = off. Falls back to
  **4 bytes `[R, G, B, Resonance]`** (weight defaults to a neutral mid, 128) and **3 bytes
  `[R, G, B]`** (resonance 0, weight 128) for backwards compatibility.

These must stay identical to `ESP32_SERVICE_UUID` / `ESP32_COLOR_UUID` in
`bulb-controller.js`.

## Sketch Purpose and Features

1. **Color Balancing (Pink Fix)**: Adjusts raw RGB inputs using a gamma curve of `2.2` and dims green/blue channels (G to 60%, B to 80%) to ensure pink shades show brightly through frosted diffusers instead of appearing washed out.
2. **Resonance Pulse Engine**: A `millis()`-based loop turns resonance into a whole-globe pulse. A brighter voice pulses **faster and deeper** (toward a quick blink); a darker voice is a slow, shallow throb. A uniform brightness pulse is the most diffuser-proof cue, so it stays obvious through the frosted globe. Tune the feel with `PULSE_SPEED_*`, `PULSE_DEPTH_*`, and `PULSE_SHAPE` (raise it for a harder blink).
3. **Weight Body**: The vocal-weight byte sets the orb's "body". Heavier voices read fuller and steadier (higher baseline brightness, a mildly calmer pulse); lighter voices read dimmer and livelier. A final brightness clamp (`MULT_CEILING`) keeps power within the strip's existing envelope.
