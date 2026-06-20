// ============================================================
// GAME RENDERER — physics integration + canvas rendering
// ============================================================
// Collaborator that holds a back-reference to the game and operates on its shared
// physics/render state (ball, scroll, camera, particles, trail, sparkles, terrain,
// stars, ballHue/Sat/Lit, ctx, width/height, …). The orchestrating loop() stays in
// VoxBallGame; this owns the per-frame physics step (update), the main scene draw,
// the idle scene, canvas resize + terrain/star generation, ground sampling, and
// ball-hue computation. Extracted from VoxBallGame as a pure move — no behavior
// change. Because that physics state is read all over the game (loop, start/stop,
// session stats, vibration, bulb), it stays owned by VoxBallGame and is reached
// here via this.game.*; only sibling renderer methods are called as this.*.
import { computeProsodyScore, clamp01, genderScoreToHue, computeGenderScoreMulti, computeSibilantFemininity, FEMINIZATION_CUE_WEIGHTS, MASCULINIZATION_CUE_WEIGHTS } from './dsp-utils.js';
import { Particle } from './particle.js';

const MAX_SPARKLES = 100; // Maximum sparkle particles in ball mode

export class GameRenderer {
  constructor(game) {
    this.game = game;
  }

  resize() {
    const rect = this.game.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.game.canvas.width = rect.width * dpr;
    this.game.canvas.height = rect.height * dpr;
    this.game.canvas.style.width = rect.width + 'px';
    this.game.canvas.style.height = rect.height + 'px';
    // FIX: Reset transform before scaling — prevents compound scaling on multiple resizes
    this.game.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.game.width = rect.width;
    this.game.height = rect.height;
    this.game.groundY = this.game.height * 0.75;
    this.game.ball.y = this.game.groundY - this.game.ball.radius;

    // FIX: Generate stars sized to actual canvas dimensions
    this.game.stars = [];
    for (let i = 0; i < 80; i++) {
      this.game.stars.push({
        x: Math.random() * 3000,
        y: Math.random() * this.game.height * 0.55,
        size: Math.random() * 1.5 + 0.5,
        twinkle: Math.random() * Math.PI * 2
      });
    }

    // Generate mountain layers (procedural, infinite via sine sums)
    if (!this.game.mountainLayers) {
      this.game.mountainLayers = [
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
    const mc = mtnColors[this.game.themeMode] || mtnColors.highcontrast;
    this.game.mountainLayers[0].color = mc[0];
    this.game.mountainLayers[1].color = mc[1];
    this.game.mountainLayers[2].color = mc[2];
    this.game._groundColors = groundColors[this.game.themeMode] || groundColors.highcontrast;

    if (!this.game.isRunning) this.drawIdleScene();
  }

  // FIX: Infinite procedural terrain
  getGroundHeight(worldX) {
    let h = 0;
    for (const layer of this.game.terrainLayers) {
      h += layer.amplitude * Math.sin(worldX * layer.frequency + layer.phase);
    }
    return this.game.groundY + h * 0.4;
  }

  // FIX: Helper for proper HSLA color strings
  getBallColor(alpha) {
    if (alpha !== undefined) {
      return `hsla(${this.game.ballHue}, ${this.game.ballSat}%, ${this.game.ballLit}%, ${alpha})`;
    }
    return `hsl(${this.game.ballHue}, ${this.game.ballSat}%, ${this.game.ballLit}%)`;
  }

  // FIX: Idle scene animation behind the overlay
  drawIdleScene() {
    // Cancel any existing idle loop first so repeated calls (e.g. toggling color
    // mode while idle) don't stack independent rAF loops.
    if (this.game.idleAnimId) { cancelAnimationFrame(this.game.idleAnimId); this.game.idleAnimId = null; }
    const idleScroll = { x: this.game.scrollX || 0 };
    let idleTime = 0;
    const animate = () => {
      if (this.game.isRunning) return;
      idleTime += 0.016;
      idleScroll.x += 0.5;
      this.game.scrollX = idleScroll.x;
      this.game.ball.x = this.game.width * 0.45;
      const ground = this.getGroundHeight(this.game.scrollX + this.game.ball.x);
      this.game.ball.y = ground - this.game.ball.radius;
      this.game.ball.rotation += 0.01;
      this.game.ballHue = 275;
      this.game.ballSat = 70;
      this.game.ballLit = 55;
      this.game.cameraY = 0;
      this.game.targetCameraY = 0;
      this.game.cameraZoom = 1.4;
      this.game.targetZoom = 1.4;
      this.drawSceneInternal(0);
      this.game.idleAnimId = requestAnimationFrame(animate);
    };
    animate();
  }

  update(dt) {
    const m = this.game.analyzer.metrics;
    const gravity = 800;

    // ==========================================================
    // PROSODY SCORE — the core pedagogical signal
    // Monotone speech ≈ 0. Expressive prosody → 1.
    // Weighted toward variation metrics, NOT raw energy/volume.
    // During low-confidence frames, slow the smoothing factor so
    // unreliable data doesn't jerk the score around.
    // ==========================================================
    const scoreSmoothing = 0.12 * Math.max(0.2, this.game.analyzer.frameConfidence);
    this.game.prosodyScore = computeProsodyScore(this.game.prosodyScore, m, scoreSmoothing);

    const ps = this.game.prosodyScore;

    // ==========================================================
    // SCROLL SPEED — prosody + rolling syllable frequency drives movement
    // Monotone: sluggish crawl (20 px/s). High rate: >300 px/s.
    // ==========================================================
    const nowSec = performance.now() / 1000;
    this.game.syllableTimes = this.game.syllableTimes || [];
    const currentImpulse = this.game.analyzer.syllableImpulse;
    if (currentImpulse > 0.9 && !this.game._hadSyllableTrigger) {
      this.game.syllableTimes.push(nowSec);
      this.game._hadSyllableTrigger = true;
    } else if (currentImpulse <= 0.8) {
      this.game._hadSyllableTrigger = false;
    }
    this.game.syllableTimes = this.game.syllableTimes.filter(t => nowSec - t <= 3.0);
    const syllableFreq = this.game.syllableTimes.length / 3.0;
    const speedFactor = Math.min(1.0, syllableFreq / 3.0);
    this.game.syllableSpeedFactor = speedFactor;

    this.game.targetScrollSpeed = 20 + ps * 150 + speedFactor * 250;
    this.game.scrollSpeed += (this.game.targetScrollSpeed - this.game.scrollSpeed) * 0.06;
    this.game.scrollX += this.game.scrollSpeed * dt;

    this.game.ball.x = this.game.width * 0.45;
    const localGround = this.getGroundHeight(this.game.scrollX + this.game.ball.x);

    // ==========================================================
    // SYLLABLE BOUNCE — gated by prosody
    // Monotone syllables = tiny nudge. Prosodic = BIG bounce.
    // At ps=0.4 → ~120px height. At ps=0.8 → ~400px height.
    // ==========================================================
    const sylImpulse = this.game.analyzer.syllableImpulse;
    if (sylImpulse > 0.5) {
      const bouncePower = 120 + ps * 1800;
      if (this.game.ball.vy > -bouncePower * 0.5) {
        this.game.ball.vy = -bouncePower * sylImpulse;
        this.game.ball.onGround = false;
        this.game.ball.squash = 0.7 - ps * 0.15;
        if (ps > 0.15) {
          const pY = Math.min(this.game.ball.y + this.game.ball.radius, localGround);
          const n = Math.floor((2 + ps * 6) * this.game.particleScale);
          for (let i = 0; i < n; i++) {
            const angle = Math.PI + Math.random() * Math.PI;
            const pr = this.game.colorblindMode ? 240 : 255;
            const pg = this.game.colorblindMode ? 200 + Math.floor(Math.random() * 55) : 120 + Math.floor(Math.random() * 100);
            const pb = this.game.colorblindMode ? 60 : 100;
            this.game.particles.push(new Particle(
              this.game.ball.x, pY,
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
      this.game.ball.vy -= m.bounce * ps * 1200 * dt;
    }

    if (!this.game.ball.onGround) {
      this.game.ball.vy += gravity * dt;
    }

    this.game.ball.y += this.game.ball.vy * dt;

    // Ground collision
    const groundContact = localGround - this.game.ball.radius;
    if (this.game.ball.y >= groundContact) {
      this.game.ball.y = groundContact;
      if (Math.abs(this.game.ball.vy) > 30 && ps > 0.1) {
        this.game.ball.squash = 0.7;
        const gParts = Math.max(1, Math.floor(3 * this.game.particleScale));
        for (let i = 0; i < gParts; i++) {
          this.game.particles.push(new Particle(
            this.game.ball.x + (Math.random() - 0.5) * 20, localGround,
            200, 200, 220,
            (Math.random() - 0.5) * 50, -Math.random() * 40,
            0.3, 1.5
          ));
        }
      }
      this.game.ball.vy *= -0.3;
      if (Math.abs(this.game.ball.vy) < 15) {
        this.game.ball.vy = 0;
        this.game.ball.onGround = true;
      }
    } else {
      this.game.ball.onGround = false;
    }

    this.game.ball.rotation += (this.game.scrollSpeed / (this.game.ball.radius * 2)) * dt;
    this.game.ball.squash += (1 - this.game.ball.squash) * 5 * dt;

    // Camera Y tracking
    const upperLimit = this.game.height * 0.3;
    const ballScreenY = this.game.ball.y;
    if (ballScreenY < upperLimit) {
      this.game.targetCameraY = ballScreenY - upperLimit;
    } else {
      this.game.targetCameraY = 0;
    }
    const camSpeed = this.game.targetCameraY < this.game.cameraY ? 0.18 : 0.06;
    this.game.cameraY += (this.game.targetCameraY - this.game.cameraY) * camSpeed;
    this.game.cameraY = Math.min(0, this.game.cameraY);
    const ballScreenY2 = this.game.ball.y - this.game.cameraY;
    if (ballScreenY2 < this.game.ball.radius * 2) {
      this.game.cameraY = this.game.ball.y - this.game.ball.radius * 2;
    }

    // Dynamic zoom — zoom in when grounded, zoom out when high
    // Also zoom out slightly at high speed for dramatic effect
    const heightAboveGround = Math.max(0, localGround - this.game.ball.radius - this.game.ball.y);
    const heightRatio = Math.min(1, heightAboveGround / (this.game.height * 0.5));
    const scrollSpeedFactor = Math.min(1, this.game.scrollSpeed / 300);
    this.game.targetZoom = (1.48 - heightRatio * 0.3 - scrollSpeedFactor * 0.08) * this.game.userZoomMultiplier; // 1.48 → 1.10, scaled by manual zoom
    this.game.cameraZoom += (this.game.targetZoom - this.game.cameraZoom) * 0.04;

    // ==========================================================
    // BALL SIZE — monotone: small (16). Prosodic: 22-40.
    // ==========================================================
    const prosodyRadius = 16 + ps * 10;
    const vowelBonus = m.vowel * 14;
    this.game.ball.targetRadius = prosodyRadius + vowelBonus;
    this.game.ball.radius += (this.game.ball.targetRadius - this.game.ball.radius) * 0.1;

    // ==========================================================
    // VOWEL TRAIL — only with real prosody
    // ==========================================================
    if (m.vowel > 0.2 && ps > 0.1) {
      this.game.trailPoints.push({
        wx: this.game.ball.x + this.game.scrollX,
        sy: this.game.ball.y + this.game.ball.radius,
        size: this.game.ball.radius * 0.5 * m.vowel * Math.min(1, ps * 3),
        life: 1.0,
        hue: this.game.ballHue
      });
    }

    for (let i = this.game.trailPoints.length - 1; i >= 0; i--) {
      this.game.trailPoints[i].life -= dt * 1.5;
      if (this.game.trailPoints[i].life <= 0) this.game.trailPoints.splice(i, 1);
    }
    if (this.game.trailPoints.length > 60) this.game.trailPoints.splice(0, this.game.trailPoints.length - 60);

    // ==========================================================
    // SPARKLES — gated by prosody
    // ==========================================================
    if (m.articulation > 0.3 && ps > 0.1) {
      const sparkleCount = Math.floor(m.articulation * ps * 6 * this.game.particleScale);
      for (let i = 0; i < sparkleCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = this.game.ball.radius + Math.random() * 20;
        this.game.sparkles.push({
          x: this.game.ball.x + Math.cos(angle) * dist,
          y: this.game.ball.y + this.game.ball.radius * 0.5 + Math.sin(angle) * dist,
          life: 0.4 + Math.random() * 0.3,
          maxLife: 0.5,
          size: 1 + ps * 3
        });
      }
    }

    for (let i = this.game.sparkles.length - 1; i >= 0; i--) {
      this.game.sparkles[i].life -= dt;
      if (this.game.sparkles[i].life <= 0) this.game.sparkles.splice(i, 1);
    }
    if (this.game.sparkles.length > MAX_SPARKLES) this.game.sparkles.splice(0, this.game.sparkles.length - MAX_SPARKLES);

    for (let i = this.game.particles.length - 1; i >= 0; i--) {
      this.game.particles[i].update(dt);
      if (this.game.particles[i].life <= 0) this.game.particles.splice(i, 1);
    }
    if (this.game.particles.length > 80) this.game.particles.splice(0, this.game.particles.length - 80);

    // ==========================================================
    // BALL COLOR — hue from pitch or perceived gender (see _computeBallHue),
    // prosody drives saturation and brightness
    // ==========================================================
    const pitchHue = this._computeBallHue(dt);
    this.game.ballHue = pitchHue;
    this.game.ballSat = 25 + ps * 75;   // 25% (muted) → 100% (vivid)
    this.game.ballLit = this.game.colorblindMode
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
    if (this.game.colorMode === 'gender') {
      return this._updateGenderHue();
    }
    const hz = this.game.analyzer.smoothPitchHz;
    let pitchHue;
    if (this.game.colorblindMode) {
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
    const a = this.game.analyzer;
    const g = this.game.genderCues;

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

    const gMode = this.game.goalMode || 'feminization';
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
    this.game.smoothGenderScore += (score - this.game.smoothGenderScore) * lerp;
    this.game.genderUncertainty = uncertainty;
    return genderScoreToHue(this.game.smoothGenderScore, this.game.colorblindMode);
  }

  drawSceneInternal(prosodyGlow) {
    const ctx = this.game.ctx;
    const w = this.game.width;
    const h = this.game.height;
    if (!w || !h) return;

    // Background — theme-aware
    const themePresets = {
      highcontrast: ['#030305', '#080814', '#0c0c1f', '#12122a']
    };
    const colors = themePresets[this.game.themeMode] || themePresets.highcontrast;
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, colors[0]);
    bgGrad.addColorStop(0.4, colors[1]);
    bgGrad.addColorStop(0.7, colors[2]);
    bgGrad.addColorStop(1, colors[3]);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Stars
    const time = performance.now() / 1000;
    for (const star of this.game.stars) {
      const sx = ((star.x - this.game.scrollX * 0.05) % (w + 100) + w + 100) % (w + 100);
      const twinkle = 0.4 + 0.6 * Math.sin(time * 2.2 + star.twinkle + prosodyGlow * 2);
      ctx.globalAlpha = twinkle * 0.6;
      ctx.fillStyle = '#e8e6f0';
      ctx.beginPath();
      ctx.arc(sx, star.y, star.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Mountain ranges — parallax layers for speed perception
    if (this.game.mountainLayers) {
      for (const mtn of this.game.mountainLayers) {
        const baseY = h * mtn.baseY;
        const scrollOffset = this.game.scrollX * mtn.parallax;
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
    const zoomPivotX = this.game.ball.x;
    const zoomPivotY = this.game.groundY;
    ctx.translate(zoomPivotX, zoomPivotY);
    ctx.scale(this.game.cameraZoom, this.game.cameraZoom);
    ctx.translate(-zoomPivotX, -zoomPivotY);
    ctx.translate(0, -this.game.cameraY);

    // Ground fill — extend bottom well past viewport for camera shifts + zoom
    const groundFillBottom = h / this.game.cameraZoom + Math.abs(this.game.cameraY) + 200;
    // Ground fill with extended range for zoom
    const margin = w * 0.3; // extra margin for zoom edges
    ctx.beginPath();
    ctx.moveTo(-margin, groundFillBottom);
    for (let x = -margin; x <= w + margin; x += 4) {
      ctx.lineTo(x, this.getGroundHeight(this.game.scrollX + x));
    }
    ctx.lineTo(w + margin, groundFillBottom);
    ctx.closePath();
    const groundGrad = ctx.createLinearGradient(0, this.game.groundY - 40, 0, groundFillBottom);
    const gc = this.game._groundColors || ['#1e1e3a', '#191932', '#121228'];
    groundGrad.addColorStop(0, gc[0]);
    groundGrad.addColorStop(0.2, gc[1]);
    groundGrad.addColorStop(1, gc[2]);
    ctx.fillStyle = groundGrad;
    ctx.fill();

    // Ground line — brighter for visibility
    ctx.beginPath();
    for (let x = -margin; x <= w + margin; x += 4) {
      const gy = this.getGroundHeight(this.game.scrollX + x);
      if (x === -margin) ctx.moveTo(x, gy); else ctx.lineTo(x, gy);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Trail
    for (const tp of this.game.trailPoints) {
      const screenX = tp.wx - this.game.scrollX;
      if (screenX < -50 || screenX > w + 50) continue;
      ctx.globalAlpha = tp.life * 0.4;
      ctx.fillStyle = `hsl(${tp.hue}, 80%, 60%)`;
      ctx.beginPath();
      ctx.arc(screenX, tp.sy, tp.size * tp.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Speed lines — horizontal streaks when moving fast
    if (this.game.scrollSpeed > 150) {
      const speedIntensity = Math.min(1, (this.game.scrollSpeed - 150) / 200); // 0→1 from 150→350 px/s
      const lineCount = Math.floor(3 + speedIntensity * 8);
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.04 + speedIntensity * 0.12})`;
      ctx.lineWidth = 1 + speedIntensity;
      for (let i = 0; i < lineCount; i++) {
        // Distribute lines around the ball with some randomness
        const seed = (i * 7919 + Math.floor(this.game.scrollX * 0.1)) % 1000 / 1000; // deterministic per frame
        const yOffset = (seed - 0.5) * this.game.height * 0.6;
        const lineY = this.game.ball.y + yOffset;
        const lineLen = 30 + speedIntensity * 80 + seed * 40;
        const lineX = this.game.ball.x - this.game.ball.radius * 2 - 20 - seed * 60;
        ctx.globalAlpha = (0.08 + speedIntensity * 0.2) * (1 - Math.abs(yOffset) / (this.game.height * 0.35));
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
    for (const p of this.game.particles) p.draw(ctx);

    // Shadow
    const groundAtBall = this.getGroundHeight(this.game.scrollX + this.game.ball.x);
    const shadowDist = groundAtBall - (this.game.ball.y + this.game.ball.radius);
    const shadowAlpha = Math.max(0, 0.3 - shadowDist * 0.002);
    const shadowScale = Math.max(0.3, 1 - shadowDist * 0.003);
    if (shadowAlpha > 0.01) {
      ctx.globalAlpha = shadowAlpha;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(this.game.ball.x, groundAtBall, this.game.ball.radius * shadowScale * 1.2, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Ball
    ctx.save();
    ctx.translate(this.game.ball.x, this.game.ball.y + this.game.ball.radius * (1 - this.game.ball.squash) * 0.5);
    ctx.scale(1 + (1 - this.game.ball.squash) * 0.3, this.game.ball.squash);

    // Ball glow — boosted for visibility against dark scene
    const glowSize = this.game.ball.radius * (2.2 + prosodyGlow * 1.5);
    const glowGrad = ctx.createRadialGradient(0, 0, this.game.ball.radius * 0.2, 0, 0, glowSize);
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
      -this.game.ball.radius * 0.25, -this.game.ball.radius * 0.25, 0,
      0, 0, this.game.ball.radius
    );
    ballGrad.addColorStop(0, '#fff');
    ballGrad.addColorStop(0.12, this.getBallColor());
    ballGrad.addColorStop(0.85, this.getBallColor());
    ballGrad.addColorStop(1, '#222');
    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.arc(0, 0, this.game.ball.radius, 0, Math.PI * 2);
    ctx.fill();

    // Rim light — subtle bright edge
    ctx.strokeStyle = this.getBallColor(0.4);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, this.game.ball.radius - 0.5, 0, Math.PI * 2);
    ctx.stroke();

    // Resonance ring — shows vocal tract resonance (F1/F2/F3)
    // Inner ring: F2-based (primary), Outer ring: F3-based (secondary)
    // Cool blue-violet = low/dark resonance → warm gold = high/bright resonance
    const res = this.game.analyzer.smoothResonance;
    const resConf = this.game.analyzer.formantConfidence;
    const resAlpha = (0.10 + res * 0.35 + prosodyGlow * 0.1) * (0.3 + resConf * 0.7);
    if (resAlpha > 0.04) {
      // F2 ring (primary): colorblind = blue(220)→yellow(55), normal = blue(240)→gold(45)
      let resHue, resSat, resLit;
      if (this.game.colorblindMode) {
        resHue = 220 - res * 165; // 220 (blue) → 55 (yellow)
        resSat = 70 + res * 30;
        resLit = 45 + res * 35;   // darker blue → brighter yellow (luminance-mapped)
      } else {
        resHue = 240 - res * 195;
        resSat = 60 + res * 40;
        resLit = 50 + res * 30;
      }
      const ringRadius = this.game.ball.radius + 4 + res * 6 + prosodyGlow * 3;
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
      const f3Norm = Math.max(0, Math.min(1, (this.game.analyzer.smoothF3 - 2200) / 1200));
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
    ctx.rotate(this.game.ball.rotation);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, this.game.ball.radius * 0.7, -0.5, 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, this.game.ball.radius * 0.7, Math.PI - 0.5, Math.PI + 0.5);
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    // Sparkles
    for (const s of this.game.sparkles) {
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
}
