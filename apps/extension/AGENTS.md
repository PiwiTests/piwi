# Piwi Picker: agent guide

Piwi Picker is the Manifest V3 browser extension that picks, records and replays with Playwright locators on the live
page (`@piwitests/core`, `@piwitests/picker-dom`). Chrome Web Store id `pakhnokpjboejcghgcmkjlpnogfjihhe` (Edge users
install it there too), Firefox Add-ons id `picker@piwitests.dev`. It works **standalone** by default: no server, nothing
sent. **Connected mode** (a Piwi instance) is opt-in and adds the function catalog, Tested elements and bug reports.

Read [`../../AGENTS.md`](../../AGENTS.md) first. How each feature works is in [`ARCHITECTURE.md`](ARCHITECTURE.md);
each rule below ends with the section to read there.

## Map

- `manifest.json`: the manifest. `scripts/build.mjs` writes `dist/` (Chrome, Edge) and `dist-firefox/`.
- `src/background/`: the service worker (messages, script registration, `debugger.ts` and `cdp-*.ts`, requests, the
  editor's run hubs in `run-hubs.ts` and `hub-connection.ts`).
- `src/content/`: content scripts injected on demand, the in-page engine (`engine-*.ts`, `locator-engine.ts`).
- `src/popup/`, `src/options/`, `src/login/` (Save login for tests), `src/devtools/` (Elements pane, Piwi panel).
- `src/runs/` and `runs.html`: the Runs window, which follows and steers the paired editor's runs.
- `src/ide/`: the recorder built for the editor service (`record-ide.js`). The extension never loads it.
- `src/shared/`: storage, translations, the instance client, buttons and icons, used by all of the above.
- `public/_locales/`: the catalogs; `i18n/`: the translation rules and glossaries. `store/`: the Firefox listing.
  `PUBLISHING.md`: releases and store secrets.
- `tests/unit/` (Vitest, pure logic), `tests/e2e/` (Playwright on the built extension), `tests/lab/` (replay lab).

`ARCHITECTURE.md` sections, and when to read them:

- "What it is": before changing the manifest, a permission, the build, a popup tile, the settings page, how a script is
  injected or registered, the tool session or session storage.
- "The debugging protocol" and its subsections: before changing the replay or anything using `chrome.debugger`.
- "Connected mode": before changing the settings page's connection, requests, secrets, project mappings or the desktop
  app.
- "The editor's runs": before changing the Runs window, the run shortcut, the run hubs or the editor's proof
  (`editor-proof.ts`).
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
  reviewed decision. (see "The manifest and its permissions")
- **Request a host permission for one origin, inside the user's click, before any `await`.** Firefox shows no prompt
  after an `await`, and a service worker can never ask. (see "Host permissions for the instance")
- **The recorder's grant comes from the popup's Record actions or Report a bug click, per origin and per recording,
  never pre-granted.** It cannot move to the worker (`requestRecording`, `startRecordingFlow` in `src/popup/main.ts`);
  `decideRecordIntent` handles a prompt that closed the popup (`record-intent.spec.ts`). (see "Rules, with their
  reasons")
- **An extension page that requests a site's `hostPattern` clears the parked recording intent with it**
  (`requestOrigins` in the settings, `requestSiteAccess` in DevTools), or that grant can start the parked recording
  (`record-intent.spec.ts`). (see "Rules, with their reasons")
- **Build every host pattern with `hostPattern`** (`src/shared/web-origin.ts`), never `${origin}/*` by hand. Firefox
  grants a pattern with a port but matches nothing with it. (see "Host permissions for the instance")
- **`cookies` is requested only by Save login's Save click, and what it reads is never kept or sent**
  (`src/shared/storage-state.ts`, `save-login.spec.ts`). (see "The manifest and its permissions")
- **Never change `browser_specific_settings.gecko.id`:** a new id is a separate AMO add-on and orphans existing
  installs. (see "The manifest and its permissions")
- **`debugger` and `minimum_chrome_version` stay out of the Firefox manifest** (`firefoxManifest` in
  `scripts/build.mjs`, `build-manifests.test.ts`). `background.js` stays both `service_worker` and `scripts`; `dist/`
  drops `scripts`. (see "The manifest and its permissions")
- **`gecko.data_collection_permissions` is `{ "required": ["none"] }`: nothing may go anywhere but the user's instance,
  the paired editor (Send to editor and its run hubs) and the desktop app paired on loopback.** A feature that sends
  data elsewhere changes this key and the store disclosures (`PUBLISHING.md` §4). (see "The manifest and its
  permissions")
- **The run shortcut (`run-pause-resume`) stays `"global": true` with no `suggested_key`, and `firefoxManifest` leaves
  `global` out** (`build-manifests.test.ts`). A global key is taken from every application on the computer, and the
  only keys Chrome binds a global command to at install (`Ctrl+Shift+[0-9]`) are JetBrains' numbered bookmarks and
  macOS screenshots. (see "The manifest and its permissions")
- **The manifest's `description` and shortcut labels are `__MSG_*__` strings.** The description stays within 132
  characters in every language, and a new language needs `public/_locales/` and `store/` (`store-listing.test.ts`).
  (see "The manifest and its permissions")

### Network, secrets and connected mode

- **No network call from a content script, ever, nor from an extension page but the settings page.** Requests go from
  `src/options/` and the worker only (`piwi-client.ts`, and `run-hubs.ts` and `hub-connection.ts` for the editor's
  runs); content scripts and the Runs window ask the worker. `piwi-client.test.ts` fails on a file of `src/content/`
  importing `piwi-client.ts`. (see "The requests and who makes them")
- **Connected mode is opt-in, off by default, and never sends a recording or anything read from a page on its own.** A bug report, a replay
  verdict or steps for the desktop app go only from a preview the user confirms; a new feature that sends recorded data
  needs the same opt-in, separation and preview. (see "What is read and what is sent")
- **No secret in `chrome.storage.local`, which content scripts read.** The API key, the desktop and editor tokens and
  the run hubs' addresses and tokens (`hubs`) live in the extension's IndexedDB (`src/shared/secret-store.ts`). (see
  "Where secrets are kept")
- **The API key goes only to its own origin (`getInstanceApiKey`), and no request follows a redirect**
  (`redirect: 'error'`). `isConnected` never reads the key. (see "Where secrets are kept")
- **The desktop app's token goes only to 127.0.0.1, after the app proves it holds it** (`proveDesktop`,
  `proveDesktopKey` in `piwi-client.ts`). The request holds steps, never code. (see "The desktop app")
- **The worker never takes a project id from a page:** for a content script it resolves the project from the sending
  tab's URL (`bug-reports.ts`, `project-refresh.ts`), and records a verdict only on the stored replay's report or one
  sent to the desktop app. (see "The requests and who makes them")
- **A content script names only its own tab's origin:** `piwi-start-replay` from a page plays on that tab's origin
  alone, an extension page names any (`mayNameOrigin`, `src/background/senders.ts`, `senders.test.ts`).
- **A message only the extension's own pages send is refused from anything else:** starting a recording, the viewport,
  request-condition and language messages, and the popup's Runs messages (`piwi-runs-summary`, `piwi-open-runs`),
  listed in `EXTENSION_PAGE_MESSAGES` (`src/background/index.ts`, `fromExtensionPage`). (see "What each folder holds")
- **A new request to the instance goes through `withConnectionHealth`**, so the popup and the settings page show
  whether the instance answers. (see "Connection health")
- **Never add a fetch to `refreshHud`: it runs on every captured step.** (see "Cache freshness")
- **The active project comes only from `resolveActiveProject(settings, override, url)`.** (see "Project mappings and
  the active project")
- **The function matcher never invents a function:** it scores catalog entries only, with the same
  `scoreTargetMatch` in the recorder and the Test functions panel. (see "What connecting adds" and "The Test functions
  panel")
- **A settings button that starts a request disables itself inside the click (`whileRunning`); a late answer is
  written through `writeConnection`.** (see "Buttons that start a request")
- **Connect and a desktop pairing send only the browser and OS names (`describeClient`); the instance marker reads
  nothing from the page and sends nothing.** (see "Connect", "The instance marker")

### The editor's runs

- **The pairing's token goes to the editor only once the program on the paired port proves it holds it**
  (`proveEditor`, `src/shared/editor-proof.ts`): before Send to editor's post (`postToEditor`) and before the run
  hubs' `GET …/live`. Without the proof no hub kept is connected (`editor-pairing.test.ts`, `run-hubs.test.ts`). (see
  "Finding the hubs")
- **An editor's address is kept on 127.0.0.1 whatever loopback name it was typed with, as it is stored and as it is
  read** (`canonicalEditorUrl`, `editor-pairing.ts`). The proof names the port alone, so `localhost` could reach
  another program on `[::1]`. (see "Finding the hubs")
- **The Runs window talks only to the worker, through the port `RUNS_PORT`:** the worker takes the port from
  `runs.html` alone (`fromRunsPage`) and reads its messages with `parseRunsRequest`. The state the worker posts
  (`RunsState`) carries no token. (see "The Runs window")
- **Every Runs window control but Pause names the stop shown (`since`),** so a click made twice never answers the next
  stop; `parseRunsRequest` refuses one without it (`runs.test.ts`). (see "The Runs window")
- **What a hub sends is shown as text (a call's title through `richText`), and its image only as a `data:` JPEG whose
  base64 is checked again.** (see "The Runs window")
- **The Runs window draws a part again only when what it shows changes (`part`, `place`); a button waiting for its
  command is `aria-disabled`, never `disabled`,** so a control keeps the focus, restored across redraws by
  `data-focus` (`runs.spec.ts`). (see "The Runs window")
- **A paired Piwi Picker holds a failure no pause bar shows only while a Runs window is open:** `RunHubs.listen` sends
  `follow` with `on: true` on each hub connection as the first window's port connects and on each one that opens
  meanwhile, and `on: false` as the last leaves (`run-hubs.test.ts`, `runs.spec.ts`). (see "A connection per hub")
- **No code from a stop comes to the Runs window:** it goes to the editor, which writes it, and the window shows the
  hub's sentence that it was sent (`.note.sent`), never that it was written. (see "The Runs window")
- **The hub's keepalive (`HUB_KEEPALIVE_MS`, `@piwitests/core/run-hub`) and the Runs window's ping (`RUNS_PING_MS`)
  stay within the 30 s an MV3 worker lives after a message;** that holds for a WebSocket from Chrome 116, under
  `minimum_chrome_version` 118. (see "A connection per hub")

### Content scripts and the page

- **Content scripts are separate IIFE bundles, injected on demand:** no shared runtime chunk, no `<all_urls>`, no
  feature injected as `func:`. Only the worker calls `registerContentScripts` (scoped to one granted origin) and
  `chrome.action.*`. (see "How content scripts are injected" and "What each folder holds")
- **A momentary tool claims the page through `src/shared/tool-session.ts`.** `startTool` before mounting, `bindToTool`
  for each panel or wait, `toolIsCurrent(epoch)` after each `await`, `endTool` at the end; the recorder stays outside.
  (see "How a tool claims the page")
- **Keep a feature's pure logic (`lint-scan.ts`) apart from its entry file (`lint-overlay.ts`).** (see
  "Content-script structure")
- **Every surface on the page gets its shadow root from `attachPanelShadow`** (`src/content/panel-root.ts`,
  `modal-dialog.spec.ts`). (see "Content-script structure")
- **Reuse `@piwitests/picker-dom`, never copy picker logic;** pass it `pickerOverlayStrings()` /
  `anchorPickerStrings()` after `initI18n()`. (see "Rules, with their reasons")
- **Hover detection changes nothing on the page but `data-piwi-hover-probe`, removed before it returns.** (see
  "Hovers a click depends on")
- **A content script never links to the settings page:** it asks the worker to open it (`piwi-open-options`). (see
  "The settings page")

### Session storage

- **Session storage goes through `sessionArea()` (`src/shared/session-area.ts`), never `chrome.storage.session`.**
  A direct call breaks only in Firefox, which no CI run exercises. (see "Session storage from a content script")
- **A content script calls `ensureSessionAccess()` before reading session storage:** until the worker's
  `setAccessLevel` has run, the read throws. (see "Session storage from a content script")
- **Append recording events only through `appendRecordingEvent`, and change Pause or the title only through
  `updateRecording(startedAt, …)`,** which queue each change (one worker message each in Firefox), so no append is lost. (see "Session storage from a content script")
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
- **Set a viewport only through `emulateCssViewport`, never `Emulation.setDeviceMetricsOverride` directly.** (see "The
  debugging protocol")
- **Nothing read through the protocol is sent unless the person sends it;** evidence keeps the recorded origin only,
  never a header or a body. (see "Evidence through the debugging protocol (Chrome and Edge)")

### Main-world scripts

- **Register a main-world script only while its feature runs, for its granted origin:** `bug-evidence-main.js` for a
  bug recording or a replay, `request-conditions-main.js` for request conditions `via: 'page'`. (see "The main-world
  evidence script" and "Slow down or fail a request")
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
  "How a replay finds a step's element", "Trusted input in a replay")
- **Read a `.piwibug` by its content (`isBugReportArchive`), never by its name.** (see "Report a bug")
- **Send `stepShot` parts only to an instance whose intake declares `stepShots`.** (see "A screenshot of each step")
- **Never answer a refused `captureVisibleTab` with `<all_urls>`;** a missing screenshot never blocks Finish. (see
  "Screenshots without the protocol need `activeTab`")
- **The IDE bundle never touches the page's `chrome`; what differs stays behind `IDE_BUILD` in `record-panel.ts`.** A
  new `chrome` call needs its answer in `src/ide/host.ts` and the launcher. (see "The IDE bundle")

### Locators and the in-page engine

- **Every tool that names an element or offers a locator goes through `verified-locators.ts`;** nothing estimates a
  count. (see "Naming and ranking an element")
- **Hover stays cheap: locators are checked only once the pointer rests (`HOVER_REST_MS`).** The Pick results' ring
  (`spotlight`) redraws on events, never in a frame loop. (see "Naming and ranking an element" and "How a tool claims
  the page")
- **Never show a locator's score alone as its verdict; use `verdictWords`.** (see "Naming and ranking an element")
- **Compare a page with the locator index, or key a bug report, only with the URL mapping's prefixes applied:**
  `pageHere` for the index, `bugContextFrom` with `activePathPrefixes` for a report, never `pageKey(location.href)`.
  (see "Tested elements")
- **The engine never tests a node with `instanceof` (a frame's nodes come from another realm); build one engine per
  scan.** (see "The in-page locator engine")
- **`locator-engine.spec.ts` compares the engine with real Playwright:** a new kind or option goes into
  `locator-cases.ts` with a fixture, and an expression Playwright rejects into the spec's `EXPECTED_REFUSALS`; one only
  the engine refuses fails, and no case is skipped. (see "Naming and ranking an element")
- **A new naming or narrowing case goes into `pick.spec.ts`** (else the ranking tests or `CONTAINER_NARROWING`). (see
  "Naming and ranking an element")
- **Render a locator with `highlightLocator` in `.piwi-loc`, with `LOCATOR_SYNTAX_CSS`, never as bare
  `textContent`.** Verdict and accent colors need their own light-scheme entry. (see "Rules, with their reasons")
- **`renderCopyMode` (`src/shared/copy-modes.ts`) stays pure.** (see "Content-script structure")

### Interface

- **The popup and the settings page stay plain TypeScript and DOM, no UI framework.** (see "The popup")
- **The popup must fit Chrome's 600-pixel popup height in every language** (`popup.spec.ts`): a new tile goes under
  More tools or into DevTools, with its hint under its label, never only a tooltip. Runs takes More tools' free cell,
  so it adds no height. (see "The popup")
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
  unless revealed, by the rule `@piwitests/core/mask` writes down, and never writes a header. The editor service
  bundles `mockCode` for Mock a request at a stopped test, so a change here changes what the editor writes. (see
  "Network and Mock this response")
- **Request conditions apply only to a tab that shows the origin they were set for.** (see "Slow down or fail a
  request")
- **Add to session has one path, `addNamedPick`.** (see "Locators and Session")

### Text and translations

- **Every text shown comes from the catalogs through `t()`, `tn()` or `tNodes()`** (`src/shared/i18n.ts`,
  `no-hardcoded-text.test.ts`). A new message goes into every catalog in the same change, English with a
  `description` (`i18n/README.md`, `locales.test.ts`). (see "Rules, with their reasons")
- **Translated text reaches the page as text or escaped, never as raw HTML.** (see "Rules, with their reasons")
- **Run `initI18n()` before the first text:** a content script ends with `void initI18n().then(start)` or runs `initI18n()` beside the
  storage reads it already awaits, and a panel
  sets `lang` from `uiLanguage()`. (see "Rules, with their reasons")

### Tests

- **Rebuild a function with `Function.prototype.toString()` only when it uses no `generateAlternatives` and no
  `chrome.*`;** test those on the real built bundle. (see "Rules, with their reasons")
- **`record.spec.ts`'s cross-page stub keeps `chrome.storage` in `window.name`, not in memory.** (see "Rules, with
  their reasons")
- **A spec opens the settings with `openOptions` and calls `optionsReady` after a `reload()`, before clicking.** (see
  "The settings page")
- **Measure a viewport through `chrome.tabs`, not the page** (`viewport.spec.ts`). (see "Open this page at a
  viewport")
- **Cancel a debugging session in a spec with the worker's `__piwiCancelDebugging(tabId)`.** (see "The debugging
  protocol")
- **Trigger the run shortcut in a spec through the worker's `__piwiRunShortcut()`:** the e2e suite cannot press a
  shortcut the browser holds. (see "The run shortcut")

## Commands

Run them from `apps/extension/`: the root `package.json` has no `extension:*` script.

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
released. `extension:lab` records on a running Piwi dashboard, or with `LAB_SET=wild` on public sites (no dashboard needed).

## Loading it locally

`npm run extension:build`, then in Chrome/Edge: `chrome://extensions` → enable Developer
mode → Load unpacked → select `apps/extension/dist`. In Firefox: `about:debugging` → Load Temporary Add-on →
`apps/extension/dist-firefox/manifest.json`.

While iterating, use `npm run extension:dev`: it rebuilds on save, but the browser picks up a build only when you
click reload on the `chrome://extensions` card (MV3 gives no way to trigger it from outside the browser).

- **Keep both runaway guards in `scripts/dev.mjs`:** rebuild only when a watched path's mtime or size changed, and
  build in a child process. (see "Loading it locally")
- **Until that reload the worker runs the old build, so a new worker message goes unanswered:** a tool reports it with
  `outdatedWorkerMessage()`. A spec that reloads the extension uses `launchWithExtension(path, { developerMode: true })`.
  (see "Loading it locally")

Disable the Chrome Web Store copy while a local build is loaded: two installs both claim the
`Ctrl+Shift+E` command, and the run shortcut's key once one is set, and only one of them gets each, which reads as "my
change didn't apply".
