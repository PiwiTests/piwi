// Builds the extension into dist/ (Chrome, Edge) and dist-firefox/ (Firefox),
// which differ only in their manifest (see `chromiumManifest`, `firefoxManifest`). Content scripts and the background
// service worker are each built as a standalone IIFE (no shared chunks) via
// Vite's library mode, since chrome.scripting.executeScript({ files: [...] })
// injects them as plain classic scripts with no module resolution — unlike
// popup.html, which is loaded as a normal extension page and gets Vite's
// standard (chunk-splitting-friendly) HTML-entry build.
//
// Running this file builds once; dev.mjs re-runs it in a fresh process on each
// change rather than calling buildExtension() in its own. `--release` makes the
// build reproducible (see `buildExtension`): the store zips are built that way, since
// Firefox reviewers rebuild the source package and diff the result against the
// submitted add-on. `--pseudo` replaces the English catalog with a pseudo-localized
// copy (see `pseudoLocalize`), a development aid that never goes into a release.
//
// `buildIdeBundle` builds the recorder a second time, for the editor service: the
// IDE bundle, which is no part of the extension (see `buildIdeBundle`).
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'vite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'dist');
const firefoxOutDir = path.join(root, 'dist-firefox');

/**
 * The manifest Chrome and Edge load: `manifest.json` without
 * `background.scripts`, Firefox's stand-in for the service worker it lacks.
 * Chromium ignores the key, and Edge lists it as an error on an unpacked load.
 */
export function chromiumManifest(manifest) {
  const { scripts: _firefoxOnly, ...background } = manifest.background ?? {};
  return { ...manifest, background };
}

/**
 * The manifest Firefox loads: `manifest.json` without `debugger`, which Firefox
 * does not have (every feature that uses it falls back to what works without
 * it), and without `minimum_chrome_version`, a Chromium key Firefox does not
 * know: its floor is `browser_specific_settings.gecko.strict_min_version`.
 */
export function firefoxManifest(manifest) {
  const { minimum_chrome_version: _chromiumOnly, ...rest } = manifest;
  return { ...rest, permissions: (manifest.permissions ?? []).filter((p) => p !== 'debugger') };
}

/** Every standalone content script / service worker entry, as [output name, source entry]. */
const STANDALONE_ENTRIES = [
  ['pick', 'src/content/pick.ts'],
  ['multi-pick', 'src/content/multi-pick.ts'],
  ['lint-overlay', 'src/content/lint-overlay.ts'],
  ['playwright-view', 'src/content/playwright-view.ts'],
  ['assertion-panel', 'src/content/assertion-panel.ts'],
  ['agent-context-panel', 'src/content/agent-context-panel.ts'],
  ['test-function-panel', 'src/content/test-function-panel.ts'],
  ['coverage-overlay', 'src/content/coverage-overlay.ts'],
  // Not injected via `chrome.scripting.executeScript({ files: [...] })` like the others —
  // registered dynamically for the recording's lifetime
  // (`chrome.scripting.registerContentScripts`, see `background/index.ts`) so it re-attaches
  // itself on every navigation across the recording's granted origin. Still built the same
  // standalone-IIFE way: MV3 has no other way to inject a classic script by file path.
  ['record-panel', 'src/content/record-panel.ts'],
  ['replay-panel', 'src/content/replay-panel.ts'],
  // Registered the same way for a bug recording's lifetime, in the page's main world (`world: 'MAIN'`): the only
  // place that sees the page's console and its fetch/XHR calls. Imports nothing that touches `chrome.*`.
  ['bug-evidence-main', 'src/content/bug-evidence-main.ts'],
  // Slow down or fail a request: registered while a condition is on, the wrapper in the page's main world
  // and its relay in the isolated one.
  ['request-conditions-main', 'src/content/request-conditions-main.ts'],
  ['request-conditions', 'src/content/request-conditions.ts'],
  // Injected into the inspected tab by the Elements sidebar, which calls it with DevTools' selection.
  ['devtools-rank', 'src/content/devtools-rank.ts'],
  // Registered for the connected instance's origin while connected (`background/instance-marker.ts`): marks its
  // pages so the dashboard leaves out its hint to install the extension.
  ['instance-marker', 'src/content/instance-marker.ts'],
  ['background', 'src/background/index.ts'],
];

