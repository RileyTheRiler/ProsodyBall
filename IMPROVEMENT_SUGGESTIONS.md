# Vox Arcade improvement suggestions

This is a practical backlog focused on three goals: **better UX**, **more reliable signal accuracy**, and **easier iteration**.

## Highest-impact UX improvements

1. **Make the first 30 seconds “guided” instead of “blank slate”.**
   - Add a short in-app checklist after mic start: "Room quiet ✓", "Voice detected ✓", "Pitch lock ✓".
   - Why: users currently have to infer whether setup worked.

2. **Turn raw metrics into coaching tips.**
   - Add context hints tied to each rule (for example: "Try bigger pitch jumps" when bounce is low).
   - Keep tips rate-limited (e.g., update every 1–2 seconds) so they feel helpful, not noisy.

3. **Clarify calibration outcomes and next actions.**
   - Distinguish "calibration skipped", "timed out", and "successful" with specific UI labels.
   - Offer one-click "Recalibrate" from the HUD.

4. **Improve accessibility and control discoverability.**
   - Add ARIA labels/tooltips for icon-only controls.
   - Ensure all controls are reachable by keyboard, with visible focus styling.

## Accuracy improvements for voice tools

1. **Use per-user pitch range adaptation.**
   - Learn a user-specific min/max pitch during the first 5–10 seconds of detected voicing.
   - Map gameplay from adaptive range instead of fixed defaults.
   - Benefit: better responsiveness for both lower and higher voices.

2. **Gate scoring by confidence and voiced state.**
   - Down-weight bounce/articulation updates when pitch/formant confidence is low.
   - Prevent unstable values from creating misleading visual feedback.

3. **Replace static thresholds with robust statistics.**
   - Convert fixed thresholds (energy/vowel/articulation) to rolling-percentile baselines.
   - This handles differences in microphones, distance, and background noise more consistently.

4. **Add an evaluation harness with canned clips.**
   - Build a small fixture set of speech samples and expected metric ranges.
   - Run the analyzer over clips in CI and track drift over time.
   - Benefit: catches regressions in detection quality before release.

## Product and iteration improvements

1. **Add session-level progress feedback.**
   - Show personal best, streaks, and “today vs last session” trend lines.
   - This improves retention and makes practice goals concrete.

2. **Add presets for intent-specific practice.**
   - Examples: "Presentation", "Storytelling", "Call-center clarity".
   - Each preset can tune rule weights and feedback language.

3. **Reduce maintenance risk from dual app entrypoints.**
   - There is a compatibility shim at `js/app.js` that also contains duplicated app logic.
   - Consolidate to a single source of truth to avoid divergence bugs.

4. **Instrument privacy-safe analytics for UX funnels.**
   - Track only event counts (e.g., calibration started/completed, average session length).
   - Use this to identify where users drop off in onboarding.

## Suggested rollout plan

- **Phase 1 (quick wins):** coaching hints, recalibrate CTA, adaptive pitch range.
- **Phase 2:** confidence-gated scoring + robust thresholding.
- **Phase 3:** fixture-based accuracy regression tests and practice presets.
