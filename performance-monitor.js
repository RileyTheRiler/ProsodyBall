export class PerformanceMonitor {
  constructor({ panelId = 'perfPanel' } = {}) {
    this.panel = document.getElementById(panelId);
    this.enabled = false;
    this.fps = 0;
    this.frameTimeMs = 0;
    this._frameCount = 0;
    this._accum = 0;
    this._lastUpdate = 0;
    this._worstFrameMs = 0;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!this.panel) return;
    this.panel.classList.toggle('show', enabled);
  }

  toggle() {
    this.setEnabled(!this.enabled);
  }

  sample(dt) {
    const ms = dt * 1000;
    this.frameTimeMs = ms;
    this._worstFrameMs = Math.max(this._worstFrameMs, ms);
    this._frameCount += 1;
    this._accum += dt;

    if (this._accum >= 0.5) {
      this.fps = Math.round(this._frameCount / this._accum);
      this._frameCount = 0;
      this._accum = 0;
      this.render();
    }
  }

  render(extra = '') {
    if (!this.enabled || !this.panel) return;
    const quality = this.fps >= 55 ? 'Excellent' : this.fps >= 40 ? 'Good' : this.fps >= 25 ? 'Degraded' : 'Poor';
    this.panel.innerHTML = `
      <div><b>FPS:</b> ${this.fps}</div>
      <div><b>Frame:</b> ${this.frameTimeMs.toFixed(1)}ms</div>
      <div><b>Worst:</b> ${this._worstFrameMs.toFixed(1)}ms</div>
      <div><b>Quality:</b> ${quality}</div>
      ${extra ? `<div class="perf-extra">${extra}</div>` : ''}
    `;
    this._worstFrameMs = 0;
  }
}
