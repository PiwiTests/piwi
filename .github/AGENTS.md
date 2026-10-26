# CI workflows: agent instructions

Area guide for `.github/`: the GitHub Actions workflows, the composite action they share, and Dependabot. The design
record these follow, with its measurements, is [`adr/ci-workflows.md`](../adr/ci-workflows.md).

## Layout

| File                                       | Runs on                         | Does                                                                                     |
| ------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `workflows/ci.yml`                         | pull requests, pushes to `main` | every check, behind the one required check `CI result`                                   |
| `workflows/reusable-e2e-extension.yml`     | called by `ci.yml`, on demand   | the browser extension's E2E suite, in 3 shards                                           |
| `workflows/reusable-e2e-vscode.yml`        | called by `ci.yml`, on demand   | the VS Code extension's integration suite                                                |
| `workflows/reusable-jetbrains.yml`         | called by `ci.yml`, on demand   | the JetBrains plugin's tests, build and Plugin Verifier runs (2 IDEs on PRs, 4 on main)  |
| `workflows/reusable-e2e-desktop.yml`       | called by `ci.yml`, on demand   | the desktop shell's Rust tests and E2E smoke test, on macOS, from `ci.yml`'s build       |
| `workflows/reusable-perf.yml`              | called by `ci.yml`              | the performance suite on the pull request's build and its base commit's, its pages split across 2 machines, as a PR comment |
| `workflows/pr-lint.yml`                    | pull requests                   | `commitlint`, `title` (the PR title) and `actionlint`                                    |
| `workflows/docs.yml`                       | pushes to `main`                | builds and deploys the docs and the demo                                                 |
| `workflows/release-please.yml`             | pushes to `main`                | the release PR, and the tag once it merges                                               |
| `workflows/release.yml`                    | release tags, on demand, PRs    | every publication, through the `reusable-publish-*.yml` below; a PR run publishes none   |
| `workflows/reusable-publish-npm.yml`       | called by `release.yml`         | `@piwitests/reporter`, `@piwitests/server` (from the shared build), `instrumentation-nitro` |
| `workflows/reusable-publish-container.yml` | called by `release.yml`, `edge.yml` | the multi-arch image: version tags on a tag (minor, major and `latest` for the newest release of each line only), `edge` on main, a build only elsewhere; the amd64 image answers `/api/health` before a tag moves |
| `workflows/reusable-publish-nuget.yml`     | called by `release.yml`         | the instrumentation NuGet packages                                                       |
| `workflows/reusable-publish-desktop.yml`   | called by `release.yml`         | the desktop installers, from the shared build, attached to the GitHub release            |
| `workflows/reusable-publish-vscode.yml`    | called by `release.yml`         | the VS Code extension (Marketplace, Open VSX)                                            |
| `workflows/reusable-publish-jetbrains.yml` | called by `release.yml`         | the JetBrains plugin (JetBrains Marketplace)                                             |
| `workflows/reusable-publish-extension.yml` | called by `release.yml`         | the browser extension (Chrome, Edge, Firefox)                                            |
| `workflows/edge.yml`                       | pushes to `main`                | the `edge` container image                                                               |
| `workflows/release-notes.yml`              | releases, on demand             | tidies the release notes                                                                 |
| `workflows/live-jira.yml`                  | on demand                       | the live Jira E2E                                                                        |
| `workflows/nightly-vscode.yml`             | every night, on demand          | the VS Code extension in the real VS Code (`apps/vscode/tests/e2e`), at the pinned release |
| `actions/setup-workspace/action.yml`       | used by the workflows above     | Node, the npm cache, `npm ci`, and Playwright's Chromium when asked                      |
| `actions/container-health/action.yml`      | `ci.yml`, the container publish | starts a server image on an empty data folder and waits for `/api/health`                |

`ci.yml`'s `changes` job reads which areas a change touches (`dorny/paths-filter`) and each job runs for the areas it
covers; a change to `.github/workflows/`, `.github/actions/` or `.node-version` runs them all. It also picks the
matrices: a pull request runs the dashboard E2E suite on two backends (`local + sqlite` on Node 22, `s3 + postgres`)
and the package smoke test on Linux (on Windows and macOS too when it changes the packages or their dependencies);
`main` runs the four backends and the three systems. The JetBrains Plugin Verifier runs on two IDEs for a pull request
and on four on `main`, where the plugin job also writes the Gradle cache. The extension, VS Code and desktop suites run
on pull requests only, and so do the container image check (the publish workflow runs it on `main` and on a tag) and
the performance comparison, which measures against the base commit's build that the
`build` job cached by its sha when it ran on `main` (when that commit has none, the `perf-base` job builds it alongside
the pull request's own build, cached for the pull request's runs only) and reports a regression in its comment without
failing. Its pages are split across two `measure` jobs that run at once, each measuring both builds on its own pages so
every comparison is made on one machine; a `report` job joins their results into the comment. The release PR runs the `Versions` job alone.

## Conventions

- **One required check.** A new check is a job of `ci.yml` (or a reusable workflow it calls) listed in the `needs` of
  `CI result`, never a separate required check. A job skipped by its `if` counts as passed; a workflow its path filter
  never started stays pending, so gate jobs on `needs.changes.outputs.*`, not workflows on `paths`.
