// The vowel set §5's Phase 4 entry names, in the order it names them. Each is ONE production
// and becomes ONE segment: the ceiling search compares candidates on how well they track
// formants across the vowel space, and a boundary run through a continuity tracker is a
// measurement of the boundary (see VoiceAnalyzer.calibrateLpcCeiling).
export const VOWEL_SET_PROMPTS = Object.freeze([
  { vowel: 'ə', say: '"uh"', hint: 'relaxed, like the middle of "sofa"' },
  { vowel: 'i', say: '"eee"', hint: 'as in "see"' },
  { vowel: 'u', say: '"ooo"', hint: 'as in "who"' },
  { vowel: 'æ', say: '"aaa"', hint: 'as in "cat"' },
  { vowel: 'ɑ', say: '"ahh"', hint: 'as in "father"' },
]);

// The standard phrase: the Rainbow Passage's opening sentence, which is already the fixture
// every frame-yield number in this redesign is measured on.
export const CALIBRATION_PHRASE =
  'When the sunlight strikes raindrops in the air, they act like a prism and form a rainbow.';

export const VOWEL_HOLD_SECS = 2.0;
export const PHRASE_SECS = 6.0;
// Below this a production has not produced enough evidence to be worth scoring a ceiling on.
export const VOWEL_MIN_WINDOWS = 12;

// Three postures. Only the two DELIBERATE extremes set the ends of the span; habitual sets
// none of it (see spanFromPostures). The wording avoids male/female framing throughout, per
// §2.10 — longer/darker to shorter/brighter, which is what the axis actually is.
export const POSTURE_PROMPTS = Object.freeze([
  {
    key: 'habitual',
    instruction: (w) => ['Read this ', w._strong('the way you normally talk'),
      ' — no effort, no target: ', w._strong(CALIBRATION_PHRASE)],
  },
  {
    key: 'brighter',
    instruction: (w) => ['Now read it again, ', w._strong('comfortably brighter and more forward'),
      ' — as bright as you can hold without straining: ', w._strong(CALIBRATION_PHRASE)],
  },
  {
    key: 'darker',
    instruction: (w) => ['And once more, ', w._strong('comfortably darker and more open'),
      ' — like a relaxed yawn, again without pushing: ', w._strong(CALIBRATION_PHRASE)],
  },
]);

export class CalibrationWizard {
  constructor({ overlayId = 'calibrationOverlay', titleId = 'calStepTitle', descId = 'calStepDesc', progressId = 'calProgressFill', nextBtnId = 'calNextBtn', skipBtnId = 'calSkipBtn', visualId = 'calVisualContainer', focusManager = null } = {}) {
    this.overlay = document.getElementById(overlayId);
    this.titleEl = document.getElementById(titleId);
    this.descEl = document.getElementById(descId);
    this.progressEl = document.getElementById(progressId);
    this.nextBtn = document.getElementById(nextBtnId);
    this.skipBtn = document.getElementById(skipBtnId);
    this.visualEl = document.getElementById(visualId);
    this.dialog = this.overlay?.querySelector?.('[role="dialog"]') || this.overlay;
    this.focusManager = focusManager;
    this.isWizardLoopActive = false;
  }

  _show() {
    this.overlay?.classList.add('show');
    this.focusManager?.activate(this.dialog, {
      initialFocus: this.nextBtn,
      onEscape: () => this.cancel(),
    });
  }
  _hide() {
    this.overlay?.classList.remove('show');
    this.focusManager?.deactivate(this.dialog);
    this.isWizardLoopActive = false;
  }

  cancel() {
    this.isWizardLoopActive = false;
    this._hide();
  }

  _clearVisual() {
    if (this.visualEl) this.visualEl.innerHTML = '';
  }

  _strong(text) {
    return Object.assign(document.createElement('strong'), { textContent: text });
  }

