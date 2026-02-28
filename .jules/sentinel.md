## 2024-05-23 - [DOM-based XSS in Teleprompter]
**Vulnerability:** Found a DOM-based XSS where `innerHTML` was used to render user-provided text (via `window.prompt`) in the teleprompter overlay without sanitization.
**Learning:** Even in client-side-only apps without a backend, user input via `prompt()` or URL parameters can be dangerous if rendered directly to `innerHTML`. Splitting by whitespace doesn't prevent injection if payload contains no spaces.
**Prevention:** Always use `textContent` or robust sanitization (like `escapeHtml`) when rendering user input into the DOM.
## 2024-05-24 - [DOM-based XSS via Error Rendering]
**Vulnerability:** Found multiple DOM-based XSS vulnerabilities in `app.js` where `window.location.href` and external error messages (`result.message`) were directly concatenated into HTML strings and passed to `innerHTML` via the `showError` function and embedded `iframeNotice`.
**Learning:** URL parameters or variables derived from `window.location` (like `href`) must never be trusted. Even if constructed client-side, they can be manipulated to break out of attributes. Relying on string concatenation for DOM updates safely is error-prone.
**Prevention:** Always use safe DOM APIs like `document.createElement`, `.textContent`, and direct property assignments (e.g., `link.href`) when constructing UI elements dynamically with untrusted data. Helper functions like `showError` should be designed to accept and render DOM `Node` objects safely.
