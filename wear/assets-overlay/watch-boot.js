/*
 * Watch boot layer for ProsodyBall on Wear OS.
 *
 * Injected by MainActivity after index.html finishes loading (and only there —
 * it no-ops without ?watch=1). It:
 *   1. flags <html> with `watch` so watch.css applies the wrist layout,
 *   2. shows a big "Tap to start" overlay sized for a round screen,
 *   3. on tap, clicks the existing #startBtn to launch Vox Ball (default mode),
 *      which also satisfies the AudioContext/getUserMedia user-gesture requirement.
 *
 * The existing engine (app.js) is reused unchanged.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  if (params.get('watch') !== '1') return;
  if (window.__voxWatchBooted) return;
  window.__voxWatchBooted = true;

  var root = document.documentElement;
  root.classList.add('watch');

  function build() {
    if (document.querySelector('.watch-start')) return;

    var overlay = document.createElement('div');
    overlay.className = 'watch-start';
    overlay.setAttribute('role', 'button');
    overlay.setAttribute('tabindex', '0');
    overlay.innerHTML =
      '<div class="watch-start__ball" aria-hidden="true"></div>' +
      '<div class="watch-start__title">Vox Ball</div>' +
      '<div class="watch-start__hint">Tap to start</div>';
    document.body.appendChild(overlay);

    var hint = overlay.querySelector('.watch-start__hint');
    var started = false;

    function launch() {
      if (started) return;
      var startBtn = document.getElementById('startBtn');
      if (!startBtn) {
        hint.textContent = 'Still loading…';
        return;
      }
      started = true;
      hint.classList.remove('error');
      hint.textContent = 'Listening…';

      // Real user gesture → click the app's Start button (default mode = ball).
      startBtn.click();

      // Force the canvas to re-measure against the now full-screen layout.
      requestAnimationFrame(function () {
        window.dispatchEvent(new Event('resize'));
      });

      var waited = 0;
      var poll = setInterval(function () {
        waited += 250;
        var app = document.getElementById('app');
        if (app && app.classList.contains('playing')) {
          clearInterval(poll);
          overlay.classList.add('hide');
          window.dispatchEvent(new Event('resize'));
        } else if (waited >= 4000) {
          // Session never started — most likely the mic was blocked.
          clearInterval(poll);
          started = false;
          hint.classList.add('error');
          hint.textContent = 'Mic blocked — tap to retry';
        }
      }, 250);
    }

    overlay.addEventListener('click', launch);
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') launch();
    });
  }

  if (document.body) {
    build();
  } else {
    document.addEventListener('DOMContentLoaded', build, { once: true });
  }
})();