  // ===== PHASE 4: GUIDED VOWEL-SET CALIBRATION =====
  //
  // docs/RESONANCE_REDESIGN.md §5's Phase 4 entry: "guided calibration extended to a vowel set
  // (ə i u æ ɑ) plus a standard phrase, sampling three postures: habitual, comfortably
  // brighter, comfortably darker."
  //
  // It replaces §2.8's rejected six-second passive learner and the two-step darkest/brightest
  // flow below, and it does two DIFFERENT jobs in a deliberate order:
  //
  //   PART 1 — THE VOWEL SET sizes the ANALYSIS. Five held vowels at the user's habitual
  //   posture, captured as five SEPARATE SEGMENTS and handed to calibrateLpcCeiling(). That
  //   method takes segments rather than a flat frame list for a measured reason (see its
  //   comment): running one continuity tracker across a vowel boundary measures the boundary,
  //   and it silently rigged the search — the ceiling that found FEWER formants scored best,
  //   0.775 per-formant yield against 0.306 for the ceiling that was three times more accurate.
  //   The vowel set is also what makes the search meaningful: a ceiling is chosen on how well
  //   it tracks formants ACROSS the vowel space, so one sustained /ɑ/ would choose it on a
  //   twentieth of the evidence.
  //
  //   PART 2 — THE THREE POSTURES size the DISPLAY, and they run AFTER the ceiling is applied,
  //   on the standard phrase. The two deliberate extremes set the ends of `resonanceControl`'s
  //   span; the habitual posture sets none of it and is recorded so a later session can tell
  //   "your range moved" from "you are having a dark day". Measuring the postures BEFORE the
  //   ceiling would build the span out of readings the next frame is about to invalidate.
  //
  // The phrase is the Rainbow Passage's opening sentence — the app's own reference material,
  // already the fixture every yield number in this redesign is measured on — rather than a
  // sentence invented here.
  async runVowelSetCalibration(analyzer, { onProfile = null } = {}) {
    if (!this.overlay) return { outcome: 'skipped', reason: 'missing-overlay' };
    if (!analyzer || !analyzer.isActive) return { outcome: 'skipped', reason: 'inactive' };
    try {
      this.isWizardLoopActive = true;
      this._show();
      this._clearVisual();
      this._setStep(
        '🎚 Resonance Setup',
        'Two parts, about a minute. First five short vowels so I can tune the analysis to your '
        + 'voice, then one sentence read three ways so the ring matches your own range. Ready?',
        0,
      );
      this._showBtn(this.nextBtn, 'Start');
      this._showBtn(this.skipBtn, 'Cancel');
      if (await this._waitForClick() === 'skip') { this._hide(); return { outcome: 'cancelled', reason: 'user-cancel' }; }

      // ---- Part 1: the vowel set -> the analysis ceiling ----------------------------------
      const segments = [];
      for (let i = 0; i < VOWEL_SET_PROMPTS.length; i++) {
        const v = VOWEL_SET_PROMPTS[i];
        const seg = await this._captureAudioSegment(analyzer, {
          title: `Vowels · ${i + 1} of ${VOWEL_SET_PROMPTS.length}`,
          instruction: ['Hold ', this._strong(v.say), ' — ', v.hint, ' — steadily, at your normal voice…'],
          progressBase: 4 + i * 7,
          progressSpan: 7,
          holdSecs: VOWEL_HOLD_SECS,
        });
        if (!this.isWizardLoopActive) { this._hide(); return { outcome: 'cancelled', reason: 'closed' }; }
        // A production that produced almost no audio is dropped rather than padded. A short
        // segment is not a shorter measurement of the same thing — it is a different amount of
        // evidence, and scoreLpcCeiling already refuses a candidate with too few frames.
        if (seg.length >= VOWEL_MIN_WINDOWS) segments.push(seg);
      }
      if (segments.length < 3) {
        return this._calibrationFailed('I couldn\u2019t hear enough of those vowels',
          'Find a quieter spot and try again from Settings whenever you like.',
          { outcome: 'incomplete', reason: 'insufficient-vowels', vowels: segments.length });
      }

      this._setStep('Tuning to your voice…', 'One moment.', 40);
      this._clearVisual();
      // Not real time: this is the multi-solve §3.4 forbids per frame and permits here.
      const ceiling = analyzer.calibrateLpcCeiling(segments);
      // Re-read the same holds at the chosen ceiling to learn how far this speaker's vowels
      // move the axis. The span needs that number or it rails on ordinary speech.
      //
      // Optional by construction: this is one more measurement over audio already captured, and
      // failing to get it must cost the user their calibration under no circumstances. A missing
      // method or a throw degrades to the published allowance, which is the population span's
      // own construction — the same fallback a measurement that finds too few vowels takes.
      let vowelExcursionResult = null;
      try {
        if (typeof analyzer.measureVowelSetExcursion === 'function') {
          vowelExcursionResult = analyzer.measureVowelSetExcursion(segments);
        }
      } catch {
        vowelExcursionResult = null;
      }

      // ---- Part 2: three postures on the standard phrase -> the personal span --------------
      const postures = { habitual: [], brighter: [], darker: [] };
      for (let i = 0; i < POSTURE_PROMPTS.length; i++) {
        const posture = POSTURE_PROMPTS[i];
        const readings = await this._capturePostureReadings(analyzer, {
          title: `Your range · ${i + 1} of ${POSTURE_PROMPTS.length}`,
          instruction: posture.instruction(this),
          progressBase: 42 + i * 18,
          progressSpan: 18,
          holdSecs: PHRASE_SECS,
        });
        if (!this.isWizardLoopActive) { this._hide(); return { outcome: 'cancelled', reason: 'closed' }; }
        postures[posture.key] = readings;
      }

      const applied = analyzer.applyVowelSetCalibration({
        postures,
        // This speaker's own across-vowel travel, from the vowel-set holds already captured
        // above. Measured AFTER the ceiling was applied, for the same reason the postures were:
        // on the analysis the app will actually run. Null when too few vowels survived, and the
        // span then falls back to the published allowance rather than to none.
        vowelExcursion: vowelExcursionResult ? vowelExcursionResult.excursion : null,
        ceilingHz: ceiling && ceiling.selected ? ceiling.ceilingHz : null,
        // The habitual reading is stored on the profile so a later session can compare like
        // with like without re-running the whole flow.
        phraseAbsolute: postures.habitual.length
          ? postures.habitual.slice().sort((a, b) => a - b)[Math.floor(postures.habitual.length / 2)]
          : null,
      });
      this._clearVisual();
      this._hideBtn(this.skipBtn);
      if (!applied.ok) {
        return this._calibrationFailed('Couldn\u2019t map your range',
          applied.reason === 'insufficient-samples'
            ? 'I didn\u2019t get a clear reading on every pass — a quieter room usually fixes it.'
            : 'Something looked off in the readings — please try again from Settings.',
          { outcome: 'incomplete', reason: applied.reason, counts: applied.counts });
      }

      if (typeof onProfile === 'function') onProfile(applied.profile);

      const widthPts = Math.round((applied.span.max - applied.span.min) * 100);
      this._setStep(
        '🎉 Resonance calibrated!',
        applied.span.spreadFloored
          // Said plainly rather than dressed up. A floored span means the two postures barely
          // differed, so the ring is normalised against the minimum defensible range and the
          // honest advice is to try again with more contrast.
          ? `Your two postures came out close together, so the ring is using a ${widthPts}-point `
            + 'range for now. Re-run this any time — pushing the bright and dark passes further '
            + 'apart will make the ring more responsive.'
          : `The ring now spans your own range (${widthPts} points wide) — your darkest at the `
            + 'left, your brightest at the right.',
        100,
      );
      this._showBtn(this.nextBtn, 'Done');
      await this._waitForClick(6000, 'next');
      return {
        outcome: 'completed', reason: 'completed',
        profile: applied.profile, span: applied.span, ceiling, counts: applied.counts,
      };
    } catch (err) {
      const errMsg = err && err.message ? err.message : String(err);
      console.error('Vowel-set calibration failed:', errMsg, err);
      return { outcome: 'incomplete', reason: 'exception', error: errMsg };
    } finally {
      this._hide();
      this._clearVisual();
      this._hideBtn(this.nextBtn);
      this._hideBtn(this.skipBtn);
    }
  }

