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
~0.5–0.9 A. The firmware caps draw via `FastLED.setMaxPowerInVoltsAndMilliamps`
(`MAX_MILLIAMPS = 500`), so it **auto-dims instead of browning out** — safe on
USB. That cap governs the **LED strip only**; the ESP32 + BLE radio add another
~150–250 mA, so 500 ≈ ~750 mA total (fine for USB 3.0 / USB-C and most laptop
ports). For a strict 500 mA USB 2.0 port, lower it to ~250. For full brightness,
power the strip from a dedicated **5V/3A+** USB brick or supply (common 5V to the
strip and ESP32, common ground) and raise the cap.

## Flash the firmware

1. Install the **Arduino IDE**.
2. Add ESP32 support: *File → Preferences → Additional Boards Manager URLs* →
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`, then
   *Boards Manager → install "esp32"*.
3. *Library Manager → install "FastLED"*.
4. Open `prosodyball_orb/prosodyball_orb.ino`. Set `NUM_LEDS` / `LED_PIN` to your
   build if different. Select your board + port, click **Upload**.

## Connect from ProsodyBall

1. Open ProsodyBall in **Chrome or Edge** (Web Bluetooth; not Safari).
2. Settings → Smart Bulb → **Connection: DIY ESP32 orb**.
3. Click **Connect bulb** → pick **ProsodyBall-01** in the OS picker.
4. **Test connection** lights the orb. Enable "Mirror ball color" — speak low →
   blue, high → pink, in sync with the on-screen ball.

## Protocol (for reference)

- Service UUID: `5b1e0001-8a0e-4f1b-9c5a-2f3d4e5a6b7c`
- Color characteristic: `5b1e0002-8a0e-4f1b-9c5a-2f3d4e5a6b7c` — write **3 bytes
  `[R, G, B]`** (0–255 each). `[0,0,0]` = off.

These must stay identical to `ESP32_SERVICE_UUID` / `ESP32_COLOR_UUID` in
`bulb-controller.js`.
