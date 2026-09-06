from playwright.sync_api import sync_playwright

def run_cuj(page):
    page.goto("http://localhost:3000/index.html", wait_until="domcontentloaded")
    page.wait_for_timeout(1000)

    # Forcefully reveal meters
    page.evaluate("document.querySelector('.meters-panel').style.display = 'block'")
    page.evaluate("document.querySelector('#metersPanel').classList.add('expanded')")

    page.wait_for_timeout(500)

    # Find the Pitch meter info trigger
    trigger = page.locator(".meter-pitch .info-trigger")

    # Check that ARIA attributes are set correctly
    expanded = trigger.get_attribute('aria-expanded')
    describedby = trigger.get_attribute('aria-describedby')
    print(f"Before focus: aria-expanded={expanded}, aria-describedby={describedby}")

    # Focus the element
    trigger.evaluate("el => el.dispatchEvent(new Event('focus'))")
    page.wait_for_timeout(500)

    expanded_after = trigger.get_attribute('aria-expanded')
    print(f"After focus: aria-expanded={expanded_after}")

    page.wait_for_timeout(1000)

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        try:
            run_cuj(page)
        finally:
            context.close()
            browser.close()
