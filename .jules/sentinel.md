## 2025-02-23 - DOM-based XSS via location href
**Vulnerability:** Multiple anchor elements dynamically generated `.href` properties using `window.location.href` directly, creating a vector for DOM-based Cross-Site Scripting (XSS).
**Learning:** Even internal location properties can be manipulated via URL fragments or parameters if assigned directly to executable contexts like `.href`.
**Prevention:** Implement and enforce a centralized `sanitizeUrl` utility that strictly validates URL protocols against an allowlist (e.g., `http:`, `https:`, `blob:`) and blocks dangerous protocols (`javascript:`, `data:`). Always wrap dynamic URL assignments.
