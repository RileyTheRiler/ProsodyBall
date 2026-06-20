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
  // Desktop viewport so the toolbar controls the interaction pass drives are laid
  // out and visible (the compact/portrait layout hides some of them).
  await page.setViewport({ width: 1280, height: 900 });

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

  // ---- Interaction pass --------------------------------------------------
  // The loop above only proves the always-on render path. These subsystems were
  // extracted into modules this session — RecordingSystem (record/DAF), MetricsHud
  // (expanded + popup canvases), VibrationAlerts — and only execute on a user
  // click, so their moved call sites (this.recorder.*/this.hud.*/this.vibration.*)
  // are otherwise untested: a bad delegation would throw only when clicked. Drive
  // each control with the pageerror listener still armed. A control hidden by the
  // active layout is reported as skipped (not a failure); any uncaught error it
  // raises still fails the run.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ran = [];
  const skipped = [];
  async function click(sel, timeout = 2500) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout });
      await page.click(sel);
      return true;
    } catch { return false; }
  }
  async function interact(label, fn) {
    const before = pageErrors.length;
    const did = await fn();
    if (pageErrors.length > before) {
      throw new Error(`uncaught page error during "${label}":\n  ${pageErrors.slice(before).join('\n  ')}`);
    }
    (did ? ran : skipped).push(label);
  }

  // RecordingSystem: enable then disable DAF.
  await interact('daf', async () => {
    if (!(await click('#dafBtn'))) return false;        // open DAF panel
    await click('#dafEnableToggle'); await sleep(400);  // on
    await click('#dafEnableToggle');                    // off
    return true;
  });

  // RecordingSystem: record → stop, and require a clip to render — this proves
  // _encodeWAV + updateRecordingsUI actually ran, not merely that nothing threw.
  let recClips = 0;
  await interact('record', async () => {
    if (!(await click('#recBtn'))) return false;        // start
    await sleep(1200);
    await click('#recBtn');                             // stop → encode + append .rec-item
    await page.waitForSelector('#recordingsList .rec-item', { timeout: 4000 });
    recClips = await page.$$eval('#recordingsList .rec-item', (els) => els.length);
    return true;
  });

  // MetricsHud: expand the HUD so _sizeExpandedCanvases + _updateExpandedMetrics
  // (line graphs, orb, spectrogram, vowel plot) render for several frames.
  await interact('expand-meters', async () => {
    if (!(await click('#metersExpandToggle'))) return false;
    await sleep(1000);
    return true;
  });

  // MetricsHud: open a metric popup (_openMetricPopup + _renderPopupCanvas), close it.
  await interact('metric-popup', async () => {
    if (!(await click('.metric-card[data-metric="pitch"]'))) return false;
    await sleep(600);
    await click('#metricPopupClose');
    return true;
  });

  // VibrationAlerts: fire the test trigger (navigator.vibrate is a headless no-op —
  // we assert the moved code path runs, not hardware output).
  await interact('vibration', async () => {
    await click('#vibToggle');               // open the panel if the button is gated
    return await click('#vibTestBtn');
  });

  if (pageErrors.length) throw new Error(`uncaught page error(s) during interaction pass:\n  ${pageErrors.join('\n  ')}`);

  console.log(`[game-loop] PASS (ran to sessionTimer=${timerText}, 0 page errors)`);
  console.log(
    `[game-loop] interactions: ran=[${ran.join(', ') || 'none'}]` +
    `${skipped.length ? ` skipped=[${skipped.join(', ')}]` : ''}` +
    `${ran.includes('record') ? ` recClips=${recClips}` : ''}`,
  );
} catch (err) {
  console.error('[game-loop] FAIL', err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  killServer();
}
