#!/usr/bin/env node
// Generates Vox Arcade PWA icons as PNGs with zero dependencies.
// Draws the brand "bouncing voice ball": a glowing coral->gold orb on the deep
// background, with concentric sound-rings and a bounce arc. Run: node tools/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT_DIR, { recursive: true });

// ---- tiny PNG encoder (8-bit RGBA, no filtering) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // raw scanlines with filter byte 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawing helpers ----
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * t;
function lerpColor(c1, c2, t) {
  return [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];
}

// Palette (matches index.html CSS vars)
const BG_DEEP = [10, 10, 18]; // #0a0a12
const BG_GLOW = [28, 26, 52]; // subtle center lift
const CORAL = [255, 107, 107]; // --accent-bounce #ff6b6b
const GOLD = [255, 217, 61]; // --accent-tempo #ffd93d
const VIOLET = [192, 132, 252];

function drawIcon(size, { maskable = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  // maskable keeps content within the central safe zone (~80%)
  const contentScale = maskable ? 0.8 : 0.92;
  const ballR = size * 0.205 * contentScale;
  const ballCx = cx;
  const ballCy = size * 0.46;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // radial background gradient from center
      const dBg = Math.hypot(x - cx, y - size * 0.42) / (size * 0.75);
      let col = lerpColor(BG_GLOW, BG_DEEP, clamp(dBg, 0, 1));

      // sound rings around the orb (concentric thin arcs)
      const dBall = Math.hypot(x - ballCx, y - ballCy);
      for (let r = 1; r <= 3; r++) {
        const ringR = ballR * (1 + r * 0.42);
        const ringW = size * 0.012;
        const t = Math.abs(dBall - ringR);
        if (t < ringW) {
          const a = (1 - t / ringW) * (0.32 - r * 0.07);
          const ringCol = lerpColor(VIOLET, CORAL, r / 3);
          col = lerpColor(col, ringCol, clamp(a, 0, 1));
        }
      }

      // soft outer glow of the orb
      if (dBall < ballR * 2.1) {
        const g = clamp(1 - (dBall - ballR) / (ballR * 1.1), 0, 1);
        col = lerpColor(col, CORAL, g * 0.22);
      }

      // the orb itself: coral (top) -> gold (bottom) vertical gradient + sheen
      if (dBall < ballR) {
        const vt = clamp((y - (ballCy - ballR)) / (2 * ballR), 0, 1);
        let orb = lerpColor(CORAL, GOLD, vt);
        // top-left sheen highlight
        const sheen = clamp(
          1 - Math.hypot(x - (ballCx - ballR * 0.32), y - (ballCy - ballR * 0.34)) / (ballR * 0.9),
          0,
          1
        );
        orb = lerpColor(orb, [255, 255, 255], sheen * 0.55);
        // anti-aliased edge
        const edge = clamp((ballR - dBall) / 1.5, 0, 1);
        col = lerpColor(col, orb, edge);
      }

      // bounce arc (dashed motion trail under/over the orb)
      const arcR = ballR * 1.62;
      const dArc = Math.abs(Math.hypot(x - ballCx, y - (ballCy + ballR * 0.2)) - arcR);
      const ang = Math.atan2(y - (ballCy + ballR * 0.2), x - ballCx);
      if (dArc < size * 0.014 && ang < -0.15 && ang > -Math.PI + 0.15) {
        const dash = (Math.floor((ang + Math.PI) / 0.22) % 2) === 0;
        if (dash) col = lerpColor(col, GOLD, 0.6);
      }

      const i = (y * size + x) * 4;
      buf[i] = clamp(Math.round(col[0]), 0, 255);
      buf[i + 1] = clamp(Math.round(col[1]), 0, 255);
      buf[i + 2] = clamp(Math.round(col[2]), 0, 255);
      buf[i + 3] = 255;
    }
  }
  return encodePNG(size, size, buf);
}

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-512-maskable.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }],
];
for (const [name, size, opts] of targets) {
  const png = drawIcon(size, opts);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`wrote icons/${name} (${size}x${size}, ${png.length} bytes)`);
}
console.log('done');
