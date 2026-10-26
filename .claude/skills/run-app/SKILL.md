---
name: run-app
description: Launch and drive the Piwi dashboard locally with seeded sample data, capture a screenshot of any route, and stop it again — the verified path for checking a UI or server change in the real app instead of rediscovering the setup.
---

# Run the dashboard locally

Use this whenever you need to *see* a change working: a screen, a flow, an API response. It is the
tested sequence; the pitfalls at the end each cost a previous session real time, so follow the
commands as written rather than improvising with `nuxt dev` and a hand-rolled Playwright script.

Everything runs from `apps/application/`. Node 24+, dependencies installed (`npm install` at the
repo root).

## Look at one page (the common case)

One command boots a throwaway dev server on port 3050, creates and seeds the dev database on the
first run, opens the route, waits for hydration and for the page to settle, screenshots it into
`.screens/` (gitignored) and tears the server down:

```bash
npm run app:screens -- --route /test-run-cases/37 --expand --height 2400
```

- `--expand` unfolds the collapsible cards first (console, network, test source and the other evidence cards
  start folded). More ways to fix is not one of them: it opens only the section the Next step points at,
  one at a time, so click another section in a scene's `run` to see it.
- `--height` is how you see more of a page: the dashboard scrolls inside a panel, so a full-page
  screenshot of the document only ever shows one viewport. Use 2000–3000 for a detail page.
- `--width` sets the viewport width (default 1280), `--name` the file stem.
- Add `--url http://localhost:3000` to drive a server you already have running instead of booting one.

Then read the image (`.screens/route-<slug>.png`) — a blank or half-loaded frame means the wait
was cut short, not that the page is empty; retry once before concluding anything.

The registered scenes (`npm run app:screens -- --list`) are the same machinery with curated routes and
viewports; add one when a change adds or visibly reworks a screen (see the "Feature screenshots" rule
in `apps/application/AGENTS.md`).

## Keep a server running (iterating on a change)

```bash
npm run app:seed:dev        # sample data into .data/piwi.db — creates and migrates the DB if needed
npm run app:dev:bg          # dev server on http://localhost:3000, detached, waits until ready
```

- Nuxt HMR picks up edits; there is no need to restart per change. Compile errors show up in
  `.data/dev-server.log`, not in the browser.
- `app:seed:dev` also moves each seeded `demo/…` media row under its project's folder
  (`project-<id>/demo/…`, the only paths `/api/files/` serves) and copies the committed evidence media
  (`public/demo/{screenshots,traces,videos}`) there, so the failure pages serve the real screenshot,
  trace and video instead of a broken image. Re-running it heals a dev database seeded before that.
- The Playwright E2E config reuses a server already on port 3000 (`npm run app:test -- <spec>`), so one
  background server serves both your screenshots and the specs.
- Capture against it with `npm run app:screens -- --route <path> --url http://localhost:3000`.
- Stop it with `node scripts/dev-server.mjs --stop` (also stops a stale one; the pid is recorded in
  `.data/dev-server.pid`). Seeding needs the server stopped — SQLite holds a lock.

## Check an API or find an id

```bash
curl -s localhost:3000/api/health
curl -s "localhost:3000/api/test-run-cases/37" | head -c 800
node scripts/db-query.mjs "select id, status from test_runs_cases where status='failed' order by id desc limit 5" --json
```

Authentication is off on a plain dev server, so no key is needed.

## Measure the failure pages' legibility

```bash
npm run app:measure -- --url http://localhost:3000        # against a running server
npm run app:measure -- --check                            # seeds .data/measure/, boots a server, exits 1 on a breach
npm run app:measure -- --build .output --check            # the same on a production build, as CI runs it
npm run app:measure -- --json                             # one object per route, with its budgets
```

`measure-detail-pages.mjs` reads the execution page (`/test-run-cases/:id`) and the failure
cluster page (`/failure-clusters/:id`) after hydration, a bounded settle and the page's last API
answer, and reports — inside the detail panel — the scroll offset of each block (header, most
likely, situation, issue, next step, evidence, the fix sections, what changed, affected tests,
occurrences trend, activity, history), the panel's total scroll height, the controls of the navbar
and the situation block, the interactive controls above the fold split into navbar, situation block
and below, the solid primary buttons and help hints above the fold, the open code blocks and their
height, the word count, the active evidence tab, the Most likely grade, the Next step's action and
how far below its button the content it copies sits, and the text styles of the situation block. A
control counts when the reader sees it: one shown on hover or focus only (the chooser beside an
Open in IDE link) does not.

