from playwright.sync_api import sync_playwright

def run_cuj(page):
    page.goto("http://localhost:3000/index.html", wait_until="domcontentloaded")
    page.wait_for_timeout(1000)

    # Capture state before modifications
    page.screenshot(path="/home/jules/verification/screenshots/verification.png")
    page.wait_for_timeout(1000)

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(record_video_dir="/home/jules/verification/videos", viewport={'width': 1280, 'height': 720})
        page = context.new_page()
        try:
            run_cuj(page)
        finally:
            context.close()
            browser.close()
