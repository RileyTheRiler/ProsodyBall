// One-off visual gut-check: render the ball at several resonance/confidence levels and
// save a labeled montage PNG so the resonance-ring readability change can be eyeballed.
// Not wired into CI — run manually: node tools/ring-shots.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.env.OUT_DIR || path.join(__dirname, '..');
const port = Number(process.env.PORT || 4188);
const baseUrl = `http://127.0.0.1:${port}/index.html`;

const server = spawn('npx', ['serve', '.', '-l', String(port)], { stdio: 'ignore', shell: true, detached: true });
const killServer = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* gone */ } } };

const deadline = Date.now() + 30000;
let ready = false;
while (Date.now() < deadline) {
  try { const r = await fetch(baseUrl, { method: 'HEAD' }); if (r.ok) { ready = true; break; } } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 250));
}
if (!ready) { console.error('server not ready'); killServer(); process.exit(2); }

let browser;
try {
  browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  const dataUrl = await page.evaluate(async () => {
    const m = await import('./app.js');     // ES module cache → same `game` instance the page built
    const game = m.game;
    const a = game.analyzer;

    const W = 480, H = 380;
    const canvas = game.canvas;
    canvas.width = W; canvas.height = H;
    game.width = W; game.height = H;
    game.ctx = canvas.getContext('2d');
    game.scrollX = 0; game.cameraY = 0; game.trustVividness = 1;
    game.themeMode = 'highcontrast';
    if (!Array.isArray(game.stars)) game.stars = [];
    game.groundY = H * 0.92;
    game.ball.baseRadius = 64; game.ball.radius = 64; game.ball.squash = 1;
    game.ball.rotation = 0.0;
    game.ball.x = W * 0.5; game.ball.y = H * 0.46;

    // (label, resonance, formantConfidence, F3 Hz)
    const scenes = [
      ['low res / uncertain  (res .15, conf .0)', 0.15, 0.0, 2600],
      ['quiet speech         (res .30, conf .45)', 0.30, 0.45, 2700],
      ['typical              (res .50, conf .50)', 0.50, 0.50, 2750],
      ['confident bright     (res .85, conf .90)', 0.85, 0.90, 3050],
    ];

    const montage = document.createElement('canvas');
    montage.width = W * 2; montage.height = H * 2;
    const mctx = montage.getContext('2d');
    mctx.fillStyle = '#000'; mctx.fillRect(0, 0, montage.width, montage.height);

    for (let i = 0; i < scenes.length; i++) {
      const [label, res, conf, f3] = scenes[i];
      a.smoothResonance = res;
      a.formantConfidence = conf;
      a.smoothF1 = 500; a.smoothF2 = 1500; a.smoothF3 = f3;
      const prosodyGlow = 0.25;
      game.drawSceneInternal(prosodyGlow);
      const cx = (i % 2) * W, cy = Math.floor(i / 2) * H;
      mctx.drawImage(canvas, cx, cy);
      mctx.fillStyle = 'rgba(0,0,0,0.55)';
      mctx.fillRect(cx, cy, W, 22);
      mctx.fillStyle = '#fff';
      mctx.font = '13px monospace';
      mctx.fillText(label, cx + 8, cy + 15);
    }
    return montage.toDataURL('image/png');
  });

  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const outPath = path.join(outDir, 'ring-readability.png');
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
  console.log('wrote', outPath);
} catch (err) {
  console.error('FAIL', err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  killServer();
}
