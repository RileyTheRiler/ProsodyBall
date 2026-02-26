## 2024-05-23 - [DOM-based XSS in Teleprompter]
**Vulnerability:** Found a DOM-based XSS where `innerHTML` was used to render user-provided text (via `window.prompt`) in the teleprompter overlay without sanitization.
**Learning:** Even in client-side-only apps without a backend, user input via `prompt()` or URL parameters can be dangerous if rendered directly to `innerHTML`. Splitting by whitespace doesn't prevent injection if payload contains no spaces.
**Prevention:** Always use `textContent` or robust sanitization (like `escapeHtml`) when rendering user input into the DOM.
