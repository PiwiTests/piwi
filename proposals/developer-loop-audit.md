# The developer loop: an audit from a new test to a fixed one

An audit of what a developer meets between an empty spec and a green test: writing the test, running it, watching it
run, stopping it to look, and fixing it, with every tool Piwi ships for that loop. The reporter and its capture
fixtures, the dashboard's run and failure pages, the VS Code extension and the JetBrains plugin with the editor service
they share, Piwi Picker and the desktop app are covered where a developer meets them, and the JetBrains plugin is held
to what the VS Code extension does. Test coverage and the Test Map's gaps are left to another audit.

**Status.** Proposed 2026-10-31, against `main` at v0.63.0 (`2bd05d42`). Built: quick wins 1 to 4 of
[the plan](#11-the-plan), the failing line kept (F1, F2), wrapped statements that stop (D1), a browser headed as the
test's fixtures make it, with no Inspector switch left to the projects that depend on a worker's (D2, D8), and a spec
without the capture fixtures named in a run that can stop, the editor's answer naming that cause (S1; `init` still
leaves the imports to the person). Quick win 5 is built in part: a new test in a spec that takes no `test` imports it
as the specs beside it do (W1), each recorded test gets a title no test of its file has (W2; asking the person for one
needs both clients), and a new file takes `expect` from a module that exports it (W3). Left from it: catalog imports
relative to the spec (W4), since a catalog entry's module names no folder it is relative to. The rest is proposed. A
pull request that builds part of the plan updates this paragraph.

