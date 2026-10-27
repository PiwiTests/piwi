# Bug reports as failing tests

- Status: accepted
- Date: 2026-09-28

A plan to turn a bug report into the test that proves it, and to let the developer who receives it watch it happen.
In Piwi Picker, **Report a bug** records the steps with the existing recorder, lets the reporter mark what is wrong
("this should read Total: 42"), and collects evidence from the page. The result is a **steps document**: structured
data, not code. From it, a converter writes a Playwright spec that fails because of the bug; the extension **replays**
it in the developer's own tab against their local dev server; and the desktop app **runs** it with Playwright. With an
instance, the report is also stored in Piwi, filed in Jira, linked to the tests that already visit the page, and
followed until its spec passes.

**Status.** Proposed 2026-09-27; revised the same day after deciding: replay targets the developer's local dev server
in their everyday browser, Playwright runs go through the desktop app, and the `debugger` permission was not used (it
cannot be optional). Revised 2026-09-28: the owner chose to use it on demand, as a required permission (option A;
see [The `debugger` permission](#the-debugger-permission)). PR 1 (the steps file, the converter's
options, Download steps and `piwi codegen`), PR 2 (Report a bug in Piwi Picker, its evidence and local exports), PR 3
(Replay, from a file, from the report just recorded, or from the finished report, with a fake cursor), PR 4
(`expectedStatus`, "looks fixed", `piwi:bug`) PR 5 (the dashboard: stored reports, their pages and spec, Send to
Piwi…, Replay from the instance, `piwi bug`, MCP tools) and PR 7 (Jira: filing from the Send preview, the report's page,
MCP or for every report, in the ticket's language, screenshots attached, the ticket following the report) and PR 8 (why the suite missed it, escaped defects on the Test
Map, the `fix-a-reported-bug` skill) and PR 6 (Run with Playwright in the desktop app: pairing, repro requests
confirmed in the window, `desktop_run_repro`, the verdict back in Replay) are built, and so are PR 3's two leftovers
(the console errors and failed requests a replay sees, and **Share result**): the whole plan is built. The extension gains
two tools and, for the first time, requests that send page data to an instance, behind the explicit opt-in and preview
its rules require. The reporter gains one wire field (`expectedStatus`); the dashboard gains a table, pages, endpoints,
an issue type for the Jira integration, a CLI command and MCP tools; the desktop app gains a run request. The steps
document, the wire field, the annotation, the endpoints, the CLI command and the MCP tools freeze at 1.0 (one new D
entry in [`1.0-stabilization.md`](../proposals/1.0-stabilization.md)).

**Summary.** A bug report is prose: steps someone remembers, a screenshot, "it should say 42". The developer rebuilds
the steps, often cannot reproduce, and when the fix lands nothing checks that it holds. Piwi Picker already records a
flow into structured steps, turns them into a runnable spec, knows how to write `expect(...)` lines for an element,
and matches steps against a project's own page objects. This plan makes the steps the product. A report is a
versioned steps document with an **expected** assertion that states the correct behavior, plus evidence. One converter
in core renders it as Playwright code, with the project's own `test` import, relative URLs, the stable locator the
suite already uses, and `test.fail()` for a spec meant to be committed now. The extension replays the same steps in
the developer's tab, on `localhost`, with their session and DevTools open, and answers in three ways: reproduced, not
reproduced, or diverged at step N. The desktop app runs the rendered spec with Playwright in the linked project, headed
or with a trace, and records it as a normal run. The committed `test.fail()` spec keeps CI green while the bug exists,
and its unexpected pass is reported as "this bug looks fixed" rather than as a new failure. Every report is also an
escaped defect, which the Test Map's escape history has been waiting for.

## What the reader gets

On the reporter's side:

```
Piwi Picker · Report a bug                                    ● recording · staging.acme.com · 4 steps
  1  goto /cart
  2  fill "Coupon" with "SPRING10"
  3  click button "Apply"
  4  expect cart total  toHaveText  "Total: 42"        actual: "Total: 40"   ← marked as wrong
  [Mark what's wrong]  [Something is missing]  [Finish]

Finish → "Coupon not applied to the total"
  Evidence  screenshot · 1 console error · 1 failed request (POST /api/cart/coupon 500) · page outline
  [Copy failing test]  [Copy report (Markdown)]  [Download .zip]  [Send to Piwi…]
```

On the developer's side, in their own browser on the local dev server:

```
Piwi Picker · Replay · bug #37 "Coupon not applied to the total"         on http://localhost:3000
  ✓ 1  goto /cart
  ✓ 2  fill "Coupon" with "SPRING10"
  ✓ 3  click button "Apply"
  ✗ 4  expect cart total toHaveText "Total: 42"      got "Total: 40"
  Reproduced · the same value as reported · POST /api/cart/coupon answered 500 here too
  [Step mode]  [Replay again]  [Run with Playwright in the desktop app]  [Copy failing test]
```

The spec the converter writes for committing:

```ts
import { test, expect } from '../fixtures';

test('bug: coupon not applied to the total', {
  tag: '@bug',
  annotation: [
    { type: 'piwi:bug', description: '37' },
    { type: 'piwi:link', description: 'https://acme.atlassian.net/browse/SHOP-812' },
  ],
}, async ({ page }) => {
  test.fail(); // SHOP-812: passes while the bug exists; remove this line with the fix
  await page.goto('/cart');
  await page.getByLabel('Coupon').fill('SPRING10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('cart-total')).toHaveText('Total: 42'); // "Total: 40" when reported
});
```

In Piwi:

```
Bug report #37 · Coupon not applied to the total              open · SHOP-812 · test committed
  /cart · Chrome 141 · reported by ana@acme · 2 days ago
  Reproduced  by a developer on localhost:3000 (replay) · with Playwright on 9f2c1e0 (desktop, trace)
  Why the suite missed it  4 tests visit /cart; 2 reach the total, and none asserts its text
  Owner  @acme/checkout (CODEOWNERS of tests/cart.spec.ts, the page's main test file)
  Spec   tests/bugs/coupon-not-applied.spec.ts · expected failure in 3 runs
```

## What exists

- **The recorder records data, then renders code.** `record-panel.ts` captures `click`, `input`, `change` and Enter in
  the page, and a navigation per page, into a raw event stream in `chrome.storage.session` (`recording-storage.ts`).
  `normalizeSteps` (`packages/core/src/recording.ts`) turns it into a `RecordedSession` of `RecordedStep`s: an action
  (`goto`, `click`, `fill`, `check`, `uncheck`, `selectOption`, `press`, `assertVisible`), a value (never for a password
  field: `redacted`), the page URL, and a `RecordedTarget` with the element's tag, role, accessible name, test id, text
  and ranked locator `alternatives`, computed at capture time. Recording follows one origin across pages, top frame
  only. `assertVisible` exists but the recorder never emits it.
- **The generator.** `renderSpec(session, { title, catalog })` (`packages/core/src/codegen.ts`) emits
  `import { test, expect } from '@playwright/test'`, a `test('recorded flow', …)`, one line per step with the first
  alternative as the locator, a redacted fill as `process.env.PIWI_TEST_VALUE_<i>`, and, with a function catalog,
  calls to the project's page objects (`matchFunctionAt`) with their imports. Every value is quoted by one escaping
  function, and catalog identifiers are checked before they are emitted (`callIdentifiersAreSafe`). `goto` emits the
  **recorded absolute URL**, so a spec recorded on staging does not follow the developer's `baseURL`.
- **The assertion suggester** (`assertion-suggest.ts`, `assertion-panel.ts`) proposes `toHaveValue`, `toHaveText`,
  `toHaveAccessibleName` and `toBeVisible` with the element's **current** value; nothing lets a person type an
  expected value.
- **The in-page engine.** `locator-engine.ts` resolves Playwright locator chains in the page and is checked against real
  Playwright (`locator-engine.spec.ts`); `engine-aria.ts` (`DomModel`) computes role, accessible name, states and
  visibility. Tested elements and the pick flow already rely on both.
- **Judging and preferring locators.** `assessLocatorChain` (`packages/core/src/locator-stability.ts`) rates a chain;
  `canonicalLocator` (`locator-chain.ts`) normalizes one; the locator index lists every chain a project's tests use.
- **Connected mode is read-only.** `piwi-client.ts`, the extension's only networked module, makes GET requests (project
  menu, function catalog, locator index) from the options page and the background worker. The manifest asks for
  `activeTab`, `scripting`, `storage` and optional host permissions, requested per origin from a popup click. Nothing
  captures a screenshot, a console message or a failed request, and no content script runs in the page's main world.
