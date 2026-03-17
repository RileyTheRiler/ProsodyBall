from playwright.sync_api import sync_playwright

def verify_frontend():
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
                "--no-sandbox"
            ]
        )
        page = browser.new_page()
        page.goto("http://localhost:8000")

        # Click start
        page.click("#startBtn")
        page.wait_for_timeout(2000)

        # Check calibration wizard
        page.wait_for_selector("#calibrationOverlay.show")

        # Check DOM manipulation by evaluating it directly
        title = page.evaluate("document.getElementById('calStepTitle').textContent")
        desc = page.evaluate("document.getElementById('calStepDesc').textContent")
        print(f"Calibration title: {title}")
        print(f"Calibration desc: {desc}")

        page.screenshot(path="verify_calibration.png")

        # Test recordings UI
        page.evaluate("""
            import('./app.js').then((module) => {
                const game = module.game;
                game.recordings = [
                    { timestamp: '10:00:00', duration: 5.5, name: 'vox-ball-1', blob: new Blob([]), dataUrl: '' },
                    { timestamp: '10:01:00', duration: 2.1, name: 'vox-ball-2', blob: new Blob([]), dataUrl: '' }
                ];
                game.updateRecordingsUI();
            });
        """)

        page.click("#recordingsBtn")
        page.wait_for_timeout(1000)

        page.screenshot(path="verify_recordings.png")

        print("Recordings UI rendered successfully.")

        browser.close()

if __name__ == "__main__":
    verify_frontend()
