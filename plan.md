1. **Update `index.html` to add `aria-pressed="false"` attribute to toggle buttons.**
   - Find `#cbToggle`, `#pauseCanvasBtn`, and `#motionToggle` and add `aria-pressed="false"` initially.
2. **Update `app.js` to dynamically sync `aria-pressed` with the `.active` class for these toggle buttons.**
   - Inside the `#cbToggle` click listener, add `cbBtn.setAttribute('aria-pressed', String(this.colorblindMode));` after it toggles `.active`.
   - Inside the `#pauseCanvasBtn` click listener, add `pauseCanvasBtn.setAttribute('aria-pressed', String(this.voiceCanvasPaused));` after it toggles `.active`.
   - Also update `aria-pressed` to `'false'` whenever `this.voiceCanvasPaused` is reset to `false`. I have verified with `grep -n "pauseCanvasBtn.classList.remove" app.js` that these areas exist and toggle `.active` state off at line 3312 and line 3848, so I will add `pauseCanvasBtn.setAttribute('aria-pressed', 'false');` there.
   - Inside `syncMotionToggleLabel`, add `motionToggle.setAttribute('aria-pressed', String(this.userMotionPreference === 'low'));` after it toggles `.active`.
3. **Run testing & linting.**
   - Run `pnpm lint` and `pnpm test:all` to ensure code style is maintained.
4. **Complete pre-commit steps to ensure proper testing, verification, review, and reflection are done.**