- **A job that runs on some events and not others is never a required check of the same name** in another run on the
  same commit: the latest run of a check is the one branch protection reads. `pr-lint.yml` runs every job on every
  event for this reason.
- **Node through `setup-workspace`.** The version comes from the root `.node-version`; a job names another only to test
  a floor (`engines`, Node 22) or a bundled runtime (the desktop's, the root `Dockerfile`'s Node version, read by
  `apps/desktop/scripts/node-version.mjs`). `npm ci` runs with
  `--prefer-offline --no-audit --fund=false`.
- **Playwright's headless shell is cached by Playwright version** (`playwright: shell`), saved as soon as it is
  installed, so the cache holds the shell alone. The full Chromium build (`playwright: full`) is installed on every
  run: its workflows run on pull requests only, where a cache serves its own pull request alone. The checks job
  installs it too, beside the shell and after the cache is saved, for the reporter's breakpoint run, which opens
  Chromium's windows under `xvfb-run`.
- **Least privilege.** `permissions: contents: read` on every workflow; anything more on the job that needs it. A job
  that calls a reusable workflow grants the permissions its jobs ask for: a called job asking for more fails the run.
- **Publishing only from a release tag.** A publishing step runs when `github.ref` is a `v*` tag (`TAG_BUILD`), or
  `main` for the `edge` image; anywhere else the workflow builds and packs, so a pull request can run it.
- **The GHCR image name is fixed.** It is `ghcr.io/piwitests/platform` (`IMAGE_NAME` in
  `reusable-publish-container.yml`), never derived from `github.repository`: users pull it by that name, and a
  registry does not redirect when the repository is renamed.
- **Publishing secrets reach a release tag only.** A `reusable-publish-*.yml` declares the secrets it uses
  (`on.workflow_call.secrets`), and `release.yml` passes each one only when `github.ref` is a `v*` tag, never
  `secrets: inherit`: a pull request's dry run gets none. A step that runs project code with a signing key (the
  JetBrains `signPlugin`, the Tauri updater key) runs on a tag only. The publishing jobs of a tag run in the
  `release` environment (`environment: ${{ startsWith(github.ref, 'refs/tags/v') && 'release' || '' }}`), whose
  protection rules and secrets are set in the repository settings. `id-token: write` only where a step uses it (npm
  provenance). `.github/` is owned by its maintainer (`CODEOWNERS`).
- **The editor extensions' changelogs are written at publish time.** `scripts/ide-changelog.mjs` keeps the `ide`
  entries of the root `CHANGELOG.md`, under their version and section: `reusable-publish-vscode.yml` writes every
  version's as `apps/vscode/CHANGELOG.md` (gitignored; `.vscodeignore` lets it into the VSIX) before `vsce package`,
  and `reusable-publish-jetbrains.yml` writes the release's as HTML into `CHANGE_NOTES`, which `build.gradle.kts`
  reads as the plugin's change notes, before its first Gradle run. Nothing generated is committed, and what
  release-please writes is left as it is.
- **Bounded.** `timeout-minutes` on every job, about three times its usual duration.
- **Actions pinned by commit.** Every `uses:` of an action outside this repository names the full commit SHA of a
  release, with its tag in a trailing comment: `uses: actions/checkout@<sha> # v7.0.1`. Resolve it with
  `git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag>` (the `^{}` line of an annotated tag). An action
  followed by branch, such as `dtolnay/rust-toolchain`, is pinned to that branch's commit, with its inputs named.
- **Readable.** A `name` on every step, and a `name:` on every workflow that says what it does.
- **Superseded runs cancelled.** Every pull-request workflow has
  `concurrency: { group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}, cancel-in-progress: true }`.
  A reusable workflow has none: there `github.workflow` is the caller's name, so its group would collide with the
  caller's and cancel the run.
- **Artifacts expire.** An explicit `retention-days` on every artifact: 1 day for the ones jobs hand to each other.
- **Comments state the rule** the workflow follows, as everywhere in the repository (see the root `AGENTS.md`).

## Checking a change

- Run `actionlint` before pushing (`pr-lint.yml` runs it on every pull request), from the repository root:
  `docker run --rm -v "$PWD:/repo" -w /repo -e SHELLCHECK_OPTS=--severity=warning rhysd/actionlint:1.7.12 -color`.
  It runs shellcheck on the `run` scripts, at the warning level. A cloud session has no Docker daemon: its
  session-start hook installs the same actionlint and shellcheck, so run
  `SHELLCHECK_OPTS=--severity=warning actionlint -color` there.
- A change under `.github/workflows/` or `.github/actions/` runs every suite on its pull request, which exercises it.
  A change to `release.yml` or a `reusable-publish-*.yml` also runs `release.yml` on its pull request: every target
  builds and packs, and nothing is published.
- Dependabot updates the actions of the workflows and of `.github/actions/*`: the commit SHA and the version comment
  together. It also updates the npm lockfiles (the root's, `apps/desktop`'s and `apps/docs`'s), the desktop shell's
  crates, the JetBrains plugin's Gradle dependencies, the .NET packages (within their major) and the Dockerfile's base
  image, whose tag and digest move together.