  async _calibrationFailed(title, body, result) {
    this._clearVisual();
    this._setStep(title, body, 100);
    this._hideBtn(this.skipBtn);
    this._showBtn(this.nextBtn, 'Done');
    await this._waitForClick(5000, 'next');
    this._hide();
    return result;
  }

  // Capture the RAW analysis windows of one production, as one segment. The analyzer is driven
  // exactly as every other step here drives it, so the windows are the same ones the live path
  // saw; they are copied because `timeDomainData` is a reused buffer.
  async _captureAudioSegment(analyzer, { title, instruction, progressBase, progressSpan, holdSecs }) {
    const windows = [];
    await this._runHold(analyzer, { title, instruction, progressBase, progressSpan, holdSecs }, () => {
      const td = analyzer.timeDomainData;
      if (td && td.length) windows.push(Float32Array.from(td));
    });
    return windows;
  }

  // Collect the live ABSOLUTE readings of one posture. Suppressed frames contribute nothing —
  // they are not readings, and pushing a 0 for one would drag a posture's median toward the
  // dark end every time the room got noisy.
  async _capturePostureReadings(analyzer, opts) {
    const readings = [];
    await this._runHold(analyzer, opts, () => {
      if (analyzer.resonancePresent && analyzer.resonanceAbsolute != null) {
        readings.push(analyzer.resonanceAbsolute);
      }
    });
    return readings;
  }

