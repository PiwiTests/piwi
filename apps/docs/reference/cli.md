---
title: Piwi CLI
description: "Every command and flag of the piwi CLI that ships with @piwitests/reporter: init, skills, gate, report, select, run, probe, flake, ai, codegen, preflight and bug."
lang: en-US
---

# Piwi CLI

The `@piwitests/reporter` package ships a command-line tool, `piwi`, for the things that happen *around* a test run: wiring a project up, gating a CI job on the dashboard's analysis, running a saved test selection, turning a recording into a spec, and managing AI-step artifacts and agent skills. This page is the reference for every command and flag; each command's own `--help` prints the same list.

## Invoking it

Run it through the package name so `npx` resolves this package:

```bash
npx @piwitests/reporter <command> [options]
```

> The package is `@piwitests/reporter`; its command is `piwi`. A plain `npx piwi …` would fetch an unrelated `piwi` from npm — invoke it through the package name. Once the reporter is a project dependency, `npx piwi <command>` resolves the local binary and works too.

| Command | What it does |
|---|---|
| [`init`](#init) | Wire a Playwright project up to a Piwi Dashboard |
| [`skills`](#skills) | Install the Piwi agent skills into this project |
| [`gate`](#gate) | Fail a CI job on the dashboard's analysis of a run |
| [`report`](#report) | Print a [quality report](/features/quality-reports) as Markdown, PDF, HTML, CSV or JSON |
| [`select`](#select-run) | Print the Playwright args for a saved test selection |
| [`run`](#select-run) | Run a saved test selection with `playwright test` |
| [`probe`](#probe) | Run the dashboard's probe plan and record what the suite noticed |
| [`flake`](#flake) | Make a flaky test fail on demand under its suspects' conditions, then verify the fix |
| [`ai`](#ai) | Manage committed natural-language AI-step artifacts |
| [`codegen`](#codegen) | Turn a steps file (a Piwi Picker recording) into a Playwright spec |
| [`preflight`](#preflight) | List the test locators your change breaks, and fix them |
| [`bug`](#bug) | Write a bug report's failing test into the project and run it once |

Several commands read connection settings from the environment as a fallback: `PIWI_DASHBOARD_URL` (dashboard URL), `PIWI_API_KEY` (API key), and `PIWI_PROJECT_NAME` (project). A flag always wins over its environment variable.

## `init`

Wire a Playwright project up to a dashboard. It installs the reporter as a dev dependency, wraps `export default defineConfig(...)` with [`wrapConfig(...)`](/guide/reporter#installing-via-wrapconfig), creates the [capture-fixtures](/guide/capture-fixtures) file, records `PIWI_*` connection settings in `.env` / `.env.example` (and `.gitignore`), and installs the [agent skills](/features/agent-skills). **Every step is idempotent** — safe to re-run — and a config shape it will not rewrite is reported as `manual` with the exact change to make. See the [one-command setup](/guide/getting-started#fast-path-one-command) in Getting started.

The `.env` it writes sits next to the Playwright config, where `npx playwright test` reads it: the reporter takes `PIWI_DASHBOARD_URL`, `PIWI_API_KEY` and `PIWI_PROJECT_NAME` from it for whatever the config and the environment leave unset, so the config needs no dotenv loading ([Values from `.env`](/reference/reporter-options#values-from-env)). The file stays out of git; in CI, set the same variables as secrets.

```bash
npx @piwitests/reporter init --server-url http://localhost:3000 --project my-project
```

| Flag | Description |
|---|---|
| `--server-url <url>` | Dashboard URL to write into the config (env `PIWI_DASHBOARD_URL`, default `http://localhost:3000`) |
| `--no-server-url` | Write no URL into the config: the reporter finds the [desktop app](/features/desktop) running on the machine, or reads `PIWI_DASHBOARD_URL` |
| `--project <name>` | Project name to report under (default: your package/folder name) |
| `--desktop-app <mode>` | Write [`desktopApp`](/guide/reporter#local-runs-to-the-desktop-app-ci-to-a-team-server) into the config: `prefer` sends local runs to the desktop app while it runs, and CI runs to `--server-url`; `fallback` or `off` |
| `--api-key <key>` | API key to write into `.env` (env `PIWI_API_KEY`), where the reporter reads it. Omit to leave a `.env.example` placeholder you fill in yourself |
| `--cwd <path>` | Project root to operate on (default: current directory) |
| `--skills <list>` | Comma-separated skills to install, or `all` / `none` (default: the four workflow skills) |
| `--skills-dir <path>` | Directory to install skills into (default: `.claude/skills`) |
| `--skills-only` | Only install skills; do not touch the config or env |
| `--no-skills` | Configure the project but install no skills |
| `--no-install` | Do not run the package manager; record the dependency only |
| `--force` | Overwrite skill files that already exist |
| `--dry-run` | Report every change without writing anything |
| `--json` | Print the plan/result as JSON (for agents) |
| `-h`, `--help` | Show help |

## `skills`

Install the Piwi [agent skills](/features/agent-skills) into a project — agent-agnostic Markdown that lets a coding agent investigate failures, heal locators, and stabilize flaky tests. `init` installs these for you; use `skills` to add them to a project that already has the reporter, or to a different skills directory.

```bash
npx @piwitests/reporter skills list
npx @piwitests/reporter skills add [names...] [options]
```

The seven skills are `setup-piwi`, `investigate-failure`, `apply-locator-healing`, `stabilize-flaky-tests`, `run-the-right-tests`, `write-the-missing-test` and `fix-a-reported-bug`. `add` with no names installs all of them. Each installed file is stamped with the reporter's version (`piwi-version`) and a hash (`piwi-hash`); `add` reports a skill as `outdated` when an older release installed it and it was never edited, and replaces it, and as `edited` when it changed since it was installed, and keeps it.

| Flag (for `add`) | Description |
|---|---|
| `--dir <path>` | Directory to install into (default: `.claude/skills`) |
| `--cwd <path>` | Project root to operate on (default: current directory) |
| `--force` | Replace a skill that was edited since it was installed (an untouched skill from an older release is always updated) |
| `--dry-run` | Report what would be written without writing |
| `--json` | Print the results as JSON |

## `gate`

Fail a CI job on the dashboard's analysis of a run — the [merge gate](/guide/ci#blocking-a-merge). Point it at a run, give it at least one policy rule, and it exits non-zero when the rule is violated. The run defaults to `./piwi-run.json` (the reporter's [output file](/guide/ci#getting-the-run-url-back-out-of-ci)) when present.

```bash
npx @piwitests/reporter gate --max-new-regressions 0 --fail-on-flaky
```

**Exit codes:** `0` satisfied · `1` violated · `2` could not evaluate · `3` inconclusive: the run is an [environment incident](/features/environment-incidents), so it cannot say whether the change is good.

| Flag | Description |
|---|---|
| `--run-id <id>` | Run id to evaluate |
| `--from-file <path>` | Read `runId` from the reporter's output JSON |
| `--server-url <url>` | Dashboard URL (env `PIWI_DASHBOARD_URL`) |
| `--api-key <key>` | API key (env `PIWI_API_KEY`) |
| `--require-tag <tags>` | Comma-separated; every test carrying the tag must pass |
| `--max-failed <n>` | Fail when more than *n* tests failed |
| `--max-new-regressions <n>` | Fail when more than *n* tests newly started failing |
| `--max-new-flaky <n>` | Fail when more than *n* tests newly became flaky |
| `--max-quarantined <n>` | Fail when more than *n* tests are quarantined |
| `--fail-on-new-cluster` | Fail when this run introduced a new failure cluster |
| `--fail-on-flaky` | Fail when this run contains any flaky test |
| `--require-selection <key>` | Fail when a test the named selection matches did not run or failed |
| `--max-leaks <n>` | Fail when the run left more than *n* browsers, contexts or pages open, counted per opening line |
| `--max-new-leaks <n>` | Fail when more than *n* of those were never seen on the base branch |
| `--max-uncovered-changes <n>` | Warn when more than *n* changed files are [uncovered changes](/features/uncovered-changes): no test reached them (warn-only — never fails the gate) |
| `--min-patch-coverage <percent>` | Warn when fewer of the change's added and modified lines ran, in the head commit's [combined coverage](/features/combined-coverage) (warn-only — never fails the gate) |
| `--json` | Print the raw result as JSON instead of a summary |
| `-h`, `--help` | Show help |

The run source is resolved first-match-wins: `--run-id`, then `--from-file`, then `PIWI_OUTPUT_FILE`, then `./piwi-run.json`. At least one policy rule is required.

## `report`

Print a [quality report](/features/quality-reports) from the dashboard, so a CI scheduler can post it every
week. It calls the report endpoint with the API key; the scope and the dashboard are the ones the
*Export* dialog offers.

```bash
npx @piwitests/reporter report --project checkout --period 7d --format md
```

**Exit codes:** `0` written · `1` written, and the verdict is at or below `--fail-on` · `2` no report.

| Flag | Description |
|---|---|
| `--server-url <url>` | Dashboard URL (env `PIWI_DASHBOARD_URL`) |
| `--api-key <key>` | API key (env `PIWI_API_KEY`) |
| `--project <names>` | Comma-separated project names or ids (default: every project the key can see) |
| `--period <period>` | `7d`, `30d` (default), `last-month`, `this-quarter`, `2026-08-01..2026-08-31`, … |
| `--compare <mode>` | `previous` (default), `year` or `none` |
| `--dashboard <name>` | `executive` (default), `engineering` or `overview` |
| `--branch <names>` / `--environment <names>` | Narrow the runs (default: each project's default branch) |
| `--selection <key>` | Only the tests of this [selection](/features/test-selection) |
| `--lang <en\|fr>` | Report language |
| `--format <fmt>` | `md` (default), `json`, `html`, `pdf`, `csv` |
| `--output <file>` | Write to a file instead of stdout (required for `pdf`) |
| `--fail-on <tone>` | `bad`: exit 1 on a bad verdict; `mixed`: on a mixed or bad one |
| `-h`, `--help` | Show help |

## `coverage`

Upload another tool's coverage report of a commit to the dashboard, for [combined coverage](/features/combined-coverage):
the unit tests of a front end or a back end, from Cobertura or LCOV. The command reads each report as a stream,
resolves its paths against the checkout, keeps the files in the project's coverage scope and sends paths, line numbers
and git blob ids, with the commit's tracked files in scope. Uploads of one commit and suite merge, so shards upload
separately. When a newer commit has superseded this one on its branch (a CI job run again), the upload
still exits `0`, the summary says so in one line, and the dashboard keeps the commit's totals as they were.

```bash
npx @piwitests/reporter coverage upload "**/coverage.cobertura.xml" --suite unit-back
```

**Exit codes:** `0` uploaded · `1` nothing to upload (no report, or no file of the reports in the checkout) · `2` the upload could not be made.

| Flag | Description |
|---|---|
| `--suite <name>` | The suite the report covers, e.g. `unit-back` |
| `--kind <kind>` | `unit` (default) or `e2e`, for a backend's own run-level report |
| `--format <format>` | `cobertura`, `lcov` or `piwi` (a .NET test host's report, written at exit with `PIWI_COVERAGE_OUTPUT`); detected from the content when absent |
| `--root <dir>` | The directory the reports' relative paths start from |
| `--project <name\|id>` | Project (env `PIWI_PROJECT_NAME`) |
| `--server-url <url>` | Dashboard URL (env `PIWI_DASHBOARD_URL`) |
| `--api-key <key>` | API key (env `PIWI_API_KEY`) |
| `--branch <name>` | The branch (env `PIWI_BRANCH`, the CI's, else git's) |
| `--dry-run` | Read and resolve the reports, print the summary, send nothing |
| `--json` | Print the summary as JSON |
| `-h`, `--help` | Show help |

Patterns are expanded by the command, so a quoted `**` works the same in every shell. Without `--root`, a relative path
is tried against the report's `<source>`, the current directory, the report's directory and its parent (Vitest writes
`coverage/` under its root), and the repository root; the first that names a file of the checkout wins, and the
summary counts the paths none did. An absolute path is taken under the repository root, and the `/_/` of a .NET build
with `ContinuousIntegrationBuild` is read as the repository root, in a path or in the `<source>` it is joined to.

Each file is named by the git blob of its content in the checkout. When `git hash-object` fails on a file, the command
says so on stderr and goes on: a changed tracked file is left out of the commit's inventory, a file git does not track
is sent without its blob.

## `select` / `run` {#select-run}

Resolve a saved [test selection](/features/test-selection) to the tests it matches. `select` prints the Playwright args (so you can compose them yourself); `run` executes `playwright test` with them. `run impact --base <ref>` runs the tests your working-tree diff impacts, down to the tests that ran the changed lines when tests record coverage ([line level](/features/change-impact#line-level)).

```bash
npx @piwitests/reporter select smoke
npx @piwitests/reporter run smoke -- --workers=4
npx @piwitests/reporter run impact --base origin/main
```

**Exit codes:** `0` ok · `1` the test run failed (`run` only) · `2` could not resolve.

| Flag | Description |
|---|---|
| `--server-url <url>` | Dashboard URL (env `PIWI_DASHBOARD_URL`) |
| `--api-key <key>` | API key (env `PIWI_API_KEY`) |
| `--project <name\|id>` | Project (env `PIWI_PROJECT_NAME`) |
| `--format <fmt>` | `args` (`file:line`, default) · `grep` · `files`. For the full resolution use `--json`; `run` rejects `--format json` |
| `--budget <duration>` | Cap total time, e.g. `5m`, `90s`, `300000` (ms) |
| `--shard <i/n>` | Keep only shard *i* of *n*, balanced by test duration and lock-aware (a lock's holders stay in one shard). `run` reports the shard to the dashboard (`PIWI_SHARD`), so the shards merge into one run |
| `--fail-fast` | Order the least-reliable tests first |
| `--base <ref>` | For `impact`: the ref to diff the working tree against |
| `--strict` | Fail (exit 2) instead of falling back when unreachable |
| `--pkg-runner <cmd>` | Package runner for the printed command (default `npx`) |
| `--json` | Print the full resolution as JSON (`select` only) |
| `-h`, `--help` | Show help |

Pass extra Playwright arguments after `--`: `piwi run smoke -- --headed --workers=1`.

When the dashboard is unreachable, `run` reuses the last good resolution from `.piwi/selection-cache.json`. An entry is
keyed by the `--project` value as written, the selection key and the flags that shape the resolution, so a project given
by name is found offline, and a name and an id for the same project are separate entries. With nothing cached, `run`
runs the full suite, or exits `2` under `--strict`.

`run --shard` sets `PIWI_SHARD=<i/n>` for the Playwright process, which the reporter reports as the run's shard, so the
shard jobs of one pipeline merge into one [run](/guide/ci#sharding) and do not cancel each other's runs. Playwright gets
no `--shard` of its own, since the resolved tests are already the shard's. A `select` job that passes the printed
arguments to `playwright test` sets `PIWI_SHARD` itself, to the same `i/n` it gave `--shard`.

When `run` spawns Playwright and the target config has **no Piwi reporter**, it appends `--add-reporter @piwitests/reporter` so the run still reaches the dashboard — provided the installed Playwright is **1.63 or later** (the version that added the flag; it appends to the configured reporters rather than replacing them). It logs one line naming what it added. On older Playwright it logs that the reporter is not configured and runs as before. This trial append gives you results, traces and screenshots but not the [capture fixtures](/guide/capture-fixtures) or [`wrapConfig`](/guide/reporter#installing-via-wrapconfig) defaults — wire the reporter into the config (via [`init`](#init)) for the full set. A config that already lists the reporter is left untouched.

## `probe`

Run the dashboard's [probe plan](/features/probes) and record what the suite noticed. `probe` fetches the (test, route, fault) pairs the dashboard wants checked, runs `playwright test` with the [capture fixtures](/guide/capture-fixtures) in probe mode — each fault injected at the network boundary, one per test — and posts the outcomes back. The run is stamped as a probe run, so the dashboard never counts it as a real run (no clusters, regression signals, notifications or PR feedback), and retries are forced off.

```bash
npx @piwitests/reporter probe --project my-app
```

| Flag | Description |
|---|---|
| `--server-url <url>` | Dashboard URL (env `PIWI_DASHBOARD_URL`) |
| `--api-key <key>` | API key (env `PIWI_API_KEY`) |
| `--project <name\|id>` | Project name or id (env `PIWI_PROJECT_NAME`) |
| `--budget <n>` | Max pairs to probe this run (default the server's) |
| `-h`, `--help` | Show help |

Everything after `--` is passed to `playwright test`. A probed test fails by design when it notices the injected fault, so a non-zero Playwright exit is expected and is not a command error.

## `flake`

Run a [Flake Lab](/features/flake-lab) experiment on one flaky test, in the checkout you are in. `flake` fetches the
test's plan from the dashboard: a control arm with no condition, then one arm per suspect of its
[flake profile](/features/flaky-tests#suspects), most likely first. It runs the control, then each arm, one test at a
time with retries off and the [capture fixtures](/guide/capture-fixtures) in flake mode, and counts only the failures
whose error matches the test's failures in history. It prints each arm against the control with its verdict, and saves
the experiment on the test's Flakiness tab.

```bash
npx @piwitests/reporter flake 1842
npx @piwitests/reporter flake tests/checkout.spec.ts:42 --suspect 1
npx @piwitests/reporter flake verify 1842
git bisect run npx @piwitests/reporter flake verify 1842 --bisect
```

`<test>` is a test case id (the number in its dashboard URL) or a spec file and line, looked up in the project.
`flake verify` reruns the arm that last reproduced the test, and its control, until a matching failure appears or
enough runs pass to say the fix holds. `flake verify --bisect` runs that arm alone at the commit checked out, saves
nothing, and answers in the exit codes `git bisect run` reads, so a bisect can find the commit where the flake started.

| Flag | Description |
|---|---|
| `--suspect <n>` | Run only the arm of suspect `n`, its rank on the Flakiness tab |
| `--all` | Also run every condition at once when none reproduces alone |
| `--runs <n>` | Runs of the control and of each arm (default 10; `verify`: the number that proves the fix at the rate the arm reproduced) |
| `--budget <duration>` | Start no new arm after this long: `15m` (default), `90s`, `1h` |
| `--no-upload` | Keep the results off the dashboard. The plan still comes from the dashboard, or from `--plan` when it cannot be reached |
| `--plan <file>` | Read the plan from a file (a saved plan response, or the `plan` of the `plan_flake_experiment` MCP tool) and run it without the dashboard; implies `--no-upload` |
| `--bisect` | `verify` only: one bisect step, the reproducing arm alone with nothing saved; implies `--no-upload` |
| `--source <where>` | Where the lab ran, recorded on the experiment: `cli`, `ci` or `desktop` (default `ci` when `CI` is set, else `cli`) |
| `--json` | Print the arms, their counts, verdicts and p-values as JSON |
| `--server-url <url>` | Dashboard URL (env `PIWI_DASHBOARD_URL`, `.env`, the desktop app) |
| `--api-key <key>` | API key (env `PIWI_API_KEY`, `.env`) |
| `--project <name\|id>` | The Piwi project, for a `file:line` test (env `PIWI_PROJECT_NAME`) |
| `-h`, `--help` | Show help |

An arm stops at 3 failures with the same error as in CI. It runs in batches of up to five repeats and its attempts are
counted in start order, cut after the third matching failure, since Playwright's `--max-failures` counts every failure.
An `alongside` arm runs both tests on two workers and keeps only the rounds where they overlapped; an `after` arm runs
both on one worker and keeps only the rounds where the other test ran just before.

**Exit codes:** `0` an arm reproduced the failure (`verify`: the fix held) · `1` nothing reproduced (`verify`: it still
fails, or there were too few runs to say) · `2` error: the plan could not be read, or an arm recorded no attempt of the
test. With `--bisect`: `0` good (no matching failure in the runs that prove it) · `1` bad (a matching failure) · `125`
skip (too few clean runs, or this commit could not run the arm) · `2` error: the plan could not be read.

## `ai`

Manage committed natural-language [AI-step](/features/ai-steps) artifacts (`page.piwiLocator(...)` / `page.piwiRun(...)`). The LLM authors each entry once; CI replays the committed JSON deterministically with no model calls, so these commands are how you keep the committed set healthy.

```bash
npx @piwitests/reporter ai check
npx @piwitests/reporter ai resolve --grep "checkout"
```

| Subcommand | What it does |
|---|---|
| `check` | Scan committed entries for orphans, non-canonical files and duplicate templates. Read-only; exits `1` on errors (orphans, non-canonical or invalid files) — duplicate templates are reported as warnings and do not fail it |
| `resolve` | Author missing entries by running the suite in resolve mode against the configured authoring server (forces `--workers=1`). Needs `PIWI_DASHBOARD_URL` (plus `PIWI_API_KEY` when auth is on) and exits `2` without it |
| `prune` | Reserved for cleaning up orphaned/dormant entries — not available in this build; it prints a notice and exits `2` |

| Flag | Applies to | Description |
|---|---|---|
| `--dir <name>` | `check` | Entry directory name per spec (env `PIWI_AI_DIR`, default `__piwi__`) |
| `--cwd <path>` | `check` | Root to scan (default: current directory) |
| `--json` | `check` | Emit findings as JSON |
| `--grep <re>` | `resolve` | Only author entries for matching tests |
| `--project <name>` | `resolve` | Author under one Playwright project (a resolve profile) |
| `--env K=V` | `resolve` | Extra env for the run (repeatable — flags/viewport profiles) |
| `--update-ai` | `resolve` | Re-author entries that already exist |

**Exit codes:** `0` clean (or `--help`) · `1` hygiene errors found · `2` bad arguments / command unavailable. `resolve` passes through the test run's exit code.

## `codegen`

Turn a [steps file](/reference/steps-format) into a Playwright spec. Piwi Picker saves one with
[**Download steps**](/features/record-actions). The spec is written for a test project: URLs on the recorded
site become paths, so your config's `baseURL` applies; each element uses the first of its recorded locators that the
[stability rules](/reference/locator-stability) call stable; and after each step that leads to another page, the spec
waits for that page's URL. Nothing is sent anywhere unless a project is configured.

```bash
npx @piwitests/reporter codegen steps.json --out tests/checkout.spec.ts --test-import ./fixtures
```

`codegen bug:<id>` reads the steps of a [bug report](/features/bug-reports) from the dashboard (`--server-url`) instead
of a file.

| Flag | Description |
|---|---|
| `--out <file>` | Write the spec to this file instead of printing it; an existing file is kept unless `--force` |
| `--force` | Replace the file `--out` names |
| `--body` | Print only the test's lines, to paste into an existing test, with the imports they need as comments |
| `--title <text>` | Test title (default: the steps file's own title) |
| `--test-import <mod>` | Module `test` and `expect` are imported from, such as your fixtures file (default `@playwright/test`) |
| `--absolute-urls` | Keep the recorded URLs instead of paths |
| `--no-url-checks` | Do not wait for each new page's URL |
| `--env-values` | Read every typed value from an environment variable named after its field (`E2E_EMAIL` for a field labeled Email) instead of writing it into the spec |
| `--fail` | Mark the test as expected to fail (`test.fail()`) |
| `--fail-reason <text>` | The reason written beside `test.fail()`, such as a ticket key |
| `--tag <tag>` | Add a tag; repeat for more (`@` is added when missing) |
| `--project <name\|id>` | Project (env `PIWI_PROJECT_NAME`): its [function catalog](/features/test-functions) turns matching steps into calls to your own functions, and a locator your tests already use is preferred when it is not brittle |
| `--server-url <url>` | Dashboard URL (env `PIWI_DASHBOARD_URL`) |
| `--api-key <key>` | API key (env `PIWI_API_KEY`) |
| `--offline` | Do not contact the dashboard, even when one is configured |
| `-h`, `--help` | Show help |

Warnings go to stderr, one per step worth a look: a password read from the environment, an element with no locator,
or one whose best locator is brittle. A dashboard that cannot be reached only costs the catalog and the preferred
locators; the spec is still written.

**Exit codes:** `0` written or printed · `2` the steps file could not be read or checked, or the spec could not be
written.

## `preflight`

List the test locators a change breaks, before it runs: [Locator preflight](/features/preflight) explains what it
reads and how it matches. It diffs the working tree against a ref, compares the strings the diff removes or renames
with the project's locator index, and prints each broken chain with its tests, its call sites and its rewrite.

```bash
npx @piwitests/reporter preflight
npx @piwitests/reporter preflight --base @{upstream} --strict
npx @piwitests/reporter preflight --fix --run -- --workers=2
```

| Flag | Description |
|---|---|
| `--base <ref>` | Diff the working tree against this ref (default `HEAD`: uncommitted changes) |
| `--branch <name>` | Compare with this branch's locator index (default: the project's default branch) |
| `--test-root <dir>` | Where call sites resolve (default: the directory of the nearest `playwright.config`) |
| `--locale <code>` | Translation files of this locale resolve keys first (default `en`) |
| `--fix` | Write the rewrites into the call sites whose line holds the string |
| `--run` | Run the tests that reach the changed files and the specs of the broken locators; Playwright arguments go after `--` |
| `--strict` | Exit 1 when a likely break is left unfixed |
| `--server-url <url>` | Dashboard URL (env `PIWI_DASHBOARD_URL`, then `.env`, then the running desktop app) |
| `--api-key <key>` | API key (env `PIWI_API_KEY`) |
| `--project <name\|id>` | Project (env `PIWI_PROJECT_NAME`) |
| `--json` | Print the breaks, their call sites, the edits and the impact as JSON |
| `-h`, `--help` | Show help |

The index is cached in `.piwi/locator-index.json` per dashboard, project and branch, and used when the dashboard
cannot be reached.

**Exit codes:** `0` ok, breaks or not · `1` a likely break left unfixed with `--strict`, or `--run`'s tests failed ·
`2` the index could not be fetched and there is no cached copy, or the diff could not be read.

## `bug`

Get a [bug report](/features/bug-reports)'s failing test from the dashboard, written with the project's
[generated specs settings](/features/bug-reports#the-failing-test): `test.fail()` while the bug exists, `@bug`, and
`piwi:bug <id>` so the report follows its runs. Printed by default; `--write` puts it in the project's bugs folder
(`tests/bugs` unless the project names another) and runs it once with `playwright test`, so you see the bug reproduce
before you fix it.

```bash
npx @piwitests/reporter bug 37 --write
```

| Flag | Description |
|---|---|
| `--write` | Write the spec to the project's bugs folder (from the repository root), then run it once |
| `--out <file>` | Write it to this file instead, then run it once; its test import is written for that file's folder |
| `--no-run` | With `--write` or `--out`: write it without running it |
| `--force` | Replace an existing file |
| `--run-mode` | The spec without `test.fail()`, as a reproduction runs it |
| `--server-url <url>` | Dashboard URL (env `PIWI_DASHBOARD_URL`) |
| `--api-key <key>` | API key (env `PIWI_API_KEY`) |
| `-h`, `--help` | Show help |

**Exit codes:** `0` printed or written, and when run, the test failed on the bug as `test.fail()` expects · `1` the run
did not: the bug may be fixed, or a step no longer matches the page · `2` the report could not be read or the file
could not be written.

## Related

- [Getting started](/guide/getting-started) — `init` in the setup flow
- [CI & sharding](/guide/ci) — `gate` in a CI job, and the run output file
- [Test selections](/features/test-selection) — what `select` / `run` resolve
- [AI steps](/features/ai-steps) — the authoring/replay lifecycle `ai` manages
- [Flake Lab](/features/flake-lab): the experiments `flake` runs and how their verdicts read
- [Agent skills](/features/agent-skills): what `skills` installs and what each skill does
