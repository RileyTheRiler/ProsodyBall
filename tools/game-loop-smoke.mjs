// Headless-Chrome integration check that actually RUNS the game loop with a fake
// mic. The regular browser smoke only loads the welcome screen, so it can't catch
// a render-loop regression (e.g. a wrong `this.game.*` reference in GameRenderer
// would throw every frame). Here we click Start, skip calibration, let the loop
// run, and assert: zero uncaught page errors AND the session timer advances —
// which only happens if renderer.update() + drawSceneInternal() ran each frame
// (the timer is updated after them in loop()). Chrome only.
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const port = Number(process.env.PORT || 4191);
const baseUrl = `http://127.0.0.1:${port}/index.html`;

const server = spawn('npx', ['serve', '.', '-l', String(port)], { stdio: 'ignore', shell: true, detached: true });
function killServer() {
  try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* gone */ } }
}

const deadline = Date.now() + 30000;
let ready = false;
while (Date.now() < deadline) {
  try { const r = await fetch(baseUrl, { method: 'HEAD' }); if (r.ok) { ready = true; break; } } catch { /* wait */ }
  await new Promise((r) => setTimeout(r, 250));
}
if (!ready) { console.error('server not ready'); killServer(); process.exit(2); }

let browser;
try {
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--use-fake-ui-for-media-stream',      // auto-grant mic permission
      '--use-fake-device-for-media-stream',  // synthesized audio input
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage();

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  // Start the game.
  await page.click('#playBtn');

  // Calibration wizard pops up first — skip it so the main loop starts promptly.
  try {
    await page.waitForSelector('#calSkipBtn', { visible: true, timeout: 5000 });
    await page.click('#calSkipBtn');
  } catch { /* no wizard / already past it — the 15s start guard covers us */ }

  // Wait until the session timer advances past 0:00 (proves the loop ran through
  // the renderer for at least a second without throwing).
  let timerText = '0:00';
  const runDeadline = Date.now() + 20000;
  while (Date.now() < runDeadline) {
    timerText = await page.$eval('#sessionTimer', (el) => el.textContent.trim()).catch(() => '');
    if (/^\d+:\d\d$/.test(timerText) && timerText !== '0:00') break;
    if (pageErrors.length) break; // fail fast on a thrown frame
    await new Promise((r) => setTimeout(r, 250));
  }

  if (pageErrors.length) throw new Error(`uncaught page error(s) during loop:\n  ${pageErrors.join('\n  ')}`);
  if (!/^\d+:\d\d$/.test(timerText) || timerText === '0:00') {
    throw new Error(`game loop did not advance (sessionTimer="${timerText}") — renderer may have thrown`);
  }

  console.log(`[game-loop] PASS (ran to sessionTimer=${timerText}, 0 page errors)`);
} catch (err) {
  console.error('[game-loop] FAIL', err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  killServer();
}
