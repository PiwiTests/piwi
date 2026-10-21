# Piwi Picker: a UX and feature audit of the browser extension

An audit of the Piwi Picker extension (`apps/extension/`) at v0.58.0: the toolbar popup, the dialogs and bars it draws on the page, the overlays, the DevTools pane and panel, the settings page, and how all of it connects to a Piwi instance, the desktop app and the editors. It records what a tester and a developer meet today, finding by finding with the file behind each, and ranks the changes by what they buy.

**Status.** Proposed 2026-10-21, against `main` at v0.58.0. Nothing of §12 is built; the defects of §11 are open. A pull request that builds part of §12 updates this paragraph.

**Summary.** Ten findings lead (§0): an element inside an open shadow root cannot be picked; on a grid of cards the best locator offered is `.first()`, because the ranking never scopes to a repeated container by its text; one element needs four tools and four picks, with two vocabularies for one ranking; the common pick costs two dismissals and copies `.click()` whatever the element; a recording cannot be paused, titled, edited or replayed before export; the dashboard cannot hand the extension a task; site grants accumulate unseen; nothing introduces the extension on install; the bars are pinned to one corner; Firefox ships untested. §12 ranks 33 changes: fifteen one-file quick wins, then container narrowing and shadow DOM picking, then one element card for the pick results dialog and the Elements sidebar, then a request channel from the dashboard.

This document is written for the maintainers. The extension already does more than any locator tool for Playwright: it ranks locators and checks them on the live page, records a flow across pages into a spec, turns a reproduced bug into a failing test with its evidence, replays it with trusted input, and shows which elements a project's tests reach. That is exactly why the remaining gaps matter: every one of them is a step a person takes several times a day.

Every finding carries a file reference. Findings marked **(seen)** were observed first-hand on the built extension (`npm run extension:build`, then Chromium driven through the e2e fixtures: `popup.html` and `options.html` as extension pages, the DevTools pages with `chrome.devtools` stubbed as `devtools-panel.spec.ts` does, the fixture shop page of `tests/e2e/pages/shop.html` for the in-page tools, and the real background worker on a local site through `tests/e2e/trusted-site.ts` for the recorder, the bug report and the replay) and not only in the code.

One name per concept, used throughout: the **popup** (the toolbar popup, `popup.html`); the **pick results dialog** (what Pick an element opens, `src/content/results-panel.ts`); the **anchors step** (the "Scope to stable parents" list between the click and the results, `packages/picker-dom/src/overlay-anchors.ts`); the **recording bar**, the **bug report bar** and the **replay bar** (the boxes at the bottom right of the page while one runs); the **review panel** (after Stop, `renderReviewPanel`) and the **finish panel** (after Finish, `renderBugFinishPanel`); the **Tested elements panel** (`src/content/coverage-panel.ts`); the **Elements sidebar** (the Piwi pane beside Styles in DevTools, `src/devtools/sidebar.ts`) and the **Piwi panel** (the DevTools panel with five tabs, `src/devtools/panel.ts`); the **settings page** (`options.html`); the **instance** (a Piwi dashboard the extension is connected to), the **desktop app** and the **editor** (VS Code or a JetBrains IDE with the Piwi plugin).

---

## 0. The ten findings that matter most

1. **An element inside an open shadow root cannot be picked.** The hover overlay reads `event.target` in a capture-phase listener on the document (`packages/picker-dom/src/overlay-element.ts`, `onMove`), which the browser retargets to the shadow host, so the chip, the highlight and the click all land on the host. The recorder (`deepTarget`, `src/content/record-panel.ts:369`, built on `composedPath()`), the in-page engine (`createPageEngine`, open shadow roots included) and Playwright's own `getByRole` all see inside. Any product built on web components (Lit, Shoelace, Ionic, Vaadin, Salesforce LWC) gets a locator for the wrapper instead of the button. The docs state it as a limit (`apps/docs/features/extension.md`, "Limits"); it is the one limit a tester hits on the first page of such an app.

2. **On a grid of cards, the best locator offered is `.first()`.** For the Blue mug's Add to cart button on the fixture shop, the pick results dialog offers `getByRole('button', { name: 'Add to cart' }).first()` (score 20, "breaks when their order changes") above three ambiguous ones, although the card carries `data-testid="product-card"` and a heading "Blue mug", and the project's own test uses `getByTestId('product-card').filter({ hasText: 'Blue mug' }).getByRole('button', { name: 'Add to cart' })`, which is the locator of "catalog › adds a mug to the cart", the first of the three tests the same dialog lists above the locators under "Reached by 3 tests". `narrow()` in `src/content/verified-locators.ts:363` scopes a locator only to an ancestor that `scopeCall` finds **alone** (a unique test id, a named dialog or row, a landmark); a repeated container narrowed by its own text, Playwright's documented pattern for lists and cards, is never tried. The anchors step cannot do it either: it counts the leaf matches of a parent by role, so the card "contains 2 matching elements" (the heart button counts), and the lint overlay then advises `data-testid="button-1"` to `button-4` for the four buttons where the right advice is the card scope. The Tested elements panel's At risk tab, on the same page, does build `getByRole('article').filter({ hasText: 'Blue mug' }).getByRole('paragraph')` for the price, so the pieces exist. **(seen)**

3. **One element, four tools, four picks, two vocabularies.** Pick an element, Assertions, Agent context and (in DevTools) Add to session each start with the same hover-and-click and end with a dialog nobody can get to from the others (`src/content/pick.ts`, `assertion-panel.ts`, `agent-context-panel.ts`, `src/devtools/sidebar.ts`). To get an `expect(…)` for the element whose locators are on screen, the person closes the dialog, opens the popup, chooses Assertions and picks again. The pick results dialog and the Elements sidebar render the same ranking (`CheckedLocator`) with different feature sets: the dialog has Send to editor and the tests reaching the element, the sidebar has Add to session, neither has the assertions; the dialog shows a bare score in a pill (`20`, `90`) under a title that says "most stable first" with the 20 above the 90, the sidebar shows words (`unique by position · could break: position`, `4 matches · stable`, each after an icon). **(seen)**

4. **The common pick costs two dismissals it does not need, and copies code that ignores the element.** Every pick of an element with a role opens the anchors step (`src/content/pick.ts`: `if (role) showAnchorPicker(…)`), a modal list to Skip even when the top-ranked locator already finds the element alone; the results dialog must then be closed before the next pick. With the shortcut, a locator costs four interactions, two avoidable; there is no "click, it is copied" mode. What Action and Assertion copy is `.click()` and `.toBeVisible()` for every element (`src/shared/copy-modes.ts`), a text field, a checkbox and a select alike, while `assertion-suggest.ts` knows the right matcher and lives in another tool. **(seen)**

5. **A recording cannot be paused, titled, edited or replayed before it is exported.** The recording bar has Stop and the two checks; Pause exists only in the IDE build (`IDE_BUILD` gates it, `src/content/record-panel.ts:525-558`, and the `record_pause` texts ship in every catalog). The review panel lists the steps read-only, the spec is always titled `recorded flow` (`packages/core/src/codegen.ts:790`), and Replay is wired to bug reports alone (`lastRecordedReport` requires `mode === 'bug'`, `src/content/replay-panel.ts:1564`) although `piwi-start-replay` takes any steps document. A login or a cookie banner recorded by accident is removed by hand in the editor. **(seen)**

6. **The dashboard cannot hand anything to the extension.** The extension links into the instance in four places (`src/shared/instance-links.ts`); nothing goes the other way. The bug report page's Reproductions tab says "Replay in Piwi Picker plays the steps in a developer's own tab" and offers no button (`apps/application/app/pages/bug-reports/[id].vue:269`); the Locators page tells the person to go and use Copy all; the Test Map's gaps cannot be shown on the live page. The extension already runs a script on the instance's pages (`src/content/instance-marker.ts`), which by design reads nothing: a one-way marker where a narrow, confirmed request channel would close the loop. Since v0.57.0 a failed execution's Export menu offers **Bug report (.piwibug)** and **Steps (steps.json)** for Replay (`apps/application/app/components/shared/ExportMenu.vue`): a download or the clipboard, then the chooser in the extension, four hops where a request would be one, and the first bridge in that direction.

7. **Site permissions accumulate and are never shown.** Record actions, Replay, the Elements sidebar and the request conditions each grant one origin for the life of the install (`chrome.permissions.request` in `src/popup/main.ts`, `src/devtools/inspected.ts`); `chrome.permissions.remove` is called only for the instance, the editor and the desktop app (`src/options/main.ts:974`, `:1111`, `:1258`). The listing says "one site, asked for when you start recording on it"; the settings page has no list of those sites and no Revoke, so the only way back is `chrome://extensions`. **(seen)**

