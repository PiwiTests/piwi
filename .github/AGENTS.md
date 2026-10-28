# CI workflows: agent instructions

Rules for `.github/`: the GitHub Actions workflows, the composite actions they share, and Dependabot. What each file
does, how `ci.yml` picks the jobs of a change, and what Dependabot updates: [`ARCHITECTURE.md`](ARCHITECTURE.md). The
design record these rules follow, with its measurements: [`adr/ci-workflows.md`](../adr/ci-workflows.md).

## Conventions

- **One required check.** A new check is a job of `ci.yml` (or a reusable workflow it calls) listed in the `needs` of
  `CI result`, never a separate required check. A job skipped by its `if` counts as passed, but a workflow its `paths`
  filter never started stays pending: gate jobs on `needs.changes.outputs.*`, not workflows on `paths`.
- **A job that runs on some events and not others is never a required check of the same name** in another run on the
  same commit: branch protection reads the latest run of a check. `pr-lint.yml` runs every job on every event for this
  reason.
- **Node through `setup-workspace`.** The version comes from the root `.node-version`. A job names another version only
  to test a floor (`engines`, Node 22) or a bundled runtime (the desktop's: the root `Dockerfile`'s Node, read by
  `apps/desktop/scripts/node-version.mjs`). `npm ci` runs with `--prefer-offline --no-audit --fund=false`.
- **Playwright's headless shell is cached by Playwright version** (`playwright: shell`), and saved as soon as it is
  installed, so the cache holds the shell alone. The full Chromium build (`playwright: full`) is installed on every run:
  the workflows that use it run on pull requests, where a cache serves its own pull request alone, or once a night
  (`nightly-showcase.yml`), where a cache would rarely outlive the night. The checks job
  also installs the full build, after the shell's cache is saved, for the reporter's breakpoint run under `xvfb-run`.
- **Least privilege.** `permissions: contents: read` at the top of every workflow, anything more on the job that needs
  it. A job that calls a reusable workflow grants the permissions its jobs ask for: a called job asking for more fails
  the run. `id-token: write` only where a step uses it (npm provenance).
- **Publish only from a release tag.** A publishing step runs when `github.ref` is a `v*` tag (`TAG_BUILD`), or `main`
  for the `edge` image. Anywhere else the workflow builds and packs, so a pull request can run it.
- **Publishing secrets reach a release tag only.** A `reusable-publish-*.yml` declares the secrets it uses
  (`on.workflow_call.secrets`), and `release.yml` passes each one only when `github.ref` is a `v*` tag, never through
  `secrets: inherit`: a pull request's dry run gets none. A step that runs project code with a signing key (the
  JetBrains `signPlugin`, the Tauri updater key) runs on a tag only. The publishing jobs of a tag run in the `release`
  environment (`environment: ${{ startsWith(github.ref, 'refs/tags/v') && 'release' || '' }}`), whose protection rules
  and secrets are set in the repository settings.
- **`.github/` is owned by its maintainer** (`CODEOWNERS`): a change here needs their review.
- **The GHCR image name is fixed.** It is `ghcr.io/piwitests/platform` (`REGISTRY` and `IMAGE_NAME` in
  `reusable-publish-container.yml`), never derived from `github.repository`: users pull it by that name, and a registry
  does not redirect when the repository is renamed.
- **A release becomes GitHub's latest only once its installers are attached.** The desktop updater reads its manifests
  from `releases/latest/download/`, and the download links open `releases/latest`. `release-please.yml` marks the
  previous release the latest again as soon as it creates one, and the `latest` job of `reusable-publish-desktop.yml`
  marks the new one once every leg has uploaded, when its tag is the newest. tauri-action gets the release's id, never
  its tag: given a tag, it rewrites the release's name and empties its body.
- **The bundled server fits Windows' MAX_PATH.** The installers fail on a file whose installed path is longer than 259
  characters, so `ci.yml`'s `build` job runs `apps/desktop/scripts/check-path-lengths.mjs` on the server it builds. The
  usual cause is a dependency installed in two versions, one nested under the other.
- **The editor extensions' changelogs are written at publish time, never committed.** `scripts/ide-changelog.mjs`
  derives them from the `ide` entries of the root `CHANGELOG.md`, which it reads and never rewrites (how each publish
  workflow uses it: [`ARCHITECTURE.md`](ARCHITECTURE.md#editor-extension-changelogs)).
- **Bounded.** `timeout-minutes` on every job, about three times its usual duration.
- **Actions pinned by commit.** Every `uses:` of an action outside this repository names the full commit SHA of a
  release, with its tag in a trailing comment: `uses: actions/checkout@<sha> # v7.0.1`. Dependabot moves the two
  together. Resolve a SHA with `git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag>` (the `^{}` line of an
  annotated tag). An action followed by branch, such as `dtolnay/rust-toolchain`, is pinned to that branch's commit,
  with its inputs named.
- **Readable.** A `name` on every step, and a `name:` on every workflow that says what it does.
- **Superseded pull-request runs cancelled.** A workflow that runs on pull requests has
  `concurrency: { group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}, cancel-in-progress: true }`
  (`release.yml` cancels its pull-request runs only, never a tag's). A reusable workflow has none: there
  `github.workflow` is the caller's name, so its group would collide with the caller's and cancel the run.
- **Artifacts expire.** An explicit `retention-days` on every artifact: 1 day for the ones jobs hand to each other, 3
  for `release.yml`'s server bundle, which **Re-run failed jobs** needs in the following days.
- **Comments state the rule** the workflow follows, as everywhere in the repository (see the root `AGENTS.md`).

## Checking a change

- Run `actionlint` before pushing (`pr-lint.yml` runs it on every pull request):
  `docker run --rm -v "$PWD:/repo" -w /repo -e SHELLCHECK_OPTS=--severity=warning rhysd/actionlint:1.7.12 -color`.
  It runs shellcheck on the `run` scripts, at the warning level.
- A change under `.github/workflows/` or `.github/actions/` runs every job of `ci.yml` on its pull request, which
  exercises it. A change to `release.yml` or a `reusable-publish-*.yml` also runs `release.yml` on its pull request:
  every target builds and packs, and nothing is published.
- **The other workflows never run on a pull request** (`docs.yml`, `edge.yml`, `release-please.yml`,
  `release-notes.yml`, `live-jira.yml`, `nightly-vscode.yml`, `nightly-showcase.yml`): actionlint is the only check a
  change to them gets before it merges.