Each route then gets a verdict against the budgets of `scripts/lib/detail-page-budgets.mjs`, set
at 1280×800 (any other viewport reports without verdicts): at most 15 text styles on the execution
page's block and 13 on the cluster page's, at most 25 controls in the navbar and the situation
block, at most one solid primary button above the fold, and a Next step that copies a code change
(`copy-git-apply`, `copy-locator`) shows that change in the block. The controls below the block
that reach the fold (the evidence card's tabs, the affected tests, the history) are reported, not
budgeted. The script finds the action by `data-next-action` and the content by `data-copies`, never
by a label. The report ends with every breach; `--check` exits 1 when there is one, and a route that
answers an error fails it too. CI runs `--build .output --check` on the shared build.

Default routes: executions #37, #13, #87, #768, #748 and clusters #10, #2, #5, #1. `--routes`
overrides them, `--width`/`--height` the viewport, `--port` the port of the server it boots (3060, off
the 3050 of `app:screens`, so both can run side by side). It refuses a port something already listens on.

Without `--url` it seeds a throwaway database in `.data/measure/` from the demo seed (regenerating
`public/demo/seed.sql` first when it no longer matches `seed.version.json`) and boots its own server
(a dev server, or with `--build <dir>` the production build in that directory) on it with no AI
provider, no issue tracker, no authentication and the default storage and locale, whatever your
shell or `.env` sets, so two runs give the same numbers whatever your machine holds; this is the run
to quote in a PR. With `--url` the report says it measured that server's own data: a dev database
with a connected issue tracker, an AI provider or extra links counts differently, and the budgets do
not cover that state.

## Seeded entry points

The seed is generated deterministically from `scripts/generate-demo-seed.mjs`, so these ids are stable
until a story is added to the generator; the docs scenes in `scripts/take-feature-screenshots.mjs`
use the same ones and are the reference when in doubt.

| Want to see | Route |
|---|---|
| A failing execution with screenshot, source, locators, console, network | `/test-run-cases/37` |
| A broken locator with ranked replacements | `/test-run-cases/13` |
| A cluster with a stored, fix-verified AI diagnosis | `/failure-clusters/10` |
| A cluster whose captured locator name looks renamed | `/failure-clusters/2` |
| A run with insights, failure clusters and a workers timeline | `/test-runs/2` |
| A project with flaky tests, quarantine and performance tabs | `/projects/1` |
| A test case's history across runs | `/test-cases/1` |
| An execution's History block | `/test-run-cases/229` |
| An execution that passed on retry | `/test-run-cases/768` |
| A test that did not run (the run hit its max failures) | `/test-run-cases/748` |

AI is not configured on the dev server: the diagnosis panels show their "not configured" state, and
clusters without a stored title fall back to the deterministic one.

## Pitfalls (each of these has already cost a session)

- **Do not wait for `networkidle` without a timeout.** The run, execution and notification surfaces
  hold a Server-Sent Events stream open, so the network never goes idle. The screens script waits for
  `domcontentloaded`, Nuxt hydration and a bounded settle instead; copy that if you script Playwright
  yourself.
- **`fullPage: true` does nothing useful here.** The document does not scroll; the panel does. Use a
  tall viewport or screenshot the panel element.
- **A route compiles on its first hit** in dev mode — allow a 90 s navigation timeout the first time.
- **A throwaway server needs its port free.** `app:screens` boots on 3050 and `app:measure` on 3060;
  both refuse a port something already listens on, since `nuxt dev` would quietly bind another one and
  the script would then drive the server that was already there. Stop it, or give `app:measure` a
  `--port`.
- **Seeding and migrations need the server stopped** (`node scripts/dev-server.mjs --stop` first).
- **`public/demo/seed.version.json` changes only when the seed does.** `npm run app:seed:demo` leaves it
  as it is unless the generator or its stories changed; when they did, commit it with them.
- **Never start `nuxt dev` in the foreground of a tool call** — it blocks until the call times out.
  `app:dev:bg` exists for that reason.
- **Never start `npx nuxt dev` by hand.** It outgrows Node's default heap (about 2 GB) and dies with
  `JavaScript heap out of memory` while `Building server`; `app:dev`, `app:dev:bg` and the scripts'
  servers give it 4 GB.
- **`PIWI_DEMO_MODE=true` is not a dev-server flag.** To verify the demo itself, build it:
  `npm run app:generate:demo && npm run app:check:demo:runtime`.
- Screenshots and dev data live under `.screens/` and `.data/`, both gitignored; never commit them.
