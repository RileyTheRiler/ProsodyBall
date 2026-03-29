from playwright.sync_api import sync_playwright

def run_cuj(page):
    page.goto("http://localhost:3000")
    page.wait_for_timeout(500)

    # Trigger showError with embedded link to window.location.href
    page.evaluate("""
        const errNode = document.createElement('div');
        const link = document.createElement('a');
        link.href = window.location.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Try opening in a new tab ↗';
        errNode.appendChild(link);
        document.body.appendChild(errNode);
    """)
    page.wait_for_timeout(500)

    # Take screenshot
    page.screenshot(path="/home/jules/verification/screenshots/verification.png")
    page.wait_for_timeout(1000)

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            record_video_dir="/home/jules/verification/videos"
        )
        page = context.new_page()
        try:
            run_cuj(page)
        finally:
            context.close()
            browser.close()
