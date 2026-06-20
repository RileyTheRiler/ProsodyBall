// ============================================================
// TELEPROMPTER — reading overlay (manual Space/Tap advance)
// ============================================================
// Owns the teleprompter passage state and overlay rendering. Self-contained:
// it touches only its own DOM overlay and is told whether a session is running.
// Extracted from VoxBallGame to keep the game class focused.

const DEFAULT_RAINBOW_TEXT =
  `When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. ` +
  `The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, ` +
  `with its path high above, and its two ends apparently beyond the horizon. There is, according to legend, a boiling pot of gold at one end.`;

export class Teleprompter {
  constructor(options = {}) {
    this.mode = options.mode || 'off';                 // 'off' | 'rainbow' | 'custom'
    this.customText = options.customText || '';
    this.rainbowText = options.rainbowText || DEFAULT_RAINBOW_TEXT;
    this.index = 0;
    this.sentenceIndex = 0;                             // current sentence for manual advance
    this._lastIdx = -1;
    this._lastText = '';
  }

  // Split a passage into sentences, keeping terminal punctuation with each
  // sentence and capturing any trailing fragment that lacks final punctuation.
  splitSentences(text) {
    if (!text) return [];
    const parts = text.match(/[^.!?]+[.!?]+(?:["')\]]+)?|\S[^.!?]*$/g);
    return (parts || [text]).map((s) => s.trim()).filter(Boolean);
  }

  sourceText() {
    return this.mode === 'custom' ? this.customText : this.rainbowText;
  }

  // Manual advance: speaker presses Space (desktop) or taps (mobile) to reveal
  // the next sentence. Wraps back to the start at the end of the passage.
  advanceManual() {
    const enabled = this.mode !== 'off';
    if (!enabled) return;
    const sentences = this.splitSentences(this.sourceText());
    if (!sentences.length) return;
    this.sentenceIndex = (this.sentenceIndex + 1) % sentences.length;
  }

  render(dt, isRunning) {
    const overlay = document.getElementById('teleprompterOverlay');
    if (!overlay) return;
    const hint = document.getElementById('teleprompterHint');
    const enabled = this.mode !== 'off';
    overlay.classList.toggle('show', enabled);
    if (hint) hint.classList.toggle('show', enabled && isRunning);
    if (!enabled) { this._lastIdx = -1; return; }

    // This runs every frame — only re-split and rebuild the overlay DOM when the
    // passage text or sentence index actually changed.
    const sourceText = this.sourceText();
    if (this.sentenceIndex === this._lastIdx && sourceText === this._lastText) return;

    const sentences = this.splitSentences(sourceText);
    if (!sentences.length) return;
    if (this.sentenceIndex >= sentences.length) {
      this.sentenceIndex = sentences.length - 1;
    }
    const idx = this.sentenceIndex;
    this._lastIdx = idx;
    this._lastText = sourceText;

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
}
