const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();

    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', error => console.error('BROWSER ERROR:', error.message));

    await page.goto('http://localhost:8080/index.html');
    await page.waitForSelector('.mode-card[data-mode="creature"]');

    console.log('Before click:');
    const emptyHintHidden = await page.$eval('.mode-details-empty', el => window.getComputedStyle(el).display);
    console.log('Empty hint display:', emptyHintHidden);
    const creatureDetailsDisplay = await page.$eval('#creatureDetails', el => window.getComputedStyle(el).display);
    console.log('Creature details display:', creatureDetailsDisplay);

    await page.click('.mode-card[data-mode="creature"]');
    await new Promise(r => setTimeout(r, 500));

    console.log('\nAfter click:');
    const emptyHintHiddenAfter = await page.$eval('.mode-details-empty', el => window.getComputedStyle(el).display);
    console.log('Empty hint display pattern:', emptyHintHiddenAfter);
    const creatureDetailsDisplayAfter = await page.$eval('#creatureDetails', el => window.getComputedStyle(el).display);
    console.log('Creature details display:', creatureDetailsDisplayAfter);

    const rightMenuWidth = await page.$eval('.menu-right', el => el.offsetWidth);
    const modeDetailsWidth = await page.$eval('#modeDetails', el => el.offsetWidth);
    console.log('menu-right width:', rightMenuWidth);
    console.log('modeDetails width:', modeDetailsWidth);

    await browser.close();
})();