/**
 * Values replaced in every bundle. `__PIWI_BUILD_ID__` changes on each build, so
 * the popup and the tools can tell when the background worker still runs an
 * earlier one (see `src/shared/build-id.ts`). `__PIWI_IDE__` is true in the IDE
 * bundle alone (see `src/shared/ide-build.ts`).
 */
function defines(buildId, { ide = false } = {}) {
  return { __PIWI_BUILD_ID__: JSON.stringify(buildId), __PIWI_IDE__: JSON.stringify(ide) };
}

/** The stamp a release build of `version` carries instead of the build time. */
function releaseBuildId(version) {
  return `v${version}`;
}

/**
 * Whether `dir` holds a release build of `version`: its background bundle
 * carries that release's stamp, as a string literal in any of the quotes the
 * minifier writes.
 */
export function isReleaseBuild(dir, version) {
  let bundle;
  try {
    bundle = readFileSync(path.join(dir, 'background.js'), 'utf8');
  } catch {
    return false;
  }
  const stamp = releaseBuildId(version);
  return ['"', "'", '`'].some((quote) => bundle.includes(`${quote}${stamp}${quote}`));
}

async function buildStandalone(name, entry, buildId) {
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    define: defines(buildId),
    build: {
      outDir,
      emptyOutDir: false,
      lib: { entry: path.join(root, entry), formats: ['iife'], name: `Piwi_${name}`, fileName: () => `${name}.js` },
      rollupOptions: { output: { extend: true } },
    },
  });
}

/**
 * Builds everything into dist/. A dev build stamps the current time, so a
 * rebuild always differs from the worker still running; a release build stamps
 * the manifest version instead, so the same sources always produce the same
 * bytes.
 */
export async function buildExtension({ release = false, pseudo = false } = {}) {
  if (release && pseudo) throw new Error('--pseudo is a development aid: it never goes into a release build');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const buildId = release ? releaseBuildId(manifest.version) : new Date().toISOString();

  for (const [name, entry] of STANDALONE_ENTRIES) await buildStandalone(name, entry, buildId);

  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    define: defines(buildId),
    build: {
      outDir,
      emptyOutDir: false,
      rollupOptions: {
        input: {
          popup: path.join(root, 'popup.html'),
          options: path.join(root, 'options.html'),
          devtools: path.join(root, 'devtools.html'),
          'devtools-sidebar': path.join(root, 'devtools-sidebar.html'),
          'devtools-panel': path.join(root, 'devtools-panel.html'),
          login: path.join(root, 'login.html'),
        },
      },
    },
  });

  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(chromiumManifest(manifest), null, 2));
  cpSync(path.join(root, 'public', 'icons'), path.join(outDir, 'icons'), { recursive: true });
  if (pseudo) writePseudoCatalog();

  // The same files for Firefox, with its manifest.
  rmSync(firefoxOutDir, { recursive: true, force: true });
  cpSync(outDir, firefoxOutDir, { recursive: true });
  writeFileSync(path.join(firefoxOutDir, 'manifest.json'), JSON.stringify(firefoxManifest(manifest), null, 2));
}

/**
 * The global the IDE bundle's `chrome` references are rewritten to, which its
 * host installs (`src/ide/host.ts`): `IDE_CHROME_GLOBAL` of
 * `@piwitests/core/ide-recorder`, which a unit test keeps this equal to.
 */
export const IDE_CHROME_GLOBAL = '__piwiIdeChrome';

/**
 * Every shipped catalog, by language, each message with its text and its
 * placeholders' contents alone: what the editor service's launcher hands the
 * IDE bundle in the editor's language.
 */
function ideCatalogs() {
  const localesDir = path.join(root, 'public', '_locales');
  const catalogs = {};
  for (const code of readdirSync(localesDir).sort()) {
    const catalog = JSON.parse(readFileSync(path.join(localesDir, code, 'messages.json'), 'utf8'));
    catalogs[code] = Object.fromEntries(
      Object.entries(catalog).map(([key, { message, placeholders }]) => [
        key,
        placeholders
          ? {
              message,
              placeholders: Object.fromEntries(
                Object.entries(placeholders).map(([name, { content }]) => [name, { content }]),
              ),
            }
          : { message },
      ]),
    );
  }
  return catalogs;
}

