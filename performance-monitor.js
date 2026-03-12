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

    // Security enhancement: use safe DOM manipulation instead of innerHTML to prevent DOM-based XSS
    this.panel.textContent = '';

    const appendStat = (label, value) => {
      const div = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = label;
      div.append(b, ' ', value);
      this.panel.appendChild(div);
    };

    appendStat('FPS:', this.fps);
    appendStat('Frame:', `${this.frameTimeMs.toFixed(1)}ms`);
    appendStat('Worst:', `${this._worstFrameMs.toFixed(1)}ms`);
    appendStat('Quality:', quality);

    if (extra) {
      const extraDiv = document.createElement('div');
      extraDiv.className = 'perf-extra';
      extraDiv.textContent = extra;
      this.panel.appendChild(extraDiv);
    }
    this._worstFrameMs = 0;
  }
}
