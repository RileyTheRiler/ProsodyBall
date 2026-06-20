import { computeProsodyScore, pitchHzToPosition, getMicDiagnostics, ensureAudioContextRunning, clamp01, normalizeAgainstRange, genderScoreToHue, computeGenderScoreMulti, computeSibilantFemininity, FEMINIZATION_CUE_WEIGHTS, MASCULINIZATION_CUE_WEIGHTS } from "./dsp-utils.js";
import { PerformanceMonitor } from './performance-monitor.js';
import { CalibrationWizard } from './calibration-wizard.js';
import { BulbController } from './bulb-controller.js';
import { NecklaceController, HapticSrc } from './necklace-controller.js';
import { VoiceAnalyzer, H1H2_HEAVY_DB, H1H2_LIGHT_DB } from "./voice-analyzer.js";

// Re-export so existing importers of VoiceAnalyzer from app.js keep working.
export { VoiceAnalyzer };

function escapeHtml(text) {
  if (!text) return text;
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Rendering constant (game-side; not part of the DSP pipeline).
const MAX_SPARKLES = 100;                // Maximum sparkle particles in ball mode


// ============================================================
// PARTICLE — uses RGB for proper alpha rendering
// ============================================================
class Particle {
  constructor(x, y, r, g, b, vx, vy, life, size) {
    this.x = x; this.y = y;
    this.r = r; this.g = g; this.b = b;
    this.vx = vx; this.vy = vy;
    this.life = life; this.maxLife = life;
    this.size = size;
  }
  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vy += 120 * dt;
    this.life -= dt;
  }
  draw(ctx) {
    const alpha = Math.max(0, this.life / this.maxLife) * 0.8;
    ctx.fillStyle = `rgba(${this.r},${this.g},${this.b},${alpha})`;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size * (this.life / this.maxLife), 0, Math.PI * 2);
    ctx.fill();
  }
}

// ============================================================
// MAIN GAME
// ============================================================
class VoxBallGame {
  constructor() {
    this.canvas = document.getElementById('gameCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.analyzer = new VoiceAnalyzer();
    this.isRunning = false;
    this._isStarting = false; // guard for startGame/stopGame race
    this.lastTime = 0;
    this.idleAnimId = null;
    this._disposables = []; // cleanup callbacks for listeners/observers
    this._pendingTimeouts = []; // track setTimeout IDs for cleanup

    // FIX: Store ball color as HSL components for proper HSLA compositing
    this.ballHue = 275;
    this.ballSat = 70;
    this.ballLit = 55;

    this.ball = {
      x: 0, y: 0, vy: 0,
      radius: 22, baseRadius: 22, targetRadius: 22,
      rotation: 0, squash: 1, onGround: true
    };

    this.groundY = 0;
    this.scrollX = 0;
    this.scrollSpeed = 120;
    this.targetScrollSpeed = 120;
    this.cameraY = 0;       // current camera vertical offset (negative = looking up)
    this.targetCameraY = 0; // smooth target
    this.cameraZoom = 1.4;  // current zoom level
    this.targetZoom = 1.4;  // target zoom (computed from ball height)
    this.userZoomMultiplier = 1; // manual zoom in/out, applied on top of the dynamic zoom
    this.prosodyScore = 0;  // smoothed composite prosody signal (0=monotone, 1=expressive)
    this.particles = [];
    this.trailPoints = [];
    this.sparkles = [];
    this.themeMode = 'highcontrast';
    this.colorblindMode = false;
    // Orb color mode: 'pitch' (hue from F0) or 'gender' (hue from perceived vocal gender).
    this.colorMode = localStorage.getItem('vox:colorMode') || 'pitch';
    this.dafEnabled = localStorage.getItem('vox:daf:enabled') === 'true';
    this.dafDelayMs = parseInt(localStorage.getItem('vox:daf:delayMs') || '75');
    // Default OFF so DAF plays back the full raw voice band instead of cutting bass.
    this.dafBassFilter = localStorage.getItem('vox:daf:bassFilter') === 'true';
    this._dafBuffer = [];
    this._dafNextPlayTime = 0;
    this._dafInterval = null;
    this._dafGain = null;
    this._dafFilter = null;
    this.smoothGenderScore = 0.5; // EMA of the 0..1 perceived-gender score (0.5 = androgynous)
    this.genderUncertainty = 1;   // 0..1 spread/disagreement of the gender cues
    // Per-cue toggles for the perceived-gender model. pitch + resonance are always on (the
    // original baseline); these are user-toggleable. Intonation is a sociolinguistic stereotype
    // (not anatomy) so it defaults OFF.
    const cueOn = (key, dflt) => {
      const v = localStorage.getItem(key);
      return v == null ? dflt : v === 'true';
    };
    this.genderCues = {
      // pitchZone, resonance always on; weight defaults on (source-only, reliable).
      weight: cueOn('vox:genderCue:weight', true),
      sibilant: cueOn('vox:genderCue:sibilant', true),
      intonation: cueOn('vox:genderCue:intonation', false),
      // Legacy keys preserved so stored user prefs are not silently lost.
      modalF0: cueOn('vox:genderCue:modalF0', true),
      dispersion: cueOn('vox:genderCue:dispersion', true),
      cpp: cueOn('vox:genderCue:cpp', true),
    };
    // Goal direction: 'feminization' | 'masculinization'. Determines cue weights and
    // incongruence-guard direction. Defaults to feminization.
    const storedGoal = localStorage.getItem('vox:goalMode');
    this.goalMode = storedGoal === 'masculinization' ? 'masculinization' : 'feminization';
    this.gameMode = 'ball';

    // Recording — AnalyserNode polling approach
    this.isRecording = false;
    this._recInterval = null;
    this._recBuffers = [];
    this._recSampleRate = 48000;
    this.recordings = []; // { blob, dataUrl, duration, timestamp, name }
    this.recordingStartTime = 0;
    this.currentPlayback = null;

    // Procedural infinite terrain — layered sine waves, no finite array
    this.terrainLayers = [];
    for (let i = 0; i < 5; i++) {
      this.terrainLayers.push({
        amplitude: 10 + Math.random() * 25,
        frequency: 0.002 + Math.random() * 0.005,
        phase: Math.random() * Math.PI * 2
      });
    }

    this.stars = [];

    // ====== VIBRATION ALERT STATE ======
    this.vibration = {
      enabled: false,
      rules: [],
      nextId: 1,
      shakeTimer: 0,
      hasHaptic: typeof navigator !== 'undefined' && 'vibrate' in navigator,
      globalCooldown: 0,
      flashAlpha: 0,       // on-canvas alert flash opacity
      flashMetric: '',     // which metric tripped (for display)
    };

    // ====== SESSION STATS ======
    this.session = {
      startTime: 0,
      duration: 0,
      pitchSum: 0,
      pitchCount: 0,
      pitchMin: Infinity,
      pitchMax: 0,
      resonanceSum: 0,
      resonanceCount: 0,
      prosodyHistory: [],  // sampled every ~0.5s for sparkline
      prosodySampleTimer: 0,
      scrollAtStart: 0,
    };

    // ====== ACCESSIBILITY ======
    this.userMotionPreference = localStorage.getItem('vox:motionPreference') || 'auto';
    this.micInputPreferences = {
      deviceId: localStorage.getItem('vox:micDeviceId') || 'default',
      // Default OFF: phones route echo cancellation / noise suppression / AGC through a
      // telephony-style voice processing pipeline that band-limits the signal (cutting
      // both low and high frequencies), which is what makes captured/played-back voice
      // sound duller and "deeper" than the raw mic input.
      echoCancellation: localStorage.getItem('vox:echoCancellation') === 'true',
      noiseSuppression: localStorage.getItem('vox:noiseSuppression') === 'true',
      autoGainControl: localStorage.getItem('vox:autoGainControl') === 'true',
    };
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.baseParticleScale = 1;
    this.particleScale = 1;
    this.dynamicQualityScale = 1;
    this._applyMotionPreferences();
    const motionMql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotionChange = (e) => {
      this.reducedMotion = e.matches;
      this._applyMotionPreferences();
    };
    motionMql.addEventListener('change', onMotionChange);
    this._disposables.push(() => motionMql.removeEventListener('change', onMotionChange));

    // ====== RUNTIME TOOLS ======
    this.perfMonitor = new PerformanceMonitor({ panelId: 'perfPanel' });
    this.calibrationWizard = new CalibrationWizard();
    this.bulbController = new BulbController({ swatchId: 'bulbSimSwatch', statusId: 'bulbStatus' });
    this.necklaceController = new NecklaceController({ onStatus: (s) => this._onNecklaceStatus(s) });
    this.hasCompletedCalibration = false;
    this.guidedStartTs = 0;
    this.guidedDurationSec = 5;
    this.guidedDismissed = false;
    this.guidedCloseHitbox = null;
    this.guidedPitchStable = 0;
    this.guidedChecklist = {
      roomReady: false,
      voiceDetected: false,
      pitchLocked: false,
    };
    this.pitchGridStrength = 'strong';
    this.teleprompterMode = 'off';
    this.voiceProfilePreset = 'auto';
    this.teleprompterCustomText = '';
    this.teleprompterRainbowText = (`When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. ` +
      `The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, ` +
      `with its path high above, and its two ends apparently beyond the horizon. There is, according to legend, a boiling pot of gold at one end.`);

    this.teleprompterIndex = 0;
    this.teleprompterSentenceIndex = 0; // current sentence for manual (Space/Tap) advance
    this.metricHighlightTimers = { bounce: 0, tempo: 0, vowel: 0, articulation: 0, syllable: 0 };
    this.metricExtremeLatch = { bounce: false, tempo: false, vowel: false, articulation: false, syllable: false };

    // ====== EXPANDED METRICS STATE ======
    this.metersExpanded = false;
    this.metricPopupOpen = null; // null or metric key string
    this._metricHistoryMax = 120; // ~2 seconds at 60fps (default)
    this._metricHistoryMaxLong = 600; // ~10 seconds at 60fps (pitch, bounce)
    this._metricHistory = {
      pitch: [],       // raw Hz values
      resonance: [],   // 0-1 resonance score
      bounce: [],      // 0-1
      vowels: [],      // 0-1
      attack: [],      // 0-1 onset hardness
      weight: [],      // 0-1 perceived heaviness
    };
    this._vowelPlotPoints = []; // {x, y} for F1/F2 scatter
    this._vowelPlotMax = 80;
    // Vocal-attack orb animation: condenses gas→solid on each onset at a speed set by the
    // measured onset hardness, then evaporates. (Weight orb reads m.weight directly.)
    this._attackOrb = { solidity: 0, prevAttack: 0, hardness: 0, lastT: 0 };

    // ====== WINDOWED-AVERAGE READOUTS ======
    // Numeric readouts for pitch/resonance/attack/weight show a rolling time-window average
    // (calmer + more useful for voice training) instead of a jittery per-frame value. The live
    // bars/orbs/graphs stay instantaneous. Buffers are TIME-stamped and fed every frame.
    this._avgWindowSecs = 3.0;        // selectable window length; 0 ⇒ "Live" (instantaneous)
    this._avgWindowMaxSecs = 10;      // retain up to this much history so window switches are instant
    this._avgRefreshSecs = 0.6;       // throttle: only recompute the displayed number this often
    this._avgBuffers = { pitch: [], resonance: [], attack: [], weight: [] };
    this._avgCache = {};              // last computed summary per metric (or null)
    this._avgLastRefresh = 0;         // performance.now()/1000 of last cache recompute
    this._avgLastFrameId = -1;        // frame id of last Live-mode recompute (de-dupes per frame)
    // Per-metric display modes (mirrors the Resonance method selector the user likes)
    this.pitchDisplayMode = 'hz';     // 'hz' | 'note' | 'range'
    this.weightMode = 'combined';     // 'combined' | 'tilt' | 'h1h2'
    this.attackMode = 'combined';     // 'combined' | 'rise' | 'abrupt'

    this.resize();
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    this._disposables.push(() => window.removeEventListener('resize', onResize));
    this.setupUI();
    this._updateHelpContent();
    this._setupMobile();
    this._setupInfoPopups();
    this.drawIdleScene();
  }



  /** Show/hide info-popup tooltips via JS (CSS-only approach was unreliable) */
  _setupInfoPopups() {
    document.querySelectorAll('.info-wrapper').forEach(wrapper => {
      const popup = wrapper.querySelector('.info-popup');
      const trigger = wrapper.querySelector('.info-trigger');
      if (!popup || !trigger) return;

      const show = () => {
        popup.removeAttribute('hidden');
        popup.style.display = '';
        popup.style.opacity = '1';
        popup.style.visibility = 'visible';
        popup.style.pointerEvents = 'auto';
      };
      const hide = () => {
        popup.style.display = 'none';
        popup.style.opacity = '0';
        popup.style.visibility = 'hidden';
        popup.style.pointerEvents = 'none';
        popup.setAttribute('hidden', '');
      };

      wrapper.addEventListener('mouseenter', show);
      wrapper.addEventListener('mouseleave', hide);
      trigger.addEventListener('focus', show);
      trigger.addEventListener('blur', hide);
    });
  }

  /** Mobile-only UX enhancements (no-op on desktop/tablet) */
  _setupMobile() {
    const mobileQuery = window.matchMedia('(max-width: 600px) and (pointer: coarse)');
    if (!mobileQuery.matches) return;

    // 1. Close drawers/panels when tapping outside on mobile
    const onMobilePointerDown = (e) => {
      if (!mobileQuery.matches) return;
      const vibPanel = document.getElementById('vibPanel');
      const vibToggle = document.getElementById('vibToggle');
      if (vibPanel?.classList.contains('show') && !vibPanel.contains(e.target) && e.target !== vibToggle) {
        vibPanel.classList.remove('show');
        vibToggle?.setAttribute('aria-expanded', 'false');
        vibToggle?.classList.remove('active');
        if (vibToggle) vibToggle.setAttribute('aria-expanded', 'false');
        vibToggle?.setAttribute('aria-expanded', 'false');
      }
      const recDrawer = document.getElementById('recordingsDrawer');
      const recBtn = document.getElementById('recordingsBtn');
      if (recDrawer?.classList.contains('show') && !recDrawer.contains(e.target) && e.target !== recBtn && !recBtn?.contains(e.target)) {
        recDrawer.classList.remove('show');
        if (recBtn) recBtn.setAttribute('aria-expanded', 'false');
        recBtn?.setAttribute('aria-expanded', 'false');
      }
      const helpTooltip = document.getElementById('helpTooltip');
      const helpBtn = document.getElementById('helpBtn');
      if (helpTooltip?.classList.contains('show') && !helpTooltip.contains(e.target) && e.target !== helpBtn) {
        helpTooltip.classList.remove('show');
        if (helpBtn) helpBtn.setAttribute('aria-expanded', 'false');
        helpBtn?.setAttribute('aria-expanded', 'false');
      }
    };
    document.addEventListener('pointerdown', onMobilePointerDown);
    this._disposables.push(() => document.removeEventListener('pointerdown', onMobilePointerDown));

    // 2. Prevent rubber-band bounce on iOS when scrolling at boundaries
    const appEl = document.getElementById('app');
    if (appEl) {
      appEl.style.overscrollBehavior = 'contain';
    }

    // 3. Add active state feedback for mobile tap via event delegation
    const mobileActiveSelector = '.btn, .btn-big, .rec-btn, .help-tab';
    const onTouchStart = (e) => {
      const el = e.target.closest(mobileActiveSelector);
      if (el) el.classList.add('mobile-active');
    };
    const onTouchEnd = (e) => {
      const el = e.target.closest(mobileActiveSelector);
      if (el) el.classList.remove('mobile-active');
    };
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true });
    this._disposables.push(
      () => document.removeEventListener('touchstart', onTouchStart),
      () => document.removeEventListener('touchend', onTouchEnd),
      () => document.removeEventListener('touchcancel', onTouchEnd)
    );

    // 4. Inject mobile active state CSS (visual feedback on tap)
    const mobileStyle = document.createElement('style');
    mobileStyle.textContent = `
      @media (max-width: 600px) and (pointer: coarse) {
        .mobile-active {
          opacity: 0.85;
          transform: scale(0.97) !important;
        }
      }
    `;
    document.head.appendChild(mobileStyle);

