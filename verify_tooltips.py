from playwright.sync_api import sync_playwright

def run_cuj(page):
    page.goto("http://localhost:3000/index.html", wait_until="domcontentloaded")
    page.wait_for_timeout(1000)

    # Need to click start so secondary controls become visible.
    # We will just evaluate to forcefully show them for testing, or just hover a visible meter

    # Forcefully reveal meters
    page.evaluate("document.querySelector('.meters-panel').style.display = 'block'")
    page.evaluate("document.querySelector('#metersPanel').classList.add('expanded')")

    page.wait_for_timeout(500)

    # Find the Pitch meter info trigger
    trigger = page.locator(".meter-pitch .info-trigger")

    # Focus the element
    trigger.evaluate("el => el.dispatchEvent(new Event('focus'))")

    page.wait_for_timeout(1000)

    # Capture the tooltip in focused state
    page.screenshot(path="verify_tooltip.png")
    page.wait_for_timeout(1000)

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            record_video_dir="videos"
        )
        page = context.new_page()
        try:
            run_cuj(page)
        finally:
            context.close()
            browser.close()
