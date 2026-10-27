# Piwi Picker: architecture

How each part of the browser extension works: flows, storage keys, worker messages and the tests that cover them. This
file is reference material, read on demand. The rules to follow before editing anything under `apps/extension/` are in
[`AGENTS.md`](AGENTS.md), and each rule there names the section below that explains it.

Piwi Picker is a browser extension for Chrome, Edge and Firefox (Manifest V3). It reuses the monorepo's locator engine
(`@piwitests/core`) and shared picker overlay (`@piwitests/picker-dom`) to pick ranked, stable Playwright locators from
the live page.

- **Standalone by default.** Picking and recording need no server. The standing permissions are `activeTab`,
  `scripting` and `storage`, plus `debugger`, attached on demand (see "The debugging protocol"). Recording also asks for
  one origin at a time through `optional_host_permissions`.
- **Connected mode is opt-in.** Connecting to a Piwi instance adds what needs a project's history: matching a recording
  against the project's function catalog, and showing which elements of the page its tests reach. See "Connected mode"
  and "Tested elements".

Where it is published:

- on the Chrome Web Store, as
  [Piwi Picker](https://chromewebstore.google.com/detail/piwi-picker/pakhnokpjboejcghgcmkjlpnogfjihhe)
  (`pakhnokpjboejcghgcmkjlpnogfjihhe`), the listing Chrome _and_ Edge users install from;
- on Firefox Add-ons (AMO), as [Piwi Picker](https://addons.mozilla.org/firefox/addon/piwi-picker/)
  (`picker@piwitests.dev`).

Each release tag packages it in CI (`.github/workflows/reusable-publish-extension.yml`). The run keeps the store zips as
its artifacts and submits them to every store whose secrets are configured. `PUBLISHING.md` has the release loop, the
secrets, and the Edge Add-ons listing that is still outstanding.

Terms used in this file:

- **The worker**: the background service worker (`src/background/`). In Firefox, which has no extension service
  workers, the same bundle runs as a background script.
- **An extension page**: a page served from the extension's own origin: the popup, the settings page, Save login, the
  DevTools pages.
- **A content script**: a script the extension runs in a web page, in the extension's _isolated world_ (its own
  JavaScript context beside the page's). A **main-world script** runs in the page's own JavaScript context instead.
- **Session storage**: `chrome.storage.session`, emptied when the browser closes.
- **The instance**: the Piwi dashboard the extension is connected to.
- **A grant**: a host permission the user gave for one origin.

## Contents

- [What it is](#what-it-is): the manifest and its permissions, what each `src/` folder holds, how content scripts are
  injected, the popup and the settings page, how a tool claims the page (`tool-session.ts`), and how content scripts
  reach session storage.
- [The debugging protocol](#the-debugging-protocol): when the worker attaches `chrome.debugger`, for which feature, how
  a viewport is emulated, and the fallback without it.
  - [A replay belongs to one tab](#a-replay-belongs-to-one-tab): which tab plays a replay, and how a replay follows a
    step into a new tab.
  - [How a replay finds a step's element](#how-a-replay-finds-a-steps-element): voting between the recorded locators,
    waits and timeouts, and the steps handed to the person.
  - [Trusted input in a replay](#trusted-input-in-a-replay): input sent through the debugging protocol, file steps, and
    the page-event fallback.
- [Connected mode](#connected-mode): connecting to an instance, where secrets are kept, the instance marker, project
  mappings and the active project, what is read and what is sent, the desktop app, Share result, the requests and who
  makes them, connection health, cache freshness, host permissions for the instance, and the Test functions panel.
- [Tested elements](#tested-elements): the locator index evaluated on the page, the in-page locator engine, and the At
  risk list.
- [Naming and ranking an element](#naming-and-ranking-an-element): accessible names, ranking, checking and narrowing
  candidates, multi-pick, lint, verdict words, the hover cost, and where a new naming case is tested.
- [Checks in a test recording](#checks-in-a-test-recording): Check an element and Check the address, Pause, Replay
  from the review panel, and the recording's title.
- [Report a bug](#report-a-bug): bug recordings, the `.piwibug` archive, step screenshots, steps handed to the person,
  evidence through the debugging protocol, and screenshots without it.
  - [The main-world evidence script](#the-main-world-evidence-script): what `bug-evidence-main.ts` may and may not do,
    in a bug recording and in a replay.
- [Files, double clicks and drags](#files-double-clicks-and-drags): how the recorder records them.
- [The recording bar's corner](#the-recording-bars-corner): the Move button and the stored corner.
- [What a click lands on, and pages reached without one](#what-a-click-lands-on-and-pages-reached-without-one): the
  element a press records, and navigations through Back, Forward or a reload.
- [Hovers a click depends on](#hovers-a-click-depends-on): finding the hovers a click needs while recording, and
  emulating them in a replay.
- [The IDE bundle](#the-ide-bundle): the recorder built for the editor service, its host, and its tests.
- [Playwright view](#playwright-view): the overlay that labels each element with its role, name and test id.
- [DevTools](#devtools): the Elements pane and the Piwi panel (recording and replay, Locators, Session, page tools,
  Network, request conditions, viewport) and how they are tested.
- [Content-script structure](#content-script-structure): the split between pure logic and entry files, shadow roots,
  modal panels and landmarks, and the copy modes.
- [Buttons, icons and readable steps](#buttons-icons-and-readable-steps): icons, buttons and their tones, labels, how a
  step or an address is shown, and colors.
- [Rules, with their reasons](#rules-with-their-reasons): the long form of several rules in `AGENTS.md`: bundling, the
  recording's permission request, translations, reusing `picker-dom`, locator rendering, session storage access, and
  the two test strategies with the `window.name` storage stub.
- [Loading it locally](#loading-it-locally): the dev watcher's guards and the worker's build stamp.

## What it is

### The manifest and its permissions

`manifest.json` is the MV3 manifest. `scripts/build.mjs` writes two builds from it: `dist/` for Chrome and Edge
(`chromiumManifest`) and `dist-firefox/` for Firefox (`firefoxManifest`).

- **Standing permissions**: `activeTab`, `debugger`, `scripting` and `storage`. There is no static host permission, no
  `<all_urls>` and no remote code. Adding a standing permission is a deliberate, reviewed decision, never a default.
- **`debugger`** is in the Chromium manifest only. `firefoxManifest` leaves it out of `dist-firefox/`, and
  `build-manifests.test.ts` checks it.
- **`minimum_chrome_version`** (118) is Chromium-only too. From that version Chrome keeps the worker running while a
  debugging session is attached. That matters because the sessions' state (`debugger.ts`, `cdp-*.ts`, `step-views.ts`)
  lives in the worker's memory.
- **`optional_host_permissions`** (`http://*/*`, `https://*/*`) is declared but **grants nothing by default**. The popup
  requests a single origin (`https://<the-recorded-site>/*`, built by `hostPattern`) with `chrome.permissions.request`,
  inside the click on **Record actions**, **Report a bug** or **Replay a bug report**. The settings page and the
  DevTools pages request the origins they need the same way, inside a click (see "Connected mode" and "DevTools").
- **`optional_permissions`** holds `cookies` alone, granted nothing at install. Only Save login for tests asks for it
  (below).
- **`browser_specific_settings.gecko.id`** is Firefox's required, stable add-on ID; Chromium ignores the key. Never
  change it: the add-on is published on AMO under it, and a new ID creates a separate add-on rather than an update,
  orphaning existing installs.
- **`background`** names `background.js` twice: as `service_worker` (Chrome) and as `scripts` (Firefox, which has no
  extension service workers; AMO rejects the manifest without it). The build writes `dist/` without `scripts`, which
  Edge lists as an error, and `dist-firefox/` with it.
- **`gecko.data_collection_permissions`** is `{ "required": ["none"] }`. That holds only while nothing goes anywhere but
  the user's own instance, the editor paired on the same computer (Send to editor) and the desktop app paired on the
  loopback address (Run with Playwright). See `PUBLISHING.md` §4.
- **The manifest's `description` and the shortcut's label** are `__MSG_*__` strings, translated in `public/_locales/`:
  English (the default), French, and German, Spanish and Brazilian Portuguese as drafts. The description doubles as the
  store listings' summary, so it stays within 132 characters in every language (`store-listing.test.ts`). The rest of
  the Firefox listing lives in `store/` (`PUBLISHING.md` §4 c): a new language needs both.

**Save login for tests** (`login.html`, `src/login/main.ts`, pure half `src/shared/storage-state.ts`) opens from the
DevTools panel's toolbar for the inspected tab:

1. Its **Save login file** click requests `cookies`, with host patterns for the site (`cookieOriginPatterns`): its host
   for both schemes and any port, and its parent domains, since Chrome checks each cookie by its domain alone.
2. It reads that site's cookies and `localStorage` once, and downloads them as Playwright's `storageState` file.
3. Nothing is kept or sent. Nothing is saved once the tab shows another origin than the one the page was opened for.

`save-login.spec.ts` loads the file into a new browser context and checks that it logs in.

### What each folder holds

- `src/content/`: the content scripts. Each one is a standalone entry, injected on demand (see "How content scripts are
  injected").
- `src/background/`: the worker. It handles:
  - the `chrome.commands` keyboard shortcut (the toolbar icon opens the popup instead, which injects content scripts
    itself);
  - the recorder's start and stop messages (`piwi-start-recording`, `piwi-recording-stopped`), and the
    `chrome.permissions.onAdded` fallback that starts a recording when the grant prompt closed the popup (see "Rules,
    with their reasons");
  - every `chrome.scripting.registerContentScripts` / `unregisterContentScripts` call and every `chrome.action.*` call,
    since content scripts can reach neither API;
  - the requests to the instance, the desktop app and the editor (see "Connected mode"), and the debugging sessions
    (see "The debugging protocol").

  Some messages name a tab or an address for the worker to act on, and only the extension's own pages send them:
  starting a recording, the viewport messages, setting request conditions, and the language (`EXTENSION_PAGE_MESSAGES`
  in `index.ts`). The worker refuses them from anything else (`fromExtensionPage`, `senders.ts`).

- `src/popup/`: the toolbar popup (see "The popup").
- `src/options/` and `options.html`: the settings page (see "The settings page").
- `src/login/` and `login.html`: Save login for tests (above).
- `src/devtools/`: the Elements pane and the Piwi panel (see "DevTools").
- `src/shared/`: code shared by all of the above.
- `src/ide/`: the entry and the host of the IDE bundle, the recorder built for the editor service (see "The IDE
  bundle"). Nothing in the extension loads it.

### How content scripts are injected

Most content scripts are injected with `chrome.scripting.executeScript({ files: [...] })`: from the popup, from the
DevTools panel's toolbar, and from the worker (the pick shortcut, and Tested elements opened from the pick results).

- Never `<all_urls>` static injection.
- Never the `func:` form, which stringifies a function and injects it. A file injection can import `@piwitests/core`
  and `@piwitests/picker-dom` directly, since nothing has to survive `Function.prototype.toString()` here, unlike the
  reporter's and the dashboard's pickers. `func:` appears only for two self-contained reads that import nothing: the
  popup's check of which tool runs in the tab, and Save login's `localStorage` read.

Other scripts are registered by the worker with `chrome.scripting.registerContentScripts`, scoped to one granted origin
and with `persistAcrossSessions: false` (the instance marker apart). A registered script runs again on every page of
that origin for as long as its feature runs. The worker also injects most of them into the pages already open: the
tab a recording or request conditions start in, the instance's open tabs, and, for a replay, the evidence script (the
replay's panel only when the start message asks, `inject`).

| Script                       | World    | Registered while                                         | Id                     |
| ---------------------------- | -------- | -------------------------------------------------------- | ---------------------- |
| `record-panel.js`            | isolated | a recording runs                                         | `piwi-record-panel`    |
| `bug-evidence-main.js`       | main     | a bug recording runs                                     | `piwi-bug-evidence`    |
| `replay-panel.js`            | isolated | a replay runs                                            | `piwi-replay-panel`    |
| `bug-evidence-main.js`       | main     | a replay runs                                            | `piwi-replay-evidence` |
| `request-conditions.js`      | isolated | request conditions are on                                | `piwi-conditions`      |
| `request-conditions-main.js` | main     | request conditions go through the page (`via: 'page'`)   | `piwi-conditions-main` |
| `instance-marker.js`         | isolated | an instance is connected and its origin granted          | `piwi-instance-marker` |

The ids of the recording, the replay and the request conditions are in `src/background/index.ts`, the marker's in
`src/background/instance-marker.ts`. A page the browser restores from its back/forward cache runs no script again: the
recorder attaches there on `pageshow` (`persisted`), or lets go of the page when the recording ended meanwhile.

### The popup

`src/popup/` holds the toolbar popup: plain TypeScript and DOM, no UI framework. Keep it that way unless the popup's
own complexity genuinely outgrows it.

- It holds the tools that act on the page, for testers and developers alike: **Record actions** and **Pick an element**
  first, then **Report a bug** and **Replay a bug report**, **Tested elements**, and the other page tools as compact
  tiles under **More tools**.
- Every tile shows its one-line hint under its label, never only as a tooltip (`popup.spec.ts` checks the compact
  tiles).
- The developer tools that have a home in DevTools are there, not here (see "DevTools"). Pick, Lint and Tested elements
  are also in the Piwi panel's toolbar. The popup ends with a line saying so.
- A gear button opens the settings (`chrome.runtime.openOptionsPage()`).
- Once connected, an **Active project** select shows which mapped project applies to the current tab's site, and
  overrides it. The connection's line sits under it (`#connection-health`, see "Connection health").
- **It must fit Chrome's 600-pixel popup height** in every shipped language; German is the longest. `popup.spec.ts`
  measures the connected popup in English, German, French, Spanish and Brazilian Portuguese. A new tile goes under More
  tools or into DevTools rather than below the fold.

### The settings page

`src/options/` and `options.html` hold the settings page, built the same way as the popup. It has one card per
setting. Each card has its own actions, its own status line (`#language-status`, `#status`, `#mappings-status`,
`#desktop-status`, `#editor-status`, `#site-access-status`) and, where it applies, a badge saying whether it is
connected or paired. The cards:

- **Language**.
- **Connect to Piwi**: the instance URL, with a pill saying how the instance answered its last request
  (`#instance-health`); a **Connect** button below it, which runs an RFC 8628 device authorization; a folded **Use an
  API key instead** with its own **Save and test**; **Disconnect**.
- **Project mappings**, shown once an instance is kept:
  - the instance's URL patterns, read-only, marked **Piwi**;
  - the patterns kept in this browser, a table whose **Save** keeps only them;
  - a folded **Add a site** form.
- **Desktop app** (see "The desktop app").
- **Send to editor**.
- **Sites Piwi Picker may run on**: every host permission granted (`chrome.permissions.getAll`), each with a **Revoke**
  button. The list is redrawn on `chrome.permissions.onAdded` / `onRemoved` and when the recording's or the replay's
  state changes. `site-grants.ts` (pure) keeps the site of a running recording or replay, and the origins the instance
  and the pairings hold, which Disconnect and Unpair give back.

How the page is opened:

- with `chrome.runtime.openOptionsPage()`: the popup's gear, or the worker answering `piwi-open-options` for a content
  script, which never links to the page itself;
- as `options.html#add=<pattern>` from the popup's **Add this site**, which opens the Add a site form filled in. While
  the form waits for a first sync of the instance's projects, the pattern shows as a line of this browser.

`main.ts` awaits the language catalog and the stored settings before it attaches a listener, then sets
`html[data-ready]`. An e2e spec opens the page with `openOptions` (`tests/e2e/fixtures.ts`) and, after a `reload()`,
calls `optionsReady` before it clicks anything.

### How a tool claims the page

A **momentary tool** is a tool the person runs once on the page (Pick, Multi-pick, Assertions, Lint, Tested elements
and the others), as opposed to the recorder. It must claim the page through `src/shared/tool-session.ts`:

1. `startTool(id, teardown)` on entry, before it mounts anything. Starting a tool tears down its predecessor: the
   predecessor's teardown runs inside that call.
2. Every panel or wait the tool opens is tied to it with `bindToTool(epoch, close)` (`waitForGlobal` is one). A
   teardown then settles the promise the tool's flow awaits, rather than stranding it for the life of the page.
3. The flow checks `toolIsCurrent(epoch)` after each `await`. Once it is not current, it leaves the picker overlay and
   the pick globals to its successor.
4. `endTool(epoch)` when it finishes.

More behavior of the tool session:

- Escape cancels the current tool, and the page does not see that Escape. During the anchors step of a pick, Escape is
  that step's Skip, not a cancel.
- A pick-driven tool injected again while it runs leaves itself be (`isToolActive`); any other tool replaces it.
- The pick-driven tools tear down with `teardownToolSurfaces`. The picking overlay and the anchors step go, listeners
  included; `__piwiPickState` / `__piwiAnchorState` are answered for a flow that waits on them; no other surface on the
  page is touched.
- The bug recorder's **Mark what's wrong** claims the page as `pick` for its pick alone, so a Pick started meanwhile
  leaves it be.
- The Pick results' **Pick another** picks again inside the same tool session (`runPick` runs `pickOne` again on the
  `pick-another` outcome), so it neither starts a tool nor ends one.
- While the Pick results are open, they draw a ring around the picked element (`spotlight` in `results-panel.ts`). The
  ring lives inside their own shadow root and goes with it. It is drawn again on a scroll (heard in the capture phase),
  a resize, or a size change of the element or the panel (`ResizeObserver`), never in a frame loop.

The recorder deliberately stays outside the tool session. It is a capture mode, and stopping it because another panel
opened would discard a recording in progress.

### Session storage from a content script

Two rules come from browser differences:

- **`ensureSessionAccess()` first** (`src/shared/session-access.ts`). In Chrome, a content script can use session
  storage only once the worker has widened its access level (`setAccessLevel`, `TRUSTED_AND_UNTRUSTED_CONTEXTS`). The
  worker does that at startup, but it is torn down when idle. So a script injected at `document_start` can run before
  the widening applies, and the read _throws_ rather than returning empty. The helper pings the worker (`piwi-ping`),
  which both wakes it and withholds its reply until the widening resolves. Skipping this is what made the recorder's
  HUD appear only sometimes.
- **Session storage goes through `sessionArea()`** (`src/shared/session-area.ts`), never `chrome.storage.session`
  directly. Firefox has no `setAccessLevel` and no session storage in content scripts at all. There, `sessionArea()`
  sends each get, set and remove to the background script (`piwi-session-storage`). A module reaching
  `chrome.storage.session` itself works in Chrome and breaks only in Firefox, which no CI run exercises.

While a recording runs, its events are appended and its Pause and title changed only through two functions of
`recording-storage.ts`, which queue each change so that no append is lost (starting, stopping and discarding it write
the state directly):

- `appendRecordingEvent` adds a captured event. In a Firefox content script each event goes as one
  `piwi-append-recording-event` message, so a click that navigates away is not lost between a read and a write.
- `updateRecording(startedAt, change)` applies Pause and the title. In a Firefox content script each change goes as one
  `piwi-update-recording` message, which the worker applies through the same queue as the appends. A change read and
  written back over two messages would drop an append the worker finished in between.

## The debugging protocol

The Chrome DevTools Protocol, through `chrome.debugger`, in Chrome and Edge only. It is used on demand since 2026-09-28.
Chrome does not let `debugger` be an optional permission, so it is a required one, and Chrome shows "Piwi Picker
started debugging this browser" while a session is attached. The rules that follow from it:

**Attach only while a feature the person started needs it, and detach the moment it ends.** Every session goes through
`src/background/debugger.ts`:

- `acquireDebugger(tabId, purpose)` attaches once per tab;
- `releaseDebugger(tabId, purpose)` detaches when no purpose holds the tab any more.

The purposes (`DebugPurpose`):

| Purpose      | Feature                                                       | Holds the tab                                          |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------------ |
| `replay`     | a replay's trusted input (`cdp-replay.ts`)                    | from the replay's first page until it lets go (below)  |
| `bug`        | a bug recording's evidence (`cdp-evidence.ts`)                | the report's first tab, until it stops or is discarded |
| `conditions` | the DevTools panel's request conditions (`cdp-conditions.ts`) | while any condition or throttling is on                |
| `viewport`   | a viewport set from the DevTools panel (`cdp-conditions.ts`)  | until **Back to the window's size**, or the tab closes |

The replay's session:

- attaches on the replay's first page, when that page asks for its driver;
- is let go by `piwi-replay-finished`, a new replay, a command the browser refuses (the replay goes on with the page's
  events), or the tab leaving the replay's origin. The worker hears that last one from `Page.frameNavigated`, which the
  protocol reports for any origin; `tabs.onUpdated` gives no address for a page without a grant;
- sets the viewport the steps were recorded at (`piwi-replay-viewport`), again on each page;
- gives the tab its size back as it lets go, or the viewport set from the DevTools panel.

A purpose that lets go of a tab another purpose still holds ends its own emulation first (`Fetch.disable`, network and
CPU back to normal, `Emulation.clearDeviceMetricsOverride`). Nothing stays attached in the background.

**A viewport is set in CSS pixels, through `emulateCssViewport`** (`viewport-emulation.ts`). The protocol's size is
divided by the browser's zoom: a 400-pixel override leaves the page 320 pixels wide at 125%. So the size is scaled by
the tab's zoom, and set again when the zoom changes (`onTabZoomChange`). Never send `Emulation.setDeviceMetricsOverride`
directly.

**Every feature keeps its way of working without the protocol as its fallback, and says why in plain words.** The
protocol can be missing or lost:

- Firefox has no `chrome.debugger` (`debuggerAvailable()` is false);
- attaching can be refused (another debugger, a policy, a page Chrome protects);
- the person can click Cancel on the browser's bar (`onDetach` with `canceled_by_user`, heard through
  `onDebuggerLost`).

The pure half, `src/shared/cdp-input.ts`, names why (`FallbackReason`) and picks the driver (`chooseDriver`).

**A content script never talks to the protocol.** It finds the element and its box. The worker sends the commands,
checks the request field by field (`readInputOps`) and checks that it comes from the tab of the running replay.

**Tests.** The e2e suite cannot click the browser's bar: the worker's `__piwiCancelDebugging(tabId)` does what Cancel
does. `chrome.debugger` attaches beside Playwright's own connection, so the specs run on the real extension
(`tests/e2e/trusted-site.ts`).

### A replay belongs to one tab

`replay-panel.js` is registered for the replay's whole origin, so every tab of that origin loads the script. Only one
of them plays the replay: the **replay's tab**, which the worker keeps under `piwiReplayTab` (`getReplayTab`; only the
worker writes it).

- The replay's tab is the tab the replay started in. When none is bound (a replay started from an extension page), it
  is the first tab to ask (`piwi-replay-tab`).
- Only that tab plays the steps, gets a driver, sends input and finishes the replay. In any other tab the popup's
  Replay says so (`popup_replayElsewhere`).
- **A step that opens its page in a new tab** (a link with `target="_blank"`, `window.open`) takes the replay there, as
  the recording went on there:
  - the worker notes the tabs the replay's tab opens while it runs (`tabs.onCreated`, `ReplayTab.opened`);
  - the first of them to ask moves the replay (`moveReplay`), when it shows the page of the replay's step and the
    replay's tab does not (`stepOpenedTab`). The page check matters because Chrome also names the tab in front as the
    opener of a tab merely opened beside it;
  - the tab left behind gets its debugging session and its size back, and its page lets go of the replay wherever it
    waits (`piwi-replay-moved`).
- Closing the replay's tab ends the replay (`finished`). A replay stopped while no page of its tab ran shows its
  verdict on that tab's next page, or ends when another tab asks.

A page writes the replay's state only through `updateReplayState(change, replayId)`, which applies the change onto the
stored state. So a Pause, a Stop or a replay started meanwhile is never overwritten by a step that was waiting.

### How a replay finds a step's element

`resolveForAction` (`replay-actions.ts`) looks for the element with every locator it was recorded with (`locatorsOf`):
the spec's own first (`stepLocator` with `locators: 'stable'`), then the other alternatives in their recorded rank. All
of them run on one engine per poll.

`chooseElement` (`replay-core.ts`, pure, unit-tested) decides by votes:

- Each locator that finds one element alone votes for it.
- The spec's own locator weighs 1.5 votes. Another weighs 1, or 0.5 when the stability rules call it brittle
  (`voteWeight`: a position, a CSS class). So only two steady locators agreeing outvote the spec's own.
- A locator other than the spec's own votes only for an element of the recorded tag or role that carries no other test
  id (`fitsTarget`).
- The most votes win. On a tie, the element the better-ranked locator found wins.

So a label that changed, an id made up on each load, or a second element sharing a name leaves the other locators to
find the element. The step's result says which locator did (`foundWith` in `replay-panel.ts`, `replay_foundWith*`). A
step no locator finds keeps the reason in the words of the spec's own locator.

How long a step waits:

- The element is waited for as Playwright waits (visible, enabled, still), for `stepTimeout`. That is
  `ACTION_TIMEOUT_MS` (10 seconds), or the time the person waited before the step when recording plus five seconds, up
  to a minute. So a reply the server sends after fifteen seconds is waited for, for its page as for its element.
- Another locator's element is taken only once the spec's own locator has had `FALLBACK_AFTER_MS` (2 seconds) to find
  one, since the page a step plays on may still be on its way. It is never an element carrying another test id than
  the recorded one.

Steps the replay does not play itself:

- A `fill` whose value the report does not hold (`redacted`: a password, a card number, a one-time code, or every typed
  value when the sender left them out) is handed to the person (`replay_reasonSecret`) rather than typed empty.
- A hover recorded without any locator is skipped (`replay_hoverNoLocator`): the next step's pointer goes over its own
  element.

Assertions look for their element with the spec's own locator only, as the spec does.

### Trusted input in a replay

**Trusted input** is input sent through the debugging protocol (`Input.*` commands): the browser handles it as a real
person's input. Without the protocol, the replay dispatches events from the content script instead, called **the
page's own events** below.

`replay-panel.ts` asks the worker for the driver on each page (`piwi-replay-driver`). The choice is kept in
`ReplayState.driver`, and a replay that fell back stays on the page's own events.

With the `cdp` driver, `replay-trusted.ts`:

- glides the fake cursor;
- checks that the element (or its label) is what the browser finds at the point, as Playwright's hit check does;
- sends `piwi-replay-input`, and the worker sends:
  - mouse moves, clicks and double clicks;
  - key presses (`ControlOrMeta` is ⌘ on a Mac, with the editing command Chrome needs);
  - `Input.insertText`, after selecting what a field or an editable element holds;
  - drags: `Input.setInterceptDrags` and `Input.dispatchDragEvent` for an HTML drag, the moves alone for a
    pointer-driven one, once both ends are on screen together.

Date, time and color fields and `<select>` get their value set as Playwright sets them.

The replay's panel lets the pointer through while input is sent, and keeps its own pointer and focus events from the
page: a click on Next leaves the page's focus and its open menu as they are. A key press with no element goes to the
page's element that last had focus.

When input does not get through:

- **Lost before it reached the page** (the bar cancelled, a command refused): the step is played again with the page's
  own events (`replay-actions.ts`).
- **Lost after part of it got through** (the button went down, not up): the step fails with
  `replay_reasonInputInterrupted` rather than being done twice.
- **Sent but never heard by the page** (`sendHeard`: none of the click's or the key's pointer, mouse or key events
  reached the window of the element's document within `INPUT_REACH_MS`): the step goes to the person
  (`replay_reasonInputBlocked`). A tab-modal browser dialog makes the tab ignore input, such as Chrome's warning about
  a password found in a data breach after a login, and the step would otherwise pass with nothing done.
  `trusted-replay.spec.ts` stands one in with `Input.setIgnoreInputEvents`.

Each step result keeps its `driver`, and the panels show it.

**File steps.** A report names files but never carries them, and `DOM.setFileInputFiles` needs a path on disk. So a
file step asks the developer for the file in the replay's panel, or lets them skip it (`skipped`). While a replay holds
the tab, the file chooser a click opens is intercepted (`Page.setInterceptFileChooserDialog`).

**Keys with the page's own events** (`replay-actions.ts`). A key carries the legacy `keyCode` and `which` the browser
gives it, and a `keypress` its `charCode`, from the same `keyDefinition` the trusted path sends (`cdp-input.ts`). Older
pages read them (the classic TodoMVC adds a todo on `keyCode === 13`), and an event a script makes has 0 otherwise.

## Connected mode

### What connecting adds

The recorder (`record-panel.ts`, `record-capture.ts`, `packages/core/src/recording.ts`, `function-match.ts`,
`codegen.ts`) works fully standalone: it records clicks, fills and the rest across pages, and gives a raw Playwright
spec back.

The user connects in `options.html`: an instance URL and **Connect**, or a pasted API key. URL patterns map sites to
projects; they come from the instance and from this browser. For the recorder, connecting adds the project's
**function catalog**:

- Each mapped project's `test_functions` catalog (`apps/application/shared/handlers/test-functions.ts`) is fetched once
  and cached per project (`src/shared/catalog-cache.ts`, in `chrome.storage.local`, keyed by project id).
- `rankFunctionMatches` and `matchFunctionAt` (pure, deterministic, unit-tested in `packages/core`) match the live
  recording against the catalog of whichever project applies. The matches are ranked live in the HUD and substituted
  into the generated spec on export.
- The matcher never invents a function: it only scores and selects among what the catalog already has.

Connected mode also adds Tested elements (see "Tested elements") and bug reports sent to the instance and replayed from
it (see "Report a bug").

### Connect

**Connect** is a device authorization (RFC 8628, `adr/extension-connect.md`):

1. The settings page requests the instance's origin inside the click.
2. `startConnect` gets a user code and a verification page, which opens in a tab.
3. `waitForApproval` (`src/shared/connect-flow.ts`, pure) polls `pollConnect` until the user allows or denies it there.
4. The approved answer carries the API key, created for that user at that moment and returned once. The key is stored
   like a pasted one.

The tab is closed however the wait ends. **Cancel** ends the wait at once, mid-sleep or mid-poll. The browser and OS
names sent with the start come from `describeClient` (`src/shared/client-info.ts`), and nothing else about the machine
is sent. A desktop app pairing sends the same names.

### Where secrets are kept

**No secret is kept in `chrome.storage.local`.** Content scripts read and write that area (the panels read
`ConnectionSettings` from it). So the API key, the desktop app's pairing and the editor's token live in the IndexedDB
of the extension's origin (`src/shared/secret-store.ts`). A content script cannot open it, since its IndexedDB is the
page's. Only the worker and the extension pages read them.

- The key is kept with the origin of the instance it was given for. `getInstanceApiKey` hands it out for that origin
  only, so an `instanceUrl` rewritten in storage gets requests without it.
- No request to the instance or the desktop app follows a redirect (`redirect: 'error'`).
- `isConnected` never looks at the key.
- The editor's address stays in `chrome.storage.local`, which tells a content script that an editor is paired.
- Older versions kept these secrets in `chrome.storage.local`. A secret found there is moved as the worker starts, as
  the settings page opens, and by each read of it (`legacy-secrets.ts`): written to IndexedDB first, removed after. One
  already kept in IndexedDB wins.

### Buttons that start a request

A button that starts something disables itself inside the click, after the permission request, until the work ends
(`whileRunning` in the settings). These are **Connect**, **Save and test**, **Save**, **Pair**, **Pair by hand**'s
**Save and test**, **Use the desktop app as your instance**, **Revoke** and **Add to Piwi** in the settings, and **Save
login file** in `login.html`.

A write the settings page makes once an answer arrives goes through `writeConnection`. The write is dropped when
**Disconnect** or another connection came meanwhile (`connectionEpoch`), or when the stored instance is no longer the
one it read. So a sync still in flight never brings back a connection Disconnect removed.

### The instance marker

The instance's pages are marked, so the dashboard knows the extension is installed (`background/instance-marker.ts`,
`content/instance-marker.ts`, the names in `@piwitests/core/picker-marker`):

- While an instance URL is set and its origin granted, the worker keeps `instance-marker.js` registered for that origin
  only, and runs it in the instance's tabs already open. The registration is synced as the worker starts, when
  `piwiConnection` changes, and when a grant is added or removed.
- The script checks that the page is the instance's (`isInstancePage`), since Firefox's pattern covers every port of
  the host. It sets `data-piwi-picker` on `<html>` to the extension's version and dispatches `piwi-picker-marked`.
- The dashboard leaves out its hint to install the extension when it sees either (`usePickerInstallHint`).
- The script reads nothing from the page and sends nothing. `instance-marker.spec.ts` covers it with the real worker and
  grant.

### Project mappings and the active project

The settings page reads the instance's own URL patterns (`GET /api/extension/url-patterns`) when it connects and each
time it opens. `applyServerSync` caches them in `ConnectionSettings.serverMappings`, with `serverProjects`, whose
`canEdit` gates **Add to Piwi**.

The **active project** of a page is the project that applies there. Only `resolveActiveProject(settings, override, url)`
(`src/shared/active-project.ts`) resolves it, and the first match wins:

1. A manual override for the page's site. It is kept per origin in session storage and set from the popup's **Active
   project** select for the tab's origin. `getActiveProjectOverride(url)` reads it: a content script calls it without a
   URL for its own page, and the popup, the worker and the DevTools pages pass the tab's address.
2. The first `ConnectionSettings.projectMappings` entry (this browser only) whose `urlPattern` matches. So a local
   pattern overrides the instance's in this browser.
3. The first `serverMappings` entry that matches.

Matching uses the URL, through `urlMatches` / `globToRegExp` in `packages/core/src/function-match.ts`: the same glob
matcher a catalog entry's own `urlPattern` gate uses. Every consumer that needs the project for a page (the record
panel's HUD and review panel, `test-function-panel.ts`, the popup's select) calls this one function rather than
re-deriving it.

**Disconnect**, and connecting to another instance, drop every site's override and every project's branch choice
(`locator-branch.ts`), with the cached catalogs and locator indexes (`forgetInstanceData`).

**The lines of this browser outlive a Disconnect.** Disconnect sets them aside with the instance's origin
(`src/options/kept-mappings.ts`, `piwiKeptMappings`):

- The next connection kept takes them back into `projectMappings` when it is to the same origin. Otherwise they are
  dropped, since their project ids are that instance's.
- They are read as a connection is made (`readKeptMappings`) and dropped only once it is kept (`dropKeptMappings`,
  unless a Disconnect came meanwhile). So a connection dropped on the way leaves them, and so does a Disconnect with no
  instance kept.

### What is read and what is sent

**No recording is ever sent to the instance**, and a bug report only through **Send to Piwi…**.

Read from the instance: the URL patterns, each mapped project's catalog and locator index, its bug-report intake (what
Send to Piwi may carry), and its bug reports (Replay's list), with a report's steps and step screenshots when it is
replayed.

Sent, each only from a user's action:

- a URL pattern the user adds (**Add to Piwi**);
- the browser and OS names, with Connect and with a desktop app pairing (`describeClient`);
- a bug report, once the user clicks Send in its preview (`bug-send-panel.ts`). The preview shows the steps and every
  kind of evidence, with a box per kind and one box that leaves the typed values out, of the steps and of everything
  that repeats them, as typed or encoded. The pure `bug-send.ts` builds the payload. The first send in a profile
  explains once what connected mode now sends (`piwiBugSendExplained`);
- a replay's verdict, through **Share result**, after its preview (see "Share result");
- a report's steps, to the paired desktop app, through **Run with Playwright**, after its preview (see "The desktop
  app");
- a locator or steps, to the paired editor, through **Send to editor**.

### The desktop app

**Run with Playwright** (`desktop-run-panel.ts`, worker side `background/desktop-repro.ts`) sends a report to the
desktop app paired in the settings, which runs it with Playwright in the developer's project. What goes: the report's
title and steps (with their typed values, as the dialog shows them), the run options (headed, with a trace), and, for a
report from the instance, its id and the instance's address. Never code.

The pairing:

- The pairing is the app's loopback address and its token, kept together in the secret area. `desktop-settings.ts`
  accepts only plain http on 127.0.0.1, `localhost` or `[::1]`, and keeps it as 127.0.0.1, the one address the app
  binds.
- **Pair** asks the app at the address typed (`DESKTOP_DEFAULT_URL`, the app's preferred port, unless changed) for a
  pairing (`POST /api/desktop/picker-pairings`, open without the token; see
  `apps/application/shared/desktop-pairing.ts`). The app's window shows who asks, with a code the card shows too.
  After the developer's **Allow**, the poll carries the app's token, once. The card keeps it after `testDesktop`
  accepts it.
- **Pair by hand** takes the token pasted from the app's **Connect Piwi Picker** instead.
- Either way the settings page requests that one loopback origin inside the click. **Unpair** gives the grant back,
  unless the instance kept is at that address. **Disconnect** leaves the grant to a pairing at that address.

The desktop app as the instance. The app's server is a Piwi instance that takes its token as an API key
(`desktop-guard.ts`). So the Connect to Piwi card:

- offers **Use the desktop app as your instance** while the app is paired and no instance is kept. It runs
  `connectWithKey`, the path of **Save and test**, with the app's address and token. A refused token leaves the address
  in place and the key field focused;
- points to the pairing while an instance is kept and no app is paired.

The token goes out only after the program at the address proves it holds it:

- Every request that carries the token (`testDesktop`, `sendReproRequest`, `fetchReproRequest`) first asks
  `/api/health` to answer a new random challenge with the proof only the token's holder can compute, for the address's
  port (`proveDesktop`, `@piwitests/core/desktop-proof`). An app that moved, an older app or another program on the
  port never receives the token, and the user is asked to pair again.
- The same holds for the token kept as an instance's key. `authHeaders` runs `proveDesktopKey` before every instance
  request whose key is the app's token. A key is the app's token when the secret area marks it so, or when it matches
  the paired address and token. `markDesktopApiKey` sets the mark as the connection is kept and as a pairing is replaced
  or removed, so Unpair keeps it.
- `proveDesktopKey` refuses at a loopback name other than 127.0.0.1. On a failed proof it throws
  `common_desktopNotProven`, which `healthOutcome` reads as `unauthorized`.

The run:

- The dialog shows the payload before **Send**. The request is JSON with `x-piwi-token`, and holds steps, never code.
  The app runs nothing before the developer confirms it in its window.
- The dialog then polls the request for the verdict, read field by field (`reproStatus`, `asReplayVerdict`). A status
  or a verdict it does not know says so in one line.

### Share result

**Share result** (`share-result.ts`, worker side `handleShareReproduction`) records a verdict on the bug report it came
from, after a preview: `POST /api/bug-reports/:id/reproductions`.

- What goes: the verdict, the step it diverged at, the origin it ran on (none for a desktop run) and the user agent.
- It is offered for a replay of a report chosen from the instance (`bugReportId` is set only then), and for a desktop
  run of such a report.
- The worker records a verdict only on the stored replay's report, or on a report it sent to the desktop app in this
  browser session (`piwiDesktopRunReports`).

### The requests and who makes them

Only `piwi-client.ts` makes requests to the instance, the desktop app and the editor, from exactly two contexts:

- `src/options/`: connecting, saving, reading and adding URL patterns, pairing the desktop app;
- the worker:
  - its `piwi-refresh-catalog` / `piwi-refresh-locator-index` handlers (`project-refresh.ts`). For a content script
    they fetch only the project its tab's URL maps to; for an extension page, the project id it names;
  - its bug-report messages (`src/background/bug-reports.ts`): `piwi-bug-send-target`, `piwi-send-bug-report`,
    `piwi-list-bug-reports` and `piwi-get-bug-report` resolve the project again from the sending tab's URL and never
    take one from the page; `piwi-share-reproduction` records a verdict as "Share result" says;
  - `piwi-replay-step-view`, for the stored replay's report (`step-views.ts`);
  - the desktop app's messages: `piwi-desktop-repro`, `piwi-desktop-repro-status` (`desktop-repro.ts`);
  - `piwi-send-to-editor`, which posts to the paired editor (`postToEditor`).

**Never from a content script**, so the API key never reaches a page's JavaScript context. `record-panel.ts`,
`test-function-panel.ts` and `coverage-overlay.ts` read the cache. When they need fresher data, they ask the worker
through `catalog-refresh.ts` / `locator-index-refresh.ts` rather than fetching themselves. They build their links into
the dashboard with `instance-links.ts`, which fetches nothing. `piwi-client.test.ts` fails on a file of `src/content/`
that imports `piwi-client.ts` directly. Keep it that way.

### Connection health

`src/shared/connection-health.ts` keeps whether the instance answers (`piwiConnectionHealth` in
`chrome.storage.local`, no secret).

- `withConnectionHealth` records `ok`, `unauthorized`, `unreachable` or `error`, with the time and the instance
  address, and passes the answer or the error on unchanged.
- It wraps every request of `project-refresh.ts`, the requests of `bug-reports.ts` that send, list or read reports and
  share a verdict, and the settings page's read of the URL patterns. Two best-effort reads catch their own errors and
  are not wrapped: the project's bug-report intake (`fetchBugReportIntake`) and a replayed step's screenshot
  (`fetchBugReportStepShot`). The settings page's other requests show their outcome in their card's status line.
- `piwi-client.ts` throws sentences, so `healthOutcome` tells the outcomes apart by the catalog's own messages. An
  answer that shows the instance works and the key is accepted (no locator index, a role that cannot send) is `ok`.
- The popup's line under the project row and the settings page's pill beside the address read it for the instance kept
  only, and redraw on `chrome.storage.onChanged`. Disconnect clears it.
- A new request to the instance goes through the same wrapper.

### Cache freshness

A function added in the dashboard must reach the extension without the settings page saving again:

- The panels render from the cache first (instant, and fine with the instance unreachable) and revalidate in the
  background, guarded by `CATALOG_TTL_MS` (one minute).
- The Test functions panel also has an explicit **Refresh** that forces past the TTL.
- `refreshHud` runs on **every captured step** during a recording: never add a fetch to it. The record panel refreshes
  the catalog once per page load instead.

### Host permissions for the instance

The dashboard API sends no CORS headers, and the `X-API-Key` header makes these requests non-simple, so the browser
preflights them. A granted host permission for the instance's origin is what makes the fetch work.

- The settings page requests it inside the click (Connect, Save and test, Save, Refresh). A service worker has no user
  gesture and can never request one itself.
- It calls `chrome.permissions.request` first, before anything is awaited. Firefox shows no prompt for a request made
  after an `await`, and an origin already granted answers true without a prompt.
- Every host pattern built for an origin comes from `hostPattern` (`src/shared/web-origin.ts`), never `${origin}/*` by
  hand. Firefox accepts a pattern with a port (`http://localhost:3000/*`) and lists it as granted, but the pattern
  matches nothing (bug 1362809), so CORS still blocks the fetch. In Firefox only, `hostPattern` leaves the port out.
- Each request for origins from the settings page also clears a parked recording intent, so its grant cannot start a
  recording (see "Rules, with their reasons").

### The Test functions panel

`test-function-panel.ts` (pure half `test-function-scan.ts`) is the other consumer of the cached catalog. It is a
standalone popup tool, **Test functions**: it scores every catalog entry's pattern against the current page's live DOM,
with no recording needed. It reports a verdict per step (unique, ambiguous or missing), rolled up per function into
ready, partial or not found.

- It shares `scoreTargetMatch` (`packages/core/src/function-match.ts`) with the recorder's live ranking, so a function
  this panel reports "ready" is scored exactly as it would be mid-recording.
- It counts what Playwright finds, open shadow roots included (`createPageEngine`). For a test id target that is every
  element carrying it, hidden ones too, as `getByTestId` does. For a role or name target it is none hidden from the
  accessibility tree, as `getByRole` does.

## Tested elements

`coverage-overlay.ts` outlines every element a test of the active project reaches, and the visible interactive
elements no test reaches. It opens from the popup's tile (key `T`) and from **Show every tested element** in the pick
results.

The data is the project's **locator index**, `GET /api/projects/:id/locator-index` (`LocatorIndex` in
`packages/core/src/locator-index.ts`, built by `getLocatorIndex` in
`apps/application/server/utils/locator-usages.ts`).

- The worker fetches it, and `locator-index-cache.ts` caches it in `chrome.storage.local`, for `LOCATOR_INDEX_TTL_MS`.
  The cache keeps the last `LOCATOR_INDEX_CACHE_PROJECTS` indexes within `LOCATOR_INDEX_CACHE_BUDGET` (4 × 1024 × 1024
  characters of JSON). An index larger than that, or one that does not fit the storage quota, comes back in the
  worker's reply, uncached.
- An index describes one branch. `locator-branch.ts` resolves it from the panel's choice for the session, else the URL
  mapping's `branch`, else the default branch. The cache keeps one entry per project and branch.

**Comparing the open page with the index.** The page is compared with the index's page keys only through `pageHere`
(`src/shared/page-here.ts`), which applies the URL mapping's two prefixes before the page key (core's
`mappedPageKey`):

1. It removes the mapping's `pathPrefix`, whole segments only: `/app` for a site serving `/app/checkout` whose tests ran
   at `/checkout`.
2. It puts the mapping's `testPathPrefix` in front: `/app` for tests that ran `/app/checkout` where the site serves
   `/checkout`.

A bug report's page key gets the same prefixes: `bugContextFrom` (core) keys it through `mappedPageKey`, with the
prefixes `activePathPrefixes` reads. Never call `pageKey(location.href)` to compare with the index or to key a bug
report.

### The in-page locator engine

The index's locator chains are evaluated by an in-page reimplementation of Playwright's selector engines:

- `engine-aria.ts`: `DomModel`, which computes role, accessible name and description, ARIA states, hidden-for-ARIA,
  visibility, element text and `getByLabel` labels, following Playwright's `roleUtils.ts` / `selectorUtils.ts`. Pure
  DOM, and no `instanceof` test on a node: a frame's nodes come from another realm (another JavaScript global), where
  `instanceof` fails.
- `engine-selector.ts`: CSS (piercing open shadow roots, with Playwright's `:has-text()`, `:text()`, `:visible`,
  `:scope` and the rest) and XPath.
  - `:is()`, `:where()`, `:not()` and `:has()` are evaluated here, as Playwright does: inside the scope and through open
    shadow roots.
  - A text pseudo-class takes quoted strings: `:has-text(Tailwind)` fails once matched against an element, as in
    Playwright.
  - Pseudo-elements and two combinators in a row are refused.
- `locator-engine.ts`: `createLocatorEngine(doc, { testIdAttributes, ignore, strict })` evaluates a parsed
  `locator-chain`: every `getBy*`, `locator()`, `>>` parts, `filter`, `and` / `or`, `nth` / `first` / `last`, and
  frames.
  - A frame locator enters its first owner, as `count()` does, and `first()` / `nth()` on it pick the owner. `strict`
    refuses several owners, as an action does.
  - `frameLocator()` with no selector searches the page and every frame below it, and refuses elements found in more
    than one.
  - A frame inside a locator nested in `and()`, `or()`, `has` / `hasNot` or `locator(locator)` is refused, as Playwright
    refuses it, unless the nested chain starts with the outer chain's own frame prefix, which is dropped
    (`prepareChain`).
  - The engine caches per instance, so build one per scan.
- `coverage-scan.ts`: the pure half. It runs every chain of the index in time slices, and starts over with a new engine
  (twice at most, `MAX_RESTARTS`) when the page changes under it. It reports the covered and uncovered elements and the
  tests. `coverage-layer.ts`, `coverage-panel.ts` and `coverage-view.ts` draw it. The overlay lives in a closed shadow
  root in the top layer (`popover="manual"`), so it paints above the page's own dialogs.
- One element at a time:
  - `scopeScan` narrows a finished scan to an element and what is inside it, with no rescan;
  - `elementReach` splits the tests reaching a picked element into the element itself, inside it, and around it;
  - the pick results hand an element to the overlay through `globalThis.__piwiCoverageScopeRequest` before asking the
    worker to inject it. Both content scripts run in the extension's isolated world, so the global is shared, and an
    element cannot travel through `chrome.runtime` messages.

### At risk

**At risk** (`coverage-risk.ts`, pure apart from the engine it is handed) lists the locators likely to break.

- Brittle locators come from `assessLocatorChain` (`@piwitests/core/locator-stability`), judged once per index.
- A replacement is built only for a chain that finds one element:
  - `rankElementLocators` (`verified-locators.ts`) ranks that element's locators;
  - the same stability rules must call a candidate stable;
  - an engine over the current page must find only that element with it;
  - `recommendLocatorFix` (`@piwitests/core/locator-fix`, the ladder locator healing uses) picks among the survivors.
- Replacements and the suggested locators are cached per element until the page changes: the overlay drops them, with
  the engine that checked them, on every change it observes.
- An element inside a frame gets no replacement, because its locator would need the frame's prefix.

## Naming and ranking an element

Every tool that names an element or offers a locator for it goes through `verified-locators.ts`, the same path the
recorder takes. In this section, the **probe** is `picker-dom`'s reading of an element's attributes and structure, and
a **candidate** is one ranked locator for the element.

- **Names and roles** come from `DomModel` (`accessibleNameOf`, `model.role`). For a tab showing a count badge the name
  is "Regressions 5", where `textContent` reads "Regressions5". A `<th>` gets `columnheader`, which
  `generateAlternatives` takes as its `role` option. The probe's `approximateAccessibleName` is only the fallback when
  the model finds no name.
- **Ranking** (`rankElement`) is `generateAlternatives` without the probe's estimated match counts.
  - Given an engine (`engine`, or a `model` from `createPageEngine`), the probe runs with `countMatches: false`, and the
    anchors are counted with the engine's indexes, built once for a whole scan, on a page of any size.
  - Without an engine (a single pick, the recorder), the probe counts them, walking the page.
- **`checkLocators`** runs every candidate through an engine over the page (`createPageEngine`, blind to the
  extension's own elements):
  - a candidate that finds the element alone is verified, and comes first;
  - a candidate that finds the element among others is narrowed (below) and scores one point under it;
  - a candidate that finds only other elements is dropped;
  - `.first()` / `.nth()` comes last, only when nothing finds the element alone;
  - `keepAmbiguous` also returns the others with the engine's count, which is what the Pick results panel shows.
- **The narrowing ladder** (`narrow()`). Each rung is checked unique by the engine and named in
  `CheckedLocator.narrowedBy`:
  1. exact (`exact`);
  2. `.filter({ hasText })` with the element's text (`text`);
  3. an ancestor whose test id is unique (`scope`, the test id read from the engine's `testIdAttributes`);
  4. the nearest **repeated container** whose siblings hold the other matches (`container`). A repeated container is an
     ancestor that repeats beside siblings of its own kind: one sharing a test id, or a tag with a role or a readable
     class (`repeatedContainers` in `repeated-container.ts`). It is picked by its own `aria-label` / `aria-labelledby`
     name, else filtered by a short text it shows and its siblings do not (a visible one before a hidden one);
  5. a landmark, named dialog or row scope (`scope`).

  A unique test id goes before the container because it is the author's own hook. A row named from its whole content
  goes after it, being longer and changing with every cell.
- **The pick** (`pick.ts`) checks the candidates before anything else. The anchors step opens first only when no
  candidate finds the element alone (`unique` or `narrowed`) without the stability rules calling it brittle. Otherwise
  the results open at once and offer the anchors step as **Scope to a parent…** (`renderResultsPanel` resolving
  `scope`); after it, the anchored candidates are checked and the results open again.
- **Built on `checkLocators`**: `verifiedLocators` (the recorder), `deriveTopLocator` (assertions, the Tested elements
  overlay) and `rankElementLocators` (At risk replacements). A scan passes one engine to every call, so the engine's
  caches serve the whole scan.
- **An element with a role and no name** (an unlabelled checkbox) gets its bare role as a candidate (`rankElement`,
  score 12, ranked among the others: above a hashed class's CSS). `checkLocators` narrows it or keeps it with
  `.first()` / `.nth()`. It never ends with no locator at all, which the replay could not play.
- **A step is never lost to its locators.** A recorded target whose candidates cannot be checked against the page
  (`checkLocators` throwing on a tree it does not expect) keeps its ranked candidates as they are
  (`recordedAlternatives`, `record-panel.ts`). A click whose hover search throws is recorded without hovers.
- **A name longer than 80 characters** (a link around a whole card: its title, summary and tags) is written by the
  words it starts with, 60 characters at most (`shortName`). Playwright matches a name as a substring, so it finds the
  same element, which `checkLocators` checks.
- **Multi-pick** (`derivePattern`, `multi-pick-derive.ts`) shares `repeatedContainers` with the ladder.
  - Picks that share a role, each alone in its container, with the containers siblings of one kind (rows of one table,
    cards of one grid), give the container's pattern, such as
    `getByTestId('product-card').getByRole('button', { name: 'Add to cart' })`, with the number of elements it finds.
    Each pick then gets its container filtered by a text no other container shows (`.nth()` on the pattern when none
    does).
  - Other picks give their own role or class with `.filter({ hasText })`.
  - `multi-pick.ts` hands `derivePattern` the page engine's roles, names and texts.
- **Lint** (`scanForLintIssues`, `lint-scan.ts`) shares it too, through `engineContainerOptions`. A finding's container
  is the nearest one whose siblings hold another finding of its role and name (`RepeatedContainer.repeats`, the check
  the ladder makes with the other matches). It uses `sameTag`, so that siblings sharing nothing but their tag count: no
  locator finds those, which is what the suggested test id fixes. The container is named after the first text
  `textsAmong` gives.
- **Verdict words** (`verdictWords`, `src/shared/verdict-words.ts`, unit-tested) say what a checked locator is worth,
  from its verdict and `locatorStability` (`assessLocatorChain`'s level and rules):
  - a word: `stable`, `could break`, `brittle`, `unique by position`, `3 matches`, `not checked`;
  - a tone;
  - an explanation: `unique · brittle: CSS class`.

  A Pick results row leads with the word and keeps the explanation and the engine's score in its Details. The Elements
  sidebar shows the same explanation. Never show the score alone as the verdict: it has no scale a person can read.
- **Hover** (`createHoverLocator`, behind the picker overlay's `__piwiDescribeElement`) must stay cheap on pointer
  moves. Building the engine's indexes costs tens of milliseconds on a large page (about 45 ms at 3,000 elements, 120 ms
  at 9,000). So a move gets the ranked candidate (probe without structural anchors, `DomModel` name: under a
  millisecond). The check runs once the pointer has rested `HOVER_REST_MS` on the element, and its answer is kept for
  that animation frame. The picker overlay reads it again through `globalThis.__piwiRedescribe`.
- **Counts** (the DevTools Locators tab) come from the same engine. Nothing in the extension estimates a count.

**Where a new naming or narrowing case is tested.** `pick.spec.ts` picks each case of `tests/e2e/pages/pick-cases.html`
(a tab with a count badge, a name that is a substring of another, a link in the nav and in main, buttons sharing an
`aria-label`, a column header, a search field with suggestions, a banner). Real Playwright then clicks the top locator
the results panel offers. A new case goes there, with two exceptions:

- a case the picker cannot click goes into `locator-engine.spec.ts`'s ranking tests (`__piwiRankTop`). The picker snaps
  to an ancestor carrying a `role`, so a grid's cell is its grid;
- a repeated-container case goes into `CONTAINER_NARROWING` (`locator-cases.ts`, on `pages/locator-containers.html`).

**`locator-engine.spec.ts` is a differential test against real Playwright.** Every expression in `locator-cases.ts` is
resolved by the engine bundle (`engine-entry.ts`) and by a real `page.locator(…)`. The two must return the same elements
in the same order, or both refuse the expression.

- A new locator kind or option goes into `locator-cases.ts`, with a fixture element in `tests/e2e/pages/`.
- An expression Playwright itself rejects must be listed in `EXPECTED_REFUSALS` (in `locator-engine.spec.ts`); the
  engine must reject it too. An expression Playwright rejects without being listed fails the test, and so does one only
  the engine refuses.
- A case is never skipped. Each group must also find something for more than a third of its expressions, which shows
  that its fixture loaded.

## Checks in a test recording

A test recording's bar (`renderHud`, in Piwi Picker and in the IDE bundle) has **Check an element** and **Check the
address** (`check-panel.ts`).

- They reuse the bug report's pick and dialog (`pickElement`, `openRecordDialog` in `bug-panel.ts`), and pause capture
  the same way.
- They record an `assert` event of what the page shows now, with `actual` null: the spec writes it as `await expect(…)`.
- The dialog names the element by the recorded target's first locator, so the project's test id attribute applies.
- Both buttons are disabled while the recording is paused.

**Pause** in the bar (both builds) stops capture without ending the recording, until **Resume**. One guard,
`capturePaused()`, sits at every capture listener.

- The extension keeps it in `RecordingState.paused` (`updateRecording`, queued behind the appends: the document's, or in
  Firefox the worker's). Each page reads it as the recorder attaches.
- The bar sends `piwi-recording-paused`, which the worker passes on to the recording's other tabs
  (`notifyRecorderTabs`).
- In the IDE bundle the launcher keeps it and tells the editor.
- The DevTools Record tab says the recording is paused.

**Replay from the review panel.** The review panel after Stop has **Replay**, as the bug report's finish panel has. Both
start the replay in the tab through `startReplayHere` (`record-ui.ts`, `piwi-start-replay`). The replay dialog offers
the last recording not discarded, of either mode (`lastRecordedReport`), each under its own label.

**The recording's title** (`RecordingState.title`) is the first page's `document.title` as the recorder first attaches,
then the review panel's **Test title** field.

- The panel stores the field a moment after the last keystroke, and at once on Copy, Download steps, Send to editor,
  Replay, close and `pagehide` (`titleWriter`). Discard drops the pending write and waits for the one in flight before
  it removes the recording.
- A field write names its recording: `updateRecording` takes the recording's `startedAt` and writes nothing when the
  stored recording is gone or a newer one (`isRecordingStartedAt`). So a late keystroke never brings a discarded
  recording back, nor renames the one another tab records. Pause names the recording its page started with the same
  way.
- Every export goes through `recordingTitle` (`src/shared/recording-title.ts`), which falls back to the first action in
  words (`titleFromSteps`). So no spec says `recorded flow` when the steps name it better. The title reaches
  `renderSpec({ title })` for Copy as TypeScript (the review panel and the DevTools Record tab), and `steps.title` for
  Download steps, Send to editor, Replay and the replay dialog.
- A bug report keeps its own title in its evidence.

## Report a bug

A **bug recording** is a recording with `mode: 'bug'` (`recording-storage.ts`): the same capture, navigation and
one-origin rule as a test recording, a different HUD (`bug-panel.ts`), and `assert` events that `normalizeSteps`
keeps in place.

- **Mark what's wrong** pauses capture (`__piwiRecordPaused`, a global because every re-injection of
  `record-panel.js` is its own module instance), runs the pick overlay, and opens the expected-value dialog built from
  `suggestAssertions`.
- **Something is missing** checks its `getByRole` with the in-page engine, and refuses an element that is there.
- Evidence lives under its own session storage keys (`bug-storage.ts`), not in `RecordingState`, which is rewritten on
  every keystroke.
- The report and its files are assembled by `bug-report-files.ts` (pure) and `@piwitests/core/bug-report`
  (`renderBugMarkdown`, `renderBugSpec`).
- **The `.piwibug` archive** is written by `shared/zip.ts`, stored without compression, and downloaded as `.piwibug`.
  Its first entry is `mimetype`, holding `BUG_REPORT_MEDIA_TYPE`, which `isBugReportArchive` (core) reads to tell it
  from any other zip. Readers go by content, never by name: Replay and the desktop app take the same file named `.zip`.
- A bug recording also records `viewport` events (`record-panel.ts`): the page's size when the recording reaches it,
  before its `navigate`, and the size a resize settles at. `normalizeSteps` skips them, and `sessionFromEvents` turns
  them into the steps document's `viewports`, by the first step recorded at or after each.
- The bar's evidence lines (the summary, the debugging session's note, why there is no screenshot) are written in place
  by `updateBugHudEvidence` whenever the evidence changes: an entry the page relays, or a screenshot stored or refused
  (`takeBugScreenshot` ends with `refreshBugHudEvidence`). That is needed because the bar a mark redraws counts the
  evidence before its screenshot is in.

### A screenshot of each step

The recorder asks the worker for a **view** of the page (a screenshot, `piwi-bug-step-view`, under an id it makes up):

- as it starts on a page, and once the page has been still for `VIEW_SETTLE_MS` after an action;
- with its own surfaces hidden (`hideSurfaces`, `record-ui.ts`). Hides keep a count per host id on the isolated
  world's `globalThis`, so hides overlap, a host drawn meanwhile is mounted hidden, and each host shows again once the
  last hide holding it ends;
- for an action with no unused view left, as that action starts.

Each action event keeps the view's id and its element's box (`view`, which `normalizeSteps` carries to the step and
`toStepsDocument` leaves out). The box only holds for the page the view shows. So a scroll (of the page or of any
element) or a resize marks an unused view moved, and it is taken again under the same id, once the page settles or as
the next action starts.

The worker (`background/step-views.ts`):

- takes the view through the recording's debugging session, or with `captureVisibleTab` under `activeTab`;
- drops what the id held before (of two images under one id, the one taken later stays);
- keeps it as a JPEG as wide as the viewport in CSS pixels, in its own IndexedDB (`shared/step-views.ts`). A content
  script's IndexedDB is the page's, and session storage cannot hold a hundred screenshots.

The finish panel asks for the views back (`piwi-bug-step-views`) and writes `evidence.stepShots` and `steps/<nnn>.jpg`,
unless the reporter leaves them out. A recording that starts or is discarded clears them. So does the worker as it
starts, when session storage holds no recording, since the browser session ended (`clearStaleViews`, which also clears
a replay's views when it holds no replay).

**Send to Piwi** sends the step screenshots as `stepShot` parts only to an instance whose intake says how many it takes
(`stepShots`): an older one refuses a send with more files than it expects.

### A step a replay cannot play goes to the person

`replay-panel.ts` hands a step to the person when:

- the step finds no element, or not the one it needs;
- the flow is on another page: a goto whose page never comes, a 204 or a download included. A goto is followed only to
  an http or https address on the replay's origin;
- its action fails (a file step's element takes no file).

It then sets `ReplayState.handOver` and shows why, the step in words, and its screenshot, outlined where the recording
found its element (`piwi-replay-step-view`). The person answers with:

- **I did it, continue**, recorded as `manual`;
- **Skip this step**, recorded as `skipped`;
- **Stop here**, recorded as `diverged`, which ends the replay.

The panel also lists the element's recorded locators (the replay's own first, three at most). The cursor overlay marks
the elements they find on the page (`FakeCursor.marks`), looked for again every `HAND_OVER_LOOK_MS` while the person
acts. The hand-over is in the replay's state, so it waits on the page the person's own action loads.

A report made from a test run (`@piwitests/core/execution-steps`):

- its `manual` steps are always handed over, with the line of the test the step stands for;
- a step whose `pageUrl` is empty waits for no page;
- its `export` block names the step the test failed at. `readReportFile` reads it into `ReplayState.runFailedStep`, and
  `replayVerdict` says that a stop there failed as in the run (`asInRun`), and that a pass there did not reproduce it
  (`runStep`).

A replay keeps its step screenshots in the worker's IndexedDB too. The start message carries the images of a chosen
`.piwibug` (`views`), or the recording's view ids (`recordingViews`), or asks to keep the last replay's (`keepViews`,
Replay again); anything else clears them. For a report from the connected instance, the worker fetches a step's
screenshot only when that step is handed over (`fetchBugReportStepShot`).

### Evidence through the debugging protocol (Chrome and Edge)

A bug recording holds a debugging session on the tab it starts in (`startBugDebugger`,
`src/background/cdp-evidence.ts`):

- `Runtime` and `Log` give the console and uncaught errors, from the page's first script;
- `Network` gives every request that failed or answered 400 or more (documents, scripts and images included): its
  method, its URL through `reportedRequestUrl`, its status, never a header or a body;
- `Page.captureScreenshot` gives a screenshot at any moment, across navigations, which the HUD's **Screenshot** button
  offers.

It keeps the recorded origin only (`startBugDebugger(tabId, originPattern)`), as the main-world script does: the
console of the page's default execution contexts (never an isolated world) while the tab shows that origin, and the
requests of its documents, their URLs written against it. A sign-in on another site adds nothing.

- Only the worker writes what it collects, under its own key (`CDP_EVIDENCE_KEY`). `getBugEvidence` merges it with what
  the page relays.
- The main-world script stays registered. The recorder asks `piwi-bug-evidence-source` and keeps its relay quiet in the
  tab the worker collects from, so nothing is counted twice. It starts the relay when the session is lost
  (`piwi-bug-debugger-lost`), from the time the session ended (`DebuggingState.endedAt`): the script leaves out what it
  held from before.
- Stop and Finish wait for the worker's answer to `piwi-recording-stopped`, which comes once the session's last entries
  are stored.
- The HUD says the debugging bar is expected (`bug_debuggingOn`), and why it went.

`bug-report-cdp.spec.ts` covers it on the real extension.

### Screenshots without the protocol need `activeTab`

`chrome.tabs.captureVisibleTab` refuses under the recorder's per-origin host grant ("Either the '<all_urls>' or
'activeTab' permission is required"). That was checked on the bundled Chromium, and `bug-report.spec.ts` checks it
against the real extension.

- The popup click that starts a report grants `activeTab` until the tab navigates.
- After that, the report records why there is no screenshot. During a bug recording, the popup's tile asks the page for
  one (`piwi-bug-take-screenshot`), since opening the popup is the grant.
- Never answer this with `<all_urls>`.
- The popup's **Finish bug report** asks the page too (`piwi-bug-finish`), which finishes as the HUD's Finish does (the
  relay's last entries, a screenshot, the outline). It stops the recording itself only when no recorder of the tab
  answers.
- The note a report keeps follows the worker's reason (`ScreenshotFailure`): no grant, in the words of Chrome or
  Firefox; the tab not in front; or another failure.
- A screenshot that session storage has no room for leaves a note in the report (`bug_screenshotNotKept`), and never
  keeps Finish from finishing.

### The main-world evidence script

`bug-evidence-main.ts` wraps `console.error` / `console.warn`, `fetch` and `XMLHttpRequest`, and listens to `error`
and `unhandledrejection`. It is the evidence in Firefox, in a bug recording's other tabs, once a debugging session is
lost, and in every replay. It is the only code here, with the request-conditions wrapper, that runs in the page's own
JavaScript world. So:

- **It is registered only while its feature runs, for that feature's granted origin**, at `document_start`, with
  `persistAcrossSessions: false`, and injected into the tab's page already open (`src/background/index.ts`):
  - for a bug recording, as `BUG_EVIDENCE_SCRIPT_ID`, unregistered with the recorder;
  - for every replay, as `REPLAY_EVIDENCE_SCRIPT_ID`, beside `replay-panel.js`, unregistered when the replay finishes.

  It needs no permission beyond `scripting` and that grant.
- **It never imports anything that touches `chrome.*`** (the main world has none), **and it only wraps and listens.**
  Every wrapper calls the original with the same arguments and returns its result.
  - `fetch` returns a promise derived from the original's, settling as it does, since observing the page's own promise
    would handle its rejection. A failure the page leaves unhandled still fires `unhandledrejection`, once.
  - An XHR gets its listeners once, and reports the request it opened last.
- **It never reads a header or a body.** A URL keeps its path, with ids collapsed and query values removed
  (`reportedRequestUrl`, built on `normalizeRoute`).
- **It talks to the isolated world only by `window.postMessage`** (`shared/bug-relay.ts`), and the page sees those
  messages.
  - The recorder and the replay listen through `relayEvidence`, which stores in batches.
  - As the page is left, what is pending goes to the worker in one message (`piwi-relay-left`), since a read and a write
    of session storage started then never finish. The worker keeps it for the bug recording or the replay whose token
    it carries.
  - The token (per recording, or the replay's `evidenceToken`) keeps out entries from another recording or replay, not
    a page that means harm. `readRelayedEntry` rebuilds every entry field by field and truncates it, and storage caps
    each kind at 100 (`BUG_EVIDENCE_LIMITS`). Treat everything it relays as page-controlled text.

**In a replay**, the panel keeps the entries apart from the replay state (`piwiReplayEvidence`) and lists them under
the verdict. Its relay sends `ReplayState.startedAt` as `since`. In the tab a bug recording's debugging session
collected from, the page's script still holds the recording's entries, which its quiet relay never took; a replay
started on that page would otherwise count them as its own.

## Files, double clicks and drags

- The recorder keeps a file field's choice as the files' names, one per line (`files`, played as `setInputFiles`), never
  their content, which never leaves the page.
- A trusted `dblclick` replaces the two clicks before it (`normalizeSteps`).
- An HTML drag and drop is recorded from `dragstart` and `drop` as `dragTo`, with the element dropped on as
  `dropTarget`. A drag done with pointer events alone (a sortable list, a slider) is not recorded as a drag.

`record.spec.ts` checks all three, and that a file's content is not stored.

## The recording bar's corner

Both bars (a test recording's, `renderHud` in `record-panel.ts`, and a bug report's, `renderBugHud`) sit in a corner of
the viewport, over the page, bottom right by default. A checkout bar or a form's last button can be under them.

- Their **Move** button (`moveHudButton`, `hud-corner.ts`; `data-piwi-control="hud-move"`) moves the bar to the next
  corner.
- The corner is kept in `chrome.storage.local` (`piwiHudCorner`) for every page and later recording, and read as the
  recorder attaches (`loadHudCorner`).
- The bug bar has the button last in its DOM, drawn in its top right corner, so its actions come first from the
  keyboard (`bug-report.spec.ts` reaches them by Tab).

## What a click lands on, and pages reached without one

A press records the control it is part of (`nearestActionable`, `record-panel.ts`): the element or its nearest
actionable ancestor. Two cases differ:

- **Inside a tree item**, whose expand arrow and label act apart, it is the part of the item where the page made the
  pointer a hand (`compositePart`, `pointerRegion`). That part is the outermost element showing `cursor: pointer` that
  its parent does not, unless the item or the body shows one itself. It is taken when that part is under half the
  item's width and something locates it; else the item is.
- **For an icon's drawing** (an SVG `<path>`) in no control at all, it is the outermost element around the icon, still
  within `ICON_SLACK` of its size, that shows a pointer cursor and has a locator; else the `<svg>` (`iconControl`). A
  row the icon sits in is not its control. A drawing in an SVG larger than `ICON_MAX` (a chart, a map) records itself.

`record.spec.ts` records them and has Playwright click their locators.

**Pages reached without a click.** A page the person reaches through the browser's Back or Forward, or by reloading,
records its `navigate` event with `navigation`, which `normalizeSteps` turns into a `goto` to that page. A page that the
page itself or an action led to does not:

- **Within a page that routes itself**, the Navigation API's `navigate` event says which moves through the history are
  the person's (`userInitiated`): not the page's `history.back()`, nor a hash it sets. Without the API, a `popstate`
  counts unless it comes within `ACTION_LED_NAVIGATION_MS` of the person's last action (`ownNavigation`,
  `record-capture.ts`).
- **A page that loads**, from its navigation entry or from the back/forward cache (timed at its `pageshow`), counts
  unless it loads within `ACTION_LED_NAVIGATION_MS` of the last action with no page reached since (`lastActionOf`). The
  last action is the last press (a page can move on `pointerdown`) or recorded step. The browser's own Back, Forward and
  reload shortcuts are not recorded as key presses (`BROWSER_NAVIGATION_KEYS`).
- **While paused**, no navigation is a step. `parseCaptureEvent` keeps `navigation` only on an event to the http(s)
  address it was sent from.

The replay and the spec go to such a page again with a goto.

## Hovers a click depends on

Some elements show only while another is hovered. At each press, `record-panel.ts` asks `hoverTargets` which hovers
revealed the pressed element or an ancestor, and records a `hover` step for each before the click:

- **CSS `:hover`.** `hover-rules.ts` reads the page's same-origin style sheets once per change: inside `@media`,
  `@supports`, `@layer` and `@container`, with nested rules resolved to their full selector. It keeps the `:hover` rules
  that set `display`, `visibility`, `opacity` or `pointer-events`, and the rules that hide. `cssHoverSubjects`
  (`hover-reveal.ts`) keeps a rule that applies now to an element another rule hides. It then finds the hovered element
  by writing `:hover` as the `data-piwi-hover-probe` attribute and setting it on ancestors until the rule matches. The
  attribute is removed before it returns, and is the only change made to the page.
- **Script.** `HoverTracker` follows trusted `pointerover` entries and a `MutationObserver`'s insertions (and the
  `style` / `hidden` changes that show an element). An element inserted soon after the pointer entered an ancestor,
  with no press in between, was revealed by that ancestor's hover.
- The step names the element the pointer entered the subject through, when the subject's own name includes what the
  hover shows (a row read as "Invoice 42Delete"), through the same verified locators as the click.
- An insertion in the same batch of mutations as the removal of an element the pointer is over is that element swapped
  for another (a link the page re-renders as the pointer enters it), which no hover reveals (`HoverTracker.mutations`).
  `hover-swap.html` is its case.

**In a replay.** Played with trusted input, a replay's hover is the browser's own. With the page's own events (Firefox,
a session refused or cancelled), it emulates CSS `:hover` (`hover-emulation.ts`):

- each document (the page, a same-origin frame) gets a constructed style sheet, or a `<style>` where one cannot be
  adopted, that repeats that document's `:hover` rules with the `data-piwi-hover` attribute in place of `:hover`;
- `hoverElement` sets the attribute on the element pointed at and its ancestors, and moves it with each step;
- everything is removed when the replay ends (`endHoverEmulation`).

`dispatchHover` (`replay-actions.ts`) calls `hoverElement` and sends the pointer events, following the element tree:
leaves for the ancestors the pointer left, enters for the ones it entered.

`hover.spec.ts` records, replays and runs the spec of each kind of reveal on `tests/e2e/pages/hover-*.html`.

## The IDE bundle

The IDE bundle, `record-ide.js`, is the recorder built a second time, for the editor service (`packages/editor`). The
editor's launcher starts a browser with the project's own Playwright, exposes the binding `__piwiRecorder` in every
page, then loads `record-ide.js` into every document. The names and the requests are in `@piwitests/core/ide-recorder`.

`buildIdeBundle({ outDir, release })` (`scripts/build.mjs`) writes it beside `record-ide-messages.json`: every catalog,
each message with its text and its placeholders' contents alone. The editor's `build.mjs` calls it to write both into
the editor's `dist/`. Neither file is part of `dist/` or `dist-firefox/`.

- **One recorder, another host.** `src/ide/record-ide.ts` imports `src/ide/host.ts`, then `record-panel.ts`. The build
  rewrites every `chrome` reference to `globalThis.__piwiIdeChrome`, which the host installs, read-only, over the
  binding:
  - `storage.local` and `runtime.sendMessage` are requests to the launcher;
  - there is no `storage.session`, so the recorder keeps its recording through `piwi-session-storage` and
    `piwi-append-recording-event`, as in Firefox;
  - `runtime.onMessage` keeps its listeners, which only the launcher's dispatch calls (`__piwiIdeDispatch`);
  - `i18n` answers nothing, since the launcher hands the editor's catalog under `piwiLanguage`;
  - `getURL` points at a reserved domain, so `isExtensionContext()` is false;
  - there is no `dom`.

  The page's own `chrome` is never touched. Without the binding the host installs nothing, and the recorder never
  starts. A `chrome` call the recorder starts making needs its answer in the host and in the launcher.
- **What differs is behind `IDE_BUILD`** (`src/shared/ide-build.ts`, the build constant `__PIWI_IDE__`). It is false in
  every bundle of the extension, where those branches fold away, and it is read in `record-panel.ts` alone:
  - the IDE bundle records the top-level document of an http or https page and nothing else (the launcher's script also
    runs in frames and in a new tab's `about:blank`);
  - Stop opens no review: capture stops, the HUD and the border go, and `piwi-recording-stopped` still goes out;
  - the HUD names the file from `piwiIdeSettings` (`record_hudTitleInto`);
  - its **Pause** goes to the launcher, which keeps the recording's `paused` for every page and tells the editor
    (`piwi-recording-paused`); the editor's Pause reaches the page through `__piwiIdeDispatch`;
  - the page refreshes no catalog.
- **The project's test id attribute.** `rankElement`, `verifiedLocators` (its engine) and the probe take
  `testIdAttribute`: from `piwiIdeSettings` in the IDE bundle, `data-testid` in the extension. A click snaps to an
  element carrying it, as to a control.
- **Tests**:
  - `ide-host.test.ts`: the request each `chrome` call makes, the recorder's storage over it, and nothing installed
    without the binding;
  - `ide-bundle.test.ts`: no `chrome` left in the built bundle, the build's global name equal to core's, the catalogs;
  - `record-ide.spec.ts` builds the bundle, answers the binding as the launcher does, and records across two pages of a
    plain browser.

  The extension's own specs keep covering the recorder.

## Playwright view

`playwright-view.ts` (**Playwright view** in the DevTools panel's toolbar, a toggle) labels every element a test could
reach with the role and name `DomModel` gives it, and its test id. It marks two kinds of element:

- **unreachable**: it looks operable (through a `tabindex`, an `onclick` or a pointer cursor its parent lacks) and has
  no role, or it has an operable role and no name; and it has no test id;
- **ambiguous**: its `getByRole(role, { name })` finds other elements on the engine.

How it works:

- The pure half is `playwright-view-scan.ts`: one engine per scan, in time slices. It counts what each `getByRole` would
  find from the elements grouped by role once (the name a case-insensitive substring, as Playwright matches it), not
  with a query per element.
- No two labels overlap. A draw adds every label hidden and reads their sizes in one layout. `placeLabels`
  (`label-layout.ts`, pure, unit-tested in `label-placement.test.ts`) puts each above its element, or shifts it a row at
  a time below or above, clear of the labels placed before it in page order. A label with no free place within a few
  rows is left out, and the panel counts those.
- The overlay redraws on scroll. It scans again once the page has been still for a moment after a change to its elements
  or to an attribute that can change a label (`observed-attributes.ts`, the list Tested elements follows too).
- It bridges its labels to `globalThis.__piwiPlaywrightView` for `playwright-view.spec.ts`, which also checks the counts
  against real Playwright.

## DevTools

`devtools_page` (`devtools.html`, `src/devtools/devtools.ts`) loads once per DevTools window. It adds the **Piwi** pane
to the Elements panel (`devtools-sidebar.html`, `src/devtools/sidebar.ts`) and the **Piwi** panel
(`devtools-panel.html`, `src/devtools/panel.ts`). DevTools pages are extension pages: they have `chrome.scripting`,
`chrome.permissions` and `chrome.storage` as well as `chrome.devtools`.

Both pages share:

- `src/devtools/devtools.css`: DevTools' own look (12px type, flat toolbars, the theme through the frame's color
  scheme, a transparent background);
- the helpers in `src/devtools/ui.ts`: buttons, empty states and their icons. `button()` there is the shared
  `makeButton` (`src/shared/buttons.ts`: an icon from `src/shared/icons.ts` and a tone), which `devtools.css` draws
  compact through its `data-tone` rules. A button of the HTML pages names its icon in `data-icon` and its tone in
  `data-tone`.

A step is drawn by `stepView`, an address by `urlView`, and a URL pattern or a site's address by `patternView`
(`src/shared/pattern-view.ts`), with `STEP_CSS` and `PATTERN_CSS` in the page's style.

### The Elements pane

- **The selection reaches the ranking through `inspectedWindow.eval`.** The pane injects `devtools-rank.js` into the
  inspected tab (`src/devtools/selection.ts`) and calls `__piwiRankSelected($0)` with `useContentScriptContext`. So `$0`
  arrives in the extension's isolated world as the same element the engine finds.
- The answer is plain data (`src/shared/devtools-selection.ts`), the element's copy facts included.
- With an editor paired, the top locator's **Send to editor** sends it in the last copy mode through
  `src/shared/editor-send.ts`, as the Pick results do. The sidebar's copies set that mode too.
- Firefox has no `useContentScriptContext`. There, `$0` is marked with an attribute in the page's world, and the content
  script is asked by message (unverified in Firefox so far).
- **Access** is the tab's `activeTab` grant or the origin's optional host permission. When injection fails on a web
  page, the pane offers **Allow on this site**, which requests that one origin inside the click. Reading the page's
  origin with a plain `inspectedWindow.eval` needs no permission.

### The Piwi panel: recording and replay

The Piwi panel (`src/devtools/panel.ts`, `panel-record.ts`, `panel-replay.ts`) mirrors the recording and the replay from
session storage (`RECORDING_KEY`, `REPLAY_KEY`) and redraws on `chrome.storage.onChanged`, so it needs no channel of its
own. Its buttons do what the in-page panels do:

- Stop is the popup's stop (`stopRecording` and `piwi-recording-stopped`).
- Pause, Continue and Stop write the replay state, then send `piwi-replay-wake` to the replayed site's tabs.
  `replay-panel.ts` answers by redrawing its panel, and:
  - with `wake: true` (Next step, Stop), by releasing its wait or keeping the wake for the next one;
  - with `wake: 'waiting'` (Pause, Continue, as the in-page panel's own do), by releasing only a wait in progress.

### Locators and Session

`panel-locators.ts` and `panel-session.ts`.

- **Locators** calls the DevTools content script (`__piwiDevtools.query`, `highlight`, `mark`, through
  `src/devtools/page-script.ts`).
  - It reveals a match by marking it with `data-piwi-devtools-reveal` (one element at a time), then running `inspect()`
    on it in the page's world, found in the document or an open shadow root, which needs no permission. A match that
    has left the page is said so.
  - Enter evaluates at once and keeps the expression in the console's history (`src/shared/locator-console.ts`, under
    `LOCATOR_HISTORY_KEY` through `sessionArea()`, so it outlives the panel). `HistoryCursor` walks the history with the
    arrow keys; the panel opened again shows the newest entry.
  - A locator that reads gets **Copy as** (each copy mode, through one `renderCopyMode` call given the match count and
    the first match's facts, which the query answers), **Add to session** (`session-form.ts`) and, with an editor
    paired, **Send to editor** (`editor-send.ts`, a `locator` payload in the copy mode chosen last). Each keeps the
    expression in the history too.
- The Session tab's page object and the Network tab's mock code have no Send to editor. The editor protocol
  (`@piwitests/core/editor-send`) takes a locator line or a steps document, and a block of code would need a kind of its
  own that the VS Code and JetBrains clients insert.
- **Session** reads the pick session (`SESSION_KEY`) and redraws when it changes.
- **Add to session has one path, `addNamedPick`** (`src/shared/session-add.ts`). It checks the name with
  `pickNameProblem`, appends `{ name, locator, pageUrl }` through `addSessionPick`, and answers the text the form shows
  for a refused name or a storage that failed. The DevTools pages (the Locators console, the Elements sidebar) open its
  form with `session-form.ts`. The Pick results (`results-panel.ts`) draw their own form in their shadow root, and call
  it after `ensureSessionAccess()`, as a content script must.

### The page tools in the toolbar

`panel.ts`, `runPageTool`. Pick, Lint, Tested elements and the Playwright view inject the popup's content scripts
(`pick.js`, `lint-overlay.js`, `coverage-overlay.js`, `playwright-view.js`) into `inspectedWindow.tabId` with
`injectContentScript`.

- A DevTools page holds no `activeTab` grant. So the click asks for the inspected origin (`requestSiteAccess`) before
  anything is awaited, from a pattern read ahead at open and on `onNavigated`. A site already granted answers without a
  prompt. Each such request also clears a parked recording intent.
- Refused, the notice offers **Allow on this site**. Any other failure says why (`injectionFailureText`).
- Tested elements is `aria-disabled`, with the popup's words as its tooltip, until an instance is connected and the
  inspected page resolves to a project (`resolveActiveProject`, read again on `piwiConnection`, on the site's override
  and on navigation).
- **Save login for tests** opens `login.html` in a tab of its own, for the inspected tab (`openSaveLogin`).
- The panel sets `html[data-ready]` once the tools know the page.

### Network and Mock this response

`panel-network.ts`, pure half `src/shared/mock-code.ts`.

- Requests come only from `chrome.devtools.network`: `getHAR` at open, then `onRequestFinished`. They are kept in the
  panel's memory, fetch and XHR only, and never leave the browser but through the user's copy or download.
- The list shows the inspected page's origin, read again when `onNavigated` reports a page on another one.
- A body comes through `responseBody`: Chrome's `getContent` calls back, Firefox's returns a promise.
- `mockCode` hides credential fields (`HIDDEN_VALUE`) unless revealed, and never writes a header.
- `devtools-network.spec.ts` runs the copied code as a test body against a real page.

### Slow down or fail a request

`panel-conditions.ts`, pure half `src/shared/request-conditions.ts`.

The panel asks for the page's origin inside the click, and sends `piwi-set-conditions` with:

- the requests' conditions;
- the whole page's network (`throttle`: fast 3G, slow 3G, offline);
- the CPU (`cpuRate`).

The worker sets them only on a tab that shows that origin, and keeps one tab's state in session storage
(`CONDITIONS_KEY`). Two paths apply them:

- **In Chrome and Edge** (`via: 'debugger'`, `cdp-conditions.ts`), the `Fetch` domain pauses every request of the tab
  and delays, fails or answers it while the tab shows the conditions' origin. `Network.emulateNetworkConditions` and
  `Emulation.setCPUThrottlingRate` throttle it. The Network tab's **Every kind** lists documents, scripts and images to
  put a condition on.
- **Without the protocol, or once its bar is cancelled** (`lost`, the throttling dropped), `via: 'page'`:
  `request-conditions-main.js` (main world) wraps `fetch` and XHR. Like the evidence script, it imports nothing that
  touches `chrome.*`.
  - It matches a relative URL as the browser resolves it (`document.baseURI`).
  - A fetch it holds back rejects as soon as its signal aborts.
  - An XHR it holds back counts its timeout from `send()`. It gets `loadstart` from the wrapper only when it never goes
    out (the browser fires its own for one that does). It ends on the page's `abort()`, with the events the browser's
    own fires, its upload's included, or on a new `open()`, which also drops an answer it gave.

Either way:

- the worker registers `request-conditions.js` (isolated) for that origin at `document_start`, and the main-world
  script only with `page`, and injects them into the tab now;
- the isolated script asks `piwi-get-conditions` (answered for that tab only), posts to the main world by
  `window.postMessage` what the wrapper applies (`forPage`, none with the protocol), and draws the banner;
- turning them off, or closing the tab, unregisters both and lets the session go; turning them off also reloads the tab;
- the Network tab's strip acts on the origin the conditions were set for. Once the page is on another origin, it names
  it and offers Turn all off alone;
- a replay started meanwhile carries the requests' conditions (`ReplayState.conditions`), and its panel lists them.

`request-conditions.spec.ts` drives both paths against a real server.

### Open this page at a viewport

**Viewport** in the panel's toolbar shows its bar (`src/devtools/panel-viewport.ts`). The inspected tab's address is
read in the page, since a DevTools page holds no `activeTab` grant.

- The sizes are the active project's `viewports` from the cached locator index, or typed by hand.
- `piwi-open-viewport` makes the worker create a window and grow it until the tab's `width` / `height` match.
- **In this tab** (Chrome and Edge) sends `piwi-set-tab-viewport` instead: `Emulation.setDeviceMetricsOverride` on the
  tab, through `emulateCssViewport`, kept under `piwiTabViewport` for the bar to show with **Back to the window's size**
  (`piwi-clear-tab-viewport`).
- In a spec, measure the tab through `chrome.tabs`, not the page: Playwright emulates its own viewport in the pages it
  drives (`viewport.spec.ts`).

### How DevTools is tested

- `devtools-sidebar.spec.ts`, `devtools-panel.spec.ts`, `devtools-network.spec.ts` and `devtools-tools.spec.ts` open the
  pages as tabs with `chrome.devtools` stubbed (`devtools-stub.ts`). `eval` runs in a fixture page's own world, where
  the spec adds the content script, and `$0` is that page's global.
- `devtools-replay.spec.ts` opens the Piwi panel the same way beside a replay of the real extension on a local site
  (`trusted-site.ts`). It checks that Pause and Continue from the panel never play a step waiting for Next.
- `devtools-real.spec.ts` launches Chromium with `--auto-open-devtools-for-tabs` and drives the real DevTools page
  through the browser's debugging port. It checks that the `devtools_page` loads and that `$0` reaches the ranking
  script.

## Content-script structure

Each standalone content-script feature (multi-pick, the lint overlay, the assertion suggester, the agent context, the
recording, the Test functions scan, and the others) is split in two:

- a **pure logic file**, such as `lint-scan.ts`, `assertion-suggest.ts`, `src/shared/session-export.ts`,
  `record-capture.ts` or `test-function-scan.ts`;
- a separate **entry file** that wires picking, the DOM and `chrome.*` calls around it, such as `lint-overlay.ts`,
  `assertion-panel.ts` or `record-panel.ts`.

Keep new features on this split rather than mixing pure logic into the entry file. It is what makes the logic half
testable with plain unit tests, or on the real bundle (see "Rules, with their reasons"), instead of needing a live
browser for everything.

**Every surface on the page gets its shadow root from `attachPanelShadow`** (`src/content/panel-root.ts`). It:

- keeps key and clipboard events inside;
- makes `[hidden]` win over the surface's own `display`;
- keeps the surface usable above a modal dialog the page opened. The dialog sits in the top layer and makes the rest of
  the page inert, so while one is open the surface lives at its end. The surface goes back to the document's root
  element when the dialog closes or leaves the page. A popover surface (the Tested elements overlay) and a dialog that
  lays out `position: fixed` children in its own box (a `transform`, a `filter`, containment) are left alone.

`picker-dom`'s overlay and anchors step mount inside an open modal dialog the same way. `modal-dialog.spec.ts` covers
it.

**A panel over the page with a backdrop is modal through `holdFocus`** (`src/content/modal-panel.ts`): `aria-modal`, the
focus on its first control, Tab kept inside, and the focus given back as it closes. These are the pick results,
multi-pick, Assertions, Context for an AI agent and Test functions.

**A panel that leaves the page usable is a landmark, not a dialog**: `role="region"` with its translated name as
`aria-label`, and a close button with an accessible name. These are the lint overlay, the Playwright view and the
Tested elements panel. A bar that stays on the page beside it (the recording bar, the bug report bar) is also
`role="region"` with a translated `aria-label`, never a dialog, and anything it animates stops under
`prefers-reduced-motion: reduce`.

**A copy button goes through `copyWithFeedback`** (`src/shared/clipboard.ts`, in extension pages too). It falls back
to the copy command when the clipboard API refuses, shows Copied or Not copied for a moment, and brings the button's own
label back however often it is clicked.

**The Action and Assertion copy modes write what the element calls for.** `renderCopyMode`
(`src/shared/copy-modes.ts`) stays pure. It takes the locator and `ElementFacts`, plain data read from the element where
it is at hand (`elementFacts`, `src/content/element-facts.ts`):

- Action: `fill` with the field's value (a placeholder for an empty field, or for one `isSensitiveField` masks),
  `check`, `selectOption`, else `click`;
- Assertion: the first of `assertionsFor` (`assertion-suggest.ts`, the Assertions dialog's own list). A locator finding
  several elements asserts `toHaveCount`.

The in-page panels pass the facts to `copyModeButtons` (`copy-mode-row.ts`, `copyFacts`). The Elements sidebar gets
them in the ranking `devtools-rank.ts` answers. Each button names the method it writes: "Action (fill)".

## Buttons, icons and readable steps

Every surface (the in-page panels, the popup, the settings, Save login, DevTools) is built the same way. So a button is
found by its icon and its color before its words are read, and a step reads at a glance.

- **Every button has an icon** from `src/shared/icons.ts` in front of its label. `ICONS` holds outline glyphs on a
  24 × 24 grid, drawn in `currentColor` and built as DOM, so no page's policy can block them.
  - An icon-only button (a panel's close ×) carries its label as `aria-label` and tooltip.
  - A new icon goes into `ICONS` in the same style, its box centered on the grid (`icons.spec.ts` measures every
    glyph). Never SVG markup written elsewhere, an icon font or an image.
  - An icon lands on whole pixels. Its size is even (16 in a button, 14 in a small one and in a step badge), and so is
    what is left of its box around it. A row it sits in with text has a line height in whole pixels.
- **A button is made by `makeButton(label, onClick, { icon, tone, small, iconOnly, title, className })`**, or given the
  same look by `styleButton` when made elsewhere (a link included), from `src/shared/buttons.ts`. It is styled by
  `BUTTON_CSS` in the panel's `<style>`: a panel does not style its own buttons. An HTML page names the icon in
  `data-icon` (and the tone in `data-tone`) and calls `decorateIcons()` after `localizeDocument()`, which writes the
  texts.
- **The tone says what a button does:**
  - `primary` (violet): the surface's main action, one per group;
  - `success` (green): what completes or goes on with a flow (Finish, I did it, continue);
  - `danger` (solid red): what stops what runs (Stop);
  - `remove` (red text): what discards or takes away (Discard, Remove, Unpair, Disconnect), set apart at the end of its
    row;
  - `neutral`: any other, its icon in the accent color;
  - `ghost`: a close button or a small inline action.
- **A verdict, a warning or a status line leads with its icon** (`check-circle`, `alert`, `x-circle` and the others) in
  its color, and a count is a badge.
- **A label changes through `setLabel`**, never `textContent`, which drops the icon. A copy goes through
  `copyWithFeedback` (and a passing text through `flashLabel`), which keeps the icon and flashes a check or a cross.
- **A step is shown by `stepView(step)`** (`src/shared/step-view.ts`, its look in `STEP_CSS`): a badge by kind of action
  (going somewhere, acting, typing or choosing, checking, by hand) and its words, with the quoted names, the typed
  value, the key, the test ids, the addresses and the locators set apart.
  - The parts come from core's `describeStepInParts`, which knows each part as the phrasebook writes the sentence.
    Never read them back out of `describeStepInWords`, nor show that sentence as bare text or with its backticks
    stripped. A plain caption joins the parts' texts.
  - A sentence that is no step and names a locator, an address or a quoted text (why a step failed, a verdict) goes
    through `richText` (`step-view.ts`, built on `sentenceTokens` in `sentence-tokens.ts`, unit-tested).
  - An address alone goes through `urlView` (origin and query dimmed, path in front), and a URL pattern or a site
    through `patternView` (`src/shared/pattern-view.ts`, its wildcards set apart).
- **Colors are dark first, with the light scheme's colors under `prefers-color-scheme: light`**, as custom properties
  set on the surface's root. A surface dark in both schemes puts `piwi-dark` on an ancestor.

## Rules, with their reasons

- **Content scripts are separately bundled IIFEs, not ES modules.** An IIFE (immediately invoked function expression)
  is a classic script that runs on load and needs no module loader. `scripts/build.mjs` builds each one with Vite's
  library mode, so that `chrome.scripting.executeScript` or a `registerContentScripts` registration (see "How content
  scripts are injected") can inject it as a plain script. Don't add a shared runtime chunk between them: each must stay
  self-contained at the bundle level. Imports are fine at the _source_ level; Vite inlines them per entry.
- **The recorder's host permission is requested per origin and per recording, from the popup's own click handler:
  never pre-granted, never `<all_urls>`.**
  - `chrome.permissions.request` only counts as satisfying a user gesture when called synchronously inside one. So it
    can't move into `background/index.ts` (see `startRecordingFlow` and `requestRecording` in `src/popup/main.ts`).
  - But on a first-time grant, the prompt that request shows _takes focus and closes the popup_. That kills the code
    that would have messaged the worker to start, which is why a first recording used to need a second click.
  - So the popup parks a `RecordIntent` (origin and tab, in session storage) inside that same click. The worker's
    `chrome.permissions.onAdded` picks it back up when the grant lands, and starts the recording itself.
  - Both starts (the popup's own message when it _does_ survive, and the `onAdded` fallback) go through
    `startRecordingOnce`, which dedupes.
  - `decideRecordIntent` (pure, unit-tested in `recording-storage.test.ts`) keeps the fallback from firing on an
    unrelated grant (the settings page granting the instance origin fires the same event) or on a stale intent.
  - A Deny reaches no code. So the intent is cleared when the popup opens again, by each origin request of the settings
    page (`requestOrigins`), and by each DevTools request for a site (`requestSiteAccess`, right after the request
    call): the next grant of that origin is not the recording's. `record-intent.spec.ts` grants the site from
    `chrome://extensions`, which fires the real `onAdded`.
  - A recording covers the one origin granted at start. Navigating to a different origin mid-recording is a known,
    documented limit (see "Limits" in `apps/docs/features/extension.md`), not a silent gap. A future phase could detect
    it and prompt to expand, but that also needs a fresh user gesture, which the HUD (a content script, with no
    `chrome.permissions` access) can't provide on its own either.
- **Every text the extension shows comes from the catalogs** (`public/_locales/<code>/messages.json`) through `t()` /
  `tn()` / `tNodes()` in `src/shared/i18n.ts`.
  - The HTML pages (`popup.html`, `options.html`, `login.html`, `devtools-panel.html`, `devtools-sidebar.html`) name
    their keys in `data-i18n*` attributes, which `localizeDocument()` fills.
  - A page or script calls `await initI18n()` once before its first text, for the Language setting's override.
  - A new message goes into every catalog in the same change, English with a `description`. See `i18n/README.md` for
    the rules `locales.test.ts` enforces.
  - `no-hardcoded-text.test.ts` fails on text written straight into the UI, in every file of `src/`.
  - Translated text reaches the page as text (`textContent`, `tNodes`) or through an escape helper, never as raw HTML.
  - A content script that paints on injection ends with `void initI18n().then(start)` (bundles are IIFEs, so there is
    no top-level await), or runs `initI18n()` beside the storage reads it already awaits. Each panel sets `lang` from
    `uiLanguage()` on its root inside the shadow DOM.
- **Reuse `@piwitests/picker-dom`'s exports** (`installPickerOverlay`, `showAnchorPicker`, the probe, role resolution,
  syntax highlighting) rather than re-deriving picker logic here. That package exists so this workspace doesn't become a
  third hand-synced copy. Its texts are English unless the host gives them: pass `strings: pickerOverlayStrings()` /
  `anchorPickerStrings()` (`src/content/picker-strings.ts`, from the catalogs) once `initI18n()` has run.
- **A locator is always rendered through `highlightLocator`, inside a `.piwi-loc` element, in a panel whose `<style>`
  includes `LOCATOR_SYNTAX_CSS`, never as bare `textContent`.** The token colors live in that stylesheet (dark first,
  with a light-scheme override), because a panel that flips to a white background needs a different palette, which
  inline colors can't express. A chip that stays dark in both schemes (anything floating over the page rather than
  sitting in a panel) adds `piwi-loc-dark` to opt out of the light override. Panel text carrying a verdict or accent
  color (`.verdict`, `.score`, `.unique`, `.warn` and the others) needs its own `@media (prefers-color-scheme: light)`
  entry for the same reason.
- **`chrome.storage.session` needs `setAccessLevel` to be reachable from a content script.** It defaults to
  extension-page and service-worker access only. `src/background/index.ts` widens it once at startup
  (`TRUSTED_AND_UNTRUSTED_CONTEXTS`), so that `recording-storage.ts` and the replay can read and write it directly from
  a content script, in Chrome. Firefox has no such call, which is why every access goes through `sessionArea()` (see
  "Session storage from a content script"). `chrome.storage.local` (the connection settings, the catalog cache) has no
  such restriction, which is why no secret goes there: the API key and the tokens are in the extension's IndexedDB (see
  "Where secrets are kept").
- **Two test strategies for content-script logic; pick one deliberately.**
  - **Rebuilt from its source.** A function built entirely from nested helpers, with no imports from
    `@piwitests/core`'s scoring engine (`derivePattern`, `repeatedContainers`, `testCatalogAgainstPage`), can be
    re-serialized with `Function.prototype.toString()` in a test. Any genuine cross-module dependency is installed as a
    global first.
  - **Driven through the real built bundle.** A function that calls `generateAlternatives` (`scanForLintIssues`,
    `suggestAssertions`, `buildAgentContext`, `record-panel.ts`'s `deriveRecordedTarget`) can't be rebuilt: that
    function's own private module-level helpers don't survive the rebuild and aren't exported one by one. Those are
    tested by loading the real bundle (`page.addScriptTag`), then either reading a well-known `globalThis.__piwiXxx`
    the entry file bridges a result out to (`lint-overlay.ts`, `assertion-panel.ts`, `agent-context-panel.ts`), or, for
    anything backed by `chrome.storage` (`record-panel.ts`), reading state back out of a stubbed `chrome.storage`
    installed with `context.addInitScript` (see `record.spec.ts`).

  Don't reach for a rebuild if the feature touches `generateAlternatives` or `chrome.*`.
- **`record.spec.ts`'s cross-page test stubs `chrome.storage` on top of `window.name`, not on a plain in-memory
  object** (`tests/e2e/recording-stub.ts`). `context.addInitScript` runs again on every new document, which would reset
  an in-memory stub on each navigation. `window.name` is one of the few things a real browser tab keeps across a
  same-tab navigation (even cross-origin). So it is the only way to fake storage that survives navigating to the next
  page without a real extension permission grant in the test.

## Loading it locally

`npm run extension:dev` rebuilds on every change, but the browser runs a new build only once you click reload on the
extension's card in `chrome://extensions` (see "Loading it locally" in `AGENTS.md`).

**`scripts/dev.mjs` guards against two runaway cases; keep both.**

- It rebuilds only when a watched path's mtime or size differs from when the last build started. On Windows, `fs.watch`
  also reports access-time changes, so the build's own reads used to start the next build, and one save rebuilt until
  the process ran out of memory.
- Each build runs in a child process (`node scripts/build.mjs`), because Vite keeps memory from every build run in one
  process (several MB a rebuild, never released).

**Until that reload, the worker runs the old build.** The popup and every tool opened come from the new build, read
from disk each time, while the worker still runs the build that was loaded. So a message only the new build knows goes
unanswered.

- Every bundle carries a build stamp (`src/shared/build-id.ts`, set by `scripts/build.mjs`), and `piwi-ping` answers
  with the worker's.
- When the two differ, the popup shows a notice with a **Reload Piwi Picker** button (`chrome.runtime.reload()`).
- A tool reports an unanswered message as that cause (`outdatedWorkerMessage()`, `src/shared/worker-status.ts`) rather
  than as a generic failure.

`worker-build.spec.ts` covers it end to end. Like any spec that reloads the extension, it launches with Developer mode
on (`launchWithExtension(path, { developerMode: true })`), since Chromium enables a reloaded unpacked extension again
only then.
