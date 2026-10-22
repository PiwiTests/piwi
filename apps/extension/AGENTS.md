# Piwi Picker — Agent Instructions

Browser extension (Chrome/Edge/Firefox, Manifest V3) that reuses the monorepo's locator engine
(`@piwitests/core`) and shared picker overlay (`@piwitests/picker-dom`) to pick ranked,
stable Playwright locators from the live page. The picking/recording features are
standalone (no server, no permissions beyond `activeTab`/`scripting`/`storage`, plus the
one-origin-at-a-time `optional_host_permissions` grant recording needs, and `debugger`, attached
on demand — see "The debugging protocol" below);
**connecting to a Piwi instance is opt-in** and adds what needs a project's history: matching
a recording against the project's function catalog, and showing which elements of the page its
tests reach ("Tested elements"). See "Connected mode" and "Tested elements" below.

Published on the Chrome Web Store as
[Piwi Picker](https://chromewebstore.google.com/detail/piwi-picker/pakhnokpjboejcghgcmkjlpnogfjihhe)
(`pakhnokpjboejcghgcmkjlpnogfjihhe`), the listing Chrome *and* Edge users install from, and on Firefox Add-ons
(AMO) as [Piwi Picker](https://addons.mozilla.org/firefox/addon/piwi-picker/) (`picker@piwitests.dev`).
Each release tag packages it in CI (`.github/workflows/reusable-publish-extension.yml`), keeps the store zips as the run's
artifacts and submits them to every store whose secrets are configured; `PUBLISHING.md` has the loop, the secrets,
and the Edge Add-ons listing that is still outstanding.

## What it is

- `manifest.json` — MV3 manifest. Standing permissions stay at `activeTab` + `debugger` + `scripting` +
  `storage` — no static host permissions, no `<all_urls>`, no remote code. `debugger` is in the Chromium
  manifest only: `scripts/build.mjs` (`firefoxManifest`) leaves it out of `dist-firefox/`, and
  `build-manifests.test.ts` checks it. `minimum_chrome_version` (118) is Chromium-only too: from that version Chrome
  keeps the worker running while a debugging session is attached, and the sessions' state (`debugger.ts`,
  `cdp-*.ts`, `step-views.ts`) lives in the worker's memory. `optional_host_permissions`
  (`http://*/*`, `https://*/*`) is declared but **granted nothing by default** — the popup
  requests a single origin (`https://<the-recorded-site>/*`) from `chrome.permissions.request`
  only when the user clicks "Record actions", inside that click's own gesture. Adding a new
  *standing* permission here is still a deliberate, reviewed decision, not a default. `optional_permissions` holds
  `cookies` alone, granted nothing at install: **Save login for tests** (`login.html`, `src/login/main.ts`, pure half
  `src/shared/storage-state.ts`) requests it inside its Save click with the site's host for both schemes and any port,
  and its parent domains (`cookieOriginPatterns`: Chrome checks each cookie by its domain alone), reads that site's
  cookies and `localStorage` once, and downloads them as Playwright's `storageState`; nothing is kept or sent, and
  nothing is saved once the tab shows another origin than the one the page was opened for.
  `save-login.spec.ts` loads the file into a new browser context and checks it logs in.
  `browser_specific_settings.gecko.id` is Firefox's required stable add-on ID (Chromium ignores
  the key); never change it: the add-on is published on AMO under it, and a new ID creates a separate
  add-on rather than an update, orphaning existing installs. `background` names `background.js`
  twice, as `service_worker` (Chrome) and `scripts` (Firefox, which has no extension service
  workers — AMO rejects the manifest without it); the build writes `dist/` for Chrome and Edge
  without `scripts` (Edge lists it as an error) and `dist-firefox/` with it, and `gecko.data_collection_permissions` is
  `"none"`, which holds only while nothing is sent anywhere but the user's own instance and the editor paired on
  the same computer (Send to editor). See
  `PUBLISHING.md` §4. The manifest's `description` and the shortcut's label are `__MSG_*__`
  strings, translated in `public/_locales/` (English, the default, French, and German, Spanish and
  Brazilian Portuguese as drafts). The
  description doubles as the store listings' summary, so it stays within 132 characters in every
  language. The rest of the Firefox listing lives in `store/` (§4 c) — a new language needs both.
- `src/content/` — content scripts, each a standalone entry injected on demand. Most are
  injected via `chrome.scripting.executeScript({ files: [...] })` from the popup (never
  `<all_urls>` static injection, never the `func:` stringify-and-inject form — a normal file
  injection can import `@piwitests/core`/`@piwitests/picker-dom` directly, since nothing needs
  to survive `Function.prototype.toString()` here, unlike the packages/reporter/dashboard pickers).
  `record-panel.ts` is the one exception: it's also registered dynamically
  (`chrome.scripting.registerContentScripts`, scoped to the granted origin) so it re-attaches
  itself on every navigation for the lifetime of a recording — see `background/index.ts`. A page
  the browser restores from its back/forward cache runs no script again: the recorder attaches
  there on `pageshow` (`persisted`), or lets go of the page when the recording ended meanwhile.
  A bug recording (**Report a bug**, `bug-panel.ts`) registers a second script beside it,
  `bug-evidence-main.ts`, in the page's **main world** — see "The main-world evidence script" below.
- `src/background/` — the service worker. Handles the `chrome.commands` keyboard shortcut
  (the toolbar icon opens the popup instead, which injects content scripts itself) and the
  recorder's start/stop messages (`piwi-start-recording` / `piwi-recording-stopped`, plus the
  `chrome.permissions.onAdded` fallback that starts a recording when the grant prompt closed
  the popup — see below) — the only places `chrome.scripting.registerContentScripts`/
  `unregisterContentScripts` and `chrome.action.*` are called from, since content scripts can't
  reach either API. A message that names a tab or an address for the worker to act on, which only the extension's own
  pages send (`EXTENSION_PAGE_MESSAGES`: starting a recording, the viewport and request-condition messages, the
  language), is refused from anything else (`fromExtensionPage`, `senders.ts`).
- `src/popup/` — the toolbar popup. Plain TypeScript + DOM, no UI framework — keep it that
  way unless the popup's own complexity genuinely outgrows it. It holds the tools that act on the page, for testers and
  developers alike: **Record actions** and **Pick an element** first, then **Report a bug** and **Replay a bug
  report**, **Tested elements**, and the other page tools as compact tiles under **More tools**. Every tile shows its
  one-line hint under its label, never only as a tooltip (`popup.spec.ts` checks the compact ones). The developer tools
  that have a home in DevTools are there, not here (see "DevTools"), and Pick, Lint and Tested elements are in the Piwi
  panel's toolbar as well: the popup ends with a line saying so. It has a
  config (gear) button (`chrome.runtime.openOptionsPage()`) and, once connected, an **Active project** select that
  shows/overrides which mapped project applies to the current tab's site, with the connection's line under it
  (`#connection-health`, see "Connected mode"). **It must fit Chrome's 600-pixel popup height** in
  every shipped language (German is the longest); `popup.spec.ts` checks the English height, and a new tile goes under
  More tools or into DevTools rather than below the fold.