  // The shared drive loop. One definition, so the two capture kinds cannot drift apart in how
  // they clock the analyzer — which is the frame-rate fidelity defect DSP_CONTRACT documents.
  async _runHold(analyzer, { title, instruction, progressBase, progressSpan, holdSecs }, onFrame) {
    this._hideBtn(this.nextBtn);
    this._hideBtn(this.skipBtn);
    this._setStep(title, instruction, progressBase);
    this._clearVisual();
    const vuTrack = document.createElement('div');
    vuTrack.className = 'cal-vu-track';
    const vuFill = document.createElement('div');
    vuFill.className = 'cal-vu-fill';
    vuTrack.appendChild(vuFill);
    if (this.visualEl) this.visualEl.appendChild(vuTrack);

    const start = performance.now();
    let last = start;
    while ((performance.now() - start) / 1000 < holdSecs && this.isWizardLoopActive) {
      if (!this.overlay?.classList.contains('show')) { this.isWizardLoopActive = false; break; }
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      analyzer.update(Math.max(0.016, dt));
      const e = analyzer.metrics?.energy || 0;
      if (vuFill) vuFill.style.width = `${Math.min(100, e * 500)}%`;
      onFrame();
      const elapsed = (now - start) / 1000;
      if (this.progressEl) this.progressEl.style.width = `${progressBase + (elapsed / holdSecs) * progressSpan}%`;
      await new Promise((r) => setTimeout(r, 60));
    }
  }

