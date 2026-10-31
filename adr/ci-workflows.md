# CI workflows: cost and organization

- Status: accepted
- Date: 2026-10-03

A plan to cut the runner time the GitHub Actions workflows spend and the time a pull request waits for them, and to give
the eighteen workflow files one organization and one set of conventions. Every figure below comes from the GitHub
Actions API: the 200 workflow runs between 2026-10-02 15:22 and 2026-10-03 06:15 UTC, about 15 hours, 12 pull requests
and 8 merges to `main`.

**Status.** Proposed 2026-10-03. **Phase 1 built 2026-10-03**: the release PR runs one version check instead of the
suites, every pull-request workflow cancels its superseded runs, every job has a timeout and every workflow declares
its token permissions, the Playwright browser cache is keyed on the Playwright version, commitlint installs from the npm
cache without install scripts, and the extension E2E flake is fixed. What changed while building phase 1:

- The PR title check still runs when a PR's body is edited. Skipping it on body edits would let an edit turn a failed
  title check green: the latest run of a check is the one a required check reads.
- The extension E2E keeps installing Chromium on every run. It runs on pull requests only, and a cache a pull request
  saves serves that pull request alone; one entry per pull request (about 170 MB) would push the caches `main` saves
  out of the repository's 10 GB.
- The flaky test (`bug-report.spec.ts`, "keeps the viewport the steps were played at…") pressed the bug HUD's buttons
  from the keyboard while the HUD was being drawn again: a recording draws its HUD twice as it attaches to a page, and
  a redraw dropped the focus. A redraw now keeps the focus on the button that had it. A second cause stays open: the
  surfaces are hidden with `visibility: hidden` while a step's screenshot is taken, which also drops the focus. The test
  waits for a shown HUD; the product fix is to hide for a screenshot in a way that keeps the focus (`opacity: 0`),
  separately from the hide of a pick, which must also let the pointer through.
- Three more extension E2E tests failed on this pull request's own runs, each a race between the test and a redraw or
  an asynchronous render: a helper measured a replay-panel button a redraw had detached (`trusted-replay.spec.ts`),
  a test focused the popup's project select before the popup showed it (`popup.spec.ts`), and a test moved the
  pointer off a Tests row the browser had not yet seen under it (`coverage-overlay.spec.ts`). Each is fixed, and the
  suite retries a failed test once on CI (from phase 3), so the next race reports a flaky test instead of failing
  the job.

**Phase 2 built 2026-10-03**: the `setup-workspace` action and `.node-version`, the `changes` job, the four
editor, extension and desktop suites as reusable workflows `ci.yml` calls, `CI result`, the docs build on pull
requests, `pr-lint.yml`, and `.github/AGENTS.md` with the conventions. What changed while building phase 2:

- The release PR check and the version check are one job, `Versions`, which runs on every pull request; on the release
  PR it also runs `npm ci`, and it is the only job there. The `changes` job skips the release PR, which skips every job
  that needs it.
- `app` also covers `apps/docs/**` and `CHANGELOG.md`: the server bundles both for its MCP tools. `ci` covers
  `.github/workflows/**`, `.github/actions/**` and `.node-version` only, not the issue templates or `dependabot.yml`.
- The editor, extension and desktop suites run on pull requests only, as before; on `main` they would run again what
  the pull request passed.
- `pr-lint.yml` runs on `pull_request` with the `edited` type, and every job runs on every event. The title check moved
  from `pull_request_target`: it reads the title from the event and needs no write token. `actionlint` runs from its
  Docker image, on every pull request.
- The docs build runs on the `.node-version` Node (24), as the demo it is deployed with.
- The release workflows (`publish*.yml`, `desktop-release.yml`) keep their own Node setup until phase 4 rewrites them.
- Dependabot also updates the actions of `.github/actions/*`.
- Branch protection is still to switch: the required checks become `CI result`, `commitlint`, `title` and
  `actionlint`. Check names that moved: the four suites report as `Extension E2E / e2e (shard …)`,
  `VS Code E2E / e2e`, `JetBrains plugin / plugin`, `JetBrains plugin / verify (…)` and `Desktop E2E / e2e`.

**Phase 3 built 2026-10-03**, on decisions D2 (option A), D4 (two IDEs on pull requests, four on `main`) and D5
(Windows and macOS when the packages change, and on `main`): the `changes` job picks the E2E backends and the package
smoke systems, the extension suite runs in three shards, the desktop suite stages `ci.yml`'s build, and the JetBrains
Plugin Verifier runs on two IDEs for a pull request. What changed while building phase 3:

