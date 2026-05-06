from playwright.sync_api import sync_playwright

def run_cuj(page):
    page.goto("http://localhost:8000")
    page.wait_for_timeout(1000)

    # Click the "Start" button to show the iframe notice (in this environment, microphone is blocked)
    try:
        page.locator("#btnStart").click()
    except:
        print("btnStart not found or couldn't click")

    page.wait_for_timeout(1000)

    # Try clicking the "Mic test panel" button if btnStart doesn't show the error directly
    try:
         page.locator("#btnMicTest").click()
    except:
         print("btnMicTest not found or couldn't click")

    page.wait_for_timeout(1000)

    page.screenshot(path="verify_sentinel.png")
    page.wait_for_timeout(1000)

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            record_video_dir="."
        )
        page = context.new_page()
        try:
            run_cuj(page)
        finally:
            context.close()
            browser.close()
