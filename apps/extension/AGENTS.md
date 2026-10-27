# Piwi Picker: agent guide

Piwi Picker is the Manifest V3 browser extension that picks, records and replays with Playwright locators on the live
page (`@piwitests/core`, `@piwitests/picker-dom`). Chrome Web Store id `pakhnokpjboejcghgcmkjlpnogfjihhe` (Edge users
install it there too), Firefox Add-ons id `picker@piwitests.dev`. It works **standalone** by default: no server, nothing
sent. **Connected mode** (a Piwi instance) is opt-in and adds the function catalog, Tested elements and bug reports.

Read [`../../AGENTS.md`](../../AGENTS.md) first. How each feature works is in [`ARCHITECTURE.md`](ARCHITECTURE.md);
each rule below ends with the section to read there.

## Map

- `manifest.json`: the manifest. `scripts/build.mjs` writes `dist/` (Chrome, Edge) and `dist-firefox/`.
- `src/background/`: the service worker (messages, script registration, `debugger.ts` and `cdp-*.ts`, requests).
- `src/content/`: content scripts injected on demand, the in-page engine (`engine-*.ts`, `locator-engine.ts`).
- `src/popup/`, `src/options/`, `src/login/` (Save login for tests), `src/devtools/` (Elements pane, Piwi panel).
- `src/ide/`: the recorder built for the editor service (`record-ide.js`). The extension never loads it.
- `src/shared/`: storage, translations, the instance client, buttons and icons, used by all of the above.
- `public/_locales/`: the catalogs. `store/`: the Firefox listing. `PUBLISHING.md`: releases and store secrets.
- `tests/unit/` (Vitest, pure logic), `tests/e2e/` (Playwright on the built extension), `tests/lab/` (replay lab).

`ARCHITECTURE.md` sections, and when to read them:

- "What it is": before changing the manifest, a permission, the build, a popup tile or the tool session.
- "The debugging protocol" and its subsections: before changing the replay or anything using `chrome.debugger`.
- "Connected mode": before changing the settings page, requests, secrets or project mappings.
- "Tested elements", "Naming and ranking an element": before changing the engine, naming or narrowing.
- "Checks in a test recording", "Files, double clicks and drags", "The recording bar's corner", "What a click lands
  on, and pages reached without one", "Hovers a click depends on": before changing what the recorder captures.
- "Report a bug", "The main-world evidence script": before changing the bug recorder or its evidence.
- "The IDE bundle": before changing `record-panel.ts` or its imports (the editor service ships them too).
- "Playwright view", "DevTools", "Content-script structure", "Buttons, icons and readable steps": before changing them.
- "Rules, with their reasons": to learn why a rule exists. "Loading it locally": before changing `scripts/dev.mjs`.

## Rules

### Permissions and the manifest

- **Standing permissions stay `activeTab`, `debugger`, `scripting` and `storage`.** No static host permission, no
  `<all_urls>`, no remote code; anything more (`contextMenus`, `sidePanel`, a broader host grant) is a deliberate,
  reviewed decision. (see "What it is")
- **Request a host permission for one origin, inside the user's click, before any `await`.** Firefox shows no prompt
  after an `await`, and a service worker can never ask. (see "Connected mode")
- **The recorder's grant comes from the popup's Record click, per origin and per recording, never pre-granted.** It
  cannot move to the worker (`startRecordingFlow`, `src/popup/main.ts`); `decideRecordIntent` handles a prompt that
  closed the popup (`record-intent.spec.ts`). (see "Rules, with their reasons")
- **Build every host pattern with `hostPattern`** (`src/shared/web-origin.ts`), never `${origin}/*` by hand. Firefox
  grants a pattern with a port but matches nothing with it. (see "Connected mode")
- **`cookies` is requested only by Save login's Save click, and what it reads is never kept or sent**
  (`src/shared/storage-state.ts`, `save-login.spec.ts`). (see "What it is")
- **Never change `browser_specific_settings.gecko.id`:** a new id is a separate AMO add-on and orphans existing
  installs. (see "What it is")
- **`debugger` and `minimum_chrome_version` stay out of the Firefox manifest** (`firefoxManifest` in
  `scripts/build.mjs`, `build-manifests.test.ts`). `background.js` stays both `service_worker` and `scripts`; `dist/`
  drops `scripts`. (see "What it is")
- **`gecko.data_collection_permissions` is `"none"`: nothing may go anywhere but the user's instance and paired
  editor.** (see "What it is")
- **The manifest's `description` and shortcut label are `__MSG_*__` strings.** The description stays within 132
  characters in every language; a new language needs `public/_locales/` and `store/`. (see "What it is")

### Network, secrets and connected mode