- The matrices are computed in the `changes` job (`jq`) and read with `fromJSON` as `include` lists: five shards per
  backend, 10 E2E jobs on a pull request and 20 on `main`.
- The package smoke systems widen on `package-lock.json`, `apps/application/package.json` and
  `apps/application/nuxt.config.ts` too: a new dependency or a bundling change is what breaks the packages on Windows
  or macOS.
- Playwright splits the extension suite by test count, file by file: 146, 150 and 142 tests. The shard holding
  `replay.spec.ts` takes about 7.8 minutes of tests against 13.4 for the whole suite; splitting that file would bring
  it near 5. Each shard installs and builds on its own, about 2 more runner minutes per shard.
- The build job also runs on a pull request that changes only the desktop app, for the desktop suite to stage it; the
  desktop suite skips the root `npm ci` and the macOS build. Run on demand, it still builds on macOS.
- On `main` the JetBrains job verifies on four IDEs, and its plugin job writes the Gradle cache the pull requests
  read.
- `checks` stays one job until a measurement shows it is the longest path.

**Phase 4 built 2026-10-03**, on decision D3 (the `edge` image on every push to `main`): `release.yml` publishes a
release through one reusable workflow per target, on one node-server build, and `edge.yml` pushes the `edge` image.
Phase 5's documentation landed with phases 2 to 4. What changed while building phase 4:

- `release.yml` takes no tag input: run on demand, it uses the ref it is run on, a tag to publish. Its inputs tick
  the targets, so a release whose publication failed on one target runs again for that target alone; "Re-run failed
  jobs" covers a failure the same week (the shared build stays 3 days).
- A pull request that changes `release.yml` or a `reusable-publish-*.yml` runs `release.yml`: every target builds and
  packs (`npm pack --dry-run`, `dotnet pack`, both image architectures, the four desktop legs, the three
  extension packages), and nothing is pushed or published. The npm jobs pack rather than run
  `npm publish --dry-run`: logged in, npm checks the version against the registry, and the version on a branch is
  the one already published (the first dry run failed on it). It is not a check of `CI result`: it runs on the
  release workflows' changes alone, which is rare, and takes about 20 minutes.
- The container workflow pushes only from a tag or `main`; elsewhere it builds both architectures, reads the
  registry cache and writes none.
- The npm server package ships the shared build, so it now carries the build's commit (`PIWI_BUILD_SHA`), as the
  container image and the desktop app do.
- `edge.yml` cancels a run still building when a newer commit lands on `main`: one image per burst of merges.
- The publications authenticate with `NPM_TOKEN` and `NUGET_API_KEY`, which no file name binds. npm provenance now
  comes from a reusable workflow; the first release tag after the merge is its first real run, as the dry run
  publishes without provenance.
- `changelog-polish.yml` is `release-notes.yml`.

## What we measured

| Workflow                 | Runs | Median (success) | Note                                                      |
| ------------------------ | ---: | ---------------: | --------------------------------------------------------- |
| `ci` (pull_request)      |   30 |         12.3 min | 27 jobs per run; 6 runs cancelled by a newer push         |
| `ci` (push to `main`)    |    8 |         13.6 min | runs again everything the pull request already passed     |
| Lint PR title            |   45 |          0.4 min | runs again on every edit of the release PR                |
| Lint commits             |   29 |          0.8 min | a full `npm ci` without the npm cache                     |
| JetBrains Plugin         |   16 |          6.5 min | 5 jobs; the Gradle cache is never written                 |
| Extension E2E            |   16 |         16.1 min | one worker, 437 tests in 13.6 min; 3 failures out of 16   |
| Desktop E2E              |   16 |          7.0 min | macOS; builds the Nuxt server again (2.3 min)             |
| VS Code E2E              |   16 |          1.0 min |                                                           |
| Publish Container Image  |    8 |          4.5 min | a multi-arch `edge` image on every push to `main`         |
| Deploy Docs & Demo       |    8 |          2.0 min |                                                           |

**Runner minutes** below are the sum of every job's duration: the machine time spent. **Wall-clock time** is what a
developer waits, from the run's start to its last job.

