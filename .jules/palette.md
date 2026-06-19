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
## 2024-05-18 - [Missing aria-label on custom toggle switches]
**Learning:** Found that custom toggle switches built using `<label class="toggle-switch">` with an `<input type="checkbox">` and `<span class="toggle-slider">` often lack explicit labels. While visually intuitive, screen readers only see an empty checkbox.
**Action:** Always ensure that custom toggle switches include an explicit `aria-label` directly on the `<input type="checkbox">` element (e.g., `aria-label="Toggle all vibration alerts"`) so screen reader users understand what the toggle controls.
## 2026-03-13 - [Missing aria-controls on toggle buttons]
**Learning:** Found that some buttons toggling UI panels (#contextToggleBtn, #metersExpandToggle) had `aria-expanded` but lacked the `aria-controls` attribute, which breaks the programmatic association between the toggle button and the panel it controls for screen reader users.
**Action:** When adding `aria-expanded` to a toggle button, always ensure it is paired with `aria-controls="[id-of-target-panel]"` to explicitly link the control to its target content.
## 2026-03-15 - [Inaccessible custom toggle switches]
**Learning:** Discovered that custom toggle switches built with `<label class="toggle-switch">` wrapping an `<input type="checkbox">` and `<span class="toggle-slider">` were inaccessible to screen readers because they lacked `aria-label` attributes on the actual `<input>` element. Also, adjacent descriptive text was using generic `<span>` tags, resulting in poor clickable hit-areas.
**Action:** Always add an explicit `aria-label` directly to the `<input>` element inside custom toggle components. In addition, replace adjacent text elements like `<span>` with `<label for="[input-id]">` to drastically improve the clickable hit-area for mouse and touch users.
## $(date +%Y-%m-%d) - [Inaccessible custom toggle switches due to duplicate IDs]
**Learning:** Discovered that custom toggle switches built with `<label class="toggle-switch">` wrapping an `<input type="checkbox">` were failing because the `id` on the `<input>` was duplicated elsewhere in the DOM. This breaks the `<label for="[id]">` association, rendering the toggle invisible to screen readers and difficult to click.
**Action:** Ensure custom toggle `<input>` elements have strictly unique IDs across the entire document so they correctly link with their `<label>` elements.

## $(date +%Y-%m-%d) - [Inaccessible ARIA Tabs]
**Learning:** Found that tab widgets in the UI (e.g., `.help-tabs`) were missing semantic ARIA roles (`role="tablist"`, `role="tab"`, `role="tabpanel"`) and relationship attributes (`aria-controls`, `aria-labelledby`). Without these, screen readers treat them as plain buttons and unassociated content.
**Action:** When implementing or modifying ARIA tabs, always ensure semantic roles are applied. Furthermore, the `aria-selected` attribute on tabs and the `hidden` attribute on inactive panels must be dynamically updated in JavaScript to accurately reflect the active tab state.
