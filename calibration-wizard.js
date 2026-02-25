export class CalibrationWizard {
  constructor({ overlayId = 'calibrationOverlay', titleId = 'calStepTitle', descId = 'calStepDesc', progressId = 'calProgressFill', nextBtnId = 'calNextBtn', skipBtnId = 'calSkipBtn' } = {}) {
    this.overlay = document.getElementById(overlayId);
    this.titleEl = document.getElementById(titleId);
    this.descEl = document.getElementById(descId);
    this.progressEl = document.getElementById(progressId);
    this.nextBtn = document.getElementById(nextBtnId);
    this.skipBtn = document.getElementById(skipBtnId);
  }

  _show() { this.overlay?.classList.add('show'); }
  _hide() { this.overlay?.classList.remove('show'); }

  _setStep(title, desc, progress) {
    if (this.titleEl) this.titleEl.textContent = title;
    if (this.descEl) this.descEl.innerHTML = desc;
    if (this.progressEl) this.progressEl.style.width = `${progress}%`;
  }

  _showBtn(btn, text) {
    if (!btn) return;
    btn.textContent = text;
    btn.style.display = 'inline-block';
  }

  _hideBtn(btn) {
    if (!btn) return;
    btn.style.display = 'none';
  }

  /**
   * Returns a promise that resolves when the user clicks a button.
   * resolve('next') or resolve('skip')
   */
  _waitForClick() {
    return new Promise(resolve => {
      const onNext = () => { cleanup(); resolve('next'); };
      const onSkip = () => { cleanup(); resolve('skip'); };
      const cleanup = () => {
        this.nextBtn?.removeEventListener('click', onNext);
        this.skipBtn?.removeEventListener('click', onSkip);
      };
      this.nextBtn?.addEventListener('click', onNext);
      this.skipBtn?.addEventListener('click', onSkip);
    });
  }

  /** Small helper: run analyzer.update in a polling loop for a set duration */
  async _runAnalyzerFor(analyzer, durationSec) {
    const start = performance.now();
    let last = performance.now();
    while ((performance.now() - start) / 1000 < durationSec) {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      analyzer.update(Math.max(0.016, dt));
      await new Promise(r => setTimeout(r, 80));
    }
  }

  async run(analyzer) {
    if (!this.overlay) return { skipped: true };

    // ──────────────────────────────────────
    // Step 0: Welcome — Calibrate or Skip?
    // ──────────────────────────────────────
    this._show();
    this._setStep(
      '🎙 Calibrate Your Mic?',
      'A quick 5-second setup to tune voice tracking to your mic and room. You can also skip and jump right in.',
      0
    );
    this._showBtn(this.nextBtn, 'Calibrate');
    this._showBtn(this.skipBtn, 'Skip');

    const welcomeChoice = await this._waitForClick();
    if (welcomeChoice === 'skip') {
      this._hide();
      return { skipped: true, reason: 'user-skip' };
    }

    // ──────────────────────────────────────
    // Step 1: Room check (automatic ~1 sec)
    // ──────────────────────────────────────
    this._hideBtn(this.nextBtn);
    this._hideBtn(this.skipBtn);
    this._setStep(
      'Step 1 of 2 · Room Check',
      'Stay quiet for a moment while we listen to your room…',
      10
    );

    // Run analyzer for the calibration duration (typically ~1 sec)
    const calDuration = analyzer.noiseCalibrationDuration || 1.0;
    const maxWait = calDuration + 3; // a little extra headroom
    const roomStart = performance.now();
    let last = performance.now();

    while ((performance.now() - roomStart) / 1000 < maxWait) {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      analyzer.update(Math.max(0.016, dt));

      const elapsed = (performance.now() - roomStart) / 1000;
      const pct = Math.min(40, 10 + (elapsed / calDuration) * 30);
      if (this.progressEl) this.progressEl.style.width = `${pct}%`;

      if (analyzer.isCalibrated) break;
      await new Promise(r => setTimeout(r, 80));
    }

    if (!analyzer.isCalibrated) {
      // Room check failed — let user continue anyway
      this._setStep(
        'Room check incomplete',
        'We couldn\'t fully calibrate — it\'s okay, you can still play! Voice tracking may be less accurate.',
        40
      );
      this._showBtn(this.nextBtn, 'Continue Anyway');
      this._showBtn(this.skipBtn, 'Cancel');
      const failChoice = await this._waitForClick();
      this._hide();
      if (failChoice === 'skip') {
        return { skipped: true, reason: 'user-cancel' };
      }
      return { skipped: true, reason: 'timeout', step: 1 };
    }

    // Room check passed — show Next with heads-up about vowel step
    this._setStep(
      'Step 1 of 2 · Room Check ✓',
      '✅ Room calibrated!<br><br>Next up: you\'ll be asked to hold a vowel sound (like "ahhh") for about 2 seconds. This helps us tune to your voice.',
      40
    );
    this._showBtn(this.nextBtn, 'Next');
    this._showBtn(this.skipBtn, 'Skip');

    const roomDoneChoice = await this._waitForClick();
    if (roomDoneChoice === 'skip') {
      this._hide();
      return { skipped: true, reason: 'user-skip' };
    }

    // ──────────────────────────────────────
    // Step 2: Vowel sustain (~2 sec)
    // ──────────────────────────────────────
    this._hideBtn(this.nextBtn);
    this._hideBtn(this.skipBtn);
    this._setStep(
      'Step 2 of 2 · Hold a Vowel',
      'Say <strong>"ahhh"</strong> steadily now…',
      50
    );

    const vowelStart = performance.now();
    let vowelStable = 0;
    let vowelPassed = false;
    const minVowelTime = 2.0; // minimum time before Next becomes available
    last = performance.now();

    // Show the Next button after minVowelTime, regardless of detection
    const vowelTimeout = 10; // max seconds to wait

    while ((performance.now() - vowelStart) / 1000 < vowelTimeout) {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      analyzer.update(Math.max(0.016, dt));

      const elapsed = (performance.now() - vowelStart) / 1000;
      const pct = Math.min(90, 50 + (elapsed / minVowelTime) * 40);
      if (this.progressEl) this.progressEl.style.width = `${pct}%`;

      // Check if vowel detection passes
      if (analyzer.metrics.vowel > 0.28 && analyzer.metrics.energy > 0.05) {
        vowelStable += dt;
        if (vowelStable > 1.2) {
          vowelPassed = true;
        }
      } else {
        vowelStable = Math.max(0, vowelStable - dt * 0.5);
      }

      // After minVowelTime, show the Next button so user isn't stuck
      if (elapsed >= minVowelTime) {
        if (this.nextBtn && this.nextBtn.style.display === 'none') {
          this._setStep(
            'Step 2 of 2 · Hold a Vowel',
            vowelPassed
              ? '✅ Got it! Click <strong>Next</strong> when you\'re ready.'
              : 'Click <strong>Next</strong> when you\'re done, or keep going.',
            90
          );
          this._showBtn(this.nextBtn, 'Next');
          this._showBtn(this.skipBtn, 'Skip');
        }
      }

      // If vowel passed AND min time reached, also allow moving on
      if (vowelPassed && elapsed >= minVowelTime) {
        this._setStep(
          'Step 2 of 2 · Hold a Vowel ✓',
          '✅ Great vowel sustain detected! Click <strong>Next</strong> to continue.',
          95
        );
        this._showBtn(this.nextBtn, 'Next');
        this._showBtn(this.skipBtn, 'Skip');
      }

      // If Next or Skip button is visible, check for clicks via a non-blocking check
      if (this.nextBtn && this.nextBtn.style.display !== 'none') {
        // Switch to waiting for user click
        break;
      }

      await new Promise(r => setTimeout(r, 80));
    }

    // Now wait for user to click Next or Skip
    const vowelChoice = await this._waitForClick();
    if (vowelChoice === 'skip') {
      this._hide();
      return { skipped: true, reason: 'user-skip' };
    }

    // ──────────────────────────────────────
    // Done!
    // ──────────────────────────────────────
    this._hideBtn(this.nextBtn);
    this._hideBtn(this.skipBtn);
    this._setStep(
      '🎉 All Set!',
      'Calibration complete — enjoy your session!',
      100
    );

    await new Promise(r => setTimeout(r, 800));
    this._hide();
    return { skipped: false, reason: 'completed' };
  }
}