/**
 * The IDE bundle, for the editor service, into `outDir`: `record-ide.js`, the
 * recorder (`src/ide/record-ide.ts`) built as one classic script whose every
 * `chrome` reference reads {@link IDE_CHROME_GLOBAL} instead, so the page's own
 * `chrome` is never touched, and `record-ide-messages.json`, the catalogs it
 * shows its texts from. No part of `dist/` or `dist-firefox/`. `release`
 * stamps the manifest's version instead of the build time, as in
 * {@link buildExtension}.
 */
export async function buildIdeBundle({ outDir: ideOutDir, release = false }) {
  mkdirSync(ideOutDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const buildId = release ? releaseBuildId(manifest.version) : new Date().toISOString();
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    // The extension's icons and catalogs stay out: the launcher reads the catalogs from the JSON file below.
    publicDir: false,
    define: { ...defines(buildId, { ide: true }), chrome: `globalThis.${IDE_CHROME_GLOBAL}` },
    build: {
      outDir: ideOutDir,
      emptyOutDir: false,
      lib: {
        entry: path.join(root, 'src/ide/record-ide.ts'),
        formats: ['iife'],
        name: 'Piwi_record_ide',
        fileName: () => 'record-ide.js',
      },
      rollupOptions: { output: { extend: true } },
    },
  });
  writeFileSync(path.join(ideOutDir, 'record-ide-messages.json'), JSON.stringify(ideCatalogs()));
}

const ACCENTED = {
  a: 'å',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'î',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ö',
  p: 'ƥ',
  q: 'ǫ',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'û',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
  A: 'Å',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ð',
  E: 'É',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Î',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ö',
  P: 'Ƥ',
  Q: 'Ǫ',
  R: 'Ŕ',
  S: 'Š',
  T: 'Ţ',
  U: 'Û',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'Ý',
  Z: 'Ž',
};

/**
 * `Pick an element` → `[Ƥîçķ åñ éļéɱéñţ ·······]`: accented, about a third
 * longer, bracketed, with `$name$` and `$$` left as they are. Loaded in a
 * browser, plain English left on screen is text that bypasses `t()`, and a
 * label cut off is one that will clip in a longer language.
 */
export function pseudoLocalize(message) {
  const parts = message.split(/(\$[A-Za-z0-9_]+\$|\$\$)/);
  const accented = parts.map((part, i) => (i % 2 ? part : part.replace(/[A-Za-z]/g, (c) => ACCENTED[c]))).join('');
  const letters = message.replace(/\$[A-Za-z0-9_]+\$/g, '').length;
  return `[${accented} ${'·'.repeat(Math.max(1, Math.round(letters / 3)))}]`;
}

/** Messages the code reads rather than shows. */
const NOT_PSEUDO = new Set(['common_languageTag']);

function writePseudoCatalog() {
  const file = path.join(outDir, '_locales', 'en', 'messages.json');
  const catalog = JSON.parse(readFileSync(file, 'utf8'));
  for (const [key, entry] of Object.entries(catalog)) {
    // Badges and the store summary have hard length limits.
    if (NOT_PSEUDO.has(key) || key.startsWith('badge_') || key === 'extDescription') continue;
    entry.message = pseudoLocalize(entry.message);
  }
  writeFileSync(file, JSON.stringify(catalog, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = process.argv.includes('--release');
  const pseudo = process.argv.includes('--pseudo');
  try {
    await buildExtension({ release, pseudo });
  } catch (error) {
    // A failed build's message already carries Vite's report and code frame;
    // the stack under it is only Rolldown's internals.
    console.error(error.message);
    process.exit(1);
  }
  const kind = release ? ' (release)' : pseudo ? ' (pseudo-localized English)' : '';
  const dirs = [outDir, firefoxOutDir].map((dir) => path.relative(process.cwd(), dir)).join(' and ');
  console.log(`Built extension${kind} into ${dirs}`);
}
