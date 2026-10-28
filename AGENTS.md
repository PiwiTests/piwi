# Piwi: agent instructions

> **Note:** Piwi is **not affiliated with, endorsed by, or connected to Microsoft Corporation**. The project was
> originally called "Playwright Dashboard" and was renamed to avoid confusion with Microsoft's Playwright.

Root guide for any AI agent (Claude Code, opencode, Copilot, Cursor, …): what lives where, how to verify a change, and
the conventions that apply everywhere. Each area has its own guide next to its code: Claude Code loads it through the
`CLAUDE.md` beside it when you open a file there, and other agents read it before editing. A guide's table may send a
file outside its directory to another guide: read that one yourself, whatever the agent.

| Editing…                                                         | Read first                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `apps/application/`: the Nuxt dashboard (app, server, demo, MCP) | [`apps/application/AGENTS.md`](apps/application/AGENTS.md)   |
| `packages/reporter/`: the Playwright reporter package            | [`packages/reporter/AGENTS.md`](packages/reporter/AGENTS.md) |
| `apps/desktop/`: the Tauri desktop shell                         | [`apps/desktop/AGENTS.md`](apps/desktop/AGENTS.md)           |
| `apps/extension/`: the browser extension (Manifest V3)           | [`apps/extension/AGENTS.md`](apps/extension/AGENTS.md)       |
| `packages/editor/`: the editor service (language server)         | [`packages/editor/AGENTS.md`](packages/editor/AGENTS.md)     |
| `apps/vscode/`: the VS Code extension                            | [`apps/vscode/AGENTS.md`](apps/vscode/AGENTS.md)             |
| `apps/jetbrains/`: the JetBrains plugin (Gradle, Kotlin)         | [`apps/jetbrains/AGENTS.md`](apps/jetbrains/AGENTS.md)       |
| `apps/docs/`: the VitePress documentation site                   | [`apps/docs/AGENTS.md`](apps/docs/AGENTS.md)                 |
| `apps/showcase/`: the showcase's story, played on every tool     | [`apps/showcase/AGENTS.md`](apps/showcase/AGENTS.md)         |
| `.github/`: the CI workflows and the actions they share          | [`.github/AGENTS.md`](.github/AGENTS.md)                     |
| `proposals/`: design records for work proposed or being built    | [`proposals/AGENTS.md`](proposals/AGENTS.md)                 |
| `adr/`: architecture decision records for shipped work           | [`adr/AGENTS.md`](adr/AGENTS.md)                             |

The dashboard's guide lists the topic guides of its subsystems. An `ARCHITECTURE.md` beside a guide is the map of
that area (what exists and how it works): open it when you need to understand the code, not before every edit.

## Project overview

A test results dashboard for **Playwright**, built with **Nuxt 4** and **Nuxt UI**. It ingests test results from a custom
reporter, stores them (SQLite or PostgreSQL), and adds analysis on top: flaky detection, failure clustering, AI diagnosis,
locator healing, notifications and an MCP server for AI agents. Self-hosted only: no SaaS, no other test frameworks
(see [`ROADMAP.md`](ROADMAP.md) for direction and non-goals).

## Repository layout