- **The extension's rules** (`apps/extension/AGENTS.md`): no network call from a content script; sending recorded data
  needs explicit opt-in, clear separation and a payload preview before the first send; no standing permission is added
  without a deliberate decision. The docs say "A recording is never sent to your instance".
- **The desktop app.** It serves the dashboard on a loopback port (3000 when free) and publishes that URL with a
  full-access local token in `~/.piwi/desktop.json` (mode 0600), which the reporter reads to find it. The window keeps
  an event stream open (`GET /api/desktop/events`), which already carries `open-page` requests handed over from the
  system browser (`server/utils/desktop-handoff.ts`). Tests run through Rust commands in the linked project folder or a
  throwaway worktree (`runner.rs`, `worktree.rs`), with an allowlist of Playwright flags that includes `--headed`,
  `--debug`, `--trace`, `--project`, `--repeat-each`; the webview cannot set environment variables, Rust does.
- **Jira.** `IssueTracker` (`server/utils/integrations/types.ts`) with a Jira Cloud client that can create, comment,
  transition, search and attach (`jira/client.ts`). `POST /api/integrations/issues` files an issue for a failure
  cluster or an execution, and `createIssue` needs a cluster. `buildIssueDocument`
  (`shared/integrations/build-issue.ts`) writes the issue in English or French. `attach()` exists but is never called,
  and the outbox (`integration_actions`, `actions.ts`) handles `create-issue`, `comment` and `transition` only. Links
  live in `entity_links`; status sync and policies (`commentOnFix`, `transitionOnFix`, `resolveOnClose`, …) run in
  `server/tasks/integrations/sync.ts`.
- **`test.fail()`.** `classifyStatus` (`packages/core/src/status-classify.ts`) inverts the outcome: an expected failure
  that passes becomes `failed` with "Expected to fail, but passed.". No `expectedStatus` is stored, and such rows are
  clustered like any failure (with the call site ignored by the fingerprint, likely into one cluster per project).
- **Annotations, owners, pages.** `parseTestMetadata` (`packages/core/src/test-meta.ts`) reads `piwi:owner`,
  `piwi:priority`, `piwi:feature`, `piwi:link`. `primaryOwnerForPath` (`codeowners.ts`) resolves CODEOWNERS for any
  path. The locator index carries the page of each locator use.
- **Escapes are derived, not recorded.** `detectEscapedDefect` (`shared/handlers/scenario-gaps.ts`) is a pure function
  over tracker bugs with no linked cluster; its loader is not wired.
- **Patterns to follow.** `scenario_gaps` has a lifecycle (`open` … `closed`) that closes itself from a run; uploaded
  files use the storage adapter (`server/storage/types.ts`) that holds run artifacts; API keys act as their user, and
  the roles `administrator`, `reporter` and `user` are what endpoints require.

## The `debugger` permission

The high-fidelity way for an extension to drive a page is the Chrome DevTools Protocol through `chrome.debugger`: it
sends trusted input, as Playwright does, and would also give real console, network and accessibility data. It cannot be
optional:

- Chrome's permissions reference lists `debugger` among the "permissions that can *not* be specified as optional",
  with `declarativeNetRequest`, `devtools`, `geolocation`, `mdns`, `proxy`, `tts`, `ttsEngine` and `wallpaper`
  ([chrome.permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)).
- Checked on the Chromium this repository's tests use: an unpacked extension declaring
  `"optional_permissions": ["debugger", "tabs"]` keeps both in its manifest, but `chrome.permissions.request({
  permissions: ['debugger'] })` from a click in its popup rejects with "Only permissions specified in the manifest may be
  requested", while the same request for `tabs` opens the permission prompt.

As a required permission, `debugger` adds an install warning for every user, and an update that adds it disables the
extension until each user accepts the new warning; Chrome also shows a "started debugging this browser" bar while it is
attached.

