export async function registerPwa() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try {
    return await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
  } catch (error) {
    console.warn('Offline support could not be registered:', error);
    return null;
  }
}

export class SessionWakeLock {
  constructor() {
    this.lock = null;
    this.wanted = false;
    this._onVisibility = () => {
      if (this.wanted && document.visibilityState === 'visible') this.request();
    };
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  async request() {
    this.wanted = true;
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || this.lock) return false;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => { this.lock = null; }, { once: true });
      return true;
    } catch {
      return false;
    }
  }

  async release() {
    this.wanted = false;
    const lock = this.lock;
    this.lock = null;
    if (lock) await lock.release().catch(() => {});
  }

  destroy() {
    this.release();
    document.removeEventListener('visibilitychange', this._onVisibility);
  }
}
