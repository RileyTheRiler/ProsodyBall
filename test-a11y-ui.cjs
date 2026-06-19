const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();

    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', error => console.error('BROWSER ERROR:', error.message));

    await page.goto('http://127.0.0.1:8080/index.html', { waitUntil: 'networkidle0' });

    console.log('Testing Help Tooltip Accessibility Attributes');

    // Check initial state
    const tabs = await page.$$eval('.help-tab', els => els.map(el => ({
        id: el.id,
        role: el.getAttribute('role'),
        ariaControls: el.getAttribute('aria-controls'),
        ariaSelected: el.getAttribute('aria-selected'),
        classList: Array.from(el.classList)
    })));

    console.log('Initial tabs:', tabs);

    const panels = await page.$$eval('.help-panel', els => els.map(el => ({
        id: el.id,
        role: el.getAttribute('role'),
        ariaLabelledby: el.getAttribute('aria-labelledby'),
        classList: Array.from(el.classList)
    })));

    console.log('Initial panels:', panels);

    // Simulate click on the second tab
    await page.evaluate(() => {
        document.getElementById('helpTab-rainbow').click();
    });

    await new Promise(r => setTimeout(r, 500));

    console.log('\nAfter clicking Rainbow Passage tab:');

    const tabsAfter = await page.$$eval('.help-tab', els => els.map(el => ({
        id: el.id,
        ariaSelected: el.getAttribute('aria-selected'),
        classList: Array.from(el.classList)
    })));

    console.log('Tabs after click:', tabsAfter);

    await browser.close();
})();
