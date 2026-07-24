const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export class ModalFocusManager {
  constructor({ root = document.getElementById('app') } = {}) {
    this.root = root;
    this.active = null;
  }

  activate(dialog, { initialFocus, onEscape, exempt = [] } = {}) {
    if (!dialog) return;
    if (this.active?.dialog === dialog) return;
    if (this.active) this.deactivate(this.active.dialog, { restoreFocus: false });

    const inerted = [];
    const exemptions = new Set([dialog, ...exempt].filter(Boolean));
    let node = dialog;
    while (node && node !== this.root?.parentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      for (const sibling of parent.children) {
        if (sibling === node || exemptions.has(sibling) || sibling.contains(dialog)) continue;
        inerted.push({ element: sibling, inert: sibling.inert });
        sibling.inert = true;
      }
      if (node === this.root) break;
      node = parent;
    }

    const previousFocus = document.activeElement;
    const keyHandler = (event) => {
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll(FOCUSABLE)]
        .filter((element) => !element.hidden && element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', keyHandler, true);
    this.active = { dialog, inerted, keyHandler, previousFocus };
    const target = initialFocus || dialog.querySelector(FOCUSABLE) || dialog;
    queueMicrotask(() => target?.focus?.({ preventScroll: true }));
  }

  deactivate(dialog, { restoreFocus = true } = {}) {
    if (!this.active || (dialog && this.active.dialog !== dialog)) return;
    const { inerted, keyHandler, previousFocus } = this.active;
    document.removeEventListener('keydown', keyHandler, true);
    for (const item of inerted) item.element.inert = item.inert;
    this.active = null;
    if (restoreFocus && previousFocus?.isConnected) {
      queueMicrotask(() => previousFocus.focus?.({ preventScroll: true }));
    }
  }
}
