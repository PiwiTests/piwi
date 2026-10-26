#!/bin/bash
# Prepare a Claude Code on the web session so the standard checks actually run.
#
# A fresh container lacks what whole classes of verification need, or offers a
# version of it that misleads:
#   1. The Node the repository names — the container ships Node 22 and npm 10,
#      below the root `engines` floor (Node 24) that CI and contributors run on.
#   2. node_modules, the workspaces' and the docs site's — nothing runs at all.
#   3. packages/reporter/dist — playwright.config.ts imports the built reporter, so the
#      E2E suite cannot even load its config, and a unit test that compares the
#      app against the reporter's build fails.
#   4. A Chromium matching the pinned Playwright — without it every
#      browser-driven spec dies on a missing binary, which reads like an
#      unrelated failure and tempts you to skip UI verification entirely.
#   5. actionlint and shellcheck — .github/AGENTS.md has a workflow change linted
#      before it is pushed, and the container has no Docker daemon to run the
#      image CI runs.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Put a directory first on the PATH of this script and, through CLAUDE_ENV_FILE,
# of every command the session runs.
add_to_path() {
  export PATH="$1:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$1:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
}

# Set a variable for every command the session runs.
session_export() {
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export $1=\"$2\"" >> "$CLAUDE_ENV_FILE"
  fi
}

# Download $1 to $2 and check that its SHA-256 is $3; nothing is left behind on a mismatch.
fetch_checked() {
  if curl -fsSL "$1" -o "$2" && echo "$3  $2" | sha256sum --check --quiet; then
    return 0
  fi
  rm -f "$2"
  return 1
}

# Run on the Node release line the root .node-version names, as CI's setup-workspace
# action does: the newest release of that line, downloaded from nodejs.org and
# checked against its published SHA-256. When the download fails, the session goes
# on with the container's Node and says so.
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
      fetch_checked "$dist/$file" "$cache/$file" "${line%% *}" &&
      tar -xJf "$cache/$file" -C "$cache" &&
      rm -f "$cache/$file" || return 1
  fi
  add_to_path "$dir/bin"
}

echo "[session-start] installing the Node that .node-version names"
if install_node; then
  echo "[session-start] using Node $(node --version) and npm $(npm --version)"
else
  echo "[session-start] WARNING: could not install the Node that .node-version names; staying on Node $(node --version), below the repository's engines floor"
fi

# Playwright's HTML reporter serves its report after a failed local run and waits
# for Ctrl+C, so the tool call that ran the suite hangs until it times out. The
# report is still written to playwright-report/.
session_export PLAYWRIGHT_HTML_OPEN never

# Install exactly what the lockfile in $1 pins, as CI does, without writing it.
# npm ci deletes node_modules first (~35s against ~5s for an up-to-date install), so
# a resumed or compacted session skips it while the tree is the one npm ci installed
# from this very lockfile under this Node. node_modules/.package-lock.json cannot
# tell: npm writes it in its own form, so it never equals the committed lockfile.
install_dependencies() {
  local dir="$1" what="$2" stamp="$1/node_modules/.session-start-install" lockfile installed
  lockfile="$dir/package-lock.json"
  installed="$(node --version) $(sha256sum "$lockfile" | cut -d ' ' -f 1)"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$installed" ]; then
    echo "[session-start] $what match ${lockfile#./}; skipping the install"
    return 0
  fi
  echo "[session-start] installing $what"
  (cd "$dir" && npm ci --no-audit --fund=false) || return 1
  echo "$installed" > "$stamp"
}

install_dependencies . "workspace dependencies"
# The docs site is not a workspace: it has its own lockfile and toolchain (VitePress).
install_dependencies apps/docs "the docs site's dependencies" ||
  echo "[session-start] WARNING: could not install the docs site's dependencies; docs:build will not run"

# The reporter bundles its own sources, @piwitests/core's and @piwitests/picker-dom's;
# a resumed session rebuilds it only when one of them, or the lockfile, is newer
# than the build.
reporter_build="packages/reporter/dist/index.js"
if [ -f "$reporter_build" ] && [ -z "$(find packages/reporter/src packages/reporter/package.json \
  packages/reporter/tsup.config.ts packages/reporter/tsconfig.json packages/core packages/picker-dom \
  package-lock.json -newer "$reporter_build" -not -path '*/node_modules/*' -print -quit)" ]; then
  echo "[session-start] the reporter's build is newer than its sources; skipping the build"
else
  echo "[session-start] building the reporter (playwright.config.ts imports it)"
  npm run reporter:build --workspace packages/reporter
fi

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
    session_export PLAYWRIGHT_CHROMIUM_EXECUTABLE "$found"
  else
    echo "[session-start] WARNING: no Chromium found — browser-driven specs will not run"
  fi
fi

# actionlint at the version pr-lint.yml runs, checked against its release's
# checksums, and the shellcheck it runs on the `run` scripts: CI's image bundles
# the stable release of shellcheck, which this pins with its SHA-256.
SHELLCHECK_VERSION=0.11.0
install_actionlint() {
  local version arch sc_arch sc_sha base line file dir cache="$HOME/.cache/piwi-tools"
  version="$(grep -oE 'rhysd/actionlint:[0-9.]+' .github/workflows/pr-lint.yml | head -n 1 | cut -d : -f 2)" || return 1
  [ -n "$version" ] || return 1
  case "$(uname -m)" in
    x86_64) arch=amd64 sc_arch=x86_64 sc_sha=8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198 ;;
    aarch64 | arm64) arch=arm64 sc_arch=aarch64 sc_sha=12b331c1d2db6b9eb13cfca64306b1b157a86eb69db83023e261eaa7e7c14588 ;;
    *) return 1 ;;
  esac
  mkdir -p "$cache" || return 1

  dir="$cache/actionlint-$version"
  if [ ! -x "$dir/actionlint" ]; then
    base="https://github.com/rhysd/actionlint/releases/download/v$version"
    line="$(curl -fsSL "$base/actionlint_${version}_checksums.txt" | grep " actionlint_${version}_linux_$arch\.tar\.gz\$")" || return 1
    file="${line##* }"
    mkdir -p "$dir" &&
      fetch_checked "$base/$file" "$cache/$file" "${line%% *}" &&
      tar -xzf "$cache/$file" -C "$dir" actionlint &&
      rm -f "$cache/$file" || return 1
  fi
  add_to_path "$dir"

  dir="$cache/shellcheck-v$SHELLCHECK_VERSION"
  if [ ! -x "$dir/shellcheck" ]; then
    file="shellcheck-v$SHELLCHECK_VERSION.linux.$sc_arch.tar.xz"
    fetch_checked "https://github.com/koalaman/shellcheck/releases/download/v$SHELLCHECK_VERSION/$file" \
      "$cache/$file" "$sc_sha" &&
      tar -xJf "$cache/$file" -C "$cache" &&
      rm -f "$cache/$file" || return 1
  fi
  add_to_path "$dir"
}

echo "[session-start] installing actionlint and shellcheck"
if install_actionlint; then
  echo "[session-start] using actionlint $(actionlint -version | head -n 1) and shellcheck $SHELLCHECK_VERSION"
else
  echo "[session-start] WARNING: could not install actionlint; lint a workflow change on its pull request instead"
fi

echo "[session-start] ready"
