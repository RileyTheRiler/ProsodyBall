## 2024-05-23 - [DOM-based XSS in Teleprompter]
**Vulnerability:** Found a DOM-based XSS where `innerHTML` was used to render user-provided text (via `window.prompt`) in the teleprompter overlay without sanitization.
**Learning:** Even in client-side-only apps without a backend, user input via `prompt()` or URL parameters can be dangerous if rendered directly to `innerHTML`. Splitting by whitespace doesn't prevent injection if payload contains no spaces.
**Prevention:** Always use `textContent` or robust sanitization (like `escapeHtml`) when rendering user input into the DOM.

## 2024-05-24 - [DOM-based XSS in Iframe Notice]
**Vulnerability:** Found `innerHTML` being used with `window.location.href` to construct a help message link. If the URL contained maliciously crafted fragments or query parameters, this could lead to XSS.
**Learning:** `window.location.href` is a tainted source. Even if browsers URL-encode many characters, relying on `innerHTML` string concatenation for attribute values (`<a href="' + url + '">`) is brittle and prone to breakage or exploitation in edge cases.
**Prevention:** Use `document.createElement('a')` and set the `.href` property directly. This ensures the browser handles escaping correctly, eliminating the XSS vector entirely without complex sanitization logic.
