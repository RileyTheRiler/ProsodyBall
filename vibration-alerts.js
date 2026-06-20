// ============================================================
// VIBRATION ALERT ENGINE
// ============================================================
// Owns the user-defined alert rules and the haptic/screen-shake/on-canvas-flash
// feedback they trigger. The instance also holds the live state the rest of the
// game reads/writes directly (rules, enabled, flashAlpha, flashMetric, nextId),
// so it can drop in where the old plain `this.vibration` object was. The two
// engine methods take a per-frame context with the metric values + DOM refs they
// need, keeping this module free of any VoxBallGame coupling.

const METRIC_LABELS = {
  pitch: 'Pitch', resonance: 'Resonance', energy: 'Energy',
  bounce: 'Pitch Var.', tempo: 'Tempo', vowel: 'Vowels', articulation: 'Articulation'
};

export class VibrationAlerts {
  constructor() {
    this.enabled = false;
    this.rules = [];
    this.nextId = 1;
    this.shakeTimer = 0;
    this.hasHaptic = typeof navigator !== 'undefined' && 'vibrate' in navigator;
    this.globalCooldown = 0;
    this.flashAlpha = 0;       // on-canvas alert flash opacity
    this.flashMetric = '';     // which metric tripped (for display)
    this._liveUpdateTimer = 0;
  }

  // ctx: { metrics, pitchHz, resonance, syllableSpeedFactor, gameArea,
  //        reducedMotion, onLiveUpdate }
  check(dt, ctx) {
    // Decay flash alpha always (even when disabled, to fade out)
    this.flashAlpha = Math.max(0, this.flashAlpha - dt * 3);

    if (!this.enabled || this.rules.length === 0) return;

    this.globalCooldown = Math.max(0, this.globalCooldown - dt);

    if (this.shakeTimer > 0) {
      this.shakeTimer -= dt;
      if (this.shakeTimer <= 0 && ctx.gameArea) {
        ctx.gameArea.classList.remove('vib-shake');
      }
    }

    const m = ctx.metrics;
    const hz = ctx.pitchHz;
    const isSpeaking = m.energy > 0.05;
    let needsRender = false;
    let trippedLabel = '';

    for (const rule of this.rules) {
      if (!rule.enabled) {
        if (rule.tripped) { rule.tripped = false; needsRender = true; }
        continue;
      }

      rule.cooldownTimer = Math.max(0, rule.cooldownTimer - dt);

      let currentVal;
      switch (rule.metric) {
        case 'pitch': currentVal = hz; break;
        case 'resonance': currentVal = ctx.resonance * 100; break;
        case 'energy': currentVal = m.energy * 100; break;
        case 'bounce': currentVal = m.bounce * 100; break;
        case 'tempo': currentVal = (ctx.syllableSpeedFactor || 0) * 100; break;
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
        trippedLabel = METRIC_LABELS[rule.metric] || rule.metric;

        if (rule.cooldownTimer <= 0 && this.globalCooldown <= 0) {
          this.trigger(trippedLabel, ctx);
          rule.cooldownTimer = 0.5;
          this.globalCooldown = 0.25;
        }
      }
    }

    // Update live values when vib panel is visible (throttled to ~10fps)
    if (ctx.onLiveUpdate) {
      this._liveUpdateTimer = (this._liveUpdateTimer || 0) + dt;
      if (this._liveUpdateTimer > 0.1) {
        this._liveUpdateTimer = 0;
        const vibPanelEl = document.getElementById('vibPanel');
        if (vibPanelEl && vibPanelEl.classList.contains('show')) {
          ctx.onLiveUpdate();
        } else if (needsRender) {
          // Even if panel closed, update tripped state for next open
          ctx.onLiveUpdate();
        }
      }
    }
  }

  trigger(metricLabel, ctx) {
    if (this.hasHaptic) {
      try { navigator.vibrate([40, 30, 40]); } catch (e) { /* haptics unavailable */ }
    }

    // Screen shake (skip if reduced motion)
    if (ctx.gameArea && !ctx.reducedMotion) {
      ctx.gameArea.classList.remove('vib-shake');
      void ctx.gameArea.offsetWidth;
      ctx.gameArea.classList.add('vib-shake');
      this.shakeTimer = 0.15;
    }

    // On-canvas flash (always show — it's a brief opacity change, not motion)
    this.flashAlpha = 1;
    this.flashMetric = metricLabel || '';
  }
}
