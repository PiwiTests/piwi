#!/bin/bash
# Prepare a Claude Code on the web session so the standard checks actually run.
#
# Three things are missing from a fresh container, and each one makes a whole
# class of verification impossible:
#   1. node_modules — nothing runs at all.
#   2. packages/reporter/dist — playwright.config.ts imports the built reporter, so the
#      E2E suite cannot even load its config, and a unit test that compares the
#      app against the reporter's build fails.
#   3. A Chromium matching the pinned Playwright — without it every
#      browser-driven spec dies on a missing binary, which reads like an
#      unrelated failure and tempts you to skip UI verification entirely.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Install exactly what package-lock.json pins, as CI does, without writing it: the
# container's npm 10 would rewrite the npm 11 lockfile under `npm install`, leaving
# every session with a lockfile change unrelated to its task. npm ci deletes
# node_modules first (~35s against ~5s for an up-to-date install), so a resumed or
# compacted session skips it while the tree is the one npm ci installed from this
# very lockfile under this Node. node_modules/.package-lock.json cannot tell: npm 10
# writes it in its own form, so it never equals the committed lockfile.
stamp="node_modules/.session-start-install"
installed="$(node --version) $(sha256sum package-lock.json | cut -d ' ' -f 1)"
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$installed" ]; then
  echo "[session-start] workspace dependencies match package-lock.json; skipping the install"
else
  echo "[session-start] installing workspace dependencies"
  npm ci --no-audit --fund=false
  echo "$installed" > "$stamp"
fi

echo "[session-start] building the reporter (playwright.config.ts imports it)"
npm run reporter:build --workspace packages/reporter

# Prefer the browser Playwright pins: the full Chromium as well as the headless
# shell, because the extension's specs load an unpacked extension, which only a
# full browser can. When the download is unavailable, fall back to whatever
# Chromium the image already provides and tell Playwright about it via the
# repo's PLAYWRIGHT_CHROMIUM_EXECUTABLE hook.
echo "[session-start] resolving a Chromium for Playwright"
if npx --yes playwright install chromium >/dev/null 2>&1; then
  echo "[session-start] using the pinned Playwright Chromium"
else
  found=""
  for candidate in \
    "${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}/chromium" \
    "$(command -v chromium 2>/dev/null || true)" \
    "$(command -v chromium-browser 2>/dev/null || true)" \
    "$(command -v google-chrome 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      found="$candidate"
      break
    fi
  done

  if [ -n "$found" ]; then
    echo "[session-start] pinned download unavailable; using $found"
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
      echo "export PLAYWRIGHT_CHROMIUM_EXECUTABLE=\"$found\"" >> "$CLAUDE_ENV_FILE"
    fi
  else
    echo "[session-start] WARNING: no Chromium found — browser-driven specs will not run"
  fi
fi

echo "[session-start] ready"
