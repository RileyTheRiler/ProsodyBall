import time
from playwright.sync_api import sync_playwright

def verify(page):
    page.goto('http://localhost:3000')
    time.sleep(2)

    settings_btn = page.get_by_title("Open Settings")

    # 1. Take screenshot of settings button initial state
    page.screenshot(path='/home/jules/verification/before_click.png')

    print("Initial Settings Btn aria-expanded:", settings_btn.get_attribute("aria-expanded"))

    settings_btn.click()
    time.sleep(1)

    # 2. Take screenshot of settings button after click
    page.screenshot(path='/home/jules/verification/after_click.png')
    print("Clicked Settings Btn aria-expanded:", settings_btn.get_attribute("aria-expanded"))

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        page = browser.new_page()
        try:
            verify(page)
        except Exception as e:
            print(f"Error: {e}")
        finally:
            browser.close()
