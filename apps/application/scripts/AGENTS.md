# Dashboard scripts: agent guide

How to run and change the dashboard's tooling scripts (`scripts/`): the feature-screenshot harness, the page
measurements, the performance suite, the demo's evidence media and the brand assets. Read [`../AGENTS.md`](../AGENTS.md)
first. The `run-app` skill (`.claude/skills/run-app/SKILL.md`) is the recipe for running the app and screenshotting a
route.

Changing `generate-demo-seed.mjs` or anything it seeds? The seed's rules (determinism, what is committed, the checks)
are in [`../app/demo/AGENTS.md`](../app/demo/AGENTS.md#the-seed).

## Feature screenshots

The rule (screenshots for every visible UI change, sent to the user) is in
[`../app/AGENTS.md`](../app/AGENTS.md#feature-screenshots). `scripts/take-feature-screenshots.mjs` boots its own dev
server, or drives one you already have with `--url`. Its header documents every option, and the `Scenes:` comment (about a thousand lines above `const SCENES`)
every scene option.

| Command                          | Purpose                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `npm run app:screens -- <scene>` | Capture one scene (add `--url` to drive a server you already have) |
| `npm run app:screens:docs`       | Regenerate every committed docs illustration                       |
| `npm run app:screens:check`      | Fail if a docs image has no scene, or a scene's image is missing   |
| `npm run app:screens -- --list`  | Every scene with its mode, tags and the files it writes            |

- **`.screens/` is gitignored: its images are a report artifact, never committed.** The scene, kept current, is what
  is committed. A scene's `out` picks the folder: `screens` (the default) writes to `.screens/`, `docs` writes the
  committed illustrations in `apps/docs/public/screenshots/`, so the scene name _is_ the image name.
- **A `docs` scene also carries `tags: ['docs']`**: `npm run app:screens:docs` selects scenes by that tag, while
  `app:screens:check` reads `out`.
- **Each scene declares the surface it captures with `mode`.** `web` (the default) is the dashboard as a browser serves
  it: pick it for anything a browser user sees, since desktop-only chrome such as the sidebar's back/forward pair
  would misrepresent the app. `tour` switches the guided tour on (`NUXT_PUBLIC_DEMO_TOUR=true`). `desktop` runs the
  server with `NUXT_PUBLIC_DESKTOP=true` and injects the mocked Tauri bridge, so no shell build is needed (shape the
  mock per scene with `link` / `inspection`). `demo` serves the built demo SPA from its `/demo/` sub-path
  (`npm run app:generate:demo` first), for what only the demo build does, such as its assistant's prepared answers.
- **A scene targets a `data-shot="…"` attribute**, placed on the container the image is about
  (`of: '[data-shot="flaky-table"]'`), never an XPath or nth-child path. Add one when a scene needs it, named for the
  content.
- **A capture waits on `settle()`** (fonts, network, nothing still loading), never on a timeout. A capture taller than
  the viewport fails with the viewport to use: give the scene that viewport, never a cropped image.
- **`--freeze-now <iso>` pins the browser clock** so relative timestamps stop moving and two runs produce
  byte-identical PNGs. Combine it with a freshly seeded database when a diff needs to mean a real UI change.
- **Annotations come from `scripts/screenshot-annotations.mjs`**, an in-repo SVG overlay with no runtime dependency. A
  scene with an `annotate` list writes both the plain image and a `-annotated` one. The label text is baked into the
  PNG, so keep it short and expect a recapture to change it.

## Measuring the failure pages

`npm run app:measure` (`scripts/measure-detail-pages.mjs`) checks the execution and failure-cluster pages against the
budgets in `scripts/lib/detail-page-budgets.mjs`; `--check` exits 1 on a breach. When to run it: the _Measure it_ rule
of [`../app/AGENTS.md`](../app/AGENTS.md#typography-and-emphasis). The options, the default routes and what it reports:
the script's header and the `run-app` skill.

## Performance

A change to what a page loads or renders is measured with the performance suite (`scripts/perf/`, `npm run app:perf`).
It runs two production builds against one large dataset and compares the server render, the full load in Chromium,
the API calls and the SQL each request runs, for the projects list, every project tab, the test-run page, and a failed
execution's page carrying the whole history and a large Playwright 1.63 trace (`scripts/perf/lib/trace.mjs`, uploaded
through the real import). CI runs it on every pull request against the base commit, on two machines (`--shard k/n`,
joined by `report.mjs`), and posts the comparison as a comment. Every option is in the header of
`scripts/perf/run.mjs`. Locally:

```bash
npm run app:build                                     # the build to measure, in .output
node scripts/perf/run.mjs --target base=<a build of main>/.output --target head=.output --scale medium
node scripts/perf/run.mjs --database postgres --pg-url postgresql://postgres:postgres@localhost:5432/postgres …
```

- **PostgreSQL must load `pg_stat_statements`** (`scripts/perf/lib/pg.mjs` has the `docker run` line); with it every
  request's statements are counted on any build.
- **The suite also runs each build with OpenTelemetry on** (`server/plugins/opentelemetry.ts`, `server/utils/otel.ts`)
  to list the SQL of each request, and of the requests the server makes to itself while rendering a page. Set
  `OTEL_EXPORTER_OTLP_ENDPOINT` to see the same traces in a collector of your own (`apps/docs/operate/tracing.md`).

## Demo evidence media

- **The demo's screenshots (`public/demo/screenshots/*.png`), trace ZIPs (`public/demo/traces/*.zip`) and failure
  videos (`public/demo/videos/*.webm`) are real Playwright artifacts**, captured against the small app-under-test pages
  in `scripts/demo-pages.mjs`. Never a real app, and never the Piwi dashboard itself: traces embed full page snapshots,
  and a screenshot of the _results UI_ is no evidence of a failing _test_.
- **Each page mirrors one story of `shared/demo/failure-stories.mjs`** closely enough (headings, labels, button names)
  that the evidence reads as the app the seeded data describes.
- **Screenshots**: `node scripts/take-demo-screenshots.mjs`, which serves the pages from a throwaway HTTP server (no
  dev server or seeded database needed).
- **Traces and videos**: `node scripts/record-demo-media.mjs` reproduces each story's failure with a real interaction,
  per its `SCENARIOS` table: add an entry for a new story's media. Traces record with `sources: true`, so the call-stack
  evidence view has real content.
- **Both scripts launch the Chromium `PIWI_DEMO_CHROMIUM` names**, else the one in `PLAYWRIGHT_BROWSERS_PATH`
  (`resolveChromium`, `scripts/lib/dev-server.mjs`), else Playwright's own download.
- **Commit the binaries, then run `npm run app:seed:demo`** to rewire the `files` rows with the real sizes.
- **A story's `media` (`screenshot`, `trace`, `video`) is all the seed needs**: the generator attaches the screenshot
  to the most recent failing execution of each member case, and the trace and the video to the first member case's
  (`max(test_runs_cases.id)` per cluster and case, as `shared/handlers/failure-clusters.ts` picks
  `recentTestRunsCaseId`). A story with no `media` has none on purpose.

## Brand assets

- **Every logo, favicon and app icon in the repository is written by `scripts/generate-brand-assets.mjs`**
  (`npm run app:generate:brand`) from the drawing and the brand colors in that file: navy ink, violet `#7c3aed` and the
  mint of the check. That covers the dashboard's and the docs site's SVG logos, favicons, touch icon and social card,
  the browser extension's, the VS Code extension's and the JetBrains plugin's icons, and `shared/brand-mark.json`.
  Never edit one by hand: change the script and regenerate them all.
- **The desktop app's bundle icons are generated from `public/logo.svg` by `tauri icon`.**
