# CI workflows: agent instructions

Area guide for `.github/`: the GitHub Actions workflows, the composite action they share, and Dependabot. The plan
these follow, with its measurements and the phases still open, is
[`proposals/ci-workflows.md`](../proposals/ci-workflows.md).

## Layout

| File                                       | Runs on                         | Does                                                                                     |
| ------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `workflows/ci.yml`                         | pull requests, pushes to `main` | every check, behind the one required check `CI result`                                   |
| `workflows/reusable-e2e-extension.yml`     | called by `ci.yml`, on demand   | the browser extension's E2E suite, in 3 shards                                           |
| `workflows/reusable-e2e-vscode.yml`        | called by `ci.yml`, on demand   | the VS Code extension's integration suite                                                |
| `workflows/reusable-jetbrains.yml`         | called by `ci.yml`, on demand   | the JetBrains plugin's tests, build and Plugin Verifier runs (2 IDEs on PRs, 4 on main)  |
| `workflows/reusable-e2e-desktop.yml`       | called by `ci.yml`, on demand   | the desktop shell's Rust tests and E2E smoke test, on macOS, from `ci.yml`'s build       |
| `workflows/reusable-perf.yml`              | called by `ci.yml`              | the performance suite on the pull request's build and its base commit's, as a PR comment |
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
| `actions/setup-workspace/action.yml`       | used by the workflows above     | Node, the npm cache, `npm ci`, and Playwright's Chromium when asked                      |
| `actions/container-health/action.yml`      | `ci.yml`, the container publish | starts a server image on an empty data folder and waits for `/api/health`                |

`ci.yml`'s `changes` job reads which areas a change touches (`dorny/paths-filter`) and each job runs for the areas it
covers; a change to `.github/workflows/`, `.github/actions/` or `.node-version` runs them all. It also picks the
matrices: a pull request runs the dashboard E2E suite on two backends (`local + sqlite` on Node 22, `s3 + postgres`)
and the package smoke test on Linux (on Windows and macOS too when it changes the packages or their dependencies);
`main` runs the four backends and the three systems. The JetBrains Plugin Verifier runs on two IDEs for a pull request
and on four on `main`, where the plugin job also writes the Gradle cache. The extension, VS Code and desktop suites run
on pull requests only, and so do the container image check (the publish workflow runs it on `main` and on a tag) and
the performance comparison, which builds the base commit once (cached by its sha)
and reports a regression in its comment without failing. The release PR runs the `Versions` job alone.

## Conventions

- **One required check.** A new check is a job of `ci.yml` (or a reusable workflow it calls) listed in the `needs` of
  `CI result`, never a separate required check. A job skipped by its `if` counts as passed; a workflow its path filter
  never started stays pending, so gate jobs on `needs.changes.outputs.*`, not workflows on `paths`.
- **A job that runs on some events and not others is never a required check of the same name** in another run on the
  same commit: the latest run of a check is the one branch protection reads. `pr-lint.yml` runs every job on every
  event for this reason.
- **Node through `setup-workspace`.** The version comes from the root `.node-version`; a job names another only to test
  a floor (`engines`, Node 22) or a bundled runtime (the desktop's `24.22.0`). `npm ci` runs with
  `--prefer-offline --no-audit --fund=false`.
- **Playwright's headless shell is cached by Playwright version** (`playwright: shell`). The full Chromium build
  (`playwright: full`) is installed on every run: its workflows run on pull requests only, where a cache serves its own
  pull request alone.
- **Least privilege.** `permissions: contents: read` on every workflow; anything more on the job that needs it. A job
  that calls a reusable workflow grants the permissions its jobs ask for: a called job asking for more fails the run.
- **Publishing only from a release tag.** A publishing step runs when `github.ref` is a `v*` tag (`TAG_BUILD`), or
  `main` for the `edge` image; anywhere else the workflow builds and packs, so a pull request can run it.
- **Publishing secrets reach a release tag only.** A `reusable-publish-*.yml` declares the secrets it uses
  (`on.workflow_call.secrets`), and `release.yml` passes each one only when `github.ref` is a `v*` tag, never
  `secrets: inherit`: a pull request's dry run gets none. A step that runs project code with a signing key (the
  JetBrains `signPlugin`, the Tauri updater key) runs on a tag only. The publishing jobs of a tag run in the
  `release` environment (`environment: ${{ startsWith(github.ref, 'refs/tags/v') && 'release' || '' }}`), whose
  protection rules and secrets are set in the repository settings. `id-token: write` only where a step uses it (npm
  provenance). `.github/` is owned by its maintainer (`CODEOWNERS`).
- **Bounded.** `timeout-minutes` on every job, about three times its usual duration.
- **Readable.** A `name` on every step, and a `name:` on every workflow that says what it does.
- **Superseded runs cancelled.** Every pull-request workflow has
  `concurrency: { group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}, cancel-in-progress: true }`.
  A reusable workflow has none: there `github.workflow` is the caller's name, so its group would collide with the
  caller's and cancel the run.
- **Artifacts expire.** An explicit `retention-days` on every artifact: 1 day for the ones jobs hand to each other.
- **Comments state the rule** the workflow follows, as everywhere in the repository (see the root `AGENTS.md`).

## Checking a change

- Run `actionlint` before pushing (`pr-lint.yml` runs it on every pull request):
  `docker run --rm -v "$PWD:/repo" -w /repo -e SHELLCHECK_OPTS=--severity=warning rhysd/actionlint:1.7.12 -color`.
  It runs shellcheck on the `run` scripts, at the warning level.
- A change under `.github/workflows/` or `.github/actions/` runs every suite on its pull request, which exercises it.
  A change to `release.yml` or a `reusable-publish-*.yml` also runs `release.yml` on its pull request: every target
  builds and packs, and nothing is published.
- Dependabot updates the actions of the workflows and of `.github/actions/*`.