- **No network call from a content script, ever.** Only `piwi-client.ts` sends requests, from `src/options/` and the
  worker; content scripts read caches and ask the worker. `piwi-client.test.ts` fails on a content script importing it.
  (see "Connected mode")
- **Connected mode is opt-in, off by default, and never sends a recording to the instance.** A bug report, a replay
  verdict or steps for the desktop app go only from a preview the user confirms; a new feature that sends recorded data
  needs the same opt-in, separation and preview. (see "Connected mode")
- **No secret in `chrome.storage.local`, which content scripts read.** The API key and the desktop and editor tokens
  live in the extension's IndexedDB (`src/shared/secret-store.ts`). (see "Connected mode")
- **The API key goes only to its own origin (`getInstanceApiKey`), and no request follows a redirect**
  (`redirect: 'error'`). `isConnected` never reads the key. (see "Connected mode")
- **The desktop app's token goes only to 127.0.0.1, after the app proves it holds it** (`proveDesktop`,
  `proveDesktopKey` in `piwi-client.ts`). The request holds steps, never code. (see "Connected mode")
- **The worker never takes a project id from a page:** it resolves the project from the sending tab's URL
  (`bug-reports.ts`, `project-refresh.ts`), and records a verdict only on the stored replay's report or one sent to
  the desktop app. (see "Connected mode")
- **A message that names a tab or an address is accepted only from extension pages:** list it in
  `EXTENSION_PAGE_MESSAGES` (`src/background/index.ts`, `fromExtensionPage`). (see "What it is")
- **Every request to the instance goes through `withConnectionHealth`.** (see "Connected mode")
- **Never add a fetch to `refreshHud`: it runs on every captured step.** (see "Connected mode")
- **The active project comes only from `resolveActiveProject(settings, override, url)`.** (see "Connected mode")
- **The function matcher never invents a function:** it scores catalog entries only, with the same
  `scoreTargetMatch` in the recorder and the Test functions panel. (see "Connected mode")
- **A settings button that starts a request disables itself inside the click (`whileRunning`); a late answer is
  written through `writeConnection`.** (see "Connected mode")
- **Connect sends only the browser and OS names (`describeClient`); the instance marker reads nothing from the page
  and sends nothing.**
  (see "Connected mode")

### Content scripts and the page

- **Content scripts are separate IIFE bundles, injected on demand:** no shared runtime chunk, no `<all_urls>`, no
  `func:` injection. Only the worker calls `registerContentScripts` (scoped to one granted origin) and
  `chrome.action.*`. (see "Rules, with their reasons")
- **A momentary tool claims the page through `src/shared/tool-session.ts`.** `startTool` before mounting, `bindToTool`
  for each panel or wait, `toolIsCurrent(epoch)` after each `await`, `endTool` at the end; the recorder stays outside.
  (see "What it is")
- **Keep a feature's pure logic (`lint-scan.ts`) apart from its entry file (`lint-overlay.ts`).** (see
  "Content-script structure")
- **Every surface on the page gets its shadow root from `attachPanelShadow`** (`src/content/panel-root.ts`,
  `modal-dialog.spec.ts`). (see "Content-script structure")
- **Reuse `@piwitests/picker-dom`, never copy picker logic;** pass it `pickerOverlayStrings()` /
  `anchorPickerStrings()` after `initI18n()`. (see "Rules, with their reasons")
- **Hover detection changes nothing on the page but `data-piwi-hover-probe`, removed before it returns.** (see
  "Hovers a click depends on")
- **A content script never links to the options page.** (see "What it is")

### Session storage

- **Session storage goes through `sessionArea()` (`src/shared/session-area.ts`), never `chrome.storage.session`.**
  A direct call breaks only in Firefox, which no CI run exercises. (see "What it is")
- **A content script calls `ensureSessionAccess()` before reading session storage:** until the worker's
  `setAccessLevel` has run, the read throws. (see "What it is")
- **Change a recording only through `appendRecordingEvent` and `updateRecording(startedAt, …)`,** which queue each
  change (one worker message each in Firefox), so no append is lost. (see "What it is")
- **A page writes the replay's state only through `updateReplayState(change, replayId)`; only the worker writes its
  tab** (`piwiReplayTab`). (see "A replay belongs to one tab")
- **Bug evidence has its own keys (`bug-storage.ts`), never `RecordingState`; only the worker writes
  `CDP_EVIDENCE_KEY`.** (see "Report a bug")

### The debugging protocol (Chrome and Edge)

- **Attach only while a feature the person started needs it, and detach the moment it ends:** always through
  `acquireDebugger` / `releaseDebugger` (`src/background/debugger.ts`). A purpose that lets go ends its own emulation
  first. (see "The debugging protocol")
