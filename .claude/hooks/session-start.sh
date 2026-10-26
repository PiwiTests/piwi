#!/bin/bash
# Prepare a Claude Code on the web session so the standard checks actually run.
#
# Four things are missing from a fresh container, and each one makes a whole
# class of verification impossible or misleading:
#   1. The Node the repository names — the container ships Node 22 and npm 10,
#      below the root `engines` floor (Node 24) that CI and contributors run on.
#   2. node_modules — nothing runs at all.
#   3. packages/reporter/dist — playwright.config.ts imports the built reporter, so the
#      E2E suite cannot even load its config, and a unit test that compares the
#      app against the reporter's build fails.
#   4. A Chromium matching the pinned Playwright — without it every
#      browser-driven spec dies on a missing binary, which reads like an
#      unrelated failure and tempts you to skip UI verification entirely.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Run on the Node release line the root .node-version names, as CI's setup-workspace
# action does: the newest release of that line, downloaded from nodejs.org, checked
# against its published SHA-256, and put first on the PATH of this script and,
# through CLAUDE_ENV_FILE, of every command the session runs. When the download
# fails, the session goes on with the container's Node and says so.
install_node() {
  local want dist arch line file dir cache="$HOME/.cache/piwi-node"
  want="$(tr -d '[:space:]v' < .node-version)"
  case "$want" in
    *.*) dist="https://nodejs.org/dist/v$want" ;;
    *) dist="https://nodejs.org/dist/latest-v$want.x" ;;
  esac
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) return 1 ;;
  esac
  line="$(curl -fsSL "$dist/SHASUMS256.txt" | grep -E " node-v[0-9.]+-linux-$arch\.tar\.xz\$")" || return 1
  file="${line##* }"
  dir="$cache/${file%.tar.xz}"
  if [ ! -x "$dir/bin/node" ]; then
    mkdir -p "$cache" &&
      curl -fsSL "$dist/$file" -o "$cache/$file" &&
      echo "${line%% *}  $cache/$file" | sha256sum --check --quiet &&
      tar -xJf "$cache/$file" -C "$cache" &&
      rm -f "$cache/$file" || return 1
  fi
  export PATH="$dir/bin:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$dir/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
}

echo "[session-start] installing the Node that .node-version names"
if install_node; then
  echo "[session-start] using Node $(node --version) and npm $(npm --version)"
else
  echo "[session-start] WARNING: could not install the Node that .node-version names; staying on Node $(node --version), below the repository's engines floor"
fi

# Install exactly what package-lock.json pins, as CI does, without writing it.
# npm ci deletes node_modules first (~35s against ~5s for an up-to-date install), so
# a resumed or compacted session skips it while the tree is the one npm ci installed
# from this very lockfile under this Node. node_modules/.package-lock.json cannot
# tell: npm writes it in its own form, so it never equals the committed lockfile.
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
