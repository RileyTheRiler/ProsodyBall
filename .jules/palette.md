## 2025-05-15 - [Keyboard Trap: Tooltips]
**Learning:** Found that info tooltips were hardcoded with `tabindex="-1"`, making them completely invisible to keyboard users despite having semantic button roles. This likely happened because they were seen as "hover-only" visual aids.
**Action:** Always test interactive elements with Tab navigation. If it has a click/hover interaction, it MUST be reachable by keyboard. Removed negative tabindex to restore natural flow.

## 2026-03-08 - [Missing aria-expanded on toggle buttons]
**Learning:** Found that buttons toggling UI panels (#settingsBtn, #vibToggle, #helpBtn, #recordingsBtn, #cameraBtn) lacked the `aria-expanded` attribute, leaving screen reader users unaware of the panel's state.
**Action:** When creating or modifying elements that toggle visibility of other content, always ensure `aria-expanded` is set initially and updated dynamically in JavaScript (including on outside-click dismissals).

## 2026-03-13 - [Missing aria-controls on toggle buttons]
**Learning:** Found that some buttons toggling UI panels (#contextToggleBtn, #metersExpandToggle) had `aria-expanded` but lacked the `aria-controls` attribute, which breaks the programmatic association between the toggle button and the panel it controls for screen reader users.
**Action:** When adding `aria-expanded` to a toggle button, always ensure it is paired with `aria-controls="[id-of-target-panel]"` to explicitly link the control to its target content.