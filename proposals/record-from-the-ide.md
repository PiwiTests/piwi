# Recording tests from the IDE

A plan to write a Playwright test by using the application: from the IDE, a browser opens with the project's own
Playwright and configuration, the developer clicks and types, and each action appears as code at the caret, in the
file they are editing. The question was whether the IDEs (the JetBrains IDEs first) could do this with the code
generator Piwi Picker already uses, and whether the desktop app is needed. It can, the desktop app is not needed, and
the recorder itself can be reused unchanged: a spike ran Piwi Picker's recorder bundle, as the extension's build
produces it, inside a browser launched by Playwright, and the code was regenerated in Node 2 to 7 ms after each
captured action.

**Status.** Proposed 2026-10-03. Delivery PRs 1 to 3 are built: the recorder's IDE bundle, the launcher and the
recording sessions in the editor service, both clients, and Part 3, items 1 to 4, with Part 8, items 1 to 3. Built
since, in part: from PR 6, the checks of the browser's recording bar (**Check an element**, **Check the address**,
2026-10-03), in Piwi Picker too, with no Assert control in the IDE yet; from PR 4, three of item 11's matchers
(`toContainText`, `toHaveCount`, `toBeChecked`, 2026-10-20), `toHaveAttribute` still missing; from PR 9 (Part 5),
recording from a pause (2026-10-24): Piwi's pause bar at a breakpoint, and `page.pause()` in a headed run the editor
started, offer **Record here**, which hands the test's page to the editor's recorder over a local socket the editor
service opens for each of its runs (`PIWI_RECORD_CHANNEL`, in place of a discovery file) and writes the steps above
the paused statement, without the opening navigation; Stop brings the pause bar back, and Resume continues the test.
Not built from Part 5: **Record from here** at the caret (a run started for it), the debug session's evaluated
assignment, `~/.piwi/editor.json` for runs Piwi did not start, **End the test**, a run that records kept from the
instance (`PIWI_ORIGIN=record`: the run reports as any run from the editor), and Part 8, item 4. Where the
build differs from this text, the [docs](../apps/docs/features/editor-recording.md) and the code are right. The three
spikes in the [appendix](#appendix-the-spikes) are the evidence for the feasibility claims; they are not part of the
repository.

**Summary.** VS Code users have a recorder: Microsoft's Playwright extension records into a new file or at the cursor,
through Playwright's own code generator. Users of WebStorm, IntelliJ IDEA and Rider have none: JetBrains' Test
Automation plugin (what remains of Aqua, discontinued in 2025) validates and generates locators in its Web Inspector,
and its documentation describes no recorder of actions. Piwi already holds the parts a recorder needs, and a better
code generator than a recorder starts with: the extension's recorder (ranked locators, each verified to find the element
alone, hovers a click depends on, no password ever written down), the shared converter `renderSpec` (calls to the
project's own page objects and helpers from its function catalog, the locators the suite already uses, a wait for each
new page), and an editor service both IDE plugins run. This plan connects them:

- **Record a test from the IDE**: the editor service launches a browser through the project's own Playwright, with the
  `use` options of its config (`baseURL`, `storageState`, viewport, locale, headers, `testIdAttribute`), and writes
  each action at the caret while recording. No instance, no desktop app, no extension needed.
- **Fix the code generator where a recording from the IDE shows its limits**: iframes, popups, dialogs, downloads,
  uploads, the project's test id attribute, environment variable names that stay stable, imports placed in the file.
- **Edit a recording before it is code**: a step list with every step's other locators, assertions in two clicks, the
  locator at the caret highlighted in the browser.
- **Record at a breakpoint**: run a test up to the caret, an ordinary IDE breakpoint, the breakpoint a debug session is
  paused at, or a `page.pause()` line, through Piwi's capture fixtures; record from the page it reached, then let the
  test go on.
- **Start from a view that is already open**: the window of the last recording, a test's window, a Chromium started
  with a debugging port, or a tab of the developer's own browser.
- **Choose the page the steps run on**: `this.page` in a page object, `adminPage` or `userPage` in a test with two
  users, a popup's variable; proposed from the code around the caret, exact when the test runs.
- **Other ways in**: a recording made in the developer's own browser with Piwi Picker, streamed to the IDE as it
  happens; a bug report or a scenario gap opened as a test.

## What the reader gets

In WebStorm, in `tests/checkout.spec.ts`, the caret on an empty line inside `test.describe('checkout', …)`.
**Tools → Piwi → Record a Test Here** (or Alt+Enter, **Record a test here with Piwi**). A popup asks, once per
project, which Playwright project's options to use and where to start (`/`, on the `baseURL` the config names).
Chromium opens at the project's viewport, already signed in from the project's `storageState` file. In the editor, a
new test appears. It is the recorded block: the lines the recording writes, tinted, and rewritten on every action
until it stops.

```
checkout.spec.ts
      ● Recording in Chromium · 6 steps · Stop · Pause · Assert…           ← a line above the block
 12 ▌ test('recorded flow', async ({ page }) => {                          ← tinted: rewritten on every action
 13 ▌   const cartPage = new CartPage(page);
 14 ▌   await page.goto('/');
 15 ▌   await cartPage.addProduct('Red shoes');                             ← a call to the project's page object
 16 ▌   await page.getByRole('link', { name: 'Checkout' }).click();
 17 ▌   await expect(page).toHaveURL(/\/checkout(?:[?#]|$)/);
 18 ▌   await expect(page.getByRole('textbox', { name: 'Coupon' })).toHaveCount(1);
 19 ▌   await page.getByRole('textbox', { name: 'Coupon' }).fill('WELCOME10');
 20 ▌ });
```

The browser shows a small panel: **● Recording into checkout.spec.ts · 6 steps · Assert · Stop**. **Assert** picks an
element and offers the checks that apply to it (`toHaveText`, `toBeVisible`, `toHaveValue`…); the check lands at the
caret like any step. The Piwi tool window lists the steps, each with the locators the recorder verified for its
element: choosing another rewrites that line, deleting a step removes its line.

**Stop**, in the IDE or in the browser, or closing the browser: the block becomes ordinary code, undone in one step.
A brittle locator or a password read from the environment is flagged on its line, with the existing Piwi quick fixes.
Above the test, **Run** runs it once; **Verify ×3** runs it three times, headless, with no retry.

