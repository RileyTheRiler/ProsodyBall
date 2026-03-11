## 2025-05-15 - [Keyboard Trap: Tooltips]
**Learning:** Found that info tooltips were hardcoded with `tabindex="-1"`, making them completely invisible to keyboard users despite having semantic button roles. This likely happened because they were seen as "hover-only" visual aids.
**Action:** Always test interactive elements with Tab navigation. If it has a click/hover interaction, it MUST be reachable by keyboard. Removed negative tabindex to restore natural flow.

## $(date +%Y-%m-%d) - [Missing aria-expanded on toggle buttons]
**Learning:** Found that the metrics panel expand toggle button (`#metersExpandToggle`) lacked the `aria-expanded` attribute, leaving screen reader users unaware of the panel's state.
**Action:** When creating or modifying elements that toggle visibility of other content, always ensure `aria-expanded` is set initially and updated dynamically in JavaScript.
## 2026-03-08 - [Missing aria-expanded on toggle buttons]
**Learning:** Found that buttons toggling UI panels (#settingsBtn, #vibToggle, #helpBtn, #recordingsBtn, #cameraBtn) lacked the `aria-expanded` attribute, leaving screen reader users unaware of the panel's state.
**Action:** When creating or modifying elements that toggle visibility of other content, always ensure `aria-expanded` is set initially and updated dynamically in JavaScript (including on outside-click dismissals).

## 2024-05-18 - [Missing aria-label on custom toggle switches]
**Learning:** Found that custom toggle switches built using `<label class="toggle-switch">` with an `<input type="checkbox">` and `<span class="toggle-slider">` often lack explicit labels. While visually intuitive, screen readers only see an empty checkbox.
**Action:** Always ensure that custom toggle switches include an explicit `aria-label` directly on the `<input type="checkbox">` element (e.g., `aria-label="Toggle all vibration alerts"`) so screen reader users understand what the toggle controls.