- `src/options/` + `options.html` — the settings page, one card per setting, each with its own actions and its own
  status line (`#language-status`, `#status`, `#mappings-status`, `#desktop-status`, `#editor-status`) and a badge
  saying whether it is connected or paired: **Language**; **Connect to Piwi** (instance URL with the pill saying how
  the instance answered its last request, `#instance-health`, and a **Connect** button,
  an RFC 8628 device authorization, below; a folded **Use an API key instead** with its own **Save and test**;
  **Disconnect**); **Project mappings**, shown once an instance is kept (the instance's URL patterns, read-only, marked
  **Piwi**; the patterns kept in this browser, a table whose **Save** keeps only them; a folded **Add a site** form);
  **Desktop app** (below); **Send to editor**; **Sites Piwi Picker may run on** (every host permission granted,
  `chrome.permissions.getAll`, with a **Revoke** each, redrawn on `chrome.permissions.onAdded`/`onRemoved` and on the
  recording's and the replay's state; `site-grants.ts`, pure, keeps the site of a running recording or replay and the
  origins the instance and the pairings hold, which Disconnect and Unpair give back). Same plain TypeScript + DOM
  approach as the popup. Opened via
  `chrome.runtime.openOptionsPage()`, or as `options.html#add=<pattern>` from the popup's **Add this site**, which
  opens the Add a site form filled in (a line of this browser with the pattern while the form waits for a first sync
  of the instance's projects), never linked to from a content script. `main.ts` awaits the language catalog and the
  stored settings before it attaches a listener, then sets `html[data-ready]`: an e2e spec opens the page with
  `openOptions` (`tests/e2e/fixtures.ts`), and calls `optionsReady` after a `reload()`, before it clicks anything.
- `src/shared/` — code shared between content scripts, background, popup, and options.
- `src/ide/` — the entry and the host of the IDE bundle, the recorder built for the editor service: see "The IDE
  bundle" below. Nothing in the extension loads it.

**A momentary tool must claim the page through `src/shared/tool-session.ts`.** `startTool(id,
teardown)` on entry, before it mounts anything (the predecessor's teardown runs inside that
call), and `endTool(epoch)` when it finishes; starting one tears down its predecessor, and
Escape cancels the current one, which the page then does not see. Every panel or wait a tool
opens is tied to it with `bindToTool(epoch, close)` (`waitForGlobal` is one), so a teardown
settles the promise its flow awaits rather than stranding it for the life of the page; the
flow checks `toolIsCurrent(epoch)` after each `await` and, once it is not current, leaves the
picker overlay and the pick globals to its successor. A pick-driven tool injected again while
it runs leaves it be (`isToolActive`); any other tool replaces it. Its teardown is
`teardownToolSurfaces`: the picking overlay and the anchors step go, listeners included,
`__piwiPickState`/`__piwiAnchorState` are answered for a flow that waits on them, and no other
surface on the page is touched. The bug recorder's Mark what's wrong claims the page as `pick`
for its pick alone, so a Pick started meanwhile leaves it be. The Pick results' **Pick another** picks again inside
the same tool session (`runPick` runs `pickOne` again on the `pick-another` outcome), so it neither starts a tool nor
ends one; while the results are open they ring the picked element (`spotlight` in `results-panel.ts`), drawn inside
their own shadow root and gone with it, and drawn again on a scroll (heard in the capture phase), a resize, or a size
change of the element or the panel (`ResizeObserver`), never in a frame loop.
Escape during the anchors step is that step's Skip, not a cancel. The
recorder deliberately stays outside this: it is a capture mode, and stopping it because
another panel opened would discard a recording in progress.

**Reading `chrome.storage.session` from a content script requires `ensureSessionAccess()`
(`src/shared/session-access.ts`) first.** The background worker widens the access level at
startup, but it is torn down when idle, so a script injected at `document_start` can run
before that has been applied — and the read *throws* rather than returning empty. The helper
pings the worker, which both wakes it and withholds its reply until the widening resolves.
Skipping this is what made the recorder's HUD appear only sometimes.

**Session storage goes through `sessionArea()` (`src/shared/session-area.ts`), never
`chrome.storage.session` directly.** Firefox has no `setAccessLevel` and no session storage in
content scripts at all, so there `sessionArea()` sends each get/set/remove to the background
script (`piwi-session-storage`), and the recorder's appends go as one `piwi-append-recording-event`
message each (see `appendRecordingEvent`) so a click that navigates away is not lost between a
read and a write. A module reaching `chrome.storage.session` itself works in Chrome and breaks
only in Firefox, which no CI run exercises.

## The debugging protocol (`debugger`, Chrome and Edge)

Used on demand since 2026-09-28. Chrome does not let `debugger` be optional, so it is a required permission, and
Chrome shows "Piwi Picker started debugging this browser" while a session is attached. The rules that follow from it:

- **Attach only while a feature the person started needs it, and detach the moment it ends.** Every session goes
  through `src/background/debugger.ts`: `acquireDebugger(tabId, purpose)` attaches once per tab and
  `releaseDebugger` detaches when no purpose holds the tab. The purposes are a replay (`cdp-replay.ts`, attached on
  the replay's first page, let go by `piwi-replay-finished`, a new replay, a command the browser refuses (the replay
  goes on with the page's events), or the tab leaving the origin, which
  `Page.frameNavigated` reports for any origin, where `tabs.onUpdated` gives no address without a grant; it also sets
  the viewport the steps were recorded at, `piwi-replay-viewport`, again on each page, and gives the tab its size back,
  or the popup's viewport, as it lets go) and a bug recording (`cdp-evidence.ts`, the tab the report starts in, let go when the
  recording stops or is discarded), the
  DevTools panel's conditions (`cdp-conditions.ts`, held while any condition or throttling is on) and a viewport set in
  the tab from the DevTools panel (held until **Back to the window's size** or the tab closes). A purpose that lets go of a tab
  another still holds ends its own emulation first (`Fetch.disable`, network and CPU back to normal,
  `Emulation.clearDeviceMetricsOverride`). Nothing stays attached in the background.
- **A viewport is set in CSS pixels, through `emulateCssViewport`** (`viewport-emulation.ts`). The protocol's size is
  divided by the browser's zoom (a 400-pixel override leaves the page 320 at 125%), so it is scaled by the tab's zoom
  and set again when that changes (`onTabZoomChange`); never send `Emulation.setDeviceMetricsOverride` directly.
- **Every feature has today's path as its fallback, and says so in plain words.** Firefox has no `chrome.debugger`
  (`debuggerAvailable()` is false); attaching can be refused (another debugger, a policy, a page Chrome protects);
  the person can click Cancel on the bar (`onDetach` with `canceled_by_user`, heard through `onDebuggerLost`). The
  pure half, `src/shared/cdp-input.ts`, names why (`FallbackReason`) and picks the driver (`chooseDriver`).
- **A content script never talks to the protocol.** It finds the element and its box; the worker sends the commands,
  checks the request field by field (`readInputOps`) and checks that it comes from the tab of the running replay.
- The e2e suite cannot click the browser's bar: the worker's `__piwiCancelDebugging(tabId)` does what Cancel does.
  `chrome.debugger` attaches beside Playwright's own connection, so the specs run on the real extension
  (`tests/e2e/trusted-site.ts`).

### A replay belongs to one tab

`replay-panel.js` is registered for the replay's whole origin, so every tab of it loads the script. The worker keeps
the replay's tab under `piwiReplayTab` (`getReplayTab`, which only the worker writes): the tab the replay started in,
or the first to ask (`piwi-replay-tab`) when none is bound. Only that tab plays the steps, gets a driver,
sends input and finishes the replay; the popup's Replay says so in any other tab (`popup_replayElsewhere`). A step
that opens its page in a new tab (a link with `target="_blank"`, `window.open`) takes the replay there, as the
recording went on there: the worker notes the tabs the replay's tab opens while it runs (`tabs.onCreated`,
`ReplayTab.opened`), and the first of them to ask moves the replay (`moveReplay`) when it shows the page of the
replay's step and the replay's tab does not (`stepOpenedTab`; Chrome also names the tab in front as the opener of a
tab merely opened beside it). The tab left gets its session and its size back, and its page lets go of the replay
wherever it waits (`piwi-replay-moved`). Closing the
tab ends the replay (`finished`), and a replay stopped while no page of its tab ran shows its verdict on that tab's next
page, or ends when another tab asks. The page writes the replay's state only through
`updateReplayState(change, replayId)`, onto the stored state, so a Pause, a Stop or a replay started meanwhile is
never overwritten by a step that was waiting.

### Trusted input in a replay

`replay-panel.ts` asks the worker for the driver on each page (`piwi-replay-driver`; the choice is kept in
`ReplayState.driver`, and a replay that fell back stays on the page's events). With `cdp`, `replay-trusted.ts` glides
the fake cursor, checks that the element (or its label) is what the browser finds at the point, as Playwright's hit
check does, and sends `piwi-replay-input`: mouse moves, clicks and double clicks, key presses (`ControlOrMeta` is ⌘
on a Mac, with the editing command Chrome needs), `Input.insertText` after selecting what a field or an editable
element holds, and drags (`Input.setInterceptDrags` + `Input.dispatchDragEvent` for an HTML drag, the moves alone for
a pointer-driven one, once both ends are on screen together). Date, time and color fields and `<select>` get their
value set as Playwright sets them. The replay's panel lets the pointer through while input is sent, and keeps its own
pointer and focus events from the page (a click on Next leaves the page's focus and its open menu as they are); a key
press with no element goes to the page's element that last had focus. Input lost before it reached the page (the bar
cancelled, a command refused) replays the step with the page's own events (`replay-actions.ts`); lost after part of it did (the button
went down, not up), the step fails with `replay_reasonInputInterrupted` rather than being done twice; each step result keeps its `driver`, and
the panels show it. A file step asks the developer for the file in the replay's panel (a report names files, never
carries them, and `DOM.setFileInputFiles` needs a path on disk), or lets them skip it (`skipped`); the file chooser a
click opens is intercepted while a replay holds the tab (`Page.setInterceptFileChooserDialog`).

## Connected mode (recording → your own functions)

The recorder (`record-panel.ts`, `record-capture.ts`, `packages/core/src/recording.ts`,
`function-match.ts`, `codegen.ts`) works fully standalone: record clicks/fills/etc. across
pages, get a raw Playwright spec back. Connecting to a Piwi instance (`options.html` →
instance URL + **Connect**, or a pasted API key; URL patterns from the instance and from this browser) adds one thing on top:
each mapped project's `test_functions` catalog (`apps/application/shared/handlers/test-functions.ts`)
is fetched once and cached per-project (`src/shared/catalog-cache.ts`, `chrome.storage.local`,
keyed by project id), and `rankFunctionMatches` / `matchFunctionAt` (pure, deterministic,
unit-tested in `packages/core`) match the live recording against whichever project's catalog
applies — ranked live in the HUD, substituted into the generated spec on export. The matcher
never invents a function; it only scores and selects among what the catalog already has.

**Connect** is a device authorization (`adr/extension-connect.md`): the settings page
requests the instance origin inside the click, `startConnect` gets a user code and a verification
page, the page opens in a tab, and `waitForApproval` (`src/shared/connect-flow.ts`, pure) polls
`pollConnect` until the user allows or denies it there. The approved answer carries the API key,
created for that user at that moment and returned once; the key is stored like a pasted one. The tab is closed however
the wait ends, and **Cancel** ends it at once, mid-sleep or mid-poll. The browser and OS names sent with the start come
from `describeClient` (`src/shared/client-info.ts`) and nothing else about the machine.

**No secret is kept in `chrome.storage.local`.** Content scripts read and write that area (the panels read
`ConnectionSettings` from it), so the API key, the desktop app's pairing and the editor's token live in the extension
origin's IndexedDB (`src/shared/secret-store.ts`), which a content script cannot open (its IndexedDB is the page's):
only the worker and the extension pages read them. The key is kept with the origin of the instance it was given for, and
`getInstanceApiKey` hands it out for that origin only, so an `instanceUrl` rewritten in storage gets requests without
it; no request to the instance or the desktop app follows a redirect (`redirect: 'error'`). `isConnected` never looks
at the key; the editor's address stays in `chrome.storage.local`, which tells a content script an editor is paired. A
secret found in `chrome.storage.local`, where older versions kept them, is moved as the worker starts, as the settings
page opens, and by each read of it (`legacy-secrets.ts`): written to IndexedDB first, removed after, and one already
kept there wins.

The buttons that start something (**Connect**, **Save and test**, **Save**, **Pair**, **Pair by hand**'s **Save and
test** and **Add to Piwi** in the settings, **Save login file** in `login.html`) disable themselves inside the click,
after the permission request, until it ends (`whileRunning` in the settings). A write the settings
page makes once an answer arrives goes through `writeConnection`: dropped when **Disconnect** or another connection
came meanwhile (`connectionEpoch`) or the stored instance is no longer the one it read, so a sync still in flight never
brings back a connection Disconnect removed.

**The instance's pages are marked** (`background/instance-marker.ts`, `content/instance-marker.ts`, the names in
`@piwitests/core/picker-marker`): while an instance URL is set and its origin granted, the worker keeps
`instance-marker.js` registered for that origin only and runs it in the instance's tabs already open, synced as the
worker starts, when `piwiConnection` changes and when a grant is added or removed. The script checks the page is the
instance's (`isInstancePage`, since Firefox's pattern covers every port of the host), sets `data-piwi-picker` on
`<html>` to the extension's version and dispatches `piwi-picker-marked`; the dashboard leaves out its hint to install
the extension when it sees either (`usePickerInstallHint`). It reads nothing from the page and sends nothing.
`instance-marker.spec.ts` covers it with the real worker and grant.

