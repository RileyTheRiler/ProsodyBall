## 2025-05-15 - [Keyboard Trap: Tooltips]
**Learning:** Found that info tooltips were hardcoded with `tabindex="-1"`, making them completely invisible to keyboard users despite having semantic button roles. This likely happened because they were seen as "hover-only" visual aids.
**Action:** Always test interactive elements with Tab navigation. If it has a click/hover interaction, it MUST be reachable by keyboard. Removed negative tabindex to restore natural flow.

## 2026-03-16 - [Missing aria-expanded on toggle buttons]
**Learning:** Found that the metrics panel expand toggle button (`#metersExpandToggle`) lacked the `aria-expanded` attribute, leaving screen reader users unaware of the panel's state.
**Action:** When creating or modifying elements that toggle visibility of other content, always ensure `aria-expanded` is set initially and updated dynamically in JavaScript.
## 2026-03-08 - [Missing aria-expanded on toggle buttons]
**Learning:** Found that buttons toggling UI panels (#settingsBtn, #vibToggle, #helpBtn, #recordingsBtn, #cameraBtn) lacked the `aria-expanded` attribute, leaving screen reader users unaware of the panel's state.
**Action:** When creating or modifying elements that toggle visibility of other content, always ensure `aria-expanded` is set initially and updated dynamically in JavaScript (including on outside-click dismissals).

## 2026-03-16 - [Inaccessible Custom Toggle Switches]
**Learning:** Found that custom toggle switches built using `<label class="toggle-switch">` with an internal `<input type="checkbox">` had missing explicit `aria-label`s on the input element, leaving screen reader users without context. Furthermore, associated descriptive text used `<span>` or an unassociated `<label>` rather than `<label for="[input-id]">`, reducing the clickable hit-area and hindering screen reader association.
**Action:** When creating custom toggle switches in this app's UI pattern, always ensure the `<input>` element has an explicit `aria-label`. Associated descriptive text must use `<label for="[input-id]">` instead of `<span>` to increase the clickable hit-area and enhance screen reader accessibility.
