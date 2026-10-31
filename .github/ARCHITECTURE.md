# CI workflows: architecture

What each file of `.github/` does and how the workflows fit together. The rules for changing them are in
[`AGENTS.md`](AGENTS.md); the design record, with its measurements, is [`adr/ci-workflows.md`](../adr/ci-workflows.md).
The release process, seen from a maintainer, is in [`CONTRIBUTING.md`](../CONTRIBUTING.md#releases).

## Layout

| File                                       | Runs on                                      | Does                                                                                                         |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `workflows/ci.yml`                         | pull requests, pushes to `main`              | every check, behind the one required check `CI result`                                                       |
| `workflows/reusable-e2e-extension.yml`     | called by `ci.yml`, on demand                | the browser extension's E2E suite, in 3 shards                                                               |
| `workflows/reusable-e2e-vscode.yml`        | called by `ci.yml`, on demand                | the VS Code extension's integration suite                                                                    |
| `workflows/reusable-jetbrains.yml`         | called by `ci.yml`, on demand                | the JetBrains plugin's tests, build and Plugin Verifier runs (2 IDEs on PRs, 4 on `main` and on demand)      |
| `workflows/reusable-e2e-desktop.yml`       | called by `ci.yml`, on demand                | the desktop shell's Rust tests and E2E smoke test, on macOS, from `ci.yml`'s build                           |
| `workflows/reusable-perf.yml`              | called by `ci.yml`                           | the performance suite on the pull request's build and its base commit's, reported as a PR comment            |
| `workflows/pr-lint.yml`                    | pull requests                                | `commitlint` (every commit), `title` (the PR title) and `actionlint`                                         |
| `workflows/docs.yml`                       | pushes to `main` that change them, on demand | builds the docs and the demo and deploys them to GitHub Pages                                                |
| `workflows/release-please.yml`             | pushes to `main`                             | the release PR, and the tag once it merges; the previous release stays GitHub's latest                       |
| `workflows/release.yml`                    | release tags, on demand, PRs                 | every publication, through the `reusable-publish-*.yml` below; a PR run publishes none                       |
| `workflows/reusable-publish-npm.yml`       | called by `release.yml`                      | `@piwitests/reporter`, `@piwitests/server` (from the shared build), `@piwitests/instrumentation-nitro`       |
| `workflows/reusable-publish-container.yml` | called by `release.yml`, `edge.yml`          | the multi-arch server image (see [The container image](#the-container-image))                                |
| `workflows/reusable-publish-nuget.yml`     | called by `release.yml`                      | the instrumentation NuGet packages                                                                           |
| `workflows/reusable-publish-desktop.yml`   | called by `release.yml`                      | the desktop installers, from the shared build, attached to the GitHub release, which then becomes the latest |
| `workflows/reusable-publish-vscode.yml`    | called by `release.yml`                      | the VS Code extension (Visual Studio Marketplace, Open VSX)                                                  |
| `workflows/reusable-publish-jetbrains.yml` | called by `release.yml`                      | the JetBrains plugin (JetBrains Marketplace)                                                                 |
| `workflows/reusable-publish-extension.yml` | called by `release.yml`                      | the browser extension (Chrome, Edge, Firefox)                                                                |
| `workflows/edge.yml`                       | pushes to `main`                             | the `edge` container image                                                                                   |
| `workflows/release-notes.yml`              | published releases, on demand                | tidies the release body from the version's `CHANGELOG.md` section (`scripts/release-notes.mjs`)              |
| `workflows/live-jira.yml`                  | on demand                                    | the live Jira E2E, against a real Atlassian Cloud site                                                       |
| `workflows/nightly-vscode.yml`             | every night, on demand                       | the VS Code extension in the real VS Code (`apps/vscode/tests/e2e`), at the pinned release                   |
| `workflows/nightly-showcase.yml`           | every night, on demand                       | the showcase's story in check mode (`apps/showcase`); with `film`, filmed and cut, the cut uploaded          |
| `actions/setup-workspace/action.yml`       | the workflows above                          | Node, the npm cache, `npm ci`, and Playwright's Chromium when asked                                          |
| `actions/container-health/action.yml`      | `ci.yml`, `reusable-publish-container.yml`   | starts a server image on an empty data folder and waits for `/api/health`                                    |

## How `ci.yml` picks the jobs of a change

- The `changes` job reads which areas a change touches (`dorny/paths-filter`), and each job runs for the areas it
  covers. A change to `.github/workflows/`, `.github/actions/` or `.node-version` runs them all.
- A change to a JavaScript workspace (`js`) runs the five check jobs at once:
  - `Format, lint and typecheck`: oxfmt, oxlint and the type check of every workspace, then knip;
  - `Dashboard unit tests`, with the coverage comment;
  - `Reporter tests`, under `xvfb-run`, then the AI steps' integration run, with the coverage comment;
  - `Reporter tests (Playwright floor)`: the same suite on the oldest Playwright the reporter supports
    (`scripts/playwright-floor.mjs --install`), where a spec that needs a later version skips itself;
  - `Package tests`: core, picker-dom (unit and in a browser), the editor service, the VS Code and browser extensions'
    unit tests, and the showcase's cut.
- The agent guides' test (`apps/application/tests/unit/agent-guides.test.ts`) runs in `Dashboard unit tests` with
  every unit test; a change that touches only guides (`AGENTS.md`, `ARCHITECTURE.md`, `CLAUDE.md`), `adr/`,
  `proposals/` or a file the guides link to outside the `js` paths (the root Markdown files,
  `release-please-config.json`, `apps/desktop/README.md`) runs it alone in the `Agent guides` job.
- The release PR (a `release-please--` branch) runs the `Versions` job alone. The other jobs run on `main` once it
  merges.
- `changes` also picks two matrices:
  - the dashboard E2E suite, five shards per backend: two backends on a pull request (`local + sqlite` on Node 22, and
    `s3 + postgres`), all four on `main`;
  - the package smoke test: Linux on a pull request, plus Windows, macOS and a Linux leg on the reporter's Playwright
    floor when it changes the packages or their dependencies, and all four on `main`.
- The JetBrains Plugin Verifier runs on two IDEs for a pull request and on four on `main`, where the plugin job also
  writes the Gradle cache.
- Some jobs run on pull requests only: the extension, VS Code and desktop suites, the docs build, the container image
  check (the publish workflow runs the same check on `main` and on a tag) and the performance comparison.

## The performance comparison

- It measures the pull request's build against its base commit's build. The `build` job caches that build by its sha
  when it runs on `main`. When the base commit has none, the `perf-base` job builds it alongside the pull request's own
  build, cached for the pull request's runs only.
- The pages are split across two `measure` jobs that run at once. Each measures both builds on its own pages, so every
  comparison is made on one machine. A `report` job joins their results into the comment.
- A regression is reported in the comment without failing the job: the jobs fail only when the suite cannot run.

## The container image

- On a release tag, `reusable-publish-container.yml` pushes the version tag to GHCR and Docker Hub. It moves the minor,
  major and `latest` tags only when the release is the newest of its line, so publishing an older tag again never moves
  them back.
- On `main` it pushes `edge` to GHCR (`edge.yml`). Anywhere else it builds both architectures and pushes nothing.
- The linux/amd64 image is started on an empty data folder and must answer `/api/health` (`container-health`) before
  any tag moves.

## Editor extension changelogs

`scripts/ide-changelog.mjs` keeps the `ide` entries of the root `CHANGELOG.md`, under their version and section:

- `reusable-publish-vscode.yml` writes every version's entries as `apps/vscode/CHANGELOG.md` before `vsce package`. The
  file is gitignored, and `.vscodeignore` lets it into the VSIX (the Marketplace's Changelog tab).
- `reusable-publish-jetbrains.yml` writes the release's entries as HTML into `CHANGE_NOTES` before its first Gradle run.
  `build.gradle.kts` reads it as the plugin's change notes (the Marketplace's "What's new").

## Dependabot

`dependabot.yml` checks every week for updates to:

- the actions of the workflows and of `.github/actions/*`: the commit SHA and the version comment together;
- the npm lockfiles: the root's (every workspace), `apps/desktop`'s and `apps/docs`'s;
- the desktop shell's crates and the JetBrains plugin's Gradle dependencies;
- the .NET packages, within their major;
- the `Dockerfile`'s base image, whose tag and digest move together. Its Node version is also the one the desktop app
  bundles, so this update moves both.