  // ===== GUIDED RESONANCE CALIBRATION =====
  // A deliberate two-step flow (run from Settings) that maps the user's resonance range by
  // asking them to hold their darkest, then brightest, sound — instead of inferring it passively
  // from ambient speech. Reuses this overlay + manual-update-loop pattern; the caller must have an
  // active analyzer and should close the settings panel first.
  async runResonanceCalibration(analyzer) {
    if (!this.overlay) return { outcome: 'skipped', reason: 'missing-overlay' };
    if (!analyzer || !analyzer.isActive) return { outcome: 'skipped', reason: 'inactive' };
    try {
      this.isWizardLoopActive = true;
      this._show();
      this._clearVisual();
      this._setStep(
        '🎚 Resonance Setup',
        'Let’s map your resonance range in two held sounds — your deepest, then your brightest. About 12 seconds. Ready?',
        0
      );
      this._showBtn(this.nextBtn, 'Start');
      this._showBtn(this.skipBtn, 'Cancel');
      if (await this._waitForClick() === 'skip') { this._hide(); return { outcome: 'cancelled', reason: 'user-cancel' }; }

      const dark = await this._captureResonanceStep(analyzer, {
        title: 'Step 1 of 2 · Deepest',
        instruction: ['Make your ', this._strong('deepest, most hollow'), ' sound — like a big yawn, ',
          this._strong('“awww”'), ', pulled back in your throat. Hold it steady…'],
        progressBase: 10,
      });
      if (!this.isWizardLoopActive) { this._hide(); return { outcome: 'cancelled', reason: 'closed' }; }

      const bright = await this._captureResonanceStep(analyzer, {
        title: 'Step 2 of 2 · Brightest',
        instruction: ['Now your ', this._strong('brightest, most forward'), ' sound — a smiley ',
          this._strong('“eee”'), ' right at the front of your mouth. Hold it steady…'],
        progressBase: 55,
      });
      if (!this.isWizardLoopActive) { this._hide(); return { outcome: 'cancelled', reason: 'closed' }; }

      const MIN_SAMPLES = 5;
      if (dark.f1.length < MIN_SAMPLES || bright.f1.length < MIN_SAMPLES) {
        this._clearVisual();
        this._setStep(
          'Didn’t catch a steady sound',
          'I couldn’t hear a clear held vowel for each step. Find a quieter spot and try again from Settings whenever you like.',
          100
        );
        this._hideBtn(this.skipBtn);
        this._showBtn(this.nextBtn, 'Done');
        await this._waitForClick(5000, 'next');
        this._hide();
        return { outcome: 'incomplete', reason: 'insufficient-samples', darkN: dark.f1.length, brightN: bright.f1.length };
      }

      const applied = analyzer.applyGuidedResonanceRange(dark, bright);
      this._clearVisual();
      this._hideBtn(this.skipBtn);
      if (!applied) {
        this._setStep('Couldn’t map the range', 'Something looked off in the readings — please try again from Settings.', 100);
        this._showBtn(this.nextBtn, 'Done');
        await this._waitForClick(5000, 'next');
        this._hide();
        return { outcome: 'incomplete', reason: 'apply-failed' };
      }
      const rp = analyzer.resonanceProfile;
      this._setStep(
        '🎉 Resonance calibrated!',
        `Your map now spans your own range (F1 ${Math.round(rp.f1Min)}–${Math.round(rp.f1Max)} Hz) — deepest at the left, brightest at the right.`,
        100
      );
      this._showBtn(this.nextBtn, 'Done');
      await this._waitForClick(4000, 'next');
      return { outcome: 'completed', reason: 'completed' };
    } catch (err) {
      const errMsg = err && err.message ? err.message : String(err);
      console.error('Resonance calibration failed:', errMsg, err);
      return { outcome: 'incomplete', reason: 'exception', error: errMsg };
    } finally {
      this._hide();
      this._clearVisual();
      this._hideBtn(this.nextBtn);
      this._hideBtn(this.skipBtn);
    }
  }

  // Capture a single held-sound step: drive the analyzer for a fixed hold, collecting F1/F2/ΔF on
  // confident voiced vowel frames, with a live level meter. Returns {f1, f2, disp} arrays.
  async _captureResonanceStep(analyzer, { title, instruction, progressBase }) {
    this._hideBtn(this.nextBtn);
    this._hideBtn(this.skipBtn);
    this._setStep(title, instruction, progressBase);

    this._clearVisual();
    const vuTrack = document.createElement('div');
    vuTrack.className = 'cal-vu-track';
    const vuFill = document.createElement('div');
    vuFill.className = 'cal-vu-fill';
    vuTrack.appendChild(vuFill);
    if (this.visualEl) this.visualEl.appendChild(vuTrack);

    const HOLD_SECS = 4.5;
    const f1 = [], f2 = [], disp = [];
    const start = performance.now();
    let last = start;
    while ((performance.now() - start) / 1000 < HOLD_SECS && this.isWizardLoopActive) {
      if (!this.overlay?.classList.contains('show')) { this.isWizardLoopActive = false; break; }
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      analyzer.update(Math.max(0.016, dt));

      const e = analyzer.metrics?.energy || 0;
      if (vuFill) vuFill.style.width = `${Math.min(100, e * 500)}%`;

      if (analyzer.formantConfidence > 0.3 && analyzer.vowelLikelihood > 0.3 && e > 0.05 &&
          analyzer.smoothF1 > 0 && analyzer.smoothF2 > 0 && analyzer.formantDispersionHz > 0) {
        f1.push(analyzer.smoothF1);
        f2.push(analyzer.smoothF2);
        disp.push(analyzer.formantDispersionHz);
      }

      const elapsed = (now - start) / 1000;
      if (this.progressEl) this.progressEl.style.width = `${progressBase + (elapsed / HOLD_SECS) * 40}%`;
      await new Promise(r => setTimeout(r, 60));
    }
    return { f1, f2, disp };
  }

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
      this.isWizardLoopActive = true;
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

    this._clearVisual();
    const vuTrack = document.createElement('div');
    vuTrack.className = 'cal-vu-track';
    const vuFill = document.createElement('div');
    vuFill.className = 'cal-vu-fill';
    vuTrack.appendChild(vuFill);
    if (this.visualEl) this.visualEl.appendChild(vuTrack);

