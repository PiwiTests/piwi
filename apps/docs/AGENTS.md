# Documentation site — agent guide

Rules for working inside `apps/docs/` (the VitePress site published to GitHub Pages). Read [`../../AGENTS.md`](../../AGENTS.md)
first. Every command on this site follows the [cross-platform shell commands](#cross-platform-shell-commands) rule below.

From `apps/docs/`:

```bash
npm run docs:dev      # local preview (runs docs:gen first)
npm run docs:build    # production build (runs docs:gen first)
npm run docs:gen      # regenerate the derived pages only
```

## Generated pages — never edit them by hand

`docs:gen` writes seven pages from registries, and two files for language models. They are **gitignored** and rebuilt
by `docs:dev` and `docs:build`:

| Page | Source | Script |
|---|---|---|
| `reference/configuration.md` | the env-var registry, `apps/application/shared/piwi-env-vars.ts`, and the Settings pages whose fields name each variable, `apps/application/shared/settings-metadata.ts` | `scripts/generate-configuration.mjs` |
| `reference/features.md` (All features) | the feature catalog, `apps/application/shared/piwi-features.ts`; its "The pieces" and "Choosing a setup" sections from `apps/application/shared/piwi-ecosystem.ts` | `scripts/generate-features.mjs` |
| `reference/reporter-options.md` | the reporter's options type, `packages/reporter/src/public/options.ts`, and `PIWI_ENV_KEYS` in `packages/reporter/src/internal/config/env.ts` | `scripts/generate-reporter-options.mjs` |
| `reference/whats-new.md` | `CHANGELOG.md`, read by `apps/application/shared/changelog.ts` (the MCP `get_release_notes` parser) | `scripts/generate-whats-new.mjs` |
| `reference/mcp-tools.md` | the MCP tool catalog, `MCP_TOOL_DEFS` in `apps/application/shared/mcp-tools.ts` | `scripts/generate-mcp-tools.mjs` |
| `reference/analytics-widgets.md` | the widget registry, `ANALYTICS_WIDGETS` in `apps/application/shared/analytics/registry.ts` | `scripts/generate-analytics-widgets.mjs` |
| `reference/metrics.md` | the metric catalog, `METRICS` in `apps/application/shared/analytics/metrics.ts` | `scripts/generate-metrics.mjs` |
| `public/llms.txt`, `public/llms-full.txt` | every page's title, `description` and URL in sidebar order; the hand-written pages as one Markdown file ([llms.txt](https://llmstxt.org)) | `scripts/generate-llms.mjs`, run last |

- **A new generated page is listed in four places**: `apps/application/shared/docs-generated-pages.ts` (read by the
  docs-drift test, the docs bundled into the server and the MCP `describe_piwi` tool), `GENERATED` in
  `scripts/generate-llms.mjs`, `.gitignore` and `.dockerignore`. The drift test checks the last two. Its script goes
  into `docs:gen` in `package.json`, before `generate-llms.mjs`.
- **A generator runs with only `apps/docs` installed**, since the docs workflows install nothing else. A package a
  registry imports at runtime, such as `zod`, is therefore a devDependency here, and the generator resolves it from here
  through a jiti alias (see `scripts/generate-mcp-tools.mjs`).
- **The band labels in `ANALYTICS_BANDS` are the headings of the Analytics widgets page**, and the in-app help links
  them: renaming one is a link change.
- **Every reporter option has a JSDoc comment** stating its default: the Reporter options page is generated from those
  comments, and the generator fails on an option without one. The rule:
  [`packages/reporter/AGENTS.md`](../../packages/reporter/AGENTS.md#the-contracts-you-can-break). `guide/reporter.md`
  covers setup only and links the generated page.

### The configuration reference

- To change a variable's name, description, default or category → edit the **registry**.
- To change section prose or ordering → edit `PIWI_ENV_CATEGORIES` (title/intro/note/order; `mergeInto` folds one
  category's table into another; `internal` hides harness-only vars).
- The interactive generator at `/reference/configuration/generator` reads the **same registry** through the `#shared` Vite alias
  wired in `apps/docs/.vitepress/config.mts`, and emits output through the pure emitters in `apps/application/shared/env-format.ts`
  (unit-tested quoting for .env / compose / docker run / K8s / systemd / shell). Change the emitters, not the markup.
- Keep the section anchors stable: other pages link `#general` and `#wasted-time`, and the drift test checks links into
  a generated page only once `docs:gen` has written it.

### The API reference

There is **no `apps/docs/api.md`, and you must not create one.** The auto-generated OpenAPI spec (`/_openapi.json`) and the
self-contained in-app reference at `/docs` in the running app are the single source of truth for API documentation.
The in-app page renders the spec with no third-party CDN, so it works offline and air-gapped.

When documenting a feature here, link to the live demo reference
(`[API docs](https://piwitests.dev/demo/docs)`) and refer to the self-hosted reference as inline code
`/docs` rather than inlining endpoint descriptions. Do **not** write a bare `[API docs](/docs)` markdown link:
`/docs` is a route on the running app, not a page on this docs site, so VitePress's dead-link check fails the
build. Endpoint documentation is authored in the handler's `defineRouteMeta({ openAPI: … })` block: see
[`../application/server/api/AGENTS.md`](../application/server/api/AGENTS.md#openapi-annotations).

## The docs ship inside the server

The dashboard bundles these pages (and `snippets/`) into its build as Nitro server assets, and the MCP
`describe_piwi` tool serves them to agents: the page index, one page or one `#anchor` section, and a search. So an
instance answers with the docs of its own version, offline. `get_release_notes` does the same for `CHANGELOG.md`.
What that means for a page:

- **Its first paragraph is its summary** in the tool's page index (a page with none falls back to the first paragraph
  under its first `##`, then to its `##` headings), so open a page with a sentence that says what it is for.
- **Anchors are addresses agents use.** They are slugged exactly as VitePress slugs them
  (`apps/application/shared/docs-corpus.ts`); renaming a heading breaks a stored `page#anchor` the same way it breaks a
  link.
- **Three lists are quoted verbatim** by the tool's overview — the jobs and the two rules on `guide/what-piwi-does.md`,
  and "When Piwi is *not* the right choice" on `guide/comparison.md` (`QUOTED_DOCS_SECTIONS` in `piwi-ecosystem.ts`).
  Keep them as Markdown lists.
- Vue components render as text for agents: `<Needs …/>` becomes a "Needs:" line, `<DemoExamples />` the page's demo
  links, and `<<< @/snippets/…` includes the snippet's code. A new component needs a text rendering in
  `docs-corpus.ts`.

## Site structure

### One grouping: the feature catalog

The feature catalog (`apps/application/shared/piwi-features.ts`) is the only place features are grouped. Three things
are rendered from it, so never restate its lists by hand:

- the **Features sidebar**, by `featuresSidebar()` in `.vitepress/navigation.ts`: one group per catalog group, one
  entry per catalog entry whose page is under `features/`;
- the **landing page's cards**, one per catalog group, set by `transformPageData` in `.vitepress/config.mts`;
- the **All features** page, `reference/features.md`.

The top navigation and the Guide, Self-hosting and Reference sidebars are plain data in `.vitepress/navigation.ts`,
which the drift test also reads.

| Section | Folder | The question the reader is holding |
|---|---|---|
| Guide → Get started | `guide/` | "How do I get a first run in, and what do these words mean?" |
| Guide → Set up | `guide/` | "How do I connect my suite, my CI, and what a feature needs?" |
| Guide → About Piwi | `guide/` | "What is this, and should I adopt it?" |
| Features | `features/`, `recipes/` | "What does this feature do, and how do I use it?", grouped by catalog group |
| Self-hosting | `operate/` | "I run the server." |
| Reference | `reference/` | "What are all the values?" |

### Where a new page goes

- **A new feature** adds a catalog entry and one page under `features/`. The entry's `title` is the page's H1 and its
  sidebar label, so the feature has one name everywhere. Never extend another feature's page with it. In the six
  feature groups an entry's `doc` is a whole page, never a `#section`; only the Self-hosting group may point into a
  section of an operator page. A page stays single-purpose: if it needs two sentences to say what it is for, it is two
  pages (`storage` + `database` was one).
- **A prerequisite**, anything a `<Needs>` chip names, gets a setup page in Guide → Set up, and the chip links there
  through `FEATURE_NEED_DOCS` in the catalog.
- **An operator task** goes in `operate/`. An install path is not an operations page: the desktop app is a way of
  getting a dashboard, so it is a feature page. A page with no server dependency at all, the browser extension, is
  never an operations page either.
- **A list of a code registry's entries** is a reference page, generated from the registry rather than written by hand.
  When the code has an id list but no descriptions to generate from, the page is written by hand and the drift test
  checks it against the list:
  - Notification events & webhooks (`NOTIFICATION_EVENTS`);
  - Clue rules (`FailureClueRule`, each rule's id shown);
  - Locator stability rules (`LOCATOR_STABILITY_RULES`);
  - Keyboard shortcuts (the `defineShortcuts` chords, and the keys of the failure inbox, the test search box and the
    assistant);
  - Test search (each qualifier of `TEST_SEARCH_FIELD_DEFS`);
  - the Piwi CLI (every flag of each command's `--help` text).

  A new event, rule, shortcut, qualifier or flag goes on its page in the same change. Gap detectors & exposure has no
  such check: the detector ids are not kept in one list.
- **A recipe** goes in `recipes/` and into `RECIPES_BY_GROUP` in `.vitepress/navigation.ts`, at the top of the catalog
  group it serves.
- **A page that moves** keeps its old URL working with a row in `public/404.html`; GitHub Pages has no server-side
  redirects.

### Page types and word budgets

Every page is one type, with one word budget and no allowlist. The budget counts the page's prose, figure captions
included; it leaves out the front matter, fenced code blocks and an image's markup and alt text. A page over it is
split into two pages, or moves a section to the page it belongs on; it is never excused, nor trimmed of true facts
sentence by sentence.

| Type | Answers | Pages | Budget |
|---|---|---|---:|
| Setup | "How do I switch this on?" | `guide/`, and the home page | 1,500 |
| Feature | "What does it do, how do I use it, what are its limits?" | `features/` | 1,500 |
| Recipe | "I have this problem right now." | `recipes/` | 1,000 |
| Self-hosting | "How do I run the server?" | `operate/` | 1,500 |
| Reference | "What are all the values?" | `reference/`, and `guide/concepts.md` | none |

A page's type is its folder. The exceptions are listed in `PAGE_TYPE_EXCEPTIONS` in the drift test (`guide/concepts.md`
is reference, the home page is setup); a new folder needs a type in `FOLDER_TYPES` there. Blog posts are essays and
have no type. When a feature page runs long, the usual cause is a table that belongs on a reference page (options,
flags, events): link the reference page instead of copying it.

### Every page

- A `description` in its front matter: one sentence of at least 50 characters, used as the search snippet and the
  social card text. The home page is the exception: it uses the site description in `config.mts`.
- Its H1 equals its sidebar label. Recipes are the exception: their H1 is the reader's question.
- One footer heading, `## Related`.
- An image goes in a `<figure>` with a `<figcaption>`: `custom.css` frames it and `theme/image-zoom.ts` opens it at
  its native size on a click. The drift test refuses a Markdown image and a `doc-screenshot` wrapper.
- A new term goes into `concepts.md` in the change that introduces it.
- The page describes what a default install does today. Planned work belongs in `ROADMAP.md`; an experimental
  feature gets one short section marked **Experimental**, with a link to its proposal. No "planned for", "not yet
  wired", "coming soon" or "unreleased".
- No endpoint path in prose, except `/api/health` and `/api/metrics`: link the API reference (see "The API
  reference" above). A path inside a code example stays, and so does an example route of the reader's own app (the
  check reads the routes under `apps/application/server/api`, so it flags only Piwi's own endpoints).
- No MCP tool count: the generated MCP tools page states it, and every other page links there.
- A concrete screen of the live demo is linked only through the demo examples registry,
  `apps/application/shared/demo/demo-examples.mjs`: add an entry (its `doc`, `title`, `shows`, `route` and the
  `expect` the seed must hold) and render the page's entries with `<DemoExamples />` in a `## Try it in the demo`
  section, the last one before `## Related`. A hand-written link may point at the demo's home or its API reference,
  nothing deeper. `llms-full.txt` expands the component into the page's links.

### `recipes/` — task-first pages

Every other page is organized by feature. `recipes/` is organized by the question a reader arrives
with ("did I break this, or is it flaky?"), and each page crosses several features to answer one. It
exists for the long-tail searches that never contain the word "Piwi", so:

- **One question per page**, phrased as the reader would phrase it — that phrasing is the H1.
- **Feature pages stay the source of truth.** A recipe links to them; it never becomes a second place
  where the flaky score or the fingerprint algorithm is explained, because that copy will drift.
- **Always give a route for readers who can't install the thing.** State what a step requires (capture
  fixtures, an LLM key, a browser extension, a signed-installer-less desktop build) and offer the
  alternative — dashboard, MCP, REST API, or plain trace evidence. Listing a requirement without an
  alternative is the failure mode to avoid.
- **A recipe opens the Features group it serves**, through `RECIPES_BY_GROUP`, and the landing page's *Something is
  red right now* list links every recipe. There is no recipes index page. A feature page and a help topic link it too.
- Recipes reuse **existing committed screenshots**; add a scene to the feature-screenshot harness only
  if a recipe genuinely needs a screen no page shows yet.

### Pages and sources with a special role

- **`concepts.md` is the vocabulary source of truth** — project / test run / **test case** (a test's identity across
  time) / **execution** (one attempt, one browser — the `test_runs_cases` row) / failure cluster / fingerprint /
  baseline. Use those words consistently in docs *and* UI copy; link the anchor instead of redefining a term.
- **`ui-overview.md` is a map, not a manual** — one short paragraph per view plus a link to the page that explains the
  concept. Feature explanations belong on the feature page. It is the page most likely to accrete a manual, because a
  feature with no home lands here by default: if you catch yourself adding an H3, a screenshot or a table to it, the
  feature needs its own page instead (`evidence` and `offline-export` were both extracted from it).
- **Contributor material does not belong on this site.** Build steps, source layout, migration workflow and dev
  commands live in `CONTRIBUTING.md` / `AGENTS.md` / `packages/reporter/ARCHITECTURE.md`. The site is for people *using* Piwi.
- **In-app help links point here.** `apps/application/shared/help-content.ts` builds docs URLs from `doc:` string
  literals, as do the capability registry, a few components via `<DocLink to="…">`, the catalog, its
  `FEATURE_NEED_DOCS` and the env-var registry's `docs` fields. The drift test resolves every one of them against the
  headings on this site, so renaming a heading turns that test red rather than breaking a help link silently. The fix
  is still yours: update the literal, or keep the anchor.

### What the drift test checks

`apps/application/tests/unit/docs-drift.test.ts` enforces most rules of this guide, and each failure names what to fix:
every docs link the code builds, every link between pages and every `https://piwitests.dev` URL in `README.md`,
`DOCKER_HUB.md`, `ROADMAP.md` and the app, package and integration READMEs; the catalog and the sidebars; the
descriptions and the word budgets; the prose bans (endpoints, MCP tool count, changelog wording such as "since
version" or "now supports", planned work); the hand-written reference pages and the _Live demo_ section of
`features/ui-overview.md`; the recipes' links; the demo examples; the positioning line and the single-source snippets.
`docs-page-meta.test.ts` checks that each page's description is at least 50 characters.

The docs build itself fails only on a link to a missing page, so this test is what catches a heading that moved. It
computes anchors the way VitePress does (`headingAnchor` in `.vitepress/navigation.ts`); when you move a section, keep
its heading text or update every link the test names.

## Writing conventions

- Update the affected page **in the same commit** as the code change; commit scope `docs`.
- **Every page carries its own search description.** `.vitepress/page-meta.mts` gives each page a canonical URL,
  `og:` tags naming the page, and a `description`: the frontmatter `description`, else a blog post's `excerpt`,
  else the page's first prose paragraph (clipped to whole sentences, ~200 characters). Every page but the home page
  sets a frontmatter `description` (see "Every page" above), so the fallbacks only catch a page that lacks one.
- **`snippets/` holds the code blocks several surfaces share.** A page includes one with `<<< @/snippets/…`; a surface
  that cannot include a file (`README.md`, `DOCKER_HUB.md`, a package README) carries a byte-for-byte copy, which the
  drift test compares (`SNIPPET_COPIES`).
- **What Piwi prints is quoted from the code.** A command's output or a served sample shown on a page (`init`, the
  reporter's lines, the gate, a metrics scrape) is a `snippets/*.txt` that
  `apps/application/tests/unit/docs-checkpoints.test.ts` renders with the code that prints it: change both together.
- American English, sentence-case headings, and the [cross-platform shell commands](#cross-platform-shell-commands) rule.
- Diagrams are theme-aware SVG assets under `apps/docs/public/` — commit the asset rather than embedding a large inline
  `<svg>` in prose.

### Cross-platform shell commands

Any command shown to a **user** (docs, `*.md`, in-app `CodeBlock` snippets) must work on Windows too. Prefer a portable
single command — `npm`/`npx`/`docker`/`git` behave the same everywhere, and
`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` replaces `openssl rand -hex 32`. Avoid
bash `\` line continuations; write one line.

When no portable form exists, show both: on this site use `::: code-group` with `bash [Linux / macOS]` and
`powershell [Windows (PowerShell)]` tabs; in GitHub-rendered `*.md` use two consecutive labeled fenced blocks.
Mappings: `$(pwd)` → `${PWD}`; `VAR=val cmd` → `$env:VAR='val'; cmd`; `rm -rf X` → `Remove-Item -Recurse -Force X`;
`\` → backtick. Linux-only Docker host operations (`chmod`/`chown` on bind mounts) need no PowerShell form — just note
they apply to Linux hosts. Convert first-touch `curl` examples (submit, auth setup/login) to an `Invoke-RestMethod` tab;
other `curl` examples may stay bash-only. `.env` file contents are not shell commands — leave them as-is.

### Voice

Informative, specific, honest — never promotional. Piwi is not a product being sold. The canonical positioning line
and the eight surfaces that must carry it are in the
[root guide](../../AGENTS.md#one-canonical-positioning-line).

- **Banned**: conversion CTA blocks ("Stop losing your…" + buttons), `for-the-badge` call-to-action badges, "try it
  now" / pointing-hand CTAs, competitor feature tables with a **Price** row in the README (honest prose comparison
  belongs in `comparison.md`), vanity badges (stars), superlatives ("powerful", "seamless", "unlock",
  "best-in-class"), and more than ~8 feature bullets or cards on any one page — past that nobody reads them.
- **Prefer the concrete over the categorical**: "groups forty red tests into three root causes" beats "observability
  platform". Name a number, a behavior, or a limit.
- **State limits plainly.** Playwright-only, pre-1.0, and "not the right tool if…" belong in the README and on the
  landing page. Trust is the point, not a caveat to bury.

## The home hero's illustration

The hero of `index.md` has no `hero.image`: its right half is `theme/components/HeroVisual.vue` (its header comment
says how the loop works), mounted in the default theme's `home-hero-image` slot from `theme/index.ts`, with its glow
and box set in `theme/custom.css` (Home hero).

- **It is an illustration, not a screenshot.** The names and timings are invented; keep it recognizably a drawing of
  what Piwi does (tests land, the two failures group into one root cause, the replacement locator is the fix) rather
  than a copy of a screen.
- **Check a change by building the site and watching the loop once** in light and dark, at 1440 px and at a phone's
  width, and with reduced motion (the final state). The panel keeps its height while its rows are hidden, so the
  layout never jumps.

## Marketing screenshots

Every image under `public/screenshots/` is recaptured by a command, never edited by hand. Most come from the
feature-screenshot harness (`apps/application/scripts/take-feature-screenshots.mjs`): each has a scene of the same
name, tagged `docs` with `out: 'docs'`. From `apps/application/`, `npm run app:screens -- <name>` recaptures one
(`flaky-detection`, …) and `npm run app:screens:docs` all of them. How to add a scene, target it (`data-shot`) and pick
its `mode`: [`../application/scripts/AGENTS.md`](../application/scripts/AGENTS.md#feature-screenshots); the scene
options (`split`, `deviceScaleFactor`, `outputWidth`, …) are listed in the script's `Scenes:` comment.

- **The docs gallery's hero** (`home`) is a light/dark diagonal split, `split: true`, so it recaptures with one command
  like any other image: `npm run app:screens -- home`. It is captured at `deviceScaleFactor: 2` and written at
  `outputWidth` 1152, the width of the featured tile: anything wider is bytes the reader never sees.
- **The other gallery images** (`flaky-tests.png`, `failure-clusters-tab.png`) are whole screens at **1280×720**.
- **The README's quick tour** is six scenes tagged `readme` (`tour-*.png`): whole screens at one size and in one theme,
  so the two-column grid lines up. Recapture them together (`npm run app:screens -- --tag readme`), with the server
  started with an AI provider so the diagnosis panel shows its configured state (`PIWI_AI_PROVIDER=anthropic` and any
  `PIWI_AI_API_KEY`; the diagnosis is stored in the seed, so no model is called).
- **A gallery image with no marketing-specific treatment** belongs to a scene rather than to a capture of the live demo:
  the harness renders icons from the bundled collection and runs offline, so the image stays reproducible as the UI
  moves.
- **Run `npm run app:screens:check` after adding or deleting an image**: it fails on an image with no scene and on a
  scene whose image is missing. An image no page, README or extension README shows is deleted with its scene: the
  drift test fails on it.

Images from other pipelines, which the harness's `--check` leaves alone (`EXTERNAL_DOCS_IMAGES` and the `picker-`,
`vscode-` and `jetbrains-` prefixes):

- the landing page's live-run video (`demo-live-run.mp4`) and its poster, from `scripts/record-demo-video.mjs` in
  `apps/application/`. It records a run of the demo's run simulator, on the live demo unless `--url` points it at a
  local demo build (`npm run app:generate:demo`), and needs an ffmpeg with libx264 (`--ffmpeg <path>` or `FFMPEG`);
- the browser extension's: `picker-*.png` at 1280 × 800, the size the stores take, except the DevTools pane, and
  `tested-elements-overlay.png` at 1400 × 900, by `PIWI_DOCS_SHOTS=1 npm run extension:test:e2e -- docs-screenshots`
  from `apps/extension/`, which also writes the loops of `public/videos/` (`picker-*-loop.mp4`: a tool in use, muted,
  with an ffmpeg that has libx264, `FFMPEG` or on the PATH). A loop goes in a `<figure>` as a `<video>` with
  `autoplay loop muted playsinline controls` and an `aria-label` saying what it shows;
- the editor extensions' (`vscode-*.png`, `jetbrains-*.png`), by `apps/vscode/scripts/take-screenshots.mjs` and
  `apps/jetbrains/scripts/take-screenshots.mjs`. They open one fixture project
  (`apps/vscode/scripts/lib/editor-fixture.mjs`) against a stub instance in the real editor, under Xvfb; each script's
  header says how to run it. `apps/vscode/scripts/record-loop.mjs` films `editor-recording-loop.mp4` the same way, the
  recording's browser beside the editor on one screen ffmpeg captures. [`proposals/real-editor-checks.md`](../../proposals/real-editor-checks.md) records what was
  found about each product while the three pipelines were built. The README's *In your browser and your editor* row
  and the Marketplace READMEs show the same images.

Demo *evidence* media (the screenshots, traces and videos shown inside the product) is a different pipeline: see
[`../application/scripts/AGENTS.md`](../application/scripts/AGENTS.md#demo-evidence-media).
