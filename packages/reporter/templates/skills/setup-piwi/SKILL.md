---
name: setup-piwi
description: Use when the user asks to "set up Piwi", "connect Playwright to the dashboard", "start reporting test results", or mentions a Piwi or dashboard server URL. Wires a Playwright project up to a Piwi Dashboard — install the reporter, wrap the config, add capture fixtures, and confirm a run lands.
---

# Set up Piwi in a Playwright project

Connect a Playwright test suite to a [Piwi Dashboard](https://piwitests.dev) so every run is uploaded, kept, and analyzed. The mechanical work is done by a deterministic command; your job is to gather the right inputs, run it, finish anything it flags, and prove a run reaches the dashboard.

## Before you start

Find out three things (ask the user only if you cannot infer them):

- **Dashboard URL** — e.g. `http://localhost:3000` for a local server, or a deployed URL. Defaults to `http://localhost:3000`.
- **Project name** — the label runs are grouped under. Defaults to the package or folder name.
- **Where local runs go** — when developers run the Piwi desktop app and CI reports to a shared server, add
  `--desktop-app prefer`: a local run lands in the app while it is running, and CI runs go to `--server-url`. When the
  desktop app is the only dashboard, pass `--no-server-url` instead of a URL: the reporter finds the running app itself.

Confirm this is a Playwright project: there should be a `playwright.config.ts|js` and `@playwright/test` in `package.json`. If there is no Playwright at all, set that up first.

## Do it

Run the initializer from the project root. It installs `@piwitests/reporter`, wraps `defineConfig(...)` with `wrapConfig(...)`, creates `tests/fixtures.ts` (`tests/fixtures.js` for a JavaScript config), records the connection in `.env.example`, and installs the Piwi workflow skills into `.claude/skills/`:

```bash
npx @piwitests/reporter init --server-url <dashboard-url> --project <name> --json
```

- Preview first with `--dry-run` if you want to see the plan before anything is written.
- `--api-key <key>` also writes the key and the URL into `.env` and adds `.env` to `.gitignore`.
- `--skills none` installs no skills; `--skills-dir <path>` installs them where your agent reads skills from.
- `--json` prints a `steps[]` array and the `nextSteps` to tell the user. Read it. Each step has a `status`:
  - `created` / `updated` / `already` — done, nothing more to do.
  - `manual` — the tool would not edit that file safely, or was told not to run the install. The `detail` field is the exact change to make; apply it yourself (see below).
  - `skipped` — a skill file exists and was changed by hand; `--force` replaces it.
  - `error` — something failed (usually the install); the `detail` says what. Fix it and re-run — `init` is idempotent.

### Finishing `manual` steps

- **config** marked `manual`: the config is not a plain `export default defineConfig(...)`. Add `import { wrapConfig } from '@piwitests/reporter'` and wrap the exported config: `export default wrapConfig(defineConfig({ ... }), { serverUrl, projectName })`.
- **fixtures** marked `manual`: a fixtures file already exists. Merge Piwi in: `import { piwiFixtures } from '@piwitests/reporter'` and compose them into the existing `base.extend(...)` (or use `extendPiwiFixtures(base)`).

### Rewire the specs to the fixtures

The capture fixtures (locator healing, slow-endpoint analysis, Web Vitals, console, failure-time ARIA) only apply to specs that import `test` from the fixtures file. In each spec that currently does:

```ts
import { test, expect } from '@playwright/test'
```

change it to import from the fixtures file instead, e.g. `import { test, expect } from './fixtures'` (adjust the relative path). A spec left on the direct import still runs and reports — it just is not captured.

## Authentication

If the dashboard has auth enabled, runs need an API key. Have the user create one in the dashboard (**Settings → Account → API keys**; keys start with `pd_`), then put it in `.env` as `PIWI_API_KEY=pd_...` (or re-run `init` with `--api-key`) and make sure `.env` is git-ignored. The reporter reads `PIWI_DASHBOARD_URL`, `PIWI_API_KEY` and `PIWI_PROJECT_NAME` from the `.env` next to `playwright.config`, so the config needs no dotenv loading; a variable set in the environment wins over the file. Never hardcode a key into `playwright.config.ts` or commit it. In CI, where `.env` is not checked out, pass it as a secret (`PIWI_API_KEY`).

## Verify it worked

Setup is not done until a run reaches the dashboard.

1. Run one spec: `npx playwright test` (or a single file to keep it quick).
2. Confirm the run landed. Deterministically: set `PIWI_OUTPUT_FILE=piwi-run.json` when running, then read `runUrl`/`status` from that JSON file — its existence with a `runUrl` proves the upload. Otherwise look for the `View run: <url>` line the reporter prints, or open the dashboard and check the project's latest run.
3. If nothing appears: read the reporter's `[Piwi Dashboard]` lines (set `PIWI_VERBOSE=true` for more), verify the dashboard is reachable at the URL, and that auth (if on) has a valid key. When the reporter could not deliver the run, it saves it and sends it with the next run.

## Wrap up

Tell the user what changed (config, fixtures, `.env.example`, the skills), what they still need to do (API key if auth is on; rewire remaining specs), and the run URL you verified. If they use CI, offer to add the reporter's env there too.