**Decision (2026-09-28, option A): used on demand.** The owner accepted those costs while the extension has almost no
users, so the update prompt costs almost nothing now. `debugger` is a required permission of the Chromium build only
(Firefox has no `chrome.debugger`; its manifest leaves it out and keeps today's behavior everywhere). A session is
attached only while a feature needs it and detached as soon as it ends: a replay (trusted input through `Input`), a bug
recording (console, exceptions and failed requests through `Runtime`, `Log` and `Network`; screenshots through
`Page.captureScreenshot`, which removes the popup's `activeTab` step), and the DevTools panel's request conditions and
throttling. Every feature keeps the page-events path as its fallback, taken when attaching fails, when the person
cancels Chrome's bar, and in Firefox, and says so in the panel. Exact fidelity still comes from Playwright in the
desktop app; the replay is now much closer to it.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Steps are the source of truth. A report is a versioned steps document; code is rendered from it, and replay reads it. Nothing ever parses generated code back. | One artifact feeds the spec, the replay, the desktop run and the dashboard, and each can improve without breaking the others. |
| D2 | One converter in core renders steps as Playwright code, with options, and every surface calls it: the extension, the dashboard, the CLI, the desktop app and MCP. | The same steps give the same code everywhere. |
| D3 | A spec written for a project (by `piwi codegen`, the dashboard, the desktop app) uses relative URLs (`page.goto('/cart')`), the project's own `test` import when one is set, a URL check after each navigation, and for each step the first alternative rated stable, preferring one the project's locator index already uses. With no options, the converter writes what the recorder always wrote. | A report recorded on staging must run against the developer's `baseURL`, with the project's fixtures, in the style of the suite; existing users of the recorder's export see no change. |
| D4 | Report a bug reuses the recorder, the pick flow and the assertion suggester. What is new is an expected assertion, a missing-element assertion and evidence. | Recording and rendering already work across pages and use the project's page objects. |
| D5 | Every report yields files locally, with no instance. Sending to Piwi is a separate action with a preview of exactly what is sent, and a checkbox per kind of evidence. | The extension's standalone stance and its rule for sending page data. |
| D6 | Replay runs in the developer's tab, on the origin the developer chooses (by default the tab's), with trusted input through `debugger` in Chrome and Edge and the page's own events otherwise (see D8). It resolves each step with the in-page engine, in the same order the converter picks locators. | The developer's own session and DevTools, and the same element the spec would use. |
| D7 | A replay or a run answers **reproduced** (the expected assertion fails), **not reproduced** (it passes) or **diverged at step N** (an earlier step found no element, several, or a disabled one). | "Not reproduced" and "the page is different here" call for different next steps. |
| D8 | `debugger` used on demand since 2026-09-28, option A (see above): required in the Chromium build, attached only while a replay, a bug recording or a DevTools condition runs, with the page-events path as the fallback. | It cannot be optional; the owner accepted the install warning and the debugging bar while the extension has few users, for trusted input and evidence from the page's first script. |
| D9 | The desktop app runs a repro only after the developer confirms it in its window. A request carries steps and options, never code; the desktop renders the spec itself with the converter, writes it under the project's test directory, runs it with the project's own config, and deletes it. | The loopback API is reachable by anything on the machine; confirmation and steps-only requests keep it from becoming a way to run arbitrary code. The project's config keeps its fixtures and `baseURL`. |
| D10 | A spec for committing is written with `test.fail()` and the report's annotations; a spec for running (replay's twin, the desktop run) is written without it. | Committed, it keeps CI green and becomes a signal when the bug is fixed. Run, it gives the three-way verdict directly. |
| D11 | An expected failure that passes is its own outcome, "expected failure passed", recorded from a new `expectedStatus` wire field, not clustered, and reported as "this bug looks fixed". | Treated as one more failure, the good news hides in a cluster shared by every such test. |
| D12 | Console errors and failed requests are captured by a main-world script registered with the existing `scripting` permission and origin grant, while a bug recording or a replay runs. | No new standing permission. The page can affect that script, which is acceptable for evidence a person reviews. |
| D13 | The page outline is built by the extension's engine in the YAML form of Playwright's ARIA snapshots and labeled "outline". | It is the engine the locator checks already trust, but it is not Playwright's snapshot. |
| D14 | A report is linked to its test by a `piwi:bug` annotation and to its ticket through `entity_links`. Every report is an escaped defect for the Test Map, keyed by its page. | An annotation survives renames. A bug on a page the suite visits is the escape history exposure ranking was designed to use. |
| D15 | Typed values stay as typed, except passwords (already redacted). The preview shows them, and a checkbox turns every typed value into an environment variable. | A reproduction often needs the exact input; the reporter decides what leaves the machine. |
| D16 | Jira issues are created by the instance, never by the extension: from the Send preview, from the report's page, from MCP, or automatically when the project files every report. The ticket is written in the project's ticket language. | Jira credentials stay on the server, the extension talks only to the instance it is connected to, and every path gets the same outbox, attachments and links. The ticket's readers are the project's team. |

## Part 1 — Steps and the converter

### 1.1 The steps document

`packages/core/src/steps.ts` defines `PiwiSteps`, the portable form of a recording:

```ts
interface PiwiSteps {
  v: 1;
  title: string | null;
  origin: string;          // where it was recorded: https://staging.acme.com
  steps: PiwiStep[];       // RecordedStep, with pageUrl stored as a path relative to origin
  recordedAt: number;
  note?: string;
}
```

- `StepAction` gains `assert`, with `assertion: { matcher, expected, actual, negated, note }`. Matchers: `toHaveText`,
  `toHaveValue`, `toBeVisible`, `toBeHidden`, `toBeEnabled`, `toBeDisabled`, `toHaveAccessibleName`, `toHaveURL` (no
  target). `assertVisible` becomes `assert` with `toBeVisible`; a document without `v` is read as a legacy session.
- `parseSteps(json)` validates a document (shape, sizes: 200 steps, 10 alternatives per target, 2,000 characters per
  value) and returns it or a list of errors. Everything that consumes steps from outside (a file, a request, the
  dashboard) goes through it.
- The recorder's own **Download steps** exports any recording this way, not only bug reports, so a steps file becomes
  the thing a tester hands a developer.

### 1.2 The converter

`renderSpec(session, options)` in `codegen.ts` takes options. With none, it writes exactly what the recorder's
**Copy as TypeScript** always wrote; each surface picks its own defaults (`sessionFromSteps` turns a document back into
the session it renders).

| Option | Core default | `piwi codegen` | Effect |
|---|---|---|---|
| `title` | `recorded flow` | the document's title | the test's title (`bug: …` for reports) |
| `testImport` | `@playwright/test` | `--test-import` | the module `test` and `expect` come from, such as `../fixtures` for a project with auth fixtures |
| `urls` | `absolute` | `relative` | `relative` writes URLs on the recorded origin as paths (`page.goto('/cart')`), so `baseURL` applies |
| `catalog` | none | the project's, with `--project` | page-object and helper calls for contiguous matching steps |
| `locators` | `first` | `stable` | `stable` takes the first alternative `assessLocatorChain` rates stable, else the first |
| `preferLocators` | none | the project's locator index, with `--project` | an alternative the suite already uses comes first, unless it is brittle |
| `urlChecks` | off | on | after a step that leads to another page, `await expect(page).toHaveURL(…)` with the page key's id and token segments open, so the next step never runs on the page before |
| `values` | `literal` | `--env-values` | `env` reads every typed value from `process.env.PIWI_TEST_VALUE_<i>` and names them in a comment |
| `expectFail` | off | `--fail`, `--fail-reason` | `test.fail()`, with the reason in a comment |
| `tags`, `annotations` | none | `--tag` | test details (`tag: ['@bug']`, `piwi:bug`, `piwi:link`) |
| `format` | `file` | `--body` | `file` (imports and one test) or `body` (the lines to paste, with the imports they need as comments) |

It returns `{ code, matchedSpans, warnings }`, with a warning for a step without a locator, a redacted value, a target
whose chosen locator is brittle, or an assertion with nothing to check. The converter is the one place steps become
code: values are escaped literals, catalog identifiers are checked, and every locator is parsed with the chain grammar
and written from its parsed form (`safeLocator`), with regex arguments checked as valid one-line patterns. A step can
therefore choose a locator but never add code, which is what makes a steps file from someone else safe to render.

### 1.3 Where it is available

- **Extension:** **Copy failing test** and **Download**, with the test import and URL mode remembered per project
  mapping.
- **Dashboard:** a **Spec** tab on each report, rendered with the project's settings (a new "Generated specs" section:
  test import, folder for bug specs, default `tests/bugs`), with copy and download.
- **CLI:** `npx @piwitests/reporter codegen <steps.json>` prints or writes a spec (flags in
  `apps/docs/reference/cli.md`); a report id as the source (`bug:<id>`) comes with PR 5. `bug <id> --write` renders a
  report's committed spec into the bugs folder and runs it once.
- **Desktop app:** renders the run spec for a repro request (Part 3.2).
- **MCP:** `render_steps { steps | bugReportId, options }` for an agent that writes the test from a recording.

## Part 2 — Reporting a bug

### 2.1 The tool

A **Report a bug** tile in the popup (key `B`) starts a recording with a bug HUD: the steps so far, **Mark what's
wrong**, **Something is missing**, and **Finish**. Recording, navigation and the one-origin rule are the recorder's.

- **Mark what's wrong** starts the pick flow; the assertion panel opens in expected mode: the matcher with the current
  value shown as **actual**, an editable **expected** field, and a note ("the coupon is ignored").
- **Something is missing** asks for a role and a name ("button", "Download invoice"), checked with the engine to find
  nothing on the page, and adds a `toBeVisible` assertion on `getByRole(role, { name })`.
