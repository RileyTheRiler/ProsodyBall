# Driving a smart bulb with ProsodyBall

The on-screen simulated bulb works with no setup. To light up a **real** bulb in
sync with your voice you have a few options:

- **Generic BLE bulb (no hub, no router)** — cheapest and simplest for a fresh
  setup; works with common unencrypted RGB(W) Bluetooth bulbs (Triones /
  HappyLighting / Magic Blue / Zengge / briturn and similar). See below.
- **Philips Hue over Bluetooth (no Bridge)** — if you already own Hue bulbs.
- **Hue Bridge over the LAN** — works in any browser; see "Using the Hue Bridge".

All Bluetooth options need a Chromium-based browser (**Chrome, Edge, or Opera** on
desktop or Android — not Safari/Firefox/iOS) and the same room as the bulb.

---

## Generic BLE bulb — no hub, no router (recommended for a new setup)

Cheap RGB(W) Bluetooth bulbs (sold under generic brands, paired in apps like
*briturn*, *Happy Lighting*, *Triones*, or *Magic Blue*) use open, unencrypted
Bluetooth, so ProsodyBall can drive them straight from the browser — no app, no
hub, no router.

1. Screw the bulb into any lamp/orb shell and turn the fixture on.
2. Open ProsodyBall in Chrome/Edge (the hosted HTTPS site is fine).
3. **Settings → Smart Bulb → Connection: "Generic BLE bulb — no hub"**.
4. Click **Connect bulb (Bluetooth)** and pick the bulb in the browser dialog.
   ProsodyBall auto-detects the common protocol families.
5. Flip **Mirror ball color to bulb** on, grant the mic, and talk — low pitch glows
   blue, high pitch glows pink.

**If auto-detect can't find it:** open a free BLE scanner app (e.g. *nRF Connect*),
read the bulb's **service UUID** and a **writable characteristic UUID**, and paste
them into the three **Advanced** fields under this option (an optional device-name
filter is there too). No code change needed. The bundled physical remote always
works as a manual backup, independent of the app.

---

## Philips Hue over Bluetooth — no Bridge, no router

Hue White & Color Ambiance bulbs have Bluetooth built in, and ProsodyBall can talk
to them straight from the browser. No Bridge, no router, no terminal.

**Requirements:** a Chromium-based browser (**Chrome, Edge, or Opera** on desktop or
Android — not Safari/Firefox/iOS), and being within ~30 ft / the same room as the bulb.

1. Screw in a bulb and turn the fixture on. (You don't need the Bridge at all — leave
   it in the box. If you already added the bulb to the Bridge, it's fine, but Bluetooth
   control is most reliable on a bulb that isn't being driven by the Bridge.)
2. Open ProsodyBall (the hosted site is fine — Web Bluetooth needs HTTPS, which it has).
3. **Settings → Smart Bulb → Connection: "Philips Hue (Bluetooth)"**.
4. Click **Connect bulb (Bluetooth)**, pick your Hue bulb in the browser dialog. If your
   OS asks, allow/pair it. (You may need to pair it once in your system Bluetooth settings.)
5. Flip **Mirror ball color to bulb** on, grant the mic, and talk — low pitch glows blue,
   high pitch glows pink.

Notes & limits: Bluetooth control is same-room only and uses a community-documented Hue
protocol, so it can occasionally be finicky. If colors look off or writes fail, switch to
the Bridge method below.

---

## Using the Hue Bridge

To light up real Hue bulbs via the Bridge (works in any browser, full LAN range), use
the bundled local helper.

## Why a local helper is needed

Browsers can't talk to a Hue Bridge directly: current Hue firmware exposes the local
API over **HTTPS only with a self-signed certificate** (which browsers reject), its CORS
behavior is unreliable, and an HTTPS-hosted page can't reach a plain-HTTP LAN address
(mixed content). The helper is a tiny **zero-dependency Node server** that does the part
the browser can't, and forwards color commands to your bridge.

## One-time setup

1. Plug in your Hue Bridge (the square hub) and screw in the color bulbs. Make sure your
   computer is on the **same Wi-Fi/LAN** as the bridge.
2. From the project folder, run:

   ```bash
   npm run hue
   ```

3. When prompted, **press the round link button on top of the bridge**. The helper pairs,
   saves credentials to `.hue-credentials.json` (git-ignored), and prints a URL.

## Using it

1. Open the URL the helper prints (e.g. `http://localhost:4793`).
2. Open **Settings → Smart Bulb**.
3. Set **Connection** to **Custom HTTP endpoint** and paste the endpoint the helper
   printed (e.g. `http://localhost:4793/hue/light`).
4. Flip **Mirror ball color to bulb** on, hit **Test connection** to confirm, then speak —
   low pitch glows blue, high pitch glows pink, matching the on-screen ball.

The helper drives **all lights** (Hue group `0`) by default.

## Options

Environment variables (optional):

| Variable | Purpose |
| --- | --- |
| `HUE_BRIDGE_IP` | Skip auto-discovery and use this bridge IP directly. |
| `HUE_GROUP` | Which Hue group to control (`0` = all lights, the default). |
| `PORT` | Port for the local helper (default `4793`). |

To re-pair from scratch, delete `.hue-credentials.json` and run `npm run hue` again.

## Notes

- The helper accepts the bridge's self-signed certificate because it's a trusted device on
  your local network. Run it on a network you control.
- You can keep using the hosted ProsodyBall site instead of the helper's `http://localhost`
  page — browsers exempt `http://localhost` from mixed-content blocking, so the **Custom
  HTTP endpoint** transport still reaches the helper.
