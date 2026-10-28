#!/bin/bash
# Prepare a Claude Code on the web session so the standard checks actually run.
#
# Three things are missing from a fresh container, and each one makes a whole
# class of verification impossible:
#   1. node_modules — nothing runs at all.
#   2. packages/reporter/dist — playwright.config.ts imports the built reporter, so the
#      E2E suite cannot even load its config (nor knip, which reads it), and the
#      reporter's own specs that load its build (build-output, flake-run) fail.
#   3. A Chromium matching the pinned Playwright — without it every
#      browser-driven spec dies on a missing binary, which reads like an
#      unrelated failure and tempts you to skip UI verification entirely.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Each step writes its output to a log rather than to the session, which reads everything this hook prints; a step
# that fails prints the end of the log.
log="${TMPDIR:-/tmp}/piwi-session-start.log"
: >"$log"
quietly() {
  if ! "$@" >>"$log" 2>&1; then
    echo "[session-start] '$*' failed; the end of $log:" >&2
    tail -n 40 "$log" >&2
    return 1
  fi
}

# The repository pins its Node major in .node-version (CI, engines). Another Node still runs most checks, so this
# warns rather than stops: a failure caused by the version then reads as one.
wanted_node="$(cut -d . -f 1 .node-version 2>/dev/null | tr -d 'v \r' || true)"
if [ -n "$wanted_node" ] && [ "$(node -p 'process.versions.node.split(".")[0]')" != "$wanted_node" ]; then
  echo "[session-start] WARNING: Node $(node --version) runs this session; the repository pins Node $wanted_node (.node-version)"
fi

# Node's default heap limit here is about 2 GB, which `nuxt dev`, `nuxt build` and `nuxt generate` outgrow while they
# bundle the server. Every later command of the session gets 6 GB, appended to the options the environment already sets
# (the proxy's `--use-openssl-ca`) rather than replacing them; an explicit limit, such as `app:typecheck`'s, still wins.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  cat >>"$CLAUDE_ENV_FILE" <<'EOF'
case " ${NODE_OPTIONS:-} " in *" --max-old-space-size="*) ;; *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=6144" ;; esac
EOF
  echo "[session-start] Node heap limit raised to 6 GB for this session"
fi

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
  quietly npm ci --no-audit --fund=false
  echo "$installed" > "$stamp"
fi

# The build takes ~10s, mostly the type declarations, so a resumed session skips it while its output is there and no
# input of the bundle changed since the last one: the reporter, the core and picker-dom sources and manifests it
# inlines, the tsconfig it extends, the installed dependencies. The stamp lives outside dist/ (tsup's clean leaves dot
# files, and dist/ is what npm packs), is taken before the build so an edit made during it still counts, and is kept
# only once the build succeeded.
build_stamp="node_modules/.cache/piwi-session-start/reporter-build"
if [ -f "$build_stamp" ] && [ -f packages/reporter/dist/index.js ] && [ -f packages/reporter/dist/index.d.ts ] &&
  [ -z "$(find packages/reporter/src packages/reporter/package.json packages/reporter/tsconfig.json \
    packages/reporter/tsup.config.ts tsconfig.json packages/core/src packages/core/package.json \
    packages/picker-dom/src packages/picker-dom/package.json "$stamp" -newer "$build_stamp" -print -quit)" ]; then
  echo "[session-start] the reporter build is up to date; skipping it"
else
  echo "[session-start] building the reporter (playwright.config.ts imports it)"
  mkdir -p "$(dirname "$build_stamp")"
  touch "$build_stamp.next"
  quietly npm run reporter:build --workspace packages/reporter
  mv "$build_stamp.next" "$build_stamp"
fi

# Prefer the browser Playwright pins: the full Chromium as well as the headless
# shell, because the extension's specs load an unpacked extension, which only a
# full browser can. When the download is unavailable, fall back to whatever
# Chromium the image already provides and tell Playwright about it via the
# repo's PLAYWRIGHT_CHROMIUM_EXECUTABLE hook.
echo "[session-start] resolving a Chromium for Playwright"
if quietly npx --yes playwright install chromium; then
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
