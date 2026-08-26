const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8080');

  // Wait for the app to load
  await page.waitForSelector('#app', { state: 'visible' });

  // Open help tooltip by clicking "How to Play" button if visible, else evaluate
  await page.evaluate(() => {
    const t = document.getElementById('helpTooltip');
    t.classList.add('show');
    t.style.display = 'block';
  });

  await page.waitForSelector('#tabHowto', { state: 'visible' });

  // Initial state check
  let howtoSelected = await page.$eval('#tabHowto', el => el.getAttribute('aria-selected'));
  let rainbowSelected = await page.$eval('#tabRainbow', el => el.getAttribute('aria-selected'));
  console.log(`Initial: HowTo=${howtoSelected}, Rainbow=${rainbowSelected}`);

  if (howtoSelected !== 'true' || rainbowSelected !== 'false') {
    console.error('Initial state is incorrect');
    process.exit(1);
  }

  // Click Rainbow tab
  await page.click('#tabRainbow');

  // Wait a tiny bit for JS to run
  await new Promise(r => setTimeout(r, 100));

  // State after clicking
  howtoSelected = await page.$eval('#tabHowto', el => el.getAttribute('aria-selected'));
  rainbowSelected = await page.$eval('#tabRainbow', el => el.getAttribute('aria-selected'));
  console.log(`After click: HowTo=${howtoSelected}, Rainbow=${rainbowSelected}`);

  if (howtoSelected !== 'false' || rainbowSelected !== 'true') {
    console.error('State after click is incorrect');
    process.exit(1);
  }

  console.log('All tests passed.');
  await browser.close();
})();