One `ci` run on a pull request (run 37101083957) is **27 jobs, about 80 runner minutes and 11 minutes of wall-clock
time**. The E2E matrix (4 storage and database pairs, called backends below, × 5 shards) is 20 of those jobs and about
65 runner minutes, **80 % of the run**; each E2E job spends about 3.3 minutes in Playwright and 40 seconds getting
ready. The `checks` job runs lint, typecheck and unit tests in sequence in 7.3 minutes, 162 seconds of them the
application's unit tests and 104 seconds the reporter's. The account runs at most 20 jobs at once (5 on macOS), so a
single `ci` run already queues: jobs waited up to 208 seconds to start.

Each merge to `main` costs about **210 runner minutes**, because it also updates the release PR. release-please rewrites
the version in `apps/desktop`, `apps/jetbrains`, `apps/vscode`, `apps/extension` and `package-lock.json`, so every
path-filtered workflow ran on the release PR although no code changed:

| Started by one merge                     | Jobs | Runner minutes |
| ---------------------------------------- | ---: | -------------: |
| `ci` on `main`                           |   27 |            ~80 |
| The release PR (8 workflows)             |  ~36 |           ~120 |
| `edge` image, docs, release-please       |    5 |            ~10 |

Over the window, about **4,100 runner minutes**: about 960 (23 %) on the release PR and about 720 (18 %) on pushes to
`main`.

## Causes, by what fixing them saves

1. **The release PR is tested like a code PR**, on every merge. The two Extension E2E failures on it were therefore
   flakes, not regressions.
2. **The full E2E matrix runs on every pull request.** Storage and database are independent axes in the code:
   `local + sqlite` and `s3 + postgres` run each implementation at least once. The two crossed pairs add next to
   nothing on a pull request and cost 10 jobs.
3. **`ci` runs again in full on `main`** after a pull request that passed it.
4. **The path-filtered workflows had no `concurrency`**: a push left the previous commit's runs going, up to 16 minutes
   for Extension E2E.
5. **The Gradle cache is never written.** `gradle/actions/setup-gradle` writes it on the default branch only, and
   `jetbrains.yml` never runs there (the job log says `Cache is read-only`). Each `verify` job downloads about 935 MB of
   plugins and dependencies.
6. **The Playwright browser cache was keyed on `package-lock.json`**: any dependency update, and every release,
   missed it.
7. **Extension E2E runs on one worker with no retry**: 13.6 minutes, 5.1 of them in `replay.spec.ts`, and one flaky
   test fails the job.
8. **Desktop E2E builds the server on macOS**, where `desktop-release.yml` shows a Linux build is enough
   (`stage-server.mjs` adds the native modules of each OS).
9. **A release builds the `node-server` output twice** (`publish.yml` and `desktop-release.yml`).

## What is uneven in the organization

- **Names**: `ci`, `release-please`, `live-jira` lower case; `Desktop E2E`, `Lint commits` title case.
  `Publish Container Image` also publishes `@piwitests/reporter` and `@piwitests/server` to npm.
- **npm publishing in two files**: reporter and server in `publish.yml`, the Nitro instrumentation in
  `publish-instrumentation.yml`.
- **The Node setup is copied about twenty times** with variations: `node-version` `24`, `'24'`, `22`, `24.4.1`; npm
  cache or not; `npm ci` with or without `--prefer-offline --no-audit --fund=false`.
- **Steps without a `name`** in commitlint, publish-instrumentation, publish-nuget, desktop-e2e and desktop-release.
- **`defaults.run.working-directory: ./apps/application`** in `ci.yml`, overridden by `working-directory: .` on most
  steps.
- **Nothing checks the docs build or the Dockerfile on a pull request**, and nothing lints the workflows themselves.

## Target organization

```
.github/
  AGENTS.md                      Area guide: the conventions below (linked from the root AGENTS.md)
  actions/
    setup-workspace/action.yml   Composite action: Node, npm cache, npm ci, Playwright browsers on request
  workflows/
    ci.yml                       Pull requests and main: every check, one required check "CI result"
    pr-lint.yml                  Pull requests: title, commits, actionlint when .github/** changes
    release-please.yml           Push to main
    release.yml                  Tag v*: every publication; on demand per target; a dry run on PRs that change it
    edge.yml                     Push to main: the edge container image
    release-notes.yml            Release published (was changelog-polish.yml)
    docs.yml                     Push to main: docs and demo deployment
    live-jira.yml                Manual
    reusable-e2e-extension.yml   Reusable workflows (workflow_call), called by ci.yml
    reusable-e2e-vscode.yml
    reusable-e2e-desktop.yml
    reusable-jetbrains.yml
    reusable-publish-npm.yml     reporter, server and the Nitro instrumentation
    reusable-publish-container.yml
    reusable-publish-nuget.yml
    reusable-publish-desktop.yml
    reusable-publish-vscode.yml
    reusable-publish-jetbrains.yml
    reusable-publish-extension.yml
```

