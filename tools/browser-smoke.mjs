import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const browserName = process.env.BROWSER || 'chrome'; // chrome | firefox
const port = Number(process.env.PORT || 4173);
const baseUrl = `http://127.0.0.1:${port}/index.html`;
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const serveCli = fileURLToPath(new URL('../node_modules/serve/build/main.js', import.meta.url));

if (!['chrome', 'firefox'].includes(browserName)) {
  console.error(`Unknown BROWSER=${browserName} (expected chrome|firefox)`);
  process.exit(2);
}

const server = spawn(process.execPath, [serveCli, '.', '-l', String(port)], {
  cwd: projectRoot,
  stdio: 'ignore',
  detached: process.platform !== 'win32',
});

function killServer() {
  try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* gone */ } }
}

function assertRectInsideViewport(name, rect, width, height) {
  if (rect.top < -0.5 || rect.left < -0.5 || rect.right > width + 0.5 || rect.bottom > height + 0.5) {
    throw new Error(`${name} escaped ${width}x${height} viewport: ${JSON.stringify(rect)}`);
  }
}

async function checkMobileLayout(page, width, height) {
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.evaluate(() => {
    for (const id of ['settingsPanel', 'vibPanel', 'calibrationOverlay']) {
      document.getElementById(id)?.classList.remove('show');
    }
    document.getElementById('modalBackdrop')?.classList.remove('show');
  });

  await page.click('#settingsBtn');
  const settings = await page.evaluate(() => {
    const panel = document.getElementById('settingsPanel');
    const close = document.getElementById('settingsCloseTopBtn');
    const rect = panel.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    return {
      rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
      closeRect: { top: closeRect.top, right: closeRect.right, bottom: closeRect.bottom, left: closeRect.left },
      sectionCount: panel.querySelectorAll('.settings-section-toggle:not([hidden])').length,
      readiness: document.getElementById('calibrationReadiness').textContent,
    };
  });
  assertRectInsideViewport('Settings panel', settings.rect, width, height);
  assertRectInsideViewport('Settings close button', settings.closeRect, width, height);
  if (width <= 600 && settings.sectionCount < 8) {
    throw new Error(`expected mobile settings accordions, found ${settings.sectionCount}`);
  }
  if (!settings.readiness.includes('Start a session')) {
    throw new Error(`expected calibration prerequisite guidance, got "${settings.readiness}"`);
  }
  await page.click('#settingsCloseTopBtn');

  await page.evaluate(() => {
    const game = window.voxGame;
    game.vibration.rules = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      metric: 'pitch',
      direction: index % 2 ? 'above' : 'below',
      threshold: 150 + index * 5,
      enabled: true,
      cooldownTimer: 0,
      tripped: false,
    }));
    game._renderVibRules();
    document.getElementById('vibPanel').classList.add('show');
  });
  const alerts = await page.evaluate(() => {
    const panel = document.getElementById('vibPanel');
    const close = document.getElementById('vibCloseBtn');
    const rect = panel.getBoundingClientRect();
    const closeRect = close.getBoundingClientRect();
    panel.scrollTop = panel.scrollHeight;
    return {
      rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
      closeRect: { top: closeRect.top, right: closeRect.right, bottom: closeRect.bottom, left: closeRect.left },
      clientHeight: panel.clientHeight,
      scrollHeight: panel.scrollHeight,
      scrollTop: panel.scrollTop,
    };
  });
  assertRectInsideViewport('Alerts panel', alerts.rect, width, height);
  assertRectInsideViewport('Alerts close button', alerts.closeRect, width, height);
  if (alerts.scrollHeight <= alerts.clientHeight || alerts.scrollTop <= 0) {
    throw new Error(`Alerts panel is not scrollable at ${width}x${height}: ${JSON.stringify(alerts)}`);
  }
  await page.click('#vibCloseBtn');
}

// Wait until the server actually accepts requests instead of a fixed sleep —
// a cold `npx serve` regularly takes longer than 2s in CI.
const deadline = Date.now() + 30000;
let serverReady = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(baseUrl, { method: 'HEAD' });
    if (res.ok) { serverReady = true; break; }
  } catch { /* not listening yet */ }
  await new Promise((r) => setTimeout(r, 250));
}
if (!serverReady) {
  console.error(`Static server did not become ready on port ${port} within 30s`);
  killServer();
  process.exit(2);
}