- **Wrong page** is `toHaveURL` with the expected path, from a fourth HUD button.

The expected mode is a dialog of the bug panel (`bug-panel.ts`) built on the assertion suggester's values
(`suggestAssertions`), not a mode of `assertion-panel.ts`, which is an injected entry that runs when it loads. It offers
the element's text, value and accessible name, and the opposite of each state it is in (hidden when visible, enabled
when disabled, and so on). A missing element's assertion records "not on the page" as its actual value.

### 2.2 Evidence

- **Screenshot.** `chrome.tabs.captureVisibleTab` from the background worker at each mark (what's wrong, missing,
  wrong page) and at Finish, three kept at most (a new one replaces the last). The recorder's per-origin grant is not
  enough: Chrome answers "Either the '<all_urls>' or 'activeTab' permission is required" (checked on the bundled
  Chromium and in `bug-report.spec.ts` against the real extension). Screenshots therefore rely on the `activeTab` grant
  of the popup click that starts the report, which lasts until the tab navigates; after that the report and the HUD say
  "no screenshot", and the popup's tile, during a bug recording, reads **Take a screenshot** (opening the popup grants
  `activeTab` again). No permission is widened.
- **Console errors and failed requests.** For the duration of a bug recording, the recorder registers a second content
  script in the page's main world (`registerContentScripts` with `world: 'MAIN'`, the same origin grant,
  `document_start`). It wraps `console.error` and `console.warn`, listens to `error` and `unhandledrejection`, and
  wraps `fetch` and `XMLHttpRequest` to note requests that failed or answered 400 or more (method, path with query
  values removed as `normalizeRoute` does, status, time). Entries reach the recorder by `postMessage` with a
  per-recording token, capped at 100 of each. No body is read.
- **Outline.** A walk over `DomModel` from the marked element's nearest landmark (the main landmark, else the body, for
  a missing element, a wrong page or a report with no mark), in ARIA snapshot YAML, at most 400 lines (D13). The last
  mark's outline is kept.
- **Context.** Origin, page key and path, browser and version, viewport, time, extension version.

### 2.3 Output

`packages/core/src/bug-report.ts`: `BugReport { steps: PiwiSteps, evidence, context }` and
`renderBugMarkdown(report)` (steps in plain words, expected and actual, the note, the evidence summarized), and
`renderBugSpec(report, options)`, the converter with the committed spec's defaults (`expectFail`, `@bug`, relative URLs,
stable locators, URL checks). The finish panel offers **Copy failing test**, **Copy report**, **Download .zip**
(`steps.json`, the spec, the Markdown, screenshots, `evidence.json`; stored without compression by `shared/zip.ts`) and,
when connected, **Send to Piwi…** (PR 5).

## Part 3 — Reproducing it

### 3.1 Replay in the developer's tab

A **Replay** tool in the popup, for a developer with their app open on the local dev server.

1. **Which report.** From a file (a `.zip` or `steps.json` a tester sent, with no instance involved), or, when
   connected, from a **Bug reports** list of the project mapped to this tab, fetched by the background worker
   (`GET /api/projects/:id/bug-reports?status=open`, then the report's steps).
2. **Where.** The steps' paths are replayed on the tab's origin (`http://localhost:3000`) unless another is chosen. The
   host permission for that origin is requested from the popup click, as the recorder does.
3. **Running across pages.** The background worker keeps the replay's state (steps, position, results) in
   `chrome.storage.session` and registers a replay content script for the origin (`registerContentScripts`,
   `document_start`), which asks for the next step on every page load, as the recorder does for recording.
4. **Finding the element.** Each step's target is resolved with the in-page engine, trying its alternatives in the
   converter's order (D6). Like Playwright, the replay waits (polling every 100 ms, up to 10 seconds) until exactly one
   element matches and, for an action, is visible, enabled and has kept the same box for two animation frames.
5. **Acting.** With the page's own events (D8), scrolled into view first:
   - `click`: pointer and mouse down, up, click at the element's center, after focusing it;
   - `fill`: focus, the native `value` setter (so React, Vue and Angular see it), then `input` and `change`;
     `contenteditable` through `beforeinput` and `input`;
   - `check`, `uncheck`: a click when the state differs;
   - `selectOption`: the native setter, then `input` and `change`;
   - `press`: key down, press and up; for Enter in a form whose key events were not cancelled, `form.requestSubmit()`,
     which the browser does not do for synthetic events;
   - `goto`: `location.assign(path)`.
   These are exactly the actions the recorder produces, so every recorded step has a replay. A step that fails to take
   effect (a fill whose value did not stick) is reported as diverged, with "run it with Playwright" offered.
6. **Checking.** An `assert` step is evaluated with the engine and core's text matching, retried for up to 5 seconds as
   `expect` retries.
7. **The verdict** (D7): reproduced, with the value found here beside the reported one; not reproduced; or diverged at
   step N, with the reason. The same main-world script as in 2.2 collects console errors and failed requests during
   the replay, so "POST /api/cart/coupon answered 500 here too" appears next to the verdict.
8. **Step mode.** The HUD highlights each target and waits for **Next**, so the developer can set breakpoints in
   DevTools before the step that matters.
9. **Reporting back.** When connected to the instance the report came from, **Share result** posts
   `{ verdict, divergedAt, origin, userAgent }` to the report (`POST /api/bug-reports/:id/reproductions`), where it
   shows as "Reproduced by a developer on localhost:3000".

### 3.2 Run with Playwright in the desktop app

For the exact verdict, a trace, and a run recorded in Piwi.

1. **Pairing.** The desktop app gets a **Connect Piwi Picker** button that shows its URL and token to paste into the
   extension's options, in a new **Desktop app** field beside the instance connection. (The extension cannot read
   `~/.piwi/desktop.json`.)
2. **The request.** **Run with Playwright** in Replay (or on a report) sends the steps and the options (headed, trace,
   Playwright project, repeat) to `POST {desktop}/api/desktop/repro-requests` from the background worker, with the
   token and a JSON body. The body is parsed with `parseSteps`; nothing in it is code (D9). The desktop server keeps the
   request for ten minutes and emits `repro-request` on `/api/desktop/events`.
3. **Confirmation.** The window shows the request: the steps, the linked project it will run in, the flags. Only the
   developer's click starts it.