GitHub takes no subfolder in `workflows/`: the `reusable-` prefix groups the reusable workflows in the list.

**Conventions** (to write down in `.github/AGENTS.md`):

- A readable `name:` that matches the file (`CI`, `PR lint`, `Release`, `Nightly`…).
- `permissions: contents: read` on the workflow; anything more on the job that needs it.
- `timeout-minutes` on every job and a `name` on every step.
- Node set up only through `.github/actions/setup-workspace`, its version read from a root `.node-version`; an explicit
  version only where a job tests a floor (`engines`, Node 22) or a bundled runtime (desktop, `24.4.1`).
- `concurrency` with cancellation on every pull-request workflow:
  `group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}`. Never in a reusable workflow:
  there `github.workflow` is the caller's name, so the group collides with the caller's and the run cancels itself.
- An explicit `retention-days` on every artifact (1 day for the ones jobs hand to each other).
- A new check is added to the `needs` of `CI result`, never as a separate required check.

## Phases

Each phase is one pull request, measured before and after with the same API queries as above.

### Phase 1: quick wins, no new structure (built)

- [x] The release PR: the heavy jobs of `ci.yml`, `desktop-e2e.yml`, `extension-e2e.yml`, `vscode-e2e.yml` and
      `jetbrains.yml` skip it (`if: ${{ !startsWith(github.head_ref, 'release-please--') }}`), and a
      `Release PR versions` job runs `npm ci` (which fails on a lockfile out of step) and
      `scripts/check-release-versions.mjs`. A job skipped by its `if` counts as passed for a required check, where a
      workflow its path filter never started stays pending.
- [x] `scripts/check-release-versions.mjs` also runs in the `checks` job of every pull request.
- [x] `concurrency` with cancellation on desktop-e2e, extension-e2e, vscode-e2e, jetbrains, commitlint and the PR title
      check; `ci.yml` groups by pull request number too.
- [x] The Playwright browser cache key is the OS, the `playwright-core` version and the build (`shell`); the demo job
      uses it too.
- [x] commitlint: npm cache, `npm ci --ignore-scripts`.
- [x] `timeout-minutes` on every job and `permissions` on every workflow.
- [x] The extension E2E flake (see Status).

### Phase 2: structure (built; branch protection still to switch)

- [x] The `setup-workspace` composite action and the root `.node-version`, replacing the copied setup blocks of the
      pull-request and `main` workflows.
- [x] A `changes` job in `ci.yml` (`dorny/paths-filter`) with the outputs `app`, `js`, `extension`, `vscode`,
      `jetbrains`, `desktop`, `docs` and `dotnet`; `ci` (`.github/workflows/**`, `.github/actions/**`,
      `.node-version`) turns every other output on.
- [x] The four path-filtered suites are reusable workflows that `ci.yml` calls on `changes`; they keep
      `workflow_dispatch`.
- [x] A `CI result` job, the one required check of `ci.yml`: it runs unless the run was cancelled, and fails when a
      job it needs failed or was cancelled.
- [x] A docs build on pull requests that change `apps/docs/**`.
- [x] `pr-lint.yml`: `commitlint`, `title` and `actionlint`.
- [ ] Branch protection switched to `CI result`, `commitlint`, `title` and `actionlint`, or pull requests wait for
      check names that no longer exist.

### Phase 3: test matrices (built)

- [x] E2E on two backends for pull requests, `local + sqlite` (Node 22, the `engines` floor) and `s3 + postgres`, five
      shards each: 20 → 10 jobs. All four backends on `main`, from a matrix `changes` computes (`fromJSON`).
- [x] Extension E2E in three shards by file (`fullyParallel: false` stays), and `retries: 1` on CI.
      `replay.spec.ts` (5.1 minutes) bounds the longest shard; split it if the suite becomes the longest path.
- [x] Desktop E2E stages the `build-output` artifact of `ci.yml`'s `build` job: no macOS build, no root `npm ci`, no
      `--max-old-space-size` workaround.
- [x] JetBrains: `verify` on the oldest and newest IDE (`WS:2024.1`, `WS:2026.2.3`) for pull requests, all four on
      `main`, where the `plugin` job writes the Gradle cache. The `verify` IDEs stay out of the cache: four
      distributions would take a large share of the 10 GB and evict the rest.