let browser;
try {
  const launchArgs = browserName === 'firefox'
    ? { browser: 'firefox', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    : { headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] };

  browser = await puppeteer.launch(launchArgs);
  const page = await browser.newPage();

  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.error('PAGE ERROR:', error.message));

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  // Basic smoke tests
  const modeCardCount = await page.$$eval('.mode-card', cards => cards.length);
  if (modeCardCount !== 0) throw new Error(`expected no .mode-card elements, found ${modeCardCount}`);

  const overlayTitle = await page.$eval('.overlay-title', el => el.textContent.trim());
  if (!overlayTitle.includes('Vox Ball')) throw new Error(`expected overlay title to mention Vox Ball, got "${overlayTitle}"`);

  const playBtn = await page.$('#playBtn');
  if (!playBtn) throw new Error('Start button (#playBtn) missing');

  await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 });
  await page.evaluate(() => {
    document.getElementById('app').classList.add('playing');
    const help = document.getElementById('helpBtn');
    help.removeAttribute('hidden');
    help.style.display = '';
    document.getElementById('recordingsBtn').classList.add('visible');
  });
  await page.click('#helpBtn');
  if (!await page.$eval('#helpTooltip', (el) => el.classList.contains('show'))) {
    throw new Error('Help panel did not open on the first click');
  }
  await page.click('#helpBtn');
  if (await page.$eval('#helpTooltip', (el) => el.classList.contains('show'))) {
    throw new Error('Help panel did not close on the second click');
  }
  await page.click('#recordingsBtn');
  if (!await page.$eval('#recordingsDrawer', (el) => el.classList.contains('show'))) {
    throw new Error('Recordings drawer did not open on the first click');
  }
  await page.click('#recordingsBtn');
  if (await page.$eval('#recordingsDrawer', (el) => el.classList.contains('show'))) {
    throw new Error('Recordings drawer did not close on the second click');
  }

  if (browserName === 'chrome') {
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    const savedAlerts = await page.evaluate(() => {
      document.getElementById('vibPresetFem').click();
      return localStorage.getItem('vox:vibration:v1');
    });
    if (!savedAlerts) throw new Error('vibration preset was not persisted');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const restoredAlerts = await page.evaluate(() => ({
      enabled: window.voxGame.vibration.enabled,
      rules: window.voxGame.vibration.rules.length,
    }));
    if (!restoredAlerts.enabled || restoredAlerts.rules !== 3) {
      throw new Error(`vibration rules did not restore: ${JSON.stringify(restoredAlerts)}`);
    }

    for (const [width, height] of [[320, 568], [360, 640], [412, 915], [740, 360]]) {
      await checkMobileLayout(page, width, height);
    }

    await page.setViewport({ width: 360, height: 640, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.evaluate(() => {
      window.voxGame.analyzer.isActive = true;
      document.getElementById('settingsBtn').click();
      document.getElementById('guidedResonanceBtn').click();
    });
    await page.waitForSelector('#calibrationOverlay.show');
    const guidedState = await page.evaluate(() => ({
      settingsVisible: document.getElementById('settingsPanel').classList.contains('show'),
      calibrationVisible: document.getElementById('calibrationOverlay').classList.contains('show'),
      calibrationInsideHiddenWelcome: Boolean(document.getElementById('calibrationOverlay').closest('#welcomeOverlay')),
    }));
    if (guidedState.settingsVisible || !guidedState.calibrationVisible || guidedState.calibrationInsideHiddenWelcome) {
      throw new Error(`guided resonance mobile flow failed: ${JSON.stringify(guidedState)}`);
    }
    await page.click('#calSkipBtn');
    await page.waitForFunction(() => !document.getElementById('calibrationOverlay').classList.contains('show'));
  }

  console.log(`[smoke:${browserName}] PASS`);
} catch (err) {
  console.error(`[smoke:${browserName}] FAIL`, err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  killServer();
}
