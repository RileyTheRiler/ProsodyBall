#!/bin/bash
# Session-start hook for Claude Code on the web.
# Installs JS dependencies so the project's checks run cleanly in a fresh
# remote container. The core checks (npm run lint, test:unit, test:audio-fixtures)
# run on stock Node with no dependencies; this primarily sets up `serve` and the
# browser-test tooling. Puppeteer's heavy Chromium download is skipped for fast,
# reliable startup — the optional `test:browser-matrix` job needs it and can pull
# it on demand, but it is not part of the core loop.
set -euo pipefail

# Only run in the remote (web) environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

export PUPPETEER_SKIP_DOWNLOAD=true
# npm install (not ci) so the cached container layer is reused on resume.
# Non-fatal: the core node tests pass even if install fails.
npm install --no-audit --no-fund || echo "session-start: npm install failed; core Node tests still run without dependencies"
