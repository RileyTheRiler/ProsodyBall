# ProsodyBall — T-Watch 2020 V3 Flashing Guide

Step-by-step instructions to get ProsodyBall onto a **LilyGo T-Watch 2020 V3**. Unlike the
Galaxy Watch (which runs Android and sideloads an APK over Wi-Fi), the T-Watch is an **ESP32
microcontroller**: there is no app store and no APK. You **flash firmware** to it over a
**USB-C cable** from the Arduino IDE. The watch then runs ProsodyBall entirely on its own —
its own mic, its own DSP, its own screen. No phone, no browser, no Bluetooth required.

> **Only the 2020 V3 works.** It is the single variant with the on-board PDM microphone. The
> V1 and V2 have no mic and will boot but never hear you.

---

## ⚠️ The one mistake that wastes everyone's first evening

The T-Watch library (TTGO TWatch Library) **only compiles on ESP32 Arduino core `2.0.x`**
(use **2.0.14**). If you let Boards Manager install the newest core (`3.x`, the default),
the build fails with a wall of confusing errors inside `TFT_eSPI` / `lvgl` that have nothing
to do with our code. **Step 2 pins the core to 2.0.14 on purpose — don't skip it.**

---

## What you need

- The **T-Watch 2020 V3**, charged.
- A **USB-C _data_ cable** (many cheap cables are charge-only — those silently fail to flash).
- A computer (Windows / Mac / Linux), ~20 minutes the first time. Reflashing later takes ~30 s.

---

## Step 1 — Install the Arduino IDE

Download and install the **Arduino IDE 2.x** from <https://www.arduino.cc/en/software>.

---

## Step 2 — Install the ESP32 core, pinned to 2.0.14 (the critical step)

1. **File → Preferences**. In **"Additional boards manager URLs"** paste:
   ```
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```
   Click **OK**.
2. Open **Boards Manager** (the chip icon in the left toolbar, or **Tools → Board → Boards
   Manager**). Search **`esp32`** — the one **by Espressif Systems**.
3. **Before clicking Install, open the version dropdown and choose `2.0.14`.** Then click
   **Install**. (If you already installed a 3.x version, select `2.0.14` from the dropdown and
   click **Install** to switch — it will downgrade.)

> Why 2.0.14 specifically: it's the newest 2.0.x release, and the T-Watch library's README
> states it supports "esp core 3.0 and below… recommended 2.0.14."

---

## Step 3 — Install the TTGO TWatch Library

This library wraps the V3's screen (ST7789), power chip (AXP202), touch (FT6236), vibration
motor, accelerometer (BMA423), and — crucially — the **PDM microphone**.

It is **not reliably in the Library Manager index**, so install it from GitHub:

1. Go to <https://github.com/Xinyuan-LilyGO/TTGO_TWatch_Library>.
2. **Code → Download ZIP**.
3. In Arduino IDE: **Sketch → Include Library → Add .ZIP Library…** and pick the ZIP you
   just downloaded.

