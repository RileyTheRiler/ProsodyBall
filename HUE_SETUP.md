# Driving Philips Hue bulbs with ProsodyBall

The on-screen simulated bulb works with no setup. To light up **real** Philips Hue
bulbs in sync with your voice, use the bundled local helper.

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
