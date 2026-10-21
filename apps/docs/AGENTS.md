# Documentation site — agent guide

Rules for working inside `apps/docs/` (the VitePress site published to GitHub Pages). Read [`../AGENTS.md`](../AGENTS.md)
first — in particular the **cross-platform shell commands** rule, which applies to every snippet on this site.

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
| `reference/configuration.md` | the env-var registry, `apps/application/shared/piwi-env-vars.ts` | `scripts/generate-configuration.mjs` |
| `reference/features.md` (All features) | the feature catalog, `apps/application/shared/piwi-features.ts`; its "The pieces" and "Choosing a setup" sections from `apps/application/shared/piwi-ecosystem.ts` | `scripts/generate-features.mjs` |
| `reference/reporter-options.md` | the reporter's options type, `packages/reporter/src/public/options.ts`, and `PIWI_ENV_KEYS` in `packages/reporter/src/internal/config/env.ts` | `scripts/generate-reporter-options.mjs` |
| `reference/whats-new.md` | `CHANGELOG.md`, read by `apps/application/shared/changelog.ts` (the MCP `get_release_notes` parser) | `scripts/generate-whats-new.mjs` |
| `reference/mcp-tools.md` | the MCP tool catalog, `MCP_TOOL_DEFS` in `apps/application/shared/mcp-tools.ts` | `scripts/generate-mcp-tools.mjs` |
| `reference/analytics-widgets.md` | the widget registry, `ANALYTICS_WIDGETS` in `apps/application/shared/analytics/registry.ts` | `scripts/generate-analytics-widgets.mjs` |
| `reference/metrics.md` | the metric catalog, `METRICS` in `apps/application/shared/analytics/metrics.ts` | `scripts/generate-metrics.mjs` |
| `public/llms.txt`, `public/llms-full.txt` | every page's title, `description` and URL in sidebar order; the hand-written pages as one Markdown file ([llms.txt](https://llmstxt.org)) | `scripts/generate-llms.mjs`, run last |

The seven pages are also listed in `apps/application/shared/docs-generated-pages.ts`, which the docs-drift test, the
docs bundled into the server and `.dockerignore` follow; a new generated page goes there too, and in `.gitignore`.

A generator runs with only `apps/docs` installed, since the deploy workflow installs nothing else. A package a registry
imports at runtime, such as `zod`, is therefore a devDependency here, and the generator resolves it from here through
a jiti alias (see `scripts/generate-mcp-tools.mjs`). The band labels in `ANALYTICS_BANDS` are the headings of the
Analytics widgets page and the in-app help links them, so renaming one is a link change.

### The configuration reference

