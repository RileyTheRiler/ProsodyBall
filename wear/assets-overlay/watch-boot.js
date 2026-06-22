/*
 * Watch boot layer for ProsodyBall on Wear OS.
 *
 * Injected by MainActivity after index.html loads (and only with ?watch=1), AFTER
 * watch-haptics.cjs has defined window.VoxWatch (the pure pattern/gate helpers). It:
 *   1. flags <html> with `watch` so watch.css applies the wrist layout,
 *   2. shows a launch chooser: Vox Ball (visual) or Necklace (eyes-free),
 *   3. Vox Ball  -> launches the flagship visual mode (default game mode),
 *   4. Necklace  -> a dark, eyes-free haptic-biofeedback mode for wearing the
 *      watch as a pendant near the mouth, with a live pitch + resonance readout
 *      (so both metrics can be seen tracking, in the user's chosen representation).
 *
 * Customization, accuracy, and the public/private haptic behaviour live here, in
 * the overlay, so the canonical engine (index.html / app.js) stays untouched. The
 * overlay runs its OWN alert loop (reading window.voxGame.analyzer directly) rather
 * than the engine's energy-only rule loop, which lets it confidence-gate alerts and
 * play distinct, directional, intensity-scaled haptic patterns. Native haptics +
 * brightness come from the AndroidHaptics / AndroidScreen bridges.
 *
 * NOTE: the ball-canvas hue is driven inside app.js from pitch/resonance with no
 * public setter, so theming here colours the overlay chrome only, not the ball.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  if (params.get('watch') !== '1') return;
  if (window.__voxWatchBooted) return;
  window.__voxWatchBooted = true;

  var root = document.documentElement;
  root.classList.add('watch');

  // Pure helpers loaded by watch-haptics.cjs (classic <script> before this one).
  var VW = window.VoxWatch || null;

  function game() { return window.voxGame || null; }
  function startBtn() { return document.getElementById('startBtn'); }
  function isRunning() { var g = game(); return !!(g && g.isRunning); }
  function nowS() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }

  function nativeBrightness(low) {
    try {
      if (window.AndroidScreen && window.AndroidScreen.setLowBrightness) {
        window.AndroidScreen.setLowBrightness(!!low);
      }
    } catch (e) {}
  }

  // Fire a buzz, using the amplitude-aware native bridge when present (real watch),
  // otherwise the standard Vibration API (which no-ops harmlessly in a browser).
  function buzz(pattern, amplitude) {
    try {
      if (amplitude && navigator.vibrateAmp) navigator.vibrateAmp(pattern, amplitude);
      else if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) {}
  }

  function toggleMic() { var b = startBtn(); if (b) b.click(); }

  // ---- settings store ----------------------------------------------------

  var SETTINGS_KEY = 'voxWatch.settings';
  var DEFAULTS = VW ? VW.DEFAULT_SETTINGS : {
    mode: 'discreet', intensity: 'gentle', theme: 'aqua', brightness: 'auto',
    resonanceMethod: 'harmonic', pitchDisplayMode: 'hz', resonanceDisplayMode: 'percent',
    tuning: { pitchConfMin: 0.4, resConfMin: 0.4, farMic: false },
    rules: [
      { metric: 'pitch', direction: 'below', threshold: 150, enabled: true },
      { metric: 'pitch', direction: 'above', threshold: 250, enabled: true },
      { metric: 'resonance', direction: 'below', threshold: 30, enabled: true },
      { metric: 'resonance', direction: 'above', threshold: 70, enabled: true }
    ],
    alertsEnabled: true
  };

  var settings;
  function loadSettings() {
    var stored = null;
    try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch (e) {}
    settings = VW ? VW.mergeSettings(stored, DEFAULTS) : JSON.parse(JSON.stringify(DEFAULTS));
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  // ---- theme + brightness ------------------------------------------------

  var THEMES = {
    aqua:   { accent: '#34d6c8', soft: 'rgba(52,214,200,0.18)',  bg: '#06121a' },
    violet: { accent: '#c084fc', soft: 'rgba(192,132,252,0.18)', bg: '#120a1e' },
    amber:  { accent: '#ff8e53', soft: 'rgba(255,142,83,0.18)',  bg: '#1a0f08' },
    mono:   { accent: '#cfd2dc', soft: 'rgba(207,210,220,0.16)', bg: '#0a0a12' }
  };

  function applyTheme() {
    var th = THEMES[settings.theme] || THEMES.aqua;
    root.style.setProperty('--watch-accent', th.accent);
    root.style.setProperty('--watch-accent-soft', th.soft);
    root.style.setProperty('--watch-bg', th.bg);
    root.setAttribute('data-watch-theme', settings.theme);
  }

  function applyBrightness() {
    var low;
    if (settings.brightness === 'dim') low = true;
    else if (settings.brightness === 'bright') low = false;
    else low = (settings.mode === 'discreet'); // auto: dark for public/discreet
    nativeBrightness(low);
  }

  // Push the user's resonance method onto the engine once it exists.
  function applyEngineSettings() {
    var g = game();
    if (!g || !g.analyzer) return;
    if (g.analyzer.resonanceMethod !== settings.resonanceMethod) {
      setResonanceMethod(settings.resonanceMethod, true);
    }
  }

  // ---- public / private mode --------------------------------------------

  function setMode(mode) {
    settings.mode = (mode === 'practice') ? 'practice' : 'discreet';
    saveSettings();
    root.classList.toggle('mode-practice', settings.mode === 'practice');
    root.classList.toggle('mode-discreet', settings.mode === 'discreet');
    applyBrightness();
    refreshOpenUI();
  }

  // ---- alert loop (confidence-gated, directional haptics) ----------------

  var workingRules = [];
  var globalCdUntil = 0;
  var alertTimer = null;
  var prevEngineEnabled = null;
  var statusOverride = { text: '', until: 0 };

  function syncWorkingRules() {
    workingRules = settings.rules.map(function (r) {
      return {
        metric: r.metric, direction: r.direction, threshold: r.threshold,
        enabled: r.enabled, cdUntil: 0, tripped: false
      };
    });
  }

  // Ensure the default pitch/resonance range rules exist (additive — user rules kept).
  function seedWatchRules() {
    function ensure(metric, dir, threshold) {
      var has = settings.rules.some(function (r) { return r.metric === metric && r.direction === dir; });
      if (!has) settings.rules.push({ metric: metric, direction: dir, threshold: threshold, enabled: true });
    }
    ensure('pitch', 'below', 150);
    ensure('pitch', 'above', 250);
    ensure('resonance', 'below', 30);
    ensure('resonance', 'above', 70);
    saveSettings();
    syncWorkingRules();
  }

  function metricValue(a, metric) {
    var m = a.metrics || {};
    switch (metric) {
      case 'pitch': return a.smoothPitchHz;
      case 'resonance': return (a.smoothResonance || 0) * 100;
      case 'energy': return (m.energy || 0) * 100;
      case 'bounce': return (m.bounce || 0) * 100;
      case 'vowel': return (m.vowel || 0) * 100;
      case 'articulation': return (m.articulation || 0) * 100;
      default: return 0;
    }
  }

  function labelFor(metric, direction) {
    var map = {
      pitch_below: 'Pitch low ↑', pitch_above: 'Pitch high ↓',
      resonance_below: 'Brighter ↑', resonance_above: 'Softer ↓',
      energy_below: 'Louder ↑', energy_above: 'Softer ↓'
    };
    return map[metric + '_' + direction] || 'Adjust';
  }

  function flashRing() {
    var el = document.getElementById('watchFlash');
    if (!el) {
      el = document.createElement('div');
      el.id = 'watchFlash';
      el.className = 'watch-flash';
      document.body.appendChild(el);
    }
    el.classList.remove('show');
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
  }

  // Play the right buzz for a tripped metric+direction, scaled by mode + intensity.
  function fireAlert(metric, direction) {
    if (!VW) return;
    var pattern = VW.patternFor(metric, direction, settings.mode);
    var amp = VW.intensityToAmp(settings.intensity, settings.mode);
    buzz(pattern, amp);
    if (settings.mode === 'practice') {
      flashRing();
      statusOverride = { text: labelFor(metric, direction), until: nowS() + 1.2 };
    }
  }

  function evalAlerts() {
    var g = game();
    if (!g || !g.analyzer) { updateNecklaceStatus(); return; }
    if (!settings.alertsEnabled || !isRunning() || !VW) {
      workingRules.forEach(function (r) { r.tripped = false; });
      updateNecklaceStatus();
      return;
    }
    var a = g.analyzer;
    var conf = {
      reliable: a.wasLastFrameReliable === true,
      pitchConfidence: a.pitchConfidence || 0,
      formantConfidence: a.formantConfidence || 0,
      frameConfidence: a.frameConfidence || 0,
      energy: (a.metrics && a.metrics.energy) || 0
    };
    var t = nowS();
    for (var i = 0; i < workingRules.length; i++) {
      var r = workingRules[i];
      if (!r.enabled) { r.tripped = false; continue; }
      var val = metricValue(a, r.metric);
      var cond = r.direction === 'below' ? val < r.threshold : val > r.threshold;
      var gated = cond && VW.gatePasses(r.metric, conf, settings.tuning);
      r.tripped = gated;
      if (gated && t >= (r.cdUntil || 0) && t >= globalCdUntil) {
        fireAlert(r.metric, r.direction);
        r.cdUntil = t + 0.5;   // per-rule cooldown (mirrors engine)
        globalCdUntil = t + 0.25;
      }
    }
    updateNecklaceStatus();
  }

  function startWatchAlertLoop() {
    var g = game();
    if (g && g.vibration) { prevEngineEnabled = g.vibration.enabled; g.vibration.enabled = false; }
    syncWorkingRules();
    stopWatchAlertLoop();
    alertTimer = setInterval(evalAlerts, 120);
    evalAlerts();
  }
  function stopWatchAlertLoop() {
    if (alertTimer) { clearInterval(alertTimer); alertTimer = null; }
  }
  function restoreEngineAlerts() {
    var g = game();
    if (g && g.vibration && prevEngineEnabled !== null) { g.vibration.enabled = prevEngineEnabled; }
    prevEngineEnabled = null;
  }

  // ---- accuracy controls -------------------------------------------------

  function setResonanceMethod(method, skipSave) {
    settings.resonanceMethod = method;
    if (!skipSave) saveSettings();
    var g = game();
    if (g && g.analyzer) {
      g.analyzer.resonanceMethod = method;
      // Mirror the engine's own reset side-effects so the switch is clean.
      g.analyzer.smoothF1 = 500;
      g.analyzer.smoothF2 = 1500;
      g.analyzer.smoothF3 = 2700;
      g.analyzer.smoothResonance = 0.5;
      g.analyzer.formantConfidence = 0;
    }
  }

  function setFarMic(on) {
    var was = settings.tuning.farMic;
    settings.tuning.farMic = !!on;
    if (on && !was) {
      // Chest-mic = lower SNR: lift the confidence floors a touch and dim the screen.
      settings.tuning.pitchConfMin = Math.min(0.7, settings.tuning.pitchConfMin + 0.1);
      settings.tuning.resConfMin = Math.min(0.7, settings.tuning.resConfMin + 0.1);
      settings.brightness = 'dim';
    }
    saveSettings();
    applyBrightness();
  }

  function runCalibrate(btn) {
    var g = game();
    if (!g || !g.analyzer) return;
    if (!isRunning()) { btn.textContent = 'Start mic first'; return; }
    try {
      if (g.analyzer.resetCalibration) g.analyzer.resetCalibration();
      btn.textContent = 'Calibrating…';
      var done = function () {
        btn.textContent = 'Calibrated ✓';
        buzz([40, 30, 40], VW ? VW.intensityToAmp(settings.intensity, settings.mode) : 0);
      };
      if (g.calibrationWizard && g.calibrationWizard.run) {
        var p = g.calibrationWizard.run(g.analyzer);
        if (p && p.then) p.then(done, function () { btn.textContent = 'Calibrate'; });
        else done();
      } else { done(); }
    } catch (e) { btn.textContent = 'Calibrate'; }
  }

  // ---- launch chooser ----------------------------------------------------

  function buildChooser() {
    if (document.querySelector('.watch-start')) return;

    var overlay = document.createElement('div');
    overlay.className = 'watch-start';
    overlay.innerHTML =
      '<button class="watch-gear" id="watchGear" aria-label="Settings">⚙</button>' +
      '<div class="watch-start__ball" aria-hidden="true"></div>' +
      '<div class="watch-start__title">Vox Arcade</div>' +
      '<button class="watch-choice" id="watchChoiceBall">' +
        '<span class="watch-choice__icon" aria-hidden="true">●</span>' +
        '<span class="watch-choice__label">Vox Ball</span>' +
        '<span class="watch-choice__sub">Visual game</span>' +
      '</button>' +
      '<button class="watch-choice" id="watchChoiceNecklace">' +
        '<span class="watch-choice__icon" aria-hidden="true">📿</span>' +
        '<span class="watch-choice__label">Necklace</span>' +
        '<span class="watch-choice__sub">Eyes-free buzz</span>' +
      '</button>' +
      '<div class="watch-start__hint" id="watchStartHint"></div>';
    document.body.appendChild(overlay);

    overlay.querySelector('#watchGear').addEventListener('click', function (e) {
      e.stopPropagation();
      openSettings();
    });
    overlay.querySelector('#watchChoiceBall').addEventListener('click', function () {
      launchVoxBall(overlay);
    });
    overlay.querySelector('#watchChoiceNecklace').addEventListener('click', function () {
      overlay.classList.add('hide');
      enterNecklace();
    });
  }

  function launchVoxBall(overlay) {
    var b = startBtn();
    if (!b) return;
    nativeBrightness(false);
    b.click(); // default game mode = ball; this also satisfies the audio gesture
    applyEngineSettings();
    requestAnimationFrame(function () { window.dispatchEvent(new Event('resize')); });
    var waited = 0;
    var hint = overlay.querySelector('#watchStartHint');
    var poll = setInterval(function () {
      waited += 250;
      if (isRunning()) {
        clearInterval(poll);
        overlay.classList.add('hide');
        window.dispatchEvent(new Event('resize'));
      } else if (waited >= 4000) {
        clearInterval(poll);
        if (hint) { hint.textContent = 'Mic blocked — retry'; hint.classList.add('error'); }
      }
    }, 250);
  }

  // ---- necklace mode -----------------------------------------------------

  function enterNecklace() {
    root.classList.add('necklace-active');
    setMode(settings.mode || 'discreet');
    seedWatchRules();
    applyEngineSettings();
    buildNecklaceUI();
    startWatchAlertLoop();
  }

  function exitNecklace(ui) {
    if (isRunning()) toggleMic();        // release the mic on the way out
    stopWatchAlertLoop();
    restoreEngineAlerts();
    nativeBrightness(false);
    root.classList.remove('necklace-active');
    if (ui && ui.parentNode) ui.parentNode.removeChild(ui);
    var chooser = document.querySelector('.watch-start');
    if (chooser) chooser.classList.remove('hide');
  }

  function buildNecklaceUI() {
    if (document.querySelector('.necklace-ui')) return;

    var ui = document.createElement('div');
    ui.className = 'necklace-ui';
    ui.innerHTML =
      '<button class="necklace-exit" id="necklaceExit" aria-label="Back">‹</button>' +
      '<button class="necklace-toggle" id="necklaceToggle" aria-pressed="false">' +
        '<span class="necklace-dot" id="necklaceDot"></span>' +
        '<span class="necklace-toggle__label" id="necklaceLabel">Tap to listen</span>' +
      '</button>' +
      '<div class="necklace-readout" id="necklaceReadout" aria-hidden="true">' +
        '<span class="necklace-readout__metric" id="roPitch"><b>—</b><i>pitch</i></span>' +
        '<span class="necklace-readout__metric" id="roRes"><b>—</b><i>resonance</i></span>' +
      '</div>' +
      '<div class="necklace-modechip" id="necklaceModeChip" role="group" aria-label="Mode">' +
        '<button class="necklace-modechip__opt" data-mode="discreet">Discreet</button>' +
        '<button class="necklace-modechip__opt" data-mode="practice">Practice</button>' +
      '</div>' +
      '<button class="necklace-alerts" id="necklaceAlerts">⚙ Settings</button>';
    document.body.appendChild(ui);

    ui.querySelector('#necklaceToggle').addEventListener('click', function () {
      var wasRunning = isRunning();
      toggleMic();
      if (!wasRunning) applyEngineSettings();
      // Distinct confirmation: one pulse to start, two to stop.
      buzz(wasRunning ? [55, 45, 55] : [90], VW ? VW.intensityToAmp(settings.intensity, settings.mode) : 0);
    });
    ui.querySelector('#necklaceExit').addEventListener('click', function () {
      exitNecklace(ui);
    });
    ui.querySelector('#necklaceAlerts').addEventListener('click', function () {
      openSettings();
    });
    ui.querySelector('#necklaceModeChip').addEventListener('click', function (e) {
      var opt = e.target.closest('.necklace-modechip__opt');
      if (opt) setMode(opt.getAttribute('data-mode'));
    });
    updateModeChip();
  }

  function updateModeChip() {
    var chip = document.getElementById('necklaceModeChip');
    if (!chip) return;
    chip.querySelectorAll('.necklace-modechip__opt').forEach(function (o) {
      o.setAttribute('aria-checked', o.getAttribute('data-mode') === settings.mode ? 'true' : 'false');
    });
  }

  function updateNecklaceStatus() {
    var dot = document.getElementById('necklaceDot');
    var label = document.getElementById('necklaceLabel');
    var toggle = document.getElementById('necklaceToggle');
    if (!dot || !label) return;

    var running = isRunning();
    var tripped = running && settings.alertsEnabled &&
      workingRules.some(function (r) { return r.enabled && r.tripped; });

    dot.classList.toggle('on', running && !tripped);
    dot.classList.toggle('alert', !!tripped);

    if (!running) {
      label.textContent = 'Tap to listen';
    } else if (settings.mode === 'practice' && statusOverride.text && nowS() < statusOverride.until) {
      label.textContent = statusOverride.text;
    } else {
      label.textContent = tripped ? 'Adjust voice' : 'Listening';
    }
    if (toggle) toggle.setAttribute('aria-pressed', running ? 'true' : 'false');
    updateReadout(running);
  }

  // Live pitch + resonance readout so the user can *see* both metrics being measured
  // (proving resonance tracks, not just buzzes), shown in the representation they chose.
  function updateReadout(running) {
    var ro = document.getElementById('necklaceReadout');
    if (!ro || !VW) return;
    var g = game();
    var a = g && g.analyzer;
    if (!running || !a) { ro.classList.remove('show'); return; }
    ro.classList.add('show');

    var energy = (a.metrics && a.metrics.energy) || 0;
    var speaking = energy > 0.05 && a.wasLastFrameReliable === true;

    // Pitch: representation honours pitchDisplayMode; 'range' is relative to the
    // centre of the active pitch band (between the min/max rules) when both exist.
    var pHz = a.smoothPitchHz || 0;
    var pConfOk = speaking && (a.pitchConfidence || 0) >= settings.tuning.pitchConfMin;
    var lo = getRule('pitch', 'below'), hi = getRule('pitch', 'above');
    var refHz = (lo && hi) ? Math.sqrt(lo.threshold * hi.threshold)
              : (lo ? lo.threshold : (hi ? hi.threshold : 0));
    var pState = VW.readoutMetric(pHz, pConfOk, lo, hi);
    setMetricEl('roPitch', VW.formatPitch(pHz, settings.pitchDisplayMode, refHz), pState.state);

    // Resonance: 0–100 brightness score, or raw F1/F2 — same value the alerts act on.
    var rPct = (a.smoothResonance || 0) * 100;
    var rConfOk = speaking && (a.formantConfidence || 0) >= settings.tuning.resConfMin;
    var rState = VW.readoutMetric(rPct, rConfOk, getRule('resonance', 'below'), getRule('resonance', 'above'));
    setMetricEl('roRes', VW.formatResonance(rPct, a.smoothF1, a.smoothF2, settings.resonanceDisplayMode), rState.state);
  }

  function setMetricEl(id, text, state) {
    var el = document.getElementById(id);
    if (!el) return;
    var b = el.querySelector('b');
    if (b) b.textContent = text;
    el.classList.remove('weak', 'low', 'high', 'ok');
    el.classList.add(state || 'ok');
  }

  // ---- native settings screen -------------------------------------------

  function seg(name, options, current) {
    return '<div class="watch-seg" data-seg="' + name + '">' +
      options.map(function (o) {
        return '<button class="watch-seg__opt" data-seg-val="' + o.v + '" aria-checked="' +
          (o.v === current ? 'true' : 'false') + '">' + o.label + '</button>';
      }).join('') + '</div>';
  }

  function getRule(metric, direction) {
    return settings.rules.filter(function (r) { return r.metric === metric && r.direction === direction; })[0];
  }

  function stepperRow(labelTxt, metric, direction, step) {
    var r = getRule(metric, direction);
    var val = r ? r.threshold : 0;
    var on = r ? r.enabled : false;
    return '<div class="watch-row">' +
      '<span class="watch-row__label">' + labelTxt + '</span>' +
      '<div class="watch-step" data-metric="' + metric + '" data-dir="' + direction + '" data-step="' + step + '">' +
        '<button class="watch-step__btn" data-delta="-1" aria-label="Lower">−</button>' +
        '<span class="watch-step__val">' + val + '</span>' +
        '<button class="watch-step__btn" data-delta="1" aria-label="Raise">+</button>' +
      '</div>' +
      '<button class="watch-toggle' + (on ? ' on' : '') + '" data-rule-toggle="' + metric + '|' + direction + '" aria-pressed="' + on + '">' +
        (on ? 'On' : 'Off') + '</button>' +
    '</div>';
  }

  function buildSettings() {
    var el = document.createElement('div');
    el.className = 'watch-settings';
    el.innerHTML =
      '<div class="watch-settings__inner">' +
        '<div class="watch-settings__head">' +
          '<button class="watch-settings__back" id="setBack">‹ Done</button>' +
          '<span class="watch-settings__title">Settings</span>' +
        '</div>' +

        '<div class="watch-card"><div class="watch-card__h">Mode</div>' +
          seg('mode', [{ v: 'discreet', label: 'Discreet' }, { v: 'practice', label: 'Practice' }], settings.mode) +
          '<div class="watch-card__hint">Discreet = gentle single tap, dark screen. Practice = stronger directional buzz + flash.</div>' +
        '</div>' +

        '<div class="watch-card"><div class="watch-card__h">Haptics</div>' +
          seg('intensity', [{ v: 'gentle', label: 'Gentle' }, { v: 'medium', label: 'Medium' }, { v: 'strong', label: 'Strong' }], settings.intensity) +
          '<div class="watch-row">' +
            '<span class="watch-row__label">Alerts</span>' +
            '<button class="watch-toggle' + (settings.alertsEnabled ? ' on' : '') + '" id="alertsToggle" aria-pressed="' + settings.alertsEnabled + '">' + (settings.alertsEnabled ? 'On' : 'Off') + '</button>' +
          '</div>' +
          '<div class="watch-card__h2">Feel each cue</div>' +
          '<div class="watch-testgrid">' +
            '<button class="watch-test" data-test="pitch|below">Pitch low</button>' +
            '<button class="watch-test" data-test="pitch|above">Pitch high</button>' +
            '<button class="watch-test" data-test="resonance|below">Res dark</button>' +
            '<button class="watch-test" data-test="resonance|above">Res bright</button>' +
          '</div>' +
        '</div>' +

        '<div class="watch-card"><div class="watch-card__h">Alerts &amp; ranges</div>' +
          stepperRow('Pitch min (Hz)', 'pitch', 'below', 5) +
          stepperRow('Pitch max (Hz)', 'pitch', 'above', 5) +
          stepperRow('Res min (%)', 'resonance', 'below', 5) +
          stepperRow('Res max (%)', 'resonance', 'above', 5) +
        '</div>' +

        '<div class="watch-card"><div class="watch-card__h">Readout</div>' +
          '<div class="watch-card__h2">Pitch as</div>' +
          seg('pitchDisplayMode', [{ v: 'hz', label: 'Hz' }, { v: 'note', label: 'Note' }, { v: 'range', label: 'St' }], settings.pitchDisplayMode) +
          '<div class="watch-card__h2">Resonance as</div>' +
          seg('resonanceDisplayMode', [{ v: 'percent', label: '%' }, { v: 'formants', label: 'F1/F2' }], settings.resonanceDisplayMode) +
          '<div class="watch-card__hint">How the live numbers read. Range (St) = semitones from your pitch band centre; F1/F2 = raw formants (Hz).</div>' +
        '</div>' +

        '<div class="watch-card"><div class="watch-card__h">Appearance</div>' +
          '<div class="watch-card__h2">Accent</div>' +
          seg('theme', [{ v: 'aqua', label: 'Aqua' }, { v: 'violet', label: 'Violet' }, { v: 'amber', label: 'Amber' }, { v: 'mono', label: 'Mono' }], settings.theme) +
          '<div class="watch-card__h2">Brightness</div>' +
          seg('brightness', [{ v: 'auto', label: 'Auto' }, { v: 'dim', label: 'Dim' }, { v: 'bright', label: 'Bright' }], settings.brightness) +
        '</div>' +

        '<div class="watch-card"><div class="watch-card__h">Accuracy</div>' +
          '<div class="watch-card__h2">Resonance method</div>' +
          seg('resonanceMethod', [{ v: 'harmonic', label: 'Harm' }, { v: 'cepstral', label: 'Ceps' }, { v: 'lpc', label: 'LPC' }, { v: 'centroid', label: 'Cent' }], settings.resonanceMethod) +
          '<div class="watch-row">' +
            '<span class="watch-row__label">Pitch confidence</span>' +
            '<input class="watch-slider" id="pitchConf" type="range" min="0.2" max="0.7" step="0.05" value="' + settings.tuning.pitchConfMin + '">' +
          '</div>' +
          '<div class="watch-row">' +
            '<span class="watch-row__label">Res confidence</span>' +
            '<input class="watch-slider" id="resConf" type="range" min="0.2" max="0.7" step="0.05" value="' + settings.tuning.resConfMin + '">' +
          '</div>' +
          '<div class="watch-row">' +
            '<span class="watch-row__label">Far-mic (necklace)</span>' +
            '<button class="watch-toggle' + (settings.tuning.farMic ? ' on' : '') + '" id="farMicToggle" aria-pressed="' + settings.tuning.farMic + '">' + (settings.tuning.farMic ? 'On' : 'Off') + '</button>' +
          '</div>' +
          '<button class="watch-btn" id="calibrateBtn">Calibrate</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    wireSettings(el);
  }

  function wireSettings(el) {
    el.querySelector('#setBack').addEventListener('click', closeSettings);

    // Segmented controls.
    el.addEventListener('click', function (e) {
      var opt = e.target.closest('.watch-seg__opt');
      if (!opt) return;
      var group = opt.closest('.watch-seg');
      var name = group.getAttribute('data-seg');
      var val = opt.getAttribute('data-seg-val');
      group.querySelectorAll('.watch-seg__opt').forEach(function (o) {
        o.setAttribute('aria-checked', o === opt ? 'true' : 'false');
      });
      onSegChange(name, val);
    });

    // Threshold steppers.
    el.addEventListener('click', function (e) {
      var btn = e.target.closest('.watch-step__btn');
      if (!btn) return;
      var step = btn.closest('.watch-step');
      var metric = step.getAttribute('data-metric');
      var dir = step.getAttribute('data-dir');
      var delta = parseInt(btn.getAttribute('data-delta'), 10) * parseInt(step.getAttribute('data-step'), 10);
      var rule = getRule(metric, dir);
      if (!rule) return;
      var max = metric === 'resonance' ? 100 : 400;
      var min = metric === 'resonance' ? 0 : 50;
      rule.threshold = Math.max(min, Math.min(max, rule.threshold + delta));
      step.querySelector('.watch-step__val').textContent = rule.threshold;
      saveSettings();
      syncWorkingRules();
    });

    // Per-rule enable toggles.
    el.addEventListener('click', function (e) {
      var t = e.target.closest('[data-rule-toggle]');
      if (!t) return;
      var parts = t.getAttribute('data-rule-toggle').split('|');
      var rule = getRule(parts[0], parts[1]);
      if (!rule) return;
      rule.enabled = !rule.enabled;
      t.classList.toggle('on', rule.enabled);
      t.setAttribute('aria-pressed', rule.enabled);
      t.textContent = rule.enabled ? 'On' : 'Off';
      saveSettings();
      syncWorkingRules();
    });

    // Master alerts toggle.
    var at = el.querySelector('#alertsToggle');
    at.addEventListener('click', function () {
      settings.alertsEnabled = !settings.alertsEnabled;
      at.classList.toggle('on', settings.alertsEnabled);
      at.setAttribute('aria-pressed', settings.alertsEnabled);
      at.textContent = settings.alertsEnabled ? 'On' : 'Off';
      saveSettings();
    });

    // Test buttons — feel each directional cue (always in practice flavour so the
    // contour is obvious), honouring the current intensity.
    el.querySelectorAll('.watch-test').forEach(function (b) {
      b.addEventListener('click', function () {
        var parts = b.getAttribute('data-test').split('|');
        if (!VW) return;
        var pattern = VW.patternFor(parts[0], parts[1], 'practice');
        buzz(pattern, VW.intensityToAmp(settings.intensity, 'practice'));
      });
    });

    // Confidence sliders.
    var pc = el.querySelector('#pitchConf');
    pc.addEventListener('input', function () {
      settings.tuning.pitchConfMin = parseFloat(pc.value); saveSettings();
    });
    var rc = el.querySelector('#resConf');
    rc.addEventListener('input', function () {
      settings.tuning.resConfMin = parseFloat(rc.value); saveSettings();
    });

    // Far-mic preset.
    var fm = el.querySelector('#farMicToggle');
    fm.addEventListener('click', function () {
      setFarMic(!settings.tuning.farMic);
      fm.classList.toggle('on', settings.tuning.farMic);
      fm.setAttribute('aria-pressed', settings.tuning.farMic);
      fm.textContent = settings.tuning.farMic ? 'On' : 'Off';
      // Reflect any floor/brightness changes the preset made.
      pc.value = settings.tuning.pitchConfMin;
      rc.value = settings.tuning.resConfMin;
      syncSeg(el, 'brightness', settings.brightness);
    });

    // Calibrate.
    el.querySelector('#calibrateBtn').addEventListener('click', function () {
      runCalibrate(this);
    });
  }

  function onSegChange(name, val) {
    if (name === 'mode') { setMode(val); return; }
    if (name === 'intensity') { settings.intensity = val; saveSettings(); return; }
    if (name === 'theme') { settings.theme = val; saveSettings(); applyTheme(); return; }
    if (name === 'brightness') { settings.brightness = val; saveSettings(); applyBrightness(); return; }
    if (name === 'resonanceMethod') { setResonanceMethod(val); return; }
    if (name === 'pitchDisplayMode') { settings.pitchDisplayMode = val; saveSettings(); updateReadout(isRunning()); return; }
    if (name === 'resonanceDisplayMode') { settings.resonanceDisplayMode = val; saveSettings(); updateReadout(isRunning()); return; }
  }

  function syncSeg(scope, name, val) {
    var group = scope.querySelector('.watch-seg[data-seg="' + name + '"]');
    if (!group) return;
    group.querySelectorAll('.watch-seg__opt').forEach(function (o) {
      o.setAttribute('aria-checked', o.getAttribute('data-seg-val') === val ? 'true' : 'false');
    });
  }

  function openSettings() {
    if (document.querySelector('.watch-settings')) return;
    buildSettings();
  }
  function closeSettings() {
    var el = document.querySelector('.watch-settings');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function refreshOpenUI() {
    updateModeChip();
    var s = document.querySelector('.watch-settings');
    if (s) syncSeg(s, 'mode', settings.mode);
    updateNecklaceStatus();
  }

  // ---- init --------------------------------------------------------------

  function init() {
    loadSettings();
    applyTheme();
    root.classList.add(settings.mode === 'practice' ? 'mode-practice' : 'mode-discreet');
    buildChooser();
  }
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