```
apps/application/     Nuxt 4 dashboard: app (UI), server (API), demo SPA, MCP server; `shared/` imported as `#shared/...`
apps/desktop/         Tauri desktop shell that bundles and runs the same server locally
apps/extension/       Piwi Picker, the browser extension (Manifest V3), standalone
apps/vscode/          VS Code extension, a thin client of packages/editor (scope `ide`)
apps/jetbrains/       JetBrains plugin, the same client in Kotlin and Gradle (scope `ide`)
apps/docs/            VitePress documentation site, published to GitHub Pages
apps/showcase/        The showcase: one story on every tool together, checked nightly and filmed (not a workspace)
packages/core/        @piwitests/core: private, zero-dependency logic shared by the app and the reporter
packages/picker-dom/  @piwitests/picker-dom: the DOM picker overlay (reporter, dashboard, extension)
packages/reporter/    @piwitests/reporter: the Playwright reporter (bundled with tsup)
packages/editor/      @piwitests/editor: the language server both editor clients bundle (scope `ide`)
packages/server/      @piwitests/server: the published npm run option (`npx @piwitests/server`)
integrations/         Instrumentation adapters: nitro/ (npm), aspnetcore/ and serilog/ (NuGet, .NET tests, .slnx)
examples/sample-app/  One web app and its Playwright suite, served by each supported backend
shared/               Base oxlint/oxfmt configs extended by every workspace
plans/                The maintainer's local planning folder: gitignored, absent in a fresh clone
```

- **A new workspace goes where its kind is**: `apps/*` for a deployable surface, `packages/*` for a package consumed by
  name (published, or imported or bundled by another workspace), `integrations/*` for a framework adapter. Every JS
  workspace is listed in the root `package.json` `workspaces`. `apps/desktop`, `apps/docs` and `examples/sample-app`
  are **intentionally not workspaces** (own toolchains; the example must resolve `@piwitests/*` from npm), and
  `apps/showcase` is scripts run on the root's `node_modules`, read by knip from the root.
- **Adding a workspace takes two entries in [`release-please-config.json`](release-please-config.json)**: its
  `package.json` `$.version`, _and_ its `package-lock.json` `$.packages['<dir>'].version`. release-please bumps only
  the root package natively; a missing lockfile entry leaves the workspace a release behind and makes `npm install`
  rewrite the lockfile on every checkout.
- Design records live in [`proposals/`](proposals/) while their work is proposed or being built, and move to
  [`adr/`](adr/) once it has shipped. Public direction is [`ROADMAP.md`](ROADMAP.md). `plans/` is the maintainer's local
  planning folder (layout in the `plan-management` skill).

## Setup and repository-wide commands

Prerequisites: **Node.js 24+**, npm, Git. `npm ci` at the repository root installs every workspace (a Claude Code web
session runs it, builds the reporter and installs Chromium in `.claude/hooks/session-start.sh`). Each area guide lists
its own commands; the dashboard's run from `apps/application/` (`npm run app:dev`, http://localhost:7494, with no
configuration: the SQLite database and `.data/` are created on the first API call).

- `npm run knip` (root) lists unused files, exports, types and dependencies, and undeclared imports, across every JS
  workspace. A standalone entry point it cannot infer goes in [`knip.ts`](knip.ts). CI's checks job fails on a finding.
- `node scripts/package-smoke.mjs <dir>` installs the packed `@piwitests/server` and `@piwitests/reporter` tarballs into
  a new project and reports a run through them (the script header shows how to pack them); CI's `package-smoke` job.
- From `integrations/aspnetcore/`: `dotnet test PiwiTests.Instrumentation.slnx` (needs the .NET 10 SDK).

Run typecheck, lint, format check and the relevant tests **once at the end**, before the final commit, not after every
edit.

## Conventions that apply everywhere

### Code

- **Keep it simple.** This is a deliberately AI-friendly codebase: obvious code beats clever code.
- Full TypeScript; Nuxt 4 conventions and Nuxt UI components in the app.
- **American English** spelling throughout ("initialize", "organize", "color").
- **Extract a shared component/helper** when the same block exceeds ~10 lines and appears more than once.
- **One locator parser.** Playwright locator expressions (`getByRole('form').getByLabel('Country')`) are parsed
  only by `@piwitests/core/locator-chain`: the app, the reporter and the extension all build on it. Adapt its output
  to a local shape; never hand-write another parser. Two exceptions, both in `core/src/error-parse.ts`: `extractSelector`
  keeps its own scan because failure fingerprints hash its output (a change regroups existing failures), and the
  error-text readers fall back to a lenient scan for a chain cut short, which no parser can read.

### Licensing (MUST follow)

`packages/reporter`, `packages/core`, `packages/picker-dom`, `integrations/` and `examples/` are MIT; everything else
is FSL-1.1-MIT (see `LICENSE`). Code may move from the MIT parts into the FSL parts, never the other way: app, server,
desktop or extension code moved into `core` or `picker-dom` ships under MIT inside the reporter. A new package or
integration gets its own `LICENSE` file and a `license` field that match the side it belongs to.

### Comments

- **Never reference plans or specs.** No plan IDs (`A1`, `B3`), plan file names or plan titles in code. Comments say
  what the code does, not where the requirement came from.
- **Never write before/after comparisons.** No "was X, now Y", "used to", "previously", "no longer", "replaced A with
  B", "better than the old approach". Comments describe the current state only. Git holds the history.
- **Never justify a change.** No "deliberately not X, because X caused Y", no bug-report retelling. State the rule the
  code follows ("Piwi options only: the Playwright config goes in `defineConfig`"), not the story behind it. The
  reasoning belongs in the commit message and the PR.
- These rules apply to **every** comment: doc/JSDoc comments, inline comments and comments inside tests.

### Commits & PR titles (MUST follow: CI lints every commit)

`commitlint.config.js` is the source of truth; [`CONTRIBUTING.md`](CONTRIBUTING.md) has the full guide and the type →
release-bump table. release-please reads PR titles (squash-merge subjects) to compute version bumps.

Format `type(scope): subject`:

- **type**: `feat` `fix` `perf` `docs` `chore` `ci` `refactor` `test` `build` `style` `revert`
- **scope**: closed list, anything else fails: `app` `reporter` `db` `ui` `demo` `desktop` `extension` `ide` `ci` `docs`
  `deps` `auth` `ai` `notifications` `release` (`main` is reserved for release-please). Optional but include the best
  fit; never invent one (a timeline component change is `fix(ui)`, not `fix(timeline)`).
- **subject**: lower-case start, imperative, no trailing period, full header ≤ 100 chars.

The `commitlint` CI check lints **every commit in the PR range**, so one bad message turns the PR red. Self-check with
`npx commitlint --from HEAD~<n> --to HEAD` from the repo root, and never bypass the husky `commit-msg` hook with
`--no-verify`.

Release notes: release-please writes one raw entry per commit; the `Tidy release notes` workflow de-duplicates them,
and the `release-notes` skill writes the polished, human-facing version.

### Cross-platform shell commands

Any command shown to a **user** (docs, `*.md`, in-app `CodeBlock` snippets) must work on Windows too: prefer one
portable command (`npm`, `npx`, `docker`, `git`, `node -e`), never a bash `\` line continuation, and when no portable
form exists show a bash and a PowerShell version. The mappings and the VitePress tabs:
[`apps/docs/AGENTS.md`](apps/docs/AGENTS.md#cross-platform-shell-commands).

### Documentation

- Update the affected doc **in the same commit** as the code change. User-facing docs live in `apps/docs/`;
  `README.md` is the landing page. API reference is **generated**: never hand-write endpoint docs.
- A pull request that ships the last planned piece of a proposal also moves it from `proposals/` to `adr/`, and one
  that builds part of it updates its Status paragraph ([`adr/AGENTS.md`](adr/AGENTS.md#when-a-proposal-has-shipped)).
- **Setup snippets lead with `wrapConfig` and the capture fixtures**, in the docs and in the app: that is what
  `npx @piwitests/reporter init` writes, and what the connect wizard (`GetStartedWizard`) shows. The bare reporter
  entry appears only as the fallback for a config that cannot be wrapped, saying what it gives up. The wizard's
  snippets come from `app/utils/setup-snippets.ts`, which `tests/unit/setup-snippets.test.ts` holds to `init`'s output.
- **Repository links point at `https://github.com/PiwiTests/piwi`**: docs, package metadata (`repository`,
  `RepositoryUrl`), app links, the desktop updater endpoints. Two names stay as they are: the container image
  `ghcr.io/piwitests/platform`, which users pull by name, and the links release-please already wrote into
  `CHANGELOG.md`.
- The one-click deploy manifests (`render.yaml`, `fly.toml`, `railway.json`, `deploy/**`) are **generated and
  committed**: never edit them by hand ([`apps/application/shared/deploy/AGENTS.md`](apps/application/shared/deploy/AGENTS.md)).

#### One canonical positioning line

Piwi is not a product being sold. Copy is informative, specific and honest, never promotional (voice rules:
[`apps/docs/AGENTS.md`](apps/docs/AGENTS.md#voice)). The project describes itself the same way everywhere:

> **Your Playwright results, kept and explained.** CI throws away every report it makes. Piwi keeps them, then groups
> the failures by root cause, scores the flaky tests, and finds the locator you should have used. Self-hosted,
> zero telemetry.

Eight surfaces carry it; update them **in the same commit**: `README.md` (subtitle), `apps/docs/index.md` (hero `text`
and `tagline`), `apps/docs/.vitepress/config.mts` (`description` and the `og:` title and description), `DOCKER_HUB.md`
(first paragraph), `apps/application/shared/piwi-ecosystem.ts` (`POSITIONING`), the `description` of
`packages/server/package.json` and `packages/reporter/package.json`, and the GitHub repository description and topics
(settings, by hand). `apps/application/tests/unit/docs-drift.test.ts` guards the first five; the rest are on you.

### Tests

- **Vitest** for unit tests (pure functions, no server/browser): `apps/application/tests/unit/*.test.ts` and
  `packages/*/tests/`.
- **Playwright** for E2E/integration (needs a server or browser): `apps/application/tests/*.spec.ts`.
- A test that creates a project MUST use a static name from `#shared/test-project-names` (`PROJECT.YOUR_KEY`) and
  register it there alphabetically, so global-setup cleanup removes it. Never use `Date.now()` suffixes.

### Merging the base branch

- Bring the base branch in with a merge commit, not a rebase: a rebase rewrites commits another checkout may hold.
- **A generated file is regenerated, never merged by hand.** Take either side of the conflict, run its generator on the
  merged tree, and commit the output:

  | File                                                        | Regenerate with                                                                                    |
  | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
  | `package-lock.json`                                         | `npm install` (repo root)                                                                          |
  | `apps/application/public/demo/seed.version.json`            | `npm run app:seed:demo` (`apps/application/`)                                                      |
  | `render.yaml`, `fly.toml`, `railway.json`, `deploy/**`      | `npm run app:generate:deploy` (`apps/application/`)                                                |
  | Drizzle migrations, `_journal.json`, `meta/*_snapshot.json` | the procedure in [`server/database/AGENTS.md`](apps/application/server/database/AGENTS.md)         |

- A branch's migrations follow extra rules through a merge (keep them unless the base branch added migrations, never
  edit a committed one): see [`apps/application/server/database/AGENTS.md`](apps/application/server/database/AGENTS.md).
- Run typecheck, lint and the unit tests on the merged tree before pushing.

### Working with the user's requests

- **Capture global change requests**: when asked to apply a change across many files ("update all X to Y"), add the
  resulting convention to the narrowest guide that covers it (see [Maintaining the agent guides](#maintaining-the-agent-guides)).
- **Review before a pull request**: before you propose or open one, unless the branch was reviewed since its last
  change, propose a code review first. Run it in fresh subagents, not a fork of your own context: give them the diff
  range and the area guides, never your reasoning or what you expect them to find, and ask for an adversarial
  reading that reports defects with the input that triggers them. Verify each finding against the code, fix the real
  ones, and open the pull request after.
- **Report what you find**: bugs, inconsistencies and tech debt discovered along the way go in your final report. When
  the local `plans/` folder exists, also log them in `plans/exploration-findings.md`, in the form the `plan-management`
  skill gives.

## Maintaining the agent guides

Every guide is read by agents before they edit, so its size is paid on every task in its area. Keep them small:

- **A guide holds rules**: an invariant a reasonable change would break, a contract with another package, a security
  boundary, a step that is easy to miss. How the code works goes in the area's `ARCHITECTURE.md`; what the code or a
  test's failure message already says goes nowhere.
- **A rule is one bullet**: the rule in bold, then at most two sentences naming the files and the test that guards it.
  Prefer a test or a lint rule over a sentence when the rule can be checked.
- **Put it in the narrowest guide**: the guide of the directory holding the code it constrains, a new guide beside that
  code when none fits (with a `CLAUDE.md` holding `@AGENTS.md` next to it, and a link from the guide of the nearest
  directory above it), this root file only when it applies everywhere.
- **Size limits**, checked by `apps/application/tests/unit/agent-guides.test.ts`: 20,000 characters for this file and
  30,000 for any other guide (Claude Code keeps only the first 40,000 characters of a guide it loads on its own). Over
  the limit, move detail to `ARCHITECTURE.md` or a topic guide; never raise the limit.

## Troubleshooting

- **Command appears frozen?** It probably opened an interactive pager. Use `git --no-pager <cmd>` for `diff`/`log`/`show`
  and avoid anything that waits for input: non-interactive shells hang on them.
- **Never start a dev server in the foreground of a tool call**: it blocks until the call times out. Use the background
  form (`npm run app:dev:bg` for the dashboard); Playwright starts its own server via `webServer`.
