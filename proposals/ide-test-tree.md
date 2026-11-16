# The full test tree in both editors

**Status.** Proposed 2026-11-16, nothing built. The maintainer asked whether both editors can show every test of the
workspace and run any of them, alone or by group, and whether the list should come from the Piwi instance or from the
source code. Its open questions were decided the same day ([§9](#9-decisions)).

**Summary.** VS Code's Testing view already shows Piwi's tests and runs any node, but its list is incomplete: the spec
files come from the instance's catalog (plus the specs open in the editor), and the tests inside each spec from a
line-by-line read of its text. Without a connection the tree is nearly empty, a new spec is missing until it is opened,
and the tests Playwright builds at run time (a loop, a Playwright project) are wrong. The JetBrains plugin has no tree
at all. This proposes that the list come from Playwright itself (`playwright test --list`, run by the editor service
with the project's own Playwright), that the line-by-line read cover a spec only while it is being edited, and that the
instance only add what it alone knows (latest result, flaky, owner, quarantine). The service builds the tree and the
run of any node, with the narrowest filter Playwright takes for it; VS Code draws it in the Testing view, and the
JetBrains plugin in a new **Tests** tab of the Piwi tool window.

Terms used here:

- **The listing**: the tests Playwright lists for one Playwright config with `playwright test --list`.
- **The line parse**: `testCalls` in `packages/editor/src/analysis.ts`, which reads a spec's text line by line and
  finds each `test(…)` call and the titled `test.describe(…)` blocks around it.
- **The catalog**: the instance's test cases (`GET /api/projects/:id/test-cases`), one per file, describe path and
  title, with their latest result and history.
- **A node**: one item of the tree (a config, a folder, a spec, a describe block, a test, a Playwright project).

## 1. What exists

- **The VS Code Testing view** (`apps/vscode/src/test-explorer.ts`, setting `piwi.testExplorer`, on by default). Its
  tree is built by `testTree` in `apps/vscode/src/glue.ts`: config (when there are several), folders, spec, describe
  blocks, test. Four run profiles (Run, Debug, Coverage, Verify ×3 with Piwi) work on any node: `runProfile` collects
  the tests under the picked nodes, and `testRunsOf` turns them into one `RunTestsArgs` per config, by catalog id when
  every test has one, else by one `file:line` per test. Each item carries its Playwright tags, `owner:<name>`,
  `quarantined` and `@piwi:flaky` as tags, which the view's filter reads.
- **`piwi/testItems`** (`packages/editor/src/server.ts`) answers the specs, not a tree: the catalog's specs the
  workspace holds (`PiwiContext.allCases`) and the specs `uris` names, each read with the line parse and matched to the
  catalog by file, describe path and title (`caseOfCall`). VS Code asks again when the connection or the runs change,
  and for one spec 300 ms after an edit or when it opens.
- **The JetBrains plugin** mirrors `piwi/testItems` in `Protocol.kt` but never calls it. A test line offers **Run with
  Piwi** and **Verify ×3 with Piwi** in the IDE run icon's menu (`PiwiRunLineMarker.kt`), and a Piwi run shows the
  IDE's test tree in its Run tab while it runs (`PiwiRunTab.kt`). The Piwi tool window has the Failures, Runs and Log
  tabs; nothing lists the tests before a run.
- **The service already runs `playwright test --list`**: `packages/editor/src/recorder/project-options.ts` reads each
  project's `use` options with the project's own Playwright and Node, through the service's reporter
  (`piwi-use-reporter.cjs`, `src/recorder/use-reporter.ts`) and a filter no spec matches, cached until the config or a
  file it reads changes (`configFingerprint`).
- **A run's arguments** (`RunTestsArgs`, `packages/editor/src/protocol.ts`): `testIds`, which the instance turns into
  arguments (`PiwiClient.runArgs`), or `locations`, a spec path or a `file:line` (`isTestLocation` in
  `src/commands.ts`), which needs no instance. `--grep` and `--project` are among the options a command may carry
  (`PLAYWRIGHT_OPTIONS`).

## 2. What the tree misses today

1. **Not connected, nearly empty.** `allCases()` returns no case without an instance, so the tree holds only the
   specs opened in the editor.
2. **A new spec is missing** until it is opened, or until a run reports it to the instance.
3. **Large suites are cut.** The catalog is read a thousand cases a request, ten requests at most: 10,000 tests.
4. **Tests built at run time are wrong.** `` for (const n of [1, 2, 3]) test(`case ${n}`, …) `` is three tests for
   Playwright, per Playwright project; the line parse gives one test titled `case ${n}`, which matches no catalog case
   and so has no result.
5. **No Playwright project.** A config with several projects runs each test once per project; the tree shows one item,
   and a live result is the first of running, failed, flaky, passed and skipped across the projects.
6. **The config's file rules are not read.** The service takes a fixed pattern for a spec
   (`SPEC_FILE` in `server.ts`, `*.spec.*` or `*.test.*`), whatever `testDir`, `testMatch` and `testIgnore` say.
7. **A group runs as its tests.** A folder of 500 tests becomes 500 arguments (a long command line; `cmd.exe` stops at
   8,191 characters), and a test the tree does not know, such as one a loop builds, is left out of the run.
8. **JetBrains has no tree** to run a folder, a spec or a describe block from.

## 3. Where the list comes from

| Source | Role | Why |
| --- | --- | --- |
| **The listing** | Which tests exist: the tree's structure | Exact: reads the config's rules and projects, runs the loops, gives each test's `file:line:column` and Playwright's id. Needs no instance, sees the checked-out branch and the tests not committed yet |
| **The line parse** | The tests of a spec while it is being edited | Instant, starts no process |
| **The catalog** | What only the instance knows, added to each test | Latest result, flaky, owner, quarantine, duration, the dashboard's link and the catalog id |

The instance alone would show what CI last ran, not the checkout: a new test missing, a deleted one still listed,
nothing offline. The line parse alone keeps gaps 4 to 6.

Checked on Playwright 1.64.1 with a config of two projects, a loop of three tests and a describe block of two:
`playwright test --list` answered in about 0.8 s, listed every test once per project with its `file:line` (and, with
`--reporter=json`, its id), and ran neither `globalSetup` nor `webServer`; neither ran on 1.59.0 either, the oldest
Playwright the reporter supports.

### 3.1 The listing

- **How.** Per config, with the project's own Playwright and Node, as the options read does: `playwright test --list`
  with the service's reporter, which also prints, when the service asks for it, one `PIWI_TESTS <json>` line from
  `onBegin(config, suite)`: each test's Playwright id, title path (describe titles, then title), location (file, line,
  column), project name, tags and expected status. No new file in `dist/`. The options read stays a process of its
  own: it loads no spec, so the recorder's answer stays fast.
- **When.** At start; when the config changes (the fingerprint the options read already computes); when a spec is
  created, deleted or renamed; when a spec is saved, the listing of that spec alone (`playwright test --list <spec>`),
  merged into the config's. Never as the person types.
- **How often.** One listing per config at a time, the next one waiting for it as refreshes do (`refreshAll`), with a
  timeout as the options read has.
- **Watching the files.** The service has no file watcher today. It registers `workspace/didChangeWatchedFiles` for the
  config folders' scripts; whether the JetBrains LSP client of 2024.1 honors that registration is to check, else the
  plugin sends the service's request from a VFS listener.
- **When it fails** (Playwright not installed, a config that throws, a spec that does not load): the last listing that
  succeeded is kept, the config node says why with the file and line Playwright gives, and a spec that does not load
  shows its line parse. A config never listed falls back to today's answer: the catalog's specs and the open ones, read
  with the line parse.
- **Trust.** `--list` loads the config and every spec, so it runs their top-level code, as the options read and every
  run already do. Neither client starts the service in an untrusted workspace or project.

### 3.2 A spec being edited

While a spec has unsaved changes, and until the listing of its last save arrives, its tests are the line parse's, as
today. Then the listing replaces them. A loop's tests show as one test while their spec is being edited: the trade-off
for never starting Playwright on a keystroke.

### 3.3 The catalog

Each listed test is matched to the catalog by file, describe path and title, the catalog's own key (`caseOfCall`), and
takes its result, flaky mark, owner, quarantine, duration, link and id. The catalog is read whole, as today
(`allCases`, once per refresh), and gap 3 then limits only what is added to the tests. Without an instance the tree is
complete, without results.

A catalog case no listed test matches (a test deleted or renamed here, or one of another branch) goes in a **Not in
this checkout** group at the end of its config, by spec path then describe path, shown dimmed, each test opening its
page on the dashboard. Nothing in the group runs: the checkout has no code for it.

## 4. The tree

- **Levels**: config (when there are several), folders, spec, describe blocks, test, then the test's Playwright
  projects when it runs in more than one; the config's **Not in this checkout** group last
  ([§3.3](#33-the-catalog)).
- **Ids** are paths, joined by `\x1f` as VS Code's are today: the config's folder, the file, the describe titles, the
  title, the project. They are the same whichever source gave the node, so an editor keeps a node's expanded state and
  result when the listing replaces the line parse.
- **Results**: a test takes the catalog's; a project node takes the result of a run the editor follows, by Playwright's
  id, which the run channel's `test-begin` names
  ([running-line-every-lane.md](running-line-every-lane.md) §1) and the listing gives. Each editor combines the
  results of a node's children itself, as both already do.
- **Built by the service.** `piwi/testItems` answers the nodes, not the specs, and `testTree` leaves `glue.ts`: the
  JetBrains plugin needs the same tree, and the clients only draw the service's answers.
- **Pushed.** `piwi/testItemsChanged` carries the whole tree when it differs from the last one sent, as the other
  pushes do; the clients stop asking again on every change of the runs.

## 5. Running a node

The service turns the picked nodes into runs, each node with the narrowest filter Playwright takes for it:

| Node | Arguments |
| --- | --- |
| Config | none: the whole config |
| Folder | its path, ending with `/` (Playwright reads a path filter as a regular expression: `tests/auth/` keeps `tests/authentication/` out) |
| Spec | its path |
| Describe block | `<spec>:<line>`: Playwright runs every test of the block declared on that line |
| Test | `<spec>:<line>`; a test that shares its line with others (a loop's) adds `--grep` with its title, escaped and anchored |
| Playwright project | its parent's filter, with `--project <name>` |

Checked on Playwright 1.64.1: `x.spec.js:3`, the line of a describe block, listed its two tests, and `x.spec.js:2
--grep "case 2$"` the loop's second test alone.

- **One command per config and set of projects**: the picked nodes of one config go in one command, except that
  `--project` applies to every filter of a command, so project nodes with different projects make separate commands.
- **Excluded nodes** (VS Code's `request.exclude`) are left out by running their siblings' filters instead.
- **A command longer than 8,000 characters** (`cmd.exe` stops at 8,191) is split into several, run one after the
  other, never widened to tests that were not picked.
- **Locations, not catalog ids**: a run from the tree needs no instance and runs tests the instance does not know. The
  other entry points (a failure node, a test line's lens) keep `testIds`.
- **The profiles stay**: Run, Debug, Coverage and Verify ×3 with Piwi, the last through `repeat`.
- **No run by tag**: the editors' filters read the tags (Playwright's, `owner:<name>`, `quarantined`, `@piwi:flaky`),
  and a run of the filtered tree runs the nodes it shows (to check in VS Code, [§6](#6-the-clients)). No `--grep @tag`
  run is added.
- **The Not in this checkout group runs nothing**: `piwi/testRuns` leaves its nodes out.

## 6. The clients

### VS Code

- The Testing view draws the service's nodes, and a profile sends the picked node ids to `piwi/testRuns`, then runs the
  `RunTestsArgs` it answers through `runTests`, as tasks, as today. `testTree` and `testRunsOf` leave `glue.ts`.
- What follows a run (the test run, its output, the coverage) does not change.
- Every node of the checkout carries a `piwi:runnable` tag, and the four profiles take only nodes with it
  (`TestRunProfile.tag`), so the **Not in this checkout** group shows no Run button.
- To check in stage 2: with a filter on, the view's **Run Tests** runs only the tests the filter shows. If it runs
  them all, the docs say to run the filtered nodes from their own menu.
- With Microsoft's Playwright Test extension installed, the view shows two trees
  ([developer-loop-audit.md](developer-loop-audit.md) S9): the docs say what each one gives, and `piwi.testExplorer`
  turns Piwi's off.

### JetBrains

- A **Tests** tab in the Piwi tool window, beside Failures: a `Tree` of the service's nodes with each node's result
  icon (the marks both editors share), speed search, and double-click to open the source (the dashboard's page for a
  node of the **Not in this checkout** group, which offers no run action).
- A filter field above the tree takes a title, a tag, an owner or a result, as VS Code's filter does, and the
  toolbar's actions then act on the nodes it shows.
- On any node, the toolbar and the context menu offer **Run with Piwi**, **Debug with Piwi** and **Verify ×3 with
  Piwi**, the registered actions wrapped to act on the node (`registeredWith`), sent to `piwi/testRuns`. The run shows
  in its Run tab, as every Piwi run does.
- New action ids go in D25 of [1.0-stabilization.md](1.0-stabilization.md) in the same change, as
  `apps/application/tests/unit/editor-ids-register.test.ts` checks.

## 7. Protocol

All in `packages/editor/src/protocol.ts`, mirrored in `Protocol.kt` in the same change, with no compatibility path:

- `TestItemsResult.contexts[]` gives `nodes` in place of `specs`: each with `id`, `kind` (`config`, `folder`,
  `spec`, `describe`, `test`, `project`, `notInCheckout`), `label`, `uri`, `line`, `endLine`, `children`, `runnable` (false in
  the **Not in this checkout** group), and for a test the fields of `SpecTest`. And `listing`: when the config was last
  listed, and why the last listing failed, if it did.
- `piwi/testItemsChanged`, pushed with the whole answer.
- `piwi/testRuns`: `{ nodes: string[]; exclude?: string[]; repeat?: number; debug?: boolean; coverage?: boolean }` →
  `RunTestsArgs[]`.

## 8. Stages

Each a pull request with the `ide` scope.

1. **The listing and the tree** in the service (the reporter's `PIWI_TESTS` line, the listing, its triggers and its
   errors, the merge with the line parse and the catalog, `piwi/testItems` as nodes, `piwi/testItemsChanged`), and
   VS Code drawing the service's nodes. Tested in `packages/editor/tests/` on a fixture with a real `@playwright/test`,
   two projects and a loop.
2. **Running a node**: `piwi/testRuns` and its filters (`tests/commands.test.ts` for each kind of node), VS Code's
   profiles on it.
3. **The JetBrains Tests tab**, checked by `PiwiPluginTest` on the same fixture.
4. **Docs and screenshots**: the editor feature pages, `vscode.md` and `jetbrains.md`, both screenshot sets; P1 of
   [developer-loop-audit.md](developer-loop-audit.md) and LI8 of [editor-ux-coherence.md](editor-ux-coherence.md)
   updated.

## 9. Decisions

Taken by the maintainer on 2026-11-16.

| # | Question | Decision | Rejected |
| --- | --- | --- | --- |
| 1 | Where the Playwright projects go | Under each test that runs in more than one ([§4](#4-the-tree)) | A level under the config, which repeats the tree per project; a choice of projects for every run, which shows no result per project |
| 2 | A run by tag | None: the filters read the tags, and a run of the filtered tree runs what it shows ([§5](#5-running-a-node)) | A **Run by tag…** action; the tags as a grouping of the tree |
| 3 | What a saved spec lists again | That spec alone ([§3.1](#31-the-listing)) | The whole config, slow on a large suite |
| 4 | One process for the listing and the options read | Two processes ([§3.1](#31-the-listing)) | One listing for both, which makes the recorder wait for every spec to load |
| 5 | How much of the catalog is read | The whole catalog, as today ([§3.3](#33-the-catalog)) | Only the listed specs' cases: a request per spec, or a new endpoint |
| 6 | The catalog's tests the checkout lacks | A **Not in this checkout** group that runs nothing ([§3.3](#33-the-catalog)) | Hidden |
