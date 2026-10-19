# Contributing

Thanks for your interest in improving Piwi Dashboard! This file covers dev setup, tests, and commit/PR conventions. See [AGENTS.md](AGENTS.md) for architecture, project structure, and the full development guide.

## Getting set up

Prerequisites: **Node.js 24+**, npm, Git.

```bash
git clone https://github.com/PiwiTests/platform.git
cd platform/apps/application
npm install
npm run app:dev      # dashboard at http://localhost:3000
```

The SQLite database and `.data/` storage are created automatically on first API call — no configuration needed. To hack on the reporter package instead, work in `packages/reporter/` (`npm run reporter:build`, or `npm run reporter:dev` for watch mode).

## Quality checks & tests

Run from `apps/application/` unless noted:

| Command | What it does |
|---|---|
| `npm run app:lint` | Lint (oxlint) |
| `npm run app:typecheck` | TypeScript check |
| `npm run app:format:check` | Formatting (oxfmt) |
| `npm run app:test:unit` | Unit tests (Vitest) |
| `npm run app:test` | E2E tests (Playwright — needs browsers: `npx playwright install chromium`) |
| `npm test` | Everything (unit first, then E2E) |
| `npm run reporter:test` | Reporter unit tests (from `packages/reporter/`) |

If an E2E test creates a project, use a static name registered in `apps/application/shared/test-project-names.ts` (see the conventions in [AGENTS.md](AGENTS.md)).

## Database & demo data

| Command | What it does |
|---|---|
| `npm run db:generate` | Generate a SQLite migration from schema changes |
| `npm run db:generate:pg` | Generate a PostgreSQL migration from schema changes |
| `npm run db:studio` | Browse the SQLite database in Drizzle Studio |
| `npm run db:studio:pg` | Browse the PostgreSQL database in Drizzle Studio |
| `npm run app:seed:demo` | Regenerate the demo seed data used by the live demo |

