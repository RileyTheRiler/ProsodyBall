export class CalibrationWizard {
  constructor({ overlayId = 'calibrationOverlay', titleId = 'calStepTitle', descId = 'calStepDesc', progressId = 'calProgressFill', skipId = 'calSkipBtn' } = {}) {
    this.overlay = document.getElementById(overlayId);
    this.titleEl = document.getElementById(titleId);
    this.descEl = document.getElementById(descId);
    this.progressEl = document.getElementById(progressId);
    this.skipBtn = document.getElementById(skipId);
  }

  async run(analyzer) {
    if (!this.overlay) return { skipped: true };
    this.overlay.classList.add('show');

    let skipRequested = false;
    const onSkip = () => { skipRequested = true; };
    this.skipBtn?.addEventListener('click', onSkip);

    const steps = [
      {
        title: 'Step 1/3 · Quiet room check',
        desc: 'Stay silent for a few seconds while we calibrate noise floor.',
        pass: () => analyzer.isCalibrated,
      },
      {
        title: 'Step 2/3 · Sustain a vowel',
        desc: 'Say “ahhh” steadily for ~2 seconds.',
        pass: () => analyzer.metrics.vowel > 0.28 && analyzer.metrics.energy > 0.05,
      },
      {
        title: 'Step 3/3 · Pitch glide',
        desc: 'Glide your voice from low to high once.',
        pass: () => analyzer.metrics.bounce > 0.22 && analyzer.lastPitch > 0,
      }
    ];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      this.titleEl.textContent = step.title;
      this.descEl.textContent = step.desc;
      let stablePass = 0;
      let passed = false;
      const maxTime = i === 0 ? 8 : 16;
      const start = performance.now();
      let last = performance.now();

      while ((performance.now() - start) / 1000 < maxTime) {
        if (skipRequested) {
          this._hide();
          this.skipBtn?.removeEventListener('click', onSkip);
          return { skipped: true, reason: 'user-skip' };
        }
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;
        analyzer.update(Math.max(0.016, dt));

        if (step.pass()) {
          stablePass += dt;
          if (stablePass > 1.2) {
            passed = true;
            break;
          }
        } else {
          stablePass = Math.max(0, stablePass - dt * 0.5);
        }

        const stepProgress = Math.min(1, ((performance.now() - start) / 1000) / maxTime);
        this.progressEl.style.width = `${((i + stepProgress) / steps.length) * 100}%`;
        await new Promise(r => setTimeout(r, 80));
      }

      if (!passed) {
        this.titleEl.textContent = 'Calibration timed out';
        this.descEl.textContent = 'We could not detect this step reliably. You can skip for now and retry later.';
        this.skipBtn?.removeEventListener('click', onSkip);
        this._hide();
        return { skipped: true, reason: 'timeout', step: i + 1 };
      }

      this.progressEl.style.width = `${((i + 1) / steps.length) * 100}%`;
    }

    this.skipBtn?.removeEventListener('click', onSkip);
    this._hide();
    return { skipped: false, reason: 'completed' };
  }

  _hide() {
    this.overlay.classList.remove('show');
  }
}