- [x] `checks` in two parallel jobs (lint, typecheck and package tests; application and reporter unit tests with
      coverage): 7.3 → about 4.5 minutes. Only if `checks` becomes the longest path once the items above have landed.
      Built 2026-10-30 as four jobs, once `checks` took 12 to 16 minutes, the longest path: `Format, lint and
      typecheck`, `Dashboard unit tests`, `Reporter tests` and `Package tests`.
- [x] Package smoke: Linux on pull requests; Windows and macOS on `main`, and on pull requests that change the
      packages, `scripts/package-smoke.mjs` or the dependencies.

### Phase 4: releases and the `edge` image (built)

- [x] `release.yml` on `push: tags: v*`, `workflow_dispatch` (one input per target) and pull requests that change a
      release workflow (a dry run): one `build-server` job (`NITRO_PRESET=node-server`) whose artifact feeds both the
      npm server package and the four desktop builds, then a call to each `reusable-publish-*.yml` with
      `secrets: inherit`. Off a tag, it builds and packs without publishing.
- [x] `reusable-publish-npm.yml` publishes reporter, server and the Nitro instrumentation.
- [x] The `edge` image on every push to `main` (`edge.yml`).
- [x] `CONTRIBUTING.md` (the targets to re-run by hand) and the comment in `release-please.yml`.

### Phase 5: documentation (built with phases 2 to 4)

- [x] `.github/AGENTS.md` with the conventions above, in the area-guide table of the root `AGENTS.md`.
- [x] The workflow and job names quoted in `AGENTS.md` (`package-smoke`), `CONTRIBUTING.md` and the extension,
      JetBrains and desktop guides.

## What to expect

| Measure                                    | Before   | After phases 1 to 3         |
| ------------------------------------------ | -------- | --------------------------- |
| `ci` jobs for an application pull request  | 27       | ~17                         |
| `ci` runner minutes for a pull request     | ~80      | ~50                         |
| Wall-clock time of a pull request (median) | 12.3 min | ~8 min                      |
| Runner minutes per merge to `main`         | ~210     | ~90 (D2, option A)          |
| Runner minutes over the 15-hour window     | ~4,100   | ~2,100 to 2,300             |

The "after" column is computed from the measured job durations, to be confirmed by measuring after each phase.

## Decisions

- **D1. One required check, `CI result`** (recommended). Branch protection changes the day phase 2 merges.
  Decided: built in phase 2.
  Alternative: keep today's checks and gate with job-level `if` only.
- **D2. Where the four-backend matrix runs.** Decided: A.
  - A (recommended): pull requests on two backends, pushes to `main` on four. A regression only a crossed pair shows
    is seen right after the merge.
  - B: pull requests and `main` on two, all four nightly. Cheaper; seen up to a day later.
  - C: a merge queue (`merge_group`): the full matrix runs once on the merge result, before the merge, and `ci` on
    `main` only seeds the caches. The most thorough; it changes how pull requests are merged.
- **D3. The `edge` image**: on every push to `main` (about 7 runner minutes a merge) or nightly. Decided: on every
  push to `main`, a newer one cancelling a run still building.
- **D4. JetBrains `verify`**: two IDEs on pull requests and four on `main` or nightly, or four on pull requests that
  change `apps/jetbrains/**` and two when only `packages/editor` or `packages/core` changes. Decided: two on pull
  requests, four on `main`.
- **D5. Package smoke on Windows and macOS**: on every application pull request (today), or when the server or
  reporter package changes, and on `main`. Decided: when the packages or their dependencies change, and on `main`.

## Still to check

- **npm trusted publishing**: if npmjs.com trusts a workflow file for `@piwitests/reporter`, `@piwitests/server` or
  `@piwitests/instrumentation-nitro`, the file name is part of that setting and has to follow the rename. The
  workflows publish with `NPM_TOKEN`, so the setting matters only if token publishing is turned off. The same holds
  for NuGet (the job asks for `id-token: write`).
- **Cache usage** (`gh cache list --sort size_in_bytes`): whether the 10 GB limit already evicts the npm and Playwright
  caches. The Nuxt build cache (`nuxt-build-v2-…-<sha>`) is about 18 MB a run.
- **The Nuxt build cache's worth**: one build with it and one without (103 seconds measured with it). If it saves
  nothing, dropping it simplifies the `build` job.
