import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const browserName = process.env.BROWSER || 'chrome'; // chrome | firefox
const port = Number(process.env.PORT || 4173);
const baseUrl = `http://127.0.0.1:${port}/index.html`;

if (!['chrome', 'firefox'].includes(browserName)) {
  console.error(`Unknown BROWSER=${browserName} (expected chrome|firefox)`);
  process.exit(2);
}

const server = spawn('python', ['-m', 'http.server', String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

let browser;
try {
  const launchArgs = browserName === 'firefox'
    ? { product: 'firefox', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    : {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    };

  browser = await puppeteer.launch(launchArgs);
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#startBtn');

  await page.click('.mode-card[data-mode="creature"]');
  const creatureVisible = await page.$eval('#creatureDetails', (el) => getComputedStyle(el).display !== 'none');
  if (!creatureVisible) throw new Error('mode switching failed for creature');

  await page.keyboard.press('Tab');
  const focusedTag = await page.evaluate(() => document.activeElement?.tagName || '');
  if (!focusedTag) throw new Error('no focused element after keyboard Tab');

  const reliability = await page.evaluate(async () => {
    const mod = await import('./reliability.js');
    const mockCtx = { state: 'suspended', async resume() { this.state = 'running'; } };
    const resumed = await mod.ensureAudioContextRunning(mockCtx);
    return resumed.ok;
  });
  if (!reliability) throw new Error('ensureAudioContextRunning smoke failed');

  console.log(`[smoke:${browserName}] PASS`);
} catch (err) {
  console.error(`[smoke:${browserName}] FAIL`, err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
