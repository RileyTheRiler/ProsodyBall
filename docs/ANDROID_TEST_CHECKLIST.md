# Android release checklist

Test at least one compact phone (320–360 CSS px wide) and one current large phone in Chrome. Samsung Internet is a useful secondary pass.

## Layout and accessibility

- Open Settings, Alerts, Help, DAF, Recordings, and every expanded Settings section.
- Scroll to the final action in portrait and landscape with browser controls visible.
- Open the keyboard in every text/number field; confirm the focused field and close control remain reachable.
- Rotate while Settings or Alerts is open.
- Verify Tab/keyboard focus stays inside Settings and calibration dialogs, and Escape closes them when a hardware keyboard is attached.
- Enable Android’s largest font size and display size; confirm controls remain usable.

## Audio and sessions

- Grant, deny, revoke, and re-grant microphone permission; confirm each error remains visible after the welcome screen closes.
- Run initial calibration and guided resonance calibration from Settings.
- Start and stop several sessions and verify the microphone indicator turns off.
- Background the app for 30 seconds, return, and verify audio recovers cleanly.
- Confirm the screen stays awake during a session where Wake Lock is supported, then can sleep after stopping.

## Alerts and installation

- Configure several vibration rules, reload, and verify they persist.
- Trigger a vibration on a physical device and verify low-motion mode does not add shake.
- Install from Chrome’s app menu, launch standalone, then launch once in airplane mode.
- Export settings, reset them, and import the backup. Confirm private bulb credentials were not included in the JSON.

Automated browser smoke covers the compact viewport matrix, scrolling, orientation, focus trapping, the global error banner, the web manifest, and the pitch worker. Physical-device checks remain required for microphone routing, vibration hardware, browser chrome, and OEM keyboard behavior.
