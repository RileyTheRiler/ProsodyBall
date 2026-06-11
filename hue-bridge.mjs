#!/usr/bin/env node
// hue-bridge.mjs — local helper that lets ProsodyBall drive real Philips Hue bulbs.
//
// Why this exists:
//   A browser can't talk to a Hue Bridge directly. Current Hue firmware exposes
//   the local API over HTTPS only, with a self-signed certificate browsers reject,
//   and the bridge's CORS behavior is unreliable — plus an HTTPS-hosted page can't
//   reach a plain-HTTP LAN address (mixed content). Node has none of those limits.
//
// What it does (zero npm dependencies — Node built-ins only):
//   1. Discovers + pairs your bridge (you press the round link button once).
//   2. Serves ProsodyBall over http://localhost so there's no mixed-content/CORS pain.
//   3. Accepts POST /hue/light {on,h,s,l} from the app's "Custom HTTP endpoint"
//      bulb transport and forwards it to the bridge as a color command.
//
// Usage:
//   node hue-bridge.mjs            # first run walks you through pairing
//   # then open the printed http://localhost URL, go Settings → Smart Bulb,
//   # choose "Custom HTTP endpoint", set the URL it prints, and enable.
//
// Optional env vars:
//   HUE_BRIDGE_IP=192.168.1.20     # skip discovery (use if auto-discovery fails)
//   HUE_GROUP=0                    # which Hue group to drive (0 = all lights, default)
//   PORT=4793                      # local server port

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hslToHueApi } from './bulb-controller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4793;
const GROUP = process.env.HUE_GROUP ?? '0';
const CREDS_FILE = path.join(__dirname, '.hue-credentials.json');
const DEVICE_TYPE = 'prosodyball#helper';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
};

// --- Bridge HTTP (HTTPS, self-signed cert accepted on the trusted LAN) ---------
function bridgeRequest(ip, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: ip,
      port: 443,
      method,
      path: apiPath,
      rejectUnauthorized: false, // local LAN device with a self-signed cert
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
      timeout: 5000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf || 'null')); } catch { resolve(buf); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('bridge request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

async function discoverBridgeIp() {
  if (process.env.HUE_BRIDGE_IP) return process.env.HUE_BRIDGE_IP;
  try {
    const res = await fetch('https://discovery.meethue.com').then((r) => r.json());
    if (Array.isArray(res) && res[0]?.internalipaddress) return res[0].internalipaddress;
  } catch { /* fall through */ }
  return null;
}

async function pairWithBridge(ip) {
  console.log('\n👉  Press the round link button on top of your Hue Bridge now…');
  for (let attempt = 0; attempt < 60; attempt++) {
    const res = await bridgeRequest(ip, 'POST', '/api', { devicetype: DEVICE_TYPE });
    const entry = Array.isArray(res) ? res[0] : null;
    if (entry?.success?.username) return entry.success.username;
    if (entry?.error?.type === 101) { // "link button not pressed"
      process.stdout.write('.');
      await sleep(2000);
      continue;
    }
    throw new Error('Pairing failed: ' + JSON.stringify(res));
  }
  throw new Error('Timed out waiting for the link button (60s).');
}

function loadCreds() {
  try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')); } catch { return null; }
}
function saveCreds(creds) {
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
}

async function ensureConnection() {
  let creds = loadCreds();
  if (creds?.ip && creds?.username) {
    // Verify the stored credentials still work.
    const lights = await bridgeRequest(creds.ip, 'GET', `/api/${creds.username}/lights`).catch(() => null);
    if (lights && !lights.error && !Array.isArray(lights)) return { ...creds, lights };
    console.log('Stored Hue credentials no longer valid — re-pairing.');
  }
  const ip = await discoverBridgeIp();
  if (!ip) {
    throw new Error('Could not find a Hue Bridge. Set HUE_BRIDGE_IP=<bridge-ip> and retry.');
  }
  console.log(`Found Hue Bridge at ${ip}.`);
  const username = await pairWithBridge(ip);
  creds = { ip, username };
  saveCreds(creds);
  console.log('\n✅  Paired! Credentials saved to .hue-credentials.json');
  const lights = await bridgeRequest(ip, 'GET', `/api/${username}/lights`).catch(() => ({}));
  return { ...creds, lights };
}

// --- Forward a color command to the bridge ------------------------------------
async function setColor(creds, { on = true, h = 0, s = 0, l = 50 }) {
  const { hue, sat, bri } = hslToHueApi(h, s, l);
  const action = on ? { on: true, hue, sat, bri, transitiontime: 1 } : { on: false };
  return bridgeRequest(creds.ip, 'PUT', `/api/${creds.username}/groups/${GROUP}/action`, action);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(__dirname, rel));
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function main() {
  const creds = await ensureConnection();
  const lightNames = creds.lights && typeof creds.lights === 'object'
    ? Object.values(creds.lights).map((x) => x?.name).filter(Boolean)
    : [];
  if (lightNames.length) console.log(`Lights on this bridge: ${lightNames.join(', ')}`);

  const server = http.createServer(async (req, res) => {
    // Permissive CORS so the hosted HTTPS site can also reach this local helper
    // (browsers exempt http://localhost from mixed-content blocking).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const route = req.url.split('?')[0];
    if (req.method === 'POST' && route === '/hue/light') {
      const body = await readJsonBody(req);
      try {
        const result = await setColor(creds, body);
        const errored = Array.isArray(result) && result.some((r) => r.error);
        res.writeHead(errored ? 502 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: !errored, result }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
      }
      return;
    }
    if (req.method === 'GET' && route === '/hue/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ip: creds.ip, lights: lightNames }));
      return;
    }
    serveStatic(req, res);
  });

  server.listen(PORT, () => {
    const endpoint = `http://localhost:${PORT}/hue/light`;
    console.log(`\n🎈  ProsodyBall + Hue helper running.`);
    console.log(`    Open:            http://localhost:${PORT}`);
    console.log(`    In Settings → Smart Bulb, choose "Custom HTTP endpoint" and set the URL to:`);
    console.log(`                     ${endpoint}`);
    console.log(`    Then flip the enable toggle and start speaking.\n`);
  });
}

main().catch((err) => {
  console.error('\n❌ ' + (err && err.message ? err.message : err));
  process.exit(1);
});