- To change a variable's name, description, default or category → edit the **registry**.
- To change section prose or ordering → edit `PIWI_ENV_CATEGORIES` (title/intro/note/order; `mergeInto` folds one
  category's table into another; `internal` hides harness-only vars).
- The interactive generator at `/reference/configuration/generator` reads the **same registry** through the `#shared` Vite alias
  wired in `apps/docs/.vitepress/config.mts`, and emits output through the pure emitters in `apps/application/shared/env-format.ts`
  (unit-tested quoting for .env / compose / docker run / K8s / systemd / shell). Change the emitters, not the markup.
- Keep the section anchors stable (`#general`, `#wasted-time` are deep-linked from the app and other pages).

### The API reference

There is **no `apps/docs/api.md`, and you must not create one.** The auto-generated OpenAPI spec (`/_openapi.json`) and the
self-contained in-app reference at `/docs` in the running app are the single source of truth for API documentation —
the in-app page renders the spec with no third-party CDN, so it works offline and air-gapped.

When documenting a feature here, link to the live demo reference
(`[API docs](https://piwitests.dev/demo/docs)`) and refer to the self-hosted reference as inline code
`/docs` rather than inlining endpoint descriptions. Do **not** write a bare `[API docs](/docs)` markdown link:
`/docs` is a route on the running app, not a page on this docs site, so VitePress's dead-link check fails the
build. Endpoint documentation is
authored in the handler's `defineRouteMeta({ openAPI: … })` block — see
[`../application/AGENTS.md`](../application/AGENTS.md#openapi-annotations).

## The docs ship inside the server

The dashboard bundles these pages (and `snippets/`) into its build as Nitro server assets, and the MCP
`describe_piwi` tool serves them to agents — the page index, one page or one `#anchor` section, and a search — so an
instance answers with the docs of its own version, offline. `get_release_notes` does the same for `CHANGELOG.md`.
What that means for a page:

- **Its first paragraph is its summary** in the tool's page index (a page with none is summarized by its `##`
  headings), so open a page with a sentence that says what it is for.
- **Anchors are addresses agents use.** They are slugged exactly as VitePress slugs them
  (`apps/application/shared/docs-corpus.ts`); renaming a heading breaks a stored `page#anchor` the same way it breaks a
  link.
- **Three lists are quoted verbatim** by the tool's overview — the jobs and the two rules on `guide/what-piwi-does.md`,
  and "When Piwi is *not* the right choice" on `guide/comparison.md` (`QUOTED_DOCS_SECTIONS` in `piwi-ecosystem.ts`).
  Keep them as Markdown lists.
- Vue components render as text for agents: `<Needs …/>` becomes a "Needs:" line, `<DemoExamples />` the page's demo
  links, and `<<< @/snippets/…` includes the snippet's code. A new component needs a text rendering in
  `docs-corpus.ts`.

## Site structure (MUST follow)

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
  section of an operator page. A page stays
  single-purpose: if it needs two sentences to say what it is for, it is two pages (`storage` + `database` was one).
- **A prerequisite**, anything a `<Needs>` chip names, gets a setup page in Guide → Set up, and the chip links there
  through `FEATURE_NEED_DOCS` in the catalog.
- **An operator task** goes in `operate/`. An install path is not an operations page: the desktop app is a way of
  getting a dashboard, so it is a feature page. A page with no server dependency at all, the browser extension, is
  never an operations page either.
- **A list of a code registry's entries** is a reference page, generated from the registry rather than written by hand.
  When the code has an id list but no descriptions to generate from, the page is written by hand and the drift test
  checks it against the list: Notification events & webhooks (`NOTIFICATION_EVENTS`), Clue rules (`FailureClueRule`,
  each rule's id shown), Keyboard shortcuts (the `defineShortcuts` chords and the failure inbox's keys) and the Piwi
  CLI (every flag of each command's `--help` text). A new event, rule, shortcut or flag goes on its page in the same
  change. Gap detectors & exposure has no such check: the detector ids are not kept in one list.
- **A recipe** goes in `recipes/` and into `RECIPES_BY_GROUP` in `.vitepress/navigation.ts`, at the top of the catalog
  group it serves.
- **A page that moves** keeps its old URL working with a row in `public/404.html`; GitHub Pages has no server-side
  redirects.

### Page types and word budgets

Every page is one type, with one word budget and no allowlist. A page over its budget is cut, or split into two pages;
it is never excused. The budget counts the page body without its front matter, code blocks included.

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

- A `description` in its front matter: one sentence, used as the search snippet and the social card text. The home
  page is the exception: it uses the site description in `config.mts`.
- Its H1 equals its sidebar label. Recipes are the exception: their H1 is the reader's question.
- One footer heading, `## Related`.
- A new term goes into `concepts.md` in the change that introduces it.
- The page describes what a default install does today. Planned work belongs in `ROADMAP.md`; an experimental
  feature gets one short section marked **Experimental**, with a link to its proposal. No "planned for", "not yet
  wired", "coming soon" or "unreleased".
- No endpoint path in prose, except `/api/health` and `/api/metrics`: link the API reference (see "The API
  reference" above). A path inside a code example stays, and so does an example route of the reader's own app.
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
  red right now* list links every recipe. There is no recipes index page.
- Recipes reuse **existing committed screenshots**; add a scene to the feature-screenshot harness only
  if a recipe genuinely needs a screen no page shows yet.

- **`concepts.md` is the vocabulary source of truth** — project / test run / **test case** (a test's identity across
  time) / **execution** (one attempt, one browser — the `test_runs_cases` row) / failure cluster / fingerprint /
  baseline. Use those words consistently in docs *and* UI copy; link the anchor instead of redefining a term.
- **`ui-overview.md` is a map, not a manual** — one short paragraph per view plus a link to the page that explains the
  concept. Feature explanations belong on the feature page. It is the page most likely to accrete a manual, because a
  feature with no home lands here by default: if you catch yourself adding an H3, a screenshot or a table to it, the
  feature needs its own page instead (`evidence` and `offline-export` were both extracted from it).
- **Contributor material does not belong on this site.** Build steps, source layout, migration workflow and dev
  commands live in `CONTRIBUTING.md` / `AGENTS.md` / `packages/reporter/ARCHITECTURE.md`. The site is for people *using* Piwi.
- **Every reporter option has a JSDoc comment** in `packages/reporter/src/public/options.ts`, under the `// ── Group ──`
  comment it belongs to, stating its default. The Reporter options page (`reference/reporter-options.md`) is generated
  from those comments and from `PIWI_ENV_KEYS`, and the generator fails on an option without one. `reporter.md` covers
  setup only and links there.
- **In-app help links point here.** `apps/application/app/utils/help-content.ts` builds docs URLs from `doc:` string
  literals, as do the capability registry, a few components via `<DocLink to="…">`, the catalog, its
  `FEATURE_NEED_DOCS` and the env-var registry's `docs` fields. `apps/application/tests/unit/docs-drift.test.ts`
  resolves every one of them against the headings on this site, so renaming a heading turns that test red rather
  than breaking a help link silently — but the fix is still yours: update the literal, or keep the anchor.

### What the drift test checks

`apps/application/tests/unit/docs-drift.test.ts` fails when:

- a docs link the code builds, a link between two docs pages, or a docs URL in `README.md`, `DOCKER_HUB.md`,
  `ROADMAP.md` or a package or integration README points at a missing page or heading;
- a `features/` page is missing from the catalog, or an entry in a feature group points to a section instead of a page;
- a page has no `description`, or a sidebar entry points at a missing page or differs from that page's H1;
- a page is over the word budget of its type;
- a hand-written page names a Piwi endpoint in prose, states an MCP tool count, uses changelog wording ("since
  version", "now supports") or announces planned work;
- a notification event, a clue rule, a registered shortcut or a CLI flag is missing from its reference page, or a
  guided tour role or language from the _Live demo_ section of `features/ui-overview.md`;
- a recipe is not linked from a feature page and a help topic;
- a demo example's page does not render `<DemoExamples />` in its "Try it in the demo" section before `## Related`,
  a page renders the component with no example, or a page links a demo screen by hand.

It also guards the positioning line and the single-source snippets. The endpoint check reads the routes under
`apps/application/server/api`, so it flags only Piwi's own endpoints.

The docs build itself only fails on a link to a missing page, and pull requests do not run it, so this test is what
catches a heading that moved. It computes anchors the way VitePress does (`headingAnchor` in `.vitepress/navigation.ts`);
when you move a section, keep its heading text or update every link the test names.


## Writing conventions

- Update the affected page **in the same commit** as the code change; commit scope `docs`.
- **Every page carries its own search description.** `.vitepress/page-meta.mts` gives each page a canonical URL,
  `og:` tags naming the page, and a `description`: the frontmatter `description`, else a blog post's `excerpt`,
  else the page's first prose paragraph (clipped to whole sentences, ~200 characters). Every page but the home page
  sets a frontmatter `description` (see "Every page" above), so the fallbacks only catch a page that lacks one, and
  `docs-page-meta.test.ts` fails when a page's description is under 50 characters.
- American English, sentence-case headings, and the shell-portability rule from the root guide: VitePress uses
  `::: code-group` with ```bash [Linux / macOS] + ```powershell [Windows (PowerShell)] tabs when a command has no
  portable single form.
- Diagrams are theme-aware SVG assets under `apps/docs/public/` — commit the asset rather than embedding a large inline
  `<svg>` in prose.

### Voice

Informative, specific, honest — never promotional. Piwi is not a product being sold. The canonical positioning line
and the seven surfaces that must carry it are in the [root guide](../AGENTS.md#documentation).

- **Banned**: conversion CTA blocks ("Stop losing your…" + buttons), `for-the-badge` call-to-action badges, "try it
  now" / pointing-hand CTAs, competitor feature tables with a **Price** row in the README (honest prose comparison
  belongs in `comparison.md`), vanity badges (stars), superlatives ("powerful", "seamless", "unlock",
  "best-in-class"), and more than ~8 feature bullets or cards on any one page — past that nobody reads them.
- **Prefer the concrete over the categorical**: "groups forty red tests into three root causes" beats "observability
  platform". Name a number, a behavior, or a limit.
- **State limits plainly.** Playwright-only, pre-1.0, and "not the right tool if…" belong in the README and on the
  landing page. Trust is the point, not a caveat to bury.

## The home hero's illustration

The hero of `index.md` has no `hero.image`: its right half is `theme/components/HeroVisual.vue`, mounted in the default
theme's `home-hero-image` slot from `theme/index.ts`. It is the Piwi mark, inline, over a small run panel whose story
is told by CSS keyframes on one shared 14 s clock (`--loop`): the tests land, the two failures are grouped into one
root cause, the replacement locator is written out as the fix. It is an illustration, not a screenshot: the names and
timings are invented, and it should stay recognizably a drawing of what Piwi does rather than a copy of a screen. The
glow behind it and the slot's box are set in `theme/custom.css` (Home hero); a visitor who prefers reduced motion gets
the final state. Check a change by building the site and watching the loop once in light and dark, at 1440 px and at
a phone's width: the panel keeps its height while its rows are hidden, so the layout never jumps.

## Marketing screenshots

The **light/dark diagonal split** is a scene option, not a manual procedure: `split: true` captures the scene in both
themes at the same viewport and scroll position and composites them — light above the top-right → bottom-left seam,
dark below — so a hero recaptures with one command like any other illustration:

```bash
cd apps/application
npm run app:screens -- home
```

Pair it with `deviceScaleFactor: 2` and `outputWidth` to write a crisp image at the width the page actually gives it:
the docs gallery's featured tile spans the content column (~1152px), and anything wider is bytes the reader never sees.

The other gallery images (`projects.png`, `flaky-tests.png`, `failure-clusters-tab.png`) are whole screens at
**1280×720**, each with a scene of its name.

**The README's quick tour** is six scenes tagged `readme` (`tour-*.png`): whole screens at one size and in one theme,
so the two-column grid lines up. Recapture them together, with the server started with an AI provider so the diagnosis
panel shows its configured state (`PIWI_AI_PROVIDER=anthropic` and any `PIWI_AI_API_KEY`; the diagnosis is stored in
the seed, so no model is called):

```bash
cd apps/application
npm run app:screens -- --tag readme
```

**The live-run video** on the landing page (`demo-live-run.mp4`) and its poster, which the README shows in its place,
come from `scripts/record-demo-video.mjs`: it starts the demo's run simulator, records the run page until the run
finishes, and writes both files. It needs an ffmpeg with libx264 (`--ffmpeg <path>` or `FFMPEG`), and records the live
demo unless `--url` points it at a local demo build (`npm run app:generate:demo`, served under `/demo/`).

Demo *evidence* media (the screenshots, traces and videos shown inside the product) is a different pipeline — see
[`../application/AGENTS.md`](../application/AGENTS.md#demo-evidence-media-committed-binaries).

**Feature illustrations** (a docs page showing a specific screen, including desktop-only UI the live demo cannot
render) come from the feature-screenshot harness instead. Every one of them has a scene that writes it, and the scene
name is the file name, so recapturing takes only the name:

```bash
cd apps/application
npm run app:screens -- flaky-detection   # one illustration
npm run app:screens:docs                 # all of them
npm run app:screens:check                # every image has a scene, every scene has its image
```

Add a scene to the script's `SCENES` registry if none fits, tagged `docs` with `out: 'docs'`; target the screen through
a `data-shot` attribute rather than a DOM path, and leave `mode` at its `web` default unless the illustration is of the
desktop shell (`mode: 'desktop'` runs it against a desktop-enabled server with the mocked Tauri bridge, no shell build
needed). Images written this way are committed — keep the scene current so the illustration can be recaptured when the
UI changes, and run `app:screens:check` after adding or deleting one.

A gallery image with no marketing-specific treatment (no diagonal split) belongs to a scene rather than the live-demo
pipeline: the harness renders icons from the bundled collection and can be re-run offline, so the image stays
reproducible as the UI moves.

Three illustrations come from other pipelines, and the harness's `--check` leaves them alone (`EXTERNAL_DOCS_IMAGES`
and the `picker-`, `vscode-` and `jetbrains-` prefixes): the video poster above; the browser extension's
(`picker-*.png` at 1280 × 800, the size the stores take, except the DevTools pane; `tested-elements-overlay.png` at 1400 × 900), by
`PIWI_DOCS_SHOTS=1 npm run extension:test:e2e -- docs-screenshots` from `apps/extension/`; and the editor extensions'
(`vscode-*.png`, `jetbrains-*.png`), written by
`apps/vscode/scripts/take-screenshots.mjs` and `apps/jetbrains/scripts/take-screenshots.mjs`, which open one fixture
project (`apps/vscode/scripts/lib/editor-fixture.mjs`) against a stub instance in the real editor, under Xvfb. Each
script's header says how to run it and what it needs, and
[`proposals/real-editor-checks.md`](../../proposals/real-editor-checks.md) records what was found about each
product while the three pipelines were built. The README's
*In your browser and your editor* row and the Marketplace READMEs show the same images.