The same works without the catalog (raw `page.*` lines instead of `cartPage.addProduct`), and in VS Code with the same
commands; the JetBrains client is built first and gets the most polish. This is the end state of the
[Delivery](#delivery); the first release (PRs 1 and 2) has the block, Stop and the warnings.

## What exists

| Piece | Where | What it gives this plan |
| --- | --- | --- |
| The recorder | `apps/extension/src/content/record-panel.ts` | Capture across pages: clicks, fills, checks, choices, drags, file names, keys, the hovers a click depends on. Each target ranked and verified on the page (`verified-locators.ts`). Passwords, card numbers and one-time codes never captured. |
| The recorder's message path | `apps/extension/src/shared/session-area.ts`, `recording-storage.ts:232` | In Firefox, with no session storage in the page, every read and write is a message, and each captured event is one atomic message (`appendViaBackground`). A Playwright binding can answer exactly these messages. |
| Recording model | `packages/core/src/recording.ts` | `normalizeSteps`, `sessionFromEvents`: raw events to steps. |
| Code generator | `packages/core/src/codegen.ts` | `renderSpec`: escaped values, re-rendered locators, catalog calls, `preferLocators`, `locators: 'stable'`, URL checks, environment values, `format: 'body'`, and `stepLines` (the line each step starts on). |
| Steps document | `packages/core/src/steps.ts` | The portable form of a recording (`v: 1`), parsed field by field. |
| Send to editor | `packages/core/src/editor-send.ts`, `PiwiSendHandler.kt`, `apps/vscode/src/send-listener.ts` | After Stop, Piwi Picker posts a steps document; the IDE renders it with `piwi/renderSteps` and inserts it at the caret. One request, no session, nothing live. |
| Editor service | `packages/editor/src/server.ts`, `context.ts` | One context per Playwright config, with its function catalog and locator index; `piwi/renderSteps` (`server.ts:1481`). It starts no process today. |
| JetBrains plugin | `apps/jetbrains/` | LSP client with custom requests (`PiwiLanguageServer`) and notifications (`PiwiLsp4jClient`), insertion at the caret, the Piwi tool window, the built-in server's handlers. |
| Capture fixtures | `packages/reporter/src/internal/capture/capture-fixtures.ts` | Every locator action and assertion is proxied; its call site (`file:line:col`) is known before it runs (`:1164`, then `:1192`). The failure-time picker already keeps a page open at teardown (`maybeOpenPicker`, `:783`). Opt-in: specs import `test` from `base.extend(piwiFixtures)`. |
| Finding the project's Playwright | `packages/reporter/src/internal/support/playwright-spawn.ts:12` | `resolvePlaywrightCli`: the project's own CLI through `createRequire`. |
| Desktop app | `apps/desktop/src-tauri/src/runner.rs`, `repro.rs`, `worktree.rs` | Runs the linked folder's Playwright with its Node sidecar, in the folder or in throwaway worktrees; bundles no browser. Writes a temporary spec under `<testDir>/piwi-repro/` for a bug report's run. |

What exists elsewhere, for comparison:

- **VS Code, Microsoft's Playwright extension**: **Record new**, **Record at cursor** and **Pick locator**. It starts
  a Playwright browser server and drives Playwright's own recorder through its debug controller, which sends the
  generated code as text (`sourceChanged`). Tests run with reused contexts, so the page a test ends on can be recorded
  on. Playwright's generator writes typed values as literals, passwords included.
- **JetBrains, the Test Automation plugin**: the Web Inspector shows the application, generates CSS, XPath and
  role-based locators for a selected element, and validates the locators in the code. WebStorm runs and debugs
  Playwright tests. No recorder is documented.

## Decisions

1. **The editor service launches the browser, through the project's own Playwright.** Not the extension, not the
   desktop app, not a browser inside the IDE window. The service already runs on the project's Node.js, knows the
   workspace's Playwright configs, holds the catalog and the locator index, and is shared by both IDEs, whose
   guides say a new feature is a service request first. It does so from a child process, the launcher (Part 1.1).
   Loading Piwi Picker itself into a Playwright Chromium (`--load-extension`) was the other candidate: it works only
   in Chromium (branded Chrome dropped the flag in 137), keeps the per-origin permission prompts, and gains nothing
   over loading the recorder directly.
2. **One recorder, two bundles.** The IDE runs the same `record-panel.ts` the extension runs, built a second time as
   `record-ide.js`: same capture and ranking code, a different host. No second capture implementation. Playwright's
   own recorder is not used: its debug controller hands back code as text, not steps, so the catalog, the suite's
   locators, the step list and the stability checks would have nothing to work on; and that controller is internal
   to Playwright.
3. **One code generator.** Recordings from the IDE go through `renderSpec`, like the extension's Copy, `piwi codegen`
   and `piwi/renderSteps`. Each change Part 3 makes to the generator lands in `@piwitests/core` and reaches all four.
4. **The recording session lives in the editor service; the clients render it.** A recording session (one recording:
   its target file and position, its events, its options) is held by the service, which turns the events into code.
   The clients draw the recorded block and the controls around it. The protocol gains two requests and one
   notification (Part 1.4). The service could write the block with the protocol's `workspace/applyEdit`, which both
   clients support (the JetBrains IDEs since 2024.1); it does not, because each client has to group the updates into
   one undo step and draw the controls around the block, which an edit request cannot ask for. Per the service's
   rule, each protocol change lands with both clients; the JetBrains client gets the full interface first, VS Code
   the same commands with less polish.
5. **The recorded block is regenerated whole on every change.** A later step can change earlier lines: a run of steps
   becomes one catalog call once its last step arrives, and a URL check appears once a step lands on another page. So
   the service renders all steps each time and the client replaces the block. `renderSpec` took under 1.1 ms for nine
   steps in the spike.
6. **The browser gets the configuration Playwright resolves, never a parse of it.** The `use` options of the chosen
   project come from Playwright itself: a reporter of about fifteen lines, run with `playwright test --list`, prints
   them from `onBegin` (2.2 s on this repository's config; cached until the config file changes). The JSON reporter
   cannot do it: it leaves `use` out.
7. **Nothing is required beyond the IDE plugin.** A team instance or the desktop app adds data (the catalog, the
   suite's locators, Tested elements) and worktree runs, never a precondition. See
   [With or without the desktop app](#with-or-without-the-desktop-app).
8. **Licenses stay on their side.** `record-ide.js` comes from the extension and the launcher belongs to the editor
   service, both FSL. The capture fixtures (reporter, MIT) only load `record-ide.js` by a path the service gives them
   (Part 5); no FSL code moves into `core`, `picker-dom` or the reporter.

## Part 1: The recording session (editor service)

### 1.1 The launcher

The launcher is a Node child process of the editor service (`child_process.fork`, one per recording session) that
starts the browser with the project's own Playwright, loads `record-ide.js` into every page, and passes the recorder's
messages to the service. A child, not the service's own process: Playwright keeps a driver process and pipes, a stuck
browser must not stall diagnostics, and ending the child ends everything, the browser included. It runs in the folder
of the Playwright config, so relative paths (`storageState`) resolve as they do in a test run.

1. **Playwright**: `createRequire(<config folder>)` resolves `playwright-core` or `@playwright/test`, as
   `resolvePlaywrightCli` does. Missing: the session fails with "Playwright is not installed in <folder>".
2. **Options**: the chosen project's `use`, from the reporter described in decision 6, run with the project's CLI.
   The launcher maps them to `browserType.launch` (`channel`, `launchOptions`, `headless: false`) and
   `browser.newContext` (`baseURL`, `viewport`, `deviceScaleFactor`, `isMobile`, `hasTouch`, `userAgent`, `locale`,
   `timezoneId`, `colorScheme`, `storageState`, `extraHTTPHeaders`, `httpCredentials`, `ignoreHTTPSErrors`,
   `permissions`, `geolocation`, `proxy`), and calls `selectors.setTestIdAttribute` with `testIdAttribute`.
3. **The recorder**: `context.exposeBinding('__piwiRecorder', …)` answers the recorder's messages
   (`piwi-session-storage`, `piwi-append-recording-event`, `piwi-ping`, `piwi-tab-zoom`, `piwi-recording-stopped`);
   `context.addInitScript` loads `record-ide.js` at the start of every document, every page of the context.
4. **Events**: each appended event is checked field by field (the page can call the binding too) and sent to the
   service over the IPC channel. The launcher keeps no state the service needs.
5. **Lifecycle**: the browser closing, the page crashing, or Playwright failing ends the session with one sentence. A
   missing browser ("Executable doesn't exist") comes with an action that runs `npx playwright install chromium` in
   the config's folder, through the existing `piwi.runCommand`.

`webServer`, `globalSetup` and fixtures do not run in a fresh browser: only a test run starts them. When the
`baseURL` does not answer, the session says so and offers **Retry**. Recording through the test runner, with all of
them, is Part 5.

### 1.2 `record-ide.js`

A second entry in `apps/extension/scripts/build.mjs`, from the same sources:

- **Host**: the bundle is wrapped so `chrome` is a variable inside it, implemented over the binding: `storage.local`
  and `runtime.sendMessage` go to the launcher, `storage.session` is absent (which selects the existing message path),
  `i18n` reads the extension's catalogs in the IDE's language. The page gets no global `chrome`.
- **Three behaviors differ**, behind a build constant: the recorder runs in the top-level document only, as the
  extension does (until Part 3 adds frames); Stop shows no review panel (the code is already in the editor); the
  browser panel says which file it records into.
- **Same tests**: the extension's e2e suite keeps covering the recorder; the launcher's test (Verification) covers
  the second bundle.

### 1.3 From events to code

The service appends each event to the session and renders:

```ts
renderSpec(sessionFromEvents(events, startedAt), {
  format: session.into === 'steps' ? 'body' : session.into, // 'test' is Part 3, item 3
  title: session.title,
  testImport: testImportOf(targetFile),            // the file's own `test` import, else the project's most used one
  urls: sameOrigin(baseURL, startUrl) ? 'relative' : 'absolute',
  locators: 'stable',
  urlChecks: true,
  catalog: await context.functionCatalog(),        // empty without an instance
  preferLocators: suiteLocators(context.index),    // empty without an instance
});
```

Codegen warnings (`brittle-locator`, `redacted-value`, `file-needed`, `no-locator`) travel in each update, with the
line `stepLines` gives within the block, and each client shows them on those lines: diagnostics in VS Code, an
annotation in a JetBrains IDE.

### 1.4 Protocol

Added to `packages/editor/src/protocol.ts` and mirrored in `Protocol.kt`:

```ts
/** `piwi/record`: open a browser through the project's Playwright and record into a file. */
export interface RecordParams {
  uri: string;
  /** 0-based caret position: where the recorded block starts. */
  line: number;
  character: number;
  /** `steps`: lines of the test the caret is in. `test`: a new test at the caret. `file`: a whole new spec. */
  into: 'steps' | 'test' | 'file';
  /** The Playwright project whose `use` options the browser gets; the first one when absent. */
  project?: string | null;
  /** A path on the `baseURL`, or an absolute URL; the `baseURL` when absent. */
  startUrl?: string | null;
  title?: string | null;
  /** The expression the steps run on (Part 8); the default of `piwi/pageCandidates` when absent. */
  page?: string | null;
}
export interface RecordResult {
  ok: boolean;
  sessionId?: string;
  /** One sentence for the client to show when it did not start. */
  message: string;
  /** When the config has several projects and none was given: their names, for the client to ask. */
  projects?: string[];
}
export const RECORD_REQUEST = 'piwi/record';

/** `piwi/stopRecording`: stop recording; the browser stays open for the next recording (Part 7) until it is closed. */
export interface StopRecordingParams { sessionId: string }
export const STOP_RECORDING_REQUEST = 'piwi/stopRecording';

/** `piwi/recordingChanged` (notification, server to client): the block to write, and the session's state. */
export interface RecordingUpdate {
  sessionId: string;
  state: 'starting' | 'recording' | 'paused' | 'stopped' | 'failed';
  /** The recorded block's lines, unindented; the client indents them like the caret's line. */
  code: string;
  /** Import lines the file needs; the client adds the missing ones at the top. */
  imports: string[];
  steps: Array<{
    /** The step in words, as the extension's review lists it (`describeStepInWords`). */
    words: string;
    /** 0-based line of `code` the step starts on. */
    line: number;
    /** The verified locators of the step's element, best first, and the one written. */
    locators: string[];
    chosen: number;
    /** Set when the step is part of a catalog call. */
    functionName?: string;
  }>;
  /** Why the session stopped or failed, in one sentence. */
  message?: string | null;
}
export const RECORDING_NOTIFICATION = 'piwi/recordingChanged';
```

`piwi/pageCandidates` (Part 8) answers, for a position, the expressions the steps could run on and the default.
`piwi/editRecording` (Part 4) and the requests of Parts 4 and 5 follow the same shape. A client command `piwi.record`
lets the service offer a recording from a summary line or a quick fix (an empty test body, a scenario gap).

## Part 2: The JetBrains client

- **Entry points**: **Tools → Piwi → Record a Test Here**; the editor's context menu; an intention (Alt+Enter) inside
  a spec: **Record a test here** between tests, **Record steps here** inside a test body; **New → Playwright Test
  (Recorded)** in the Project view, which creates the file first.
- **First run in a project**: a popup with the Playwright project (the names `piwi/record` answers with), the start
  page and the page the steps run on (Part 8), prefilled from the last recording, kept in `.idea/workspace.xml`
  (`PiwiLocalSettings`).
- **The recorded block**: a `RangeMarker` over the block, tinted with a new `PIWI_RECORDING_BLOCK` attribute (beside
  `PIWI_FAILING_TEST`, in `PiwiColorSettingsPage` and both default schemes). Each update replaces the marker's text in
  a write command. A block inlay above it shows the state and **Stop**, **Pause**, **Assert…**, and the status bar
  shows **● Recording**.
- **One undo step**: the updates are applied as one command group, so a single Undo after Stop removes the whole
  recording. The platform's command grouping (`CommandProcessor` with one group id) is the first candidate; a short
  platform test settles it before the rest is built (Risks).
- **Typing in the block while recording** pauses the updates and says so on the inlay: **Resume** (the block is
  written again from the steps) or **Keep my edits** (the session stops, the code stays as edited).
- **Imports**: `imports` lines missing from the file are added after its last import, in the same command.
- **After Stop**: the tint and the inlay go; the warnings stay as diagnostics; Code Vision above the test offers
  **Run** and **Verify ×3** (Part 4.5).
- **Rider and IntelliJ IDEA Ultimate** get the same, through the same LSP API; nothing here is WebStorm-only.

## Part 3: Improvements to the recorder and the code generator

Each item lands in `@piwitests/core` or the recorder, so the extension's Copy, `piwi codegen` and Send to editor get it
too. The first four are needed by recordings from the IDE; the others are what a recording from the IDE reaches that
the extension never did.

1. **The project's test id attribute.** The probe (`packages/picker-dom/src/probe.ts:71`) and `generateAlternatives`
   (`packages/core/src/locator-generation.ts:239`) read `data-testid` only, and the recorder builds its engine without
   the project's attributes (`verified-locators.ts:68` takes them, `record-panel.ts` passes none). A project with
   `testIdAttribute: 'data-test'` gets no `getByTestId` for its own test ids, and gets `getByTestId` for any
   `data-testid` its pages carry (a component library's), which its tests then look up as `data-test` and do not
   find. Add a `testIdAttribute` option to generation, the probe and the engine; the launcher passes
   `use.testIdAttribute`, the extension the locator index's `testIdAttributes` when connected.
2. **Environment variable names that do not move.** A password becomes `process.env.PIWI_TEST_VALUE_<step index>`
   (`codegen.ts:345`), so a step added or removed before it renames the variable: in the spike,
   `PIWI_TEST_VALUE_5` became `PIWI_TEST_VALUE_6` when a late step arrived, in code the developer was watching. Name
   the variable from the field (`E2E_PASSWORD` for a field labeled Password, a suffix on a second one), and accept a
   map of names, so a rename in the step list sticks.
3. **Imports as data, and a test without its file.** `format: 'body'` writes the imports a catalog call needs as
   `// Needs: import …` comments (`codegen.ts:591`). Return them in `CodegenResult.imports` as well, for an editor
   that can place them. Add `format: 'test'`: the `test(…)` call alone, for a new test inside an existing file.
4. **`baseURL`-aware URLs.** `piwi/renderSteps` always writes paths (`server.ts:1494`): in a project without a
   `baseURL`, `page.goto('/…')` fails at run time. Write paths only when the recording's origin is the `baseURL`'s,
   relative to the `baseURL`'s own path (`/app/` in `http://host/app/`).
5. **Frames.** The extension records the top-level document only (its registration has no `allFrames`, and its docs
   say "One frame at a time"), so a click in an iframe is not recorded. A host that injects into every frame gets wrong
   code instead: in the spike, a click in a same-origin iframe became
   `await expect(page).toHaveURL(/\/promo(?:[?#]|$)/)` and a `page.getByRole(…)` that cannot reach into the frame.
   Add a frame chain to `RecordedTarget` (each iframe's locator in its parent) and render
   `page.locator('iframe[title="Promo"]').contentFrame().getByRole(…)` (`frameLocator` before Playwright 1.43); a
   frame's events keep the top page's `pageUrl`. In the IDE the launcher computes the chain: the binding names the
   frame that called it, and the frame's element is ranked in its parent by the same bundle.
6. **Popups and new tabs.** The recording model has one page: in the extension, a new tab of the same origin gets the
   recorder and its events join the stream, so its steps are written against `page` (read from the code, not
   reproduced). Give each step a page index and render
   `const page1Promise = page.waitForEvent('popup'); … const page1 = await page1Promise;`. The launcher knows each
   page (`context.on('page')`, `page.opener()`).
7. **Dialogs.** Under Playwright, a dialog nobody handles is dismissed at once, which changes the application's
   behavior during a recording. The launcher handles `page.on('dialog')`: the IDE shows the message with **Accept**,
   **Dismiss** and, for a prompt, a text field; the choice is recorded as `page.once('dialog', …)` before the step that
   opened it.
8. **Downloads** become `const downloadPromise = page.waitForEvent('download'); …; const download = await
   downloadPromise;`.
9. **Uploads with a real file.** The extension writes the chosen files' names, and the spec reads them from the
   folder Playwright runs in (`file-needed`). The launcher intercepts the file chooser (`page.on('filechooser')`); the
   IDE asks for a file from the project (a `fixtures` folder by default), the page gets it, and the step writes
   `setInputFiles(path.join(__dirname, 'fixtures/invoice.pdf'))` relative to the spec.
10. **Other origins.** The extension records one origin, the one it was granted. The launcher has no such limit, so a
    sign-in on an identity provider's domain is recorded with the rest (the spike recorded one).
11. **More matchers**: `toContainText`, `toBeChecked`, `toHaveCount`, `toHaveAttribute` beside the eight of
    `AssertionMatcher`.
12. **The steps document**: frames and pages are new fields. `parseSteps` drops fields it does not know, so an older
    `piwi codegen` would render a document that uses them as wrong code, silently. A document that uses them is
    `v: 2`, which an older reader refuses; any other stays `v: 1`.

## Part 4: What makes it worth switching to

1. **Edit before it is code.** The Piwi tool window gets a **Recording** tab: each step in words, its locators (the
   recorder keeps up to five, each verified to find the element alone), the function call it is part of, its
   warning. Choosing another locator, deleting a step, or turning a typed value into an environment variable sends
   `piwi/editRecording`; the service re-renders the block. Nothing is parsed back from the code: the steps stay the
   source, as in the bug-report plan.
2. **Assertions in two clicks.** **Assert** in the browser panel and in the inlay picks an element and offers the
   checks that apply to it, from the extension's `suggestAssertions`; the bug recorder's **Mark what's wrong** already
   adds `assert` steps this way. The extension's action recordings get the same button.
3. **The locator at the caret, in the browser.** With a recording browser open, the caret on a locator line outlines
   what it finds there, with a count (`piwi/highlightLocator`, through Playwright's own `locator.highlight()` and
   `count()`). **Pick in the browser** (`piwi/pickLocator`) runs the extension's picker and replaces the locator at the
   caret with the chosen candidate, or inserts it.
4. **Start where the tests start.** The browser opens signed in from the project's `storageState` file when it exists,
   and offers to run the setup project when it does not. A sign-in done during a recording can be saved to that file
   (`context.storageState({ path })`), the Save login for tests feature of the extension, written in place.
5. **Know it passes before committing.** **Run** runs the test as `piwi.runTests` does; **Verify ×3** adds
   `--repeat-each=3 --retries=0` and reports "passed 3 of 3" in a notification. With the desktop app, the same run can
   go to a throwaway worktree as a desktop job.
6. **Record what the suite misses.** With a connection, **Tested elements** outlines, in the recording browser, every
   element a test of the project reaches, from the locator index the service already holds (the extension's
   `coverage-overlay.ts`, built into `record-ide.js`).
7. **Keyboard first.** One shortcut starts a recording at the caret, the same one stops it, and the browser panel's
   buttons have keys.

## Part 5: Record at the caret or at a breakpoint

The most common case is not a new test: a test reaches the checkout page and the next steps are missing. Recording
from a fresh browser would mean replaying the start by hand. The capture fixtures can hand the test's page to the
recorder at the right line instead.

### 5.1 The hand-off

Every way of asking (5.2) ends in the same record request: a file and a line, the channel to the editor service (a
named pipe it listens on) and the path of `record-ide.js`. In the worker, the capture fixtures act on it:

1. Before running each action, the locator proxy checks for a request: a requested line this action's call site has
   reached (at or after it, in that file), or a request a debugger has just set. At that action, or when the test ends
   first (the same `context.close` hook as `maybeOpenPicker`), it holds the test there: lifts the timeout
   (`testInfo.setTimeout(0)`), loads the bundle into the context (`addInitScript` for the next documents, `evaluate`
   for the current one), and connects to the channel.
2. The session is the same as in Part 1: the events go to the service, and the block is written at the requested line,
   before the statement that was about to run, without the opening `page.goto` a fresh browser needs (a `renderSpec`
   option), since the page is where the test left it. Inside a page object, the block uses `this.page` instead of
   `page`; the service reads which one is in scope from the file.
3. **Stop** offers two endings. **End the test** skips it (`testInfo.skip()`, "recorded with Piwi"): the lines after
   the block never run. **Continue the test** runs the remaining lines on the page as the recording left it, which
   checks at once that the new steps fit what follows. With several requested lines, the next one reached opens the
   recorder again.
4. A run that records is never reported: `PIWI_ORIGIN=record` is a new origin the reporter does not submit.

Everything the test does before that line runs as it always does: `webServer`, `globalSetup`, the setup project,
`beforeEach` hooks and the project's own fixtures. The same hand-off gives **Record a test here** a second mode, through
the runner, for a project whose state comes from fixtures rather than a `storageState` file.

### 5.2 Four ways to ask

| Way | What the developer does | How the request reaches the worker |
| --- | --- | --- |
| The caret | **Record from here** inside a test | Piwi starts the run, since it holds the channel (today the clients run tests, from commands the service builds): `playwright test <file>:<line> --project=<p> --headed --workers=1 --retries=0 --timeout=0`, with `PIWI_RECORD_AT=<file>:<line>`, `PIWI_RECORD_CHANNEL` and `PIWI_RECORD_BUNDLE` |
| The IDE's own breakpoints, without debugging | Sets ordinary line breakpoints in the test, then **Run and Record at Breakpoints** | The same run; `PIWI_RECORD_AT` lists the test's enabled line breakpoints, read from the platform's breakpoint manager (`XBreakpointManager`) or `vscode.debug.breakpoints`. No debugger attaches: the breakpoints only say where. |
| A breakpoint a debug session is paused at | Debugs the test as usual (WebStorm's Playwright debugging, Microsoft's extension), and at a pause clicks **Record from here** | The client evaluates one assignment in the paused frame, `globalThis.__piwiRecordRequested = { file, line, channel, bundle }`, through the platform's debugger evaluator (`XDebuggerEvaluator`) or the debug adapter's `evaluate` request, then resumes. The hand-off happens at the next action, so the test stays at the breakpoint while recording. |
| `page.pause()` in the code | Writes `await page.pause()` where the steps should go and runs the test headed, from anywhere | The capture fixtures replace `page.pause` on the pages they instrument: while an editor service runs for the workspace, it hands off to Piwi instead of opening Playwright's Inspector, and the block replaces the `page.pause()` line. |

The first two need only the run Piwi starts. The other two also work in runs Piwi did not start (a debug session, a
terminal): the debugger carries the request in the assignment it evaluates, and `page.pause()` finds the service
through a discovery file, `~/.piwi/editor.json` (the channel, a token, the bundle's path and the workspace's root;
readable by the user only, removed when the service stops), the pattern of the desktop app's `~/.piwi/desktop.json`.

The third way was checked in a spike ([appendix B](#b-a-breakpoint-opens-the-recorder)): a breakpoint set through
Node's inspector protocol, the assignment evaluated in the paused frame, and the next action loaded the recorder into
the open page, with the email the earlier lines had typed still there. The two recorded steps came out without a
`goto`, and the test then went on to the next page.

### 5.3 Limits

- **The capture fixtures** are needed (`import { test } from './fixtures'`, which `piwi init` writes). Without them,
  the session says so, offers `piwi init`, and falls back to a fresh browser. Actions that do not go through a locator
  (`page.goto`, `page.keyboard`) are seen through Playwright's instrumentation listener, which the resource ledger
  already uses (`resource-ledger.ts`), behind the same feature check.
- **A visible browser.** The runs Piwi starts add `--headed`. A debug session of a headless run cannot show the
  recorder: Piwi says so and offers to run the test again headed.
- **Breakpoint conditions and hit counts** are not evaluated without a debugger: **Run and Record at Breakpoints**
  stops at the first pass on the line. A conditional breakpoint needs the debugging way.

## Part 6: Other ways in

1. **Recording in your own browser, streamed to the IDE.** Some flows need the developer's own profile: a hardware
   key, a single sign-on that refuses automated browsers. Piwi Picker records there today and sends the result after
   Stop. With **Live to editor** on, the extension's worker forwards each new event to the paired IDE as it is stored
   (it can observe every write through `chrome.storage.onChanged`, and content scripts make no network calls), and
   the IDE opens a recording session whose events come from the extension instead of the launcher. The block, the
   step list and the warnings are the same.
2. **A bug report as a test.** **New Test from Bug Report…** lists the project's reports and renders the chosen one
   into a new spec (`piwi codegen bug:<id>`, with the file's imports), ready to record more steps after it. A report
   sent to the desktop app opens the same way.
3. **A scenario gap as a test.** The dashboard's Gaps tab offers **Record in my IDE**: it calls the IDE's built-in
   server, as **Open in IDE** does (`PiwiOpenHandler.kt`), with the route; the IDE creates a spec and starts a
   recording at that page.
4. **From the desktop app, without an IDE plugin.** The launcher is a Node program the app's sidecar can run as well,
   writing into a linked folder; useful for editors without a Piwi plugin. Later, if asked for.

## Part 7: A view that is already open

Most recordings start from an address: `startUrl` (Part 1.4), prefilled with the last one, or the route of a scenario
gap. Four more starts reuse a window that is already on the right view:

1. **The window of the last recording.** **Stop** keeps the browser open: **Record a Test Here** or **Record Steps
   Here** at another caret continues in that window, from the view it is on, until the window or the project is closed.
2. **The window of a test**, held at the caret, a breakpoint or `page.pause()` (Part 5).
3. **A Chromium already open with a debugging port**: a browser started with `--remote-debugging-port` and its own
   profile (a debugging profile, Chrome for Testing). **Record in an Open Browser…** lists its pages; the launcher
   attaches with `connectOverCDP`, loads the recorder into the chosen page and the next ones, and records. Checked in
   a spike ([appendix C](#c-attaching-to-an-open-window)): attached in 158 ms to a page holding a half-filled form,
   which stayed as it was, and followed a navigation. Chrome's everyday profile is out of reach: since Chrome 136,
   remote debugging needs a separate profile, so the IDE cannot attach to the window the developer browses with.
   That window is Piwi Picker's (next item).
4. **A tab of the developer's own browser.** Piwi Picker records there and streams to the IDE (Part 6.1), or hands the
   tab over: **Open in a Recording Browser** sends the IDE the tab's address and the site's sign-in (cookies and
   storage, as Save login for tests reads them, asked for in that click), and the launcher opens the same page in a
   Playwright browser, signed in.

**What none of them can do**: generated code starts from an address. What the page held before the recording (a typed
value, an open menu, an application's state in memory) is not in the code: in appendix C, the email typed before
attaching is in the window, not in the block. The code needs the steps that led there: record from earlier, or record
at a breakpoint (Part 5), where the test's earlier lines rebuild that state. When the recorder attaches to an open
page, it can offer the fields that already hold a value (never a secret) as fill steps at the start of the block.

## Part 8: The page the steps run on

`renderSpec` writes `page` as the receiver of every line: locators, `goto`, `keyboard`, URL checks, viewport lines, a
helper's first argument (`fill(page, …)`), a page object's constructor (`new CartPage(page)`) and the test's parameters.
That is right in a test whose fixture is `page`, and wrong in a page object (`this.page`), a test with two users
(`adminPage`, `userPage`), after a popup (`popup`), or with a fixture object (`app.page`).

1. **A `page` option in `renderSpec`**: the expression every line runs on, an identifier or a member chain such as
   `this.page` or `app.page`, checked like a catalog identifier before it is written. In the `file` and `test`
   formats, a fixture name also goes into the test's parameters (`async ({ adminPage }) => …`). With several pages
   (Part 3, item 6), a map from each page to its expression.
2. **Candidates at the caret**, found by the editor service in the file's text, with the same kind of scanner as
   `callEndLine`, no TypeScript needed: the receivers of the Playwright calls around the caret, the test's fixture
   parameters (`{ page, adminPage }`), local variables assigned from `newPage()`, a `'popup'` event or
   `firstWindow()`, or annotated `Page`, and `this.page` in a class with a `page` field. The default is the receiver of
   the nearest Playwright call before the caret, else the test's `page` parameter, else `this.page` in a class.
   `piwi/pageCandidates` returns them; `piwi/renderSteps` uses the same default, so a flow sent from Piwi Picker into
   a page object comes out with `this.page`.
3. **The developer picks**: in the record popup (**Steps run on: adminPage ▾**, the candidates and a field for any
   other expression), and during the recording in the step list, which re-renders the block. A page the recording
   opens (a popup) gets a name the developer can change (`page1` to `invoicePopup`).
4. **Exact when the test runs** (Part 5): the capture fixtures see which page object each action of the test used
   (the locator proxy wraps each locator with its page) and where it was written; the service reads the expression
   at that call site. For each page the test holds, the name the test itself gives it is known, and the steps
   recorded in that page's window get it: record in the second user's window and the lines say `userPage`. In a debug
   session, the paused frame's variables give the same answer: the client lists those holding a `Page`.
5. **Two actors in one recording.** The launcher can open one window per actor, each with its own `storageState` (a
   requester and an approver, from the project's setup files), each tied to a variable. The steps are written in the
   order they happen, against the variable of the window they happen in: a workflow between two roles, recorded in
   one go.
6. **A locator as the receiver** (later): steps inside a container the test already holds
   (`const dialog = page.getByRole('dialog')`) written as `dialog.getByRole(…)`, each locator verified inside that
   container rather than on the whole page. Navigation, keyboard and URL checks still need the page, so this takes two
   choices instead of one.

## With or without the desktop app

| Setup | What a recording gets |
| --- | --- |
| The IDE plugin alone | Everything in Parts 1 to 5: the project's Playwright and options, verified locators, live code, the step list, assertions, frames, popups, dialogs, uploads, continuing a test. Steps are written as `page.*` lines. |
| With a team instance | Also: calls to the project's page objects and helpers (the catalog), the suite's locators preferred, Tested elements in the recording browser, bug reports and gaps as starting points. |
| With the desktop app | The same as a team instance for a linked folder (the app is an instance on this machine); also **Verify** in a throwaway worktree, and bug reports Piwi Picker sends to the app opened as tests. |

The browser never needs the desktop app: the editor service launches it, and the project's Playwright installs its
browsers. The app's own Playwright runs (reproduce, bisect, Flake Lab) already work the same way, with the folder's
CLI and no bundled browser.

## Delivery

Each PR is usable on its own; sizes are relative (S, M, L).

| PR | Content | Size |
| --- | --- | --- |
| 1 | `record-ide.js` (extension build), the launcher, its headless test; both IDE plugins ship the two files | M |
| 2 | Recording sessions in the service, the protocol, the JetBrains client (Part 2), the VS Code client (commands, live block, status bar), docs in `features/editors.md` | L |
| 3 | Part 3, items 1 to 4: test id attribute, stable variable names, imports as data, `baseURL`-aware URLs; Part 8, items 1 to 3: the page the steps run on | M |
| 4 | Part 3, items 5 to 12: frames, popups, dialogs, downloads, uploads, other origins, matchers, steps document v2 | L |
| 5 | The step list (`piwi/editRecording`; JetBrains tab, then a VS Code tree view) | M |
| 6 | Assertions while recording (browser panel and IDE), in the extension too | M |
| 7 | The locator at the caret in the browser, and picking a locator into the code | M |
| 8 | Run and Verify ×3 after Stop; the desktop job variant | S |
| 9 | Record at the caret or a breakpoint (Part 5): the hand-off, the four ways to ask, `~/.piwi/editor.json`; the test's own page names (Part 8, item 4) | L |
| 10 | Part 6: live stream from Piwi Picker, bug report to test, gap to test (one PR each) | M |
| 11 | A view that is already open (Part 7): keep the window, attach over the DevTools protocol, a tab handed over | M |
| 12 | Two actors in one recording (Part 8, item 5) | M |

PRs 1 and 2 are the first usable release. PR 3 should follow at once: without it, a project with its own test id
attribute or no `baseURL` gets worse code from the IDE than it expects.

## Verification

- **Core**: unit tests for every `renderSpec` change (frames, pages, dialogs, variable names, imports, URLs, the page
  expression, including one that is refused) and for `parseSteps` refusing a `v: 2` document in the old reader's
  terms.
- **The editor service**: page candidates on fixture files covering a test with `page`, a test with two fixtures, a
  popup variable and a page-object class.
- **The launcher**: `packages/editor/tests/launcher.test.ts` starts headless Chromium with the repository's
  Playwright, serves fixture pages through `context.route`, drives them with Playwright's own input (trusted, as a
  person's is), and compares the rendered block with the expected code: the spike, made a test. Frames, popups,
  dialogs, downloads and uploads get a page each.
- **The extension** is unchanged by PR 1 apart from a build entry; its e2e suite must stay green.
- **JetBrains**: a platform test applies a sequence of `RecordingUpdate`s to a document and checks the text, the single
  undo step and the pause on a user edit; the block arithmetic lives in `Glue.kt`, tested without an IDE.
- **VS Code**: the integration suite runs `piwi.record` against a stub that sends updates.
- **By hand**: `./gradlew runIde` with a sandboxed WebStorm on the dashboard's own tests (`run-app` skill for the
  server), recording a flow across two pages with a catalog call.

## Risks

- **The recorder runs in the page's own JavaScript world.** Playwright's init scripts run there, where the extension
  has an isolated world: the page can see the binding and the recorder's globals, and a page that replaces DOM
  methods can disturb capture. The binding validates every event, and the code generator writes nothing a step can
  turn into code. In Chromium, a later step can load the bundle into an isolated world through the DevTools protocol.
- **Firefox and WebKit are unverified.** The spike ran in Chromium only (the others were not installed). The recorder
  is DOM code and both browsers support init scripts and bindings, but each needs the launcher's test before it is
  offered; Chromium is the default either way.
- **Remote development.** With JetBrains Gateway, Dev Containers or Codespaces, the service runs where the code is,
  and a headed browser there has no display (WSLg on Windows 11 is the exception). The session must say so plainly;
  a browser on the developer's machine, reached from the remote service, is a later design.
- **Applications that refuse automated browsers** (`navigator.webdriver` is true under Playwright): some sign-in pages
  do. The project's `storageState` and the Piwi Picker stream (Part 6) are the ways around it.
- **The JetBrains block**: replacing a range on every update while keeping one undo step, the formatter and the user's
  typing is the least certain part of the client. A short platform test of the command grouping comes first in PR 2.
- **Two bundles of one recorder** can drift. They share every source file; the build constant changes three
  behaviors, and both bundles are tested in CI.
- **Playwright versions.** The launcher uses the project's Playwright, so only long-standing APIs (`addInitScript`,
  `exposeBinding`, the reporter API, `--list`); generated code must match the project's version (`contentFrame()`
  from 1.43). The oldest version is the one the reporter supports.
- **Recording at the caret or a breakpoint** depends on the capture fixtures and, for actions without a locator, on
  Playwright's instrumentation listener, an internal API the resource ledger already feature-checks.
- **Taking over `page.pause()`** changes what a Playwright method does in the project. It happens only while an
  editor service runs for the workspace and the run is headed, and the first time it asks (Open questions).
- **Attaching to an open window** needs Chromium with a debugging port and a separate profile; the everyday browser
  stays out of reach, by Chrome's design.

## Open questions

1. **Keep a panel in the page, or put every control in the IDE?** Recommendation: keep a small one (Stop, Assert, the
   step count): the developer's eyes are on the browser while recording.
2. **Which browser by default?** Recommendation: Chromium; the project's own browser as a choice once Firefox and
   WebKit pass the launcher's test.
3. **Continue from a test without the capture fixtures**: require them (and offer `piwi init`), or use Playwright's
   reused contexts, as Microsoft's extension does? Playwright 1.63 made `reuseContext` a public option, but turning
   it and `connectOptions` on for one run without editing the config takes internal environment variables
   (`PW_TEST_REUSE_CONTEXT`, `PW_TEST_CONNECT_WS_ENDPOINT`), and taking the reused context over from another client
   an internal method. Recommendation: require the fixtures, look again if users ask.
4. **A command-line recorder** (`piwi record tests/new.spec.ts`) for editors without a plugin: the launcher and the
   bundle are FSL, the reporter that holds the CLI is MIT. Ship it from an FSL package, or not at all?
5. **Names of environment variables for secrets**: from the field's label (`E2E_PASSWORD`), or with a project prefix
   set in the reporter's options?
6. **`page.pause()`**: hand off to Piwi whenever an editor service runs, or ask once per project? Recommendation: ask
   the first time, and keep the answer in the workspace settings.

## Not in this plan

- **A browser inside the IDE window** (JCEF in the JetBrains IDEs): one remote-debugging port for the whole IDE, an
  older Chromium than the tests use, nothing equivalent in VS Code.
- **AI-written steps or assertions**: the generator stays deterministic, as the catalog matcher is.
- **Generating page objects from a recording**: the catalog uses the project's existing ones; writing new classes is a
  separate design.
- **Other languages' Playwright** (Python, Java, .NET): the reporter, the catalog and the generator are TypeScript.

## Defects found while researching this plan

- The recorder ignores the project's test id attribute (Part 3, item 1).
- Environment variable names for secrets follow the step index and change while recording (Part 3, item 2).
- In the extension, a new tab of the recorded origin joins the recording and its steps are written against `page`
  (Part 3, item 6); found by reading the code, not reproduced.
- `piwi/renderSteps` writes paths whatever the project's `baseURL` (Part 3, item 4).
- A password typed in a field whose value a page object call takes was written as `''`, with no warning; found
  while building PR 3, and fixed there.

## Appendix: the spikes

Three scripts, run with this repository's `node_modules` (Playwright 1.63, headless Chromium) and
`apps/extension/dist/record-panel.js` from `npm run extension:build` (233 KB, unchanged). None is in the repository.

### A. The recorder in a browser launched by Playwright

`record-host.ts`, about 190 lines run with `tsx`:

1. `context.exposeBinding('__piwiHost', …)` kept the recording state in Node and answered `piwi-session-storage`,
   `piwi-append-recording-event`, `piwi-ping` and `piwi-tab-zoom`.
2. An init script defined a `chrome` object over that binding, without `storage.session`, so the recorder took its
   message path, plus `i18n` from the English catalog.
3. `context.addInitScript({ path: record-panel.js })` loaded the recorder into every document.
4. Fixture pages served by `context.route`: a shop on one origin with a search field and a same-origin iframe, a
   sign-in page on a second origin, an account page back on the first. Playwright's own input drove them.
5. On each append, Node ran `sessionFromEvents` and `renderSpec` with the options of `piwi/renderSteps`.

The last rendered body:

```ts
await page.goto('/');
await page.getByRole('textbox', { name: 'Search' }).fill('red shoes');
await page.getByRole('textbox', { name: 'Search' }).press('Enter');
await expect(page).toHaveURL(/\/promo(?:[?#]|$)/);                       // wrong: the iframe's URL
await expect(page.getByRole('button', { name: 'Claim coupon' })).toHaveCount(1);
await page.getByRole('button', { name: 'Claim coupon' }).click();        // wrong: inside the iframe
await expect(page).toHaveURL(/:\/\/[^/]+\/?(?:[?#]|$)/);
await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(1);
await page.getByRole('link', { name: 'Sign in' }).click();
await expect(page).toHaveURL(/\/login(?:[?#]|$)/);                       // the second origin
await expect(page.getByRole('textbox', { name: 'Email' })).toHaveCount(1);
await page.getByRole('textbox', { name: 'Email' }).fill('dev@example.com');
await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PIWI_TEST_VALUE_6 ?? '');
await page.getByRole('button', { name: 'Continue' }).click();
await expect(page).toHaveURL(/\/account(?:[?#]|$)/);
await expect(page.getByTestId('add-to-cart')).toHaveCount(1);
await page.getByTestId('add-to-cart').click();
```

What it showed:

- The recorder needed no change: 9 steps across 3 pages on 2 origins.
- From an event in the page to the rendered body in Node: 2 to 7 ms. `renderSpec`: 0.03 to 1.1 ms.
- With `chrome.storage.session` present, the read-then-write of each append lost the two clicks that navigated away
  (Sign in, Continue); the message path, one atomic append, kept them. The launcher must use the message path.
- The iframe's click produced the two wrong lines marked above (Part 3, item 5).
- The password's variable was `PIWI_TEST_VALUE_5` until a late step arrived, then `PIWI_TEST_VALUE_6` (Part 3,
  item 2).
- Not tested: a headed browser, Firefox, WebKit.

A second check read the resolved `use` options of `apps/application/playwright.config.ts` with a short reporter
(`onBegin` prints `config.projects[].use`) run as `playwright test --list --reporter=<file>`: 2.2 s, `baseURL`,
`viewport`, `userAgent`, `deviceScaleFactor`, `extraHTTPHeaders` and `launchOptions` as Playwright resolved them.
`--reporter=json` leaves `use` out.

### B. A breakpoint opens the recorder

`test-flow.js` (plain JavaScript, so its lines are exact) stands for a test: it opens a sign-in page and types an
email, and before each action calls a hook that stands for the capture fixtures' locator proxy.
`debugger-controller.js` stands for the IDE's debugger: it starts the test with `--inspect-brk`, sets a line breakpoint
through Node's inspector protocol (`Debugger.setBreakpointByUrl`) on the line before the Continue click, and when it is
hit, evaluates `globalThis.__piwiRecordRequested = { file, line }` on the paused frame (`Debugger.evaluateOnCallFrame`)
and resumes.

```
[debugger] breakpoint set at test-flow.js:36
[debugger] paused at test-flow.js:36; "Record from here"
[fixture] record requested at test-flow.js:36; the page is https://shop.test/login, Email holds "dev@example.com"
[fixture] recorded block, written at the breakpoint line:
  await page.getByRole('checkbox', { name: 'Keep me signed in' }).check();
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PIWI_TEST_VALUE_1 ?? '');
[fixture] stopped; the test continues
[test] reached https://shop.test/account, keep-signed-in was checked before Continue
```

The hook loaded the recorder into the open page with `evaluate`, and into the next documents with `addInitScript`; the
two recorded steps were the person's, played by Playwright's input. Not tested: Playwright's test runner (the hook is a
function here, not the capture fixtures) and the IDEs' own debugger APIs; both IDEs' JavaScript debuggers talk to Node
through this inspector protocol.

### C. Attaching to an open window

`attach-existing.js`: a Chromium started by Playwright with `--remote-debugging-port=9333` and its own profile
(`launchPersistentContext`), on a sign-in page with the email typed, stands for the open window. A second client
attached with `connectOverCDP`, found the page by its address and loaded the recorder; the person went on in the first
client's page: the password, Continue, then Orders on the next page.

```
[launcher] attached to https://shop.test/login in 158 ms; Email holds "dev@example.com"
[launcher] recorded from the open view:
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PIWI_TEST_VALUE_1 ?? '');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/account(?:[?#]|$)/);
  await expect(page.getByRole('button', { name: 'Orders' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Orders' }).click();
```

The email typed before attaching is in the window and not in the code (Part 7). Not tested: a Chrome started by hand.