**Migration workflow:** edit `server/database/schema.sqlite.ts` (and `schema.pg.ts` for the PostgreSQL equivalent — `schema.ts` is just a dialect-selecting re-export, don't edit it) → run `npm run db:generate` (SQLite) or `npm run db:generate:pg` (PostgreSQL) → review the generated `.sql` file → restart the app. Never create migration files or edit `meta/_journal.json` by hand — the Drizzle migrator depends on the journal to track which migrations have been applied, and manual entries cause it to silently skip the migration.

## What to work on

- Check [open issues](https://github.com/PiwiTests/platform/issues) and the [roadmap](ROADMAP.md).
- For anything non-trivial, open an issue or a [Discussion](https://github.com/PiwiTests/platform/discussions) first so we can agree on the approach before you invest time.
- Security problems: follow [SECURITY.md](SECURITY.md) — please don't open public issues for those.

## License of your contribution

The repository is licensed in two parts (see [LICENSE](LICENSE)): `packages/reporter`, `packages/core`, `packages/picker-dom`, `integrations/` and `examples/` are MIT; everything else is FSL-1.1-MIT. By opening a pull request, you agree that your contribution is licensed under the license of the directory it changes.

## Commit messages & PR titles

This repo uses [Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint (locally and in CI) and a PR-title check. [release-please](https://github.com/googleapis/release-please) reads commit history to compute version bumps and generate the changelog, so following this format isn't just style — it's what makes releases work.

Because PRs are squash-merged, **the PR title becomes the commit message on `main`** — that's what release-please actually reads. Give the PR itself a Conventional Commit title; individual commits within the PR are not required to follow the format, though it's good practice.

### Format

```
type(scope): subject
```

- `type` — required, one of the types below
- `scope` — optional but encouraged, one of the scopes below
- `subject` — required, lowercase, no trailing period, imperative mood ("add", not "added"/"adds")

### Types → release bump

| Type | Bump | Appears in changelog |
|---|---|---|
| `feat:` | **minor** (0.x.0) | 🚀 Features |
| `fix:` / `perf:` | **patch** (0.0.x) | 🐛 Fixes |
| `feat!:` / `fix!:` / body with `BREAKING CHANGE:` | **major**\* | ⚠ Breaking |
| `docs:` `chore:` `ci:` `refactor:` `test:` `build:` `style:` `revert:` | none | hidden |

\* Pre-1.0, breaking changes bump **minor** instead of major (`bump-minor-pre-major` in `release-please-config.json`).

### Scopes

`app`, `reporter`, `db`, `ui`, `demo`, `desktop`, `extension`, `ide`, `ci`, `docs`, `deps`, `auth`, `ai`,
`notifications`,
`release`

(`main` is also allowed, but only appears in release-please's own auto-generated `chore(main): release X.Y.Z` PRs — don't use it for your own commits.)

### Examples

```
feat(reporter): send reporter version with each test run
fix(db): correct null handling in flaky-test aggregation
docs: update configuration reference
ci: add commitlint workflow
feat(auth)!: require email verification before login

BREAKING CHANGE: unverified accounts can no longer sign in.
```

### Enforcement

1. **Local `commit-msg` hook** (husky + commitlint) — runs on every `git commit` after `npm install`. Bypassable with `--no-verify`; treat it as convenience, not a gate.
2. **`commitlint` check** (the `PR lint` workflow) — lints every commit in a PR's range on push.
3. **`title` check** (the `PR lint` workflow) — lints the PR title itself, since that's what becomes the squash-merge commit subject. This is the check that actually gates `main`.

## Releases

Merging a release-please PR (titled `chore(main): release X.Y.Z`) tags the release, and the tag starts `release.yml`, which publishes it. This requires one repository secret, **`RELEASE_PLEASE_TOKEN`** — without it, releases silently stop at the tag and `release.yml` never runs. `release-please.yml` writes the release PR, the tag and the release with it alone: it is a Personal Access Token (classic `repo` scope, or fine-grained with `Contents: read/write` + `Pull requests: read/write`) or a GitHub App installation token, added at `Settings → Secrets and variables → Actions`. This is required because GitHub's anti-recursion protection means a tag created with the default `GITHUB_TOKEN` does **not** trigger other `on: push: tags` workflows — `release.yml` would never run even though the tag exists. A PAT/App token isn't subject to that restriction.

The release PR runs one job of `ci.yml`, `Versions`: it installs the dependencies and runs `node scripts/check-release-versions.mjs`, which fails when a file release-please stamps (the root `package.json` and `package-lock.json`, and the `extra-files` of `release-please-config.json`) does not carry the release version. The other jobs skip the release PR and run on `main` once it merges. `Versions` runs the script on every pull request, so a stamped file whose version is edited by hand, or that loses its `x-release-please-version` marker, fails before a release.

`release.yml` builds the node-server bundle once and calls one reusable workflow per target: `reusable-publish-npm.yml` (`@piwitests/reporter`, `@piwitests/server`, `@piwitests/instrumentation-nitro`), `reusable-publish-container.yml` (GHCR and Docker Hub), `reusable-publish-nuget.yml`, `reusable-publish-desktop.yml` (the installers, attached to the GitHub release) and the three below. One target failing holds back none of the others, and **Re-run failed jobs** on the run retries only the failed ones. If a release's tag already exists but some targets never published (e.g. because this wasn't set up yet), run `release.yml` manually against that tag (**Run workflow**, the tag as the ref) with only those targets ticked. A pull request that changes a release workflow runs `release.yml` too: it builds and packs every target and publishes nothing.

The browser extension and the editor plugins keep their packages as the run's workflow artifacts (not release assets), each downloading as the file a store takes, so they can be uploaded by hand; then each publishes to every store whose secrets are set and skips the others:

| Workflow | Store | Secrets |
|---|---|---|
| `reusable-publish-extension.yml` | Chrome Web Store | `CHROME_PUBLISHER_ID`, `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN` |
| | Edge Add-ons | `EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY` |
| | Firefox Add-ons (AMO) | `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` |
| `reusable-publish-vscode.yml` | Visual Studio Marketplace | `VSCE_PAT` |
| | Open VSX | `OVSX_PAT` |
| `reusable-publish-jetbrains.yml` | JetBrains Marketplace | `JETBRAINS_PUBLISH_TOKEN`, plus `JETBRAINS_CERTIFICATE_CHAIN`, `JETBRAINS_PRIVATE_KEY` and `JETBRAINS_PRIVATE_KEY_PASSWORD` to sign the plugin (the artifact too) |

[`apps/extension/PUBLISHING.md`](apps/extension/PUBLISHING.md) §5 says where each extension credential comes from and what each store needs by hand first. Off a tag, these workflows only build the artifacts.

The container image of `main` is pushed to GHCR as `edge` by `edge.yml`, on every commit that lands there.