**Summary.** Every step of the loop exists, most of them in several tools, and most of it works as documented: a
breakpoint stops a headed run under the pause bar, Step and Resume answer, a picked locator lands on its line, a
recording writes a test that passes three times out of three, and a failure reaches the dashboard with the replacement
locator in its Next row. What breaks is at the seams between the tools, and it breaks silently. Twelve findings lead
(§0): a breakpoint on the first line of a wrapped statement never stops; the failing line is lost when an action times
out, and with it **Debug in my editor**; the JetBrains gutter's Run is not a Piwi run; a recording into an empty spec,
or a second one into the same spec, does not run; the desktop app's reproduce and bisect can empty the checkout's
`node_modules`, and its runs cannot start a dev server from `node_modules/.bin`; a stale Piwi Picker pairing looks
healthy everywhere; a spec without the capture fixtures, or one made headed in the spec, never stops and the message
blames something else; a pick or a recording at a stop is placed by a line number the edits have moved; the first
failure page of a new test explains it wrongly; the run page never shows the call a stuck test waits in; and work in
progress from developers' machines fills the team's failure inbox. [§11](#11-the-plan) ranks the changes: thirteen
contained fixes first, each with the test that holds it, then the parity work.

Every finding carries a file reference. **(seen)**: observed first-hand in a fresh project, as §1 describes. **(ran)**:
reproduced with a script or a real Playwright run against the code at that commit. **(read)**: from the code alone.

One name per thing, used throughout: the **pause bar** (Piwi's bar at the top of a stopped headed page,
`packages/picker-dom/src/overlay-pause.ts`); a **stop** (a worker held at a call: a breakpoint, Step, Pause,
`page.pause()` or a held failure); the **editor service** (`packages/editor`, the language server both IDE clients
run); the **Runs window** (Piwi Picker's `runs.html`); the **tray** (the desktop app's Local runs tray); the
**failure page** (`/test-run-cases/:id`).

---

## 0. The findings that matter most

1. **A breakpoint on the first line of a statement wrapped over several lines never stops** ([D1](#d1)). Prettier wraps
   `await expect(page.getByRole(…)).toBeVisible()` and long chains over three lines, and the gutter click lands on the
   `await` line. The reporter matches `file:line` exactly, while the stop's line is the line of the call itself
   (`packages/reporter/src/internal/capture/pause-at.ts:30-42`); nothing says why the run went through. Run to cursor
   on that line runs through too. **(ran)**

2. **The failing line is lost when an action times out, and with it Debug in my editor** ([F1](#f1), [F2](#f2)). A
   new test's usual failure is a click on a locator that matches nothing; under Playwright's defaults it ends as a test
   timeout, whose first error has no location. The reporter takes the location of that first error only
   (`packages/reporter/src/internal/collect/error-text.ts:16`), so the failure page marks the `test(` line as **Failed
   here** and offers no **Debug in my editor**, with traces on or off. A run started outside the config's folder loses
   the failing line of every failure, whatever its kind. **(seen)**

3. **In a JetBrains IDE, the gutter's Run is not a Piwi run** ([P1](#p1)). VS Code puts **Run with Piwi** on each
   test's gutter through the Testing view; the JetBrains plugin never asks for the test items, and its result icon only
   opens the dashboard. The IDE's own run is followed as a run started outside Piwi: headless by default, no Stop, and
   Pick, Record and Assert in the test's window are not written. **(read)**

4. **A recording into an empty spec, or a second one into the same spec, does not run** ([W1](#w1), [W2](#w2),
   [W3](#w3)). Record here in an empty spec writes `test('recorded flow', …)` and imports only `expect`; a second
   recording repeats the title and Playwright refuses the whole file; a new file imports `expect` from a fixtures module
   that may not export it. **Run** and **Verify ×3** are still offered after each. **(ran)**

5. **The desktop app's reproduce and bisect can empty the checkout's `node_modules`** ([R1](#r1)). A worktree links
   the checkout's `node_modules` when the lockfile matches; a later bisect step whose lockfile differs runs `npm ci`
   through the link. In a workspace monorepo every step imports the checkout's own packages, so a bisect tests the
   current code at every commit. **(ran)**

6. **The desktop app's runs cannot start a dev server from `node_modules/.bin`** ([R2](#r2)), and the app takes port
   3000, the default of most dev servers ([S5](#s5)). A `webServer` that runs `vite`, `next` or `npm run dev` exits with
   127, every bisect step is judged bad, and the wrong commit is recorded as the first bad one. **(ran)**

7. **A stale Piwi Picker pairing looks healthy everywhere** ([S6](#s6)). Pair saves the address and shows **Paired**
   without asking the editor; when the editor comes back on another port or token, the settings still say Paired, the
   popup hides the Runs tile, and the Runs window offers only **Look again**, with advice that contradicts Send to
   editor's. **(seen)**

8. **A spec without the capture fixtures, or one made headed in the spec, never stops, and the message blames something
   else** ([S1](#s1), [D2](#d2)). `init` leaves the existing specs on `@playwright/test`; such a spec runs past every
   breakpoint with no word, and the editor's Pause answers that no worker is connected. A browser made headed by
   `test.use({ headless: false })` is read as headless, and the run says to set what the spec already sets. **(ran)**

9. **A pick or a recording at a stop is placed by a line number the edits have moved** ([F3](#f3), [F4](#f4)). Record
   here at a breakpoint writes its steps above the paused line; a Pick at the same stop then replaces the locator on the
   run's line number in the edited file, which now holds a recorded step, and the notice says it worked. **(ran)**

10. **The first failure page of a new test explains it wrongly** ([F5](#f5), [F6](#f6)). For a locator that matched
    nothing, **Most likely** says the failure used the timeout budget, "a slow operation, not necessarily a wrong one",
    above a Next row that rightly says to replace the locator; the Locator fix panel then says to enable the capture
    fixtures the test already uses. **(seen)**

11. **The run page never shows the call a stuck test waits in** ([V1](#v1), [V2](#v2)). Step events are sent only
    while someone watches, the reporter learns it 5 to 10 seconds after the page opens, and the call already running
    then is never sent: a test held 25 seconds by one click reads **In progress…** until it fails. **(seen)**

12. **Work in progress from developers' machines fills the team's failure inbox** ([V3](#v3)). The inbox lists every
    open cluster of the projects a person can read, whatever the run's origin or branch, so each broken attempt at a
    new test, run locally against the team instance, is an item for the team to triage. **(seen)**

---

## 1. Method

**Hands-on, in a fresh project.** A Playwright project scaffolded with
`npm init playwright@latest -- --quiet --browser=chromium --lang=ts` (Playwright 1.64.1), then connected with
`piwi init --server-url … --project …` from the reporter built at this commit, packed and installed in place of the
published one. The application under test was the sample shop of `examples/sample-app` (its Nitro backend); the
instance a dashboard dev server seeded with the demo data. New specs were written by hand, run from the terminal, a
headed run under Xvfb was stopped with `PIWI_PAUSE_AT` and its pause bar answered over the browser's DevTools protocol,
and the run and failure pages were driven with Playwright while the runs went on.

**By surface, with what each could run.** The pause and run-control chain was driven by real `playwright test` runs
under a scripted editor on `PIWI_RUN_CHANNEL`. The editor's recorder ran through the real recording sessions, the
launcher and the recorder's IDE bundle, with trusted input, and the code it wrote was type-checked and run against the
sample shop. Piwi Picker was built and driven in Chromium against the real editor service and its hub. The desktop
app's front end and its unit tests ran; its Rust shell was read, and the behaviors it hands to npm and Playwright were
reproduced with those tools directly. The two IDE clients were compared by reading, with a scripted diff of the
protocol's TypeScript interfaces against the Kotlin classes.

**What could not be run here:** VS Code and a JetBrains IDE themselves, the built Tauri app, Windows, macOS and Firefox.
Findings that depend on them are marked **(read)**.

---

## 2. Set up

What works: `init` is quick and safe to re-run, wraps the config, writes the fixtures file, records the connection,
and its closing lines say what is left to do **(seen)**; an instance that cannot be reached neither slows nor fails a
run, and one recovery copy per instance and project is kept for the next run
(`packages/reporter/src/internal/streaming/crash-recovery.ts:22`) **(seen)**; the editors read the connection the
reporter uses; Piwi Picker proves an editor holds the pairing's token before it sends anything **(seen)**.

<a id="s1"></a>**S1. `init` leaves every existing spec on `@playwright/test`, and a spec without the capture fixtures
never stops, with no word.** `init`'s last lines, and step 02 of the dashboard's Setup page, say to change each spec's
import by hand. Until then breakpoints, Pause, the live view and the locator snapshots behind healing do nothing for
that spec: the pause is armed in `piwiCapture` alone (`packages/reporter/src/internal/capture/capture-fixtures.ts:3843-3848`),
the run prints nothing about it, and the editor's Pause answers `No worker of this run is connected to the editor.`
(`packages/editor/src/run-sessions.ts:627`), the line a reporter older than run control gets too. **(seen, ran)** Fix:
`init` offers to rewrite `import { test, expect } from '@playwright/test'` in the specs under `testDir`; the reporter
says once per run which spec ran without the fixtures while breakpoints or a run channel are set; the service's answer
names that cause.

<a id="s2"></a>**S2. `init` writes the fixtures to `tests/` whatever `testDir` says, and no authoring path imports
them.** `packages/reporter/src/cli/init.ts:210` writes `tests/fixtures.ts`; the recorder takes the import most specs of
the same folder use (`packages/editor/src/recorder/sessions.ts:287-318`), `piwi codegen` defaults to `@playwright/test`
(`packages/reporter/src/cli/codegen.ts:163`), and so does the scenario-gap draft
(`apps/application/shared/handlers/scenario-gaps.ts:4048`). In a project whose `testDir` is `./e2e`, a test recorded
right after `init` runs without the fixtures. **(ran)** Fix: write the fixtures inside `testDir`; when no sibling
imports a module that extends `piwiFixtures`, every authoring path imports from that file.

<a id="s3"></a>**S3. The scaffold's `trace: 'on-first-retry'` survives `init`, so a local failure arrives without a
trace.** `wrapConfig` sets the screenshot when the config sets none, and says so; it leaves an explicit `trace`, and
with `retries: 0` locally no retry records one. The failure page then has no DOM snapshot, no full call stack and no
Pick from trace, and its Source tab suggests `retain-on-failure`. **(seen)** Fix: `init` reports it as a manual step,
with the edit, as it reports a config it cannot wrap.

<a id="s4"></a>**S4. `init`'s edit of the config ignores the file's style.** It adds
`import { wrapConfig } from '@piwitests/reporter'` without a semicolon to a file that uses them, and does not indent
the wrapped `defineConfig(…)`: the first diff Piwi makes in a project fails a formatter's check. **(seen)** Fix: follow
the file's semicolons and indent the wrapped call.

<a id="s5"></a>**S5. The desktop app takes port 3000, the default of most dev servers.** `DEFAULT_PORT` is 3000
(`apps/desktop/src-tauri/src/lib.rs:91`), and a taken port falls back to a random one that is not saved
(`lib.rs:470-482`). With the app started first, a suite whose `webServer` waits for port 3000 with
`reuseExistingServer` starts no server and runs against the dashboard, which comes to the front at each `page.goto`
(`apps/application/server/middleware/desktop-handoff.ts`). With the dev server first, each launch takes a new port,
and the Piwi Picker pairing and any hand-set reporter URL stop working. **(read)** Fix: a port of its own, and the
fallback saved.

<a id="s6"></a>**S6. A stale Piwi Picker pairing looks healthy everywhere, and nothing offers to pair again.** Pair
stores the address and shows **Paired** without asking the editor anything (`apps/extension/src/options/main.ts:1215-1233`),
and nothing checks it later. The Runs tile shows only while a hub answers (`src/popup/main.ts:546-555`), so the Runs
window's explanations cannot be reached from the popup; its unproven, outdated and unreachable states offer only
**Look again** (`src/runs/main.ts:990-1012`), an unproven pairing is retried forever (`src/shared/run-hubs.ts:535-536`),
and any 404 reads as an outdated editor (`src/shared/editor-proof.ts:46`). The same state says "asks again in a moment"
in the Runs window and "pair again" from Send to editor. It happens when VS Code's saved port was busy at activation
(`apps/vscode/src/extension.ts:852-879`), when another JetBrains IDE took 63342 first
(`apps/jetbrains/src/main/kotlin/dev/piwitests/jetbrains/PiwiSendHandler.kt:386`), or when a remote forward comes back
on another port. **(seen)** Fix: prove the pairing on Pair and whenever the settings open, show the result beside the
pill, keep a muted Runs tile with the reason while an editor is paired, and say "run Pair with Piwi Picker again"
with an **Open the settings** button in those three states.

<a id="s7"></a>**S7. Closing the VS Code window that holds the pairing port breaks the pairing for the others.** The
other windows never take the saved port when it frees (`apps/vscode/src/extension.ts:876-879, 897`). The Runs window
then reads "Following 1 editor window" beside "Your editor does not answer", the popup counts a run in the editor, and
Send to editor fails while VS Code is open. The docs say "the one that paired receives"
(`apps/docs/features/editor-recording.md:107`). **(seen)** Fix: a surviving window takes the saved port when it frees,
and the Runs window names the case.

<a id="s8"></a>**S8. In Firefox, unpairing one loopback pairing removes the access of the others.** Firefox drops the
port, so every pattern is `http://127.0.0.1/*` (`apps/extension/src/shared/web-origin.ts:25-28`), and the editor's
Unpair removes it without checking the desktop app's pairing (`src/options/main.ts:1236-1240`; the desktop's Unpair and
Disconnect check one use each, `:1396-1398`, `:1089-1095`). **(read)** Fix: remove a pattern only when no other use
holds it; the sites card already computes the uses.

<a id="s9"></a>**S9. With Microsoft's Playwright Test extension installed beside Piwi in VS Code, nothing says how the
two share the work, and its runs never follow Piwi's breakpoints.** Neither `apps/vscode` nor the docs name it, though
most VS Code users of Playwright have it: the Testing view shows two trees (`piwi.testExplorer` is on by default), and
its gutter Run, the one most people click, goes through Playwright's test server. The reporter follows a run without a
terminal only when `PW_TEST_REPORTER` names a file, as a JetBrains runner sets it
(`packages/reporter/src/internal/config/editors.ts:42-45, 56-74`), so that run takes no breakpoint, Pause or code from
a stop. The JetBrains IDEs' own runner is followed ([Runs started outside Piwi](../apps/docs/features/terminal-runs.md)).
By the gate's own rule, `PIWI_EDITOR=on` in that extension's `playwright.env` setting would make its runs follow.
**(read)** Fix: check it in the real editor (the nightly suite of [real-editor-checks.md](real-editor-checks.md)), then
document the setting or detect the test server.

<a id="s10"></a>**S10. The JetBrains plugin ignores a WSL or remote Node.js interpreter** ([P5](#p5)).

---

## 3. Write a test

What works: Record a new test file and Record here write code that type-checks and passes three runs out of three,
steps fold into the project's page objects and helpers, waits follow each navigation, page expressions are offered
right (fixtures, `this.root`, popups), passwords are read from the environment and never written, a new tab says it is
not recorded, the config's `use` options reach the browser, and `piwi codegen` turns the same steps into a passing
spec. **(ran)**

<a id="w1"></a>**W1. Record here in an empty spec writes a test that cannot run.** `blockImports` adds `expect` and the
catalog's imports a block needs, never `test` (`packages/editor/src/recorder/sessions.ts:367-377`, called at `:512`),
and `expect` comes from `@playwright/test` though the other specs import from `./fixtures`. The file then fails with
`TS2593 Cannot find name 'test'` and Playwright's `ReferenceError: test is not defined`; **Run** and **Verify ×3** are
still offered. Both clients (`apps/vscode/src/glue.ts:1097`, `Glue.kt:2137`). **(ran)** Fix: when the file binds no
`test`, import it from the module the sibling specs use.

<a id="w2"></a>**W2. Every new test is titled `recorded flow`, so a second one breaks the whole spec.**
`packages/core/src/codegen.ts:851` defaults the title; the protocol has a `title` (`packages/editor/src/protocol.ts:1098`)
that neither client sends (`apps/vscode/src/recording.ts:654-661`, `PiwiRecordingActions.kt:305`). Two recordings into
one file: `Error: duplicate test title "recorded flow"`, and no test of the file loads. **(ran)** Fix: ask for a title
with the start page, and make it unique in the file.

<a id="w3"></a>**W3. A new test file imports `expect` from a fixtures module that may not export it.**
`codegen.ts:1015` always writes `import { test, expect } from <testImport>`; the block path checks the module with
`expectModuleOf`, this one does not. A fixtures file that exports only `test` gives `TS2305` and Playwright's
`does not provide an export named 'expect'`; `piwi codegen --test-import` does the same. **(ran)** Fix: choose the
`expect` module with `expectModuleOf` in the file format too.

<a id="w4"></a>**W4. Catalog imports are written as stored, not relative to the new spec.** `codegen.ts:748, 752`: a
test recorded into `tests/checkout/` imports `./pages/login-page`, and fails with `TS2307`. **(ran)** Fix: resolve a
relative module from the config's folder and write it relative to the target file.

<a id="w5"></a>**W5. JetBrains' Record a New Test File ignores `testDir` and the suite's suffix** ([P3](#p3)). With
`testDir: './e2e'` and the project root selected, it writes `recorded.spec.ts` at the root, and its **Run** finds no
test. VS Code reads `testDir` and the suffix the suite uses (`apps/vscode/src/glue.ts:1155-1168`). **(read; the VS
Code half ran)**

<a id="w6"></a>**W6. An unset password variable fills `''`, and the test fails one step later.** `codegen.ts:544, 708`
write `process.env.E2E_PASSWORD ?? ''`; a teammate or a CI job without the variable sees `toHaveURL` fail on the next
page, with nothing naming the variable. **(ran)** Fix: a read that fails, or skips, naming the variable; the docs say
where to set it.

<a id="w7"></a>**W7. Send to editor at a caret outside a test inserts bare statements.** `piwi/renderSteps` renders
the `body` format whatever the caret's context (`packages/editor/src/server.ts:3463`): `await page.goto(…)` at module
level, `TS2304 Cannot find name 'page'`, and the recording's title is dropped. **(ran)** Fix: render the `test` format
in a file context, as Record here does.

<a id="w8"></a>**W8. Function-catalog completion writes a helper call the recorder would not.** Completion offers
`await fillAddress(${1:city})` (`packages/editor/src/analysis.ts:680-684`, no import or receiver added at
`server.ts:2548-2560`); the recorder writes `await fillAddress(page, 'Berlin')` and its import (`codegen.ts:728-735`).
**(ran)** Fix: the page expression first for a helper, and the import as an additional edit.

<a id="w9"></a>**W9. Choose another locator leaves the brittle locator in the page wait.** The quick fix edits one
line (`apps/vscode/src/glue.ts:958-967`) while `codegen.ts:896` repeats the locator in the wait that follows a
navigation: `await expect(page.locator('form > div:nth-child(3) > button')).toHaveCount(1);` stays. **(ran)** Fix:
edit the wait line too.

<a id="w10"></a>**W10. Brittle-locator warnings drift when the file is edited.** They are placed by the index's line
on the current text (`server.ts:1943-1957`), where failures go through the diff anchors (`server.ts:911-929`), and
fall back to the whole line (`analysis.ts:137-159`). **(read)** Fix: the failures' anchors.

<a id="w11"></a>**W11. A click inside an iframe is dropped with no message.** The launcher sends a notice for a new
page only (`packages/editor/src/recorder/launcher.ts:127`); the limit is documented, the silence is not. **(ran)**
Fix: a notice on the first action outside the recorded frame.

<a id="w12"></a>**W12. A text check uses a locator built from the text it checks.** `codegen.ts:209-236` takes the
first stable alternative: `await expect(page.getByText('Sent!')).toHaveText('Sent!');`, where `#result` and
`getByRole('status')` were offered. **(ran)** Fix: for a text check, skip the alternatives that contain the expected
text.

<a id="w13"></a>**W13. `piwi codegen` ignores the config's `'@piwi'.codegen` section.** `packages/reporter/src/cli/codegen.ts:160-174`;
the editor writes `test.step`, the tag and the owner for the same steps, codegen none of them, and `envPrefix` cannot
be set. `apps/docs/features/recorded-code.md:32` says everyone who records gets the same code. **(ran)** Fix: read the
section.

<a id="w14"></a>**W14. The scenario-gap draft navigates to a page key.** `scenario-gaps.ts:4209` writes
`await page.goto('/shop/orders/:id');` for a templated key, and the login hint names the page object's file rather
than the project's fixtures (`:4048`, `:4073`). **(ran)** Fix: a TODO for a templated key, and the fixtures import.

<a id="w15"></a>**W15. JetBrains refuses Record Here in files outside a config's folder** ([P4](#p4)), and forgets the
page chosen last ([P11](#p11)).

---

## 4. Run it

What works: runs from the editor are the same command in both clients, each saves the spec first, and a run that never
reached an instance says so **(read)**; the desktop app's run arguments go to no shell, so spaces, quotes and accented
titles are safe, and its unattended runs never hold a failure **(ran)**.

<a id="r1"></a>**R1. The desktop app's reproduce and bisect can empty the checkout's `node_modules`, and in a workspace
monorepo they test the checkout's packages.** `link_node_modules` links the checkout's `node_modules` into the worktree
when the lockfile matches, and returns at once when one is there (`apps/desktop/src-tauri/src/worktree.rs:656-671`);
each bisect step installs again (`:1299`), and a step whose lockfile differs runs `npm ci`, `pnpm install` or
`yarn install` through the link (`:688-715`). `npm ci` in a folder whose `node_modules` links elsewhere empties the
target. With workspaces, `require('@acme/ui')` from the worktree resolves to the checkout's `packages/ui`, so every
step tests the current code. **(ran)** Fix: remove a link before any install, and never link for a root
`package.json` that declares workspaces.

<a id="r2"></a>**R2. The desktop app's runs cannot start a dev server from `node_modules/.bin`.** Runs are spawned as
`node <cli.js> test` with no `node_modules/.bin` on `PATH` (`runner.rs:698-711`, `repro.rs:343-352`,
`worktree.rs:852-857`), and on macOS with the bare PATH of an app opened from the Dock; the shell knows about that PATH
for its own tools (`worktree.rs:473-509`) and the server for the AI CLIs (`ai-claude-cli.ts:176-198`), the runs get
neither. A `webServer` running `vite` exits with `127`, `npm run dev` is not found; a bisect judges every step bad and
records the commit after the green one as the first bad commit
(`apps/application/app/composables/useDesktopLocalRuns.ts:488-491`). **(ran)** Fix: prepend each ancestor's
`node_modules/.bin`, as npm does, and the login shell's PATH read once.

<a id="r3"></a>**R3. In a JetBrains IDE, the gutter's Run is not a Piwi run** ([P1](#p1)).

<a id="r4"></a>**R4. The desktop app finds no test in a spec whose path holds a regex character.**
`app/utils/local-run-args.ts` passes `file:line` raw, and Playwright reads a file argument as a regular expression:
`tests/[slug].spec.ts:2` and `checkout (guest).spec.ts` find no test, `c++.spec.ts` is an invalid expression, and a
bisect judges each step bad. `repro.rs:96-102` already escapes its own filter. **(ran)** Fix: escape the file part.

<a id="r5"></a>**R5. Reloading the desktop app's window drops the runs it started.** The registry is page state
(`useDesktopLocalRuns.ts:425`) and no command lists the shell's runs; the page posts the verdicts and the bisect's
result itself (`:586-587`, `:488-491`). A reload (F5 in WebView2, the analytics conflict reload, an error page) empties
the tray, loses Stop, lets the headless stops go on and the Hold failures choices with them, and leaves an editor's
reproduce job running forever (`server/utils/desktop-repro.ts:40`). **(read)** Fix: the runs in the shell's
`LocalRuns`, the page rehydrated from it, the verdicts posted by the shell.

<a id="r6"></a>**R6. Console windows open on Windows for each git and npm call of a reproduction or a bisect.**
`worktree.rs:568, 590-605, 613, 633, 780, 990, 1168` spawn without `CREATE_NO_WINDOW` from a windows-subsystem binary;
`interrupt.rs:36-42` sets it. Closing the window of `npm.cmd ci` kills the install. **(read)** Fix: set the flag on each.

<a id="r7"></a>**R7. A project linked through a monorepo subfolder cannot reproduce, bisect or run the Flake Lab.**
`worktree.rs:932` requires `.git` in the linked folder itself, while Re-run walks up for hoisted modules
(`runner.rs:446-459`) and the bug-report run finds the repository above (`repro.rs:61-70`). **(read)** Fix:
`git rev-parse --show-toplevel`, and run in the worktree's subfolder.

<a id="r8"></a>**R8. The browser check counts any cached Chromium**, so a commit that pins another Playwright skips
`playwright install` and fails with `Executable doesn't exist` (`worktree.rs:745-767`). **(read)** Fix: always run
`playwright install <browser>`, which is idempotent.

<a id="r9"></a>**R9. Verify ×3 says "Passed 3 of 3" for a skipped test when no instance answers.** Without one, the
verdict is the exit code (`packages/editor/src/run-watch.ts:194`, `server.ts:3563`); `test.fixme` gives `3 skipped`
and exit 0. **(ran)** Fix: count the run channel's results, or word the exit-code verdict without "Passed".

<a id="r10"></a>**R10. Nine of the fourteen lines a passing one-test run prints are plumbing.** `Defaulted Playwright
screenshot…`, `Partial run detected (filter active)` (`packages/reporter/src/public/reporter.ts:359`), `Streaming
enabled. Run ID`, five lines of machine summary (`internal/collect/machine-panel.ts:216`, printed unless
`captureResources: false`, which also drops the data, `reporter.ts:861-886`), `Successfully finalized streaming run`
(`run-submitter.ts:325`), `Successfully uploaded reports` (`uploader.ts:155`) and `HTML Report:
project-6/run-…/index.html`, a storage key printed from the server's answer (`uploader.ts:121, 157`). The logger has
no level between always and `PIWI_VERBOSE` (`internal/support/logger.ts`). **(seen)** Fix: the plumbing at `debug`,
the report line as a URL or not at all, the machine summary only when something stands out or on CI.

<a id="r11"></a>**R11. An unreachable instance prints eight lines for one fact**: `Could not register global setup`,
`Live streaming is unavailable`, `Found 0 trace files`, `Failed to upload with files`, `Falling back to JSON upload...`,
`All upload methods failed`, `Saved a local recovery copy…`, `Saved recovery data for later upload`. **(seen)** Fix:
one line at the first failure, one at the end.

<a id="r12"></a>**R12. `PIWI_VERBOSE=1` and `PIWI_EDITOR=false` are read as their opposite.** `PIWI_VERBOSE` is on only
for `true` (`internal/config/env.ts:450`); `PIWI_EDITOR` is off only for `off`, so `false`, `0` and `no` follow the
editor (`internal/config/editors.ts:60-61`). **(seen, ran)** Fix: read `1/0/true/false/on/off/yes/no` alike.

<a id="r13"></a>**R13. Two prefixes in one terminal**: `[Piwi Dashboard]` from the runner's logger, `[piwi]` from the
workers' lines (25 sites, most in `capture-fixtures.ts`). **(seen)** Fix: one prefix.

<a id="r14"></a>**R14. The desktop app's smaller run defects.** Quitting stops the server before the runs, which then
cannot send their end (`lib.rs:950-955`); Force stop leaves the `webServer`'s children on their port (`worktree.rs:573-580`);
a crash during a bug report run leaves `piwi-repro/bug-<id>.spec.ts` in the user's tests (`repro.rs:331-334`); the
bundled Node 24 runs the suite whatever `.nvmrc` says (`runner.rs:703-707`); on Windows `symlink_dir` needs Developer
Mode though its comment says junction, and worktree paths run long (`worktree.rs:519-524, 664`); a bug report run's
notification reads `exit 1 after 0s` (`useDesktopLocalRuns.ts:715, 856-868`). **(read)**

---

## 5. Watch it run

What works: a run streams to the run page from its first test, the run and failure pages link from the terminal's
lines, and a running test's row shows its worker's current step once steps flow **(seen)**; the editor's status bar,
the Runs window and the tray follow the same runs **(seen, read)**.

<a id="v1"></a>**V1. The run page never shows the call a stuck test waits in.** Step events are dropped while nobody
watches (`packages/reporter/src/internal/streaming/stream-manager.ts:316-318`), and when someone starts watching, the
reporter only refreshes the live resources (`reporter.ts:457`): the call already running is never sent. A test held 25
seconds by a click on a missing button read **In progress…** for the 18 seconds the page was open, until it failed;
that is the run a person opens the page for. **(seen)** Fix: keep each running test's open step, and send it when the
run gets a watcher.

<a id="v2"></a>**V2. Steps start 5 to 10 seconds after the run page opens.** The reporter learns of a watcher from the
heartbeat, sent every 5 seconds while unwatched, and a heartbeat that finds the stream active less than a period ago
waits a whole period again (`stream-manager.ts:473-480`). **(seen)** Fix: wait for the rest of the period only; with
V1, the current call shows within one heartbeat.

<a id="v3"></a>**V3. Work in progress from developers' machines fills the team's failure inbox.** Three broken
attempts at new tests, run locally against the instance, were three open items on Home's Failure inbox.
`getOpenFailureClusters` filters on the state and the projects a person may read
(`apps/application/shared/handlers/failure-clusters.ts:752-755`); the run's origin, which
`LOCAL_RUN_ORIGINS` names (`shared/run-eligibility.ts:55`), plays no part. **(seen)** Fix: leave clusters seen only in
`local` and `editor` runs out of the inbox by default, or mark them and filter them as the branch filter does.

<a id="v4"></a>**V4. A hidden Runs window holds every headless failure of every run.** `follow` stays on while any
window's port is open (`apps/extension/src/shared/run-hubs.ts:140-148`), minimizing only ends the live views
(`src/runs/main.ts:776-783`), and the service holds failures whenever a window follows
(`packages/editor/src/run-sessions.ts:519-522, 1094-1100`). The whole suite then waits at its first failure per
worker, and the terminal says `Resume in Visual Studio Code…` without saying why. **(read)** Fix: `follow: false`
while the window is hidden, and the reason in the reporter's line.

<a id="v5"></a>**V5. In the desktop app, keys typed into Watch live also trigger the dashboard's shortcuts.**
`DesktopRunStopPage.vue:279-304` prevents the default but stops the event only for Esc, and Home's Failure inbox listens
on the window and skips only inputs (`OpenFailuresCard.vue:454-457, 560`): typing `q` quarantines the selected
cluster's tests, `r` resolves it. **(read)** Fix: stop propagation for every key and paste sent to the page.

<a id="v6"></a>**V6. The desktop app's other watch surfaces.** The taskbar and Dock progress, the tray dot and the
Windows thumbnail buttons are in no docs page; the thumbnail's Stop stops every local run
(`desktop-run-progress.client.ts:165`); a run waiting at a held stop reads `Running 7/12`
(`desktop-run-progress.ts:56`); an editor's **Reproduce in the desktop app** holds its failure in the app until someone
clicks Resume there (`useDesktopLocalRuns.ts:1221-1223`, `desktop-run-view.ts:69`). **(read)**

---

## 6. Stop it and look

What works: the stop lands on the right line for plain and boxed `test.step`, page objects, helpers and test- and
worker-scoped fixtures; the test timeout and the call's own budget stop during a stop and resume after it; a late
answer never reaches a later stop; a headless stop goes on when the IDE closes, one under the pause bar waits; held
keys and buttons are let go before the test goes on **(ran)**; from a terminal, the pause bar, Step and Resume work and
the terminal says what to do (`[piwi] Paused at tests/pause.spec.ts:5 before Fill … (Esc resumes).`) **(seen)**.

<a id="d1"></a>**D1. A breakpoint on the first line of a statement wrapped over several lines never stops.** The editor
sends the clicked line (`packages/editor/src/analysis.ts:264-272`, `apps/vscode/src/breakpoints.ts:36-46`,
`run-sessions.ts:675-684, 1439-1446`); the reporter matches `file:line` exactly (`pause-at.ts:30-42`) against the
line of the call, which in a wrapped statement is the `.click(` or `).toBeVisible(` line. Of three wrapped statements
with a breakpoint on their first line, only the one whose call sat on that line stopped. Run to cursor on such a line
runs through. **(ran)** Fix: in the service, map each breakpoint and run-to line to every line of the statement that
starts there.

<a id="d2"></a>**D2. A browser made headed in the spec, or through `launchOptions`, is read as headless.**
`pauseGateFromTestInfo` reads `testInfo.project.use.headless` (`pause-at.ts:169-190`; `capture-fixtures.ts:1815, 2524,
3843-3848`). With `test.use({ headless: false })` the run prints `breakpoints are skipped: the browser is headless —
re-run with --headed (or set use: { headless: false })`, and under a run channel its stop shows no bar in the open
window. **(ran)** Fix: read the resolved `headless` and `launchOptions` fixture values in `piwiCapture`.

<a id="d3"></a>**D3. Conditional breakpoints, logpoints and breakpoints that do not suspend are plain stops.** VS Code
keeps a breakpoint for being enabled, in a file and under a config's folder (`apps/vscode/src/breakpoints.ts:36-46`);
the JetBrains plugin for being enabled and in a file (`PiwiProjectService.kt:413-427`). A logpoint stops the browser,
a JetBrains breakpoint whose Suspend is off stops it, a conditional one stops at every pass. **(read)** Fix: leave
logpoints and non-suspending breakpoints out, and send conditions the reporter cannot evaluate as plain stops with a
notice.

<a id="d4"></a>**D4. Page-level calls on a popup show the pause bar, Pick and a held failure in the opener.** The page
is guessed (`capture-fixtures.ts:1635-1640`), falling back to the last page any request touched (`:1765-1770, 3022`);
`holdFailure` uses the same guess (`:2229`). For `expect(popup).toHaveTitle('B')` the bar showed in the opener; the
person looks at the popup, Esc there does nothing, and Pick picks on the wrong page. **(ran)** Fix: the page from the
call's own channel (`_instrumentation.onApiCallBegin`, which `run-events.ts` already reads), and no Pick on a guessed
page.

<a id="d5"></a>**D5. The pause bar covers the top of the page, and on a phone-sized page the paused call.** The bar is
`position: fixed; top: 0` across the page (`packages/picker-dom/src/overlay-pause.ts:54`) with no way to move it: at
1280 pixels it hides the application's own header and navigation; on a Pixel 5 project it wraps to two rows, about a
sixth of the viewport, and the call it is paused before shows as `Cli…`. **(seen)** Fix: the call on a row of its own
when the bar wraps, and a toggle that docks the bar at the bottom.

<a id="d6"></a>**D6. Debug in my editor refuses a test whose title is computed.** `debug-run.ts:72-80` compares titles
exactly, and `analysis.ts:806-820` keeps `${…}` literal: `pays with visa` from `` test(`pays with ${card}`) `` is
refused as "may have been renamed or moved". **(ran)** Fix: `${…}` as a wildcard, and "computed title" in the refusal
when it still cannot match.

<a id="d7"></a>**D7. Some breakpoints are dropped without a word.** In a file outside the config's folder (a page object
of a sibling package), the clients and the service drop it (`breakpoints.ts:41`, `analysis.ts:268-269`,
`run-sessions.ts:1442-1454`, `workspace.ts:171-175`) though the reporter stops at `../shared/outside.page.ts:2`; in a
test folder reached through a symbolic link, Playwright names the target and no key matches (`pause-at.ts:48-67`); on
Windows, `Pages/` and `pages/` differ (`pause-at.ts:38-56`). **(ran, read)** Fix: send `..` places for workspace files,
resolve real paths on both sides, compare without case on Windows; warn once for a place that matches no file.

<a id="d8"></a>**D8. `PW_CODEGEN_NO_INSPECTOR` leaks into dependent projects.** It is set while breakpoints are armed and
never cleared (`pause-at.ts:383-388, 414-449`), and Playwright passes a worker's environment changes to the projects
that depend on its project: a `page.pause()` in a dependent project's `beforeAll` then waits with no Inspector until the
test's timeout. **(ran)** Fix: unset it at worker teardown.

<a id="d9"></a>**D9. Esc does two things nobody asked for.** In the Runs window's live view it gives the keys back to
the window and is never sent, so a Pick or an Assert a region started there cannot be cancelled: the picker's only skip
is Esc (`apps/extension/src/shared/view-input.ts:83`, `src/runs/main.ts:713-718`,
`picker-dom/src/overlay-element.ts:87-91, 496-499`). In the page, Esc anywhere resumes the test
(`overlay-pause.ts:74-80, 137`), closing the application's own dialog included. **(read)** Fix: send Esc to the page
while an action runs there, or give the picker's banner a Skip button; ignore Esc in fields and dialogs.

<a id="d10"></a>**D10. Two controls on the same stop.** A second control sent before the worker says `running` is
answered "Resuming." and dropped (`run-sessions.ts:651-699`, `run-channel.ts:476-480`), and Step at a test's last call
does not carry into the next test, where Pause does (`capture-fixtures.ts:3894`). **(read, ran)** Fix: mark the stop
answered on the first control; carry Step as Pause is carried.

<a id="d11"></a>**D11. Pick on the image says less than it knows.** It is offered on Playwright 1.59 and then refused
(`packages/core/src/run-channel.ts:132-144`, `pick-at.ts:105, 164`); with no editor to take the locator, the Runs
window draws it as sent and offers no Copy (`src/runs/main.ts:765, 1496`), where the docs promise it "for you to copy".
**(seen, read)** Fix: no `pick-at` capability below 1.60; mark it sent only when an editor took it, with Copy.

<a id="d12"></a>**D12. The run shortcut and Look again give no sign.** The shortcut's answers are dropped
(`background/index.ts:161-164`), and with no test stopped it pauses every live run, a Flake Lab or a bisect of the
desktop app included (`shared/runs.ts:383-396`); **Look again** sets no searching state (`run-hubs.ts:207-228`).
**(seen)** Fix: a badge, and the reason when nothing answered; "Looking…" until the answer.

<a id="d13"></a>**D13. A pick at a stop of a JetBrains run can land in another project** ([P2](#p2)).

---

## 7. Fix it

What works: the failure page's headline names the call and the locator (`Test timed out after 30 s while clicking
getByRole('button', { name: 'Log in' })`), its Next row shows the replacement as a diff with Copy, Pick from snapshot
opens the failure-time tree, an assertion failure offers Debug in my editor at its line, and the reporter's terminal
line links straight to the execution **(seen)**; a pick at a stop replaces the locator of its line and is kept as **Your
pick** for the panel **(ran)**.

<a id="f1"></a>**F1. The failing line is lost when an action times out.** A test timeout's errors are
`Test timeout of 30000ms exceeded.`, with no location, then the interrupted call's, with its location and stack
(`sign-in.spec.ts:7:54`). `buildErrorText` joins the messages and appends the location of `result.error`, the first
(`packages/reporter/src/internal/collect/error-text.ts:12-20`); the blob-report importer takes `errors[0]` the same way
(`apps/application/server/utils/blob-report.ts:366-374`). The source frames then hold the declaration line alone
(`internal/support/source-snippet.ts:65-115`), and `failurePlace` skips the test's own line
(`apps/application/app/utils/ide-links.ts:280-287`): the Source tab marks `test(` as **Failed here**, **Debug in my
editor** is absent (`TestSourceStack.vue:61`), and with a trace, the full stack names line 7 with no button beside it,
since the target is read from the frames alone. Under Playwright's defaults (no `actionTimeout`), that is every action
whose locator matches nothing. **(seen, ran)** Fix: the location of the first error that has one, in the reporter and
the importer alike; the appended frame sits after the message, so fingerprints do not move.

<a id="f2"></a>**F2. A run started outside the config's folder loses the failing line of every failure.** The appended
frame is relative to the config's folder (`reporter.ts:306`), the frames are resolved against the working directory
(`source-snippet.ts:87-97`, no root passed at `reporter.ts:691-698`). From the parent folder with `-c
shopper/playwright.config.ts`, an assertion failure stored `at tests/products.spec.ts:8:69` and the frame
`shopper/tests/products.spec.ts:3`, beside a `filePath` of `tests/products.spec.ts`: Debug in my editor then targets the
declaration line, where the run never stops. Monorepos and CI jobs that pass `-c` are this case. **(seen)** Fix:
resolve and name the frames relative to the config's folder, as every other path of the run is.

<a id="f3"></a>**F3. A pick at a stop replaces the locator on a line that has moved.** `piwi/applyPick` applies the
run's line to the current text (`packages/editor/src/server.ts:3348-3365`; callers `apps/vscode/src/extension.ts:1567`,
`PiwiSendHandler.kt:173`). After Record here at a breakpoint, which writes above the paused line, a Pick at the same
stop rewrote the recorded Email step:
`await page.locator('#sign-in').getByRole('button').fill('alice@example.com');`, and the notice said it was replaced.
**(ran)** Fix: send the run's ref, map the line with `RunLines.lineNow`, refuse when the line no longer holds the
paused call.

<a id="f4"></a>**F4. A recording at a stop is placed by the run's line number.** `server.ts:1789` and
`sessions.ts:601` use `handoff.line - 1` on the edited text, and the hand-off carries no run ref (`handoff.ts:37-48`):
a second Record here at the same stop writes its steps above the first recording's. **(ran)** Fix: the same mapping
as F3.

<a id="f5"></a>**F5. Most likely blames the timeout for a locator that matched nothing.** For the failure of F1 the
only clue is `timeout-budget`, "The failure used 101% of the timeout budget — … a slow operation, not necessarily a
wrong one" (`apps/application/shared/failure-clues.ts:887-913`), while the Next row says to replace the locator. The
clue that says the element changed fires only for healing from a prior success or an element match
(`failure-clues.ts:684-687`); this healing came from the failure-time ARIA snapshot, and a new test has no green run to
diff against. **(seen)** Fix: a clue for a locator that matched nothing at the failure, ranked above
`timeout-budget`, naming the element the snapshot offers; `timeout-budget` stops calling such a wait slow.

<a id="f6"></a>**F6. The Locator fix panel tells a new test to enable the fixtures it uses.** "No HTML attributes were
available. Enable Piwi fixture capture…" shows whenever healing came from the ARIA snapshot
(`apps/application/app/components/shared/LocatorHealingPanel.vue:681-689`); here the fixtures were on and the test had
never passed. **(seen)** Fix: that hint only when the execution carries no fixture data; otherwise "attributes are
captured on a passing run".

<a id="f7"></a>**F7. A failed Send to editor flashes "Not sent" for a second and a half.** The reason goes into the
button's `title` alone (`apps/extension/src/shared/editor-send.ts:26-35`; callers `results-panel.ts:340`,
`record-panel.ts:1034`, `devtools/sidebar.ts:148`, `panel-locators.ts:90`), with no live region. **(seen)** Fix: the
reason in a visible `role=status` line under the button.

<a id="f8"></a>**F8. In the desktop app, Debug in my editor through VS Code probably does nothing.** `debugInIde`
(`useOpenInIde.ts:569-630`) loads `vscode://piwitests.piwi/open?…&debug=1` in a hidden iframe (`:221-237`); the app's
webviews do not hand an unknown scheme to the system, and `desktop_open_external` refuses one (`lib.rs:1067-1075`).
The app says it asked the extension, and nothing opens. **(read)** Fix: `code --open-url <link>` through the app's IDE
launcher.

<a id="f9"></a>**F9. Pick from snapshot opens on the pointer's row.** It starts with the tree at its top and the hover
on whatever row the pointer is over, not on the element the Locator fix panel recommends, which on the shop's sign-in
page sits below the fold. **(seen)** Fix: scroll to the recommended element and outline it.

---

## 8. VS Code and the JetBrains IDEs

The protocol is at parity: of its 59 `piwi/*` messages, all 13 the service sends are handled by both clients, both send
the same capability flags, and a scripted diff of `packages/editor/src/protocol.ts` against `Protocol.kt` found renames
only, no dropped field. The runs' arguments, breakpoints, stops, the paused page, code from a stop, the recording's
controls, Debug in my editor, Open in IDE and the connection match **(read)**. The gaps are in the clients:

| # | Capability | VS Code | JetBrains | Severity |
|---|---|---|---|---|
| <a id="p1"></a>P1 | A Piwi run from a test's gutter | Testing view with **Run with Piwi** and **Verify ×3 with Piwi** (`test-explorer.ts:117-125`), **Run** in the hover (`glue.ts:530-541`) | `piwi/testItems` never sent; the result icon opens the dashboard (`PiwiTestAnnotator.kt:100-104`); the IDE's own Run is a run started outside Piwi | high |
| <a id="p2"></a>P2 | Where a pick at a stop goes | the window whose run it is (`extension.ts:895-899, 933-935`) | one IDE-wide address (`PiwiCommands.kt:236-244`), sent to the last-focused project (`PiwiSendHandler.kt:167-213`) | medium |
| <a id="p3"></a>P3 | Record a new test file | `testDir` and the suite's suffix | the folder at hand, always `recorded.spec.ts`, no subfolder (`PiwiRecordingActions.kt:104-110, 270-271`, `Glue.kt:2296-2303`) | medium |
| <a id="p4"></a>P4 | Record Here outside a config's folder | any file | refused (`PiwiRecordingActions.kt:178-182`), though the service accepts it (`server.ts:782-787`) | low-medium |
| <a id="p5"></a>P5 | WSL or remote Node.js | Remote-WSL | local interpreter only (`PiwiLspServerSupportProvider.kt:76-78`), and the error points back at the setting already chosen | medium-low |
| <a id="p6"></a>P6 | Remote development | forwarded ports of any number, `piwi/hub` | Gateway forwards with equal numbers only; `piwi/hub` never sent (`PiwiSendHandler.kt:102, 119`); listed as left out in [run-control.md](../adr/run-control.md) | low-medium |
| <a id="p7"></a>P7 | Undo after a recording | your edits stay undoable | one undo takes your edits too (`PiwiRecording.kt:640-682`); documented | medium-low |
| <a id="p8"></a>P8 | The service's log and traffic | **Piwi: Open the log**, `piwi.trace.server` | none | low |
| <a id="p9"></a>P9 | Failures view follows the active editor | yes (`failures-view.ts:212-224`) | no | low |
| <a id="p10"></a>P10 | MCP configuration to copy | `servers` shape only, which Cursor does not read (`glue.ts:754-760`) | `mcpServers` with `mcp-remote` (`Glue.kt:1078, 1101-1110`) | low |
| <a id="p11"></a>P11 | The recording's page question | the last choice preselected (`recording.ts:542, 550`) | the default preselected (`PiwiRecordingActions.kt:480`); the docs say the last answers are offered | low |
| <a id="p12"></a>P12 | Share live offer in the status bar | yes, with why sharing stopped (`run-control.ts:335-359`) | shared runs only (`PiwiStatusBar.kt:117-141`) | low |
| <a id="p13"></a>P13 | Run-control keys | Stop on `Shift+F5`, no Pause key | Pause on Resume's key (`plugin.xml:196`), no Stop key | low |
| <a id="p14"></a>P14 | Fix plan preview | previewed (`changeAnnotationSupport`, `server.ts:2189`) | the descriptor sets no capability (`PiwiLspServerSupportProvider.kt:121-130`): possibly applied without a preview; unverified | low |
| <a id="p15"></a>P15 | `piwi/commandStarted` | sent without the `terminalRef` the service needs (`run-watch.ts:380-381`) | never sent | none: dead protocol |

---

## 9. One loop, one vocabulary

The same action has several names, and a developer moving from the editor to the browser to the desktop app meets them
all **(seen, read)**:

| What it does | Pause bar | VS Code | JetBrains | Runs window | Tray | Elsewhere |
|---|---|---|---|---|---|---|
| Name a locator for an element | Pick a locator | Pick a locator in the stopped test's page | Pick a Locator at the Stop | Pick, Pick on the image | Pick on the image | Pick an element (popup) |
| Check an element | | Assert | Assert | Assert | | Check an element (recording bar) |
| Run to a line | | Run to the cursor | Run to Caret | | | |
| A stop an agent asked for | | Paused by the agent (`run-control.ts:241`) | | | Stopped after the agent's step (`desktop-run-view.ts:99-103`) | |
| Finish | Finish | its tooltip (`run-control.ts:548`) | | its tooltip (`messages.json:7699`) | its tooltip (`DesktopRunWorker.vue:49-53`) | three wordings |
| Piwi Picker's settings page | | "Paste it in Piwi Picker's options" (`extension.ts:1432`) | the same (`PiwiSendHandler.kt:399`) | | | the page is titled settings (`options.html:5`) |
| The desktop app's runs | | | | "Your editor's runs" (`runs.html:566`), "N runs in your editor" | | |
| A line in the terminal | `[piwi]` | | | | | `[Piwi Dashboard]` |

The tray's **Hold failures** switch also reads off while the Runs window holds that run's failures. Fix: one word per
action, chosen once, the strings moved to the places that already share them (the reporter's stop words, the
extension's `messages.json`).

---

## 10. The docs

<a id="doc1"></a>**DOC1. The loop has no page of its own.** Thirty-three of the catalog's 84 features sit in one group,
**Use it from elsewhere** (`apps/application/shared/piwi-features.ts`): recording, breakpoints, Pause and step, the Runs
window, the desktop app's runs, Debug in my editor, Code from a pause, End the test and the editor's runs among them,
listed beside the MCP server and Bug reports. No page takes a developer from a new spec to a fixed test and says which
tool does which step. **(read)** Fix: a guide page for the loop, and a catalog group for it.

<a id="doc2"></a>**DOC2. Drift.**

- `PIWI_PAUSE_AT` is relative to the working directory (`pause-at.ts:94-111`, and `locator-healing.md:133` says so);
  `editor-breakpoints.md:99-102` says the config's folder. An entry that matches no file says nothing. **(ran)**
- A run that follows an editor takes over every `page.pause()`, headless included, where `editor-breakpoints.md:78-80`
  says it stays Playwright's own and returns at once headless. **(ran)**
- `globalTimeout` keeps counting during a stop, and breakpoints in `beforeAll` and `afterAll` never stop: neither is
  in the Breakpoints page's Limits (`end-the-test.md:39-40` has the second). **(ran)**
- `editor-run-control.md:28` gives the JetBrains Stop as the Run tool window's, though **Tools → Piwi → Stop the Run**
  exists; `editors.md`'s commands table has no JetBrains names, and lists **Write code at the stop…**, **Open the log**
  and **Get started** with no word that JetBrains lacks them. **(read)**
- `editor-recording.md:35` says a new test file is offered next to the file you are in (neither client does exactly
  that) and that the editor offers your last answers again (JetBrains does not for the page). **(read)**
- `editor-recording.md:107`: "the one that paired receives" (S7). `runs-window.md:17`: the tile shows "while the editor
  answers" (also for the desktop app). `terminal-runs.md`: Pick on the image "for you to copy" (D11).
  `recorded-code.md:32`: everyone who records gets the same code (W13). **(seen, read)**
- `desktop.md` and `desktop-runs.md` mention neither the OS progress surfaces nor that the bundled Node 24 runs the
  suite; `desktop.md:102` says reproductions reuse your `node_modules`, which on Windows they never do (R14). **(read)**

---

## 11. The plan

Ranked by what each change buys a developer per day, then by its size. Each item names the findings it closes; each
quick win is one area and lands with the test that holds it.

### Quick wins

1. **The failing line, kept** (F1, F2): the error text's location from the first error that has one, in the reporter
   and the blob-report importer; the source frames resolved and named relative to the config's folder. Unit tests in
   `packages/reporter/tests/error-text.spec.ts` and the importer's.
2. **Wrapped statements stop** (D1): the service maps a breakpoint or a run-to line to the call lines of the statement
   that starts on it.
3. **Headed means headed** (D2, D8): the pause gate reads the resolved `headless` and `launchOptions`;
   `PW_CODEGEN_NO_INSPECTOR` is unset at the worker's teardown.
4. **Say why a spec cannot stop** (S1): once per run, the specs that ran without the capture fixtures while
   breakpoints or a run channel were set; the service's answer names the cause.
5. **Recordings that run** (W1, W2, W3, W4): `test` imported when the file binds none, a title asked for and unique in
   the file, `expect` from a module that exports it, catalog imports relative to the spec.
6. **Breakpoints as the editor means them** (D3): logpoints and non-suspending breakpoints left out, conditions noted.
7. **Live progress that shows the stuck call** (V1, V2): the open step of each running test sent when the run gets a
   watcher; the heartbeat waits for the rest of its period only.
8. **The first failure page, right** (F5, F6): a clue for a locator that matched nothing, above `timeout-budget`; the
   fixtures hint only when the execution carries no fixture data.
9. **Desktop runs that find their tests and keep their keys** (R4, V5, R6, R14): spec paths escaped, keys sent to a
   watched page stopped there, `CREATE_NO_WINDOW`, the runs stopped before the server on quit.
10. **Desktop runs with the user's PATH, and a checkout left alone** (R2, R1): `node_modules/.bin` and the login
    shell's PATH; no `node_modules` link for a workspace root, and a link removed before any install.
11. **Pairing and sending that say what happened** (S6, F7): the pairing proved on Pair and when the settings open,
    "Pair with Piwi Picker again" with **Open the settings** in the failing states; Send to editor's reason shown.
12. **A quieter terminal** (R10, R11, R12, R13): the plumbing at `debug`, one line for an unreachable instance, the
    report line as a URL, boolean variables read alike, one prefix.
13. **The docs drift of DOC2.**

### Medium

1. **JetBrains: Run and Verify ×3 with Piwi from a test's gutter** (P1), through `piwi/testItems` or a run line marker
   that starts Piwi's command.
2. **Picks and recordings at a stop placed by the run's lines** (F3, F4, P2): the run's ref on `piwi/applyPick` and the
   recording's hand-off, `RunLines` mapping, a refusal when the line moved; in JetBrains, the pick routed to the
   project whose run holds the stop.
3. **A new test file's place from the service, for both clients** (P3, W5), with Record Here allowed wherever the
   service accepts it (P4).
4. **The pause bar on a real page** (D5, D9, D4): the call on its own row, a dock toggle, Esc only outside fields; the
   popup's page from the call's channel.
5. **The desktop app's port and run registry** (S5, R5): a port of its own and a saved fallback; the runs kept in the
   shell and rehydrated.
6. **Reproduce and bisect in a monorepo** (R7, R8): from a subfolder of the repository, with `playwright install`
   always.
7. **The team's inbox for the team's failures** (V3): clusters seen only in local and editor runs out of the inbox by
   default.
8. **Debug in my editor everywhere** (D6, F8): computed titles, and VS Code from the desktop app.
9. **One vocabulary** (§9).
10. **Breakpoints outside the config's folder, through links and on Windows** (D7).
11. **Piwi Picker's smaller dead ends** (S7, S8, V4, D9, D11, D12).
12. **The recorder's smaller defects** (W6 to W14, R9).

### Larger

1. **A page for the loop** (DOC1): from a new spec to a fixed test, which tool for which step, and a catalog group.
2. **VS Code beside Microsoft's Playwright Test** (S9): checked in the real editor, then documented or followed.
3. **The JetBrains plugin's remaining gaps** (P5, P6, P8 to P14).
4. **The desktop app's Windows and quit paths** (R14, V6), checked on a real Windows desktop.

---

## Appendix A. Checked and found sound

- **Setup.** `init` is idempotent and reports a config it cannot rewrite; an unreachable instance neither slows nor
  fails a run, and one recovery copy is kept per instance and project **(seen)**. The desktop discovery file and the
  reporter's reader agree (`lib.rs:624-676`, `config/desktop.ts`) **(read)**; the GetStartedWizard of the desktop build
  writes no URL and lets the reporter find the app **(read)**.
- **Write.** Record a new test file and Record here through the sample shop, with keyboard selects, element and
  address checks, and the steps folded into `loginPage.login`, `productsPage.addToCart` and `checkoutPage.placeOrder`,
  type-check and pass three runs of three; `piwi codegen` on the same steps passes; `pageUrlPattern` matches its own URL
  for fourteen URL shapes; page candidates and placement are right for tests, hooks, describe bodies, helpers, page
  object fields, popups and `newPage()`; passwords are read from the environment; the `'@piwi'` config type-checks and
  rejects a wrong value **(ran)**.
- **Run.** Both clients build the same run arguments, save the spec first, drop the breakpoints for Verify ×3 and quote
  compatibly with JetBrains' argument split; the "never reached the instance" notice is the service's for both
  **(read)**. The desktop app's run arguments reach no shell, its `--grep` is escaped, and the shell and the window
  agree on which runs nobody attends (85 unit tests) **(ran)**; Stop sends Ctrl+C and kills after ten seconds, and
  closing the window, Quit and an update ask while runs are active **(read)**.
- **Watch.** The run page streams from the first test, the terminal links to the run and to each failure's execution,
  and steps show on the running rows once they flow **(seen)**. The Runs window follows two VS Code windows through one
  pairing, pauses, steps and resumes, and lists the desktop app's runs **(seen)**; the hub refuses unattended runs to
  agents, and an agent's stop goes on after two minutes (43 unit tests) **(ran)**.
- **Stop.** Stops land on the right line for `test.step`, boxed steps, page objects, helpers and fixtures; the test's
  and the call's timeouts stop during a stop; a late answer never reaches a later stop; a locator call on a popup shows
  the bar in the popup; a headless stop goes on when the IDE closes; held keys are let go before the test goes on; End
  the test below Playwright 1.62 and Pick on the image below 1.60 say what to update; the reporter's pause unit tests
  pass **(ran, read)**. From a terminal, a headed run with `PIWI_PAUSE_AT` stops, steps and resumes **(seen)**.
- **Fix.** The failure page's headline, Next row and Pick from snapshot; Debug in my editor on an assertion failure;
  Send to editor's proof before the token goes out; a pick on the image highlighted in the Runs window **(seen)**.
- **Parity.** The 59 protocol messages, the capability flags and the fields of every message; the run arguments,
  breakpoint updates, stops, the paused page with Watch live and Interact, code from a stop, the recording's edit
  pauses and Keep my edits, Debug in my editor's prompt, Open in IDE's scoping and the connection flow **(read)**.