8. **Nothing introduces the extension.** `chrome.runtime.onInstalled` only refreshes the language catalog (`src/background/index.ts:107`). A new install opens on a popup of ten tiles whose five compact ones carry their explanation in a `title` attribute only (`popup.html`, `.tile.compact`), invisible to the keyboard and to touch, and a dashed note saying the developer tools are "in DevTools, in the Piwi panel", which is where the AGENTS guide says developers live. The docs gained screenshots of the popup, a pick, the lint overlay, a recording and the Piwi panel in v0.58.0 (`apps/docs/features/extension.md`, `devtools.md`); the extension itself still shows none of that to a new install. **(seen)**

9. **The bars cannot be moved or collapsed, and four surfaces share one corner.** The recording bar, the bug report bar and the replay bar are pinned at `inset: auto 16px 16px auto` (`record-panel.ts` `renderHud`, `bug-panel.ts:896`, `replay-panel.ts:428`); the Playwright view panel sits at `bottom: 12px; right: 12px` (`playwright-view.ts`) and the Tested elements panel docks right by default. A page with a chat widget or a cookie banner in that corner loses it for the whole recording (the fixture shop's "Chat with us" box sits exactly there), and the Tested elements panel is the only surface with a dock toggle and a collapsed pill (`coverage_dock`, `coverage_collapse`). **(seen)**

10. **Firefox ships with no automated coverage, and its DevTools path is unverified.** The Firefox listing promises the same tools; `reusable-e2e-extension.yml` runs Chromium only, the AGENTS guide notes that the message fallback for `useContentScriptContext` is "unverified in Firefox so far" (`src/devtools/inspected.ts`), and five specs name Firefox only to stub its API shapes. Every Firefox-only branch (`sessionArea()`, the page-world evidence script, the port-less host patterns, the HAR without `_resourceType`) is checked by reading, not by running.

The rest of this document is the evidence behind these, the smaller findings, the defects seen on the way (§11), and, in §12, the changes ranked by what they buy.

---

## 1. Method

Four sweeps of the code: the popup and the settings page (`src/popup/`, `src/options/`, `popup.html`, `options.html`); the in-page tools (`src/content/`, 57 entry and logic files, plus `packages/picker-dom`'s overlays, which the reporter and the dashboard share); the DevTools pages (`src/devtools/`); and the worker and the shared code (`src/background/`, `src/shared/`), with the five language catalogs read as the complete inventory of what the extension can say (1,071 keys in English). The user-facing docs (`apps/docs/features/extension.md`, `devtools.md`, `extension-connection.md`, `tested-elements.md`, `report-a-bug.md`, `replay-a-bug-report.md`, `bug-reports.md`) were read as the intended design, and the dashboard's side (`apps/application/app/components/shared/PickerInstallHint.vue`, `CompanionToolsCard.vue`, the bug report and locators pages, `server/api/extension/*`) for what crosses between the two.

Then a walk through the built extension, at v0.56.0 first and again at v0.58.0 after `main` moved: the popup standalone and connected, the settings page in both states, the five tabs of the Piwi panel with a stubbed network log, the Elements sidebar on a selected button, the pick flow on the fixture shop (hover, anchors step, results), the lint overlay, the Playwright view, multi-pick, Assertions, Agent context, the Tested elements panel on its At risk tab, and, with the real worker on a local site, a recording and its review panel, a bug report with a marked step and its finish panel, the replay chooser and a replay that reproduces the bug.

Not covered: Firefox and Edge (not run), the IDE bundle (`src/ide/`, which belongs to the editor record, `adr/suite-in-the-editor.md`), the generated spec's quality beyond its title and the recorded steps, and the Chrome Web Store and AMO listings as pages.

---

## 2. The journeys today

Each row is a step a person takes, what the extension gives them there, and where it stops short.

### A tester wants a locator for one element

| Step | What the person has | Where it stops short |
|---|---|---|
| **Open the tool** | The toolbar icon or `Ctrl+Shift+E`; the popup names the key actually bound (`renderPickShortcutHint`). | The shortcut goes straight to picking, the popup needs a second click on the tile. Nothing on a first install says that the shortcut exists but the footer line. |
| **Point at the element** | A highlight that snaps to the actionable ancestor, a chip with `<tag> locator` pinned to the element, the same locator in the banner, ↑/↓ to walk the tree, Esc to cancel, the banner moving out of the way (`overlay-element.ts`). The chip shows the ranked locator within a millisecond and the checked one once the pointer rests (`HOVER_REST_MS`). | Mouse only: a focused element cannot be picked from the keyboard. An element inside an open shadow root cannot be reached at all (finding 1). A hidden or zero-size element is never hoverable, and there is no "pick the parent of what I clicked" after the fact. |
| **The anchors step** | For an element with a role, a list of the ancestors with a stable hook, a live match count for the selection, Use or Skip. | Shown on every such pick, even when the ranking already has a unique candidate (finding 4). Its texts say "standard alternatives only", a phrase from the engine, not from the person's task. **(seen)** |
| **Read the results** | Up to eight locators, most stable first, each checked on the page: unique, narrowed (exact, `filter({ hasText })`, a landmark, a dialog, a row, a test id scope), by position, or ambiguous with its count; a score pill; a "Best choice" line under the first row; Copy all for the Locators page; with a connection, the tests that reach the element, inside it and around it, with their status, and the brittle locators among them. | The element itself is no longer outlined (the overlay is removed before the dialog opens, `pick.ts`), and the dialog covers the middle of the page. Three copy buttons repeat on every row, 24 buttons for eight locators. The score is a number with no scale on screen. No Add to session, no assertions, no "pick another". **(seen)** |
| **Use it** | Copy as locator, action or assertion; Send to editor when paired, inserted at the cursor. | Action is always `.click()`, Assertion always `.toBeVisible()`. The last copy mode is remembered, but copying still takes a click per locator; nothing copies the best one on pick. |

### A tester records a flow into a test

| Step | What the person has | Where it stops short |
|---|---|---|
| **Start** | Record actions asks for the site's access inside the click and survives the prompt closing the popup (`RecordIntent`); a red border marks the tab, REC on the badge. | The grant stays forever (finding 7). A recording started on the wrong page cannot be trimmed later. |
| **Record** | Clicks, double clicks, fills, checks, selections, drags, file names, submit and navigation keys, hovers a click depends on, across the site's pages; secrets never captured; the bar shows the count, the last locator, the matching test functions, Check an element and Check the address. | No Pause (finding 5). The bar is fixed at the bottom right (finding 9). The steps are not listed while recording (the Piwi panel in DevTools lists them, the bar does not). Another origin ends the capture silently for that page, as documented. |
| **Stop and review** | The steps in words, the matched functions, Copy as TypeScript with or without the functions, Download steps, Send to editor, Discard. | Read-only: no delete, no title, no test id attribute choice, no fixture import. No Replay to check the recording before exporting. The spec arrives titled `recorded flow`. |

### A tester reports a bug, a developer replays it

| Step | What the person has | Where it stops short |
|---|---|---|
| **Report** | The same recorder with Mark what's wrong (the element, what it shows, what it should), Something is missing, Wrong page, Screenshot; evidence through the debugging protocol in Chrome (console, failed requests, screenshots, one per step) with the page-world script as the fallback everywhere else; the bar says why Chrome shows its debugging banner. | The step list in the bar shows the last six only and cannot be edited, and a mark cannot be changed after Add to the report. The expected value field opens prefilled with the page's value and refuses it unchanged (`bug_sameAsPage`), which is right. **(seen)** |
| **Finish** | A title, the steps with their marks, the evidence summary, a box to leave the step screenshots out, Copy failing test, Copy report, Download `.piwibug`, Replay, Send to Piwi… with a preview per kind of evidence, Discard. | The screenshots are counted, not shown: the tester decides to share them without seeing them. No thumbnails, no per-screenshot exclusion. **(seen)** |
| **Replay** | A chooser with the report just recorded, a `.piwibug` or steps file, the text of a steps file pasted in, or the project's open reports from the instance; a `.piwibug` exported from a failed execution on the dashboard (v0.57.0); Start from this page; Step by step; a step that opens a new tab followed there (v0.57.0); a cursor and a caption per step; trusted input in Chrome; a hand-over with the step's screenshot when a step cannot be played; a verdict with what the page showed; Share result…; Run with Playwright… through the desktop app. | The developer who received the report on the instance has to open the site, open the popup, choose Replay, then find the report in a select (finding 6). The replay bar grows with the hand-over box and has no collapse. |

### A developer in DevTools

| Step | What the person has | Where it stops short |
|---|---|---|
| **Select a node** | The Piwi pane ranks it on every selection change and after navigation, with the verdict and the stability rules in words, Copy as locator, action or assertion, Add to session; Allow on this site the first time. | No Send to editor, no tests reaching the element, no assertions, no agent context (finding 3). Nothing in a frame. Firefox unverified (finding 10). |
| **Try a locator** | The Locators tab: a strict-mode verdict, the elements found with their role and name, an outline on hover, Reveal in Elements. | No history, no copy, no Add to session, no Enter-to-reveal; the field is cleared when the panel is reopened. |
| **Stub the network** | The Network tab: fetch and XHR calls, Mock this response as `page.route` code with hidden secrets and a file for large bodies, Slow down, Fail with 500, Fail (network error), whole-page network and CPU throttling. | One request at a time: no "mock these five as a fixture", no download of the bodies as files for a test's `mocks/` folder. |
| **Set the page up** | Viewport from the project's own runs or typed, in a new window or in the tab; Playwright view; Save login for tests. | Pick, Lint and Tested elements still need the popup, which closes DevTools' focus on each use. |

---

## 3. The popup

The popup is a launcher: ten tiles in a 480-pixel column, an Active project row once connected, a note about DevTools and a footer with the bound shortcut and a docs link (`popup.html`, `src/popup/main.ts`). It must fit Chrome's 600-pixel cap in German, which `popup.spec.ts` checks, so every new tool has gone under **More tools** as a compact tile.

**What works.** The Record and Report a bug tiles change with the recording's state (Stop recording (n), Finish bug report (n), Review recording, Take a screenshot), so the popup doubles as the status line. The tile of the tool running on the page gets a ring and `aria-current` (`highlightActiveTool`), read live from the page rather than from a copy that could go stale. The footer shows the key the browser actually bound, or a link to set one. A worker that predates the build gets a notice with a Reload button. The digit keys run the tiles without the mouse, and a modified digit is left to the browser.

**3.1 The compact tiles explain themselves only on hover.** Multi-pick, Assertions, Lint overlay, Agent context and Test functions carry their one line of help in a `title` attribute (`popup.html`, `data-i18n-title`), so a keyboard user, a touch user and a screen reader never get "2–3 items → a list" or "Summary for an AI", and the labels alone ("Agent context", "Lint overlay") name the mechanism, not the task. The two big tiles say what they are for ("Ranked, stable locators", "Across pages → a test"); the arrow glyph is the only hint of a sequence. **(seen)** Give every tile its line, or drop the compact mode once the pick-driven tools merge (§4.1); until then, `aria-describedby` on a visually hidden copy of the hint.

**3.2 The popup never says whether the connection works.** `refreshActiveProjectSelect` reads `ConnectionSettings` from storage; `isConnected` deliberately never looks at the key (`src/shared/connection-settings.ts`). A key revoked in the dashboard, an instance that moved, or a grant removed in `chrome://extensions` show up as `common_projectKeyRejected` inside Tested elements or Test functions, after a tool was opened, and the popup keeps offering "Automatic (found from the page address)". The worker already learns of every failure in `project-refresh.ts` and `bug-reports.ts`. Keep the last outcome per instance (`ok`, `unauthorized`, `unreachable`, with a time) in `chrome.storage.local`, show it as one line under the Active project row with a Reconnect link to the settings, and turn the settings pill from "Connected" into "Connected · key rejected".

**3.3 No first run.** `chrome.runtime.onInstalled` refreshes the language catalog and nothing else (`src/background/index.ts:107`). The Chrome Web Store sends people to a popup that says nothing about DevTools beyond a dashed note, nothing about the shortcut beyond the footer, and nothing about what "Tested elements" needs until the tile is clicked (which then opens the settings page with no way back to the page). Open a one-page welcome on install: the three flows in one line each with a screenshot, the shortcut, "Open DevTools and look for the Piwi tab", and Connect as the optional last step. The same page answers the `?` button the popup lacks.

**3.4 The key legend is in render order, not in order of use.** Record actions is `1`, Pick an element is `2` (`KEY_TO_ACTION_ID`), the flows are letters (`B`, `R`, `T`) and the rest digits. The primary tile, drawn in the accent color, is not the first key. Small, but it is what every tile shows in its corner. Either make `1` the primary tile or let `Enter` run it.

**3.5 Ten tiles for six tasks.** Pick an element, Assertions and Agent context are one pick followed by three different renderings of the same element; Multi-pick is a pick with a second element; Test functions is a check of the connected catalog against the page. Once the element card (§4.1) carries locators, assertions, the agent block and the session, the popup needs six tiles: Pick, Record, Report a bug, Replay, Tested elements, Lint, with Multi-pick and Test functions as entries under the two tools they belong to (Pick: "a list of similar items"; Tested elements: "which of your functions work here"). Two rows, every tile with its line, no More tools.

---

## 4. The dialogs on the page

### 4.1 The pick results dialog

The dialog (`src/content/results-panel.ts`) is the extension's main product: a centered 640-pixel box over a backdrop with the ranked, checked locators, each with a score pill, the locator highlighted, three copy buttons (Locator, Action, Assertion), Send to editor when an editor is paired, a verdict line (`✓ Finds exactly one element…`, `⚠ Finds 3 elements…`), "Best choice" under the first row, Copy all in the header, and, connected, a section with the tests that reach the element, inside it and around it, the brittle locators among them, and links into the instance. Esc, the close button and a click outside close it; Tab moves between rows; focus is held inside (`holdFocus`).

- **The copy buttons repeat per row.** Each row draws a Copy label and the three joined mode buttons (`src/content/copy-mode-row.ts`), 24 buttons for eight locators, 32 with an editor paired, for a mode that is panel-wide anyway (`activeMode` is one value, every row marks it). **(seen)** One mode selector in the header (a three-way segmented control, remembered as today) and one Copy per row, plus a click on the locator text itself to copy, reads at a glance and keeps the keyboard path (Tab to a row, Enter copies).
- **No locator scoped to a repeated container.** `narrow()` (`verified-locators.ts:363`) tries an exact name, a text filter on the element itself, then an ancestor that `scopeCall` finds alone; a container that repeats (a card, a row without a name, a list item) is skipped because `getByTestId('product-card')` finds four. The missing rung is the scope narrowed by its own distinguishing text, `getByTestId('product-card').filter({ hasText: 'Blue mug' })` or `getByRole('article').filter({ hasText: 'Blue mug' })`, checked for uniqueness like the others (finding 2). The engine already counts `filterRoleCount` for anchors with a `filterText` (`engineStructure`), so the text to filter by is at hand: the ancestor's heading or its first short text node. **(seen)**
- **The order and the title disagree.** Verified locators come first, by position included, then the ambiguous ones by rank; the title says "most stable first" and the pills show `20` above `90`. **(seen)** A by-position locator belongs among the ambiguous ones with its warning, or the title should say "finds it alone first".
- **The score is a number without a scale.** `score.textContent = formatNumber(alt.score)` with the explanation in a tooltip. The Elements sidebar renders the same `CheckedLocator` as words through `verdictText` (`src/devtools/sidebar.ts`): `✓ unique · stable`, `✓ unique by position · brittle: position, CSS class`. The words come from the stability rules (`@piwitests/core/locator-stability`, `stabilityRulesText`), which is what a person can act on; the number is the engine's. Use the sidebar's words in the dialog and keep the number as the tooltip.
- **Action and Assertion ignore what the element is.** `renderCopyMode` (`src/shared/copy-modes.ts`) writes `.click()` and `.toBeVisible()` for every locator. For a text field the action is `fill('…')`, for a checkbox `check()`, for a select `selectOption('…')`, for a link `click()`; `assertion-suggest.ts` already derives `toHaveValue`, `toHaveText`, `toHaveAccessibleName` from the element. Make Action role-aware (the role is in `rankElement`'s result) and let Assertion take the top suggestion; the mode labels then read "Action (fill)" and "Assertion (toHaveText)".
- **The element disappears behind the dialog.** `removePickerOverlay()` runs before `renderResultsPanel` (`src/content/pick.ts`), so the highlight goes, and the dialog sits over the middle of the page. The person reads eight locators for an element they can no longer see. Keep a thin outline on the element while the dialog is open (the Tested elements layer draws boxes under its panel; the same `CoverageLayer` or a one-box version does), and offer the dialog docked to a side like the Tested elements panel, remembered per site.
- **No Add to session, no assertions, no agent block.** The named-picks session is reachable only from the Elements sidebar (`addSessionPick` is imported in `sidebar.ts` alone); the assertions and the agent block need a new pick each (finding 3). The dialog and the sidebar should render one **element card** with tabs: **Locators** (as today), **Assertions** (the suggestions, with the chosen matcher and value editable), **Tests** (the connected section), **For an agent** (the block). Add to session and Send to editor sit in the card's header. `devtools-selection.ts` already turns the ranking into plain data for the sidebar; the card takes that data in both places.
- **No way to pick the next element.** Closing the dialog and reopening the popup (or the shortcut) is the only path. A **Pick another** button and `N` key restart the overlay without the popup; with the dock, the card stays open and updates on each pick, which is how a tester works through a form.
- **Keys.** `pick_tabHint` says "Tab moves between rows"; add `1`-`8` to copy row n in the current mode, `Enter` for the top row, `A` to add to the session.

### 4.2 Multi-pick

Two or three picks, a bar between picks (Pick one more, Find the pattern, ×), then a dialog of the rows' shared locators with a by-position warning (`src/content/multi-pick.ts`). It works as described and the bar is a good pattern: a non-modal strip at the bottom that keeps the page usable. On the fixture shop, two Add to cart buttons in two cards derive `getByRole('button').nth(2)` and `.nth(4)` with the by-position warning (`derivePattern`, `multi-pick-derive.ts`, works from the picked leaves and their shared leaf locator): the pattern a test wants is the repeating ancestor, `getByTestId('product-card')` with the button inside it, which the two picks share and the derivation never looks for. **(seen)** It lacks Add to session and Send to editor, and the pattern it derives would be a natural "Tests" row too (how many tests use `getByRole('row')` on this page). Fold it under Pick as a second mode ("Pick a list") rather than a tile of its own.

### 4.3 Assertions

`suggestAssertions` (`src/content/assertion-suggest.ts`) offers five matchers: `toHaveValue`/`toHaveValues`, `toHaveText`, `toHaveAccessibleName`, `toBeVisible`. On the shop's "Free shipping from 30 €." paragraph it also offers `toHaveAccessibleName('Free shipping from 30 €.')`, which fails in Playwright: a paragraph takes no name from its content, and the name here is the probe's approximation that `deriveTopLocator` falls back to when `DomModel` finds none (§11, defect 3). **(seen)** Missing for the elements a test checks most: `toBeChecked` for a checkbox or radio (explicitly out of scope in the file's comment), `toBeDisabled`/`toBeEnabled`, `toHaveCount` for a list pattern, `toContainText` for a long text, `toHaveURL` and `toHaveTitle` for the page. The bug report's Mark dialog takes the three value choices from `suggestAssertions` and adds the two state pairs (`expectedChoices`, `bug-panel.ts:521`), and the recording's Check an element reuses it (`check-panel.ts`), so a checkbox can be marked visible or usable but never checked. Core already defines `toContainText`, `toHaveCount` and `toBeChecked` (`packages/core/src/recording.ts`, v0.57.0) and the replay plays them (`replay-core.ts`); no dialog offers them. One assertion catalog in `@piwitests/core` (matcher, label, applies-to, value reader) would serve Assertions, Check an element, Mark what's wrong and the Assertion copy mode.

### 4.4 Agent context

One English block with the page, the element, its attributes and the checked locators with their notes (`src/content/agent-context.ts`), addresses written as a bug report writes them. Right for its purpose. Connected, it could carry the Tests section (which tests already reach the element, their status), which is what an agent asked to "write a test for this" needs most; and a second rendering as Markdown for a ticket costs nothing. Low priority on its own; it comes for free as a tab of the element card.

### 4.5 Test functions

Ready, partly found, not on this page, per function, with a Refresh past the TTL and a link to manage the catalog (`src/content/test-function-panel.ts`). Clear. A ready function has no action: a **Copy call** (`await login(page, …)`, from `codegen`'s call rendering) would turn the check into a start. It belongs under Tested elements, which answers the same "what do my tests have for this page" question.

### 4.6 The review panel (after Stop)

Steps in words with the matched function badges, Copy as TypeScript (with or without the functions), Download steps, Send to editor, Discard (`record-panel.ts:628`). What is missing is everything a person wants to change before exporting:

- **Pause.** The IDE build pauses with `record_pause`/`record_resume` and `piwi-recording-paused` (`record-panel.ts:525-558`, behind `IDE_BUILD`); the extension build has the texts and not the button. Logging in, dismissing a banner, or fetching a value from another tab are all recorded today.
- **Delete a step, edit a value.** The list is read-only. A mis-click or a typo in a field becomes a step in the spec.
- **A title and a file.** `renderSpec` takes `options.title` and the extension never sets it, so every spec is `test('recorded flow', …)` (`packages/core/src/codegen.ts:790`); Download steps names the file by the time. One text field at the top of the panel, prefilled from the first page's title, fixes both and feeds `steps.title`.
- **Replay before export.** `piwi-start-replay` takes any steps document and `replay-panel.ts` plays a plain recording as well as a bug report, but the review panel has no Replay button and the chooser's "Use the bug report recorded in this browser" requires `mode === 'bug'` (`lastRecordedReport`). Replaying a recording is the one check that the locators hold; the replay lab (`tests/lab/`) exists because they sometimes do not.
- **Which test id attribute.** The extension ranks with `data-testid` unless the IDE settings say otherwise (`testIdAttribute` in the IDE bundle only). A project on `data-test` or `data-cy` gets `getByTestId` candidates for the wrong attribute, and the index's `testIdAttributes` is read only by Tested elements. The connected project's attribute should feed `rankElement` everywhere; standalone, a setting.

### 4.7 The bug report bar, the Mark dialog and the finish panel

The bar lists the last six steps, offers Mark what's wrong, Something is missing, Wrong page, Screenshot (with a debugging session), Finish, and sums up the evidence with a line explaining Chrome's debugging banner (`bug-panel.ts:896`). The Mark dialog names the element by its first locator, offers what to check (value, text, name, visible, hidden, usable, grayed out), shows what the page shows, and asks what it should show, refusing a value equal to the page's (`bug_sameAsPage`). The finish panel adds a title, the steps with their marks, the evidence summary, a box to leave the step screenshots out, three exports, Replay, Send to Piwi… and Discard, and warns when nothing is marked.

- **A mark cannot be revisited.** Once added, a step's expected value, note or matcher is fixed; removing it means Discard and start over. The finish panel's step list is the place to edit or remove a marked step, and to add a note after the fact.
- **The screenshots are counted, not shown.** `bug_stepShotsHint` says "they show the whole page: leave them out if it shows what should not be shared", and the tester decides on a count. A strip of thumbnails in the finish panel and in the send preview, each with its own box, is the honest version of that choice. The data is already in the worker's IndexedDB (`shared/step-views.ts`).
- **Six steps in view.** `.steps { max-height: 150px }` with the last six; a bug after fifteen steps is reviewed in the finish panel only. A "Show all" that expands the bar, or the collapsed pill of §5.6, keeps the bar small by default and complete on demand.

### 4.8 The replay chooser and the send preview

The chooser offers the report just recorded, a file, the text of a steps file pasted in (v0.57.0), or the project's open reports; Start from this page; Step by step (`replay-panel.ts:1577`). A failed execution exported from the dashboard replays the same way, the steps the run did not keep enough of handed over as manual steps, with the verdict "Failed at step N, as in the test run" (v0.57.0). The send preview lists one box per kind of evidence, a box to leave typed values out, the Jira box when the project files there, and says once what connected mode sends. Both are right. Two small things: the chooser's file input accepts a drop nowhere but on itself (a drop zone over the dialog is cheap), and "Run with Playwright…" when the desktop app is not paired opens a dialog that says to pair first with a link to the options (`replay_desktopNotPaired`), which is fine, but the same dialog could start the pairing (the settings page's Pair is a `chrome.runtime.sendMessage` away).

---

## 5. The overlays and the bars

### 5.1 The hover overlay

`installPickerOverlay` (`packages/picker-dom/src/overlay-element.ts`) is shared with the reporter's failure-time picker and the dashboard's snapshot picker, so it must stay self-contained; the extension plugs the real ranking in through `__piwiDescribeElement`. It is good: the banner docks away from the element, the chip is pinned to the element, the checked locator replaces the estimate once the pointer rests, the page's own click handlers are suppressed so a pick never navigates.

- **Open shadow roots** (finding 1). `onMove` reads `e.target`; `onClick` reads `current()` from that chain. `e.composedPath()[0]` gives the inner element in both, and `buildChain` has to walk out through `host` when `parentElement` is null. The probe's counts and `checkLocators` already run on a shadow-aware engine. The anchors step's `leafMatches` walks `scope.querySelectorAll`, which does not pierce, so it needs the same engine or a shadow-walking count.
- **Keyboard picking.** The overlay has ↑/↓/Esc and nothing to pick without a pointer. `Enter` should pick the element the chain points at, and with no chain the document's active element, so a person can Tab to a control and pick it; the same path serves a one-pixel icon button that is hard to hover.
- **Zero-size and hidden targets.** An element that only exists on hover of another (a menu) is handled by the recorder's hover tracking, not by the picker: the pick dismisses the menu as the pointer leaves it. An "arm the pick on the next click, keep hover menus open" variant (`pointerdown` picks, `mousemove` is ignored) is a one-flag change and what DevTools' own picker does.

### 5.2 The anchors step

Shown for every element with a role (`pick.ts`), it lists the ancestors with a hook and recounts the selection live. On the shop's Add to cart button it lists five parents, three of them grayed as "no stable hook, add a data-testid to make this usable", the card as "contains 2 matching elements" (the leaf count is by role, so the heart button counts) and `main` as "contains 8": nothing a person can use, and the useful narrowing (the card filtered by its heading) is not among them. When the top candidate is already unique, which the engine knows before the step opens (`checkLocators` could run on `alternatives` first), the step is pure cost: a modal to Skip. **(seen)** Open it only when no candidate finds the element alone, or when the person asks for it from the element card ("Scope to a parent…" expands the same list in place). Its texts should say what the person gains ("Narrow it to a parent: the form, the dialog, the row") rather than "standard alternatives only".

### 5.3 The lint overlay

Red dashed boxes on every interactive element no stable locator finds alone, a panel with the list and a Markdown checklist, truncated at 800 elements with a note (`src/content/lint-scan.ts`). On the shop it flags the four Add to cart buttons, which share a name, and suggests `data-testid="button-1"` to `"button-4"` **(seen)**: the cards already carry `product-card`, and the advice a developer needs is "scope by the card", not four new attributes. The suggested test ids are `button-1`, `button-2`, numbered by discovery order within the role: a name no one would commit, and one that changes when the page reorders. The finding has the accessible name and the nearest label at hand; a slug from them (`add-to-cart`, `newsletter-email`, with the role only as a fallback) turns the checklist into a patch. The overlay also stops at interactive roles (`INTERACTIVE_ROLES`); a heading or a region that tests assert on is never linted, which is right for "hard to target" and worth saying in the panel.

### 5.4 The Playwright view

Labels with the role and name `getByRole` sees and the test id, red for unreachable, amber for ambiguous, counts and a role filter, rescanned when the page settles (`src/content/playwright-view.ts`). It is the clearest answer to "what does a test see here" and the one tool of the popup's DevTools note that v0.58.0's docs screenshots leave out. Two things hold it back: the labels are placed at each element's top left with no collision handling, so a header's three links or a row of five star buttons overwrite each other into one strip (§11, defect 5) **(seen)**; and its panel sits in the same corner as the bars (§5.6). Labels that stack when they collide, or that show for one element's siblings on hover and for all on request, keep dense pages readable.

### 5.5 The Tested elements overlay and panel

The richest surface: a panel with the branch, the index's age, This page or All pages, three tiles, a meter, four tabs with a filter, the display toggles and a legend; boxes with test counts on the page; a pinned card per element with its locators, tests and a replacement for a brittle one; Limit to an element with ↑/↓; a collapsed pill; dock left or right. **(seen)** Three observations:

- The not-connected text still describes the API-key setup (`coverage_notConnected`: "add the address of your instance, an API key and an address pattern") while Connect is the one-step path and the key is the fallback. Text drift.
- The count badges are drawn at each element's top right and overlap on dense rows (the three nav links in the docs screenshot read `1 1 1` as one cluster). A badge that merges with its neighbor into `+2`, or sits inside the box when the box is wide enough, keeps dense pages readable.
- The panel's status line "41% of the 34 interactive elements" is the number a team would track; it is not exported anywhere. Copy as Markdown (the three tiles, the untested list) gives the overlay a place in a review.

### 5.6 The bars

The recording bar (260 to 340 pixels), the bug report bar (360) and the replay bar (380) are fixed at the bottom right; the Playwright view panel and the lint panel are fixed too; only the Tested elements panel docks and collapses. On a page with a support widget, a cookie banner or a sticky checkout bar in that corner, the person loses it for the whole recording and the bar hides what the recording is about. **(seen)**

- Give the three bars the Tested elements panel's dock (left or right) and collapse (a pill with the count and the pulse), remembered per site in `chrome.storage.local`, and let them be dragged by their title.
- The recording bar does not list the steps; the Piwi panel in DevTools does. The collapsed pill with the count, and the expanded bar with the last steps as the bug report bar has them, make the two bars consistent.
- The recording bar's pulse has no `prefers-reduced-motion` rule (`.dot` in `renderHud`, `record-panel.ts`), while the red frame around the tab has one (`record-panel.ts:436`) and the bug report bar's dot has one (`bug-panel.ts:923`).
- The replay bar's hand-over box adds the step's screenshot, up to three locators and three buttons under the full step list; on a laptop it runs past the viewport with no scroll of its own. A `max-height` with the step list scrolling, as the bug report bar does, keeps the buttons reachable.
- All of them hide during a step screenshot (`hideSurfaces`) and mount inside an open modal dialog so they stay usable above it (`panel-root.ts`): both are right and worth keeping as the bars move.

---

## 6. DevTools

The DevTools pages are drawn in DevTools' own idiom: 12-pixel type, flat toolbars, the frame's color scheme (`src/devtools/devtools.css`). `devtools_page` adds the Piwi pane to Elements and the Piwi panel (`src/devtools/devtools.ts`); both reach the page through `inspectedWindow.eval` in the extension's isolated world and inject `devtools-rank.js` on demand, asking for the site's access with **Allow on this site** when they cannot (`src/devtools/inspected.ts`, `selection.ts`, `page-script.ts`).

### 6.1 The Elements sidebar

Select a node, read its locators: the role and name as the heading, each locator with its verdict in words and its stability rules, **Copy as** Locator, Action, Assertion, and **Add to session** (`src/devtools/sidebar.ts`). It ranks again on every selection change and after a navigation; Refresh ranks the same node on the page as it is. **(seen)** It is the fastest way to a locator in the whole extension, because DevTools' own picker (`Ctrl+Shift+C`) selects what the pointer is on and the pane answers without a click.

- It is the pick results dialog with a different feature set: no Send to editor, no tests reaching the element, no assertions, no agent block (finding 3); the four actions repeat per row as the dialog's three do. The element card (§4.1) belongs here first.
- An element in a frame is refused (`devtools_inFrame`), with the advice to use Pick an element, which refuses it too (one frame at a time, `apps/docs/features/extension.md`). Playwright's `frameLocator` prefix is derivable from the frame element's own locator; the engine already evaluates frame chains (`locator-engine.ts`, `frameLocator()`).
- Firefox: the message path replacing `useContentScriptContext` (`hasContentScriptContext`, `RANK_MARKED_MESSAGE`) has never been run (finding 10).

### 6.2 The Piwi panel

Five tabs and a toolbar (`devtools-panel.html`, `src/devtools/panel.ts`). The panel mirrors session storage and redraws on `chrome.storage.onChanged`, so Record and Replay follow the page across navigations with no channel of their own; a dot on the tab says which runs. **(seen)**

- **Record** lists the steps as they are captured, with each step's locator, and after Stop offers Copy as TypeScript, Download steps and Discard (`panel-record.ts`). It is the only place the steps of a running recording are listed. It has the review panel's limits (§4.6): no Pause, no edit, no title.
- **Replay** lists the steps with their results, the driver and the conditions, and the verdict; Pause, Continue, Next step and Stop reach the page (`panel-replay.ts`). Complete.
- **Network** lists fetch and XHR requests (every kind on request, in Chrome), one selected request as `page.route` code with hidden credentials, a file for a large body, Answer with a server error or a network failure, and under it Slow down, Fail with 500, Fail (network error), with the whole page's network and CPU throttling in the toolbar (`panel-network.ts`, `panel-conditions.ts`, `src/shared/mock-code.ts`). Three gaps for a test author: a mock is one request at a time, so stubbing a page's five calls is five copies; the bodies cannot be saved as fixture files in one go (`mocks/cart.json` is offered only past 100 kB); a POST mock matches the method and the pattern, never the request body, so two POSTs to one endpoint get one answer. Multi-select with one block of routes and a zip of the bodies is the feature; body matching can wait.
- **Locators** is a console with a strict-mode verdict, the matches with role and name, an outline on hover and Reveal (`panel-locators.ts`). No history (the expression lives in a module variable and is lost when the panel is reopened), no Copy as, no Add to session, no Send to editor, no Enter to reveal the first match, no completion of `getBy…`. A locator typed here is often the one the person is about to paste into a test; the card's actions belong under the field.
- **Session** lists the named elements, copies them as a page object, a Markdown table or JSON, and clears them (`panel-session.ts`, `src/shared/session-export.ts`). The class is always `PickedElements`; names cannot be edited after adding; there is no Send to editor although the page object is the one thing a person writes in the editor next.
- **Toolbar**: Viewport (the project's sizes from the index, or typed, in a new window or in the tab), Playwright view, Save login for tests. The tools that need the page (Pick, Lint, Tested elements) are not here; a developer keeps DevTools open and loses focus to the popup each time. Three buttons calling `injectContentScript` give DevTools the whole set.

### 6.3 Save login for tests

A page of its own (`login.html`) that asks for the `cookies` permission inside Save, reads the site's cookies and localStorage once, downloads `user.json`, and shows the `storageState` snippet and the `.gitignore` line. Right and well explained. It names the file `user.json` while the snippet says `playwright/.auth/user.json`; the download could carry the folder in its name, and the setup test it mentions is in the docs, not on the page.

---

## 7. Connectivity

### 7.1 The instance

**Connect** is a device authorization: the instance origin is requested inside the click, a code is shown on both sides, the tab closes itself, the key is created for that user and kept in the extension's IndexedDB with the origin it was given for (`src/options/main.ts`, `connect-flow.ts`, `secret-store.ts`). The instance's URL patterns are read on connect and each time the settings open, kept per project with environment, branch and the two path prefixes, and overridden per browser and per site (`active-project.ts`). **(seen)** This is the strongest part of the connection story, and the privacy line under the settings says what is sent in one paragraph.

- The popup and the settings never report a connection that stopped working (§3.2).
- One instance at a time. A team with a staging and a production instance switches by Disconnect and Connect, which also drops the browser-only patterns (`disconnectBtn` clears `piwiConnection` whole), every site's Active project and every branch choice. Keeping the browser-only lines across a reconnect to the same origin is cheap; two instances is a larger change and can stay a limit.
- `coverage_notConnected` and `functions_noProject` still describe the setup in API-key terms (§5.5).

### 7.2 From the dashboard to the extension

Everything crosses one way: the extension deep-links into the Locators page, a test case, a bug report and the catalog (`src/shared/instance-links.ts`); the dashboard suggests installing the extension on three pages (`PickerInstallHint.vue`) and stops once the marker script says it is there (`usePickerInstallHint.ts`). Since v0.57.0 a failed execution's Export menu offers **Bug report (.piwibug)** and **Steps (steps.json)** for Replay (`ExportMenu.vue`; `apps/docs/features/replay-a-bug-report.md`, "A report made from a test run"): the person downloads or copies, opens the site, opens Replay from the popup and chooses the file or pastes the text. It is the first bridge in this direction, and it shows the shape of the gap: four hops where one request would do. What the dashboard still cannot do is hand the extension a task (finding 6). Five places want it:

| On the dashboard | The request | What the extension does |
|---|---|---|
| A failed execution, beside its `.piwibug` export | **Replay in Piwi Picker** | opens the project's site (from its URL patterns) and the chooser with the export already loaded |
| A bug report's page | **Replay in Piwi Picker** | opens the project's site and the replay chooser with that report chosen |
| A test case or a Test Map gap | **Show on the live page** | opens the page and Tested elements limited to the element or the page |
| The Locators page, a chain selected | **Find it on the live page** | opens the page, outlines what the chain finds (the Locators console's `highlight`) |
| A failure with locator healing | **Pick a replacement on the site** | opens the page with the pick overlay; the result goes back as the healing pick does from the snapshot |

The channel can stay as narrow as the privacy rules require: the dashboard page dispatches a `CustomEvent` on `document` (`piwi-picker-request`, with `{ kind, projectId, bugReportId | pageUrl | locator }`); `instance-marker.ts`, which already runs on the instance's pages, relays it to the worker; the worker keeps it as an intent (as `RecordIntent` is kept, with a short TTL) and shows it in the extension's own UI, a badge and a line in the popup ("Piwi asks to replay bug #37 on shop.example.com: Open"), or a Chrome notification with Open; nothing runs before that click, and the intent names only a report id or a page, never a script. The marker script keeps reading nothing from the page; it listens for one event and forwards its fields after checking them field by field, as `readRelayedEntry` does for the evidence relay. The instance's origin is the only one it runs on, so the request can only come from the instance the person connected.

### 7.3 The desktop app

Pairing shows a code in the app's window and hands the token over on Allow, the token goes only to an app that proves it holds it, and Run with Playwright… shows the payload before Send (`src/options/main.ts`, `desktop-repro.ts`, `desktop-run-panel.ts`). **(seen)** The desktop app is also a Piwi instance, the same server on a loopback address, and a developer who uses it as their instance has to pair twice: once under Desktop app, once under Connect to Piwi with the token pasted as an API key (`apps/docs/features/extension-connection.md`, "So does the desktop app"). After a successful pairing, offer **Use it as your Piwi instance too** (one click: the same address and token through `setInstanceApiKey`, then the pattern sync), and after connecting to a loopback instance, offer the pairing.

### 7.4 The editor

Send to editor works from the pick results dialog and the review panel (`src/content/results-panel.ts`, `record-panel.ts`), nowhere else: not from the Elements sidebar, the Locators console, the Session tab's page object, the Network tab's mock code, the Assertions dialog or multi-pick. When an editor is paired, every Copy should have a Send to editor beside it; the payload kinds (`@piwitests/core/editor-send`) take a locator or steps today and need a `code` kind for a block.

Pairing is the odd one out: the person runs a command in the editor, copies an address with a token, and pastes it in the settings (`options_editorHint`), while the instance and the desktop app pair by a code and an Allow. The editor service listens on loopback with a token already; a pairing request from the extension (`POST` to a pairing path, the editor shows the code and Allow) is the same shape as the desktop app's (`apps/application/shared/desktop-pairing.ts`) and removes the copy-paste.

### 7.5 Site permissions

Every grant is one origin, requested inside a click, which is right. What is missing is the list: the settings page has no card for the sites the extension may run on, so a tester who recorded on ten sites over a month has ten standing grants and no idea (finding 7). `chrome.permissions.getAll()` gives the list; a card with one Revoke per origin, and a note under Record actions saying "Piwi Picker may already run on this site", closes it. Revoking the instance origin on Disconnect is already done.

### 7.6 What the instance knows and the page does not show

Connected, the pick results dialog shows the tests reaching the element with their last status and the brittle locators among them. The instance knows more about that element: a failure cluster open on one of those tests, the replacement locator healing proposed, the auto-heal PR opened for it. None of it reaches the page, where the developer is looking at the element in question. The index carries the test's status; a `healing` entry per locator (the proposed replacement and its confidence, from `locator-healing.ts`) would let the dialog say "failing in CI since Tuesday; Piwi proposes `getByRole(…)`", with the link it already builds.

---

## 8. Efficiency

### 8.1 Interactions per task

| Task | Today | After the changes in §12 |
|---|---|---|
| A locator for one element, copied | popup, tile, click the element, Skip the anchors step, Copy: **5** (4 with the shortcut) | shortcut, click: **2** with the quick-copy mode; 3 with the card |
| An assertion for the element just picked | close, popup, Assertions, click the element again, Copy: **5** | Assertions tab, Copy: **2** |
| Locators for five elements of a form | 5 × (popup, tile, click, Skip, Copy, close): **30** | shortcut once, then click, copy per element with the docked card: **11** |
| A test without the login steps | record everything, export, delete the steps in the editor | Pause before logging in, Resume after |
| Replay a report received on the instance | open the site, popup, Replay, choose the report in the select, Replay: **5** | Replay in Piwi Picker on the report's page, Open: **2** |
| Replay a failed execution from the dashboard | Export, download, open the site, popup, Replay, choose the file, Replay: **7** | Replay in Piwi Picker beside the export, Open: **2** |
| A named page object from DevTools | per element: select, Add to session, type a name, Save; then Session, Copy: **4n + 2** | the same, with Send to editor instead of Copy and paste |

### 8.2 Runtime

- The hover path is engineered well: a ranked candidate under a millisecond on each move, the check on the page once the pointer rests (`HOVER_REST_MS`), the engine's indexes built once per scan (about 45 ms at 3,000 elements, `src/content/verified-locators.ts`). Nothing to change.
- Scans run in time slices with `keepGoing` (lint, Playwright view, Tested elements) and start over when the page changes under them; the lint stops at 800 interactive elements and says so. Right.
- The pick results dialog runs a full coverage scan of the page for its Tests section on every pick (`scanCoverage(index, document, …)` in `fillPiwiSection`, `results-panel.ts`). On a large page with a large index the section arrives seconds after the locators, and a second pick on the same page scans again. The Tested elements overlay keeps its scan until the page changes (`pageVersion`); the dialog and the overlay could share that scan through the isolated world's `globalThis`, as they already share the scope request.
- Caches: catalogs and locator indexes revalidate past a 60-second TTL in the background; the index cache keeps three projects within 4 MB (`catalog-cache.ts`, `locator-index-cache.ts`). The index is downloaded whole and evaluated whole; a page-keyed slice (`pages` is in the index) would make the first load on a large project proportional to the page. Later.
- Session storage holds the recording and is written on every keystroke (`RecordingState`); the evidence and the step screenshots are kept apart so that the rewrite stays small, and a full quota is reported in the bar (`record_storageFull`). Right.

### 8.3 Development loop

`npm run extension:dev` rebuilds on save; the browser still needs a manual reload, and the popup detects a worker older than the build and offers Reload (`worker-status.ts`). The replay lab (`tests/lab/`) is the one tool that measures the recorder and the replay against a real app, and it is not in CI by design. Both are good; the lab's table deserves a line in `PUBLISHING.md`'s release loop so a release never ships a recorder regression the lab would have caught.

---

## 9. Accessibility, languages, browsers

- **Dialogs** carry `role="dialog"`, an `aria-label`, a focus trap and focus return (`src/content/modal-panel.ts`); every panel sets `lang` from the interface language; copy buttons announce Copied or Not copied (`clipboard.ts`). Good.
- **The hover overlay is mouse-only** (§5.1): no keyboard pick, no pick of the focused element.
- **The compact tiles' hints are hover-only** (§3.1).
- **The lint panel and the Playwright view panel use `role="dialog"`** while being non-modal boxes with no focus management (`lint-overlay.ts`, `playwright-view.ts`); `role="region"` with the same label describes them.
- **Reduced motion** is honored by the pick results dialog and the bug report bar, not by the recording bar's pulse (§5.6).
- **Color** carries verdicts with words beside it everywhere; light and dark schemes are both handled, in the page surfaces through the `prefers-color-scheme` overrides the AGENTS guide requires. Good.
- **Languages**: five, two reviewed, three marked as drafts with a link to correct them, every text through the catalogs with a test that fails on a hardcoded string (`no-hardcoded-text.test.ts`), the bug report written in the interface language with the code left alone. Exemplary. The agent block stays English by design.
- **Browsers**: Chrome and Edge from one store listing, Firefox from AMO. Firefox has no debugging protocol, so trusted input, CDP evidence, throttling and the in-tab viewport fall back, and the extension says so each time (`FallbackReason`). What it lacks is the run: no Firefox job in CI (finding 10). Playwright cannot load an extension in Firefox; `web-ext run` with a Marionette or WebDriver BiDi client, or Puppeteer's Firefox with `installExtension`, can, and the popup, the settings, the pick flow and the recorder's storage path are enough for a first job. Safari is a non-goal (a packaged Xcode app) and should be said so in the docs' install section.

---

## 10. What works and must stay

- **One tool at a time, Esc cancels, the popup shows which runs** (`src/shared/tool-session.ts`, `highlightActiveTool`).
- **Locators checked on the page before they are shown**, narrowed when they find several, with the count when they still do (`checkLocators`), and the same engine used by the hover, the dialog, the sidebar, the console, the lint and Tested elements, differentially tested against real Playwright (`locator-engine.spec.ts`).
- **The privacy model**: no network from a content script, one origin per grant asked inside a click, secrets in IndexedDB away from content scripts, a preview before anything is sent, a first-time explanation, and the debugging protocol attached only while a feature runs and said so in the bar.
- **The recorder's secret handling** (never a password, a card number or a one-time code; the spec reads them from the environment) and its capture of what Playwright needs (hovers a click depends on, files by name, drags, keys).
- **The replay's hand-over**: a step that cannot be played goes to the person with the step's screenshot, the element outlined, and three honest choices.
- **The Tested elements panel**: This page vs All pages, At risk with a checked replacement and Copy the change, Limit to an element, dock and collapse.
- **The worker-outdated notice, the state-aware Record tile, the bound shortcut in the footer**: small things that remove whole classes of "it does nothing" reports.
- **The evidence through the debugging protocol**, with the page-world script as the fallback and the bar saying which one is on.
- **The catalogs**: five languages and a test that fails on hardcoded text.

---

## 11. Defects seen during the audit

Logged here because `plans/exploration-findings.md` is local to a checkout. Each was observed on the built extension at v0.56.0 and again at v0.58.0, where every one still shows.

1. **A replay lists each request and console error twice.** After a bug report recorded and finished on the local site, Replay from the chooser with "Use the bug report recorded in this browser" ends with "What the page showed during the replay" reading `POST /api/cart/coupon-fail?code=<redacted> answered 500` twice and `Console error: Coupon failed: 500` twice, for one click (`replay-panel.ts`, `evidenceLines`; the entries come from `bug-evidence-main.js` through `relayEvidence`). Likely two instances of the evidence script in the page, the one the recording injected into the already-loaded document and the one the replay registered, both relaying with a token the replay accepts, or one relay stored twice; not traced.
2. **The bug report bar says "no screenshot" right after a mark that took one.** After Add to the report, the bar's evidence line read `no screenshot · 1 console error · 1 failed request · page outline` and still read so three seconds later, while the finish panel then counted `2 screenshots`. The bar is redrawn from the recording's events before the worker's screenshot is stored, and `updateBugHudEvidence` does not reach it in time or at all (`bug-panel.ts:872`).
3. **Assertions suggests `toHaveAccessibleName` for a paragraph.** On "Free shipping from 30 €." (a `<p>`), the dialog offers `toHaveAccessibleName('Free shipping from 30 €.')`. A paragraph's role takes no name from content, so Playwright computes an empty name and the assertion fails. `suggestAssertions` reads `accessibleName` from `deriveTopLocator`, which falls back to the probe's `approximateAccessibleName` when `DomModel` has none (`verified-locators.ts`); the suggestion must require the model's name.
4. **"4 locators, most stable first" lists a 20-point locator above a 90-point one.** The list is ordered by verdict (unique and by position first, then ambiguous by rank), as `checkLocators` documents, and the title and the score pills say otherwise. The title should say what the order is, or the by-position row should rank among the ambiguous ones with its warning.
5. **The Playwright view's labels overwrite each other on dense rows.** In the shop's header, `link · Products`, `link · Deals` and `link · Account` overlap into one unreadable strip, and the five star buttons read `bu| bu| bu| button · 5 stars`. Labels are placed at each element's top left with no collision handling (`playwright-view.ts`, `draw`).
6. **Multi-pick on two "Add to cart" buttons in two cards derives `getByRole('button').nth(2)` and `.nth(4)`.** The repeating ancestor (`article[data-testid="product-card"]`, four of them) is the pattern a test wants; `derivePattern` (`multi-pick-derive.ts`) works from the picked leaves and their shared leaf locator only.
7. **`coverage_notConnected` describes the API-key setup**, while Connect is the one-step path (text drift, `public/_locales/*/messages.json`).
8. **The recording bar's pulse ignores `prefers-reduced-motion`** (`.dot` in `renderHud`, `record-panel.ts`), unlike the bug report bar's (`bug-panel.ts:923`) and the recording frame's (`record-panel.ts:436`).
9. **Disconnect erases the browser-only URL patterns** along with the instance's (`disconnectBtn` in `src/options/main.ts:983`), so a reconnect to the same instance starts from nothing.

---

## 12. What to change, ranked

Cost: **S** a day or two in one file, **M** a few days across a surface, **L** a program with its own proposal. "Buys" says which journey gets shorter and by how much, from §8.1.

### Quick wins (S)

| # | Change | Where | Buys |
|---|---|---|---|
| 1 | **Skip the anchors step when a candidate already finds the element alone**; keep it as "Scope to a parent…" in the results | `src/content/pick.ts` | one dismissal off most picks |
| 2 | **Role-aware Action and suggestion-based Assertion copy modes** (`fill`, `check`, `selectOption`; the top matcher) | `src/shared/copy-modes.ts`, `assertion-suggest.ts` | copies that run as pasted |
| 3 | **Words instead of the score pill**, reusing the sidebar's `verdictText`; a title that says the order; the by-position row among the ambiguous ones | `results-panel.ts`, `sidebar.ts` | one vocabulary |
| 4 | **Pause / Resume in the recording bar** (lift the `IDE_BUILD` gate: the texts and `paused` already exist) | `record-panel.ts` | no setup steps in the spec |
| 5 | **Replay on the review panel** and in the chooser for a plain recording (`lastRecordedReport` for both modes) | `record-panel.ts`, `replay-panel.ts` | a recording checked before export |
| 6 | **A title field on the review and finish panels**, fed to `renderSpec({ title })` and `steps.title` | `record-panel.ts`, `bug-panel.ts` | no `recorded flow` |
| 7 | **Add to session in the pick results dialog; Send to editor in the sidebar, the Locators console, the Session tab and the mock code** | the four files | the session reachable from the page; one paste less per copy |
| 8 | **Keep the picked element outlined under the dialog; "Pick another" button and key** | `pick.ts`, `results-panel.ts` | five elements in eleven interactions instead of thirty |
| 9 | **A "Sites Piwi Picker may run on" card with Revoke per origin** (`chrome.permissions.getAll`) | `options.html`, `src/options/main.ts` | the privacy story made visible |
| 10 | **Connection health** in the popup and the settings pill, from the worker's last outcome | `project-refresh.ts`, `popup/main.ts`, `options/main.ts` | a dead key found in the popup, not in a tool |
| 11 | **"Use the desktop app as your instance too"** after pairing, and the reverse | `src/options/main.ts` | one pairing instead of two |
| 12 | **Locators console: history, Enter reveals, Copy as, Add to session** | `panel-locators.ts` | the console as a second entry to the card |
| 13 | **Pick, Lint and Tested elements buttons in the Piwi panel's toolbar** | `devtools-panel.html`, `panel.ts` | no round trip through the popup |
| 14 | **Hints as visible text on the compact tiles**, or `aria-describedby`; reduced-motion on the recording pulse; `role="region"` on the non-modal panels; `coverage_notConnected` rewritten for Connect | `popup.html`, `record-panel.ts`, `lint-overlay.ts`, `playwright-view.ts`, catalogs | accessibility and text drift |
| 15 | **Require the model's name for `toHaveAccessibleName`**; log and fix the doubled replay evidence and the bar's stale "no screenshot" | `assertion-suggest.ts`, `replay-panel.ts`, `bug-panel.ts` | §11 defects 1 to 3 |

### Next (M)

| # | Change | Where | Buys |
|---|---|---|---|
| 16 | **Narrow by a repeated container filtered by its text** in `narrow()`, and derive the repeating ancestor in multi-pick | `verified-locators.ts`, `multi-pick-derive.ts` | the right locator on every list, grid and table (finding 2) |
| 17 | **Pick inside open shadow roots**: `composedPath()[0]` in the overlay and the anchors step, `host` in `buildChain`, shadow-aware leaf counts | `packages/picker-dom/src/overlay-element.ts`, `overlay-anchors.ts` | web-component apps (finding 1) |
| 18 | **One element card** (Locators, Assertions, Tests, For an agent; Add to session and Send to editor in the header) rendered by the pick results dialog and the Elements sidebar, dockable to a side, updated on each pick | new `src/content/element-card.ts`, `results-panel.ts`, `sidebar.ts` | findings 3 and 4; the popup down to six tiles |
| 19 | **Quick-copy mode**: the shortcut then a click copies the top locator in the last mode with a toast; Shift+click or the popup opens the card | `background/index.ts`, `pick.ts` | a locator in two interactions |
| 20 | **Delete and edit steps in the review and finish panels**; edit a mark; thumbnails of the screenshots with a box each | `record-panel.ts`, `bug-panel.ts`, `bug-send-panel.ts` | fewer edits in the editor; an informed Send |
| 21 | **Dock, collapse and drag for the three bars**, remembered per site; a scrolling step list in the replay bar | `record-ui.ts`, the three bars | finding 9 |
| 22 | **Lint suggestions from names** (`add-to-cart`, `newsletter-email`) and "scope by `<container>`" when a unique container exists | `lint-scan.ts`, `lint-overlay.ts` | a checklist worth committing |
| 23 | **A welcome page on install** and a `?` in the popup, built from the docs' new screenshots; screenshots of the Playwright view, the replay and the bars for the docs | `background/index.ts`, a new `welcome.html`, `apps/docs/features/*.md` | finding 8 |
| 24 | **Mock several responses at once** and download their bodies as fixture files | `panel-network.ts`, `mock-code.ts` | a page stubbed in one copy |
| 25 | **Keyboard picking** (`Enter` picks the chain's element or the focused one) and a press-to-pick variant that keeps hover menus open | `overlay-element.ts` | accessibility; menus |
| 26 | **One assertion catalog** in `@piwitests/core` for Assertions, Check an element, Mark what's wrong and the copy mode | `packages/core`, the three dialogs | `toBeChecked`, `toHaveCount` and `toContainText`, in core since v0.57.0, offered everywhere at once, with `toBeDisabled` and `toHaveURL` |
| 27 | **A Firefox job**: `web-ext run` with a WebDriver BiDi client on the popup, the settings, a pick and a recording | `.github/workflows/reusable-e2e-extension.yml` | finding 10 |
| 28 | **Playwright view labels that stack on collision**; count badges that merge on dense rows | `playwright-view.ts`, `coverage-layer.ts` | §11 defect 5, §5.5 |
| 29 | **The project's test id attribute** read from the index for ranking everywhere, with a standalone setting | `verified-locators.ts`, `options.html` | right `getByTestId` on `data-test` projects |

### Programs (L)

| # | Change | Where | Buys |
|---|---|---|---|
| 30 | **Requests from the dashboard to the extension** through the marker script, confirmed in the extension's UI, starting where the `.piwibug` export and the bug report's page already are: Replay in Piwi Picker, Show on the live page, Find it on the live page, Pick a replacement on the site | `instance-marker.ts`, `background/index.ts`, the popup, four dashboard pages | finding 6; the loop closed from report to replay in two clicks |
| 31 | **Healing and CI status on the live page**: the index carries the proposed replacement and the open failure per locator; the card shows them | `server/utils/locator-usages.ts`, `locator-index.ts`, the card | the developer sees in the page what the dashboard knows |
| 32 | **Editor pairing by code**, the desktop app's flow served by the editor service | `packages/editor`, `apps/vscode`, `apps/jetbrains`, `src/options/main.ts` | one pairing procedure for all three |
| 33 | **Frames**: a `frameLocator` prefix from the frame element's own locator, in the overlay, the card and the sidebar | `verified-locators.ts`, `overlay-element.ts` | the one-frame limit lifted for same-origin frames |

### Sequence

Items 1 to 8 first: they are each a day, touch one file each, and remove the friction every tester feels on every pick and recording. Then 16 and 17 together, which change what the ranking offers and what can be picked, and are the two findings a user of a modern design system meets first. Then 18 and 19, which reshape the popup and the two main surfaces around the card; the popup's own redesign (§3.5) waits for them. Then 30, which needs the instance side and a design pass on the request channel, and 27, which needs a spike on driving Firefox.

---

## 13. Open questions

1. **Should the pick results dialog become a docked panel by default**, or stay a dialog with a dock option? The Tested elements panel chose docked and it is the surface people keep open; the dialog is what people expect from "Inspect". A docked default with the element kept outlined is the better bet for a tool used several times per page.
2. **How far should the dashboard be allowed to steer the extension?** The channel in §7.2 is one event, one confirmation. The privacy page promises that nothing the page says moves the extension; a request confirmed in the extension's own UI keeps that promise, but the docs must say it in one sentence, and the marker script's "reads nothing" line changes to "listens for one request and asks you first".
3. **Does Firefox stay a first-class target?** The AMO listing says yes; CI says nothing. A job is a spike plus maintenance; the alternative is a release checklist run by hand and stated in `PUBLISHING.md`. Either is better than the current silence.
4. **Is multi-pick a tool or a mode?** Folded under Pick (§4.2) it loses its key and tile; kept apart it keeps asking for two picks of leaves. The container derivation (item 16) may make it a row of the card ("the pattern of this list: 4 cards") and the question moot.
5. **Where does the welcome page live after install?** Opening a tab on install is the Chrome convention and a one-time interruption; the popup's `?` must open the same page afterwards, and the docs site is where it ends up for everyone else.

---

## Appendix A. The surfaces, counted

| Surface | Where | Texts (catalog keys) |
|---|---|---|
| The popup | `popup.html`, `src/popup/main.ts` | 60 |
| The settings page | `options.html`, `src/options/main.ts` | 134 |
| Save login for tests | `login.html`, `src/login/main.ts` | 17 |
| The pick results dialog and the overlays it uses | `src/content/pick.ts`, `results-panel.ts`, `packages/picker-dom` | 59 |
| Multi-pick, Lint overlay, Assertions, Agent context, Test functions | `src/content/multi-pick.ts`, `lint-overlay.ts`, `assertion-panel.ts`, `agent-context-panel.ts`, `test-function-panel.ts` | 43 |
| The recording bar, the checks and the review panel | `src/content/record-panel.ts`, `check-panel.ts` | 44 |
| The bug report bar, the Mark dialogs, the finish panel, the send preview | `src/content/bug-panel.ts`, `bug-send-panel.ts` | 115 |
| The replay chooser, the replay bar, the hand-over, Run with Playwright | `src/content/replay-panel.ts`, `desktop-run-panel.ts`, `share-result.ts` | 140 |
| The Tested elements overlay and panel | `src/content/coverage-*.ts` | 214 |
| The Playwright view | `src/content/playwright-view.ts` | 11 |
| The Elements sidebar and the Piwi panel | `src/devtools/*` | 118 |

About 35,000 lines of TypeScript and CSS in `apps/extension/src`, 1,071 catalog keys in five languages, 50 end-to-end spec files on Chromium, six docs screenshots of the extension (the popup, a pick, the lint overlay, a recording, the Piwi panel, Tested elements).

## Appendix B. How the walk-through was done

A throwaway Playwright spec in `tests/e2e/` (not committed) drove the built `dist/`, of v0.56.0 and again of v0.58.0: the popup and the settings page as extension tabs with a seeded `piwiConnection`; the Piwi panel and the Elements sidebar through `devtools-stub.ts` with three HAR entries; the in-page tools on `tests/e2e/pages/shop.html` with `stubCoverageChrome` and the `SHOP_TESTS` and `BRITTLE_TESTS` index; and, through `trusted-site.ts` with the real worker, a two-page cart on `127.0.0.1` where a coupon fails: Record actions with a fill and a click, Stop, the review panel; Report a bug with the same steps, Mark what's wrong on the total, Add to the report, Finish; the replay chooser, "Use the bug report recorded in this browser", Replay, and the verdict "Reproduced: the bug shows here" with trusted input. Every "(seen)" above comes from those screens.
