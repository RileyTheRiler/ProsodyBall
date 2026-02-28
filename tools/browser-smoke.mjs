import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

const browserName = process.env.BROWSER || 'chrome'; // chrome | firefox
const port = Number(process.env.PORT || 4173);
const baseUrl = `http://127.0.0.1:${port}/index.html`;

if (!['chrome', 'firefox'].includes(browserName)) {
  console.error(`Unknown BROWSER=${browserName} (expected chrome|firefox)`);
  process.exit(2);
}

const server = spawn('npx', ['serve', '.', '-l', String(port)], { stdio: 'ignore', shell: true });
await new Promise((r) => setTimeout(r, 2000));

let browser;
try {
  const launchArgs = browserName === 'firefox'
    ? { product: 'firefox', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
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
  server.kill('SIGTERM');
}