- **A feature that uses the protocol also works without it, and says why in plain words** (`chooseDriver`,
  `FallbackReason` in `cdp-input.ts`). (see "The debugging protocol")
- **A content script never talks to the protocol;** the worker checks each request field by field (`readInputOps`)
  and that it comes from the replay's tab. (see "The debugging protocol")
- **Set a viewport only through `emulateCssViewport`, never `Emulation.setDeviceMetricsOverride` directly.** (see
  "The debugging protocol")
- **Nothing read through the protocol is sent unless the person sends it;** evidence keeps the recorded origin only,
  never a header or a body. (see "Report a bug")

### Main-world scripts

- **Register a main-world script only while its feature runs, for its granted origin:** `bug-evidence-main.js` for a
  bug recording or a replay, `request-conditions-main.js` for request conditions `via: 'page'`. (see "The main-world
  evidence script")
- **A main-world script imports nothing that touches `chrome.*`, and only wraps and listens:** each wrapper calls the
  original with the same arguments and returns its result. (see "The main-world evidence script")
- **It never reads a header or a body (URLs go through `reportedRequestUrl`), and what it relays is page-controlled
  text** (`readRelayedEntry`, `shared/bug-relay.ts`). (see "The main-world evidence script")

### Recording and replay

- **A recording keeps a file's name, never its content** (`record.spec.ts`). (see "Files, double clicks and drags")
- **Every capture listener checks `capturePaused()`; every exported title goes through `recordingTitle`.** (see
  "Checks in a test recording")
- **A step is never lost to its locators:** unchecked candidates are kept, and an element with a role and no name
  gets its bare role. (see "Naming and ranking an element")
- **A replay hands a step it cannot play to the person;** it never types a redacted value or sends input twice. (see
  "How a replay finds a step's element")
- **Read a `.piwibug` by its content (`isBugReportArchive`), never by its name.** (see "Report a bug")
- **Send `stepShot` parts only to an instance whose intake declares `stepShots`.** (see "Report a bug")
- **Never answer a refused `captureVisibleTab` with `<all_urls>`;** a missing screenshot never blocks Finish. (see
  "Report a bug")
- **The IDE bundle never touches the page's `chrome`; what differs stays behind `IDE_BUILD` in `record-panel.ts`.** A
  new `chrome` call needs its answer in `src/ide/host.ts` and the launcher. (see "The IDE bundle")

### Locators and the in-page engine

- **Every tool that names an element or offers a locator goes through `verified-locators.ts`;** nothing estimates a
  count. (see "Naming and ranking an element")
- **Hover stays cheap: locators are checked only once the pointer rests (`HOVER_REST_MS`).** The Pick results' ring
  (`spotlight`) redraws on events, never in a frame loop. (see "Naming and ranking an element")
- **Never show a locator's score alone as its verdict; use `verdictWords`.** (see "Naming and ranking an element")
- **Compare a page with the locator index, or key a bug report, only through `pageHere`, never
  `pageKey(location.href)`.** (see "Tested elements")
- **The engine never uses `instanceof` (frames are other realms); build one engine per scan.** (see "Tested
  elements")
- **`locator-engine.spec.ts` compares the engine with real Playwright:** a new kind or option goes into
  `locator-cases.ts` with a fixture, one Playwright rejects into `EXPECTED_REFUSALS`, never a skipped case. (see "Naming
  and ranking an element")
- **A new naming or narrowing case goes into `pick.spec.ts`** (else the ranking tests or `CONTAINER_NARROWING`). (see
  "Naming and ranking an element")
- **Render a locator with `highlightLocator` in `.piwi-loc`, with `LOCATOR_SYNTAX_CSS`, never as bare
  `textContent`.** Verdict and accent colors need their own light-scheme entry. (see "Rules, with their reasons")
- **`renderCopyMode` (`src/shared/copy-modes.ts`) stays pure.** (see "Content-script structure")

### Interface

- **The popup and the settings page stay plain TypeScript and DOM, no UI framework.** (see "What it is")
- **The popup must fit Chrome's 600-pixel popup height in every language** (`popup.spec.ts`): a new tile goes under
  More tools or into DevTools, with its hint under its label, never only a tooltip. (see "What it is")
- **A panel with a backdrop is modal through `holdFocus`; one that leaves the page usable is `role="region"`, never a
  dialog.** A bar on the page stops animating under `prefers-reduced-motion: reduce`. (see "Content-script
  structure")
- **Every button has an icon from `ICONS` (`icons.spec.ts`) and comes from `makeButton` or `styleButton`**
  (`src/shared/buttons.ts`): no other SVG, icon font or image, no button styles of a panel's own. An HTML page uses
  `data-icon` and `decorateIcons()`. (see "Buttons, icons and readable steps")
- **A button's tone says what it does:** `primary` (one per group), `success`, `danger`, `remove`, `neutral`, `ghost`.
  (see "Buttons, icons and readable steps")
- **A label changes through `setLabel`, never `textContent`; a copy goes through `copyWithFeedback`.** (see "Buttons,
  icons and readable steps")
- **A step is shown by `stepView(step)`, never by parsing or printing `describeStepInWords`;** other sentences go
  through `richText`. (see "Buttons, icons and readable steps")
- **Colors are dark first, with the light scheme under `prefers-color-scheme: light`.** (see "Buttons, icons and
  readable steps")
- **DevTools Network data leaves the browser only through the user's copy or download;** `mockCode` hides credentials
  unless revealed and never writes a header. (see "DevTools")
- **Request conditions apply only to a tab that shows the origin they were set for.** (see "DevTools")
- **Add to session has one path, `addNamedPick`.** (see "DevTools")

### Text and translations

- **Every text shown comes from the catalogs through `t()`, `tn()` or `tNodes()`** (`src/shared/i18n.ts`,
  `no-hardcoded-text.test.ts`). A new message goes into every catalog in the same change, English with a
  `description` (`i18n/README.md`, `locales.test.ts`). (see "Rules, with their reasons")
- **Translated text reaches the page as text or escaped, never as raw HTML.** (see "Rules, with their reasons")
- **Run `initI18n()` before the first text:** a content script ends with `void initI18n().then(start)`, and a panel
  sets `lang` from `uiLanguage()`. (see "Rules, with their reasons")

### Tests

- **Rebuild a function with `Function.prototype.toString()` only when it uses no `generateAlternatives` and no
  `chrome.*`;** test those on the real built bundle. (see "Rules, with their reasons")
- **`record.spec.ts`'s cross-page stub keeps `chrome.storage` in `window.name`, not in memory.** (see "Rules, with
  their reasons")
- **A spec opens the settings with `openOptions` and calls `optionsReady` after a `reload()`, before clicking.** (see
  "What it is")
- **Measure a viewport through `chrome.tabs`, not the page** (`viewport.spec.ts`). (see "DevTools")
- **Cancel a debugging session in a spec with the worker's `__piwiCancelDebugging(tabId)`.** (see "The debugging
  protocol")

## Commands

| Command                               | Purpose                                                                |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `npm run extension:build`             | Build `dist/` (scripts, pages, manifest, icons, `_locales`)            |
| `npm run extension:dev`               | Same build, re-run on every change (below)                             |
| `npm run extension:build -- --pseudo` | Pseudo-localized English, to spot text that bypasses `t()` or clips    |
| `npm run extension:build:release`     | Reproducible build: the version, not the build time, in every bundle   |
| `npm run extension:zip`               | Release build, store zip, AMO source zip and listing (`PUBLISHING.md`) |
| `npm run extension:typecheck`         | TypeScript check                                                       |
| `npm run extension:lint`              | oxlint (`extension:lint:fix` to fix)                                   |
| `npm run extension:format`            | oxfmt (`extension:format:check` to check only)                         |
| `npm run extension:test`              | Unit tests (Vitest), pure logic only                                   |
| `npm run extension:test:e2e`          | Build, then run Playwright on the built extension (`--load-extension`) |
| `npm run extension:lab`               | The replay lab (`tests/lab/README.md`; not part of CI)                 |

`extension:dev` watches `src/`, `public/`, the HTML pages, `manifest.json`, `scripts/build.mjs`, and the `src/` and
`package.json` of `packages/core` and `packages/picker-dom`, which are bundled from source. The `--pseudo` build is never
released. `extension:lab` needs a running Piwi dashboard (`LAB_SET=wild`: public sites).

## Loading it locally

`npm run extension:build`, then in Chrome/Edge: `chrome://extensions` → enable Developer
mode → Load unpacked → select `apps/extension/dist`.

While iterating, use `npm run extension:dev`: it rebuilds on save, but the browser picks up a build only when you
click reload on the `chrome://extensions` card (MV3 gives no way to trigger it from outside the browser).

- **Keep both runaway guards in `scripts/dev.mjs`:** rebuild only when a watched path's mtime or size changed, and
  build in a child process. (see "Loading it locally")
- **Until that reload the worker runs the old build, so a new worker message goes unanswered:** a tool reports it with
  `outdatedWorkerMessage()`. A spec that reloads the extension uses `launchWithExtension(path, { developerMode: true })`.
  (see "Loading it locally")

Disable the Chrome Web Store copy while a local build is loaded: two installs both claim the
`Ctrl+Shift+E` command, and only one of them gets it, which reads as "my change didn't apply".