The instance's own URL patterns (`GET /api/extension/url-patterns`) are read by the settings
page when it connects and each time it opens, and cached in `ConnectionSettings.serverMappings`
(with `serverProjects`, whose `canEdit` gates **Add to Piwi**) by `applyServerSync`.
Which project applies on a given page is resolved by `src/shared/active-project.ts`'s
`resolveActiveProject(settings, override, url)`: a manual override for the page's site
(`chrome.storage.session`, kept per origin, set from the popup's **Active project** select for the tab's origin and
read with `getActiveProjectOverride(url)`, which a content script calls without one for its own page, and the popup, the
worker and the DevTools pages with the tab's address) wins if present,
then the first `ConnectionSettings.projectMappings` entry (this browser only) whose `urlPattern`
matches, then the first `serverMappings` entry that matches — so a local pattern overrides the
instance's in this browser. Matching uses the URL (via `urlMatches`/`globToRegExp` in `packages/core/src/function-match.ts` — the same glob
matcher a catalog entry's own `urlPattern` gate uses). Every consumer that needs "which project
applies here" (record-panel's HUD and review panel, test-function-panel, the popup's select)
calls this one function rather than re-deriving it. **Disconnect**, and connecting to another instance, drop every
site's override and every project's branch choice (`locator-branch.ts`) with the cached catalogs and locator indexes.
Disconnect sets the lines of this browser aside with the instance's origin (`src/options/kept-mappings.ts`,
`piwiKeptMappings`); the next connection kept takes them, back into `projectMappings` when it is to the same origin,
dropped otherwise, since their project ids are that instance's. They are read as a connection is made
(`readKeptMappings`) and dropped only once it is kept (`dropKeptMappings`, unless a Disconnect came meanwhile), so a
connection dropped on the way leaves them; a Disconnect with no instance kept leaves them too.

**No recording is ever sent to the instance**, and a bug report only through **Send to Piwi…**: the URL patterns,
each mapped project's catalog and locator index, and its bug reports (Replay's list) are fetched; what is sent is a URL
pattern the user adds, and a bug report once the user clicks Send in its preview (`bug-send-panel.ts`: the steps and
every kind of evidence shown, a box per kind and one that leaves the typed values out, of the steps and of everything
that repeats them, as typed or encoded; the payload is built by the pure `bug-send.ts`). The first send in a profile
explains once what connected mode now sends (`piwiBugSendExplained`).

