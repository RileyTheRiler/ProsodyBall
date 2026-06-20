# Vox Arcade — Galaxy Watch 7 Setup Guide

Step-by-step instructions to get the app onto a Samsung Galaxy Watch 7 (or any
Wear OS 3+ watch). This app is **watch-only** — there is no phone app and it is
not in the Play Store, so you install it by sideloading the APK over Wi-Fi.

> The Galaxy Watch 7 charges on a wireless puck and has **no USB data port**, so
> everything here is done **over Wi-Fi**. Your watch and computer must be on the
> **same Wi-Fi network** the entire time.

---

## What you need

- The Galaxy Watch 7, charged and on Wi-Fi.
- A computer (Windows/Mac/Linux) on the **same** Wi-Fi network.
- ~15 minutes for the first-time setup. After that, reinstalling takes seconds.

---

## Step 1 — Install ADB on your computer (one time)

ADB ("Android Debug Bridge") is the tool that pushes the app to the watch.

- **Windows:** Download "SDK Platform-Tools for Windows" from
  <https://developer.android.com/tools/releases/platform-tools>, unzip it (e.g. to
  `C:\Users\<you>\Desktop\platform-tools`). Open that folder, click the address
  bar, type `cmd`, and press Enter to open a terminal **in that folder**.
- **Mac:** `brew install android-platform-tools` (with Homebrew), or download the
  Mac platform-tools zip and unzip it.
- **Linux:** `sudo apt install adb` (Debian/Ubuntu), or download the Linux zip.

Check it works:
```
adb version
```
You should see a version number. (On Mac/Linux using the downloaded zip, `cd` into
the folder and use `./adb` instead of `adb`.)

---

## Step 2 — Download the app (the APK)

1. Open the build workflow:
   <https://github.com/RileyTheRiler/ProsodyBall/actions/workflows/wear-build.yml>
2. Click the most recent **green** run.
3. Scroll to **Artifacts** at the bottom and download **`vox-ball-wear-debug-apk`**.
4. Unzip it — you get **`app-debug.apk`**. Move it into your `platform-tools`
   folder so it's easy to reach.

> No Android Studio needed. (If you ever want to build it yourself, see
> `wear/README.md`.)

---

## Step 3 — Turn on wireless debugging on the watch

On the **watch**:

1. **Settings → About watch → Software** → tap **Software version** about **7
   times** until it says developer mode is on. (Skip if already done.)
2. **Settings → Developer options** → turn on:
   - **ADB debugging** (accept the warning)
   - **Wireless debugging** (may be labeled *Debug over Wi-Fi*)

Leave the **Wireless debugging** screen open — you need numbers from it next.

---

## Step 4 — Pair and connect

Wear OS 5 uses Android's pairing flow. **Use the numbers shown on YOUR watch** —
the examples below are placeholders.

1. On the watch: **Wireless debugging → Pair new device**. Keep this popup **open**.
   It shows a **6-digit code** and an address like `192.168.1.50:37115`.
   - That port (the long one in the popup) is the **pairing** port. It and the code
     **change every time** you open this screen — so don't reopen it mid-command.
2. On the computer, using **your** popup's IP:port:
   ```
   adb pair 192.168.1.50:37115
   ```
   Enter the **6-digit code** from that same popup when asked. You want
   **"Successfully paired."**
3. Now connect. Go to the **main** Wireless debugging screen (not the popup); it
   lists a **different** IP:port (often ending in `:5555`). Using those numbers:
   ```
   adb connect 192.168.1.50:5555
   ```
4. Confirm the watch is connected:
   ```
   adb devices
   ```
   You should see a line ending in **`device`**. If the watch shows an
   **"Allow debugging?"** prompt, check *Always allow* and tap OK.

> Some watches skip pairing and just show one IP:port under *Debug over Wi-Fi* — if
> so, go straight to `adb connect <that ip:port>`.

---

## Step 5 — Install the app

From the folder containing `app-debug.apk`:
```
adb install -r app-debug.apk
```
Wait for **`Success`**. (If the APK is elsewhere, use the full path, e.g.
`adb install -r C:\Users\<you>\Downloads\app-debug.apk`.)

---

## Step 6 — Verify and open it

Confirm it installed:
```
adb shell pm list packages | findstr voxarcade
```
- Prints **`package:com.voxarcade.wear`** → installed. 
- Prints nothing → it didn't install; recheck Step 4/5.

(On Mac/Linux use `grep voxarcade` instead of `findstr voxarcade`.)

Launch it directly on the watch (skips hunting through the app list):
```
adb shell am start -n com.voxarcade.wear/.MainActivity
```
The watch should open the app. Tap **Allow** for the **microphone**.

### Finding it later, on the watch
It appears in the **watch's app list** (press the watch's lower side button, or
swipe up, then scroll) as **Vox Ball**. It is **not** on your phone.

> **Don't see the icon even though Step 6 says it's installed?** Sideloaded apps on
> Galaxy Watch sometimes don't appear in the list until you **reboot the watch**.
> Restart it and the icon will show.

---

## Step 7 — Using the app

On launch you pick a mode:

- **Necklace** (eyes-free): the screen goes dark. Wear the watch on a lanyard so
  the mic is near your mouth. Tap the big circle to start listening (**one buzz =
  on**). It **buzzes when your pitch (150–250 Hz) or resonance (30–70%) drifts out
  of range**. Tap again to stop (**two buzzes = off**, mic released). **⚙ Alerts**
  lets you change which metric/threshold triggers.
- **Vox Ball** (visual): the ball reacts to your voice's pitch and rhythm.

The mic is **off until you start it** — that saves battery and means it isn't
listening to other people in public.

---

## Reinstalling later (after a new build)

Once paired, updating is quick:
```
adb connect <watch-ip>:5555
adb install -r app-debug.apk
```
(You may need to redo `adb pair` if you rebooted the watch or toggled Wireless
debugging off and on, since the ports change.)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `adb` is not recognized | You're not in the `platform-tools` folder, or it's not on PATH. `cd` into that folder (use `./adb` on Mac/Linux). |
| `adb pair` → `protocol fault (couldn't read status message)` | You used the wrong/expired IP:port or code. Reopen **Pair new device** on the watch and use the **fresh** numbers shown right then, while the popup stays open. |
| `adb devices` is empty | Watch and PC aren't on the same Wi-Fi (watch may be on a guest/5GHz network), or Wireless debugging timed out — reopen it. Then `adb kill-server` and retry. |
| Windows firewall blocks it | Allow `adb.exe` through the firewall, or disable it briefly, then retry. |
| Installed but no icon on the watch | **Reboot the watch** — sideloaded apps often appear only after a restart. |
| "Mic blocked — retry" in the app | Permission denied. On the watch: Settings → Apps → Vox Ball → Permissions → allow Microphone, then reopen. |
| No buzz in Necklace mode | Make sure the watch isn't in Do-Not-Disturb/Theater mode (mutes vibration), and that you're actually speaking (alerts only fire on voiced sound). |
| Nothing on your phone | Correct — this is a watch-only app with no phone component. Ignore any phone "Open on watch" buttons; those belong to other apps. |