    const calDuration = analyzer.noiseCalibrationDuration || 1.0;
    const maxWait = calDuration + 3;
    const roomStart = performance.now();
    let last = performance.now();

    while ((performance.now() - roomStart) / 1000 < maxWait && this.isWizardLoopActive) {
      if (!this.overlay?.classList.contains('show')) {
        this.isWizardLoopActive = false;
        break;
      }

      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      analyzer.update(Math.max(0.016, dt));

      if (vuFill) {
        const e = analyzer.metrics?.energy || 0;
        vuFill.style.width = `${Math.min(100, e * 500)}%`;
      }

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
    holdVowelDesc.append('Say ', Object.assign(document.createElement('strong'), { textContent: '"ahhh"' }), ' steadily now…');
    this._setStep('Step 2 of 2 · Hold a Vowel', holdVowelDesc, 50);

    this._clearVisual();
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 80;
    if (this.visualEl) this.visualEl.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const styles = window.getComputedStyle(document.documentElement);
    const successColor = styles.getPropertyValue('--accent-vowel').trim() || '#6bcb77';
    const normalColor = styles.getPropertyValue('--text-muted').trim() || '#908da5';
    const ringColor = styles.getPropertyValue('--text-primary').trim() || '#eceaf4';

    const vowelStart = performance.now();
    let vowelStable = 0;
    let vowelPassed = false;
    let passedShown = false;
    const minVowelTime = 2.0;
    last = performance.now();
    const vowelTimeout = 10;

    // Record clicks that arrive while the tracking loop is still running, so the
    // loop can keep measuring vowel stability ("keep going") and still exit the
    // moment the user decides. Listeners are removed deterministically below.
    let pendingChoice = null;
    const onLoopNext = () => { pendingChoice = 'next'; };
    const onLoopSkip = () => { pendingChoice = 'skip'; };
    this.nextBtn?.addEventListener('click', onLoopNext);
    this.skipBtn?.addEventListener('click', onLoopSkip);

    try {
    while ((performance.now() - vowelStart) / 1000 < vowelTimeout && this.isWizardLoopActive) {
      if (!this.overlay?.classList.contains('show')) {
        this.isWizardLoopActive = false;
        break;
      }

      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      analyzer.update(Math.max(0.016, dt));

      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        
        ctx.beginPath();
        ctx.arc(cx, cy, 15, 0, Math.PI * 2);
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 2;
        ctx.stroke();

        const v = analyzer.metrics?.vowel || 0;
        const e = analyzer.metrics?.energy || 0;
        const clamp01 = (val) => Math.max(0, Math.min(1, val));
        
        let markerDist = 0;
        let isAligned = false;
        
        if (e < 0.05) {
          markerDist = 120;
        } else {
          markerDist = 120 * (1.0 - clamp01(v / 0.28));
          if (v > 0.28 && e > 0.05) {
             isAligned = true;
          }
        }
        
        const angle = now / 300;
        const px = cx + Math.cos(angle) * markerDist;
        const py = cy + Math.sin(angle) * markerDist;
        
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fillStyle = isAligned ? successColor : normalColor;
        ctx.fill();
        if (isAligned) {
           ctx.shadowColor = successColor;
           ctx.shadowBlur = 10;
           ctx.fill();
           ctx.shadowBlur = 0;
        }
      }

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

      if (vowelPassed && elapsed >= minVowelTime && !passedShown) {
        passedShown = true;
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

      // Keep tracking vowel stability until the user clicks Next/Skip or the loop
      // times out. The await is what yields to the event loop — without it this
      // becomes a synchronous busy-loop that freezes the page and spins
      // analyzer.update() thousands of times per second.
      if (pendingChoice) break;
      await new Promise(r => setTimeout(r, 80));
    }
    } finally {
      this.nextBtn?.removeEventListener('click', onLoopNext);
      this.skipBtn?.removeEventListener('click', onLoopSkip);
    }

    // Same safeguard for the final confirmation step.
    const vowelChoice = pendingChoice ?? await this._waitForClick(5000, 'next');
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
      this._clearVisual();
      this._hideBtn(this.nextBtn);
      this._hideBtn(this.skipBtn);
    }
  }
}
