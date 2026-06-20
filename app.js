import { getMicDiagnostics, ensureAudioContextRunning } from "./dsp-utils.js";
import { PerformanceMonitor } from './performance-monitor.js';
import { CalibrationWizard } from './calibration-wizard.js';
import { BulbController } from './bulb-controller.js';
import { NecklaceController, HapticSrc } from './necklace-controller.js';
import { VoiceAnalyzer } from "./voice-analyzer.js";
import { Teleprompter } from "./teleprompter.js";
import { VibrationAlerts } from "./vibration-alerts.js";
import { RecordingSystem } from "./recording-system.js";
import { MetricsHud } from "./metrics-hud.js";
import { GameRenderer } from "./game-renderer.js";

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

    // Recording + Delayed Auditory Feedback subsystem (owns its own state/DOM).
    this.recorder = new RecordingSystem(this.analyzer);

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
    this.vibration = new VibrationAlerts();

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
    this.voiceProfilePreset = 'auto';
    this.teleprompter = new Teleprompter();
    // Metrics HUD subsystem (owns meter/expanded/popup state; reads analyzer + modes via this).
    this.hud = new MetricsHud(this);
    // Physics + rendering collaborator (operates on this game's shared render state).
    this.renderer = new GameRenderer(this);
    // Per-metric display modes (mirrors the Resonance method selector the user likes)
    this.pitchDisplayMode = 'hz';     // 'hz' | 'note' | 'range'
    this.weightMode = 'combined';     // 'combined' | 'tilt' | 'h1h2'
    this.attackMode = 'combined';     // 'combined' | 'rise' | 'abrupt'

    this.renderer.resize();
    const onResize = () => this.renderer.resize();
    window.addEventListener('resize', onResize);
    this._disposables.push(() => window.removeEventListener('resize', onResize));
    this.setupUI();
    this._updateHelpContent();
    this._setupMobile();
    this._setupInfoPopups();
    this.renderer.drawIdleScene();
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
        // Self-hosted (was unpkg CDN) so no third-party code is fetched at runtime.
        const s = document.createElement('script');
        s.src = 'vendor/peerjs-1.5.4.min.js';
        s.onload = initPeer;
        s.onerror = () => reject(new Error('Could not load PeerJS (vendor/peerjs-1.5.4.min.js).'));
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
      this.teleprompter.sentenceIndex = 0; // start each session at the first sentence
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
        this.renderer.drawIdleScene();
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
          this.renderer.drawIdleScene();
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
        this.renderer.drawIdleScene();
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
      this.ball.y = this.renderer.getGroundHeight(this.scrollX + this.ball.x) - this.ball.radius;

      // Clear vibration alert tripped highlights
      for (const rule of this.vibration.rules) { rule.tripped = false; }
      this.vibration.flashAlpha = 0;
      if (this._renderVibRules) this._renderVibRules();

      // Clear windowed-average readout buffers so a quick restart doesn't average in
      // the previous session's history.
      this.hud._avgBuffers = { pitch: [], resonance: [], attack: [], weight: [] };
      this.hud._avgCache = {};
      this.hud._avgLastRefresh = 0;
      this.hud._avgLastFrameId = -1;

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
      if (this.recorder.dafEnabled) this.recorder.startDAF();
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
      if (this.recorder.isRecording) {
        recBtn.classList.remove('recording');
        recBtn.querySelector('.rec-label').textContent = 'Rec';
        await this.recorder.stopRecording();
      }
      this.recorder.stopDAF();
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
        this.renderer.drawIdleScene(); // animate behind semi-transparent summary
      } else {
        welcomeOverlay.classList.remove('hidden');
      document.getElementById('app').classList.remove('playing');
      setHudSettingsVisible(false);
        this.renderer.drawIdleScene();
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
      this.recorder.stopDAF();
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

      this.renderer.drawIdleScene();
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
      this.renderer.drawIdleScene();
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
        if (this.isRunning && this.teleprompter.mode !== 'off') {
          this.teleprompter.advanceManual();
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
        if (this.hud.metricPopupOpen) {
          this.hud._closeMetricPopup();
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
          this.renderer.drawIdleScene();
        }
      }
    });

    // Single-mode (Vox Ball) setup — runs once during init.
    document.querySelectorAll('.ball-only').forEach(el => el.classList.add('show'));
    if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompter.mode !== 'off');
    document.querySelector('.hud-title').textContent = 'VOX BALL';
    this._updateHelpContent();
    if (this.idleAnimId) { cancelAnimationFrame(this.idleAnimId); this.idleAnimId = null; }
    if (!this.isRunning) this.renderer.drawIdleScene();

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
      if (!this.isRunning) this.renderer.drawIdleScene();
    });

    for (const [cue, input] of Object.entries(genderCueInputs)) {
      input?.addEventListener('change', (e) => {
        this.genderCues[cue] = !!e.target.checked;
        localStorage.setItem(`vox:genderCue:${cue}`, String(this.genderCues[cue]));
        if (!this.isRunning) this.renderer.drawIdleScene();
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
        if (this.isRunning && this.teleprompter.mode !== 'off') {
          this.teleprompter.advanceManual();
        }
      });
    }

    teleprompterModeSelect?.addEventListener('change', (e) => {
      this.teleprompter.mode = e.target.value;
      this.teleprompter.index = 0;
      this.teleprompter.sentenceIndex = 0;
      if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompter.mode !== 'off');
      teleprompterCustomBtn?.classList.toggle('active', this.teleprompter.mode === 'custom');
    });

    teleprompterCustomBtn?.addEventListener('click', () => {
      const existing = this.teleprompter.customText || '';
      const input = window.prompt('Paste or type your teleprompter text:', existing);
      if (input === null) return;
      this.teleprompter.customText = input.trim();
      if (!this.teleprompter.customText) {
        this.teleprompter.mode = 'rainbow';
      } else {
        this.teleprompter.mode = 'custom';
      }
      if (teleprompterModeSelect) teleprompterModeSelect.value = this.teleprompter.mode;
      this.teleprompter.index = 0;
      this.teleprompter.sentenceIndex = 0;
      if (teleprompterOverlay) teleprompterOverlay.classList.toggle('show', this.teleprompter.mode !== 'off');
      teleprompterCustomBtn.classList.toggle('active', this.teleprompter.mode === 'custom');
    });

    // Diagnostic controls (formant-method picker) are revealed only with ?dev=1.
    if (new URLSearchParams(window.location.search).has('dev')) {
      document.body.classList.add('dev-mode');
    }

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
      if (el) el.addEventListener('change', (e) => { apply(e.target.value); this.hud._avgLastRefresh = 0; this.hud._avgLastFrameId = -1; });
    };
    bindReadoutSelect('pitchDisplaySelect', (v) => { this.pitchDisplayMode = v; });
    bindReadoutSelect('weightModeSelect', (v) => { this.weightMode = v; });
    bindReadoutSelect('attackModeSelect', (v) => { this.attackMode = v; });
    bindReadoutSelect('avgWindowSelect', (v) => { this.hud._avgWindowSecs = parseFloat(v) || 0; });

    // ---- Voice recorder: always-available Record + Play-last controls in the top bar ----
    // Reuses the analyser-based recorder (startRecording/stopRecording) and the recordings
    // drawer (Clips) for the full list; the Play button plays back the most recent clip.
    const voiceRecBtn = document.getElementById('voiceRecBtn');
    if (voiceRecBtn) {
      voiceRecBtn.addEventListener('click', async () => {
        if (this.recorder.isRecording) {
          await this.recorder.stopRecording();   // pushes the clip + calls updateRecordingsUI → syncs buttons
          this.recorder._updateVoiceRecBtn();    // also reset if no clip was saved (silent recording)
        } else if (!this.isRunning) {
          showError('🎙 Press Start to begin a session, then Record.');
        } else {
          this.recorder.startRecording();
          this.recorder._updateVoiceRecBtn();
        }
      });
    }
    const voicePlayBtn = document.getElementById('voicePlayBtn');
    if (voicePlayBtn) {
      voicePlayBtn.addEventListener('click', () => {
        const lastIdx = this.recorder.recordings.length - 1;
        if (lastIdx < 0) return;
        if (this.recorder.currentPlayback && this.recorder.currentPlayback.index === lastIdx) {
          this.recorder.stopPlayback();
        } else {
          this.recorder.playRecording(lastIdx);
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
      this.hud.metersExpanded = !this.hud.metersExpanded;
      metersPanel.classList.toggle('expanded', this.hud.metersExpanded);
      appEl.classList.toggle('meters-open', this.hud.metersExpanded);
      metersExpandToggle.setAttribute('aria-expanded', this.hud.metersExpanded ? 'true' : 'false');
      metersExpandToggle.setAttribute('aria-label', this.hud.metersExpanded ? 'Collapse metrics' : 'Expand metrics');
      // Reflow the game canvas after panel height changes so the ball/ground stay in view.
      requestAnimationFrame(() => this.renderer.resize());
      // Expansion animation shifts layout over ~300ms; run one more resize after it settles.
      setTimeout(() => this.renderer.resize(), 320);
      // Size canvases after layout settles
      if (this.hud.metersExpanded) {
        requestAnimationFrame(() => this.hud._sizeExpandedCanvases());
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
        this.hud._openMetricPopup(metric);
      });
    });

    // Popup close
    const popupBackdrop = document.getElementById('metricPopupBackdrop');
    const popupClose = document.getElementById('metricPopupClose');
    popupClose?.addEventListener('click', () => this.hud._closeMetricPopup());
    popupBackdrop?.addEventListener('click', (e) => {
      if (e.target === popupBackdrop) this.hud._closeMetricPopup();
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
            case 'tempo': val = Math.round((this.syllableSpeedFactor || 0) * 100); break;
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
      this.vibration.trigger('Test', {
        gameArea: this._gameArea,
        reducedMotion: this.reducedMotion,
      });
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
        document.getElementById('dafEnableToggle').checked = this.recorder.dafEnabled;
        document.getElementById('dafDelaySlider').value = this.recorder.dafDelayMs;
        document.getElementById('dafDelayLabel').textContent = `${this.recorder.dafDelayMs}ms`;
        document.getElementById('dafBassFilterToggle').checked = this.recorder.dafBassFilter;
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
      this.recorder.dafEnabled = e.target.checked;
      localStorage.setItem('vox:daf:enabled', String(this.recorder.dafEnabled));
      dafBtn?.classList.toggle('active', this.recorder.dafEnabled);
      if (this.isRunning) {
        if (this.recorder.dafEnabled) this.recorder.startDAF();
        else this.recorder.stopDAF();
      }
    });

    document.getElementById('dafDelaySlider')?.addEventListener('input', (e) => {
      this.recorder.dafDelayMs = parseInt(e.target.value);
      localStorage.setItem('vox:daf:delayMs', String(this.recorder.dafDelayMs));
      document.getElementById('dafDelayLabel').textContent = `${this.recorder.dafDelayMs}ms`;
      this.recorder._dafBuffer = [];
    });

    document.getElementById('dafBassFilterToggle')?.addEventListener('change', (e) => {
      this.recorder.dafBassFilter = e.target.checked;
      localStorage.setItem('vox:daf:bassFilter', String(this.recorder.dafBassFilter));
      if (this.recorder._dafInterval) {
        this.recorder.stopDAF();
        this.recorder.startDAF();
      }
    });

    if (this.recorder.dafEnabled) dafBtn?.classList.add('active');
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
        if (this.recorder.isRecording) {
          this.recorder.stopRecording();
          recBtn.classList.remove('recording');
          recBtn.querySelector('.rec-label').textContent = 'Rec';
        } else {
          this.recorder.startRecording();
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
      if (this.recorder.recordings.length === 0) return;
      if (window.confirm('Are you sure you want to delete all recordings? This cannot be undone.')) {
        this.recorder.clearAllRecordings();
      }
    });


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

    this.renderer.update(dt);
    this.renderer.drawSceneInternal(this.prosodyScore);
    // Mirror the live ball color onto a smart bulb (throttled internally).
    // Driven from the central loop so it tracks every mode that updates the color.
    const currentResonance = this.analyzer ? this.analyzer.smoothResonance : 0;
    const currentWeight = this.analyzer ? this.analyzer.weightSmoothed : 0.5;
    this.bulbController?.update(this.ballHue, this.ballSat, this.ballLit, currentResonance, dt, currentWeight);
    this.hud._pushAvgSamples();
    this.hud.updateMeters();
    this.hud._updateExpandedMetrics();
    this.teleprompter.render(dt, this.isRunning);
    this.vibration.check(dt, {
      metrics: this.analyzer.metrics,
      pitchHz: this.analyzer.smoothPitchHz,
      resonance: this.analyzer.smoothResonance,
      syllableSpeedFactor: this.syllableSpeedFactor || 0,
      gameArea: this._gameArea,
      reducedMotion: this.reducedMotion,
      onLiveUpdate: this._updateVibLiveUI,
    });
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

}

// Initialize if in main UI, export for testing harness
export const game = document.getElementById('app') ? new VoxBallGame() : null;