    // 5. Scroll fade indicators on horizontally-scrollable areas
    this._initScrollFades();
  }

  /** Attach scroll-fade edge indicators to horizontal scroll containers */
  _initScrollFades() {
    const scrollables = [
      document.querySelector('.hud-secondary'),
    ].filter(Boolean);

    const updateFade = (el) => {
      const { scrollLeft, scrollWidth, clientWidth } = el;
      const threshold = 4;
      const canScrollLeft = scrollLeft > threshold;
      const canScrollRight = scrollLeft + clientWidth < scrollWidth - threshold;
      el.classList.toggle('fade-left', canScrollLeft && !canScrollRight);
      el.classList.toggle('fade-right', canScrollRight && !canScrollLeft);
      el.classList.toggle('fade-both', canScrollLeft && canScrollRight);
      if (!canScrollLeft && !canScrollRight) {
        el.classList.remove('fade-left', 'fade-right', 'fade-both');
      }
    };

    scrollables.forEach(el => {
      el.classList.add('mobile-scroll-fade');
      // Initial check (deferred to ensure layout is computed)
      requestAnimationFrame(() => updateFade(el));
      el.addEventListener('scroll', () => updateFade(el), { passive: true });
      // Re-check when children change (e.g. mode cards appearing)
      const resizeObs = new ResizeObserver(() => updateFade(el));
      resizeObs.observe(el);
      this._disposables.push(() => resizeObs.disconnect());
    });
  }


  _applyMotionPreferences() {
    const lowMotion = this.userMotionPreference === 'low' || (this.userMotionPreference === 'auto' && this.reducedMotion);
    this.baseParticleScale = lowMotion ? 0.15 : 1;
    this.particleScale = this.baseParticleScale * this.dynamicQualityScale;
    document.body.classList.toggle('low-motion', lowMotion);
  }

  _updateHelpContent() {
    const el = document.getElementById('helpHowTo');
    if (!el) return;
    const c = (color, label, desc) => ({ color, label, desc });
    const helpData = {
      ball: {
        title: 'Voice → Ball Mapping',
        items: [
          c('bounce', 'Bounciness', 'Pitch variation controls bounce height. Speak with intonation!'),
          c('vowel', 'Vowel Elongation', 'Sustained sounds grow the ball and leave trails.'),
          c('artic', 'Articulation', 'Sharp consonants create sparkle bursts. Be crisp!'),
        ],
      },
    };
    const data = helpData.ball;
    el.textContent = '';
    const h3 = document.createElement('h3');
    h3.textContent = data.title;
    const p = document.createElement('p');
    const fragment = document.createDocumentFragment();
    data.items.forEach((item, index) => {
      if (index > 0) {
        fragment.appendChild(document.createElement('br'));
        fragment.appendChild(document.createElement('br'));
      }
      const b = document.createElement('b');
      b.style.color = `var(--accent-${item.color})`;
      b.textContent = `${item.label}:`;
      fragment.append(b, ' ', item.desc);
    });
    p.appendChild(fragment);
    el.append(h3, p);
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    // FIX: Reset transform before scaling — prevents compound scaling on multiple resizes
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    this.groundY = this.height * 0.75;
    this.ball.y = this.groundY - this.ball.radius;

    // FIX: Generate stars sized to actual canvas dimensions
    this.stars = [];
    for (let i = 0; i < 80; i++) {
      this.stars.push({
        x: Math.random() * 3000,
        y: Math.random() * this.height * 0.55,
        size: Math.random() * 1.5 + 0.5,
        twinkle: Math.random() * Math.PI * 2
      });
    }

    // Generate mountain layers (procedural, infinite via sine sums)
    if (!this.mountainLayers) {
      this.mountainLayers = [
        // Far mountains — slow parallax, taller, lighter
        {
          parallax: 0.08, baseY: 0.52, layers: [
            { amp: 60, freq: 0.0008, phase: 0.0 },
            { amp: 30, freq: 0.002, phase: 1.2 },
            { amp: 15, freq: 0.005, phase: 3.7 },
          ]
        },
        // Mid mountains — medium parallax
        {
          parallax: 0.18, baseY: 0.58, layers: [
            { amp: 55, freq: 0.0012, phase: 2.1 },
            { amp: 25, freq: 0.003, phase: 0.5 },
            { amp: 12, freq: 0.007, phase: 4.2 },
          ]
        },
        // Near hills — faster parallax, smaller, darker
        {
          parallax: 0.35, baseY: 0.65, layers: [
            { amp: 35, freq: 0.002, phase: 4.5 },
            { amp: 18, freq: 0.005, phase: 1.8 },
            { amp: 8, freq: 0.012, phase: 0.3 },
          ]
        },
      ];
    }
    // Theme-aware mountain + ground colors
    const mtnColors = {
      highcontrast: ['#12122a', '#0e0e22', '#0a0a1a'],
    };
    const groundColors = {
      highcontrast: ['#14142a', '#101024', '#0c0c1e'],
    };
    const mc = mtnColors[this.themeMode] || mtnColors.highcontrast;
    this.mountainLayers[0].color = mc[0];
    this.mountainLayers[1].color = mc[1];
    this.mountainLayers[2].color = mc[2];
    this._groundColors = groundColors[this.themeMode] || groundColors.highcontrast;

    if (!this.isRunning) this.drawIdleScene();
  }

  // FIX: Infinite procedural terrain
  getGroundHeight(worldX) {
    let h = 0;
    for (const layer of this.terrainLayers) {
      h += layer.amplitude * Math.sin(worldX * layer.frequency + layer.phase);
    }
    return this.groundY + h * 0.4;
  }

  // FIX: Helper for proper HSLA color strings
  getBallColor(alpha) {
    if (alpha !== undefined) {
      return `hsla(${this.ballHue}, ${this.ballSat}%, ${this.ballLit}%, ${alpha})`;
    }
    return `hsl(${this.ballHue}, ${this.ballSat}%, ${this.ballLit}%)`;
  }

  // ============================================
  // RECORDING — AnalyserNode time-domain polling + WAV encoding
  // The ONLY reliable approach in sandboxed iframes:
  // - MediaRecorder: stream consumed by Web Audio → silence
  // - ScriptProcessorNode: needs ctx.destination → blocked in sandbox
  // - AnalyserNode.getFloatTimeDomainData: WORKS (proven — the ball moves!)
  // We poll a dedicated small-FFT analyser at matched intervals
  // to capture approximately non-overlapping sample windows.
  // ============================================
  startRecording() {
    const a = this.analyzer;
    if (!a.audioCtx || !a.analyserRec || this.isRecording) return;
    try {
      this._recSampleRate = a.audioCtx.sampleRate;
      this._recBuffers = [];
      const fftSize = a.analyserRec.fftSize; // 512

      // Poll interval = window duration in ms (e.g. 512/44100*1000 ≈ 11.6ms)
      const intervalMs = Math.round(1000 * fftSize / this._recSampleRate);

      this._recInterval = setInterval(() => {
        if (!this.isRecording || !a.analyserRec) return;
        a.analyserRec.getFloatTimeDomainData(a.recTimeDomainData);

        // Speech gate: compute local RMS and check against analyzer's noise floor
        // plus pitch confidence. Non-speech frames become silence (preserves timing).
        const data = a.recTimeDomainData;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const localRms = Math.sqrt(sum / data.length);
        const threshold = a.isCalibrated ? a.noiseFloor * 2.5 : 0.02;
        const isSpeech = localRms > threshold || a.pitchConfidence > 0.3;

        if (isSpeech) {
          this._recBuffers.push(new Float32Array(data));
        } else {
          // Push silence to keep timing intact (avoids clicks/jumps)
          this._recBuffers.push(new Float32Array(data.length));
        }
      }, intervalMs);

      this.recordingStartTime = performance.now();
      this.isRecording = true;
    } catch (e) {
      console.error('Recording failed:', e);
    }
  }

  stopRecording() {
    if (!this.isRecording) return Promise.resolve();
    this.isRecording = false;

    if (this._recInterval) {
      clearInterval(this._recInterval);
      this._recInterval = null;
    }

    return new Promise((resolve) => {
      try {
        if (this._recBuffers.length === 0) { resolve(); return; }

        // Merge all Float32 buffers
        // ⚡ Bolt: Replace reduce with traditional loop for performance
        let totalLen = 0;
        for (let i = 0; i < this._recBuffers.length; i++) {
          totalLen += this._recBuffers[i].length;
        }
        const merged = new Float32Array(totalLen);
        let offset = 0;
        for (const buf of this._recBuffers) {
          merged.set(buf, offset);
          offset += buf.length;
        }
        this._recBuffers = [];

        // Encode as WAV (PCM 16-bit mono)
        const wavBlob = this._encodeWAV(merged, this._recSampleRate);
        const duration = (performance.now() - this.recordingStartTime) / 1000;
        const now = new Date();
        const ts = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const fileTs = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

        // Convert to data URL for universal playback in sandbox
        const reader = new FileReader();
        reader.onloadend = () => {
          this.recordings.push({
            blob: wavBlob,
            dataUrl: reader.result,
            duration,
            timestamp: ts,
            name: `vox-ball-${fileTs}`,
            mimeType: 'audio/wav'
          });
          this.updateRecordingsUI();
          resolve();
        };
        reader.onerror = () => { resolve(); };
        reader.readAsDataURL(wavBlob);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error(`Recording save error (${e && e.name || 'Error'}): ${msg}`, e);
        resolve();
      }
    });
  }

  startDAF() {
    const a = this.analyzer;
    if (!a.audioCtx || !a.analyserRec || this._dafInterval) return;
    const fftSize = a.analyserRec.fftSize;
    const sampleRate = a.audioCtx.sampleRate;
    const intervalMs = Math.round(1000 * fftSize / sampleRate);

    this._dafGain = a.audioCtx.createGain();
    this._dafGain.gain.value = 0.9;
    if (this.dafBassFilter) {
      this._dafFilter = a.audioCtx.createBiquadFilter();
      this._dafFilter.type = 'highpass';
      this._dafFilter.frequency.value = 150;
      this._dafGain.connect(this._dafFilter);
      this._dafFilter.connect(a.audioCtx.destination);
    } else {
      this._dafGain.connect(a.audioCtx.destination);
    }
    this._dafBuffer = [];
    this._dafNextPlayTime = 0;

    this._dafInterval = setInterval(() => {
      if (!a.analyserRec) return;
      const samples = new Float32Array(fftSize);
      a.analyserRec.getFloatTimeDomainData(samples);
      this._dafBuffer.push({ samples, captureTime: performance.now() });

      const threshold = performance.now() - this.dafDelayMs;
      while (this._dafBuffer.length > 0 && this._dafBuffer[0].captureTime <= threshold) {
        const { samples: s } = this._dafBuffer.shift();
        const buf = a.audioCtx.createBuffer(1, s.length, sampleRate);
        buf.copyToChannel(s, 0);
        const src = a.audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(this._dafGain);
        if (this._dafNextPlayTime < a.audioCtx.currentTime) {
          this._dafNextPlayTime = a.audioCtx.currentTime;
        }
        src.start(this._dafNextPlayTime);
        this._dafNextPlayTime += buf.duration;
      }
    }, intervalMs);
  }

  stopDAF() {
    if (this._dafInterval) {
      clearInterval(this._dafInterval);
      this._dafInterval = null;
    }
    this._dafBuffer = [];
    this._dafNextPlayTime = 0;
    if (this._dafFilter) { this._dafFilter.disconnect(); this._dafFilter = null; }
    if (this._dafGain) { this._dafGain.disconnect(); this._dafGain = null; }
  }

  _encodeWAV(samples, sampleRate) {
    // PCM 16-bit mono WAV
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    const dataLength = samples.length * blockAlign;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // RIFF header
    this._writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    this._writeString(view, 8, 'WAVE');

    // fmt chunk
    this._writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);           // chunk size
    view.setUint16(20, 1, true);            // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // data chunk
    this._writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // Convert Float32 [-1,1] to Int16
    let p = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      p += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  _writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  playRecording(index) {
    const rec = this.recordings[index];
    if (!rec) return;
    this.stopPlayback();

    const audio = new Audio();
    audio.volume = 1.0;
    this.currentPlayback = { audio, index };
    this.updateRecItemState(index, true);
    this._updateVoiceRecBtn();

    audio.addEventListener('timeupdate', () => {
      const progress = audio.duration > 0 ? (audio.currentTime / audio.duration) * 100 : 0;
      const el = document.getElementById(`rec-progress-${index}`);
      if (el) el.style.width = progress + '%';
    });

    audio.addEventListener('ended', () => {
      this.updateRecItemState(index, false);
      const el = document.getElementById(`rec-progress-${index}`);
      if (el) el.style.width = '0%';
      this.currentPlayback = null;
      this._updateVoiceRecBtn();
    });

    audio.addEventListener('error', (e) => {
      const detail = audio.error ? `${audio.error.code}: ${audio.error.message}` : String(e);
      console.error(`Audio playback error: ${detail}`);
      this.updateRecItemState(index, false);
      this.currentPlayback = null;
      this._updateVoiceRecBtn();
    });

    // Wait for audio to be loadable before playing
    audio.addEventListener('canplay', () => {
      audio.play().catch(e => {
        console.error('Playback failed:', e);
        this.updateRecItemState(index, false);
        this.currentPlayback = null;
        this._updateVoiceRecBtn();
      });
    }, { once: true });

    // Use data URL (works in sandboxed iframes, unlike blob: URLs)
    audio.src = rec.dataUrl;
    audio.load();
  }

  stopPlayback() {
    if (this.currentPlayback) {
      const audio = this.currentPlayback.audio;
      audio.pause();
      audio.removeAttribute('src');
      audio.load(); // release media resources
      this.updateRecItemState(this.currentPlayback.index, false);
      const el = document.getElementById(`rec-progress-${this.currentPlayback.index}`);
      if (el) el.style.width = '0%';
      this.currentPlayback = null;
      this._updateVoiceRecBtn();
    }
  }

  updateRecItemState(index, isPlaying) {
    const btn = document.getElementById(`rec-play-${index}`);
    if (btn) {
      btn.textContent = isPlaying ? '⏸' : '▶';
      btn.classList.toggle('playing', isPlaying);
    }
  }

  // Keep the always-visible top-bar Record/Play buttons in sync with recording + playback state.
  _updateVoiceRecBtn() {
    const recBtn = document.getElementById('voiceRecBtn');
    if (recBtn) {
      recBtn.classList.toggle('recording', !!this.isRecording);
      recBtn.setAttribute('aria-pressed', String(!!this.isRecording));
      const label = recBtn.querySelector('.voice-rec-label');
      if (label) label.textContent = this.isRecording ? 'Stop' : 'Record';
    }
    const playBtn = document.getElementById('voicePlayBtn');
    if (playBtn) {
      const lastIdx = this.recordings.length - 1;
      const playingLast = !!(this.currentPlayback && this.currentPlayback.index === lastIdx);
      playBtn.disabled = lastIdx < 0 || this.isRecording;
      playBtn.classList.toggle('playing', playingLast);
      const plabel = playBtn.querySelector('.voice-play-label');
      if (plabel) plabel.textContent = playingLast ? ' Stop' : ' Play';
    }
  }

  downloadRecording(index) {
    const rec = this.recordings[index];
    if (!rec) return;
    const url = URL.createObjectURL(rec.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${rec.name}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke immediately — the download has already been initiated by click()
    URL.revokeObjectURL(url);
  }

  deleteRecording(index) {
    if (this.currentPlayback && this.currentPlayback.index === index) {
      this.stopPlayback();
    }
    this.recordings.splice(index, 1);
    this.updateRecordingsUI();
  }

  clearAllRecordings() {
    this.stopPlayback();
    this.recordings = [];
    this.updateRecordingsUI();
  }

  formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  updateRecordingsUI() {
    const list = document.getElementById('recordingsList');
    const empty = document.getElementById('recsEmpty');
    const badge = document.getElementById('recBadge');
    const recBtn = document.getElementById('recordingsBtn');
    const clearAllBtn = document.getElementById('clearAllRecs');

    badge.textContent = this.recordings.length;
    recBtn.classList.toggle('visible', this.recordings.length > 0);
    if (clearAllBtn) {
      clearAllBtn.disabled = this.recordings.length === 0;
    }
    this._updateVoiceRecBtn();

    if (this.recordings.length === 0) {
      list.textContent = '';
      list.appendChild(empty);
      empty.style.display = '';
      return;
    }

    list.textContent = '';
    for (let i = this.recordings.length - 1; i >= 0; i--) {
      const rec = this.recordings[i];
      const item = document.createElement('div');
      item.className = 'rec-item';

      const info = Object.assign(document.createElement('div'), { className: 'rec-item-info' });
      info.append(
        Object.assign(document.createElement('div'), { className: 'rec-item-name', textContent: `Recording ${i + 1}` }),
        Object.assign(document.createElement('div'), { className: 'rec-item-meta', textContent: `${rec.timestamp} · ${this.formatDuration(rec.duration)}` })
      );

      const progress = Object.assign(document.createElement('div'), { className: 'rec-progress' });
      progress.appendChild(Object.assign(document.createElement('div'), { className: 'rec-progress-fill', id: `rec-progress-${i}` }));
      info.appendChild(progress);

      const actions = Object.assign(document.createElement('div'), { className: 'rec-item-actions' });
      actions.append(
        Object.assign(document.createElement('button'), { className: 'rec-btn', id: `rec-play-${i}`, title: 'Play', ariaLabel: 'Play Recording', textContent: '▶' }),
        Object.assign(document.createElement('button'), { className: 'rec-btn', title: 'Download', ariaLabel: 'Download Recording', textContent: '⬇' }),
        Object.assign(document.createElement('button'), { className: 'rec-btn delete', title: 'Delete', ariaLabel: 'Delete Recording', textContent: '✕' })
      );

      // Set data attributes
      actions.children[0].dataset.action = 'play'; actions.children[0].dataset.index = i;
      actions.children[1].dataset.action = 'download'; actions.children[1].dataset.index = i;
      actions.children[2].dataset.action = 'delete'; actions.children[2].dataset.index = i;

      item.append(info, actions);
      list.appendChild(item);
    }

    list.onclick = (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const idx = parseInt(btn.dataset.index, 10);
      if (action === 'play') {
        if (this.currentPlayback && this.currentPlayback.index === idx) {
          this.stopPlayback();
        } else {
          this.playRecording(idx);
        }
      } else if (action === 'download') {
        this.downloadRecording(idx);
      } else if (action === 'delete') {
        this.deleteRecording(idx);
      }
    };
  }


  // Wire the Smart Bulb section of the settings panel to the BulbController.
  // All transport/config state lives in the controller (persisted to localStorage);
  // this just binds the DOM controls and shows/hides transport-specific fields.
  _setupBulbUI() {
    const ctrl = this.bulbController;
    if (!ctrl) return;
    const enable = document.getElementById('bulbEnableToggle');
    const transportSel = document.getElementById('bulbTransportSelect');
    const testBtn = document.getElementById('bulbTestBtn');
    const connectBtn = document.getElementById('bulbConnectBtn');
    const autoReconnect = document.getElementById('bulbAutoReconnect');
    const fields = {
      hueBridge: document.getElementById('bulbHueBridge'),
      hueUser: document.getElementById('bulbHueUser'),
      hueLightId: document.getElementById('bulbHueLightId'),
      webhookUrl: document.getElementById('bulbWebhookUrl'),
      httpUrl: document.getElementById('bulbHttpUrl'),
      bleNamePrefix: document.getElementById('bulbBleNamePrefix'),
      bleServiceUuid: document.getElementById('bulbBleServiceUuid'),
      bleWriteUuid: document.getElementById('bulbBleWriteUuid'),
    };
    const groups = {
      hue: document.getElementById('bulbHueFields'),
      homeassistant: document.getElementById('bulbHaFields'),
      http: document.getElementById('bulbHttpFields'),
      genericble: document.getElementById('bulbGenericbleFields'),
    };
    // The Connect button (Bluetooth pairing) is shared by all BLE transports.
    const btFields = document.getElementById('bulbBtFields');
    const btTransports = new Set(['webbluetooth', 'genericble', 'esp32']);

    const syncVisibility = () => {
      const t = ctrl.config.transport;
      for (const [key, el] of Object.entries(groups)) {
        if (el) el.style.display = key === t ? '' : 'none';
      }
      if (btFields) btFields.style.display = btTransports.has(t) ? '' : 'none';
    };

    // Reflect controller config into the DOM controls. Runs initially and again
    // whenever the controller changes config itself (e.g. failure auto-disable).
    const hydrate = () => {
      if (enable) enable.checked = ctrl.config.enabled;
      if (transportSel) transportSel.value = ctrl.config.transport;
      if (autoReconnect) autoReconnect.checked = ctrl.config.autoReconnect;
      for (const [key, el] of Object.entries(fields)) {
        if (el) el.value = ctrl.config[key] ?? '';
      }
      syncVisibility();
    };
    hydrate();
    ctrl.onChange = hydrate;

    // Clinic convenience: silently re-link the saved BLE device on load so staff
    // don't re-pick it each session. No-op for non-BLE transports or when off.
    ctrl.restore?.();

    enable?.addEventListener('change', () => ctrl.setEnabled(enable.checked));
    autoReconnect?.addEventListener('change', () => ctrl.set('autoReconnect', autoReconnect.checked));
    transportSel?.addEventListener('change', () => {
      ctrl.set('transport', transportSel.value);
      syncVisibility();
    });
    for (const [key, el] of Object.entries(fields)) {
      el?.addEventListener('change', () => ctrl.set(key, el.value.trim()));
    }
    testBtn?.addEventListener('click', () => ctrl.test());
    // Bluetooth needs an explicit connect from a user gesture (this click).
    connectBtn?.addEventListener('click', () => ctrl.connect());
  }

  // Wire the Necklace section of the settings panel to the NecklaceController.
  // Unlike the Smart Bulb section, the necklace decides on its own when to buzz —
  // this UI only pushes a one-time calibration packet and shows the live status
  // notifications the necklace sends back (~1 Hz) while connected.
  _setupNecklaceUI() {
    const ctrl = this.necklaceController;
    if (!ctrl) return;
    const connectBtn = document.getElementById('necklaceConnectBtn');
    const pushBtn = document.getElementById('necklacePushBtn');
    const hapticSrcSel = document.getElementById('necklaceHapticSrcSelect');
    const loInput = document.getElementById('necklaceTargetLoHz');
    const hiInput = document.getElementById('necklaceTargetHiHz');
    const thrInput = document.getElementById('necklaceHapticThr');
    const pitchFields = document.getElementById('necklacePitchFields');
    const thrFields = document.getElementById('necklaceThrFields');
    const statusEl = document.getElementById('necklaceStatus');
    const liveEl = document.getElementById('necklaceLive');

    if (loInput && !loInput.value) loInput.value = 145;
    if (hiInput && !hiInput.value) hiInput.value = 175;
    if (thrInput && !thrInput.value) thrInput.value = 50;

    const setStatus = (text, kind) => {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.dataset.kind = kind || '';
    };

    const syncFieldVisibility = () => {
      const isPitch = hapticSrcSel?.value === String(HapticSrc.PITCH);
      if (pitchFields) pitchFields.style.display = isPitch ? '' : 'none';
      if (thrFields) thrFields.style.display = isPitch ? 'none' : '';
    };
    syncFieldVisibility();
    hapticSrcSel?.addEventListener('change', syncFieldVisibility);

    connectBtn?.addEventListener('click', async () => {
      setStatus('Opening device picker…', '');
      try {
        await ctrl.connect();
        setStatus('Necklace connected.', 'ok');
      } catch (err) {
        setStatus(`Connect failed: ${err && err.message ? err.message : err}`, 'err');
      }
    });

    pushBtn?.addEventListener('click', async () => {
      try {
        await ctrl.sendCalibration({
          hapticSrc: Number(hapticSrcSel?.value ?? HapticSrc.PITCH),
          hapticThrPct: Number(thrInput?.value ?? 50),
          targetLoHz: Number(loInput?.value ?? 145),
          targetHiHz: Number(hiInput?.value ?? 175),
        });
        setStatus('Calibration pushed.', 'ok');
      } catch (err) {
        setStatus(`Push failed: ${err && err.message ? err.message : err}`, 'err');
      }
    });

    if (liveEl) liveEl.textContent = '';
  }

  // Live readout from the necklace's ~1 Hz status notification (see
  // NecklaceController._onStatusPacket). Purely informational — the necklace has
  // already decided on its own whether to buzz by the time this arrives.
  _onNecklaceStatus(status) {
    const liveEl = document.getElementById('necklaceLive');
    if (!liveEl) return;
    const mins = Math.floor(status.voicedSeconds / 60);
    const secs = status.voicedSeconds % 60;
    const time = `${mins}:${String(secs).padStart(2, '0')}`;
    const battery = status.batteryPct == null ? '' : ` · battery ${status.batteryPct}%`;
    liveEl.textContent = status.calibrating
      ? 'Calibrating…'
      : `On target ${status.onTargetPct}% · ${time} voiced${battery}`;
  }

  setupUI() {
    const startBtn = document.getElementById('startBtn');
    const playBtn = document.getElementById('playBtn');
    const helpBtn = document.getElementById('helpBtn');
    const recalibrateBtn = document.getElementById('recalibrateBtn');
    const homeBtn = document.getElementById('homeBtn');
    const welcomeOverlay = document.getElementById('welcomeOverlay');
    const helpTooltip = document.getElementById('helpTooltip');
    const helpTabs = Array.from(helpTooltip?.querySelectorAll('.help-tab') || []);
    const helpPanels = Array.from(helpTooltip?.querySelectorAll('.help-panel') || []);

    const teleprompterModeSelect = document.getElementById('teleprompterModeSelect');
    const voiceProfileSelect = document.getElementById('voiceProfileSelect');
    const micDeviceSelect = document.getElementById('micDeviceSelect');
    const colorModeSelect = document.getElementById('colorModeSelect');
    const genderCueInputs = {
      modalF0: document.getElementById('genderCueModalF0'),
      dispersion: document.getElementById('genderCueDispersion'),
      sibilant: document.getElementById('genderCueSibilant'),
      cpp: document.getElementById('genderCueCpp'),
      intonation: document.getElementById('genderCueIntonation'),
    };
    const echoCancelToggle = document.getElementById('echoCancelToggle');
    const noiseSuppressToggle = document.getElementById('noiseSuppressToggle');
    const autoGainToggle = document.getElementById('autoGainToggle');
    const pitchProfileLearned = document.getElementById('pitchProfileLearned');
    const tiltProfileLearned = document.getElementById('tiltProfileLearned');
    const frameConfidenceLabel = document.getElementById('frameConfidenceLabel');
    const motionToggle = document.getElementById('motionToggle');
    const cameraBtn = document.getElementById('cameraBtn');
    const cameraModal = document.getElementById('cameraModal');
    const cameraClose = document.getElementById('cameraClose');
    const cameraVideo = document.getElementById('cameraVideo');
    const cameraZoom = document.getElementById('cameraZoom');
    const cameraHeader = document.getElementById('cameraHeader');

    const teleprompterCustomBtn = document.getElementById('teleprompterCustomBtn');
    const recordingsBtn = document.getElementById('recordingsBtn');
    const recordingsDrawer = document.getElementById('recordingsDrawer');
    const clearAllRecs = document.getElementById('clearAllRecs');
    const perfBtn = document.getElementById('perfBtn');
    const teleprompterOverlay = document.getElementById('teleprompterOverlay');
    const diagPanel = document.getElementById('diagPanel');

    const errorBanner = document.getElementById('errorBanner');
    const statusLiveRegion = document.getElementById('statusLiveRegion');
    const iframeNotice = document.getElementById('iframeNotice');
    const isInIframe = window.self !== window.top;

    // Detect iframe on load and show helpful notice
    if (isInIframe && iframeNotice) {
      // Build direct URL — HF Spaces has multiple URL patterns
      let directUrl = window.location.href;
      try {
        // Try to build the *.hf.space direct URL from the current location
        const url = new URL(window.location.href);
        // If we're already on a .hf.space domain, just use it directly
        if (!url.hostname.endsWith('.hf.space')) {
          directUrl = window.location.href;
        }
      } catch (e) { }
      iframeNotice.textContent = '';
      iframeNotice.appendChild(document.createTextNode('This app needs microphone access, which may be blocked when embedded.'));
      iframeNotice.appendChild(document.createElement('br'));
      const link = document.createElement('a');
      link.href = directUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open in new tab for full access ↗';
      iframeNotice.appendChild(link);
      iframeNotice.classList.add('show');
    }

    const showError = (msg) => {
      if (msg instanceof Node) {
        errorBanner.textContent = '';
        errorBanner.appendChild(msg);
        if (statusLiveRegion) statusLiveRegion.textContent = msg.textContent.trim();
      } else {
        errorBanner.textContent = msg;
        if (statusLiveRegion) statusLiveRegion.textContent = String(msg).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      errorBanner.classList.add('show');
    };
    const clearError = () => {
      errorBanner.classList.remove('show');
      if (statusLiveRegion) statusLiveRegion.textContent = '';
    };

    const updateAdaptiveProfileStatus = () => {
      const pitch = this.analyzer.pitchProfile;
      const tilt = this.analyzer.tiltProfile;
      const pitchPct = Math.min(100, Math.round((pitch.voicedTime / Math.max(0.1, pitch.learningDuration)) * 100));
      const tiltPct = Math.min(100, Math.round((tilt.voicedTime / Math.max(0.1, tilt.learningDuration)) * 100));
      if (pitchProfileLearned) {
        pitchProfileLearned.textContent = pitch.isLearned
          ? `${Math.round(pitch.min)}–${Math.round(pitch.max)} Hz learned`
          : `Learning… ${pitchPct}%`;
      }
      if (tiltProfileLearned) {
        tiltProfileLearned.textContent = tilt.isLearned
          ? `${tilt.min.toFixed(1)} to ${tilt.max.toFixed(1)} dB learned`
          : `Learning… ${tiltPct}%`;
      }
      if (frameConfidenceLabel) {
        frameConfidenceLabel.textContent = `${Math.round(this.analyzer.frameConfidence * 100)}%`;
      }
    };

    const syncMicSettingsUi = () => {
      if (echoCancelToggle) echoCancelToggle.checked = this.micInputPreferences.echoCancellation;
      if (noiseSuppressToggle) noiseSuppressToggle.checked = this.micInputPreferences.noiseSuppression;
      if (autoGainToggle) autoGainToggle.checked = this.micInputPreferences.autoGainControl;
      if (micDeviceSelect) micDeviceSelect.value = this.micInputPreferences.deviceId || 'default';
      const phoneMicPanel = document.getElementById('phoneMicPanel');
      if (phoneMicPanel) phoneMicPanel.style.display = this.micInputPreferences.deviceId === 'phone-mic' ? '' : 'none';
      if (colorModeSelect) colorModeSelect.value = this.colorMode || 'pitch';
      for (const [cue, input] of Object.entries(genderCueInputs)) {
        if (input) input.checked = !!this.genderCues[cue];
      }
    };

    const populateMicDevices = async () => {
      if (!micDeviceSelect || !navigator.mediaDevices?.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter((d) => d.kind === 'audioinput');
        micDeviceSelect.textContent = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = 'default';
        defaultOption.textContent = 'Microphone: System Default';
        micDeviceSelect.appendChild(defaultOption);
        const phoneOption = document.createElement('option');
        phoneOption.value = 'phone-mic';
        phoneOption.textContent = 'Phone Microphone (link via browser)';
        micDeviceSelect.appendChild(phoneOption);
        mics.forEach((mic, idx) => {
          const option = document.createElement('option');
          option.value = mic.deviceId;
          option.textContent = `Mic: ${mic.label || `Microphone ${idx + 1}`}`;
          micDeviceSelect.appendChild(option);
        });
        const hasStoredDevice = this.micInputPreferences.deviceId === 'default'
          || this.micInputPreferences.deviceId === 'phone-mic'
          || mics.some((mic) => mic.deviceId === this.micInputPreferences.deviceId);
        if (!hasStoredDevice) {
          this.micInputPreferences.deviceId = 'default';
          localStorage.setItem('vox:micDeviceId', 'default');
        }
        syncMicSettingsUi();
      } catch (err) {
        console.warn('Could not enumerate microphones:', err);
      }
    };

    const showCalibrationOutcome = (calResult) => {
      if (!calResult) return;
      if (calResult.outcome === 'completed') {
        showError('✅ Calibration complete. Tip: you can run Recalibrate from the top bar anytime.');
      } else if (calResult.outcome === 'incomplete') {
        showError('⚠ Calibration timed out. You can continue, but tracking may be less accurate. Next action: tap Recalibrate when your room is quieter.');
      } else if (calResult.outcome === 'cancelled') {
        showError('ℹ Calibration cancelled. Next action: tap Recalibrate in the top bar when you are ready.');
      } else if (calResult.outcome === 'partial') {
        showError('ℹ Calibration partially completed. Next action: tap Recalibrate to finish vowel tuning for better accuracy.');
      } else if (calResult.outcome === 'skipped') {
        showError('ℹ Calibration skipped. Next action: tap Recalibrate in the top bar for more stable tracking.');
      }
    };


    // Camera Mirror Logic
    let cameraStream = null;

    const stopCamera = () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
      }
      if (cameraVideo) {
        cameraVideo.srcObject = null;
      }
      cameraModal?.classList.remove('show');
      cameraBtn?.setAttribute('aria-expanded', 'false');
      cameraBtn?.classList.remove('active');
      if (cameraBtn) cameraBtn.setAttribute('aria-expanded', 'false');
      cameraBtn?.setAttribute('aria-expanded', 'false');
    };

    const toggleCamera = async () => {
      if (cameraModal?.classList.contains('show')) {
        stopCamera();
        return;
      }

      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
        });
        if (cameraVideo) {
          cameraVideo.srcObject = cameraStream;
        }
        cameraModal?.classList.add('show');
        cameraBtn?.setAttribute('aria-expanded', 'true');
        cameraBtn?.classList.add('active');
        if (cameraBtn) cameraBtn.setAttribute('aria-expanded', 'true');
        cameraBtn?.setAttribute('aria-expanded', 'true');
      } catch (e) {
        showError('📷 Camera access denied or not available.');
        console.error('Camera error:', e);
      }
    };

    cameraBtn?.addEventListener('click', toggleCamera);
    cameraClose?.addEventListener('click', stopCamera);

    // Zoom Logic
    cameraZoom?.addEventListener('input', (e) => {
      if (cameraVideo) {
        cameraVideo.style.transform = `scale(${e.target.value})`;
      }
    });

    // Draggable Window Logic
    let isDraggingCamera = false;
    let cameraDragStartX = 0;
    let cameraDragStartY = 0;
    let cameraModalStartX = 0;
    let cameraModalStartY = 0;

    cameraHeader?.addEventListener('pointerdown', (e) => {
      isDraggingCamera = true;
      cameraDragStartX = e.clientX;
      cameraDragStartY = e.clientY;

      const rect = cameraModal.getBoundingClientRect();
      cameraModalStartX = rect.left;
      cameraModalStartY = rect.top;

      cameraHeader.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    cameraHeader?.addEventListener('pointermove', (e) => {
      if (!isDraggingCamera || !cameraModal) return;

      const dx = e.clientX - cameraDragStartX;
      const dy = e.clientY - cameraDragStartY;

      // Keep it within window bounds approximately
      const newLeft = Math.max(0, Math.min(window.innerWidth - cameraModal.offsetWidth, cameraModalStartX + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - 40, cameraModalStartY + dy));

      cameraModal.style.left = `${newLeft}px`;
      cameraModal.style.top = `${newTop}px`;
      cameraModal.style.right = 'auto'; // overriding initial right positioning
    });

    cameraHeader?.addEventListener('pointerup', (e) => {
      isDraggingCamera = false;
      cameraHeader.releasePointerCapture(e.pointerId);
    });

    // Audio file upload handling
    const audioUploadInput = document.getElementById('audioUploadInput');
    let selectedAudioFile = null;

    audioUploadInput?.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        selectedAudioFile = e.target.files[0];

        // if a game is running, stop it and start again with file
        if (this.isRunning) {
          stopGame().then(() => startGame());
        } else {
          startGame();
        }
      }
    });

    // Show/hide HUD secondary controls (hidden on main menu, visible during play)
    const setHudSettingsVisible = (visible) => {
      document.querySelectorAll('.hud-setting').forEach(el => {
        if (visible) {
          el.removeAttribute('hidden');
          el.style.display = '';
        } else {
          el.setAttribute('hidden', '');
          el.style.display = 'none';
        }
      });
    };

    const startPhoneMicSession = (onStatus) => new Promise((resolve, reject) => {
      function initPeer() {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        const code = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
        const peerId = 'vox-' + code.toLowerCase();
        let settled = false;
        let timeoutId;
        let peer;
        const fail = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          try { peer?.destroy(); } catch (_) {}
          reject(err);
        };
        peer = new window.Peer(peerId);
        timeoutId = setTimeout(() => fail(new Error('Phone mic pairing timed out. Try pressing Start again.')), 120_000);
        peer.on('open', () => onStatus('waiting', code));
        peer.on('call', (call) => {
          if (settled) { call.close?.(); return; }
          call.answer();
          call.on('stream', (stream) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              onStatus('connected', code);
              resolve({ stream, cleanup: () => peer.destroy() });
            }
          });
          call.on('error', fail);
        });
        peer.on('error', fail);
      }
      if (window.Peer) {
        initPeer();
      } else {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
        s.integrity = 'sha384-nlUQ8ZqCbvStErob+biJNzSgltf6urV3VGqhfIfzhmg9RXmpeRm76ELw0pYnKlTR';
        s.crossOrigin = 'anonymous';
        s.onload = initPeer;
        s.onerror = () => reject(new Error('Could not load PeerJS. Check your internet connection.'));
        document.head.appendChild(s);
      }
    });

    const cleanupPhoneMic = () => {
      if (this._phoneMicCleanup) {
        try { this._phoneMicCleanup(); } catch (err) { console.warn('Phone mic cleanup failed:', err); }
        this._phoneMicCleanup = null;
      }
      const phoneMicUrlEl = document.getElementById('phoneMicUrl');
      const phoneMicCodeEl = document.getElementById('phoneMicCode');
      const phoneMicStatusEl = document.getElementById('phoneMicStatus');
      if (phoneMicUrlEl) phoneMicUrlEl.style.display = 'none';
      if (phoneMicCodeEl) phoneMicCodeEl.style.display = 'none';
      if (phoneMicStatusEl) phoneMicStatusEl.style.display = 'none';
    };

    const startGame = async () => {
      if (this._isStarting) return; // prevent concurrent start/stop race
      this._isStarting = true;
      try {
      this.teleprompterSentenceIndex = 0; // start each session at the first sentence
      clearError();
      const initialDiag = await getMicDiagnostics(this.analyzer.audioCtx);
      if (diagPanel) {
        diagPanel.textContent = '';
        diagPanel.textContent = '';
        diagPanel.append(
          'Mic permission: ', Object.assign(document.createElement('b'), { textContent: initialDiag.permission }),
          ' · Audio: ', Object.assign(document.createElement('b'), { textContent: initialDiag.audioState }),
          ' · Secure: ', Object.assign(document.createElement('b'), { textContent: initialDiag.secureContext ? 'yes' : 'no' }),
          initialDiag.inIframe ? ' · Embedded iframe: yes' : ''
        );
      }
      if (this.idleAnimId) {
        cancelAnimationFrame(this.idleAnimId);
        this.idleAnimId = null;
      }

      // Check if we have an audio file OR microphone
      if (!selectedAudioFile && (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)) {
        const errNode = document.createElement('div');
        errNode.append(
          '🎙 Microphone API not available and no audio file selected.',
          document.createElement('br'),
          'This requires HTTPS and a modern browser. '
        );
        errNode.textContent = '';
        errNode.appendChild(document.createTextNode('🎙 Microphone API not available and no audio file selected.'));
        errNode.appendChild(document.createElement('br'));
        errNode.appendChild(document.createTextNode('This requires HTTPS and a modern browser. '));
        if (isInIframe) {
          const link = document.createElement('a');
          link.href = window.location.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'Try opening in a new tab ↗';
          errNode.appendChild(link);
        } else {
          errNode.appendChild(document.createTextNode('Please use Chrome, Firefox, Safari, or Edge.'));
        }
        showError(errNode);
        this.drawIdleScene();
        return;
      }

      const buildInputOptions = () => ({
        deviceId: this.micInputPreferences.deviceId !== 'default' && this.micInputPreferences.deviceId !== 'phone-mic'
          ? this.micInputPreferences.deviceId : undefined,
        echoCancellation: this.micInputPreferences.echoCancellation,
        noiseSuppression: this.micInputPreferences.noiseSuppression,
        autoGainControl: this.micInputPreferences.autoGainControl,
      });

      let result;
      if (!selectedAudioFile && this.micInputPreferences.deviceId === 'phone-mic') {
        const phoneMicUrlEl = document.getElementById('phoneMicUrl');
        const phoneMicCodeEl = document.getElementById('phoneMicCode');
        const phoneMicStatusEl = document.getElementById('phoneMicStatus');
        try {
          const { stream, cleanup } = await startPhoneMicSession((status, code) => {
            if (status === 'waiting') {
              const url = new URL('phone.html', window.location.href);
              url.searchParams.set('room', code);
              url.searchParams.set('ec', this.micInputPreferences.echoCancellation ? '1' : '0');
              url.searchParams.set('ns', this.micInputPreferences.noiseSuppression ? '1' : '0');
              url.searchParams.set('ag', this.micInputPreferences.autoGainControl ? '1' : '0');
              if (phoneMicUrlEl) { phoneMicUrlEl.href = url.href; phoneMicUrlEl.textContent = url.href; phoneMicUrlEl.style.display = ''; }
              if (phoneMicCodeEl) { phoneMicCodeEl.style.display = ''; phoneMicCodeEl.querySelector('strong').textContent = code; }
              if (phoneMicStatusEl) { phoneMicStatusEl.style.display = ''; phoneMicStatusEl.textContent = 'Waiting for phone to connect...'; }
              showError(`📱 Open on your phone: ${url.href}`);
            } else if (status === 'connected') {
              if (phoneMicStatusEl) phoneMicStatusEl.textContent = '✅ Phone connected!';
              clearError();
            }
          });
          this._phoneMicCleanup = cleanup;
          result = await this.analyzer.start(null, { stream });
          if (!result.ok) { cleanupPhoneMic(); }
        } catch (err) {
          cleanupPhoneMic();
          showError('📱 Phone mic failed: ' + (err.message || 'Connection error'));
          this.drawIdleScene();
          return;
        }
      } else {
        result = await this.analyzer.start(selectedAudioFile, buildInputOptions());
        // Recover automatically if a previously saved device is no longer available.
        if (!selectedAudioFile && !result.ok && result.error === 'NotFoundError' && this.micInputPreferences.deviceId !== 'default') {
          this.micInputPreferences.deviceId = 'default';
          localStorage.setItem('vox:micDeviceId', 'default');
          syncMicSettingsUi();
          result = await this.analyzer.start(selectedAudioFile, buildInputOptions());
        }
      }

      // Clear the selected file after starting so it doesn't persistently start with the file
      // if the user later clicks the normal Start button.
      selectedAudioFile = null;
      if (audioUploadInput) audioUploadInput.value = "";

      if (!result.ok) {
        let msg = '';
        if (result.error === 'NotAllowedError') {
          if (isInIframe) {
            msg = document.createElement('div');
            msg.append(
              '🎙 Microphone blocked by browser — this usually happens inside iframes.',
              document.createElement('br')
            );
            msg.append('🎙 Microphone blocked by browser — this usually happens inside iframes.', document.createElement('br'));
            msg.textContent = '';
            msg.appendChild(document.createTextNode('🎙 Microphone blocked by browser — this usually happens inside iframes.'));
            msg.appendChild(document.createElement('br'));
            const link = document.createElement('a');
            link.href = window.location.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'Open in a new tab for full mic access ↗';
            msg.appendChild(link);
          } else {
            msg = document.createElement('div');
            msg.append(
              '🎙 Microphone permission denied.',
              document.createElement('br'),
              'Click the lock/camera icon in your address bar → Allow microphone → then try again.'
            );
            msg.appendChild(document.createTextNode('🎙 Microphone permission denied.'));
            msg.appendChild(document.createElement('br'));
            msg.appendChild(document.createTextNode('Click the lock/camera icon in your address bar → Allow microphone → then try again.'));
          }
        } else if (result.error === 'NotFoundError') {
          msg = '🎙 No microphone detected. Please connect a microphone and try again.';
        } else if (result.error === 'NotReadableError') {
          msg = '🎙 Microphone is in use by another app. Close other apps using the mic and try again.';
        } else {
          msg = document.createElement('div');
          msg.textContent = '🎙 Could not access microphone: ' + (result.message || result.error);
        }
        showError(msg);
        this.drawIdleScene();
        return;
      }

      const resumed = await ensureAudioContextRunning(this.analyzer.audioCtx);
      if (!resumed.ok) {
        showError('🔊 Audio context could not be resumed automatically. Tap Start again after interacting with the page.');
      }

      const audioTracks = this.analyzer.stream?.getAudioTracks?.() || [];
      audioTracks.forEach((track) => {
        track.onended = () => {
          showError('🎙 Microphone stream ended unexpectedly. Press Start to resume.');
        };
      });

      const activeDiag = await getMicDiagnostics(this.analyzer.audioCtx);
      if (diagPanel) {
        diagPanel.textContent = '';
        diagPanel.textContent = '';
        diagPanel.append(
          'Mic permission: ', Object.assign(document.createElement('b'), { textContent: activeDiag.permission }),
          ' · Audio: ', Object.assign(document.createElement('b'), { textContent: activeDiag.audioState }),
          ' · API: ', Object.assign(document.createElement('b'), { textContent: activeDiag.mediaDevices ? 'ok' : 'missing' })
        );
      }
      populateMicDevices();

      if (!this.hasCompletedCalibration) {
        let calResult = { outcome: 'incomplete', skipped: true, reason: 'timeout-guard' };
        try {
          // Global guard so calibration can never stall session start.
          const timeoutMs = 15000;
          calResult = await Promise.race([
            this.calibrationWizard.run(this.analyzer),
            new Promise((resolve) => setTimeout(() => {
              this.calibrationWizard.cancel();
              resolve({ outcome: 'incomplete', skipped: true, reason: 'wizard-timeout' });
            }, timeoutMs)),
          ]);
        } catch (err) {
          console.error('Calibration flow failed:', err);
          calResult = { outcome: 'incomplete', skipped: true, reason: 'wizard-exception' };
        }
        this.hasCompletedCalibration = true;
        showCalibrationOutcome(calResult);
      }

      // If the wizard was skipped/timed out, don't leave the analyzer in the
      // pre-calibration state where update() early-returns forever.
      if (!this.analyzer.isCalibrated) {
        const fallbackFloor = Math.max(0.008, this.analyzer.noiseFloor || 0.01);
        this.analyzer.noiseFloor = fallbackFloor;
        this.analyzer.syllableThreshold = Math.max(this.analyzer.syllableThreshold || 0, fallbackFloor * 1.2);
        this.analyzer.sustainedThreshold = Math.max(this.analyzer.sustainedThreshold || 0, fallbackFloor * 1.5);
        this.analyzer.isCalibrated = true;
      }

      this.scrollX = 0;
      this.cameraY = 0;
      this.targetCameraY = 0;
      this.cameraZoom = 1.4;
      this.targetZoom = 1.4;
      this.prosodyScore = 0;
      this.guidedStartTs = performance.now();
      this.guidedDismissed = false;
      this.guidedCloseHitbox = null;
      this.guidedPitchStable = 0;
      this.guidedChecklist = {
        roomReady: this.analyzer.isCalibrated,
        voiceDetected: false,
        pitchLocked: false,
      };
      this.particles = [];
      this.trailPoints = [];
      this.sparkles = [];
      this.ball.vy = 0;
      this.ball.onGround = true;
      this.ball.squash = 1;
      this.ball.radius = this.ball.baseRadius;
      this.ball.x = this.width * 0.45;
      this.ball.y = this.getGroundHeight(this.scrollX + this.ball.x) - this.ball.radius;

      // Clear vibration alert tripped highlights
      for (const rule of this.vibration.rules) { rule.tripped = false; }
      this.vibration.flashAlpha = 0;
      if (this._renderVibRules) this._renderVibRules();

      // Clear windowed-average readout buffers so a quick restart doesn't average in
      // the previous session's history.
      this._avgBuffers = { pitch: [], resonance: [], attack: [], weight: [] };
      this._avgCache = {};
      this._avgLastRefresh = 0;
      this._avgLastFrameId = -1;

      // Initialize session stats
      this.session.startTime = Date.now();
      this.session.duration = 0;
      this.session.pitchSum = 0;
      this.session.pitchCount = 0;
      this.session.pitchMin = Infinity;
      this.session.pitchMax = 0;
      this.session.resonanceSum = 0;
      this.session.resonanceCount = 0;
      this.session.prosodyHistory = [];
      this.session.prosodySampleTimer = 0;
      this.session.scrollAtStart = this.scrollX;

      // Show session timer
      const timerEl = document.getElementById('sessionTimer');
      timerEl.textContent = '0:00';
      timerEl.classList.add('active');

      // Hide summary if visible
      document.getElementById('summaryOverlay').classList.remove('show');

      welcomeOverlay.classList.add('hidden');
      document.getElementById('app').classList.add('playing');
      setHudSettingsVisible(true);
      if (iframeNotice) iframeNotice.classList.remove('show');
      helpTooltip.classList.remove('show');
      vibPanel.classList.remove('show');
      recordingsDrawer.classList.remove('show');
      startBtn.textContent = '⏹ Stop Ball';
      startBtn.classList.add('active');
      recBtn.classList.add('visible');
      this.isRunning = true;
      if (this.dafEnabled) this.startDAF();
      this.lastTime = performance.now();
      this.loop();
      } finally {
        this._isStarting = false;
      }
    };

    const stopGame = async () => {
      // Clear any pending timeouts from the game session
      for (const id of this._pendingTimeouts) clearTimeout(id);
      this._pendingTimeouts = [];
      // Auto-stop recording if active — must await so recorder can
      // flush its final chunk before we kill the mic stream
      if (this.isRecording) {
        recBtn.classList.remove('recording');
        recBtn.querySelector('.rec-label').textContent = 'Rec';
        await this.stopRecording();
      }
      this.stopDAF();
      document.getElementById('dafPanel')?.classList.remove('show');
      document.getElementById('dafBtn')?.setAttribute('aria-expanded', 'false');
      this.isRunning = false;
      this.analyzer.stop();
      cleanupPhoneMic();
      startBtn.textContent = '🎙 Start';
      startBtn.classList.remove('active');
      recBtn.classList.remove('visible');

      // Hide session timer
      document.getElementById('sessionTimer').classList.remove('active');

      // Clear vibration alert tripped highlights on stop
      for (const rule of this.vibration.rules) { rule.tripped = false; }
      this.vibration.flashAlpha = 0;
      if (this._renderVibRules) this._renderVibRules();
      if (this._gameArea) this._gameArea.classList.remove('vib-shake');

      // Close any open panels so they don't block the menu or summary overlay
      // (panels have higher z-index than the welcome overlay, so they must be
      // explicitly closed here — setHudSettingsVisible only hides .hud-setting
      // buttons, not the panel contents themselves).
      document.getElementById('settingsPanel')?.classList.remove('show');
      document.getElementById('settingsBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('vibPanel')?.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
      document.getElementById('helpTooltip')?.classList.remove('show');
      document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('recordingsDrawer')?.classList.remove('show');
      document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');

      // Show session summary if session was meaningful (> 3 seconds)
      if (this.session.duration > 3) {
        this._showSessionSummary();
        this.drawIdleScene(); // animate behind semi-transparent summary
      } else {
        welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
        this.drawIdleScene();
      }
    };

    startBtn?.addEventListener('click', () => {
      if (this.isRunning) stopGame(); else startGame();
    });

    playBtn?.addEventListener('click', startGame);

    perfBtn?.addEventListener('click', () => {
      this.perfMonitor.toggle();
      perfBtn.classList.toggle('active', this.perfMonitor.enabled);
    });

    homeBtn?.addEventListener('click', () => {
      // If a game is running, stop it and go directly to menu
      if (this.isRunning) {
        this.isRunning = false;
        this.analyzer.stop();
        cleanupPhoneMic();
        startBtn.textContent = '🎙 Start';
        startBtn.classList.remove('active');
        const recBtn = document.getElementById('recBtn');
        if (recBtn) recBtn.classList.remove('visible');

        document.getElementById('sessionTimer').classList.remove('active');
        for (const rule of this.vibration.rules) { rule.tripped = false; }
        this.vibration.flashAlpha = 0;
        if (this._renderVibRules) this._renderVibRules();
        if (this._gameArea) this._gameArea.classList.remove('vib-shake');
      }

      // Show the menu directly
      welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
      document.getElementById('summaryOverlay').classList.remove('show');

      // Close all panels and reset aria-expanded
      this.stopDAF();
      document.getElementById('settingsPanel')?.classList.remove('show');
      document.getElementById('settingsBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('vibPanel')?.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
      document.getElementById('helpTooltip')?.classList.remove('show');
      document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('recordingsDrawer')?.classList.remove('show');
      document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('dafPanel')?.classList.remove('show');
      document.getElementById('dafBtn')?.setAttribute('aria-expanded', 'false');

      this.drawIdleScene();
    });

    // Session summary buttons
    document.getElementById('summaryBackBtn')?.addEventListener('click', () => {
      document.getElementById('summaryOverlay').classList.remove('show');
      welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
      // Close any open panels before showing the menu
      document.getElementById('settingsPanel')?.classList.remove('show');
      document.getElementById('settingsBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('vibPanel')?.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
      document.getElementById('helpTooltip')?.classList.remove('show');
      document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('recordingsDrawer')?.classList.remove('show');
      document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');
      document.getElementById('dafPanel')?.classList.remove('show');
      document.getElementById('dafBtn')?.setAttribute('aria-expanded', 'false');
      this.drawIdleScene();
    });
    document.getElementById('summaryAgainBtn')?.addEventListener('click', () => {
      document.getElementById('summaryOverlay').classList.remove('show');
      startGame();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Don't capture when typing in inputs
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (this.isRunning && this.teleprompterMode !== 'off') {
          this._advanceTeleprompterManual();
          return;
        }
        if (document.getElementById('summaryOverlay').classList.contains('show')) {
          // From summary → start again
          document.getElementById('summaryOverlay').classList.remove('show');
          startGame();
        } else {
          startBtn.click();
        }
      }
      if (e.code === 'KeyP') {
        e.preventDefault();
        this.perfMonitor.toggle();
        perfBtn?.classList.toggle('active', this.perfMonitor.enabled);
      }
      if (e.code === 'KeyR' && this.isRunning) {
        e.preventDefault();
        recBtn.click();
      }
      if (e.code === 'Escape') {
        // Close metric popup first if open
        if (this.metricPopupOpen) {
          this._closeMetricPopup();
          return;
        }
        helpTooltip.classList.remove('show');
        vibPanel.classList.remove('show');
        recordingsDrawer.classList.remove('show');
        // If summary is showing, go to menu
        if (document.getElementById('summaryOverlay').classList.contains('show')) {
          document.getElementById('summaryOverlay').classList.remove('show');
          welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
          this.drawIdleScene();
        }
      }
    });

    // Single-mode (Vox Ball) setup — runs once during init.
    document.querySelectorAll('.ball-only').forEach(el => el.classList.add('show'));
    if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompterMode !== 'off');
    document.querySelector('.hud-title').textContent = 'VOX BALL';
    this._updateHelpContent();
    if (this.idleAnimId) { cancelAnimationFrame(this.idleAnimId); this.idleAnimId = null; }
    if (!this.isRunning) this.drawIdleScene();

    const applyVoiceProfilePreset = (preset) => {
      this.voiceProfilePreset = preset;
      const profiles = {
        auto: { min: 80, max: 380, sustainMul: 1, tiltShift: 0 },
        deeper: { min: 60, max: 260, sustainMul: 0.95, tiltShift: -2 },
        lighter: { min: 120, max: 520, sustainMul: 1.05, tiltShift: 2 },
        expressive: { min: 70, max: 460, sustainMul: 1.15, tiltShift: 0 }
      };
      const cfg = profiles[preset] || profiles.auto;
      this.analyzer.pitchProfile.min = cfg.min;
      this.analyzer.pitchProfile.max = cfg.max;
      this.analyzer.pitchProfile.isLearned = false;
      this.analyzer.pitchProfile.samples = [];
      this.analyzer.tiltProfile.isLearned = false;
      this.analyzer.tiltProfile.samples = [];
      const baseSustain = this.analyzer.defaultSustainedThreshold || this.analyzer.sustainedThreshold || 0.02;
      this.analyzer.sustainedThreshold = Math.max(0.01, baseSustain * cfg.sustainMul);
      this.analyzer.spectralTiltSmoothedDb += cfg.tiltShift;
    };

    voiceProfileSelect?.addEventListener('change', (e) => {
      applyVoiceProfilePreset(e.target.value);
    });

    micDeviceSelect?.addEventListener('change', (e) => {
      this.micInputPreferences.deviceId = e.target.value || 'default';
      localStorage.setItem('vox:micDeviceId', this.micInputPreferences.deviceId);
      const phoneMicPanel = document.getElementById('phoneMicPanel');
      if (phoneMicPanel) phoneMicPanel.style.display = this.micInputPreferences.deviceId === 'phone-mic' ? '' : 'none';
    });

    colorModeSelect?.addEventListener('change', (e) => {
      this.colorMode = e.target.value === 'gender' ? 'gender' : 'pitch';
      localStorage.setItem('vox:colorMode', this.colorMode);
      if (!this.isRunning) this.drawIdleScene();
    });

    for (const [cue, input] of Object.entries(genderCueInputs)) {
      input?.addEventListener('change', (e) => {
        this.genderCues[cue] = !!e.target.checked;
        localStorage.setItem(`vox:genderCue:${cue}`, String(this.genderCues[cue]));
        if (!this.isRunning) this.drawIdleScene();
      });
    }

    echoCancelToggle?.addEventListener('change', (e) => {
      this.micInputPreferences.echoCancellation = !!e.target.checked;
      localStorage.setItem('vox:echoCancellation', String(this.micInputPreferences.echoCancellation));
    });

    noiseSuppressToggle?.addEventListener('change', (e) => {
      this.micInputPreferences.noiseSuppression = !!e.target.checked;
      localStorage.setItem('vox:noiseSuppression', String(this.micInputPreferences.noiseSuppression));
    });

    autoGainToggle?.addEventListener('change', (e) => {
      this.micInputPreferences.autoGainControl = !!e.target.checked;
      localStorage.setItem('vox:autoGainControl', String(this.micInputPreferences.autoGainControl));
    });

    // Tap-to-advance for the teleprompter (mobile tap + desktop click)
    if (teleprompterOverlay) {
      teleprompterOverlay.addEventListener('click', () => {
        if (this.isRunning && this.teleprompterMode !== 'off') {
          this._advanceTeleprompterManual();
        }
      });
    }

    teleprompterModeSelect?.addEventListener('change', (e) => {
      this.teleprompterMode = e.target.value;
      this.teleprompterIndex = 0;
      this.teleprompterSentenceIndex = 0;
      if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompterMode !== 'off');
      teleprompterCustomBtn?.classList.toggle('active', this.teleprompterMode === 'custom');
    });

    teleprompterCustomBtn?.addEventListener('click', () => {
      const existing = this.teleprompterCustomText || '';
      const input = window.prompt('Paste or type your teleprompter text:', existing);
      if (input === null) return;
      this.teleprompterCustomText = input.trim();
      if (!this.teleprompterCustomText) {
        this.teleprompterMode = 'rainbow';
      } else {
        this.teleprompterMode = 'custom';
      }
      if (teleprompterModeSelect) teleprompterModeSelect.value = this.teleprompterMode;
      this.teleprompterIndex = 0;
      this.teleprompterSentenceIndex = 0;
      if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompterMode !== 'off');
      teleprompterCustomBtn.classList.toggle('active', this.teleprompterMode === 'custom');
    });

    document.getElementById('resMethodSelect').addEventListener('change', (e) => {
      this.analyzer.resonanceMethod = e.target.value;
      // Reset smoothed values when switching methods for clean comparison
      this.analyzer.smoothF1 = 500;
      this.analyzer.smoothF2 = 1500;
      this.analyzer.smoothF3 = 2700;
      this.analyzer.smoothResonance = 0.5;
      this.analyzer.formantConfidence = 0;
    });

    // Readout-display mode selectors (mirror the resonance method selector). These are
    // display/selection only — they never change analyzer.metrics.* — and force an immediate
    // cache recompute so the readout updates on the next frame instead of after the throttle.
    const bindReadoutSelect = (id, apply) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', (e) => { apply(e.target.value); this._avgLastRefresh = 0; this._avgLastFrameId = -1; });
    };
    bindReadoutSelect('pitchDisplaySelect', (v) => { this.pitchDisplayMode = v; });
    bindReadoutSelect('weightModeSelect', (v) => { this.weightMode = v; });
    bindReadoutSelect('attackModeSelect', (v) => { this.attackMode = v; });
    bindReadoutSelect('avgWindowSelect', (v) => { this._avgWindowSecs = parseFloat(v) || 0; });

    // ---- Voice recorder: always-available Record + Play-last controls in the top bar ----
    // Reuses the analyser-based recorder (startRecording/stopRecording) and the recordings
    // drawer (Clips) for the full list; the Play button plays back the most recent clip.
    const voiceRecBtn = document.getElementById('voiceRecBtn');
    if (voiceRecBtn) {
      voiceRecBtn.addEventListener('click', async () => {
        if (this.isRecording) {
          await this.stopRecording();   // pushes the clip + calls updateRecordingsUI → syncs buttons
          this._updateVoiceRecBtn();    // also reset if no clip was saved (silent recording)
        } else if (!this.isRunning) {
          showError('🎙 Press Start to begin a session, then Record.');
        } else {
          this.startRecording();
          this._updateVoiceRecBtn();
        }
      });
    }
    const voicePlayBtn = document.getElementById('voicePlayBtn');
    if (voicePlayBtn) {
      voicePlayBtn.addEventListener('click', () => {
        const lastIdx = this.recordings.length - 1;
        if (lastIdx < 0) return;
        if (this.currentPlayback && this.currentPlayback.index === lastIdx) {
          this.stopPlayback();
        } else {
          this.playRecording(lastIdx);
        }
      });
    }

    // Colorblind mode toggle
    const cbBtn = document.getElementById('cbToggle');
    if (cbBtn) {
      cbBtn.addEventListener('click', () => {
        this.colorblindMode = !this.colorblindMode;
        document.documentElement.classList.toggle('colorblind', this.colorblindMode);
        cbBtn.classList.toggle('active', this.colorblindMode);
      });
    }


    // ====== EXPANDABLE METRICS PANEL ======
    const metersPanel = document.getElementById('metersPanel');
    const metersExpandToggle = document.getElementById('metersExpandToggle');
    const metersExpanded = document.getElementById('metersExpanded');
    const appEl = document.getElementById('app');
    metersExpandToggle?.addEventListener('click', () => {
      this.metersExpanded = !this.metersExpanded;
      metersPanel.classList.toggle('expanded', this.metersExpanded);
      appEl.classList.toggle('meters-open', this.metersExpanded);
      metersExpandToggle.setAttribute('aria-expanded', this.metersExpanded ? 'true' : 'false');
      metersExpandToggle.setAttribute('aria-label', this.metersExpanded ? 'Collapse metrics' : 'Expand metrics');
      // Reflow the game canvas after panel height changes so the ball/ground stay in view.
      requestAnimationFrame(() => this.resize());
      // Expansion animation shifts layout over ~300ms; run one more resize after it settles.
      setTimeout(() => this.resize(), 320);
      // Size canvases after layout settles
      if (this.metersExpanded) {
        requestAnimationFrame(() => this._sizeExpandedCanvases());
      }
    });

    // ====== BALL CAMERA ZOOM CONTROLS ======
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const ZOOM_STEP = 0.15;
    const ZOOM_MIN = 0.55;
    const ZOOM_MAX = 2.2;
    zoomInBtn?.addEventListener('click', () => {
      this.userZoomMultiplier = Math.min(ZOOM_MAX, this.userZoomMultiplier + ZOOM_STEP);
    });
    zoomOutBtn?.addEventListener('click', () => {
      this.userZoomMultiplier = Math.max(ZOOM_MIN, this.userZoomMultiplier - ZOOM_STEP);
    });

    // Metric card click → open popup
    metersExpanded?.querySelectorAll('.metric-card').forEach(card => {
      card.addEventListener('click', () => {
        const metric = card.dataset.metric;
        this._openMetricPopup(metric);
      });
    });

    // Popup close
    const popupBackdrop = document.getElementById('metricPopupBackdrop');
    const popupClose = document.getElementById('metricPopupClose');
    popupClose?.addEventListener('click', () => this._closeMetricPopup());
    popupBackdrop?.addEventListener('click', (e) => {
      if (e.target === popupBackdrop) this._closeMetricPopup();
    });

    const syncMotionToggleLabel = () => {
      if (!motionToggle) return;
      const next = this.userMotionPreference === 'auto' ? 'Auto' : this.userMotionPreference === 'low' ? 'Low' : 'Full';
      motionToggle.textContent = `Motion: ${next}`;
      motionToggle.classList.toggle('active', this.userMotionPreference === 'low');
    };
    syncMotionToggleLabel();
    syncMicSettingsUi();
    updateAdaptiveProfileStatus();
    populateMicDevices();
    motionToggle?.addEventListener('click', () => {
      const order = ['auto', 'low', 'full'];
      const idx = order.indexOf(this.userMotionPreference);
      this.userMotionPreference = order[(idx + 1) % order.length];
      localStorage.setItem('vox:motionPreference', this.userMotionPreference);
      this._applyMotionPreferences();
      syncMotionToggleLabel();
    });

    // ---- Smart Bulb UI ----
    this._setupBulbUI();
    this._setupNecklaceUI();


    // ---- Vibration alert UI ----
    const vibBtn = document.getElementById('vibToggle');
    const vibPanel = document.getElementById('vibPanel');
    const vibMaster = document.getElementById('vibMasterToggle');
    const vibRulesList = document.getElementById('vibRulesList');
    const vibAddBtn = document.getElementById('vibAddRule');
    const gameArea = document.querySelector('.game-area');

    // ---- Settings Panel UI ----
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsPanel = document.getElementById('settingsPanel');
    const modalBackdrop = document.getElementById('modalBackdrop');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');

    const toggleSettings = (show) => {
      const isVisible = show !== undefined ? show : !settingsPanel.classList.contains('show');
      settingsPanel.classList.toggle('show', isVisible);
      settingsBtn?.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      modalBackdrop.classList.toggle('show', isVisible);
      if (settingsBtn) settingsBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      settingsBtn?.setAttribute('aria-expanded', isVisible ? 'true' : 'false');

      if (settingsBtn) {
        settingsBtn.setAttribute('aria-expanded', isVisible);
      }

      // Force DOM visibility (bypass any CSS specificity issues)
      if (isVisible) {
        settingsPanel.removeAttribute('hidden');
        settingsPanel.style.display = 'flex';
        settingsPanel.style.opacity = '1';
        settingsPanel.style.pointerEvents = 'auto';
        syncMicSettingsUi();
        updateAdaptiveProfileStatus();
        populateMicDevices();
        helpTooltip.classList.remove('show');
        if (helpBtn) helpBtn.setAttribute('aria-expanded', 'false');
        recordingsDrawer.classList.remove('show');
        if (recordingsBtn) recordingsBtn.setAttribute('aria-expanded', 'false');
        vibPanel.classList.remove('show');
        if (vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
        document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
        recordingsDrawer.classList.remove('show');
        document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');
        vibPanel.classList.remove('show');
        document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
        vibBtn?.setAttribute('aria-expanded', 'false');
      } else {
        settingsPanel.style.display = 'none';
        settingsPanel.style.opacity = '0';
        settingsPanel.style.pointerEvents = 'none';
        settingsPanel.setAttribute('hidden', '');
      }
    };

    settingsBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettings();
    });

    closeSettingsBtn?.addEventListener('click', () => toggleSettings(false));
    modalBackdrop?.addEventListener('click', () => toggleSettings(false));

    // Global click-to-close for all overlays
    document.addEventListener('click', (e) => {
      // Settings panel (if clicking outside and not the gear)
      if (settingsPanel && !settingsPanel.contains(e.target) && e.target !== settingsBtn && (!settingsBtn || !settingsBtn.contains(e.target))) {
        if (settingsPanel.classList.contains('show')) toggleSettings(false);
      }
      // Vibration panel
      if (vibPanel && !vibPanel.contains(e.target) && (!vibBtn || e.target !== vibBtn)) {
        if (vibPanel.classList.contains('show')) {
          vibPanel.classList.remove('show');
          if (vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
        }
        vibPanel.classList.remove('show');
        if (vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
        document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
        vibBtn?.setAttribute('aria-expanded', 'false');
      }
      // DAF panel
      const _dafPanel = document.getElementById('dafPanel');
      const _dafBtn = document.getElementById('dafBtn');
      if (_dafPanel && !_dafPanel.contains(e.target) && e.target !== _dafBtn && (!_dafBtn || !_dafBtn.contains(e.target))) {
        if (_dafPanel.classList.contains('show')) {
          _dafPanel.classList.remove('show');
          _dafBtn?.setAttribute('aria-expanded', 'false');
        }
      }
    });

    if (vibBtn) {
      vibBtn.addEventListener('click', (e) => {
        e.stopPropagation();

        if (vibPanel) {
          const isVisible = vibPanel.classList.toggle('show');
          vibBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
        }

        if (helpTooltip) {
          helpTooltip.classList.remove('show');
          document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
        }

        if (recordingsDrawer) {
          recordingsDrawer.classList.remove('show');
          document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');
        }

        if (settingsPanel && settingsPanel.classList.contains('show')) {
          toggleSettings(false);
        }
      });
    }

    if (vibMaster) {
      vibMaster.addEventListener('change', () => {
        this.vibration.enabled = vibMaster.checked;
        if (vibBtn) vibBtn.classList.toggle('active', vibMaster.checked);
      });
    }

    const vibMetrics = [
      { value: 'pitch', label: 'Pitch (Hz)', unit: 'Hz', min: 50, max: 500, step: 5, defaultBelow: 150, defaultAbove: 250 },
      { value: 'resonance', label: 'Resonance', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 30, defaultAbove: 70 },
      { value: 'energy', label: 'Energy', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 80 },
      { value: 'bounce', label: 'Pitch Variation', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 80 },
      { value: 'tempo', label: 'Tempo Var.', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 80 },
      { value: 'vowel', label: 'Vowel Sustain', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 70 },
      { value: 'articulation', label: 'Articulation', unit: '%', min: 0, max: 100, step: 5, defaultBelow: 10, defaultAbove: 80 },
    ];

    const getMetricInfo = (val) => vibMetrics.find(m => m.value === val) || vibMetrics[0];

    const renderVibRules = () => {
      vibRulesList.textContent = '';
      const hintEl = document.getElementById('vibEmptyHint');
      if (hintEl) hintEl.style.display = this.vibration.rules.length === 0 ? 'block' : 'none';
      for (const rule of this.vibration.rules) {
        const info = getMetricInfo(rule.metric);
        const el = document.createElement('div');
        el.className = 'vib-rule' + (rule.tripped ? ' tripped' : '');
        el.dataset.ruleId = rule.id;

        const frag = document.createDocumentFragment();

        const configDiv = document.createElement('div');
        configDiv.className = 'vib-rule-config';

        const topDiv1 = document.createElement('div');
        topDiv1.className = 'vib-rule-top';

        const metricSelect = document.createElement('select');
        metricSelect.className = 'vib-metric';
        metricSelect.setAttribute('aria-label', 'Metric');
        for (const m of vibMetrics) {
          const opt = document.createElement('option');
          opt.value = m.value;
          opt.textContent = m.label;
          if (m.value === rule.metric) opt.selected = true;
          metricSelect.append(opt);
        }

        const dirSelect = document.createElement('select');
        dirSelect.className = 'vib-dir';
        dirSelect.setAttribute('aria-label', 'Direction');
        const optBelow = document.createElement('option');
        optBelow.value = 'below';
        optBelow.textContent = 'drops below';
        if (rule.direction === 'below') optBelow.selected = true;
        const optAbove = document.createElement('option');
        optAbove.value = 'above';
        optAbove.textContent = 'goes above';
        if (rule.direction === 'above') optAbove.selected = true;
        dirSelect.append(optBelow, optAbove);

        topDiv1.append(metricSelect, dirSelect);

        const topDiv2 = document.createElement('div');
        topDiv2.className = 'vib-rule-top';

        const thresholdInput = document.createElement('input');
        thresholdInput.type = 'number';
        thresholdInput.className = 'vib-threshold';
        thresholdInput.value = rule.threshold;
        thresholdInput.min = info.min;
        thresholdInput.max = info.max;
        thresholdInput.step = info.step;
        thresholdInput.setAttribute('aria-label', 'Threshold');

        const unitSpan = document.createElement('span');
        unitSpan.className = 'vib-rule-unit';
        unitSpan.textContent = info.unit;

        const liveValSpan = document.createElement('span');
        liveValSpan.className = 'vib-live-val';
        liveValSpan.dataset.ruleId = rule.id;
        liveValSpan.style.cssText = 'font-size:0.62rem;color:rgba(255,255,255,0.35);margin-left:4px;min-width:32px;text-align:right';
        liveValSpan.textContent = '—';

        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'toggle-switch';
        toggleLabel.style.marginLeft = '4px';

        const toggleInput = document.createElement('input');
        toggleInput.type = 'checkbox';
        toggleInput.className = 'vib-rule-toggle';
        toggleInput.setAttribute('aria-label', 'Enable alert rule');
        if (rule.enabled) toggleInput.checked = true;

        const toggleSlider = document.createElement('span');
        toggleSlider.className = 'toggle-slider';

        toggleLabel.append(toggleInput, toggleSlider);
        topDiv2.append(thresholdInput, unitSpan, liveValSpan, toggleLabel);

        configDiv.append(topDiv1, topDiv2);

        const delBtn = document.createElement('button');
        delBtn.className = 'vib-rule-del';
        delBtn.title = 'Delete rule';
        delBtn.setAttribute('aria-label', 'Delete rule');
        delBtn.textContent = '✕';

        frag.append(configDiv, delBtn);
        el.append(frag);

        // Wire events
        el.querySelector('.vib-metric').addEventListener('change', (e) => {
          rule.metric = e.target.value;
          const newInfo = getMetricInfo(rule.metric);
          rule.threshold = rule.direction === 'below' ? newInfo.defaultBelow : newInfo.defaultAbove;
          renderVibRules();
        });
        el.querySelector('.vib-dir').addEventListener('change', (e) => {
          rule.direction = e.target.value;
        });
        el.querySelector('.vib-threshold').addEventListener('input', (e) => {
          rule.threshold = parseFloat(e.target.value) || 0;
        });
        el.querySelector('.vib-rule-toggle').addEventListener('change', (e) => {
          rule.enabled = e.target.checked;
        });
        el.querySelector('.vib-rule-del').addEventListener('click', () => {
          this.vibration.rules = this.vibration.rules.filter(r => r.id !== rule.id);
          renderVibRules();
        });

        vibRulesList.appendChild(el);
      }
    };

    vibAddBtn.addEventListener('click', () => {
      this.vibration.rules.push({
        id: this.vibration.nextId++,
        metric: 'pitch',
        direction: 'below',
        threshold: 150,
        enabled: true,
        cooldownTimer: 0,
        tripped: false,
      });
      renderVibRules();
    });

    // Store render function for external updates
    this._renderVibRules = renderVibRules;
    this._gameArea = gameArea;
    this._vibRulesList = vibRulesList;

    // Lightweight live-value updater (called from game loop, no DOM rebuild)
    this._updateVibLiveUI = () => {
      const m = this.analyzer.metrics;
      const hz = this.analyzer.smoothPitchHz;
      for (const rule of this.vibration.rules) {
        // Update live value readout
        const valEl = vibRulesList.querySelector(`.vib-live-val[data-rule-id="${rule.id}"]`);
        if (valEl) {
          let val;
          switch (rule.metric) {
            case 'pitch': val = Math.round(hz); break;
            case 'resonance': val = Math.round(this.analyzer.smoothResonance * 100); break;
            case 'energy': val = Math.round(m.energy * 100); break;
            case 'bounce': val = Math.round(m.bounce * 100); break;
            case 'tempo': val = 0; break;
            case 'vowel': val = Math.round(m.vowel * 100); break;
            case 'articulation': val = Math.round(m.articulation * 100); break;
            default: val = 0;
          }
          const isActive = m.energy > 0.05;
          valEl.textContent = isActive ? `${val}` : '—';
          valEl.style.color = rule.tripped
            ? 'rgba(255,160,60,0.8)'
            : 'rgba(255,255,255,0.35)';
        }
        // Update tripped highlight on row (lightweight class toggle)
        const rowEl = vibRulesList.querySelector(`[data-rule-id="${rule.id}"]`);
        if (rowEl && rowEl.classList.contains('vib-rule')) {
          rowEl.classList.toggle('tripped', rule.tripped);
        }
      }
    };

    document.getElementById('vibTestBtn').addEventListener('click', () => {
      this._triggerVibration('Test');
    });

    // Preset configurations
    const addPresetRules = (rules) => {
      // Clear existing rules
      this.vibration.rules = [];
      for (const r of rules) {
        this.vibration.rules.push({
          id: this.vibration.nextId++,
          metric: r.metric,
          direction: r.direction,
          threshold: r.threshold,
          enabled: true,
          cooldownTimer: 0,
          tripped: false,
        });
      }
      // Enable master toggle
      this.vibration.enabled = true;
      vibMaster.checked = true;
      vibBtn.classList.add('active');
      renderVibRules();
    };

    document.getElementById('vibPresetFem').addEventListener('click', () => {
      addPresetRules([
        { metric: 'pitch', direction: 'below', threshold: 155 },
        { metric: 'pitch', direction: 'above', threshold: 280 },
        { metric: 'resonance', direction: 'below', threshold: 40 },
      ]);
    });

    // ── DAF (Delayed Auditory Feedback) panel handlers ──
    const dafBtn = document.getElementById('dafBtn');
    const dafPanel = document.getElementById('dafPanel');

    dafBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = dafPanel.classList.toggle('show');
      dafBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      if (isVisible) {
        document.getElementById('dafEnableToggle').checked = this.dafEnabled;
        document.getElementById('dafDelaySlider').value = this.dafDelayMs;
        document.getElementById('dafDelayLabel').textContent = `${this.dafDelayMs}ms`;
        document.getElementById('dafBassFilterToggle').checked = this.dafBassFilter;
        vibPanel?.classList.remove('show');
        if (vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
        helpTooltip?.classList.remove('show');
        recordingsDrawer?.classList.remove('show');
        if (recordingsBtn) recordingsBtn.setAttribute('aria-expanded', 'false');
        settingsPanel?.classList.remove('show');
        if (settingsBtn) settingsBtn.setAttribute('aria-expanded', 'false');
      }
    });

    document.getElementById('dafEnableToggle')?.addEventListener('change', (e) => {
      this.dafEnabled = e.target.checked;
      localStorage.setItem('vox:daf:enabled', String(this.dafEnabled));
      dafBtn?.classList.toggle('active', this.dafEnabled);
      if (this.isRunning) {
        if (this.dafEnabled) this.startDAF();
        else this.stopDAF();
      }
    });

    document.getElementById('dafDelaySlider')?.addEventListener('input', (e) => {
      this.dafDelayMs = parseInt(e.target.value);
      localStorage.setItem('vox:daf:delayMs', String(this.dafDelayMs));
      document.getElementById('dafDelayLabel').textContent = `${this.dafDelayMs}ms`;
      this._dafBuffer = [];
    });

    document.getElementById('dafBassFilterToggle')?.addEventListener('change', (e) => {
      this.dafBassFilter = e.target.checked;
      localStorage.setItem('vox:daf:bassFilter', String(this.dafBassFilter));
      if (this._dafInterval) {
        this.stopDAF();
        this.startDAF();
      }
    });

    if (this.dafEnabled) dafBtn?.classList.add('active');
    // ── end DAF handlers ──

    document.getElementById('vibPresetMasc').addEventListener('click', () => {
      addPresetRules([
        { metric: 'pitch', direction: 'above', threshold: 140 },
        { metric: 'pitch', direction: 'below', threshold: 80 },
        { metric: 'resonance', direction: 'above', threshold: 60 },
      ]);
    });

    recalibrateBtn?.addEventListener('click', async () => {
      if (!this.analyzer.isActive) {
        showError('ℹ Start a session first, then tap Recalibrate.');
        return;
      }
      // Clear stale calibration data so fresh samples are collected
      this.analyzer.resetCalibration();
      const calResult = await this.calibrationWizard.run(this.analyzer);
      this.hasCompletedCalibration = true;
      this.guidedStartTs = performance.now();
      this.guidedDismissed = false;
      this.guidedCloseHitbox = null;
      this.guidedPitchStable = 0;
      this.guidedChecklist.roomReady = this.analyzer.isCalibrated;
      this.guidedChecklist.voiceDetected = false;
      this.guidedChecklist.pitchLocked = false;
      showCalibrationOutcome(calResult);
    });

    this.canvas.addEventListener('click', (e) => {
      if (!this.isRunning || this.guidedDismissed || !this.guidedCloseHitbox) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this.guidedCloseHitbox;
      if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) {
        this.guidedDismissed = true;
        this.guidedCloseHitbox = null;
      }
    });

    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._updateHelpContent();
      const isVisible = helpTooltip.classList.toggle('show');
      helpBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      recordingsDrawer.classList.remove('show');
      const recBtn = document.getElementById('recordingsBtn');
      if (recBtn) recBtn.setAttribute('aria-expanded', 'false');
      vibPanel.classList.remove('show');
      const vibToggle = document.getElementById('vibToggle');
      if (vibToggle) vibToggle.setAttribute('aria-expanded', 'false');
      if (helpBtn) helpBtn.setAttribute('aria-expanded', isVisible);
      if (recordingsDrawer) {
        recordingsDrawer.classList.remove('show');
        if (recordingsBtn) recordingsBtn.setAttribute('aria-expanded', 'false');
      }
      if (vibPanel) {
        vibPanel.classList.remove('show');
        if (typeof vibBtn !== 'undefined' && vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
      }
      const isShown = helpTooltip.classList.toggle('show');
      helpBtn.setAttribute('aria-expanded', isShown ? 'true' : 'false');

      helpTooltip.classList.toggle('show');
      helpBtn.setAttribute('aria-expanded', helpTooltip.classList.contains('show') ? 'true' : 'false');
      recordingsDrawer.classList.remove('show');
      document.getElementById('recordingsBtn')?.setAttribute('aria-expanded', 'false');
      vibPanel.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');

      vibPanel.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');

      if (settingsPanel && settingsPanel.classList.contains('show')) toggleSettings(false);
    });

    helpTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const selected = tab.dataset.tab;
        helpTabs.forEach((btn) => btn.classList.toggle('active', btn === tab));
        helpPanels.forEach((panel) => {
          panel.classList.toggle('active', panel.dataset.panel === selected);
        });
      });
    });

    document.addEventListener('click', (e) => {
      if (helpTooltip && !helpTooltip.contains(e.target) && e.target !== helpBtn) {
        if (helpTooltip.classList.contains('show')) {
          helpTooltip.classList.remove('show');
          if (helpBtn) helpBtn.setAttribute('aria-expanded', 'false');
        }
      }
      if (recordingsDrawer && !recordingsDrawer.contains(e.target) && (!recordingsBtn || !recordingsBtn.contains(e.target))) {
        if (recordingsDrawer.classList.contains('show')) {
          recordingsDrawer.classList.remove('show');
          if (recordingsBtn) recordingsBtn.setAttribute('aria-expanded', 'false');
        }
      }
      if (vibPanel && !vibPanel.contains(e.target) && (!vibBtn || !vibBtn.contains(e.target))) {
        if (vibPanel.classList.contains('show')) {
          vibPanel.classList.remove('show');
          if (typeof vibBtn !== 'undefined' && vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
        }
        helpTooltip.classList.remove('show');
        if (helpBtn) helpBtn.setAttribute('aria-expanded', 'false');
      }
      if (recordingsDrawer && !recordingsDrawer.contains(e.target) && (!recordingsBtn || !recordingsBtn.contains(e.target))) {
        recordingsDrawer.classList.remove('show');
        if (recordingsBtn) recordingsBtn.setAttribute('aria-expanded', 'false');
      }
      if (vibPanel && !vibPanel.contains(e.target) && (!vibBtn || !vibBtn.contains(e.target))) {
        vibPanel.classList.remove('show');
        const vibToggle = document.getElementById('vibToggle');
        if (vibToggle) vibToggle.setAttribute('aria-expanded', 'false');
        helpBtn?.setAttribute('aria-expanded', 'false');
      }
      if (recordingsDrawer && !recordingsDrawer.contains(e.target) && (!recordingsBtn || !recordingsBtn.contains(e.target))) {
        recordingsDrawer.classList.remove('show');
        recordingsBtn?.setAttribute('aria-expanded', 'false');
      }
      if (vibPanel && !vibPanel.contains(e.target) && (!vibBtn || !vibBtn.contains(e.target))) {
        vibPanel.classList.remove('show');
        document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');
        vibBtn?.setAttribute('aria-expanded', 'false');
      }
    });

    // Recording controls
    if (typeof recBtn !== 'undefined' && recBtn) {
      recBtn.addEventListener('click', () => {
        if (this.isRecording) {
          this.stopRecording();
          recBtn.classList.remove('recording');
          recBtn.querySelector('.rec-label').textContent = 'Rec';
        } else {
          this.startRecording();
          recBtn.classList.add('recording');
          recBtn.querySelector('.rec-label').textContent = 'Stop';
        }
      });
    }


    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible' || !this.isRunning) return;
      // Resume AudioContext if it was suspended while tab was hidden
      try {
        if (this.analyzer.audioCtx && this.analyzer.audioCtx.state === 'suspended') {
          await this.analyzer.audioCtx.resume();
        }
      } catch (_) { /* non-blocking */ }
      try {
        if (navigator.permissions?.query) {
          const mic = await navigator.permissions.query({ name: 'microphone' });
          if (mic.state === 'denied') {
            showError('🎙 Microphone permission changed to denied. Re-enable browser mic permission, then press Start.');
          }
        }
      } catch (e) {
        // non-blocking permissions probe
      }
    });

    recordingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = recordingsDrawer.classList.toggle('show');
      recordingsBtn.setAttribute('aria-expanded', isVisible ? 'true' : 'false');
      helpTooltip.classList.remove('show');
      const helpBtnEl = document.getElementById('helpBtn');
      if (helpBtnEl) helpBtnEl.setAttribute('aria-expanded', 'false');
      vibPanel.classList.remove('show');
      const vibBtnEl = document.getElementById('vibToggle');
      if (vibBtnEl) vibBtnEl.setAttribute('aria-expanded', 'false');
      if (recordingsBtn) recordingsBtn.setAttribute('aria-expanded', isVisible);
      if (helpTooltip) {
        helpTooltip.classList.remove('show');
        if (helpBtn) helpBtn.setAttribute('aria-expanded', 'false');
      }
      if (vibPanel) {
        vibPanel.classList.remove('show');
        if (typeof vibBtn !== 'undefined' && vibBtn) vibBtn.setAttribute('aria-expanded', 'false');
      }
      const isShown = recordingsDrawer.classList.toggle('show');
      recordingsBtn.setAttribute('aria-expanded', isShown ? 'true' : 'false');

      recordingsDrawer.classList.toggle('show');
      recordingsBtn.setAttribute('aria-expanded', recordingsDrawer.classList.contains('show') ? 'true' : 'false');
      helpTooltip.classList.remove('show');
      document.getElementById('helpBtn')?.setAttribute('aria-expanded', 'false');
      vibPanel.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');

      vibPanel.classList.remove('show');
      document.getElementById('vibToggle')?.setAttribute('aria-expanded', 'false');

      if (settingsPanel && settingsPanel.classList.contains('show')) toggleSettings(false);
    });

    clearAllRecs.addEventListener('click', () => {
      if (this.recordings.length === 0) return;
      if (window.confirm('Are you sure you want to delete all recordings? This cannot be undone.')) {
        this.clearAllRecordings();
      }
    });


  }

  // FIX: Idle scene animation behind the overlay
  drawIdleScene() {
    // Cancel any existing idle loop first so repeated calls (e.g. toggling color
    // mode while idle) don't stack independent rAF loops.
    if (this.idleAnimId) { cancelAnimationFrame(this.idleAnimId); this.idleAnimId = null; }
    const idleScroll = { x: this.scrollX || 0 };
    let idleTime = 0;
    const animate = () => {
      if (this.isRunning) return;
      idleTime += 0.016;
      idleScroll.x += 0.5;
      this.scrollX = idleScroll.x;
      this.ball.x = this.width * 0.45;
      const ground = this.getGroundHeight(this.scrollX + this.ball.x);
      this.ball.y = ground - this.ball.radius;
      this.ball.rotation += 0.01;
      this.ballHue = 275;
      this.ballSat = 70;
      this.ballLit = 55;
      this.cameraY = 0;
      this.targetCameraY = 0;
      this.cameraZoom = 1.4;
      this.targetZoom = 1.4;
      this.drawSceneInternal(0);
      this.idleAnimId = requestAnimationFrame(animate);
    };
    animate();
  }

  loop() {
    if (!this.isRunning) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    // While the calibration wizard is active it drives analyzer.update() from its
    // own loops — skip the main-loop update so frame time isn't counted twice
    // (double-driving corrupts calibration timers and every EMA-smoothed metric).
    if (!this.calibrationWizard?.isWizardLoopActive) {
      this.analyzer.update(dt);
    }

    // Skip rendering when the tab is hidden to save CPU/GPU.
    // Audio analysis above still runs so calibration state stays warm.
    if (document.hidden) {
      requestAnimationFrame(() => this.loop());
      return;
    }

    this.perfMonitor.sample(dt);

    const targetQualityScale = this.perfMonitor.fps > 0 && this.perfMonitor.fps < 30 ? 0.55 : this.perfMonitor.fps > 0 && this.perfMonitor.fps < 42 ? 0.75 : 1;
    this.dynamicQualityScale += (targetQualityScale - this.dynamicQualityScale) * 0.08;
    this.particleScale = this.baseParticleScale * this.dynamicQualityScale;

    this.update(dt);
    this.drawSceneInternal(this.prosodyScore);
    // Mirror the live ball color onto a smart bulb (throttled internally).
    // Driven from the central loop so it tracks every mode that updates the color.
    const currentResonance = this.analyzer ? this.analyzer.smoothResonance : 0;
    const currentWeight = this.analyzer ? this.analyzer.weightSmoothed : 0.5;
    this.bulbController?.update(this.ballHue, this.ballSat, this.ballLit, currentResonance, dt, currentWeight);
    this._pushAvgSamples();
    this.updateMeters();
    this._updateExpandedMetrics();
    this.renderTeleprompter(dt);
    this.checkVibrationAlerts(dt);
    this.perfMonitor.render(`Particles: ${this.particles.length} · Trail: ${this.trailPoints.length}`);

    // ---- Session stats accumulation ----
    const sess = this.session;
    sess.duration = (Date.now() - sess.startTime) / 1000;

    // Update HUD timer
    const mins = Math.floor(sess.duration / 60);
    const secs = Math.floor(sess.duration % 60);
    const timerEl = document.getElementById('sessionTimer');
    if (timerEl) timerEl.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;

    // Sample pitch and resonance when speaking
    const sessM = this.analyzer.metrics;
    const sessHz = this.analyzer.smoothPitchHz;
    if (sessM.energy > 0.05 && this.analyzer.lastPitch > 0) {
      sess.pitchSum += sessHz;
      sess.pitchCount++;
      if (sessHz < sess.pitchMin) sess.pitchMin = sessHz;
      if (sessHz > sess.pitchMax) sess.pitchMax = sessHz;
      sess.resonanceSum += this.analyzer.smoothResonance;
      sess.resonanceCount++;
    }

    // Sample prosody score every 0.5s for sparkline
    sess.prosodySampleTimer += dt;
    if (sess.prosodySampleTimer >= 0.5) {
      sess.prosodySampleTimer = 0;
      sess.prosodyHistory.push(this.prosodyScore);
      // Cap at 240 samples (2 minutes)
      if (sess.prosodyHistory.length > 240) sess.prosodyHistory.shift();
    }

    // Show calibration notice during noise floor measurement
    if (!this.analyzer.isCalibrated && this.analyzer.isActive) {
      const ctx = this.ctx;
      const progress = Math.min(1, this.analyzer.noiseCalibrationTimer / this.analyzer.noiseCalibrationDuration);
      ctx.save();
      ctx.fillStyle = 'rgba(10,10,18,0.6)';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.fillStyle = '#e8e6f0';
      ctx.font = '600 16px "Outfit", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🎙 Calibrating to room noise...', this.width / 2, this.height / 2 - 12);
      ctx.font = '400 13px "Outfit", sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText('Stay quiet for a moment', this.width / 2, this.height / 2 + 14);
      // Progress bar
      const barW = 160, barH = 4;
      const barX = (this.width - barW) / 2;
      const barY = this.height / 2 + 34;
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = this.colorblindMode ? '#56B4E9' : '#4d96ff';
      ctx.fillRect(barX, barY, barW * progress, barH);
      ctx.restore();
    }

    // Guided onboarding overlay for first 30 seconds
    const guidedElapsed = (performance.now() - this.guidedStartTs) / 1000;
    if (this.isRunning && this.guidedStartTs > 0 && !this.guidedDismissed && guidedElapsed < this.guidedDurationSec) {
      const hasVoice = this.analyzer.metrics.energy > 0.05 || this.analyzer.lastPitch > 0;
      this.guidedChecklist.voiceDetected = this.guidedChecklist.voiceDetected || hasVoice;
      if (this.analyzer.pitchConfidence > 0.65 && this.analyzer.lastPitch > 0) {
        this.guidedPitchStable += dt;
      } else {
        this.guidedPitchStable = Math.max(0, this.guidedPitchStable - dt * 0.5);
      }
      if (this.guidedPitchStable > 0.8) this.guidedChecklist.pitchLocked = true;
      this.guidedChecklist.roomReady = this.guidedChecklist.roomReady || this.analyzer.isCalibrated;

      const ctx = this.ctx;
      const x = 16;
      const y = 68;
      const w = Math.min(360, this.width - 32);
      const h = 120;
      const left = Math.max(8, Math.min(x, this.width - w - 8));
      ctx.save();
      ctx.fillStyle = 'rgba(9, 12, 22, 0.72)';
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(left, y, w, h, 10);
      ctx.fill();
      ctx.stroke();

      const closeSize = 18;
      const closeX = left + w - closeSize - 8;
      const closeY = y + 8;
      this.guidedCloseHitbox = { x: closeX, y: closeY, w: closeSize, h: closeSize };

      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      ctx.roundRect(closeX, closeY, closeSize, closeSize, 6);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '600 12px "Outfit", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('✕', closeX + closeSize * 0.5, closeY + 13);

      const secsLeft = Math.max(0, Math.ceil(this.guidedDurationSec - guidedElapsed));
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e8e6f0';
      ctx.font = '600 14px "Outfit", sans-serif';
      ctx.fillText(`Quick setup guide · ${secsLeft}s`, left + 12, y + 22);
      ctx.font = '500 12px "Outfit", sans-serif';
      const rows = [
        ['Room calibrated', this.guidedChecklist.roomReady],
        ['Voice detected', this.guidedChecklist.voiceDetected],
        ['Pitch lock stable', this.guidedChecklist.pitchLocked],
      ];
      rows.forEach((row, i) => {
        ctx.fillStyle = row[1] ? '#6bcb77' : 'rgba(255,255,255,0.55)';
        ctx.fillText(`${row[1] ? '✅' : '⬜'} ${row[0]}`, left + 14, y + 48 + i * 22);
      });
      if (this.guidedChecklist.roomReady && this.guidedChecklist.voiceDetected && this.guidedChecklist.pitchLocked) {
        ctx.fillStyle = this.colorblindMode ? '#56B4E9' : '#4d96ff';
        ctx.fillText('Great! You are fully tracked.', left + 14, y + 112);
      }
      ctx.restore();
    } else {
      this.guidedCloseHitbox = null;
    }

    // Vibration alert flash overlay
    if (this.vibration.flashAlpha > 0.01) {
      const vib = this.vibration;
      const fa = vib.flashAlpha;
      const ctx = this.ctx;
      ctx.save();

      // Edge flash — orange border glow
      const edgeW = 4 + fa * 4;
      const grad = ctx.createLinearGradient(0, 0, edgeW * 3, 0);
      grad.addColorStop(0, `rgba(255,140,40,${fa * 0.4})`);
      grad.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, edgeW * 3, this.height); // left edge
      const grad2 = ctx.createLinearGradient(this.width, 0, this.width - edgeW * 3, 0);
      grad2.addColorStop(0, `rgba(255,140,40,${fa * 0.4})`);
      grad2.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = grad2;
      ctx.fillRect(this.width - edgeW * 3, 0, edgeW * 3, this.height); // right edge

      // Metric label badge at top center
      if (vib.flashMetric && fa > 0.3) {
        const badgeAlpha = Math.min(1, (fa - 0.3) * 2);
        ctx.font = '600 12px "Outfit", sans-serif';
        ctx.textAlign = 'center';
        const text = `⚠ ${vib.flashMetric}`;
        const tw = ctx.measureText(text).width;
        const bx = this.width / 2 - tw / 2 - 10;
        const by = 32;
        const bw = tw + 20;
        const bh = 22;
        const br = 6;
        ctx.fillStyle = `rgba(50,30,10,${badgeAlpha * 0.7})`;
        ctx.beginPath();
        ctx.moveTo(bx + br, by);
        ctx.lineTo(bx + bw - br, by);
        ctx.arcTo(bx + bw, by, bx + bw, by + br, br);
        ctx.lineTo(bx + bw, by + bh - br);
        ctx.arcTo(bx + bw, by + bh, bx + bw - br, by + bh, br);
        ctx.lineTo(bx + br, by + bh);
        ctx.arcTo(bx, by + bh, bx, by + bh - br, br);
        ctx.lineTo(bx, by + br);
        ctx.arcTo(bx, by, bx + br, by, br);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = `rgba(255,160,60,${badgeAlpha})`;
        ctx.fillText(text, this.width / 2, by + 15);
      }

      ctx.restore();
    }

    requestAnimationFrame(() => this.loop());
  }

  update(dt) {
    const m = this.analyzer.metrics;
    const gravity = 800;

    // ==========================================================
    // PROSODY SCORE — the core pedagogical signal
    // Monotone speech ≈ 0. Expressive prosody → 1.
    // Weighted toward variation metrics, NOT raw energy/volume.
    // During low-confidence frames, slow the smoothing factor so
    // unreliable data doesn't jerk the score around.
    // ==========================================================
    const scoreSmoothing = 0.12 * Math.max(0.2, this.analyzer.frameConfidence);
    this.prosodyScore = computeProsodyScore(this.prosodyScore, m, scoreSmoothing);

    const ps = this.prosodyScore;

    // ==========================================================
    // SCROLL SPEED — prosody + rolling syllable frequency drives movement
    // Monotone: sluggish crawl (20 px/s). High rate: >300 px/s.
    // ==========================================================
    const nowSec = performance.now() / 1000;
    this.syllableTimes = this.syllableTimes || [];
    const currentImpulse = this.analyzer.syllableImpulse;
    if (currentImpulse > 0.9 && !this._hadSyllableTrigger) {
      this.syllableTimes.push(nowSec);
      this._hadSyllableTrigger = true;
    } else if (currentImpulse <= 0.8) {
      this._hadSyllableTrigger = false;
    }
    this.syllableTimes = this.syllableTimes.filter(t => nowSec - t <= 3.0);
    const syllableFreq = this.syllableTimes.length / 3.0;
    const speedFactor = Math.min(1.0, syllableFreq / 3.0);
    this.syllableSpeedFactor = speedFactor;

    this.targetScrollSpeed = 20 + ps * 150 + speedFactor * 250;
    this.scrollSpeed += (this.targetScrollSpeed - this.scrollSpeed) * 0.06;
    this.scrollX += this.scrollSpeed * dt;

    this.ball.x = this.width * 0.45;
    const localGround = this.getGroundHeight(this.scrollX + this.ball.x);

    // ==========================================================
    // SYLLABLE BOUNCE — gated by prosody
    // Monotone syllables = tiny nudge. Prosodic = BIG bounce.
    // At ps=0.4 → ~120px height. At ps=0.8 → ~400px height.
    // ==========================================================
    const sylImpulse = this.analyzer.syllableImpulse;
    if (sylImpulse > 0.5) {
      const bouncePower = 120 + ps * 1800;
      if (this.ball.vy > -bouncePower * 0.5) {
        this.ball.vy = -bouncePower * sylImpulse;
        this.ball.onGround = false;
        this.ball.squash = 0.7 - ps * 0.15;
        if (ps > 0.15) {
          const pY = Math.min(this.ball.y + this.ball.radius, localGround);
          const n = Math.floor((2 + ps * 6) * this.particleScale);
          for (let i = 0; i < n; i++) {
            const angle = Math.PI + Math.random() * Math.PI;
            const pr = this.colorblindMode ? 240 : 255;
            const pg = this.colorblindMode ? 200 + Math.floor(Math.random() * 55) : 120 + Math.floor(Math.random() * 100);
            const pb = this.colorblindMode ? 60 : 100;
            this.particles.push(new Particle(
              this.ball.x, pY,
              pr, pg, pb,
              Math.cos(angle) * (30 + ps * 60 + Math.random() * 50),
              Math.sin(angle) * (30 + ps * 70 + Math.random() * 60),
              0.4 + ps * 0.4,
              1.5 + ps * 3
            ));
          }
        }
      }
    }

    // ==========================================================
    // CONTINUOUS PITCH LIFT — requires real pitch variation
    // Stronger force so expressive speech sustains altitude
    // ==========================================================
    if (m.bounce > 0.2) {
      this.ball.vy -= m.bounce * ps * 1200 * dt;
    }

    if (!this.ball.onGround) {
      this.ball.vy += gravity * dt;
    }

    this.ball.y += this.ball.vy * dt;

    // Ground collision
    const groundContact = localGround - this.ball.radius;
    if (this.ball.y >= groundContact) {
      this.ball.y = groundContact;
      if (Math.abs(this.ball.vy) > 30 && ps > 0.1) {
        this.ball.squash = 0.7;
        const gParts = Math.max(1, Math.floor(3 * this.particleScale));
        for (let i = 0; i < gParts; i++) {
          this.particles.push(new Particle(
            this.ball.x + (Math.random() - 0.5) * 20, localGround,
            200, 200, 220,
            (Math.random() - 0.5) * 50, -Math.random() * 40,
            0.3, 1.5
          ));
        }
      }
      this.ball.vy *= -0.3;
      if (Math.abs(this.ball.vy) < 15) {
        this.ball.vy = 0;
        this.ball.onGround = true;
      }
    } else {
      this.ball.onGround = false;
    }

    this.ball.rotation += (this.scrollSpeed / (this.ball.radius * 2)) * dt;
    this.ball.squash += (1 - this.ball.squash) * 5 * dt;

    // Camera Y tracking
    const upperLimit = this.height * 0.3;
    const ballScreenY = this.ball.y;
    if (ballScreenY < upperLimit) {
      this.targetCameraY = ballScreenY - upperLimit;
    } else {
      this.targetCameraY = 0;
    }
    const camSpeed = this.targetCameraY < this.cameraY ? 0.18 : 0.06;
    this.cameraY += (this.targetCameraY - this.cameraY) * camSpeed;
    this.cameraY = Math.min(0, this.cameraY);
    const ballScreenY2 = this.ball.y - this.cameraY;
    if (ballScreenY2 < this.ball.radius * 2) {
      this.cameraY = this.ball.y - this.ball.radius * 2;
    }

    // Dynamic zoom — zoom in when grounded, zoom out when high
    // Also zoom out slightly at high speed for dramatic effect
    const heightAboveGround = Math.max(0, localGround - this.ball.radius - this.ball.y);
    const heightRatio = Math.min(1, heightAboveGround / (this.height * 0.5));
    const scrollSpeedFactor = Math.min(1, this.scrollSpeed / 300);
    this.targetZoom = (1.48 - heightRatio * 0.3 - scrollSpeedFactor * 0.08) * this.userZoomMultiplier; // 1.48 → 1.10, scaled by manual zoom
    this.cameraZoom += (this.targetZoom - this.cameraZoom) * 0.04;

    // ==========================================================
    // BALL SIZE — monotone: small (16). Prosodic: 22-40.
    // ==========================================================
    const prosodyRadius = 16 + ps * 10;
    const vowelBonus = m.vowel * 14;
    this.ball.targetRadius = prosodyRadius + vowelBonus;
    this.ball.radius += (this.ball.targetRadius - this.ball.radius) * 0.1;

    // ==========================================================
    // VOWEL TRAIL — only with real prosody
    // ==========================================================
    if (m.vowel > 0.2 && ps > 0.1) {
      this.trailPoints.push({
        wx: this.ball.x + this.scrollX,
        sy: this.ball.y + this.ball.radius,
        size: this.ball.radius * 0.5 * m.vowel * Math.min(1, ps * 3),
        life: 1.0,
        hue: this.ballHue
      });
    }

    for (let i = this.trailPoints.length - 1; i >= 0; i--) {
      this.trailPoints[i].life -= dt * 1.5;
      if (this.trailPoints[i].life <= 0) this.trailPoints.splice(i, 1);
    }
    if (this.trailPoints.length > 60) this.trailPoints.splice(0, this.trailPoints.length - 60);

    // ==========================================================
    // SPARKLES — gated by prosody
    // ==========================================================
    if (m.articulation > 0.3 && ps > 0.1) {
      const sparkleCount = Math.floor(m.articulation * ps * 6 * this.particleScale);
      for (let i = 0; i < sparkleCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = this.ball.radius + Math.random() * 20;
        this.sparkles.push({
          x: this.ball.x + Math.cos(angle) * dist,
          y: this.ball.y + this.ball.radius * 0.5 + Math.sin(angle) * dist,
          life: 0.4 + Math.random() * 0.3,
          maxLife: 0.5,
          size: 1 + ps * 3
        });
      }
    }

    for (let i = this.sparkles.length - 1; i >= 0; i--) {
      this.sparkles[i].life -= dt;
      if (this.sparkles[i].life <= 0) this.sparkles.splice(i, 1);
    }
    if (this.sparkles.length > MAX_SPARKLES) this.sparkles.splice(0, this.sparkles.length - MAX_SPARKLES);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      this.particles[i].update(dt);
      if (this.particles[i].life <= 0) this.particles.splice(i, 1);
    }
    if (this.particles.length > 80) this.particles.splice(0, this.particles.length - 80);

    // ==========================================================
    // BALL COLOR — hue from pitch or perceived gender (see _computeBallHue),
    // prosody drives saturation and brightness
    // ==========================================================
    const pitchHue = this._computeBallHue(dt);
    this.ballHue = pitchHue;
    this.ballSat = 25 + ps * 75;   // 25% (muted) → 100% (vivid)
    this.ballLit = this.colorblindMode
      ? (40 + ps * 30) + (pitchHue < 100 ? 10 : 0) // extra luminance boost at yellow end
      : 40 + ps * 30;
  }

  // ==========================================================
  // BALL HUE — single source of truth for ball color.
  //
  // colorMode 'pitch' (default): hue follows F0
  //   ≤100 Hz → 210 (deep blue), 145 → 250, 160 → 275 (androgynous center),
  //   175 → 310, ≥250 → 340 (hot pink)
  //
  // colorMode 'gender': hue follows perceived vocal gender (pitch + resonance)
  //   blue (masculine) → purple ~275 (androgynous/nonbinary) → pink (feminine)
  //
  // Each mode has a colorblind sub-ramp (luminance-mapped blue→yellow).
  // ==========================================================
  _computeBallHue(dt) {
    if (this.colorMode === 'gender') {
      return this._updateGenderHue();
    }
    const hz = this.analyzer.smoothPitchHz;
    let pitchHue;
    if (this.colorblindMode) {
      // Colorblind: blue(220)→cyan(190)→yellow(55) — luminance-mapped
      // Works for protanopia, deuteranopia, tritanopia, and grayscale
      if (hz <= 100) {
        pitchHue = 220;
      } else if (hz <= 160) {
        pitchHue = 220 - ((hz - 100) / 60) * 30;  // 220 → 190
      } else if (hz <= 220) {
        pitchHue = 190 - ((hz - 160) / 60) * 135; // 190 → 55
      } else {
        pitchHue = 55;
      }
    } else {
      if (hz <= 100) {
        pitchHue = 210;
      } else if (hz <= 145) {
        pitchHue = 210 + ((hz - 100) / 45) * 40;  // 210 → 250
      } else if (hz <= 175) {
        pitchHue = 250 + ((hz - 145) / 30) * 60;  // 250 → 310
      } else if (hz <= 250) {
        pitchHue = 310 + ((hz - 175) / 75) * 30;  // 310 → 340
      } else {
        pitchHue = 340;
      }
    }
    return pitchHue;
  }

  // Perceived-gender hue: combine all enabled acoustic cues into a 0..1 score, smooth it,
  // then map to a hue. Smoothing rate rises with confidence so the hue settles quickly on
  // confident voiced frames and coasts gently when the signal is weak. Every cue feeds only
  // this score, so the smart bulb and colorblind ramp inherit it automatically.
  _updateGenderHue() {
    const a = this.analyzer;
    const g = this.genderCues;

    // Build per-cue {value (0..1 femininity), confidence}.
    // pitchZone: absolute F0 position (110–230 Hz → 0–1) from modal F0 — no longer relative
    //   to the user's own range, so it carries real gender-perceptual information.
    // resonance: aVTL-primary score (vowel-robust).
    // weight: lower = lighter/breathier (more feminine); higher = heavier/pressed (more masculine).
    // dispersion and cpp are now absorbed into resonance and weight respectively.
    const cues = {
      pitchZone: { value: clamp01(a.metrics.pitchZone), confidence: a.modalF0Confidence },
      resonance: { value: clamp01(a.smoothResonance), confidence: a.formantConfidence },
      weight: { value: 1 - clamp01(a.metrics.weight), confidence: a.spectralTiltConfidence }, // invert: low weight = light/feminine
      sibilant: { value: computeSibilantFemininity(a.sibilantCentroidHz), confidence: a.sibilantConfidence },
      intonation: { value: clamp01(a.metrics.bounce), confidence: a.pitchConfidence },
    };

    const enabledMap = {
      pitchZone: true,
      resonance: true,
      weight: g.weight != null ? g.weight : true,
      sibilant: g.sibilant,
      intonation: g.intonation,
    };

    const gMode = this.goalMode || 'feminization';
    const gWeights = gMode === 'masculinization' ? MASCULINIZATION_CUE_WEIGHTS : FEMINIZATION_CUE_WEIGHTS;
    const { score, uncertainty } = computeGenderScoreMulti({
      cues,
      weights: gWeights,
      enabledMap,
      goalMode: gMode,
      modalF0Hz: a.modalF0Hz,
    });

    const conf = clamp01(1 - uncertainty);
    const lerp = 0.05 + conf * 0.08;
    this.smoothGenderScore += (score - this.smoothGenderScore) * lerp;
    this.genderUncertainty = uncertainty;
    return genderScoreToHue(this.smoothGenderScore, this.colorblindMode);
  }

  drawSceneInternal(prosodyGlow) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (!w || !h) return;

    // Background — theme-aware
    const themePresets = {
      highcontrast: ['#030305', '#080814', '#0c0c1f', '#12122a']
    };
    const colors = themePresets[this.themeMode] || themePresets.highcontrast;
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, colors[0]);
    bgGrad.addColorStop(0.4, colors[1]);
    bgGrad.addColorStop(0.7, colors[2]);
    bgGrad.addColorStop(1, colors[3]);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Stars
    const time = performance.now() / 1000;
    for (const star of this.stars) {
      const sx = ((star.x - this.scrollX * 0.05) % (w + 100) + w + 100) % (w + 100);
      const twinkle = 0.4 + 0.6 * Math.sin(time * 2.2 + star.twinkle + prosodyGlow * 2);
      ctx.globalAlpha = twinkle * 0.6;
      ctx.fillStyle = '#e8e6f0';
      ctx.beginPath();
      ctx.arc(sx, star.y, star.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Mountain ranges — parallax layers for speed perception
    if (this.mountainLayers) {
      for (const mtn of this.mountainLayers) {
        const baseY = h * mtn.baseY;
        const scrollOffset = this.scrollX * mtn.parallax;
        ctx.beginPath();
        ctx.moveTo(-20, h);
        for (let x = -20; x <= w + 20; x += 3) {
          const worldX = x + scrollOffset;
          let my = 0;
          for (const l of mtn.layers) {
            my += l.amp * Math.sin(worldX * l.freq + l.phase);
          }
          ctx.lineTo(x, baseY - Math.abs(my));
        }
        ctx.lineTo(w + 20, h);
        ctx.closePath();
        ctx.fillStyle = mtn.color;
        ctx.fill();
        // Subtle top edge highlight
        ctx.beginPath();
        for (let x = -20; x <= w + 20; x += 3) {
          const worldX = x + scrollOffset;
          let my = 0;
          for (const l of mtn.layers) {
            my += l.amp * Math.sin(worldX * l.freq + l.phase);
          }
          const gy = baseY - Math.abs(my);
          if (x === -20) ctx.moveTo(x, gy); else ctx.lineTo(x, gy);
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.03)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // === Camera transform — zoom + vertical follow ===
    ctx.save();
    const zoomPivotX = this.ball.x;
    const zoomPivotY = this.groundY;
    ctx.translate(zoomPivotX, zoomPivotY);
    ctx.scale(this.cameraZoom, this.cameraZoom);
    ctx.translate(-zoomPivotX, -zoomPivotY);
    ctx.translate(0, -this.cameraY);

    // Ground fill — extend bottom well past viewport for camera shifts + zoom
    const groundFillBottom = h / this.cameraZoom + Math.abs(this.cameraY) + 200;
    // Ground fill with extended range for zoom
    const margin = w * 0.3; // extra margin for zoom edges
    ctx.beginPath();
    ctx.moveTo(-margin, groundFillBottom);
    for (let x = -margin; x <= w + margin; x += 4) {
      ctx.lineTo(x, this.getGroundHeight(this.scrollX + x));
    }
    ctx.lineTo(w + margin, groundFillBottom);
    ctx.closePath();
    const groundGrad = ctx.createLinearGradient(0, this.groundY - 40, 0, groundFillBottom);
    const gc = this._groundColors || ['#1e1e3a', '#191932', '#121228'];
    groundGrad.addColorStop(0, gc[0]);
    groundGrad.addColorStop(0.2, gc[1]);
    groundGrad.addColorStop(1, gc[2]);
    ctx.fillStyle = groundGrad;
    ctx.fill();

    // Ground line — brighter for visibility
    ctx.beginPath();
    for (let x = -margin; x <= w + margin; x += 4) {
      const gy = this.getGroundHeight(this.scrollX + x);
      if (x === -margin) ctx.moveTo(x, gy); else ctx.lineTo(x, gy);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Trail
    for (const tp of this.trailPoints) {
      const screenX = tp.wx - this.scrollX;
      if (screenX < -50 || screenX > w + 50) continue;
      ctx.globalAlpha = tp.life * 0.4;
      ctx.fillStyle = `hsl(${tp.hue}, 80%, 60%)`;
      ctx.beginPath();
      ctx.arc(screenX, tp.sy, tp.size * tp.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Speed lines — horizontal streaks when moving fast
    if (this.scrollSpeed > 150) {
      const speedIntensity = Math.min(1, (this.scrollSpeed - 150) / 200); // 0→1 from 150→350 px/s
      const lineCount = Math.floor(3 + speedIntensity * 8);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.04 + speedIntensity * 0.12})`;
      ctx.lineWidth = 1 + speedIntensity;
      for (let i = 0; i < lineCount; i++) {
        // Distribute lines around the ball with some randomness
        const seed = (i * 7919 + Math.floor(this.scrollX * 0.1)) % 1000 / 1000; // deterministic per frame
        const yOffset = (seed - 0.5) * this.height * 0.6;
        const lineY = this.ball.y + yOffset;
        const lineLen = 30 + speedIntensity * 80 + seed * 40;
        const lineX = this.ball.x - this.ball.radius * 2 - 20 - seed * 60;
        ctx.globalAlpha = (0.08 + speedIntensity * 0.2) * (1 - Math.abs(yOffset) / (this.height * 0.35));
        if (ctx.globalAlpha > 0.02) {
          ctx.beginPath();
          ctx.moveTo(lineX, lineY);
          ctx.lineTo(lineX - lineLen, lineY);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Particles
    for (const p of this.particles) p.draw(ctx);

    // Shadow
    const groundAtBall = this.getGroundHeight(this.scrollX + this.ball.x);
    const shadowDist = groundAtBall - (this.ball.y + this.ball.radius);
    const shadowAlpha = Math.max(0, 0.3 - shadowDist * 0.002);
    const shadowScale = Math.max(0.3, 1 - shadowDist * 0.003);
    if (shadowAlpha > 0.01) {
      ctx.globalAlpha = shadowAlpha;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(this.ball.x, groundAtBall, this.ball.radius * shadowScale * 1.2, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Ball
    ctx.save();
    ctx.translate(this.ball.x, this.ball.y + this.ball.radius * (1 - this.ball.squash) * 0.5);
    ctx.scale(1 + (1 - this.ball.squash) * 0.3, this.ball.squash);

    // Ball glow — boosted for visibility against dark scene
    const glowSize = this.ball.radius * (2.2 + prosodyGlow * 1.5);
    const glowGrad = ctx.createRadialGradient(0, 0, this.ball.radius * 0.2, 0, 0, glowSize);
    glowGrad.addColorStop(0, this.getBallColor(0.35));
    glowGrad.addColorStop(0.4, this.getBallColor(0.12));
    glowGrad.addColorStop(0.7, this.getBallColor(0.04));
    glowGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(0, 0, glowSize, 0, Math.PI * 2);
    ctx.fill();

    // Ball body — bright with rim light
    const ballGrad = ctx.createRadialGradient(
      -this.ball.radius * 0.25, -this.ball.radius * 0.25, 0,
      0, 0, this.ball.radius
    );
    ballGrad.addColorStop(0, '#fff');
    ballGrad.addColorStop(0.12, this.getBallColor());
    ballGrad.addColorStop(0.85, this.getBallColor());
    ballGrad.addColorStop(1, '#222');
    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.arc(0, 0, this.ball.radius, 0, Math.PI * 2);
    ctx.fill();

    // Rim light — subtle bright edge
    ctx.strokeStyle = this.getBallColor(0.4);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, this.ball.radius - 0.5, 0, Math.PI * 2);
    ctx.stroke();

    // Resonance ring — shows vocal tract resonance (F1/F2/F3)
    // Inner ring: F2-based (primary), Outer ring: F3-based (secondary)
    // Cool blue-violet = low/dark resonance → warm gold = high/bright resonance
    const res = this.analyzer.smoothResonance;
    const resConf = this.analyzer.formantConfidence;
    const resAlpha = (0.10 + res * 0.35 + prosodyGlow * 0.1) * (0.3 + resConf * 0.7);
    if (resAlpha > 0.04) {
      // F2 ring (primary): colorblind = blue(220)→yellow(55), normal = blue(240)→gold(45)
      let resHue, resSat, resLit;
      if (this.colorblindMode) {
        resHue = 220 - res * 165; // 220 (blue) → 55 (yellow)
        resSat = 70 + res * 30;
        resLit = 45 + res * 35;   // darker blue → brighter yellow (luminance-mapped)
      } else {
        resHue = 240 - res * 195;
        resSat = 60 + res * 40;
        resLit = 50 + res * 30;
      }
      const ringRadius = this.ball.radius + 4 + res * 6 + prosodyGlow * 3;
      ctx.strokeStyle = `hsla(${resHue}, ${resSat}%, ${resLit}%, ${resAlpha})`;
      ctx.lineWidth = 1.5 + res * 2;
      ctx.beginPath();
      ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
      // F2 glow
      const ringGlow = ctx.createRadialGradient(0, 0, ringRadius - 2, 0, 0, ringRadius + 8 + res * 6);
      ringGlow.addColorStop(0, `hsla(${resHue}, ${resSat}%, ${resLit}%, ${resAlpha * 0.4})`);
      ringGlow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = ringGlow;
      ctx.beginPath();
      ctx.arc(0, 0, ringRadius + 8 + res * 6, 0, Math.PI * 2);
      ctx.fill();

      // F3 outer ring — appears when F3 is high (> 2500 Hz) and confident
      // Separate visual from F2 ring: thinner, more cyan/white toned
      const f3Norm = Math.max(0, Math.min(1, (this.analyzer.smoothF3 - 2200) / 1200));
      const f3Alpha = f3Norm * resConf * 0.45;
      if (f3Alpha > 0.03) {
        const f3Radius = ringRadius + 6 + res * 6 + f3Norm * 4;
        const f3Hue = 200 - f3Norm * 30; // cyan → bright blue-white
        ctx.strokeStyle = `hsla(${f3Hue}, ${40 + f3Norm * 30}%, ${65 + f3Norm * 25}%, ${f3Alpha})`;
        ctx.lineWidth = 0.8 + f3Norm * 1.2;
        ctx.beginPath();
        ctx.arc(0, 0, f3Radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Rotation stripe
    ctx.save();
    ctx.rotate(this.ball.rotation);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, this.ball.radius * 0.7, -0.5, 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, this.ball.radius * 0.7, Math.PI - 0.5, Math.PI + 0.5);
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    // Sparkles
    for (const s of this.sparkles) {
      const alpha = s.life / s.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#fff';
      const cx = s.x, cy = s.y, sz = s.size * alpha;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        const r = i % 2 === 0 ? sz : sz * 0.3;
        ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // === End camera transform ===
    ctx.restore();
  }

  _pitchHzToNoteLabel(hz) {
    if (!hz || !Number.isFinite(hz)) return '—';
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const note = names[(midi + 1200) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${note}${octave}`;
  }

  _triggerMetricHighlight(metric, threshold = 0.75) {
    const val = this.analyzer.metrics[metric] || 0;
    const isExtreme = val >= threshold;
    if (isExtreme && !this.metricExtremeLatch[metric]) {
      this.metricHighlightTimers[metric] = 0.35;
    }
    this.metricExtremeLatch[metric] = isExtreme;
  }
  // ============================================================
  // VIBRATION ALERT ENGINE
  // ============================================================
  checkVibrationAlerts(dt) {
    const vib = this.vibration;

    // Decay flash alpha always (even when disabled, to fade out)
    vib.flashAlpha = Math.max(0, vib.flashAlpha - dt * 3);

    if (!vib.enabled || vib.rules.length === 0) return;

    vib.globalCooldown = Math.max(0, vib.globalCooldown - dt);

    if (vib.shakeTimer > 0) {
      vib.shakeTimer -= dt;
      if (vib.shakeTimer <= 0 && this._gameArea) {
        this._gameArea.classList.remove('vib-shake');
      }
    }

    const m = this.analyzer.metrics;
    const hz = this.analyzer.smoothPitchHz;
    const isSpeaking = m.energy > 0.05;
    let anyTrippedNow = false;
    let needsRender = false;
    let trippedLabel = '';

    for (const rule of vib.rules) {
      if (!rule.enabled) {
        if (rule.tripped) { rule.tripped = false; needsRender = true; }
        continue;
      }

      rule.cooldownTimer = Math.max(0, rule.cooldownTimer - dt);

      let currentVal;
      switch (rule.metric) {
        case 'pitch': currentVal = hz; break;
        case 'resonance': currentVal = this.analyzer.smoothResonance * 100; break;
        case 'energy': currentVal = m.energy * 100; break;
        case 'bounce': currentVal = m.bounce * 100; break;
        case 'tempo': currentVal = 0; break;
        case 'vowel': currentVal = m.vowel * 100; break;
        case 'articulation': currentVal = m.articulation * 100; break;
        default: currentVal = 0;
      }

      let conditionMet = false;
      if (isSpeaking) {
        conditionMet = rule.direction === 'below'
          ? currentVal < rule.threshold
          : currentVal > rule.threshold;
      }

      const wasTripped = rule.tripped;
      rule.tripped = conditionMet;
      if (wasTripped !== conditionMet) needsRender = true;

      if (conditionMet) {
        anyTrippedNow = true;
        const metricLabels = {
          pitch: 'Pitch', resonance: 'Resonance', energy: 'Energy',
          bounce: 'Pitch Var.', tempo: 'Tempo', vowel: 'Vowels', articulation: 'Articulation'
        };
        trippedLabel = metricLabels[rule.metric] || rule.metric;

        if (rule.cooldownTimer <= 0 && vib.globalCooldown <= 0) {
          this._triggerVibration(trippedLabel);
          rule.cooldownTimer = 0.5;
          vib.globalCooldown = 0.25;
        }
      }
    }

    // Update live values when vib panel is visible (throttled to ~10fps)
    if (this._updateVibLiveUI) {
      vib._liveUpdateTimer = (vib._liveUpdateTimer || 0) + dt;
      if (vib._liveUpdateTimer > 0.1) {
        vib._liveUpdateTimer = 0;
        const vibPanelEl = document.getElementById('vibPanel');
        if (vibPanelEl && vibPanelEl.classList.contains('show')) {
          this._updateVibLiveUI();
        } else if (needsRender) {
          // Even if panel closed, update tripped state for next open
          this._updateVibLiveUI();
        }
      }
    }
  }

  _triggerVibration(metricLabel) {
    const vib = this.vibration;

    if (vib.hasHaptic) {
      try { navigator.vibrate([40, 30, 40]); } catch (e) { }
    }

    // Screen shake (skip if reduced motion)
    if (this._gameArea && !this.reducedMotion) {
      this._gameArea.classList.remove('vib-shake');
      void this._gameArea.offsetWidth;
      this._gameArea.classList.add('vib-shake');
      vib.shakeTimer = 0.15;
    }

    // On-canvas flash (always show — it's a brief opacity change, not motion)
    vib.flashAlpha = 1;
    vib.flashMetric = metricLabel || '';
  }

  // ============================================================
  // SESSION SUMMARY
  // ============================================================
  _showSessionSummary() {
    const sess = this.session;
    const overlay = document.getElementById('summaryOverlay');
    const grid = document.getElementById('summaryGrid');
    const bar = document.getElementById('summaryProsodyBar');

    // Format duration
    const mins = Math.floor(sess.duration / 60);
    const secs = Math.floor(sess.duration % 60);
    document.getElementById('summaryDuration').textContent =
      mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    // Build stats grid based on mode
    const stats = [];

    // Pitch stats (all modes)
    if (sess.pitchCount > 0) {
      const avgPitch = Math.round(sess.pitchSum / sess.pitchCount);
      const minP = sess.pitchMin === Infinity ? 0 : Math.round(sess.pitchMin);
      const maxP = Math.round(sess.pitchMax);
      stats.push({ value: `${avgPitch} Hz`, label: 'Avg Pitch' });
      stats.push({ value: `${minP}–${maxP}`, label: 'Pitch Range (Hz)' });
    } else {
      stats.push({ value: '—', label: 'Avg Pitch' });
      stats.push({ value: '—', label: 'Pitch Range' });
    }

    // Resonance (all modes)
    if (sess.resonanceCount > 0) {
      const avgRes = Math.round((sess.resonanceSum / sess.resonanceCount) * 100);
      stats.push({ value: `${avgRes}%`, label: 'Avg Resonance' });
    } else {
      stats.push({ value: '—', label: 'Avg Resonance' });
    }

    // Average prosody
    if (sess.prosodyHistory.length > 0) {
      // ⚡ Bolt: Replace reduce with traditional loop for performance
      let prosodySum = 0;
      for (let i = 0; i < sess.prosodyHistory.length; i++) {
        prosodySum += sess.prosodyHistory[i];
      }
      const avgProsody = Math.round((prosodySum / sess.prosodyHistory.length) * 100);
      stats.push({ value: `${avgProsody}%`, label: 'Avg Prosody' });
    } else {
      stats.push({ value: '—', label: 'Avg Prosody' });
    }

    // Render stats grid (Security enhancement: safe DOM construction)
    grid.textContent = '';
    const gridFrag = document.createDocumentFragment();
    for (const s of stats) {
      const statDiv = document.createElement('div');
      statDiv.className = 'summary-stat' + (s.wide ? ' wide' : '');
      const valDiv = document.createElement('div');
      valDiv.className = 'summary-stat-value';
      valDiv.textContent = s.value;
      const labelDiv = document.createElement('div');
      labelDiv.className = 'summary-stat-label';
      labelDiv.textContent = s.label;
      statDiv.append(valDiv, labelDiv);
      gridFrag.append(statDiv);
    }
    grid.append(gridFrag);

    // Render prosody sparkline
    const history = sess.prosodyHistory;
    if (history.length > 2) {
      document.getElementById('summaryProsodyWrap').style.display = '';
      const barFrag = document.createDocumentFragment();
      const bar = document.getElementById('summaryProsodyBar');
      bar.textContent = '';

      // Downsample to ~60 bars max
      const maxBars = 60;
      const step = Math.max(1, Math.floor(history.length / maxBars));
      const bars = [];
      for (let i = 0; i < history.length; i += step) {
        const slice = history.slice(i, i + step);
        let sliceSum = 0;
        for (let j = 0; j < slice.length; j++) {
          sliceSum += slice[j];
        }
        const v = sliceSum / slice.length;
        bars.push(v);
      }
      // ...
      for (const v of bars) {
        const h = Math.max(2, v * 30);
        const hue = 220 + v * 80; // blue → purple as prosody increases
        const seg = document.createElement('div');
        seg.className = 'bar-seg';
        seg.style.height = `${h}px`;
        seg.style.backgroundColor = `hsl(${Math.round(hue)}, 60%, ${Math.round(45 + v * 20)}%)`;
        barFrag.append(seg);
      }
      bar.append(barFrag);
    } else {
      document.getElementById('summaryProsodyWrap').style.display = 'none';
    }

    overlay.classList.add('show');
  }

  // Split a passage into sentences, keeping terminal punctuation with each
  // sentence and capturing any trailing fragment that lacks final punctuation.
  _splitSentences(text) {
    if (!text) return [];
    const parts = text.match(/[^.!?]+[.!?]+(?:["')\]]+)?|\S[^.!?]*$/g);
    return (parts || [text]).map((s) => s.trim()).filter(Boolean);
  }

  _teleprompterSourceText() {
    return this.teleprompterMode === 'custom' ? this.teleprompterCustomText : this.teleprompterRainbowText;
  }

  // Manual advance: speaker presses Space (desktop) or taps (mobile) to reveal
  // the next sentence. Wraps back to the start at the end of the passage.
  _advanceTeleprompterManual() {
    const enabled = this.teleprompterMode !== 'off';
    if (!enabled) return;
    const sentences = this._splitSentences(this._teleprompterSourceText());
    if (!sentences.length) return;
    this.teleprompterSentenceIndex = (this.teleprompterSentenceIndex + 1) % sentences.length;
  }

  renderTeleprompter(dt) {
    const overlay = document.getElementById('teleprompterOverlay');
    if (!overlay) return;
    const hint = document.getElementById('teleprompterHint');
    const enabled = this.teleprompterMode !== 'off';
    overlay.classList.toggle('show', enabled);
    if (hint) hint.classList.toggle('show', enabled && this.isRunning);
    if (!enabled) { this._tpLastIdx = -1; return; }

    // This runs every frame — only re-split and rebuild the overlay DOM when the
    // passage text or sentence index actually changed.
    const sourceText = this._teleprompterSourceText();
    if (this.teleprompterSentenceIndex === this._tpLastIdx && sourceText === this._tpLastText) return;

    const sentences = this._splitSentences(sourceText);
    if (!sentences.length) return;
    if (this.teleprompterSentenceIndex >= sentences.length) {
      this.teleprompterSentenceIndex = sentences.length - 1;
    }
    const idx = this.teleprompterSentenceIndex;
    this._tpLastIdx = idx;
    this._tpLastText = sourceText;

    overlay.textContent = '';
    const frag = document.createDocumentFragment();
    const cur = document.createElement('span');
    cur.className = 'active-sentence';
    cur.textContent = sentences[idx];
    frag.append(cur);
    if (idx + 1 < sentences.length) {
      frag.append(document.createTextNode(' '));
      const nxt = document.createElement('span');
      nxt.className = 'next-sentence';
      nxt.textContent = sentences[idx + 1];
      frag.append(nxt);
    }
    overlay.append(frag);
  }

  updateMeters() {
    this._triggerMetricHighlight('articulation', 0.72);

    // Cache the DOM lookups — this runs every frame, and getElementById/querySelector
    // ten times per frame is pure waste. The static 3px indicator width is set once here too.
    if (!this._meterEls) {
      this._meterEls = {
        pitch: document.getElementById('meterPitch'),
        valPitch: document.getElementById('valPitch'),
        resonance: document.getElementById('meterResonance'),
        valResonance: document.getElementById('valResonance'),
        highlight: {
          tempo: document.querySelector('.meter-tempo .meter-label'),
          articulation: document.querySelector('.meter-artic .meter-label'),
        },
        mapSplatter: document.getElementById('mapSplatter'),
        pitchStatus: document.getElementById('pitchProfileLearned'),
        tiltStatus: document.getElementById('tiltProfileLearned'),
        confidenceStatus: document.getElementById('frameConfidenceLabel'),
      };
      this._meterEls.pitch.style.width = '3px';
      this._meterEls.resonance.style.width = '3px';
    }
    const els = this._meterEls;

    // Pitch meter — position-based indicator (not fill width). The bar tracks the live pitch;
    // the numeric readout shows a windowed average (formatted per the Pitch display mode).
    // Map 80-300 Hz to 0-100% position on the gradient bar
    const hz = this.analyzer.smoothPitchHz;
    const pitchPos = pitchHzToPosition(hz, 80, 300);
    els.pitch.style.left = (pitchPos * 100) + '%';
    els.valPitch.textContent = this._pitchReadout();

    // Resonance meter — position-based indicator like pitch; numeric readout = windowed avg F1/F2
    const res = this.analyzer.smoothResonance;
    els.resonance.style.left = (res * 100) + '%';
    els.valResonance.textContent = this._resonanceReadout('hud');

    for (const [k, el] of Object.entries(els.highlight)) {
      this.metricHighlightTimers[k] = Math.max(0, this.metricHighlightTimers[k] - 1 / 60);
      if (el) el.classList.toggle('active-ping', this.metricHighlightTimers[k] > 0);
    }
    if (els.mapSplatter) els.mapSplatter.classList.toggle('active-ping', this.metricHighlightTimers.articulation > 0);

    const pitchStatus = els.pitchStatus;
    const tiltStatus = els.tiltStatus;
    const confidenceStatus = els.confidenceStatus;
    if (pitchStatus || tiltStatus || confidenceStatus) {
      const pitch = this.analyzer.pitchProfile;
      const tilt = this.analyzer.tiltProfile;
      if (pitchStatus) {
        const pct = Math.min(100, Math.round((pitch.voicedTime / Math.max(0.1, pitch.learningDuration)) * 100));
        pitchStatus.textContent = pitch.isLearned
          ? `${Math.round(pitch.min)}–${Math.round(pitch.max)} Hz learned`
          : `Learning… ${pct}%`;
      }
      if (tiltStatus) {
        const pct = Math.min(100, Math.round((tilt.voicedTime / Math.max(0.1, tilt.learningDuration)) * 100));
        tiltStatus.textContent = tilt.isLearned
          ? `${tilt.min.toFixed(1)} to ${tilt.max.toFixed(1)} dB learned`
          : `Learning… ${pct}%`;
      }
      if (confidenceStatus) confidenceStatus.textContent = `${Math.round(this.analyzer.frameConfidence * 100)}%`;
    }
  }

  _meterLabel(val, low, mid, high) {
    const pct = Math.round(val * 100);
    if (pct <= 15) return `${pct}% · ${low}`;
    if (pct <= 55) return `${pct}% · ${mid}`;
    return `${pct}% · ${high}`;
  }

  // ============================================================
  // WINDOWED-AVERAGE READOUTS (pitch / resonance / attack / weight)
  // ============================================================

  // Collect one time-stamped sample per metric every frame (voicing/confidence-gated so the
  // averages reflect actual phonation, not silence). Called unconditionally from the render
  // loop — independent of whether the expanded panel is open — so the always-visible HUD
  // readouts have history to average.
  _pushAvgSamples() {
    const a = this.analyzer, m = a.metrics;
    const t = performance.now() / 1000;
    const B = this._avgBuffers;

    if (a.lastPitch > 0 && a.smoothPitchHz > 0 && a.pitchConfidence > 0.35 && m.energy > 0.05) {
      B.pitch.push({ t, v: a.smoothPitchHz });
    }
    if (a.formantConfidence > 0.2 && m.energy > 0.05) {
      B.resonance.push({ t, f1: a.smoothF1, f2: a.smoothF2 });
    }
    if (m.attack > 0.02) {
      B.attack.push({ t, v: m.attack, rise: a.attackRiseHardness, abrupt: a.attackAbruptness });
    }
    if (a.spectralTiltConfidence > 0.2) {
      B.weight.push({ t, v: m.weight, tilt: 1 - a.spectralWeight, h1h2: a.h1h2SmoothedDb });
    }

    // Evict samples older than the retained max so buffers stay bounded; the active window
    // (which may be shorter, or 0 for "Live") is applied at read time in _recomputeAvgCache().
    const cutoff = t - this._avgWindowMaxSecs;
    for (const k in B) {
      const buf = B[k];
      while (buf.length && buf[0].t < cutoff) buf.shift();
    }
  }

  // Throttled accessor: returns a cached per-metric summary (or null when there aren't enough
  // samples). The whole cache is recomputed at most every _avgRefreshSecs so the displayed
  // numbers read calmly even though samples arrive at 60fps.
  _avgSummary(metric) {
    const t = performance.now() / 1000;
    if (this._avgWindowSecs <= 0) {
      // Live mode tracks every frame, but recompute at most once per frame (HUD + cards +
      // popup all call this), not once per readout.
      const frameId = Math.floor(t * 1000 / 16);
      if (frameId !== this._avgLastFrameId) { this._recomputeAvgCache(t); this._avgLastFrameId = frameId; }
    } else if (t - this._avgLastRefresh >= this._avgRefreshSecs) {
      this._recomputeAvgCache(t);
      this._avgLastRefresh = t;
    }
    return this._avgCache[metric] || null;
  }

  _recomputeAvgCache(now) {
    const B = this._avgBuffers;
    const live = this._avgWindowSecs <= 0;
    // In Live mode use only the most recent sample; otherwise the trailing time window.
    const within = (buf) => {
      if (!buf.length) return [];
      if (live) return buf.slice(-1);
      const cutoff = now - this._avgWindowSecs;
      let i = buf.length;
      while (i > 0 && buf[i - 1].t >= cutoff) i--;
      return buf.slice(i);
    };
    const MIN_N = live ? 1 : 5; // need a few samples for a stable window average

    // Pitch — mean Hz plus min/max and semitone range (range is the most training-useful cue).
    {
      const s = within(B.pitch);
      if (s.length >= MIN_N) {
        let sum = 0, min = Infinity, max = -Infinity;
        for (const p of s) { sum += p.v; if (p.v < min) min = p.v; if (p.v > max) max = p.v; }
        const meanHz = sum / s.length;
        const rangeSemitones = (min > 0 && max > 0) ? 12 * Math.log2(max / min) : 0;
        this._avgCache.pitch = { n: s.length, meanHz, minHz: min, maxHz: max, rangeSemitones };
      } else this._avgCache.pitch = null;
    }

    // Resonance — mean F1/F2 and a bright/neutral/dark descriptor (from F2, matching the
    // resonance-score logic in the analyzer).
    {
      const s = within(B.resonance);
      if (s.length >= MIN_N) {
        let f1 = 0, f2 = 0;
        for (const p of s) { f1 += p.f1; f2 += p.f2; }
        const meanF1 = f1 / s.length, meanF2 = f2 / s.length;
        const descriptor = meanF2 >= 1900 ? 'Bright' : meanF2 >= 1500 ? 'Neutral' : 'Dark';
        this._avgCache.resonance = { n: s.length, meanF1, meanF2, descriptor };
      } else this._avgCache.resonance = null;
    }

    // Attack — mean blended hardness plus the two sub-cues (rise-rate vs abruptness).
    {
      const s = within(B.attack);
      if (s.length >= MIN_N) {
        let v = 0, rise = 0, abrupt = 0;
        for (const p of s) { v += p.v; rise += (p.rise || 0); abrupt += (p.abrupt || 0); }
        const mean = v / s.length;
        const descriptor = mean <= 0.15 ? 'Soft' : mean <= 0.55 ? 'Medium' : 'Hard';
        this._avgCache.attack = { n: s.length, mean, meanRise: rise / s.length, meanAbrupt: abrupt / s.length, descriptor };
      } else this._avgCache.attack = null;
    }

    // Weight — mean blended heaviness plus per-cue means (spectral tilt, H1–H2 in dB).
    {
      const s = within(B.weight);
      if (s.length >= MIN_N) {
        let v = 0, tilt = 0, h1h2 = 0;
        for (const p of s) { v += p.v; tilt += p.tilt; h1h2 += p.h1h2; }
        const mean = v / s.length;
        const descriptor = mean <= 0.35 ? 'Light' : mean <= 0.6 ? 'Balanced' : 'Heavy';
        this._avgCache.weight = { n: s.length, mean, meanTilt: tilt / s.length, meanH1H2: h1h2 / s.length, descriptor };
      } else this._avgCache.weight = null;
    }
  }

  // ---- Readout formatters (shared by HUD meters, expanded cards, and focus popup) ----

  _pitchReadout(rich = false) {
    const s = this._avgSummary('pitch');
    if (!s) return (rich || this.pitchDisplayMode === 'hz') ? '— Hz' : '—';
    const note = this._pitchHzToNoteLabel(s.meanHz);
    if (rich) return `${Math.round(s.meanHz)} Hz · ${note} · ±${(s.rangeSemitones / 2).toFixed(1)}st`;
    switch (this.pitchDisplayMode) {
      case 'note': return note;
      case 'range': return `${s.rangeSemitones.toFixed(1)} st`;
      default: return `${Math.round(s.meanHz)} Hz`;
    }
  }

  _resonanceReadout(format) {
    const s = this._avgSummary('resonance');
    if (!s) return '—';
    const f1 = Math.round(s.meanF1), f2 = Math.round(s.meanF2);
    if (format === 'popup') return `F1: ${f1} Hz  F2: ${f2} Hz`;
    if (format === 'card') return `${s.descriptor} · F2 ${f2}`;
    return `${f1}/${f2}`; // compact HUD
  }

  _attackReadout() {
    const s = this._avgSummary('attack');
    if (!s) return '—';
    const v = this.attackMode === 'rise' ? s.meanRise
            : this.attackMode === 'abrupt' ? s.meanAbrupt
            : s.mean;
    const d = v <= 0.15 ? 'Soft' : v <= 0.55 ? 'Medium' : 'Hard';
    return `${Math.round(v * 100)}% · ${d}`;
  }

  _weightReadout() {
    const s = this._avgSummary('weight');
    if (!s) return '—';
    let v;
    if (this.weightMode === 'tilt') v = s.meanTilt;
    else if (this.weightMode === 'h1h2') v = 1 - normalizeAgainstRange(s.meanH1H2, H1H2_HEAVY_DB, H1H2_LIGHT_DB);
    else v = s.mean;
    v = Math.max(0, Math.min(1, v));
    const d = v <= 0.35 ? 'Light' : v <= 0.6 ? 'Balanced' : 'Heavy';
    return `${Math.round(v * 100)}% · ${d}`;
  }

  // ============================================================
  // EXPANDED METRICS — History tracking & rendering
  // ============================================================

  _pushMetricHistory() {
    const m = this.analyzer.metrics;
    const h = this._metricHistory;
    const max = this._metricHistoryMax;

    h.pitch.push(this.analyzer.smoothPitchHz);
    h.resonance.push(this.analyzer.smoothResonance);
    h.bounce.push(m.bounce);
    h.vowels.push(m.vowel);
    h.attack.push(m.attack);
    h.weight.push(m.weight);

    for (const k of Object.keys(h)) {
      const limit = (k === 'pitch' || k === 'bounce') ? this._metricHistoryMaxLong : max;
      if (h[k].length > limit) h[k].shift();
    }

    // Vowel scatter plot: collect F1/F2 points during voiced speech
    if (m.energy > 0.05 && this.analyzer.formantConfidence > 0.25 && this.analyzer.lastPitch > 0) {
      const f1 = this.analyzer.smoothF1;
      const f2 = this.analyzer.smoothF2;
      this._vowelPlotPoints.push({ x: f2, y: f1 });
      if (this._vowelPlotPoints.length > this._vowelPlotMax) this._vowelPlotPoints.shift();
    }
  }

  _sizeExpandedCanvases() {
    const ids = ['expCanvasPitch', 'expCanvasResonance', 'expCanvasBounce',
                 'expCanvasVowels', 'expCanvasAttack', 'expCanvasWeight'];
    for (const id of ids) {
      const c = document.getElementById(id);
      if (c) {
        const r = c.getBoundingClientRect();
        c.width = Math.round(r.width * devicePixelRatio);
        c.height = Math.round(r.height * devicePixelRatio);
      }
    }
  }

  _sizePopupCanvas() {
    const c = document.getElementById('metricPopupCanvas');
    if (c) {
      const r = c.getBoundingClientRect();
      c.width = Math.round(r.width * devicePixelRatio);
      c.height = Math.round(r.height * devicePixelRatio);
    }
  }

  _updateExpandedMetrics() {
    if (!this.metersExpanded && !this.metricPopupOpen) return;
    this._pushMetricHistory();
    this._updateAttackOrb(this.analyzer.metrics.attack);

    const m = this.analyzer.metrics;

    if (this.metersExpanded) {
      // Update expanded card values — windowed averages (visuals below stay live)
      const pEl = document.getElementById('expValPitch');
      if (pEl) pEl.textContent = this._pitchReadout(true);
      const rEl = document.getElementById('expValResonance');
      if (rEl) rEl.textContent = this._resonanceReadout('card');
      const atkEl = document.getElementById('expValAttack');
      if (atkEl) atkEl.textContent = this._attackReadout();
      const wtEl = document.getElementById('expValWeight');
      if (wtEl) wtEl.textContent = this._weightReadout();

      // Render each card canvas
      this._drawLineGraph('expCanvasPitch', this._metricHistory.pitch, '#c084fc', 60, 400, true);
      this._drawSpectrogram('expCanvasResonance');
      this._drawLineGraph('expCanvasBounce', this._metricHistory.bounce, '#ff6b6b', 0, 1, false);
      this._drawVowelPlot('expCanvasVowels');
      this._drawOrb('expCanvasAttack', this._attackOrb.solidity, '#2ec4b6');
      this._drawOrb('expCanvasWeight', m.weight, '#e06c9f');
    }

    // Render popup if open
    if (this.metricPopupOpen) {
      this._renderPopupCanvas(this.metricPopupOpen);
      this._updatePopupValue(this.metricPopupOpen);
    }
  }

  // ---- Drawing helpers for expanded cards ----

  _drawLineGraph(canvasId, data, color, minVal, maxVal, isHz) {
    const c = document.getElementById(canvasId);
    if (!c || !data.length) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // Data line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const range = maxVal - minVal || 1;
    const xMax = Math.max(data.length, 2) - 1;
    for (let i = 0; i < data.length; i++) {
      const x = (i / xMax) * w;
      const val = Math.max(minVal, Math.min(maxVal, data[i]));
      const y = h - ((val - minVal) / range) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Glow effect
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = 6 * devicePixelRatio;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Current value label
    if (data.length > 0) {
      const last = data[data.length - 1];
      const lastY = h - ((Math.max(minVal, Math.min(maxVal, last)) - minVal) / range) * (h - 4) - 2;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(w - 2, lastY, 3 * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Advance the vocal-attack orb's gas→solid animation. A rising edge of the (decaying) attack
  // impulse marks a fresh onset; the orb then condenses toward that hardness at a speed
  // proportional to it — a hard attack snaps solid almost instantly, a soft attack blooms
  // slowly — before evaporating back to gas, ready for the next onset. The condensation *speed*
  // (and the solidity it reaches) is the readable signal.
  _updateAttackOrb(attackVal) {
    const st = this._attackOrb;
    const now = performance.now();
    const dt = st.lastT ? Math.min(0.1, (now - st.lastT) / 1000) : 0.016;
    st.lastT = now;
    if (attackVal > st.prevAttack + 0.02) st.hardness = attackVal; // fresh onset captured
    st.prevAttack = attackVal;
    const a = st.hardness;
    if (a > 0.01 && st.solidity < a - 0.005) {
      const rate = Math.min(1, (1.5 + a * 12) * dt); // speed ∝ hardness
      st.solidity += (a - st.solidity) * rate;
    } else {
      st.solidity += (0 - st.solidity) * Math.min(1, 2.2 * dt); // evaporate back to gas
      st.hardness *= 0.96;
    }
  }

  // Draw a single "gas → solid" orb for solidity ∈ [0,1]: a wide faint glow when gassy, a bright
  // dense core with a crisp rim when solid. Used for the Vocal Attack and Weight visualizations
  // (reads the canvas size, so it scales for both the small cards and the larger focus popup).
  _drawOrb(canvasId, solidity, color) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const s = Math.max(0, Math.min(1, solidity || 0));
    const cx = w / 2, cy = h / 2;
    const n = parseInt(color.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const rgba = (a) => `rgba(${r},${g},${b},${a})`;
    const maxR = Math.min(w, h) * 0.42;

    // Halo — wide and faint when gassy, tighter and brighter when solid
    const haloR = maxR * (1.0 + (1 - s) * 0.8);
    const haloA = 0.08 + s * 0.22;
    const halo = ctx.createRadialGradient(cx, cy, maxR * 0.1, cx, cy, haloR);
    halo.addColorStop(0, rgba(haloA));
    halo.addColorStop(0.5, rgba(haloA * 0.4));
    halo.addColorStop(1, rgba(0));
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();

    // Core — emerges from the gas and brightens as it solidifies
    const coreR = maxR * (0.30 + s * 0.55);
    const coreA = 0.12 + s * 0.82;
    const core = ctx.createRadialGradient(cx - coreR * 0.3, cy - coreR * 0.3, 0, cx, cy, coreR);
    core.addColorStop(0, rgba(Math.min(1, coreA + 0.15)));
    core.addColorStop(0.7, rgba(coreA));
    core.addColorStop(1, rgba(coreA * (0.2 + s * 0.5)));
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();

    // Rim — only crisp once solid
    if (s > 0.12) {
      ctx.strokeStyle = rgba(0.2 + s * 0.6);
      ctx.lineWidth = (0.5 + s * 1.5) * (window.devicePixelRatio || 1);
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.stroke();
    }
  }

  _drawSpectrogram(canvasId) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;

    // Shift existing content left by 1 column
    const imgData = ctx.getImageData(1, 0, w - 1, h);
    ctx.putImageData(imgData, 0, 0);

    // Draw new column on the right using frequency data
    const fData = this.analyzer.frequencyData;
    if (!fData || fData.length === 0) {
      ctx.fillStyle = '#000';
      ctx.fillRect(w - 1, 0, 1, h);
      return;
    }

    // Map frequency bins to vertical pixels (low freq at bottom)
    const binsToShow = Math.min(fData.length, 256); // focus on lower frequencies
    for (let y = 0; y < h; y++) {
      const binIdx = Math.floor(((h - y) / h) * binsToShow);
      const dbVal = fData[binIdx] || -100;
      // Map dB (-100 to 0) to intensity
      const intensity = Math.max(0, Math.min(1, (dbVal + 100) / 80));
      // Warm color map: black → blue → orange → gold
      const r = Math.round(intensity * intensity * 255);
      const g = Math.round(Math.pow(intensity, 3) * 200);
      const b = Math.round(intensity * 180);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(w - 1, y, 1, 1);
    }
  }

  _drawVowelPlot(canvasId) {
    const c = document.getElementById(canvasId);
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);

    // Axes
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();

    // Reference vowel positions (approximate F2, F1 in Hz)
    const vowels = [
      { label: 'EE', f2: 2300, f1: 300 },
      { label: 'AH', f2: 1100, f1: 800 },
      { label: 'OO', f2: 800, f1: 350 },
      { label: 'EH', f2: 1800, f1: 550 },
      { label: 'AW', f2: 900, f1: 600 },
    ];

    // F2 range: 600-2600, F1 range: 200-1000
    const mapF2 = f2 => ((f2 - 600) / 2000) * w;
    const mapF1 = f1 => ((f1 - 200) / 800) * h;

    // Reference labels
    ctx.font = `${8 * devicePixelRatio}px "Space Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    for (const v of vowels) {
      const vx = mapF2(v.f2);
      const vy = mapF1(v.f1);
      ctx.fillText(v.label, vx, vy);
    }

    // Scatter points
    const pts = this._vowelPlotPoints;
    for (let i = 0; i < pts.length; i++) {
      const alpha = 0.2 + (i / pts.length) * 0.6;
      const size = 2 + (i / pts.length) * 2;
      ctx.fillStyle = `rgba(107, 203, 119, ${alpha})`;
      ctx.beginPath();
      ctx.arc(mapF2(pts[i].x), mapF1(pts[i].y), size * devicePixelRatio, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- Metric Popup ----

  _openMetricPopup(metric) {
    this.metricPopupOpen = metric;
    const backdrop = document.getElementById('metricPopupBackdrop');
    const title = document.getElementById('metricPopupTitle');
    const desc = document.getElementById('metricPopupDesc');

    const descriptions = {
      pitch: 'Displays the current fundamental frequency (F0). The color-coded slider shows your position in the pitch range. The line graph shows pitch stability and range over time.',
      resonance: 'Shows a real-time spectrogram tracking formant frequencies (F1, F2). The "Q" value indicates the sharpness of the resonance filter (Harmonic Envelope).',
      bounce: 'A stylized wave graph measuring prosodic inflection or "melody" in speech. Higher values suggest more dynamic pitch variation rather than monotonic delivery.',
      vowels: 'A vowel space plot (F1 vs F2) showing the brightness or darkness of vowel sounds like "EE" and "AH." Tracks resonance shifts during articulation.',
      attack: 'Vocal attack measures onset hardness — how steeply your voice rises into phonation. High = crisp glottal onsets; low = soft, breathy, gradual starts.',
      weight: 'Vocal weight is perceived heaviness from spectral tilt. High = thick, heavy, buzzy tone; low = light, bright, breathy tone.',
    };

    const colors = {
      pitch: '#c084fc', resonance: '#ffaa44', bounce: '#ff6b6b',
      vowels: '#6bcb77', attack: '#2ec4b6', weight: '#e06c9f',
    };

    title.textContent = metric.toUpperCase();
    title.style.color = colors[metric] || '#fff';
    desc.textContent = descriptions[metric] || '';

    backdrop.classList.add('show');
    // Allow layout, then size canvas
    requestAnimationFrame(() => this._sizePopupCanvas());
  }

  _closeMetricPopup() {
    this.metricPopupOpen = null;
    const backdrop = document.getElementById('metricPopupBackdrop');
    backdrop.classList.remove('show');
  }

  _updatePopupValue(metric) {
    const el = document.getElementById('metricPopupValue');
    if (!el) return;

    const colors = {
      pitch: '#c084fc', resonance: '#ffaa44', bounce: '#ff6b6b',
      vowels: '#6bcb77', attack: '#2ec4b6', weight: '#e06c9f',
    };
    el.style.color = colors[metric] || '#fff';

    switch (metric) {
      case 'pitch': el.textContent = this._pitchReadout(true); break;
      case 'resonance': el.textContent = this._resonanceReadout('popup'); break;
      // Bounce/Vowels: percentage readouts removed — the chart below is the readout.
      case 'bounce': el.textContent = ''; break;
      case 'vowels': el.textContent = ''; break;
      case 'attack': el.textContent = this._attackReadout(); break;
      case 'weight': el.textContent = this._weightReadout(); break;
    }
  }

  _renderPopupCanvas(metric) {
    const canvasId = 'metricPopupCanvas';
    switch (metric) {
      case 'pitch':
        this._drawLineGraph(canvasId, this._metricHistory.pitch, '#c084fc', 60, 400, true);
        break;
      case 'resonance':
        this._drawSpectrogram(canvasId);
        break;
      case 'bounce':
        this._drawLineGraph(canvasId, this._metricHistory.bounce, '#ff6b6b', 0, 1, false);
        break;
      case 'vowels':
        this._drawVowelPlot(canvasId);
        break;
      case 'attack':
        this._drawOrb(canvasId, this._attackOrb.solidity, '#2ec4b6');
        break;
      case 'weight':
        this._drawOrb(canvasId, this.analyzer.metrics.weight, '#e06c9f');
        break;
    }
  }
}

// Initialize if in main UI, export for testing harness
export const game = document.getElementById('app') ? new VoxBallGame() : null;
