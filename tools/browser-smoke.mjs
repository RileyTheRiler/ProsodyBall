import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const browserName = process.env.BROWSER || 'chrome'; // chrome | firefox
const port = Number(process.env.PORT || 4173);
const baseUrl = `http://127.0.0.1:${port}/index.html`;

if (!['chrome', 'firefox'].includes(browserName)) {
  console.error(`Unknown BROWSER=${browserName} (expected chrome|firefox)`);
  process.exit(2);
}

const server = spawn('npx', ['serve', '.', '-l', String(port)], { stdio: 'ignore', shell: true, detached: true });

function killServer() {
  // With shell:true, server.pid is the wrapper shell, not `serve` itself —
  // SIGTERM to the shell alone leaves serve squatting on the port, which breaks
  // the second leg of test:browser-matrix. Kill the whole process group, with a
  // direct-kill fallback for platforms without group semantics (Windows).
  try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* gone */ } }
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
  const titles = await page.$$eval('.mode-card', cards => cards.map(c => c.getAttribute('data-mode')));
  console.log('Available modes:', titles);

  if (!titles.includes('creature')) throw new Error('creature mode card missing');

  console.log(`[smoke:${browserName}] PASS`);
} catch (err) {
  console.error(`[smoke:${browserName}] FAIL`, err);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  killServer();
}