> (You can also try **Tools → Manage Libraries → search "TTGO TWatch"** — if it appears,
> installing it there works too. If it doesn't appear, use the ZIP method above.)

---

## Step 4 — Install the USB-serial driver and plug in

The 2020 V3 typically uses a **WCH CH9102F** USB-serial chip (LilyGo swapped it in for the
older CP2104). For your computer to see the watch as a serial port you usually need its driver:

- **CH9102 / CH34x driver:** <https://github.com/Xinyuan-LilyGO/CH9102_Driver>
  (Windows: run the installer; macOS: install the signed `.pkg`, then approve it in
  *System Settings → Privacy & Security*).
- If your unit is an **older batch with a CP2104**, install the Silicon Labs **CP210x VCP**
  driver instead.
- **Linux:** usually works with no driver (the `ch341`/`cp210x` modules are in-kernel). If the
  port doesn't appear, add yourself to the `dialout` group: `sudo usermod -aG dialout $USER`
  then log out/in.

Plug the watch into your computer with the **data** cable. In Arduino IDE, **Tools → Port**
should now list a new port (e.g. `COM5` on Windows, `/dev/cu.wchusbserial…` on macOS,
`/dev/ttyACM0` or `/dev/ttyUSB0` on Linux).

---

## Step 5 — Open the sketch and set the board options

1. Open **`hardware/twatch_voxball/twatch_voxball.ino`**. Keep all four files together in the
   folder: `twatch_voxball.ino`, `config.h`, `dsp.h`, `dsp.cpp`. (The `test/` subfolder is
   host-only and is ignored by the Arduino build.)
2. **Tools → Board → ESP32 Arduino → "TTGO T-Watch".**
3. Set these under **Tools** (defaults are fine except *Board Revision*):

   | Tools menu | Set to |
   |---|---|
   | **Board Revision** | **T-Watch-2020-V3** |
   | **Port** | the watch's port from Step 4 |
   | **Partition Scheme** | *Default (...)* — leave as-is |
   | **PSRAM** | *Enabled* (default) |
   | **Upload Speed** | leave default; drop to `921600` if uploads fail |

   `config.h` also hard-defines `LILYGO_WATCH_2020_V3`, so the V3 pin map + mic compile in
   even if the menu is wrong — but set the revision anyway to avoid confusion.

---

## Step 6 — Upload

Click the **→ (Upload)** arrow. The IDE compiles (the first build is slow — it's building
lvgl + TFT_eSPI), then flashes. Watch for **"Hard resetting via RTS pin…"** / **Done
uploading**.

The 2020 V3's auto-reset circuit normally puts the ESP32 into download mode for you. If you
see `Connecting......____` stuck dots, see Troubleshooting.

---

## Step 7 — First boot (the self-test)

On power-up the firmware runs a deliberate self-test you can sanity-check against:

1. The screen flashes **soft teal** (~1 s) — confirms the display + backlight work.
2. It shows **"ProsodyBall — calibrating mic…"** and spends ~1 second measuring the room's
   noise floor. **Stay quiet** during this.
3. **Speak.** The ball rises with your pitch, hops on each syllable, and shifts blue → pink.

If it boots but says **"Startup failed"**, the microphone or a worker task didn't initialise —
recheck that you selected the **V3** board revision and that you have the **V3** hardware.

### Controls (quick reference — full details in `README.md`)
- **Short tap:** top third = raise pitch target, bottom third = lower it, middle = recalibrate
  + reset score.
- **Long press (~0.8 s):** open **Settings** (two pages; tap rows to cycle, **Done** to save).
  Settings persist across reboots.

---

## Reflashing later

After a `git pull` or an edit, just reopen the sketch and click **Upload** again — board and
port stay selected. No pairing dance, no Wi-Fi (that was the Galaxy). One cable, one click.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails with errors deep inside `TFT_eSPI`, `lvgl`, or `esp32-hal` | You're on ESP32 core **3.x**. Go to Boards Manager → esp32 → select **2.0.14** → Install. (See Step 2.) |
| `LilyGoWatch.h: No such file or directory` | The TTGO TWatch Library isn't installed. Redo **Step 3** (Add .ZIP Library). |
| **Tools → Port** shows nothing | Missing USB driver (Step 4), a **charge-only** cable, or (Linux) you're not in `dialout`. Try another cable first — it's the #1 cause. |
| Upload hangs at `Connecting......____` | Lower **Upload Speed** to `921600`. Try a different USB port/cable. Some units need you to start the upload, then briefly press the side button as the dots begin. |
| Uploads OK but screen stays black | Confirm **Board Revision = T-Watch-2020-V3**; make sure the watch is charged (a flat battery can't drive the backlight even over USB). |
| Boots to **"Startup failed"** | Mic/I2S didn't come up — almost always wrong board revision or non-V3 hardware. |
| Ball never moves / always shows `--` | The mic isn't producing data. In `audioTask` temporarily add `Serial.printf("rms %.4f\n", res.rms);` and open **Tools → Serial Monitor** at 115200 — the value should rise when you speak. |
| `ModuleNotFoundError: No module named 'serial'` (rare) | The esp32 toolchain needs Python `pyserial`. Arduino IDE bundles it; if you build from the command line, `pip install pyserial`. |

---

## How this differs from the Galaxy Watch

| | Galaxy Watch 7 (`wear/`) | T-Watch 2020 V3 (here) |
|---|---|---|
| Platform | Wear OS (Android) | ESP32 (bare microcontroller) |
| You install | an **APK** | **firmware** (this sketch) |
| Over | Wi-Fi (ADB pair/connect) | a **USB-C cable** |
| Toolchain | Android SDK / a prebuilt APK | Arduino IDE + ESP32 core 2.0.14 |

The DSP that analyses your voice is the **same algorithm** in both, ported from the web app
(`app.js` / `dsp-utils.js`) — see `README.md` → *DSP fidelity*.
