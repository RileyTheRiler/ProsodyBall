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
    if (this.descEl) {
      this.descEl.textContent = '';
      if (typeof desc === 'object' && desc !== null && (desc.nodeType !== undefined || Array.isArray(desc))) {
        if (Array.isArray(desc)) {
          this.descEl.append(...desc);
        } else {
          this.descEl.appendChild(desc);
        }
      if (desc instanceof Node) {
        this.descEl.append(desc);
      } else if (Array.isArray(desc)) {
        this.descEl.append(...desc);
      } else {
        this.descEl.textContent = desc;
      }
    }
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

  _waitForClick(timeoutMs = 0, timeoutChoice = 'next') {
    return new Promise(resolve => {
      let timer = null;
      const onNext = () => { cleanup(); resolve('next'); };
      const onSkip = () => { cleanup(); resolve('skip'); };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.nextBtn?.removeEventListener('click', onNext);
        this.skipBtn?.removeEventListener('click', onSkip);
      };
      this.nextBtn?.addEventListener('click', onNext);
      this.skipBtn?.addEventListener('click', onSkip);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          resolve(timeoutChoice);
        }, timeoutMs);
      }
    });
  }

  async run(analyzer) {
    if (!this.overlay) return { outcome: 'skipped', skipped: true, reason: 'missing-overlay' };

    try {
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
      return { outcome: 'skipped', skipped: true, reason: 'user-skip' };
    }

    this._hideBtn(this.nextBtn);
    this._hideBtn(this.skipBtn);
    this._setStep('Step 1 of 2 · Room Check', 'Stay quiet for a moment while we listen to your room…', 10);

    const calDuration = analyzer.noiseCalibrationDuration || 1.0;
    const maxWait = calDuration + 3;
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
      this._setStep(
        'Room check incomplete',
        'We couldn\'t fully calibrate — it\'s okay, you can still play! Voice tracking may be less accurate.',
        40
      );
      this._showBtn(this.nextBtn, 'Continue Anyway');
      this._showBtn(this.skipBtn, 'Cancel');
      // Never block indefinitely here: auto-continue after a short grace period
      // so the session does not appear frozen when ambient calibration times out.
      const failChoice = await this._waitForClick(4500, 'next');
      this._hide();
      if (failChoice === 'skip') {
        return { outcome: 'cancelled', skipped: true, reason: 'user-cancel' };
      }
      return { outcome: 'incomplete', skipped: true, reason: 'timeout', step: 1 };
    }

    const roomDoneDesc = document.createDocumentFragment();
    roomDoneDesc.append('✅ Room calibrated!');
    roomDoneDesc.append(document.createElement('br'), document.createElement('br'));
    roomDoneDesc.append('Next up: you\'ll be asked to hold a vowel sound (like "ahhh") for about 2 seconds. This helps us tune to your voice.');

    roomDoneDesc.append('✅ Room calibrated!', document.createElement('br'), document.createElement('br'),
      'Next up: you\'ll be asked to hold a vowel sound (like "ahhh") for about 2 seconds. This helps us tune to your voice.');
    this._setStep(
      'Step 1 of 2 · Room Check ✓',
      roomDoneDesc,
      40
    );
    this._showBtn(this.nextBtn, 'Next');
    this._showBtn(this.skipBtn, 'Skip');

    // Auto-advance if user misses this step so gameplay never appears frozen.
    const roomDoneChoice = await this._waitForClick(4500, 'next');
    if (roomDoneChoice === 'skip') {
      this._hide();
      return { outcome: 'skipped', skipped: true, reason: 'user-skip-step-2' };
    }

    this._hideBtn(this.nextBtn);
    this._hideBtn(this.skipBtn);
    const holdVowelDesc = document.createDocumentFragment();
    holdVowelDesc.append('Say ');
    holdVowelDesc.append(Object.assign(document.createElement('strong'), { textContent: '"ahhh"' }));
    holdVowelDesc.append(' steadily now…');

    holdVowelDesc.append('Say ', Object.assign(document.createElement('strong'), { textContent: '"ahhh"' }), ' steadily now…');
    this._setStep('Step 2 of 2 · Hold a Vowel', holdVowelDesc, 50);

    const vowelStart = performance.now();
    let vowelStable = 0;
    let vowelPassed = false;
    const minVowelTime = 2.0;
    last = performance.now();
    const vowelTimeout = 10;

    while ((performance.now() - vowelStart) / 1000 < vowelTimeout) {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      analyzer.update(Math.max(0.016, dt));

      const elapsed = (performance.now() - vowelStart) / 1000;
      const pct = Math.min(90, 50 + (elapsed / minVowelTime) * 40);
      if (this.progressEl) this.progressEl.style.width = `${pct}%`;

      if (analyzer.metrics.vowel > 0.28 && analyzer.metrics.energy > 0.05) {
        vowelStable += dt;
        if (vowelStable > 1.2) vowelPassed = true;
      } else {
        vowelStable = Math.max(0, vowelStable - dt * 0.5);
      }

      if (elapsed >= minVowelTime) {
        if (this.nextBtn && this.nextBtn.style.display === 'none') {
          const nextWaitDesc = document.createDocumentFragment();
          if (vowelPassed) {
            nextWaitDesc.append('✅ Got it! Click ');
            nextWaitDesc.append(Object.assign(document.createElement('strong'), { textContent: 'Next' }));
            nextWaitDesc.append(' when you\'re ready.');
          } else {
            nextWaitDesc.append('Click ');
            nextWaitDesc.append(Object.assign(document.createElement('strong'), { textContent: 'Next' }));
            nextWaitDesc.append(' when you\'re done, or keep going.');
          }
          this._setStep('Step 2 of 2 · Hold a Vowel', nextWaitDesc, 90);
          const passDesc = document.createDocumentFragment();
          if (vowelPassed) {
            passDesc.append('✅ Got it! Click ', Object.assign(document.createElement('strong'), { textContent: 'Next' }), ' when you\'re ready.');
          } else {
            passDesc.append('Click ', Object.assign(document.createElement('strong'), { textContent: 'Next' }), ' when you\'re done, or keep going.');
          }
          this._setStep(
            'Step 2 of 2 · Hold a Vowel',
            passDesc,
            90
          );
          this._showBtn(this.nextBtn, 'Next');
          this._showBtn(this.skipBtn, 'Skip');
        }
      }

      if (vowelPassed && elapsed >= minVowelTime) {
        const passFinalDesc = document.createDocumentFragment();
        passFinalDesc.append('✅ Great vowel sustain detected! Click ', Object.assign(document.createElement('strong'), { textContent: 'Next' }), ' to continue.');
        this._setStep(
          'Step 2 of 2 · Hold a Vowel ✓',
          passFinalDesc,
          95
        );
        this._showBtn(this.nextBtn, 'Next');
        this._showBtn(this.skipBtn, 'Skip');
      }

      if (this.nextBtn && this.nextBtn.style.display !== 'none') break;
      await new Promise(r => setTimeout(r, 80));
    }

    // Same safeguard for the final confirmation step.
    const vowelChoice = await this._waitForClick(5000, 'next');
    if (vowelChoice === 'skip') {
      this._hide();
      return { outcome: 'partial', skipped: true, reason: 'user-skip-vowel-step' };
    }

    this._hideBtn(this.nextBtn);
    this._hideBtn(this.skipBtn);
    this._setStep('🎉 All Set!', 'Calibration complete — enjoy your session!', 100);

    await new Promise(r => setTimeout(r, 800));
    return { outcome: 'completed', skipped: false, reason: 'completed' };
    } catch (err) {
      const errName = err && err.name ? err.name : 'UnknownError';
      const errMsg = err && err.message ? err.message : String(err);
      console.error(`Calibration wizard failed (${errName}):`, errMsg, err);
      return { outcome: 'incomplete', skipped: true, reason: 'exception', error: errMsg };
    } finally {
      this._hide();
      this._hideBtn(this.nextBtn);
      this._hideBtn(this.skipBtn);
    }
  }
}