4. **The run.** A new Rust command, `desktop_run_repro`, asks the local server to render the run spec (the converter
   with `expectFail: false`, the project's generated-spec settings and catalog), reads the project's test directory from
   `playwright test --list --reporter=json` (the config's `projects[].testDir`), writes the spec to
   `<testDir>/piwi-repro/bug-<id>.spec.ts`, runs `playwright test <that file>` with the project's own config through
   the existing sidecar path and flag allowlist (`--headed`, `--debug`, `--trace`, `--project`, `--repeat-each`), sets
   `PIWI_BUG_REPORT=<id>` so the reporter stamps the run, and deletes the file (and the folder, when empty) when it
   ends.
5. **The verdict.** Read from the run's result: failing on the expected assertion is reproduced, passing is not
   reproduced, failing earlier is diverged at that step. The run is a normal Piwi run in the desktop app, with its trace.
   The extension polls `GET {desktop}/api/desktop/repro-requests/:id` to show the verdict, and posts it to the report's
   instance as in 3.1.

## Part 4 — In Piwi

### 4.1 Sending

**Send to Piwi…** opens a preview of the exact payload (the steps with typed values, each evidence item) with a
checkbox per kind (D5, D15) and the project from the tab's mapping. The background worker sends
`POST /api/projects/:id/bug-reports` as multipart (a JSON part and PNG parts) with the connection's key. The first send
in a profile explains once what connected mode now sends. Limits: 5 MB per screenshot, 3 screenshots, 1 MB of JSON.
Roles: administrator, reporter or user, so a tester's key can report.

**Filing in Jira in the same step.** Before showing the preview, the extension asks the instance what a send will do:
`GET /api/projects/:id/bug-reports/intake` answers with the project's tracker binding, if any
(`{ tracker: 'jira', projectKey, locale, canCreate, fileEvery }`). With a binding, the preview adds **Also create a
Jira issue in ACME**. It is ticked when the project files every bug report (`fileEvery`, a binding setting an
administrator turns on), and offered only when the key's role can create issues (administrator or reporter, as
`POST /api/integrations/issues` requires) or the project files every report anyway. The send then carries
`createIssue: true`: the instance stores the report and enqueues the issue through the same path as the dashboard's
**Create issue**, so the outbox, the attachments and the links are the same. The extension's result says the issue is
queued and links the report's page, which shows the ticket's key once created. Reports sent without it can be filed
later from that page.

### 4.2 Storage and pages

- `bug_reports (id, project_id, title, note, page_key, path, status, steps JSON, evidence JSON, created_by,
  created_at, closed_at, closed_by_run_id, test_case_id)`, statuses `open`, `test-committed`, `looks-fixed`, `closed`,
  `dismissed`; `bug_reproductions (id, bug_report_id, source: 'replay' | 'desktop', verdict, diverged_at, origin,
  run_id, created_at)`. Screenshots go through the storage adapter under `bug-reports/<id>/`.
- `/projects/:id/bug-reports` (from the project menu) lists them by status and page; `/bug-reports/:id` shows steps,
  expected and actual, screenshots, evidence, reproductions, the Spec tab, the ticket, the owner and Why the suite
  missed it.

### 4.3 The lifecycle

1. **Test committed.** On ingest, a test whose annotations carry `piwi:bug <id>` links the report and moves it to
   `test-committed`. `parseTestMetadata` learns `piwi:bug`.
2. **Looks fixed.** The reporter sends `expectedStatus` for every result (`test.expectedStatus`), stored on
   `test_runs_cases`. A row expected to fail that passed is recorded as "expected failure passed", not clustered (D11).
   For a linked report, that moves it to `looks-fixed`, raises the event `bug.looks_fixed`, and adds a line to the
   pull-request comment: "the spec of bug #37 now passes: remove `test.fail()` in
   tests/bugs/coupon-not-applied.spec.ts".
3. **Closed.** When the spec passes as a normal test, the report closes with that run. A later failure reopens it as a
   regression, as fix verification does for clusters.

### 4.4 Why the suite missed it

From the locator index for the report's page key: the tests that visit the page, the ones whose locators reach the
marked element (its alternatives matched against their chains), and what they do with it (actions, assertions). The
detail page says it in one line and lists the tests. The same data picks the owner: CODEOWNERS of the spec file that
uses the page most, until code reach ([`suite-in-the-editor.md`](suite-in-the-editor.md)) can name the component's
owner.

### 4.5 Jira

- `POST /api/integrations/issues` accepts `entityType: 'bug_report'`; `createIssue` files it without a cluster.
- `buildBugIssueDocument`, beside `buildIssueDocument`, in the same locales and ADF rendering: what happened (steps,
  expected, actual, the note), evidence, the failing test (the committed spec with this ticket's key), reproductions,
  why the suite missed it, links. Labels `piwi`, `piwi-bug-<id>`.
- Screenshots are attached through a new `attach` outbox action calling the client's existing `attach()`.
- `entity_links` gains `bug_report_id`. `commentOnFix` and `transitionOnFix` fire on `looks-fixed`; `resolveOnClose`
  and `reopenOnTicketReopen` follow the ticket.
- The MCP tool `create_issue` accepts the new entity type.
- **Where it is created.** From the Send preview (4.1); from the report's page, with **Create issue** and the modal
  clusters use; from the MCP tool; and automatically on receipt when the binding files every bug report.
- **The ticket's language** is the binding's ticket language (English or French today), whatever language the report
  was written in. Piwi's own parts (headings, facts, links) are in that language, as for clusters. The steps and
  expectations are written again from the steps document with core's phrasebook for that language (see
  [`extension-localization.md`](extension-localization.md), PR 3), so a report written in German files as a French
  ticket in French. The reporter's own words (the title, the note, a value they typed as expected) stay as typed, and
  a line says which language the report was written in when it differs; the send carries it. A ticket language with no
  phrasebook falls back to English.

### 4.6 Agents and the Test Map

- MCP `list_bug_reports { projectId, status? }`, `get_bug_report { id }` (steps, evidence, reproductions, the tests on
  the page) and `render_steps` (1.3).
- A skill, `fix-a-reported-bug`: fetch the report, `piwi bug <id> --write`, reproduce, fix, remove `test.fail()`, run
  the spec and the tests that visit the page.
- `detectEscapedDefect` gets its loader from `bug_reports`, so reported bugs feed escape history and page exposure.

## Delivery

| PR | Content | Needs |
|---|---|---|
| 1 | Core: `PiwiSteps` and `parseSteps`, `assert` steps, the converter options; the recorder's Download steps; `piwi codegen` (built) | — |
| 2 | Extension, reporter side: Report a bug, expected and missing assertions, evidence, `renderBugMarkdown`, local exports | 1 |
| 3 | Extension, developer side: Replay from a file, the verdict, step mode, a fake cursor (built) | 1 |
| 4 | Reporter and app: `expectedStatus`, the "expected failure passed" outcome, `piwi:bug` | — |
| 5 | Dashboard: `bug_reports`, reproductions, endpoints, pages, Spec tab and project settings, **Send to Piwi…**, Replay from the instance, `piwi bug`, MCP tools, capability `bug-reports` | 1–4 |
| 6 | Desktop: pairing, repro requests, `desktop_run_repro` | 1, 5 |
| 7 | Jira: the bug entity, the document in the ticket's language, attachments through the outbox, sync; filing from the Send preview and the report's page | 5 |
| 8 | Why the suite missed it, escapes for the Test Map, the skill | 5 |

PRs 1–3 close the loop between a tester and a developer with files alone: record, send the zip, replay on
`localhost`, copy the failing test. PR 4 gives every `test.fail()` spec the "looks fixed" signal on its own.

## File-by-file checklist

### PR 1 — steps and the converter (built)
- `packages/core/src/steps.ts` (new: `PiwiSteps`, `toStepsDocument`, `sessionFromSteps`, `parseSteps`),
  `recording.ts` (`assert` steps, `StepAssertion`), `codegen.ts` (options, `safeLocator`, `pageUrlPattern`, warnings),
  `./steps` in `packages/core/package.json`.
- `apps/extension/src/content/record-panel.ts` (Download steps), `packages/reporter/src/cli/codegen.ts` (new),
  `cli/index.ts`.
- Tests: `packages/core/tests/steps.test.ts` and `codegen.test.ts` (every option, assertions, the default output
  unchanged, locators that are code refused, a spec with every option parsed by TypeScript);
  `packages/reporter/tests/codegen-cli.spec.ts`; in `apps/extension/tests/e2e/record.spec.ts`, a real recording
  across two pages, downloaded, parsed, rendered and run on a new page with Playwright's `expect`, passing as recorded
  and failing on a wrong expected value.
- Docs: `features/extension.md` (Download steps), `reference/cli.md` (`codegen`), `reference/steps-format.md` (new),
  the CLI drift check in `apps/application/tests/unit/docs-drift.test.ts`, D20 in `1.0-stabilization.md`.

### PR 2 — reporting (built)
- `packages/core/src/bug-report.ts` (new: `BugReport`, `renderBugMarkdown`, `renderBugSpec`, `reportedRequestUrl`,
  `bugContextFrom`), `recording.ts` (`assert` raw events, kept in place by `normalizeSteps`), `./bug-report` in
  `packages/core/package.json`; tests in `bug-report.test.ts` and `recording.test.ts`.
- `apps/extension/src/content/bug-panel.ts` (new: HUD, the three dialogs with the expected mode, screenshots, the relay,
  the finish panel), `bug-evidence-main.ts` (new, main world), `bug-outline.ts` (new), `bug-report-files.ts` (new, pure:
  the report and the archive's files), `record-ui.ts` (new: the recorder's shared host ids and helpers),
  `record-panel.ts` (bug mode, assert events, pause), `src/shared/bug-storage.ts`, `bug-relay.ts`, `zip.ts` (new),
  `recording-storage.ts` (mode, token), `src/background/index.ts` (screenshot, main-world registration, message types),
  `src/popup/` and `popup.html` (tile `B`), `scripts/build.mjs` (entry).
- Docs: `features/report-a-bug.md` (new, in the feature catalog `apps/application/shared/piwi-features.ts`, since
  `features/extension.md` is at its word budget; the extension page links it from its tool table),
  `apps/extension/ARCHITECTURE.md` (Report a bug, the main-world script, screenshots).
- Tests: `apps/extension/tests/e2e/bug-report.spec.ts` on the fixture shop (`bug-shop.ts`): record, mark, missing
  element (one on the page refused), console error and warning, failed request, outline, each export, and the steps
  rendered and run on a new page, failing on the marked assertion and passing once the shop is fixed; wrong page and no
  screenshot; Escape during the pick; the real extension (main-world registration, cross-world relay, refused
  screenshot, unregistration); the outline's format and its 400-line cut. Unit tests for the storage caps, the relay's
  validation, the archive and the zip writer; the popup tile in `popup.spec.ts`.

### PR 3 — replay (built)
- Built as `replay-panel.ts` (chooser, panel, run loop), `replay-actions.ts` (resolution with `stepLocator`, the
  actions), `replay-core.ts` (assertions with Playwright's rules, the verdict), `replay-cursor.ts` (the fake cursor:
  an arrow that glides to each element, a ripple on clicks, a caption, still with reduced motion), `steps-file.ts` and
  `readZipEntry` (a report's `.zip` or `steps.json`), `shared/replay-storage.ts`, the background's `piwi-start-replay`
  and `piwi-replay-finished`, the popup's **Replay a bug report** (`R`) and the finished report's **Replay**.
- Built after PR 6: the **evidence of a replay** (the background registers `bug-evidence-main.js` in the main world
  beside the replay script, under the replay's `evidenceToken`; the panel keeps the entries in `piwiReplayEvidence`
  and lists up to five under the verdict, failed requests first). It says what the page showed here, not "here too":
  the replay has the steps, not the report's evidence. **Share result** (`share-result.ts`) follows a verdict of a
  report chosen from the instance, in the replay HUD and in Run with Playwright's dialog (`source: 'desktop'`), and
  sends the verdict, the step it diverged at, the origin (none for a desktop run) and the user agent after a preview.
- The replay lab after PRs 6 and 3: 23 of 24 scenarios pass both ways (import-file its known gap).
  `project-tests-search` times out before recording, at its first step: it opens a "Piwi Dashboard" project that
  neither the dev database nor `app:seed:dev`'s demo seed holds. That is a data mismatch in the scenario, not in the
  replay, and it is left to whoever keeps the lab.
- `apps/extension/src/content/replay-panel.ts` (new, HUD and verdict), `replay-actions.ts` (new, events per action),
  `replay-runner.ts` (new, waiting and resolution with the engine), `src/background/index.ts` (state and
  registration), `src/popup/` (tile).
- Tests: e2e on the fixture shop served on two origins (record on one, replay on the other): reproduced, not
  reproduced (bug fixed in the fixture), diverged (element removed), React-controlled input, Enter submitting a form,
  step mode; unit tests for the verdict.
- Docs: `features/extension.md` (Replay, its limits).

### PR 4 — expected status (built)
- `packages/reporter/src/public/reporter.ts`, collected and wire types, serializer;
  `apps/application/server/utils/blob-report.ts` (importer); `packages/core/src/wire.ts`, `status-classify.ts`,
  `test-meta.ts` (`piwi:bug`).
- App: schema and migrations (`test_runs_cases.expected_status`), no clustering for the new outcome, counts and badges,
  `shared/pr-feedback.ts`, the notification event.
- Docs: `reference/test-metadata.md`, `reference/notification-events.md`, `features/pr-feedback.md`.
- Built as: `resolveExpectedStatus`, `isExpectedFailurePassed` and `normalizeExpectedStatus` in
  `packages/core/src/status-classify.ts`; `piwi:bug` read by `parseTestMetadata` as `TestMetadata.bug`; the column
  `test_runs_cases.expected_status`, written by every ingest path and, for a payload without the field (an older
  reporter, a blob report without it), derived from the `fail`, `skip` and `fixme` annotations. Decisions made while
  building:
  - **The stored status stays `failed`**, as Playwright reports it, so the run's counts and CI agree. "Expected failure
    passed" is read, not stored: a `failed` row whose expected status is `failed` (an expected failure that did fail is
    stored `passed`). No run-level counter was added; the row's **Looks fixed** badge, the execution page's header
    and the pull-request comment's **Looks fixed** section name it.
  - **`bug.looks_fixed` fires for every `test.fail()` test that passes**, once per run, with the `piwi:bug` id and the
    `piwi:link` each test names, whether or not a bug report exists; PR 5 adds the report's state change to it.
  - The pull-request line reads "the spec of bug #37 now passes: remove `test.fail()` in `<file>`" and links the
    execution; PR 5 links the report.
  - Tests: `status-classify.test.ts`, `test-meta.test.ts` (core); `expected-status.spec.ts`, `serializer.spec.ts`
    (reporter); `blob-report.test.ts`, `pr-feedback.test.ts`, `notification-events.test.ts` and the e2e
    `expected-failure.spec.ts` (app). D22 in `1.0-stabilization.md` covers the wire field, the annotation and the
    event.

### PR 5 — dashboard (built)
- Schema and migrations for `bug_reports`, `bug_reproductions`, `test_cases.bug_report_id`, the project's
  generated-spec settings; `server/api/projects/[id]/bug-reports.post.ts` and `.get.ts`,
  `server/api/bug-reports/[id].get.ts`, `.patch.ts`, `reproductions.post.ts` (new); `shared/handlers/bug-reports.ts`
  (new); `app/pages/projects/[id]/bug-reports.vue`, `app/pages/bug-reports/[id].vue` (new); the project menu.
- `apps/extension/src/shared/piwi-client.ts` (POSTs), the options page (one-time explanation), Replay's instance list.
- `packages/reporter/src/cli/bug.ts` (new); `shared/mcp-tools.ts`, `server/utils/mcp/tools.ts`;
  `shared/capabilities.ts` and the setup ladder.
- Docs: `features/bug-reports.md` (new), `reference/cli.md`, `navigation.ts`, `guide/privacy.md`.
- Built as: `parseBugReport` in core (the steps through `parseSteps`, evidence and context field by field, capped);
  `bug_reports`, `bug_reproductions`, `test_cases.bug_report_id`, `projects.generated_specs`; the endpoints above plus
  `GET /api/bug-reports/:id/spec` and `GET /api/bug-reports/:id/screenshots/:index`; `shared/handlers/bug-reports.ts`
  (storage, lists, the spec with the project's catalog and suite locators, `applyBugReportLifecycle`, run from
  `runFinalizeSideEffects`); the list page and the report page (Steps, Evidence, Reproductions, Spec), **Bug reports**
  in the project's More menu, **Generated specs** in the project settings; the demo seeds one report; `piwi bug` and
  `piwi codegen bug:<id>`; the MCP tools `list_bug_reports`, `get_bug_report`, `render_steps`; the capability
  `bug-reports` and its Setup entry. In the extension: `bug-send.ts` (pure payload), `bug-send-panel.ts` (the preview),
  `src/background/bug-reports.ts` (the worker's messages), the client's `sendBugReport`, `fetchBugReports`,
  `fetchBugReportSteps`, and Replay's list from the instance. Decisions made while building:
  - **The one-time explanation sits in the preview**, not in the settings page: it shows before the first send of a
    profile (`piwiBugSendExplained`), where the reader is deciding.
  - **Leave out the values I typed** also removes those values from the evidence that repeats them: the extension's
    e2e found the outline holding a text box's value (`textbox "Coupon": SPRING10`). They become `…` in the outline and
    in console messages.
  - **The worker resolves the project from the sending tab's URL** and never takes one from the page; the preview
    names the project and the instance it will go to.
  - **The lifecycle reads the last attempt of each test that names a report**: an expected failure that passed →
    looks fixed; an ordinary pass → closed; anything else that ran → test committed (a closed report's test failing
    again reopens it there). Only reports of the run's project move; `dismissed` never does.
  - **The spec is rendered on the server** (`GET /api/bug-reports/:id/spec`), so the page, `piwi bug` and MCP share it;
    `mode=run` is the reproduction's twin without `test.fail()`.
  - The list shows every status with a filter rather than grouping by page; the page key is on each row.
  - Tests: `bug-report.test.ts` (core), `bug-cli.spec.ts` (reporter), `bug-reports.spec.ts` (app e2e: send with a
    screenshot, refusals, both specs, a reproduction, the lifecycle through four runs, the pages), `bug-send.test.ts`
    and `bug-send.spec.ts` (extension: the preview and what it sends, and the real worker against a stub instance).

### PR 6 — desktop (built)
- Built as planned, with these decisions:
  - **The verdict comes from the spec itself.** The rendered spec ends with an `afterEach` hook that writes the
    test's status, the spec line of its first error and the message to the file `PIWI_REPRO_RESULT` names; the core
    converter now returns `stepLines` (the line each step starts on), and `specRunVerdict` in
    `@piwitests/core/bug-report` reads failing on an `assert` step as reproduced, failing elsewhere as diverged at
    that step, and passing as not reproduced. The run is still a normal Piwi run through the project's own reporter,
    but it is not stamped: `PIWI_BUG_REPORT` is not set, since the verdict no longer needs the run.
  - **The window picks the project.** A request carries steps, not a project: the confirmation lists the projects
    linked to a folder on this machine and the developer picks one; the spec is rendered with that project's
    settings, catalog and suite locators (`renderStepsRunSpec`).
  - **The shell fetches the spec itself** from the bundled server (`GET /api/desktop/repro-requests/:id/spec`, with
    its own token over loopback), so the webview never hands it code; `repro_spec_path` refuses a test directory
    outside the linked folder once both are resolved, and a request id that is not short hex.
  - **A PATCH records what the window did** (`running` with the project, `declined`, `done` with the verdict), which
    is what Piwi Picker polls; requests live in memory ten minutes after their last change.
  - **Options are sent as defaults** (headed and a trace); the developer changes them in the window.
  - **Connect Piwi Picker** is a card on the desktop app's Setup page (address and token), beside the reporter's.
  - Posting the desktop verdict to the report's instance is left to **Share result**, which serves both kinds of run.
- Verified: Rust unit tests on the path handling, app unit tests on the request parsing and store, app e2e with a
  faked bridge (the dialog, the run, the verdict recorded, declining), extension e2e (the preview, nothing sent
  before Send, the real worker against a stand-in app), and by hand against a built server in desktop mode: 401
  without the token, 415 for a non-JSON body even with it, 400 for steps `parseSteps` refuses, and a page's preflight
  refused; the rendered spec run with Playwright in a scratch project wrote its result, read as reproduced on the
  buggy page and not reproduced on the fixed one. Not run: the Tauri window itself (no desktop e2e build here).
- `server/api/desktop/repro-requests.post.ts`, `[id].get.ts`, `[id]/spec.get.ts` (new);
  `server/utils/desktop-handoff.ts` (`repro-request`); `apps/desktop/src-tauri/src/runner.rs` (`desktop_run_repro`),
  `lib.rs` (registration); the window's confirmation dialog and **Connect Piwi Picker**; the extension's Desktop app
  setting.
- Tests: the endpoint rejects a non-JSON body and a body `parseSteps` refuses; the Rust command's path handling (the
  spec stays under the test directory); a desktop e2e run of a repro.
- Docs: `features/desktop.md`.

### PR 7 — Jira (built)
- `server/utils/integrations/create.ts`, `actions.ts` (`attach`), `sync.ts`, `known-issue.ts`;
  `shared/integrations/build-issue.ts` (`buildBugIssueDocument`, the steps through core's phrasebook for the ticket
  language), `messages/en.ts`, `messages/fr.ts`; schema for `entity_links.bug_report_id` and the binding's `fileEvery`;
  `server/api/integrations/issues.post.ts`.
- `server/api/projects/[id]/bug-reports/intake.get.ts` (new); `bug-reports.post.ts` (`createIssue`, the report's
  language); **Create issue** on `app/pages/bug-reports/[id].vue`; **File every bug report** in the project's tracker
  settings.
- `apps/extension/src/content/bug-panel.ts` (the preview's checkbox and result), `src/shared/piwi-client.ts` (intake).
- Tests: a send with `createIssue` enqueues exactly one create action, and one with `fileEvery` too without it; a
  `user` key is not offered the checkbox and cannot create unless the project files every report; a report written in
  German files a French ticket whose steps read in French and whose note is unchanged.
- Docs: `features/issue-tracking.md`, `features/report-a-bug.md`.
- Built as: `entity_links.bug_report_id`; `bug_report` as a link entity and an issue entity (`IssueEntityType`), in the
  draft (`buildBugReportDraft`), `createIssue` (`createBugReportIssue`, no cluster, the link on the report) and the MCP
  tool; `buildBugIssueDocument` in `shared/integrations/build-issue.ts` with the steps through `bugPhrases(locale)`;
  `buildBugReportIssue` in `documents.ts`; the `attach` outbox action, queued per screenshot once the issue exists;
  `server/utils/integrations/bug-reports.ts` (intake, `fileBugReportIssue`, `shouldFileOnSend`,
  `followBugReportTickets`); `enqueueBugLooksFixedPolicies`; the bug-report branch of the tracker sync; the intake
  endpoint; **Create issue** and the ticket on the report's page; **File every bug report** in the project's sync
  settings; in the extension, the intake read with the send target, the preview's checkbox and the result line.
  Decisions made while building:
  - **`fileEvery` is a sync policy** (`policies.fileEveryBugReport`), stored with the binding's other policies, so it
    needs no column; the intake answers it as `fileEvery`.
  - **The committed spec in the ticket carries `piwi:bug`, not the ticket's key**: the key exists only once Jira
    answers, and the spec is rendered before. The ticket links the report, whose Spec tab is the reference.
  - **A `createIssue` a role may not make is refused (403) before the report is stored**, unless the project files
    every report; a send never fails because Jira did, the report is kept and the answer's `issue` says what happened.
  - **The ticket follows the report on looks fixed** with the cluster policies (`commentOnFix`, `transitionOnFix`),
    and the report follows the ticket (`resolveOnClose`, `reopenOnTicketReopen`); "why the suite missed it" joins the
    ticket with PR 8.
  - Tests: `integrations-bug-issue.test.ts` (a German report files a French ticket, its steps in French, the note
    unchanged), `bug-reports-jira.spec.ts` (intake, a send that does not ask files nothing, one that asks files exactly
    one issue with its screenshot attached, `fileEvery` files without asking, filing from the page and its draft; a
    `user` key's refusal on the CI auth server), and the extension's `bug-send.spec.ts` (the checkbox and
    `createIssue` on the wire).

### PR 8 — missed-by and escapes (built)
- `shared/handlers/bug-reports.ts`, `shared/handlers/scenario-gaps.ts` (escaped-defect loader),
  `packages/reporter/templates/skills/fix-a-reported-bug/SKILL.md` (new), `cli/skills.ts`.
- Docs: `features/agent-skills.md`, `features/scenario-gaps.md`.
- Built as: `computeMissedBy` and `describeMissedBy` (`shared/bug-report-missed-by.ts`, pure: the page of the first
  marked step, the tests whose uses ran on it, and for each marked element the tests whose chains find it through
  core's `lookupLocators`, with what they assert); `getBugReportMissedBy` in the shared handler;
  `GET /api/bug-reports/:id/missed-by` (adds the owner of the spec file whose tests visit the page most, through
  `resolveOwners`); the report page's **The suite** line; `missedBy` in `get_bug_report` and a section of the Jira
  ticket; `detectReportedBugEscapes` with its loader in `computeScenarioGaps`; the skill in
  `packages/reporter/templates/skills/fix-a-reported-bug/SKILL.md`, registered in `cli/skills.ts`. Decisions made
  while building:
  - **An escape is a gap per page, from the open reports only**: a report whose test is committed is no longer a
    blind spot, since the test now guards it. The gap closes when no open report is left on the page. The exposure
    factors keep reading the SCM's files; a page gap has none, so it ranks on its confidence (0.6, more with more
    reports).
  - **A use recorded on another page does not count as reaching the element**, even when its chain matches: the same
    test id on the checkout page is another element.
  - **Without page data** (no capture fixtures), the line says the visits are unknown rather than "no test visits".
  - Tests: `bug-report-missed-by.test.ts` (the counts, a same-id element on another page left out, no pages, the
    escape gaps) and the e2e read in `bug-reports.spec.ts`.

## Verification

1. On the fixture shop with a coupon bug, served as "staging": record the flow, mark the total, finish. The rendered
   spec, run with Playwright against the same server, fails on the assertion; with `test.fail()` it passes.
2. Serve the same shop on a second origin as "localhost": Replay reproduces with the reported value. Fix the bug on that
   origin: not reproduced. Remove the coupon field: diverged at step 2.
3. The evidence has the 500 and the console error, during the recording and during the replay.
4. Without a connection, every export and Replay from a file work, and no request leaves the browser (checked in e2e).
5. Connected, **Send to Piwi…** shows the preview; unchecking console errors removes them from the stored report.
6. In the desktop app, a repro request waits for confirmation; the run writes the spec under the test directory, runs
   headed with a trace, deletes the spec, and the verdict reaches the extension and the report.
7. A page on `localhost` that posts to the desktop's repro endpoint is refused (no CORS for a JSON body, no token).
8. Commit the spec, fix the bug, run: the report moves to looks fixed, the pull-request comment says to remove
   `test.fail()`, the ticket gets the fix comment. Remove it and run: the report closes.

## Risks

- **Replay fidelity.** Synthetic events are not trusted input. The replayed actions are limited to what the recorder
  records, the native setters cover the common frameworks, form submission is handled explicitly, and a step that does
  not take effect is reported as diverged with the desktop run offered. An app that ignores untrusted events can only be
  reproduced in Playwright.
- **Specs that depend on data.** A report recorded on staging may need a user, a cart, a coupon that the local database
  lacks. "Diverged at step N" names the step, and the report keeps the original origin and time.
- **Sensitive data in evidence.** Nothing is sent without the preview; each kind can be left out; request bodies are
  never read.
- **The main-world script.** It runs in the page and can be affected by it. It only listens and wraps, and it is
  registered only while a bug recording or a replay runs.
- **The desktop endpoint.** Loopback, token, JSON-only, steps-only and a confirmation in the window. The spec is
  written by the desktop from the steps, under the test directory, and removed.

## Open questions

1. **Screenshots across navigations.** Settled in PR 2: the origin grant does not satisfy `captureVisibleTab`, so
   screenshots are taken under the `activeTab` grant (the Report a bug click, then **Take a screenshot** from the
   popup), and the HUD and the report say when there is none (see 2.2). Not verified in a test, since a test cannot
   click the toolbar icon: how long the popup click's grant lasts in practice (Chrome documents it as ending when the
   tab navigates).
2. **Reports from people without an API key.** Recommendation: not in this plan; a report-only key would need API key
   scopes, which do not exist yet.
3. **Other trackers.** Recommendation: follow the issue-tracker plan's order; the bug document is written against the
   `IssueTracker` interface, not Jira.
4. **Pairing with the desktop app.** Copying a URL and a token works but is clumsy. Recommendation: start with it; a
   one-time code shown in the window and typed in the extension can replace it later.
5. **A companion extension with `debugger`.** Settled 2026-09-28: Piwi Picker carries the permission itself (D8).

## Not in this plan

- Video or session replay of the recording.
- Reports from a mobile browser, and replay in Firefox.
- Automatic deduplication of reports; a report page lists the other open reports on the same page.
- Parsing hand-written specs back into steps.
- Generating the fix; the skill hands that to a coding agent with the steps and the evidence.
- Filing in Jira without an instance. The extension would need Jira credentials and would send page data to
  Atlassian. A pre-filled create-issue link (`/secure/CreateIssueDetails!init.jspa?pid=…&summary=…&description=…`)
  needs neither, but Atlassian does not support it on Jira Cloud
  ([JRACLOUD-69267](https://jira.atlassian.com/browse/JRACLOUD-69267)) and it cannot attach files. Without an
  instance, the reporter attaches the report's zip and pastes its Markdown by hand.
