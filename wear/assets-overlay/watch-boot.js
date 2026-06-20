/*
 * Watch boot layer for ProsodyBall on Wear OS.
 *
 * Injected by MainActivity after index.html loads (and only with ?watch=1). It:
 *   1. flags <html> with `watch` so watch.css applies the wrist layout,
 *   2. shows a launch chooser: Vox Ball (visual) or Necklace (eyes-free),
 *   3. Vox Ball  -> launches the flagship visual mode (default game mode),
 *   4. Necklace  -> a dark, eyes-free haptic-biofeedback mode for wearing the
 *      watch as a pendant near the mouth: big Start/Stop mic toggle, strong
 *      vibration when a chosen metric (pitch / resonance) drifts out of range.
 *
 * The biofeedback itself is the existing engine's vibration rule system
 * (window.voxGame.vibration). Native haptics + brightness come from the
 * AndroidHaptics / AndroidScreen bridges. app.js is reused unchanged apart from
 * the additive window.voxGame export.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  if (params.get('watch') !== '1') return;
  if (window.__voxWatchBooted) return;
  window.__voxWatchBooted = true;

  var root = document.documentElement;
  root.classList.add('watch');

  function game() { return window.voxGame || null; }
  function startBtn() { return document.getElementById('startBtn'); }
  function isRunning() { var g = game(); return !!(g && g.isRunning); }

  function nativeBrightness(low) {
    try {
      if (window.AndroidScreen && window.AndroidScreen.setLowBrightness) {
        window.AndroidScreen.setLowBrightness(!!low);
      }
    } catch (e) {}
  }

  function buzz(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
  }

  // Toggle the mic by clicking the app's Start/Stop button. Returns the new
  // running state (best-effort; the click is async but state flips synchronously
  // for stop and after getUserMedia resolves for start).
  function toggleMic() {
    var b = startBtn();
    if (b) b.click();
  }

  // ---- launch chooser ----------------------------------------------------

  function buildChooser() {
    if (document.querySelector('.watch-start')) return;

    var overlay = document.createElement('div');
    overlay.className = 'watch-start';
    overlay.innerHTML =
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
      '</button>';
    document.body.appendChild(overlay);

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
    requestAnimationFrame(function () { window.dispatchEvent(new Event('resize')); });
    var waited = 0;
    var poll = setInterval(function () {
      waited += 250;
      if (isRunning()) {
        clearInterval(poll);
        overlay.classList.add('hide');
        window.dispatchEvent(new Event('resize'));
      } else if (waited >= 4000) {
        clearInterval(poll);
        var hint = overlay.querySelector('.watch-start__title');
        if (hint) hint.textContent = 'Mic blocked — retry';
      }
    }, 250);
  }

  // ---- necklace mode -----------------------------------------------------

  // Seed pitch + resonance "range" rules (a below + an above bound each) and turn
  // the master alert toggle on, reusing the engine's own rule system. Existing
  // rules are left intact so the user's own thresholds survive.
  function seedNecklaceRules() {
    var g = game();
    if (!g || !g.vibration) return;
    var vib = g.vibration;
    function ensure(metric, dir, threshold) {
      var exists = vib.rules.some(function (r) {
        return r.metric === metric && r.direction === dir;
      });
      if (exists) return;
      vib.rules.push({
        id: vib.nextId++, metric: metric, direction: dir,
        threshold: threshold, enabled: true, cooldownTimer: 0, tripped: false
      });
    }
    ensure('pitch', 'below', 150);
    ensure('pitch', 'above', 250);
    ensure('resonance', 'below', 30);
    ensure('resonance', 'above', 70);
    vib.enabled = true;

    var mt = document.getElementById('vibMasterToggle');
    if (mt) mt.checked = true;
    var vb = document.getElementById('vibBtn');
    if (vb) vb.classList.add('active');
    if (g._renderVibRules) g._renderVibRules();
  }

  var necklaceStatusTimer = null;

  function enterNecklace() {
    root.classList.add('necklace-active');
    nativeBrightness(true);
    seedNecklaceRules();
    buildNecklaceUI();
    startNecklaceStatus();
  }

  function exitNecklace(ui) {
    if (isRunning()) toggleMic();        // release the mic on the way out
    nativeBrightness(false);
    stopNecklaceStatus();
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
      '<button class="necklace-alerts" id="necklaceAlerts">⚙ Alerts</button>';
    document.body.appendChild(ui);

    ui.querySelector('#necklaceToggle').addEventListener('click', function () {
      var wasRunning = isRunning();
      toggleMic();
      // Distinct confirmation: one pulse to start, two to stop.
      buzz(wasRunning ? [55, 45, 55] : 90);
    });
    ui.querySelector('#necklaceExit').addEventListener('click', function () {
      exitNecklace(ui);
    });
    ui.querySelector('#necklaceAlerts').addEventListener('click', function () {
      // Open the engine's own vibration-rules panel to adjust metrics/ranges.
      var vb = document.getElementById('vibBtn');
      if (vb) vb.click();
    });
  }

  function startNecklaceStatus() {
    stopNecklaceStatus();
    necklaceStatusTimer = setInterval(updateNecklaceStatus, 200);
    updateNecklaceStatus();
  }
  function stopNecklaceStatus() {
    if (necklaceStatusTimer) { clearInterval(necklaceStatusTimer); necklaceStatusTimer = null; }
  }

  function updateNecklaceStatus() {
    var dot = document.getElementById('necklaceDot');
    var label = document.getElementById('necklaceLabel');
    var toggle = document.getElementById('necklaceToggle');
    if (!dot || !label) return;

    var running = isRunning();
    var g = game();
    var vib = g && g.vibration;
    var tripped = running && vib && vib.enabled && vib.rules.some(function (r) {
      return r.enabled && r.tripped;
    });

    dot.classList.toggle('on', running && !tripped);
    dot.classList.toggle('alert', !!tripped);
    label.textContent = running ? (tripped ? 'Adjust voice' : 'Listening') : 'Tap to listen';
    if (toggle) toggle.setAttribute('aria-pressed', running ? 'true' : 'false');
  }

  // ---- init --------------------------------------------------------------

  function init() { buildChooser(); }
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
