## 2024-05-23 - [DOM-based XSS in Teleprompter]
**Vulnerability:** Found a DOM-based XSS where `innerHTML` was used to render user-provided text (via `window.prompt`) in the teleprompter overlay without sanitization.
**Learning:** Even in client-side-only apps without a backend, user input via `prompt()` or URL parameters can be dangerous if rendered directly to `innerHTML`. Splitting by whitespace doesn't prevent injection if payload contains no spaces.
**Prevention:** Always use `textContent` or robust sanitization (like `escapeHtml`) when rendering user input into the DOM.

## 2024-05-24 - [DOM-based XSS in Iframe Notice]
**Vulnerability:** Found `innerHTML` being used with `window.location.href` to construct a help message link. If the URL contained maliciously crafted fragments or query parameters, this could lead to XSS.
**Learning:** `window.location.href` is a tainted source. Even if browsers URL-encode many characters, relying on `innerHTML` string concatenation for attribute values (`<a href="' + url + '">`) is brittle and prone to breakage or exploitation in edge cases.
**Prevention:** Use `document.createElement('a')` and set the `.href` property directly. This ensures the browser handles escaping correctly, eliminating the XSS vector entirely without complex sanitization logic.
## 2024-05-24 - [DOM-based XSS via Error Rendering]
**Vulnerability:** Found multiple DOM-based XSS vulnerabilities in `app.js` where `window.location.href` and external error messages (`result.message`) were directly concatenated into HTML strings and passed to `innerHTML` via the `showError` function and embedded `iframeNotice`.
**Learning:** URL parameters or variables derived from `window.location` (like `href`) must never be trusted. Even if constructed client-side, they can be manipulated to break out of attributes. Relying on string concatenation for DOM updates safely is error-prone.
**Prevention:** Always use safe DOM APIs like `document.createElement`, `.textContent`, and direct property assignments (e.g., `link.href`) when constructing UI elements dynamically with untrusted data. Helper functions like `showError` should be designed to accept and render DOM `Node` objects safely.
## 2024-05-28 - [DOM-based XSS via innerHTML eliminated]
**Vulnerability:** Found multiple DOM-based XSS vectors in `app.js` where `innerHTML` was being assigned dynamic strings, specifically in `showError`, `diagPanel`, and `errNode` functions.
**Learning:** The codebase had remaining instances of `innerHTML` usage despite previous fixes. Direct assignment to `innerHTML` with dynamic content (even error messages) is unsafe as it allows arbitrary HTML injection.
**Prevention:** Safely build DOM elements using `document.createElement` and set text using `textContent`. For inline building, `Node.append()` with `Object.assign(document.createElement('b'), { textContent: ... })` provides a clean and safe alternative to template literals with `innerHTML`.