**Run with Playwright** (`desktop-run-panel.ts`, worker side `background/desktop-repro.ts`) sends a report's title and
steps, nothing else, to the desktop app paired in the options (its loopback address and token, together in the
secret area; `desktop-settings.ts` accepts only plain http on 127.0.0.1, localhost or [::1], and keeps it as
127.0.0.1, the one address the app binds). **Pair** asks the app at the address
typed (`DESKTOP_DEFAULT_URL`, the app's preferred port, unless changed) for a pairing
(`POST /api/desktop/picker-pairings`, open without the token; see `apps/application/shared/desktop-pairing.ts`): the
app's window shows who asks with a code the card shows too, and the poll after the developer's **Allow** carries the
app's token, once, which the card keeps after `testDesktop` accepts it. **Pair by hand** takes the token pasted from the
app's **Connect Piwi Picker** instead. Either way the options page requests that one loopback origin inside the click,
and **Unpair** gives it back, unless the instance kept is at that address. The app's server is a Piwi instance that
takes its token as an API key (`desktop-guard.ts`), so the Connect to Piwi card offers **Use the desktop app as your
instance** while the app is paired and no instance is kept (`connectWithKey`, the path of **Save and test**, with the
app's address and token; a refused token leaves the address in place and the key field focused), and points to the
pairing while an instance is kept and no app is paired. **Disconnect** leaves the address to a pairing there. Every request that carries the token (`testDesktop`, `sendReproRequest`,
`fetchReproRequest`) first has `/api/health` answer a new random challenge with the proof only the token's holder can
compute, for the address's port (`proveDesktop`, `@piwitests/core/desktop-proof`): an app that moved, an older app or
another program on the port never receives the token, and the user is asked to pair again. The same holds for the
token kept as an instance's key: `authHeaders` runs `proveDesktopKey` before every instance request whose key is the
app's token (marked so in the secret area by `markDesktopApiKey` as the connection is kept and as a pairing is replaced
or removed, so Unpair keeps it; or matching the paired address and token), refuses at a loopback name other than
127.0.0.1, and throws `common_desktopNotProven`, which `healthOutcome` reads as `unauthorized`. The dialog shows the payload before **Send**. The request is JSON with `x-piwi-token`, holds steps and never code, and the app runs nothing
before the developer confirms it in its window; the dialog then polls the request for the verdict, read field by field
(`reproStatus`, `asReplayVerdict`): a status or a verdict it does not know says so in one line.

A replay registers `bug-evidence-main.js` in the page's main world beside `replay-panel.js`, for as long as it runs,
under the replay's `evidenceToken`; the panel keeps the entries apart from the replay state (`piwiReplayEvidence`) and
lists them under the verdict. Its relay sends `ReplayState.startedAt` as `since`: in the tab a bug recording's debugging
session collected from, the page's script still holds the recording's entries, which its quiet relay never took, and a
replay started on that page would otherwise count them as its own. **Share result** (`share-result.ts`, worker side `handleShareReproduction`) records a
verdict on the report it came from (`bugReportId`, set only for a report chosen from the instance), after a preview:
the verdict, the origin it ran on and the user agent, `POST /api/bug-reports/:id/reproductions`.
Only `piwi-client.ts` makes those requests, from exactly two
contexts: `src/options/` (connecting, saving, reading and adding URL patterns, pairing the desktop app) and the
background worker: its `piwi-refresh-catalog` / `piwi-refresh-locator-index` handlers (`project-refresh.ts`, which
fetch for a content script only the project its tab's URL maps to, and take a whole project id), its bug-report
messages (`src/background/bug-reports.ts`: `piwi-bug-send-target`, `piwi-send-bug-report`, `piwi-list-bug-reports`,
`piwi-get-bug-report`, which resolve the project again from the sending tab's URL and never take one from the page;
`piwi-share-reproduction`, which records a verdict only on the stored replay's report or one sent to the desktop app;
and `piwi-replay-step-view`, for the stored replay's report) and the desktop app's (`piwi-desktop-repro`,
`piwi-desktop-repro-status`). **Never from a content script**, so the API key never reaches a page's JS context —
`record-panel.ts`/`test-function-panel.ts`/`coverage-overlay.ts` read the cache and, when they need fresher data, ask
the worker via `catalog-refresh.ts` / `locator-index-refresh.ts` rather than fetching themselves, and build their links
into the dashboard with `instance-links.ts`, which fetches nothing; `piwi-client.test.ts` fails on a content script
importing `piwi-client.ts`. Keep it that way.

**Whether the instance answers** is kept by `src/shared/connection-health.ts` (`piwiConnectionHealth` in
`chrome.storage.local`, no secret): every request `project-refresh.ts` and `bug-reports.ts` make, and the settings
page's read of the URL patterns, goes through `withConnectionHealth`, which records `ok`, `unauthorized`,
`unreachable` or `error` with the time and the instance address, and passes the answer or the error on unchanged.
`piwi-client.ts` throws sentences, so `healthOutcome` tells them apart by the catalog's own messages; an answer that
shows the instance works and the key is accepted (no locator index, a role that cannot send) is `ok`. The popup's
line under the project row and the settings page's pill beside the address read it for the instance kept only, and
redraw on `chrome.storage.onChanged`; Disconnect clears it. A new request to the instance goes through the same
wrapper.

Staleness matters here: a function added in the dashboard reaches the extension without the options page saving again.
The panels render from cache first (instant, and fine with the instance unreachable) and
revalidate in the background, TTL-guarded by `CATALOG_TTL_MS`; the "Test functions" panel also
has an explicit Refresh that forces past the TTL. `refreshHud` runs on **every captured step**
during a recording — never add a fetch to it; the record panel refreshes once per page load
instead.

The dashboard API sends no CORS headers, and the `X-API-Key` header makes these requests
non-simple, so the browser preflights them. A granted host permission for the instance origin
is what actually makes the fetch work; the options page requests it inside the click (Connect, Save and test, Save,
Refresh; a service worker has no user gesture and can never request one itself), calling `chrome.permissions.request`
first, before anything is awaited: Firefox shows no prompt for a request made after an `await`, and an origin already
granted answers true without one. Every host pattern built for an origin comes from `hostPattern` (`src/shared/web-origin.ts`),
never `${origin}/*` by hand. Firefox accepts a pattern with a port (`http://localhost:3000/*`) and lists it as
granted, but the pattern matches nothing (bug 1362809), so CORS still blocks the fetch. In Firefox only, `hostPattern` leaves
the port out.

`test-function-panel.ts` (+ its pure half, `test-function-scan.ts`) is the other consumer of
the cached catalog: a standalone popup action ("Test functions") that scores every catalog
entry's pattern against the *current* page's live DOM — no recording needed — and reports a
per-step unique/ambiguous/missing verdict rolling up into ready/partial/not-found per function.
It shares `scoreTargetMatch` (`packages/core/src/function-match.ts`) with the recorder's own
live ranking, so a function this reports "ready" is scored exactly the way it would be mid-recording.
It counts what Playwright finds, open shadow roots included (`createPageEngine`): a test id target every element
carrying it, hidden ones too, as `getByTestId` does; a role or name target none hidden from the accessibility tree, as
`getByRole` does.

## Tested elements (the project's locator index, evaluated on the page)

`coverage-overlay.ts` (popup tile `T`, and **Show every tested element** in the pick results)
outlines every element a test of the active project reaches, and the visible interactive
elements none reaches. The data is `GET /api/projects/:id/locator-index`
(`LocatorIndex` in `packages/core/src/locator-index.ts`, built by `getLocatorIndex` in
`apps/application/server/utils/locator-usages.ts`), fetched by the worker and cached in
`chrome.storage.local` by `locator-index-cache.ts` (TTL `LOCATOR_INDEX_TTL_MS`, the last
`LOCATOR_INDEX_CACHE_PROJECTS` indexes within `LOCATOR_INDEX_CACHE_BUDGET`, 4 MB of JSON; an index larger than that,
or one that does not fit the quota, comes back in the worker's reply uncached). An index describes one branch: `locator-branch.ts` resolves it from the
panel's choice for the session, else the URL mapping's `branch`, else the default branch, and the
cache keeps one entry per project and branch.
The open page is compared with the index's page keys only through `pageHere` (`src/shared/page-here.ts`): it removes
the URL mapping's `pathPrefix` (`/app` for a site serving `/app/checkout` whose tests ran at `/checkout`), whole
segments only, then puts its `testPathPrefix` in front (`/app` for tests that ran `/app/checkout` where the site serves
`/checkout`), before `pageKey`. Never call `pageKey(location.href)` to compare with the index or to key a bug report.

The chains are evaluated by an in-page reimplementation of Playwright's selector engines:

- `engine-aria.ts` — `DomModel`: role, accessible name and description, ARIA states,
  hidden-for-ARIA, visibility, element text and `getByLabel` labels, following Playwright's
  `roleUtils.ts`/`selectorUtils.ts`. Pure DOM, no `instanceof` (frames are other realms).
- `engine-selector.ts` — CSS (piercing open shadow roots, Playwright's `:has-text()`, `:text()`,
  `:visible`, `:scope`, …) and XPath. `:is()`, `:where()`, `:not()` and `:has()` are evaluated
  here, as Playwright does: inside the scope and through open shadow roots. A text pseudo-class takes quoted strings
  (`:has-text(Tailwind)` fails once matched against an element, as in Playwright); pseudo-elements and two combinators
  in a row are refused.
- `locator-engine.ts` — `createLocatorEngine(doc, { testIdAttributes, ignore, strict })`: evaluates a
  parsed `locator-chain` (every `getBy*`, `locator()`, `>>` parts, `filter`, `and`/`or`,
  `nth`/`first`/`last`, frames). A frame locator enters its first owner, as `count()` does, and
  `first()`/`nth()` on it pick the owner; `strict` refuses several owners, as an action does. `frameLocator()` with no
  selector searches the page and every frame below it, and refuses elements found in more than one. A frame inside a
  locator nested in `and()`, `or()`, `has`/`hasNot` or `locator(locator)` is refused, as Playwright refuses it, unless
  the nested chain starts with the outer chain's own frame prefix, which is dropped (`prepareChain`).
  Caches per engine instance, so build one per scan.
- `coverage-scan.ts` — the pure half: runs every chain of the index in time slices, starting over
  with a new engine (twice at most) when the page changes under it, and reports covered/uncovered
  elements and tests. `coverage-layer.ts`/`coverage-panel.ts`/`coverage-view.ts`
  draw it; the overlay lives in a closed shadow root in the top layer (`popover="manual"`) so it
  paints above the page's own dialogs.
- One element at a time: `scopeScan` narrows a finished scan to an element and what is inside it
  (no rescan), and `elementReach` splits the tests reaching a picked element into the element
  itself, inside it, and around it. The pick results hand an element to the overlay through
  `globalThis.__piwiCoverageScopeRequest` before asking the worker to inject it: both content
  scripts run in the extension's isolated world, so the global is shared, and an element cannot
  travel through `chrome.runtime` messages.

**At risk** (`coverage-risk.ts`, pure apart from the engine it is handed) lists the locators likely to break. Brittle
ones come from `assessLocatorChain` (`@piwitests/core/locator-stability`), judged once per index. A replacement is
built only for a chain finding one element: `rankElementLocators` (`verified-locators.ts`) ranks that element's locators, the
same rules must call a candidate stable, an engine over the current page must find only that element with it, and
`recommendLocatorFix` (`@piwitests/core/locator-fix`, locator healing's ladder) picks among the survivors. Replacements
and the suggested locators are cached per element until the page changes: the overlay drops them, with the engine that
checked them, on every change it observes. An element inside a frame gets none, because its locator would need the
frame's prefix.

## Naming and ranking an element

Every tool that names an element or offers a locator for it goes through `verified-locators.ts`, the same path the
recorder takes:

- **Names and roles** come from `DomModel` (`accessibleNameOf`, `model.role`): "Regressions 5" for a tab showing a
  count badge, where `textContent` reads "Regressions5", and `columnheader` for a `<th>`, which `generateAlternatives`
  takes as its `role` option. The probe's `approximateAccessibleName` is only the fallback when the model finds no name.
- **Ranking** (`rankElement`) is `generateAlternatives` without the probe's estimated match counts. Given an engine
  (`engine`, or a `model` from `createPageEngine`), the probe runs with `countMatches: false` and the anchors are
  counted with the engine's indexes, built once for a whole scan, on a page of any size; without one (a single pick,
  the recorder), the probe counts them, walking the page. **`checkLocators`** runs every candidate through an engine
  over the page (`createPageEngine`, blind to the extension's own elements): verified first, a candidate finding the
  element among others narrowed at one point under it, one finding only others dropped, `.first()`/`.nth()` last. The
  narrowing ladder (`narrow()`), each rung checked unique by the engine and named in `CheckedLocator.narrowedBy`:
  exact (`exact`); `.filter({ hasText })` with the element's text (`text`); an ancestor whose test id is unique
  (`scope`, the test id read from the engine's `testIdAttributes`); the nearest **repeated container** whose siblings
  hold the other matches (`container`: `repeatedContainers` in `repeated-container.ts`, an ancestor sharing a test id,
  or a tag with a role or a readable class, with its siblings), filtered by a short text it shows and they do not, or
  by its own `aria-label`/`aria-labelledby` name; a landmark, named dialog or row scope (`scope`). A unique test id
  goes before the container because it is the author's own hook; a row named from its whole content goes after it,
  being longer and changing with every cell. `keepAmbiguous` also returns the others with the engine's count, which
  is what the Pick results panel shows.
  The pick (`pick.ts`) checks the candidates before anything else: the anchors step opens first only when none
  finds the element alone (`unique` or `narrowed`) without the stability rules calling it brittle; otherwise the
  results open at once and offer it as **Scope to a parent…** (`renderResultsPanel` resolving `scope`), after which
  the anchored candidates are checked and the results open again. `verifiedLocators` (the recorder),
  `deriveTopLocator` (assertions, the Tested
  elements overlay) and `rankElementLocators` (At risk replacements) are built on it; a scan passes one engine to every
  call so the engine's caches serve the whole scan.
- **Multi-pick** (`derivePattern`, `multi-pick-derive.ts`) shares `repeatedContainers` with the ladder: picks
  sharing a role, each alone in its container, the containers siblings of one kind (rows of one table, cards of one
  grid), give the container's pattern, `getByTestId('product-card').getByRole('button', { name: 'Add to cart' })`
  with the number of elements it finds, and per pick its container filtered by a text no other container shows
  (`.nth()` on the pattern when none does). Other picks give their own role or class with `.filter({ hasText })`.
  `multi-pick.ts` hands it the page engine's roles, names and texts.
- **Words** (`verdictWords`, `src/shared/verdict-words.ts`, unit-tested) say what a checked locator is worth: a word
  (`stable`, `could break`, `brittle`, `unique by position`, `3 matches`, `not checked`), a tone and an explanation
  (`unique · brittle: CSS class`), from its verdict and `locatorStability` (`assessLocatorChain`'s level and rules). A
  Pick results row leads with the word and keeps the explanation and the engine's score in its Details; the Elements
  sidebar shows the same explanation. Never show the score alone as the verdict: it has no scale a person can read.
- **Hover** (`createHoverLocator`, behind the picker overlay's `__piwiDescribeElement`) must stay
  cheap on pointer moves. Building the engine's indexes costs tens of milliseconds on a large page (about 45 ms at
  3,000 elements, 120 ms at 9,000), so a move gets the ranked candidate (probe without structural anchors, `DomModel`
  name: under a millisecond), and the check runs once the pointer has rested `HOVER_REST_MS` on the element, kept for
  that animation frame; the picker overlay re-reads it through `globalThis.__piwiRedescribe`.
- **Counts** (the DevTools Locators tab) come from the same engine; nothing in the extension estimates a count.

`pick.spec.ts` picks each case of `tests/e2e/pages/pick-cases.html` (a tab with a count badge, a name that is a
substring of another, a link in the nav and in main, buttons sharing an `aria-label`, a column header, a search field
with suggestions, a banner) and has real Playwright click the top locator the results panel offers. A new naming or
narrowing case goes there; one the picker cannot click (it snaps to an ancestor carrying a `role`, so a grid's cell
is its grid) goes into `locator-engine.spec.ts`'s ranking tests (`__piwiRankTop`), and a repeated-container case into
`CONTAINER_NARROWING` (`locator-cases.ts`, on `pages/locator-containers.html`).

**`locator-engine.spec.ts` is a differential test against real Playwright**: every expression in
`locator-cases.ts` is resolved by the engine bundle (`engine-entry.ts`) and by a real
`page.locator(…)`, and the two element lists must be identical. A new locator kind or option
goes into `locator-cases.ts` with a fixture element in `tests/e2e/pages/`; an expression the
engine deliberately refuses goes into the pinned refusal list, never into a skipped case.

## Checks in a test recording

A test recording's bar (`renderHud`, in Piwi Picker and in the IDE bundle) has **Check an element** and **Check the
address** (`check-panel.ts`). They reuse the bug report's pick and dialog (`pickElement`, `openRecordDialog` in
`bug-panel.ts`), pause capture the same way, and record an `assert` event of what the page shows now, with `actual`
null: the spec writes it as `await expect(…)`. The dialog names the element by the recorded target's first locator, so
the project's test id attribute applies. Both buttons are disabled while the recording is paused.

**Pause** in the bar (both builds) stops capture without ending the recording, until **Resume**: one guard,
`capturePaused()`, at every capture listener. The extension keeps it in `RecordingState.paused` (`updateRecording`,
queued behind the document's appends), which each page reads as the recorder attaches, and sends
`piwi-recording-paused`, which the worker passes on to the recording's other tabs (`notifyRecorderTabs`); in the IDE
bundle the launcher keeps it and tells the editor. The DevTools Record tab says the recording is paused.

The review panel after Stop has **Replay**, as the bug report's finish panel has: both start the replay in the tab
through `startReplayHere` (`record-ui.ts`, `piwi-start-replay`). The replay dialog offers the last recording not
discarded, either mode (`lastRecordedReport`), each under its own label.

A recording of actions has a title (`RecordingState.title`): the first page's `document.title` as the recorder first
attaches, then the review panel's **Test title** field. Every export of it goes through `recordingTitle`
(`src/shared/recording-title.ts`), which falls back to the first action in words (`titleFromSteps`), so no spec says
`recorded flow` when the steps name it better: `renderSpec({ title })` for Copy as TypeScript (the review panel and the
DevTools Record tab), `steps.title` for Download steps, Send to editor, Replay and the replay dialog. A bug report keeps
its own title in its evidence.

## Report a bug

A bug recording is a recording with `mode: 'bug'` (`recording-storage.ts`): the same capture,
navigation and one-origin rule, a different HUD (`bug-panel.ts`), and `assert` events that
`normalizeSteps` keeps in place. **Mark what's wrong** pauses capture (`__piwiRecordPaused`, a
global because every re-injection of `record-panel.js` is its own module instance), runs the pick
overlay, and opens the expected-value dialog built from `suggestAssertions`; **Something is
missing** checks its `getByRole` with the in-page engine and refuses an element that is there.
Evidence lives under its own `chrome.storage.session` keys (`bug-storage.ts`), not in
`RecordingState`, which is rewritten on every keystroke. The report and its files are assembled
by `bug-report-files.ts` (pure) and `@piwitests/core/bug-report` (`renderBugMarkdown`,
`renderBugSpec`); the archive is written by `shared/zip.ts`, stored without compression, and downloaded as
`.piwibug`: its first entry is `mimetype` holding `BUG_REPORT_MEDIA_TYPE`, which `isBugReportArchive` (core) reads to
tell it from any other zip. Readers go by content, never by name: Replay and the desktop app take the same file named
`.zip`. A bug recording also records `viewport` events (`record-panel.ts`: the page's size when the recording reaches
it, before its `navigate`, and the size a resize settles at); `normalizeSteps` skips them and `sessionFromEvents` turns
them into the steps document's `viewports`, by the first step recorded at or after each. The bar's evidence lines (the summary, the
debugging session's note, why there is no screenshot) are written in place by `updateBugHudEvidence` whenever the
evidence changes: an entry the page relays, and a screenshot stored or refused (`takeBugScreenshot` ends with
`refreshBugHudEvidence`), since the bar a mark redraws counts the evidence before its screenshot is in.

**A screenshot of each step.** The recorder asks the worker for a view of the page (`piwi-bug-step-view`, under an id
it makes up) as it starts on a page and once the page has been still for `VIEW_SETTLE_MS` after an action, with its
surfaces hidden (`hideSurfaces`, `record-ui.ts`: a count per host id on the isolated world's `globalThis`, so hides
overlap, a host drawn meanwhile is mounted hidden, and each shows again once the last hide holding it ends); an action
with no unused view left asks for its own as it starts. Each action event keeps the view's
id and its element's box (`view`, which `normalizeSteps` carries to the step and `toStepsDocument` leaves out), so the
box only holds for the page the view shows: a scroll (of the page or any element) or a resize marks an unused view
moved, and it is taken again under the same id, once the page settles or as the next action starts. The worker
(`background/step-views.ts`) takes it through the recording's debugging session, or `captureVisibleTab` under
`activeTab`, drops what the id held before (of two images under one id, the later-taken stays), and keeps it as a
JPEG as wide as the viewport in CSS pixels in its own IndexedDB
(`shared/step-views.ts`: a content script's IndexedDB is the page's, and session storage cannot hold a hundred
screenshots); the finish panel asks for them back (`piwi-bug-step-views`) and writes `evidence.stepShots` and
`steps/<nnn>.jpg`, unless the reporter leaves them out. A recording that starts or is discarded clears them, and so
does the worker as it starts when session storage holds no recording (the browser session ended: `clearStaleViews`,
which clears a replay's views when it holds no replay).

**A step a replay cannot play goes to the person.** When a step finds no element (or not the one it needs), the flow is
on another page (a goto whose page never comes, a 204 or a download, included; a goto is followed only to an http or
https address on the replay's origin), or its action fails (a file step's element takes no file), `replay-panel.ts`
sets `ReplayState.handOver` and shows why, the step in words
and its screenshot, outlined where the recording found its element (`piwi-replay-step-view`): **I did it, continue**
records it as `manual`, **Skip this step** as `skipped`, **Stop here** as `diverged` and ends the replay. The panel
also lists the element's recorded locators (the replay's own first, three at most), and the cursor overlay marks the
elements they find on the page (`FakeCursor.marks`), looked for again every `HAND_OVER_LOOK_MS` while the person acts. The
hand-over is in the replay's state, so it waits on the page the person's own action loads. A `manual` step (a
report made from a test run, `@piwitests/core/execution-steps`) is always handed over, with the line of the test it
stands for; a step whose `pageUrl` is empty waits for no page. Such a report's `export` block names the step the test
failed at; `readReportFile` reads it into `ReplayState.runFailedStep`, and `replayVerdict` says a stop there failed as
in the run (`asInRun`) and a pass there did not reproduce it (`runStep`). A replay keeps its step
screenshots in the worker's IndexedDB too: the start message carries the images of a chosen `.piwibug` (`views`), the
recording's view ids (`recordingViews`), or asks to keep the last replay's (`keepViews`, Replay again); anything else
clears them. For a report from the connected instance, the worker fetches a step's screenshot only when that step is
handed over (`fetchBugReportStepShot`). **Send to Piwi** sends the step screenshots as `stepShot` parts only to an
instance whose intake says how many it takes (`stepShots`): an older one refuses a send with more files than it
expects.

**Evidence through the debugging protocol (Chrome and Edge).** A bug recording holds a session on the tab it starts
in (`startBugDebugger`, `src/background/cdp-evidence.ts`): `Runtime` and `Log` give the console and uncaught errors
from the page's first script, `Network` every request that failed or answered 400 or more (documents, scripts and
images included; method, URL through `reportedRequestUrl`, status, never a header or a body), and
`Page.captureScreenshot` a screenshot at any moment, across navigations, which the HUD's **Screenshot** button offers.
It keeps the recorded origin only (`startBugDebugger(tabId, originPattern)`), as the main-world script does: the console
of the page's default execution contexts (never an isolated world) while the tab shows that origin, and the requests of
its documents, their URLs written against it; a sign-in on another site adds nothing.
Only the worker writes what it collects, under its own key (`CDP_EVIDENCE_KEY`); `getBugEvidence` merges it with what
the page relays. The main-world script stays registered: the recorder asks `piwi-bug-evidence-source` and keeps its
relay quiet in the tab the worker collects from, so nothing is counted twice, and starts it when the session is lost
(`piwi-bug-debugger-lost`), from the time it ended (`DebuggingState.endedAt`): the script leaves out what it held
from before. Stop and Finish wait for the worker's answer to `piwi-recording-stopped`, which comes once the session's
last entries are stored. The HUD says the debugging bar is expected (`bug_debuggingOn`), and why it went.
`bug-report-cdp.spec.ts` covers it on the real extension.

**Without it, screenshots need `activeTab`.** `chrome.tabs.captureVisibleTab` refuses under the recorder's
per-origin host grant ("Either the '<all_urls>' or 'activeTab' permission is required", checked on
the bundled Chromium, and in `bug-report.spec.ts` against the real extension). The popup click
that starts a report grants `activeTab` until the tab navigates; after that the report records
why there is no screenshot, and the popup's tile, during a bug recording, asks the page for one
(opening the popup is the grant). Never answer this with `<all_urls>`. The popup's **Finish bug report** asks the page
too (`piwi-bug-finish`), which finishes as the HUD's Finish does (the relay's last entries, a screenshot, the outline),
and stops the recording itself only when no recorder of the tab answers. The note a report keeps follows the
worker's reason (`ScreenshotFailure`: no grant, in the words of Chrome or Firefox, the tab not in front, or another
failure). A screenshot session storage has no room for leaves a note in the report (`bug_screenshotNotKept`) and
never keeps Finish from finishing.

### The main-world evidence script

`bug-evidence-main.ts` wraps `console.error`/`console.warn`, `fetch` and `XMLHttpRequest`, and
listens to `error` and `unhandledrejection`: the evidence in Firefox, in the recording's other tabs, and once a
debugging session is lost. It is the only code here, with the request-conditions wrapper, that runs in the page's own
JavaScript world, so:

- It is registered only while a bug recording runs, for the recording's granted origin, at
  `document_start` (`BUG_EVIDENCE_SCRIPT_ID` in `background/index.ts`), and unregistered with the
  recorder. It needs no permission beyond `scripting` and that grant.
- It must never import anything that touches `chrome.*` (the main world has none) and must only
  wrap and listen: every wrapper calls the original with the same arguments and returns its result. `fetch` returns a
  promise derived from the original's, settling as it does, since observing the page's own promise would handle its
  rejection: a failure the page leaves unhandled still fires `unhandledrejection`, once. An XHR gets its listeners once
  and reports the request it opened last.
- It never reads a header or a body; a URL keeps its path with ids collapsed and query values
  removed (`reportedRequestUrl`, built on `normalizeRoute`).
- It talks to the isolated-world recorder only by `window.postMessage` (`shared/bug-relay.ts`; the recorder and the
  replay listen through `relayEvidence`, which stores in batches; as the page is left, what is pending goes to the
  worker in one message, `piwi-relay-left`, since a read and a write of session storage started then never finish,
  and the worker keeps it for the recording or the replay whose token it carries), and the page sees those messages. The per-recording token keeps out entries from another recording,
  not a page that means harm; `readRelayedEntry` rebuilds every entry field by field and truncates
  it, and storage caps each kind at 100. Treat everything it relays as page-controlled text.

## Files, double clicks and drags

The recorder keeps a file field's choice as the files' names, one per line (`files` → `setInputFiles`), never their
content, which never leaves the page; a trusted `dblclick` replaces the two clicks before it (`normalizeSteps`); an
HTML drag and drop is recorded from `dragstart` and `drop` as `dragTo`, with the element dropped on as `dropTarget`. A
drag done with pointer events alone (a sortable list, a slider) is not recorded as a drag.
`record.spec.ts` checks all three, and that a file's content is not stored.

## Hovers a click depends on

Some elements show only while another is hovered. At each press, `record-panel.ts` asks `hoverTargets` which hovers
revealed the pressed element or an ancestor, and records a `hover` step for each before the click:

- **CSS `:hover`** — `hover-rules.ts` reads the page's same-origin sheets once per change (inside `@media`,
  `@supports`, `@layer`, `@container`, and nested rules resolved to their full selector) and keeps the `:hover` rules
  that set `display`, `visibility`, `opacity` or `pointer-events`, and the rules that hide. `cssHoverSubjects`
  (`hover-reveal.ts`) keeps a rule that applies now to an element another rule hides, then finds the hovered element
  by writing `:hover` as the `data-piwi-hover-probe` attribute and setting it on ancestors until the rule matches; the
  attribute is removed before it returns, and is the only change to the page.
- **Script** — `HoverTracker` follows trusted `pointerover` entries and a `MutationObserver`'s insertions (and
  `style`/`hidden` changes that show an element). An element inserted soon after the pointer entered an ancestor, with
  no press in between, was revealed by that ancestor's hover.
- The step names the element the pointer entered the subject through when the subject's own name includes what the
  hover shows (a row read as "Invoice 42Delete"), through the same verified locators as the click.

Played with trusted input, a replay's hover is the browser's own. With the page's own events (Firefox, a session
refused or cancelled), it emulates CSS `:hover` (`hover-emulation.ts`): a constructed sheet in each document (the
page, a same-origin frame) repeats that document's
`:hover` rules with the `data-piwi-hover` attribute in place of `:hover`, and `dispatchHover` sets the attribute on
the element pointed at and its ancestors, moving it with each step and removing everything when the replay ends. The
pointer events it sends follow the element tree: leaves for the ancestors it left, enters for the ones it entered.
`hover.spec.ts` records, replays and runs the spec of each kind of reveal on `tests/e2e/pages/hover-*.html`.

## The IDE bundle (`record-ide.js`)

The recorder built a second time, for the editor service (`packages/editor`): its launcher starts a browser with the
project's own Playwright, exposes the binding `__piwiRecorder` in every page, then loads `record-ide.js` into every
document (the names and the requests are in `@piwitests/core/ide-recorder`). `buildIdeBundle({ outDir, release })`
(`scripts/build.mjs`) writes it beside `record-ide-messages.json`, every catalog with its messages and placeholders'
contents alone, into the editor's `dist/`; neither is part of `dist/` or `dist-firefox/`.

- **One recorder, another host.** `src/ide/record-ide.ts` imports `src/ide/host.ts`, then `record-panel.ts`. The build
  rewrites every `chrome` reference to `globalThis.__piwiIdeChrome`, which the host installs, read-only, over the
  binding: `storage.local` and `runtime.sendMessage` are requests to the launcher; there is no `storage.session`, so the
  recorder keeps its recording through `piwi-session-storage` and `piwi-append-recording-event`, as in Firefox;
  `runtime.onMessage` keeps its listeners, which nothing calls; `i18n` answers nothing, since the launcher hands the
  editor's catalog under `piwiLanguage`; `getURL` points at a reserved domain, so `isExtensionContext()` is false; no
  `dom`. The page's own `chrome` is never touched. Without the binding the host installs nothing and the recorder never
  starts. A `chrome` call the recorder starts making needs its answer in the host and in the launcher.
- **What differs is behind `IDE_BUILD`** (`src/shared/ide-build.ts`, the build constant `__PIWI_IDE__`, false in every
  bundle of the extension, where those branches fold away), in `record-panel.ts` alone: it records the top-level
  document of an http or https page and nothing else (the launcher's script also runs in frames and in a new tab's
  `about:blank`); Stop opens no review (capture stops, the HUD and the border go, `piwi-recording-stopped` still goes
  out); the HUD names the file from `piwiIdeSettings` (`record_hudTitleInto`); its **Pause** goes to the launcher, which
  keeps the recording's `paused` for every page and tells the editor (`piwi-recording-paused`), the editor's Pause
  reaching the page through `__piwiIdeDispatch`; the page refreshes no catalog.
- **The project's test id attribute.** `rankElement`, `verifiedLocators` (its engine) and the probe take
  `testIdAttribute`: from `piwiIdeSettings` in the IDE bundle, `data-testid` in the extension. A click snaps to an
  element carrying it, as to a control.
- **Tests**: `ide-host.test.ts` (the request each `chrome` call makes, the recorder's storage over it, nothing installed
  without the binding), `ide-bundle.test.ts` (no `chrome` left in the built bundle, the build's global name equal to
  core's, the catalogs), and `record-ide.spec.ts`, which builds the bundle, answers the binding as the launcher does,
  and records across two pages of a plain browser. The extension's own specs keep covering the recorder.

## Playwright view

`playwright-view.ts` (**Playwright view** in the DevTools panel's toolbar, a toggle) labels every element a test could reach with the role and name
`DomModel` gives it and its test id, and marks two kinds: **unreachable** (looks operable, through a `tabindex`, an
`onclick` or a pointer cursor its parent lacks, with no role; or an operable role with no name; and no test id) and
**ambiguous** (its `getByRole(role, { name })` finds other elements on the engine). The pure half is
`playwright-view-scan.ts`, one engine per scan, in time slices; it counts what each `getByRole` would find from the
elements grouped by role once (the name a case-insensitive substring, as Playwright matches it), not with a query per
element. No two labels overlap: a draw adds every label hidden, reads their sizes in one layout, and `placeLabels`
(`label-layout.ts`, pure and unit-tested) puts each above its element or shifts it a row at a time below or above, clear of the labels
placed before it in page order; one with no free place within a few rows is left out, and the panel counts those. The
overlay redraws on scroll, scans again once the page has been still for a moment after a change to its
elements or to an attribute that can change a label (`observed-attributes.ts`, the list Tested elements follows too),
and bridges its labels to `globalThis.__piwiPlaywrightView` for `playwright-view.spec.ts`, which also checks the counts
against real Playwright.

## DevTools

`devtools_page` (`devtools.html`, `src/devtools/devtools.ts`) loads once per DevTools window and adds the **Piwi**
pane to the Elements panel (`devtools-sidebar.html`, `src/devtools/sidebar.ts`). DevTools pages are extension pages:
they have `chrome.scripting`, `chrome.permissions` and `chrome.storage` as well as `chrome.devtools`. Both pages
share `src/devtools/devtools.css` (DevTools' own look: 12px type, flat toolbars, the theme through the frame's color
scheme, a transparent background) and the helpers in `src/devtools/ui.ts` (buttons, empty states and their icons).
`button()` there is the shared `makeButton` (`src/shared/buttons.ts`: an icon from `src/shared/icons.ts` and a tone),
which `devtools.css` draws compact through its `data-tone` rules; a button of the HTML pages names its icon in
`data-icon` and its tone in `data-tone`. A step is drawn by `stepView`, an address by `urlView`, and a URL pattern or
a site's address by `patternView` (`src/shared/pattern-view.ts`), with `STEP_CSS` and `PATTERN_CSS` in the page's
style.

- **The selection reaches the ranking through `inspectedWindow.eval`.** The pane injects `devtools-rank.js` into the
  inspected tab (`src/devtools/selection.ts`) and calls `__piwiRankSelected($0)` with `useContentScriptContext`, so
  `$0` arrives in the extension's isolated world as the same element the engine finds. The answer is plain data
  (`src/shared/devtools-selection.ts`), the element's copy facts included. With an editor paired, the top locator's
  **Send to editor** sends it in the last copy mode through `src/shared/editor-send.ts`, as the Pick results do; the
  sidebar's copies set that mode too. Firefox has no `useContentScriptContext`: there `$0` is marked with an
  attribute in the page's world and the content script is asked by message (unverified in Firefox so far).
- **Access** is the tab's `activeTab` grant or the origin's optional host permission. When injection fails on a web
  page, the pane offers **Allow on this site**, which requests that one origin inside the click. Reading the page's
  origin with a plain `inspectedWindow.eval` needs no permission.
- **The Piwi panel** (`devtools-panel.html`, `src/devtools/panel.ts`, `panel-record.ts`, `panel-replay.ts`) mirrors
  the recording and the replay from session storage (`RECORDING_KEY`, `REPLAY_KEY`) and redraws on
  `chrome.storage.onChanged`, so it needs no channel of its own. Its buttons do what the in-page panels do: Stop is the
  popup's stop (`stopRecording` + `piwi-recording-stopped`); Pause, Continue and Stop write the replay state, then send
  `piwi-replay-wake` to the replayed site's tabs, which `replay-panel.ts` answers by redrawing its panel and, with
  `wake: true` (Next step, Stop), releasing its wait or keeping the wake for the next one; with `wake: 'waiting'`
  (Pause, Continue, as the in-page panel's own), releasing only a wait in progress.
- **Locators and Session** (`panel-locators.ts`, `panel-session.ts`): Locators calls the DevTools content script
  (`__piwiDevtools.query`, `highlight`, `mark`, through `src/devtools/page-script.ts`) and reveals a match by marking
  it with `data-piwi-devtools-reveal` (one element at a time), then running `inspect()` on it in the page's world, found
  in the document or an open shadow root, which needs no permission; a match that has left the page is said so.
  Enter evaluates at once and keeps the expression in the console's history (`src/shared/locator-console.ts`, under
  `LOCATOR_HISTORY_KEY` through `sessionArea()`, so it outlives the panel), which `HistoryCursor` walks with the arrow
  keys; the panel opened again shows the newest entry. A locator that reads gets Copy as (each copy mode, through one
  `renderCopyMode` call given the match count and the first match's facts, which the query answers), Add to session
  (`session-form.ts`) and, with an editor paired, Send to editor (`editor-send.ts`, a `locator` payload in the copy
  mode chosen last), each keeping the expression in the history too. The Session tab's page object and the Network tab's mock code have no Send to editor:
  the editor protocol (`@piwitests/core/editor-send`) takes a locator line or a steps document, and a block of code
  would need a kind of its own that the VS Code and JetBrains clients insert. Session reads the pick session
  (`SESSION_KEY`) and redraws when it changes. Add to session has one path, `addNamedPick` (`src/shared/session-add.ts`):
  it checks the name with `pickNameProblem`, appends `{ name, locator, pageUrl }` through `addSessionPick`, and answers
  the text the form shows for a refused name or a storage that failed. The DevTools pages (the Locators console, the
  Elements sidebar) open its form with `session-form.ts`; the Pick results (`results-panel.ts`) draw their own in their
  shadow root and call it after `ensureSessionAccess()`, as a content script must.
- **The page tools in the toolbar** (`panel.ts`, `runPageTool`): Pick, Lint, Tested elements and the Playwright view
  inject the popup's content scripts (`pick.js`, `lint-overlay.js`, `coverage-overlay.js`, `playwright-view.js`) into
  `inspectedWindow.tabId` with `injectContentScript`. A DevTools page holds no `activeTab` grant, so the click asks
  for the inspected origin (`requestSiteAccess`) before anything is awaited, from a pattern read ahead at open and on
  `onNavigated`; a site already granted answers without a prompt. Refused, the notice offers Allow on this site; any
  other failure says why (`injectionFailureText`). Tested elements is `aria-disabled` with the popup's words as its
  tooltip until an instance is connected and the inspected page resolves to a project (`resolveActiveProject`, read
  again on `piwiConnection`, the site's override and navigation). The panel sets `html[data-ready]` once the tools
  know the page.
- **Network and Mock this response** (`panel-network.ts`, pure half `src/shared/mock-code.ts`): requests come only
  from `chrome.devtools.network` (`getHAR` at open, then `onRequestFinished`), kept in the panel's memory, fetch and
  XHR only, and never leave the browser but through the user's copy or download. The list shows the inspected page's
  origin, read again when `onNavigated` reports a page on another. A body comes through `responseBody`: Chrome's
  `getContent` calls back, Firefox's returns a promise. `mockCode` hides credential fields
  (`HIDDEN_VALUE`) unless revealed, and never writes a header. `devtools-network.spec.ts` runs the copied code as a
  test body against a real page.
- **Slow down or fail a request** (`panel-conditions.ts`, pure half `src/shared/request-conditions.ts`): the panel asks
  for the page's origin inside the click and sends `piwi-set-conditions` with the requests' conditions, the whole
  page's network (`throttle`: fast 3G, slow 3G, offline) and CPU (`cpuRate`); the background worker sets them only on
  a tab that shows that origin, and keeps one tab's state in session storage (`CONDITIONS_KEY`). In Chrome and Edge (`via: 'debugger'`, `cdp-conditions.ts`) the
  `Fetch` domain pauses every request of the tab and delays, fails or answers it while the tab shows the conditions'
  origin, and `Network.emulateNetworkConditions` and `Emulation.setCPUThrottlingRate` throttle it; the Network tab's
  **Every kind** lists documents, scripts and images to put a condition on. Without the protocol, or once its bar is
  cancelled (`lost`, the throttling dropped), `via: 'page'`: `request-conditions-main.js` (main world) wraps `fetch`
  and XHR and, like the evidence script, imports nothing that touches `chrome.*`. It matches a relative URL as the
  browser resolves it (`document.baseURI`); a fetch it holds back rejects as soon as its signal aborts; an XHR it holds
  back counts its timeout from `send()`, gets `loadstart` from the wrapper only when it never goes out (the browser
  fires its own for one that does), and ends on the page's `abort()`, with the events the browser's own fires, its
  upload's included, or on a new `open()`, which also drops an answer it gave. Either way the worker registers
  `request-conditions.js` (isolated) for that origin at `document_start` (and the main-world script only with `page`),
  and injects them now. The isolated script asks `piwi-get-conditions` (answered for that tab only), posts to the main
  world by `window.postMessage` what the wrapper applies (`forPage`, none with the protocol) and draws the banner.
  Turning them off, or closing the tab, unregisters both and lets the session go, and turning them off reloads the tab.
  The Network tab's strip acts on the origin the conditions were set for, and once the page is on another, names it
  and offers Turn all off alone. A replay started meanwhile carries the requests' conditions (`ReplayState.conditions`) and its panel lists them.
  `request-conditions.spec.ts` drives both paths against a real server.
- **Open this page at a viewport** (**Viewport** in the panel's toolbar shows its bar, `src/devtools/panel-viewport.ts`;
  the inspected tab's address is read in the page, since a DevTools page holds no `activeTab` grant): the sizes are the active
  project's `viewports` from the cached locator index, or typed by hand; `piwi-open-viewport` in the background worker
  creates the window and grows it until the tab's `width`/`height` match. In a spec, measure the tab through
  `chrome.tabs`, not the page: Playwright emulates its own viewport in the pages it drives (`viewport.spec.ts`).
  **In this tab** (Chrome and Edge) sends `piwi-set-tab-viewport` instead: `Emulation.setDeviceMetricsOverride` on
  the tab, kept under `piwiTabViewport` for the bar to show with **Back to the window's size**
  (`piwi-clear-tab-viewport`).
- **Tests**: `devtools-sidebar.spec.ts`, `devtools-panel.spec.ts` and `devtools-network.spec.ts` open the pages as tabs with `chrome.devtools` stubbed (`devtools-stub.ts`:
  `eval` runs in a fixture page's own world, where the spec adds the content script; `$0` is that page's global).
  `devtools-replay.spec.ts` opens the Piwi panel the same way beside a replay of the real extension on a local site
  (`trusted-site.ts`), and checks that Pause and Continue from the panel never play a step waiting for Next.
  `devtools-real.spec.ts` launches Chromium with `--auto-open-devtools-for-tabs` and drives the real DevTools page
  through the browser's debugging port: it checks the `devtools_page` loads and that `$0` reaches the ranking script.

## Content-script structure

Each standalone content-script feature (multi-pick, lint overlay, assertion suggester, agent
context, recording, try-it scanning, …) is split into a pure
logic file (e.g. `lint-scan.ts`, `assertion-suggest.ts`, `session-export.ts`,
`record-capture.ts`, `test-function-scan.ts`) and a separate entry-point/UI file (e.g.
`lint-overlay.ts`, `assertion-panel.ts`,
`session-panel.ts`, `record-panel.ts`) that wires picking, DOM, and `chrome.*` calls around
it. Keep new features on this split rather than mixing pure logic into the entry point —
it's what makes the logic half plain-unit-testable (or real-bundle-testable, see below)
instead of needing a live browser for everything.

**Every surface on the page gets its shadow root from `attachPanelShadow`** (`src/content/panel-root.ts`). It keeps
key and clipboard events inside, makes `[hidden]` win over the surface's own `display`, and keeps the surface usable
above a modal dialog the page opened: the dialog sits in the top layer and makes the rest of the page inert, so while
one is open the surface lives at its end, and goes back to the document's root element when it closes or leaves the
page. A popover surface (the Tested elements overlay) and a dialog that lays out `position: fixed` children in its own
box (a `transform`, a `filter`, containment) are left alone. `picker-dom`'s overlay and anchors step mount inside an
open modal dialog the same way. `modal-dialog.spec.ts` covers it.

**A panel over the page with a backdrop is modal through `holdFocus`** (`src/content/modal-panel.ts`): `aria-modal`,
the focus on its first control, Tab kept inside, and the focus given back as it closes (the pick results, multi-pick,
Assertions, Context for an AI agent, Test functions). **A panel that leaves the page usable is a landmark, not a
dialog**: `role="region"` with its translated name as `aria-label`, and a close button with an accessible name (the
lint overlay, the Playwright view, the Tested elements panel). **A copy button goes through `copyWithFeedback`**
(`src/shared/clipboard.ts`, extension pages too): the copy command when the clipboard API refuses, Copied or Not copied
for a moment, and the button's own label back however often it is clicked. A bar that stays on the page beside it (the recording
bar, the bug report bar) is `role="region"` with a translated `aria-label`, never a dialog, and anything it animates
stops under `prefers-reduced-motion: reduce`.

**The Action and Assertion copy modes write what the element calls for.** `renderCopyMode`
(`src/shared/copy-modes.ts`) stays pure: it takes the locator and `ElementFacts`, plain data read from the element
where it is at hand (`elementFacts`, `src/content/element-facts.ts`): `fill` with the field's value (a placeholder
for an empty field or one `isSensitiveField` masks), `check`, `selectOption`, else `click`; and the first of
`assertionsFor` (`assertion-suggest.ts`, the Assertions dialog's own list). A locator finding several elements asserts
`toHaveCount`. The in-page panels pass the facts to `copyModeButtons` (`copy-mode-row.ts`, `copyFacts`); the Elements
sidebar gets them in the ranking `devtools-rank.ts` answers. Each button names the method it writes, "Action (fill)".

## Buttons, icons and readable steps

Every surface (the in-page panels, the popup, the settings, Save login, DevTools) is built the same way, so a button is
found by its icon and its color before its words are read, and a step reads at a glance:

- **Every button has an icon** from `src/shared/icons.ts` (`ICONS`: outline glyphs on a 24 × 24 grid, drawn in
  `currentColor`, built as DOM so no page's policy can block them) in front of its label. An icon-only button (a
  panel's close ×) carries its label as `aria-label` and tooltip. A new icon goes into `ICONS` in the same style,
  its box centered on the grid (`icons.spec.ts` measures every glyph); never SVG markup written elsewhere, an icon font
  or an image. An icon lands on whole pixels: its size is even (16 in a button, 14 in a small one and in a step badge)
  and so is what is left of its box around it, a row it sits in with text having a line height in whole pixels.
- **A button is made by `makeButton(label, onClick, { icon, tone, small, iconOnly, title, className })`**, or given
  the same look by `styleButton` when made elsewhere (a link included), from `src/shared/buttons.ts`, and styled by
  `BUTTON_CSS` in the panel's `<style>`: a panel does not style its own buttons. An HTML page names the icon in
  `data-icon` (and the tone in `data-tone`) and calls `decorateIcons()` after `localizeDocument()`, which writes the
  texts.
- **The tone says what a button does:** `primary` (violet), the surface's main action, one per group; `success`
  (green), what completes or goes on with a flow (Finish, I did it, continue); `danger` (solid red), what stops what
  runs (Stop); `remove` (red text), what discards or takes away (Discard, Remove, Unpair, Disconnect), set apart at the
  end of its row; `neutral`, any other, its icon in the accent color; `ghost`, a close button or a small inline action.
- **A verdict, a warning or a status line leads with its icon** (`check-circle`, `alert`, `x-circle`…) in its color,
  and a count is a badge.
- **A label changes through `setLabel`**, never `textContent`, which drops the icon. A copy goes through
  `copyWithFeedback` (and a passing text through `flashLabel`), which keeps the icon and flashes a check or a cross.
- **A step is shown by `stepView(step)`** (`src/shared/step-view.ts`, its look in `STEP_CSS`): a badge by kind of
  action (going somewhere, acting, typing or choosing, checking, by hand) and its words with the quoted names, the typed
  value, the key, the test ids, the addresses and the locators set apart. The parts come from core's
  `describeStepInParts`, which knows each one as the phrasebook writes the sentence; never read them back out of
  `describeStepInWords`, nor show it as bare text or with its backticks stripped (a plain caption joins the parts'
  texts). A sentence that is no step and names a locator, an address or a quoted text (why a step failed, a verdict)
  goes through `richText` (`sentence-tokens.ts`, unit-tested), an address alone through `urlView` (origin and query
  dimmed, path in front), a URL pattern or a site through `patternView` (`src/shared/pattern-view.ts`, its wildcards
  set apart).
- **Colors are dark first, with the light scheme's under `prefers-color-scheme: light`**, as custom properties set on
  the surface's root; a surface dark in both schemes puts `piwi-dark` on an ancestor.

## Rules

- **No network call from a content script, ever.** Picking/recording talk to no server.
  Connected mode (see above) is opt-in, off by default, confined to `src/options/` and the
  background worker (`piwi-client.ts`). It never sends a recording or anything read from a
  page except a bug report the user sends from its preview. Any other feature that wants to
  *send* recorded data needs the same explicit-opt-in, clearly-separated treatment, plus a
  payload preview before the first send.
- **Content scripts are separately-bundled IIFEs, not ES modules.** `scripts/build.mjs`
  builds each one with Vite's library mode specifically so `chrome.scripting.executeScript`
  (or a `registerContentScripts` registration, for `record-panel.ts`) can inject it as a plain
  script. Don't add a shared runtime chunk between them — each must stay self-contained at the
  bundle level (imports are fine at the *source* level; Vite inlines them per entry).
- **Never widen *standing* permissions casually.** `activeTab`/`debugger`/`scripting`/`storage` plus the
  recorder's one-origin-at-a-time optional host permission cover everything today. A feature
  that seems to need more (`contextMenus`, `sidePanel`, a broader or default-granted
  host permission) needs a deliberate call, not a silent addition. `debugger` was one (see "The debugging
  protocol"): a new use of it follows its rules — attached only while the feature runs, released at once, a
  fallback that works without it, and nothing read through it sent anywhere unless the person sends it.
- **The recorder's host permission is requested per-origin, per-recording, from the popup's
  own click handler — never pre-granted, never `<all_urls>`.** `chrome.permissions.request`
  only counts as satisfying a user gesture when called synchronously inside one, so this can't
  move into `background/index.ts` (see `src/popup/main.ts`'s `startRecordingFlow`). But the
  prompt that request shows *takes focus and closes the popup on a first-time grant*, killing
  the code that would have messaged the worker to start — which is why a first recording used
  to need a second click. So the popup parks a `RecordIntent` (origin + tab, in session
  storage) inside that same click, and the worker's `chrome.permissions.onAdded` picks it back
  up when the grant lands and starts the recording itself. Both starts (the popup's own message
  when it *does* survive, and the `onAdded` fallback) funnel through `startRecordingOnce`, which
  dedupes; `decideRecordIntent` (pure, unit-tested) is what keeps the fallback from firing on an
  unrelated grant — the options page granting the instance origin fires the same event — or on a
  stale intent. A Deny reaches no code, so the popup opening again clears the intent, and so does
  each DevTools request for a site (`requestSiteAccess`, right after the request call): the next
  grant of that origin is not the recording's. `record-intent.spec.ts` grants the site from
  `chrome://extensions`, which fires the real `onAdded`. Recording covers the one origin granted
  at start; navigating to a different
  origin mid-recording is a known, documented limit (see `apps/docs/extension.md`), not a silent gap
  — a future phase could detect it and prompt to expand, but that also needs a fresh user
  gesture, which the HUD (a content script, no `chrome.permissions` access) can't provide on its
  own either.
- **Every text the extension shows comes from the catalogs** (`public/_locales/<code>/messages.json`) through `t()` /
  `tn()` / `tNodes()` in `src/shared/i18n.ts`; `popup.html` and `options.html` name their keys in `data-i18n*`
  attributes, which `localizeDocument()` fills. A page or script calls `await initI18n()` once before its first text,
  for the Language setting's override. A new message goes into every catalog in the same change, English with a
  `description` — see `i18n/README.md` for the rules `locales.test.ts` enforces. `no-hardcoded-text.test.ts` fails on
  text written straight into the UI, in every file of `src/`. Translated text reaches the page as text (`textContent`,
  `tNodes`) or through an escape helper, never as raw HTML. A content script that paints on injection ends with
  `void initI18n().then(start)` (bundles are IIFEs, no top-level await), or runs `initI18n()` beside the storage reads
  it already awaits, and each panel sets `lang` from `uiLanguage()` on its root inside the shadow DOM.
- Reuse `@piwitests/picker-dom`'s exports (`installPickerOverlay`, `showAnchorPicker`,
  probe, role-resolution, syntax highlighting) rather than re-deriving picker logic here —
  that package exists so this workspace doesn't become a third hand-synced copy. Its texts are English unless the
  host gives them: pass `strings: pickerOverlayStrings()` / `anchorPickerStrings()` (`src/content/picker-strings.ts`,
  from the catalogs) once `initI18n()` has run.
- **A locator is always rendered through `highlightLocator`, inside a `.piwi-loc` element,
  in a panel whose `<style>` includes `LOCATOR_SYNTAX_CSS`** — never as bare `textContent`.
  The token colors live in that stylesheet (dark-first, with a light-scheme override) because
  a panel that flips to a white background needs a different palette, which inline colors
  can't express. A chip that stays dark in both schemes — anything floating over the page
  rather than sitting in a panel — adds `piwi-loc-dark` to opt out of the light override.
  Panel text carrying a verdict or accent color (`.verdict`, `.score`, `.unique`, `.warn`, …)
  needs its own `@media (prefers-color-scheme: light)` entry for the same reason.
- **`chrome.storage.session` needs `setAccessLevel` to be reachable from a content script.**
  It defaults to extension-page/service-worker-only access; `src/background/index.ts` widens
  it once at startup (`TRUSTED_AND_UNTRUSTED_CONTEXTS`) specifically so `recording-storage.ts`
  and the replay can read/write it directly from a content script — in Chrome. Firefox
  has no such call, which is why every access goes through `sessionArea()` (see above).
  `chrome.storage.local` (connection settings, the catalog cache) has no such restriction, which is why no secret goes
  there: the API key and the tokens are in the extension's IndexedDB (see "Connected mode").
- **Two different test strategies for content-script logic, pick deliberately.** A function
  built entirely from nested helpers with no imports from `@piwitests/core`'s scoring engine
  (`derivePattern`, `repeatedContainers`, `testCatalogAgainstPage`) can be re-serialized via
  `Function.prototype.toString()` in tests, installing any genuine cross-module dependency as
  a global first. A function that calls `generateAlternatives` (`scanForLintIssues`,
  `suggestAssertions`, `buildAgentContext`, `record-panel.ts`'s `deriveRecordedTarget`) can't
  — that function's own private module-level helpers don't survive reconstruction and aren't
  exported individually. Those are tested by driving the real built bundle
  (`page.addScriptTag`), either reading a well-known `globalThis.__piwiXxx` the entry-point
  bridges a result out to (`lint-overlay.ts`, `assertion-panel.ts`, `agent-context-panel.ts`)
  or, for anything backed by `chrome.storage` (`record-panel.ts`), reading state back out of
  a stubbed `chrome.storage` installed via `context.addInitScript` (see `record.spec.ts`) —
  don't reach for reconstruction if the
  feature touches `generateAlternatives` or `chrome.*`.
- **`record.spec.ts`'s cross-page test stubs `chrome.storage` on top of `window.name`, not a
  plain in-memory object.** `context.addInitScript` re-runs on every new document, which would
  reset an in-memory stub on each navigation; `window.name` is one of the few things a real
  browser tab preserves across a same-tab navigation (even cross-origin), so it's the only way
  to fake "storage that survives navigating to the next page" without a real extension
  permission grant in the test.

## Commands

| Command | Purpose |
|---|---|
| `npm run extension:build` | Build `dist/` (content scripts, background, popup, options page, manifest, icons, `_locales`) |
| `npm run extension:dev` | Same build, re-run on every change to `src/`, `public/`, the HTML pages, `manifest.json`, `scripts/build.mjs`, or the `src/` and `package.json` of `packages/core` and `packages/picker-dom` (bundled from source) |
| `npm run extension:build -- --pseudo` | Same build with a pseudo-localized English catalog, to spot text that bypasses `t()` or clips (never released) |
| `npm run extension:build:release` | Reproducible build: stamps the version instead of the build time into every bundle |
| `npm run extension:zip` | Release build, then the store-ready zip, the source zip Firefox AMO requires, and the AMO listing metadata (see `PUBLISHING.md`) |
| `npm run extension:typecheck` | TypeScript check |
| `npm run extension:lint` / `extension:lint:fix` | oxlint |
| `npm run extension:format` / `extension:format:check` | oxfmt |
| `npm run extension:test` | Unit tests (Vitest) — pure logic only |
| `npm run extension:test:e2e` | Builds, then drives the real built extension with Playwright (`--load-extension`) |
| `npm run extension:lab` | The replay lab: records scenarios on a running Piwi dashboard with the real extension, replays them with the extension and as Playwright specs, and prints the comparison (see `tests/lab/README.md`; not part of CI) |

## Loading it locally

`npm run extension:build`, then in Chrome/Edge: `chrome://extensions` → enable Developer
mode → Load unpacked → select `apps/extension/dist`.

While iterating, use `npm run extension:dev` instead — it rebuilds on save. The browser
still needs a manual reload on the `chrome://extensions` card to pick up a new build (MV3
gives no way to trigger that from outside the browser), so the loop is: save → wait for the
rebuild line → click reload.

`scripts/dev.mjs` guards against two runaway cases; keep both. It rebuilds only when a watched
path's mtime or size differs from when the last build started: on Windows `fs.watch` also reports
access-time changes, so the build's own reads used to start the next build, and one save rebuilt
until the process ran out of memory. And each build runs in a child process (`node
scripts/build.mjs`), because Vite keeps memory from every build run in one process (several MB a
rebuild, never released).

Until that reload, the popup and every tool opened come from the new build, read from disk
each time, while the background worker still runs the build that was loaded — so a message
only the new build knows goes unanswered. Every bundle carries a build stamp
(`src/shared/build-id.ts`, set by `scripts/build.mjs`) and `piwi-ping` answers with the
worker's: when the two differ, the popup shows a notice with a **Reload Piwi Picker** button
(`chrome.runtime.reload()`), and a tool reports an unanswered message as that cause
(`OUTDATED_WORKER_MESSAGE`, `src/shared/worker-status.ts`) rather than as a generic failure.
`worker-build.spec.ts` covers it end to end; like any spec that reloads the extension, it
launches with Developer mode on (`launchWithExtension(path, { developerMode: true })`), since
Chromium enables a reloaded unpacked extension again only then.

Disable the Chrome Web Store copy while a local build is loaded — two installs both claim the
`Ctrl+Shift+E` command, and only one of them gets it, which reads as "my change didn't apply".
