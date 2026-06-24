// Visual gut-check for the ball-colour-vs-pitch fix. Renders the ball at several pitches
// with prosody=0 (the steady "pitch check" posture that used to grey out), plus a low-SNR
// case. Hue comes from the REAL game._computeBallHue; sat/lit mirror the new (decoupled)
// formula in app.js. Manual only. node tools/pitch-color-shots.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.env.OUT_DIR || path.join(__dirname, '..');
const port = Number(process.env.PORT || 4189);
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
    const m = await import('./app.js');
    const game = m.game;
    const a = game.analyzer;

    const W = 440, H = 320;
    const canvas = game.canvas;
    canvas.width = W; canvas.height = H;
    game.width = W; game.height = H;
    game.ctx = canvas.getContext('2d');
    game.scrollX = 0; game.cameraY = 0;
    game.themeMode = 'highcontrast';
    game.colorMode = 'pitch';
    if (!Array.isArray(game.stars)) game.stars = [];
    game.groundY = H * 0.92;
    game.ball.baseRadius = 58; game.ball.radius = 58; game.ball.squash = 1; game.ball.rotation = 0;
    game.ball.x = W * 0.5; game.ball.y = H * 0.46;
    // Steady note: no resonance ring noise, neutral formants.
    a.smoothResonance = 0.5; a.formantConfidence = 0.5; a.smoothF1 = 500; a.smoothF2 = 1500; a.smoothF3 = 2700;

    // (label, pitchHz, trust)  — prosody is held at 0 (the case that used to grey out)
    const scenes = [
      ['95 Hz · deep blue', 95, 1.0],
      ['134 Hz · blue (your shot)', 134, 1.0],
      ['165 Hz · purple', 165, 1.0],
      ['205 Hz · magenta', 205, 1.0],
      ['255 Hz · hot pink', 255, 1.0],
      ['134 Hz · noisy (low SNR)', 134, 0.15],
    ];

    const cols = 3, rows = 2;
    const montage = document.createElement('canvas');
    montage.width = W * cols; montage.height = H * rows;
    const mctx = montage.getContext('2d');
    mctx.fillStyle = '#000'; mctx.fillRect(0, 0, montage.width, montage.height);

    for (let i = 0; i < scenes.length; i++) {
      const [label, hz, trust] = scenes[i];
      a.smoothPitchHz = hz;
      game.prosodyScore = 0;                 // <-- monotone / steady-note posture
      game.trustVividness = trust;
      a.metrics.snrConfidence = trust;
      // Mirror app.js: hue from the real function, colour decoupled from prosody.
      game.ballHue = game._computeBallHue(0.016);
      let sat = 88, lit = game.colorblindMode ? 52 + (game.ballHue < 100 ? 10 : 0) : 52;
      sat *= 0.65 + 0.35 * trust;
      lit *= 0.85 + 0.15 * trust;
      game.ballSat = sat; game.ballLit = lit;
      game.drawSceneInternal(0);             // prosodyGlow 0 — monotone

      const cx = (i % cols) * W, cy = Math.floor(i / cols) * H;
      mctx.drawImage(canvas, cx, cy);
      mctx.fillStyle = 'rgba(0,0,0,0.55)'; mctx.fillRect(cx, cy, W, 22);
      mctx.fillStyle = '#fff'; mctx.font = '13px monospace';
      mctx.fillText(label, cx + 8, cy + 15);
    }
    return montage.toDataURL('image/png');
  });

  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const outPath = path.join(outDir, 'pitch-color.png');
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
  console.log('wrote', outPath);
} catch (err) {
  console.error('FAIL', err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  killServer();
}
