# Dashboard front end: agent guide

Rules for the Vue front end (`app/`: pages, components, composables, utils). Read [`../AGENTS.md`](../AGENTS.md) first.
The run page's timeline has its own guide ([`components/run/AGENTS.md`](components/run/AGENTS.md)), and so do the demo
([`demo/AGENTS.md`](demo/AGENTS.md)) and the guided tour ([`utils/demo-tour/AGENTS.md`](utils/demo-tour/AGENTS.md)).

## Reuse the shared primitives

`app/components/shared/` holds the building blocks — **prefer them over re-implementing**. `SectionCard` /
`CollapsibleSectionCard` (headers + folding), `EmptyState` / `LoadingState` / `ErrorState`, `StatTile` + `StatTileGrid`
(never hand-rolled tile markup), `FiltersBlock` + `FilterBar`, `FilterToolbar`, `TableScroller`, `NavbarActions`,
`BreadcrumbNav`, `ChartCard`, `DurationValue`, `ErrorText` (never print a raw error string — it carries ANSI codes),
`DiffPatch` / `DiffFile`, `HelpHint`, `DocLink`, `EnvManagedBadge` / `EnvManagedAlert`, `SettingsField`,
`OpenInIdeLink`. See [`ARCHITECTURE.md`](../ARCHITECTURE.md) for what each one does.

## Responsive / mobile

The app must be usable at **~375 px with no horizontal page scroll**. Write mobile-first (stacked/narrow default, add
`sm:`/`md:`/`lg:` upward) and **never hide data** with `max-sm:hidden` — hide decorations only. For wide tables use
either a `md:hidden` card list + `hidden md:block` table (preferred for dense tables, see `ProjectTrendTable`) or a
`TableScroller`. On fixed-height detail layouts the mobile view must scroll as one document — never `overflow-hidden`
clipping a tall summary; `DetailPageLayout` handles this. **Verify new or changed screens at 375 px before committing.**

## Feature screenshots

Every change that adds or visibly reworks user-facing UI ends with screenshots of the result: add or update a scene in
the `SCENES` registry of `scripts/take-feature-screenshots.mjs`, capture it (`npm run app:screens -- <scene>`), and
**send the images to the user in the conversation**, not only in the PR. A user-facing change is never reported as done
without them. When the change alters existing UI, send the before and the after; capture both narrow (~390 px) and
wide (~1280 px) when the change is about layout. A scene targets a `data-shot="…"` attribute, never a DOM path: do not
remove one without updating its scene. The harness's modes, outputs and options:
[`scripts/AGENTS.md`](../scripts/AGENTS.md).

## Inline help

Any new **block-level** shared component with a header MUST accept an optional `help?: HelpTopicKey` prop (typed from
`shared/help-content.ts`, re-exported by `app/utils/help-content.ts`) and render
`<HelpHint v-if="help" :topic="help" />`. Add copy by adding one entry to the `HELP_TOPICS` registry — never hardcode
hint strings at call sites. Hint text is Markdown (`app/utils/help-markdown.ts`):
put identifiers and commands in `code`, and when a hint can't stay to 1–2 sentences, give it a lead sentence and a
`- **Label** — …` list instead of a wall of prose (it then opens wider and scrolls). Document only non-obvious blocks
(skip counters, search boxes, basic CRUD forms, theme switcher). When adding a hint, **remove the always-on prose it
replaces** so the page gets quieter. If a `PIWI_*` env var can override the setting, set `envVars: [...]` (typed `PiwiEnvVarName[]`) so
the popover surfaces it for system admins.

Use `i-lucide-circle-help` for help and reserve `i-lucide-info` for informational/empty-state callouts. A topic's
`title` becomes the accessible name `Help: <title>` — avoid titles that are substrings of nearby button labels, or
Playwright's substring `getByRole('button', { name })` matches both.

## Settings surface

Settings pages are driven by the `SETTINGS_PAGES` registry in `shared/settings-metadata.ts` (re-exported by
`app/utils/settings-metadata.ts`, and read by the assistant's `explain_setting`); `useSettingsNav` and
`useSettingsEnvState` derive from it. To add a page or field: (1) add the env var to `shared/piwi-env-vars.ts`,
(2) add or extend the `HELP_TOPICS` entry with its `envVars`, (3) add the `fields` entry to `SETTINGS_PAGES`,
(4) render with `SettingsField`. Never hand-roll an env-managed `UAlert` or lock icon — use `EnvManagedBadge` /
`EnvManagedAlert`.

## UTable

- **Always use template slots for cells** — never `cell:` callbacks with `h()` / `resolveComponent()`. The only
  exception is `createSortHeader<T>()` in `header:`. No `import { h, resolveComponent }` in table components for cells.
- Slot naming: `#${accessorKey}-cell="{ row }"` (or `#${id}-cell` for id-only columns); headers `#${accessorKey}-header`.
- Every sortable column uses `createSortHeader<T>('Label')` (`app/utils/index.ts`); non-sortable ones use a plain string.
- Sticky headers: the `sticky` prop + a `max-h-*` class on the table root. Do **not** wrap tables in `overflow-y-auto`.
- Row highlighting: `:meta="{ class: { tr: '…' } }"` — **not** `:row-attrs`, which Nuxt UI v4 dropped.
- Actions column: `{ id: 'actions', header: 'Actions' }` plus right-aligned `#actions-header` / `#actions-cell` slots.
- **Never `header: ''`.** An empty-string header hydrates as a mismatch (tanstack's `FlexRender` renders a bare `''`
  that Vue cannot place). A column without a visible title gets a real label and renders it through its header slot:
  `header: 'Actions'` plus `<template #actions-header><span class="sr-only">Actions</span></template>`.
- A table with ≥5 columns needs the mobile treatment from the responsive rule above.

## Typography and emphasis

A screen is read top to bottom; emphasis tells the reader where to look, and it only works when it is rare. These
rules apply to every block a page opens on and to any card that states facts (the situation block, page headers,
summaries, list rows). Dense tables and code views are exempt only where a rule says so.

- **Four text styles per block, no more**: a heading (`text-lg sm:text-xl font-semibold text-highlighted`, at most
  one per block), a body (`text-sm text-highlighted leading-relaxed`, every sentence), a label (`text-sm font-semibold
  text-highlighted`) and a meta style (`text-xs text-muted` — qualifiers, facts, footers). Code — a locator, a path, a
  commit — is the body or meta style in `font-mono`. One exception: the commit range of a _What changed_ setup gap
  (`a1b2c3d..e4f5a6b since the last passing run`) is a line of meta facts with no sentence, and keeps the meta font
  so the cluster block stays within its text-style budget. Nothing else in the block: no `text-toned`/`text-dimmed`
  mixed with `text-muted`, no italics, no uppercase micro-labels, no `font-semibold` on a sentence.
- **Structure with layout, not with styling.** A block with several kinds of lines gets one label column
  (`SituationBlock` renders a `<dl>` with an 8 rem label column), so the reader scans labels, not formatting. A badge,
  a color or a bold span is never what tells two lines apart.
- **The situation block reads explanation, action, context**, in the one order of `SITUATION_ROWS`
  (`app/utils/situation-rows.ts`): _Most likely_ first, then _State_ right above _Next_, then the context lines, the
  cluster and its ticket first (the execution page's _Cluster_ line ends with the ticket, the cluster page's _Issue_
  line holds it). A page fills the lines it has and never reorders them; a new line takes its place in that list.
  Facts about the execution itself (since when, whether it is the latest) are the meta line under the headline.
- **The situation block's left edge carries the page's status color** (`SituationBlock :edge`): the execution's
  outcome color, the cluster state's dot color. It is the status, not an accent, and nothing else in the block
  repeats it.
- **One accent color per screen: the primary action.** The solid `color="primary"` button is the only saturated
  element the reader is meant to click. Every other button is `color="neutral"` — `variant="outline"` for a secondary
  action, `variant="ghost"` for a disclosure or a menu trigger. No `warning`, `success` or `soft` buttons for ordinary
  actions. A selected tab, a pressed switch or a selected row is neutral too, never `primary`: `SELECTED_TAB_CLASS`
  (`app/utils/index.ts`) for a tab strip, `SEGMENTED_SELECTED_CLASS` for a segmented control or view switch,
  `SELECTED_ROW_CLASS` for the row that picks what the page shows, and `CURRENT_ITEM_RING_CLASS` for the current
  item in a strip of status-colored marks (this execution in its history, this attempt among the retries). On the
  failure pages two tests hold it: `tests/unit/evidence-accent.test.ts` refuses a raw red, orange or green shade and
  a primary class outside `hover:` and `focus-visible:` in the evidence card's and the affected tests' components
  (add a new one to its list), and `tests/failure-page-accent.spec.ts` checks that nothing rendered in them changes
  with the primary color and that the page shows at most one solid primary button. A card's header icon
  (`CARD_ICON_CLASS`, marked `data-card-icon`) is the one exception.
- **Links inside a sentence keep the sentence's color**: `underline decoration-dotted underline-offset-2
  hover:decoration-solid`. `text-primary` links belong in navigation lists and tables, not in prose.
- **Badges are for exceptions, at most two per screen** — the status chip and one exceptional state (_Quarantined_, a
  did-not-run cause). A strength, a confidence, an error type, a tag or a mark such as `@fixme` is plain meta text,
  never a chip. Two red chips on one screen is a bug.
- **Icons only where they carry meaning the text does not**: a status dot, a chevron on a disclosure or a menu, the
  check on a copied button. No icon in front of a label, a heading or a fact.
- **Code inside a heading or a sentence of the situation block sits in a chip**: a locator is syntax-highlighted in
  it (`<LocatorCode chip>`, `<FailureHeadline chip>`), a commit keeps the sentence's color (`CODE_CHIP_CLASS`).
  Elsewhere in prose a locator stays plain mono (`<LocatorCode plain>`).
- **A recorded step is shown from core's parts, never from its sentence**: `<BugStepText>` renders
  `describeStepInParts` (or `describeExpectationInParts`), which knows each name, value, key, address and locator as it
  writes them in any language: names and values semibold in `text-highlighted` over words in `text-default`, a key as
  `UKbd`, and its code (an address, a test id, a locator through `LocatorCode`) in a chip, in the steps list as in the
  situation block, since a reader scans a step for them. Don't split the Markdown sentence at its backticks or quotes.
- **Say a fact once, in one style.** When the same fact could be a chip and words, keep the words.
- **Measure it.** `npm run app:measure -- --check` fails when the execution or failure-cluster page breaks a budget at
  1280×800 (text styles in the situation block, controls in the navbar and the situation block, solid primary buttons
  above the fold; the values are in `scripts/lib/detail-page-budgets.mjs`). It finds the Next action by
  `data-next-action` and what it copies by `data-copies`: keep both when you move either. CI runs it on the build
  (`Failure page budgets`); run it before committing a change to either page. Raising a budget needs a reason in the
  PR. What it reports: the `run-app` skill.

## Filters

- **A page's filters sit in one `FiltersBlock`** (`app/components/shared/FiltersBlock.vue`): a bordered block with the
  _Filters_ heading, the block's help hint and _Reset_ on its header row, folded to a one-line summary of the active
  filters below `sm` (`filterBarSummary`, `app/utils/filter-summary.ts`). `inline` puts a single row of controls on the
  heading's row. Home, a project page and Analytics use it. Never put page filters in the navbar or loose above the
  content.
- **What a filter hides is a note in the block, never an alert.** Its `notes` slot names the count and the action that
  brings the rows back (`HiddenRunsNote`: _Include partial runs_, _Show all branches_); no full-width `UAlert`, no solid
  button.
- **A list's own controls stay with the list**: a search box, status chips, a sort or a window that only one list
  reads go in that list's card or toolbar (`FilterToolbar`), not in the Filters block. One exception: the run page's
  outcome filter is the count bar in its header, so the run's Tests list has no status chips
  ([`adr/run-page-room.md`](../../../adr/run-page-room.md)).
- **A page shows its lists as the user left them** when they come back to it (Back, a breadcrumb, a link): the search,
  the filters, the sort, the open or collapsed groups, the page of a paged list, a _Show all_ and the scroll position.
  Hold that state with `useViewState(key, init)` (`app/composables/useViewState.ts`), never a plain `ref`: it is kept
  per route path until a reload. A `UTable` sort is `v-model:sorting` on a `useViewState` value, and a page whose list
  scrolls calls `useViewScroll` on its scrolling element (`dashboardPanelBody(id)` for a `UDashboardPanel` body),
  keyed by tab when its tabs share it. A value the URL carries stays in the URL and wins over the kept one; a
  preference shared by every page of a kind stays a cookie (`useGroupByCookie`); a row selection or an open dialog
  stays a plain `ref`. Two components that write the query in the same tick go through `replaceQuery`
  (`app/utils/route-query.ts`).
- **The project page's filters are a run scope every tab that reads run history follows** (`#shared/project-run-scope`:
  environments, branches, the branch policy, full runs only). The page passes `projectRunScopeQuery(scope)`, the
  endpoint reads it with `parseProjectRunScope` and its handler adds `projectRunScopeConditions`
  (`shared/handlers/project-run-scope.ts`), so the header, the runs, the catalog, the failures, the Flake Lab and the
  performance tab read the same runs. With no branch picked the scope reads the default branch
  (`projectDefaultBranch`) and the runs that report none, as Analytics does. A new tab or endpoint that reads runs
  takes the scope; a request without its keys keeps its unscoped reading for API callers.

## Brand assets

Every logo, favicon and app icon in the repository — the dashboard's and the docs site's SVG logos, favicons, touch
icon and social card, the browser extension's icons, the VS Code extension's icons and the JetBrains plugin's icons —
is written by `scripts/generate-brand-assets.mjs` (`npm run app:generate:brand`) from the drawing and the brand colors
in that file: navy ink, violet `#7c3aed` and the mint of the check. Never edit one of those files by hand; change the
script and regenerate them all. The desktop app's bundle icons are generated from `public/logo.svg` by `tauri icon`.
Show the wide lockup with `<BrandLogo>`, which swaps in the reversed drawing on a dark page. The dashboard's accent
(`primary` in `app/app.config.ts`) is the same violet.

Every document Piwi writes for use outside the dashboard (the offline exports, the quality reports, the emails) ends
with the Piwi credit from `shared/brand.ts`: the small mark and a link to piwitests.dev (`piwiCreditHtml`,
`drawPiwiCredit` for a PDF, `piwiCreditMarkdown`; `emailLayout` draws it in every email). The mark is drawn from
`shared/brand-mark.json`, which the same generator writes. It never loads over the network: inline SVG in HTML, vector
paths in a PDF, and an attachment in an email (`sendEmail` attaches it whenever the message shows it). A new document
format ends with the same credit. Data files (CSV, XLSX, JSON) carry none.

## Test outcome colors

Passed, failed, flaky, skipped, didn't run and running each have **one** color, everywhere: the `--color-status-*`
tokens in `app/assets/css/main.css` (emerald, rose, fuchsia, zinc, amber, blue; violet is the accent, never an outcome). Timed-out and interrupted count as
failed; a pass that needed a retry counts as flaky. Skipped has a second grey, `fixme`, for a `test.fixme()` skip
(`isFixmeSkip` / `fixmeSkipPredicate` in `shared/utils/skip-kind.ts`): a subset of skipped, carved out of the skipped
segment the way flaky is carved out of passed. Never hardcode a status color in a bar, chart, legend, dot, history
cell, timeline bar or filter chip: use `STATUS_PALETTE` / `statusPalette(status, retries?)` from
`app/utils/status-palette.ts` (`bg-status-*` classes for HTML, `var(--color-status-*)` in SVG `style`), the shared
`StatusFilterChip`, and `getStatusColor` for badges (`flaky` is a registered Nuxt UI color). A new outcome view that
needs another shade adds it to the palette entry, not to the component.

Pass rates follow the same rule with one scale: `app/utils/pass-rate.ts` (`passRateTone`, `passRateTextClass`,
`PASS_RATE_TONES`, and `passRateStep` for heatmap-style cells) — good at 90% or more, fair from 50%, poor below, in
emerald / amber / rose. Never write a pass-rate threshold or color at a call site.

## Other UI rules

- **One page gutter, set once.** The `UDashboardPanel` body (`dashboardPanel.slots.body` in `app/app.config.ts`) is
  every page's gutter: 16 px around the content and between the panel's direct children from `sm` up, and no side
  gutter below `sm`, where cards and blocks go full-bleed (`max-sm:rounded-none max-sm:border-x-0`). A page never pads
  its body content again (no `p-4` or `p-6` wrapper, no `:ui` body override), spaces its top-level blocks `gap-4` /
  `space-y-4`, and narrows with `max-w-*`, never with padding. The one exception is below `sm`: a page whose content
  is not only full-bleed cards (a loose heading, sentence or select at the top level) wraps it in `max-sm:px-4`, so
  nothing touches the screen edge.
- Sentence case headings and labels ("Test runs"), relative dates via date-fns (full timestamp on hover), human-readable
  durations (exact ms on hover), `DurationValue` where a tight `210ms` reads better than "0.21 seconds".
- **A duration in an execution's evidence** (a step or a request, on the Timeline, the Network tab or the trace's
  request list) is a `DurationValue`, never `Math.round(ms) + ' ms'`, and is colored only when `durationStandout`
  (`#shared/duration-standout`) says it stands out in its test or against its usual time (the `usual` the timeline
  sends with it, from `getUsualDurations`), in the one tone of `app/utils/duration-tone.ts`. Never color it by a fixed
  threshold at the call site; `tests/timeline-durations.spec.ts` checks which durations stand out, and
  `tests/unit/evidence-accent.test.ts` refuses a raw red, orange or green shade in the evidence card's components. The
  Timeline and the Network tab read the timeline through `useExecutionTimeline`, one key per execution. Web Vitals keep
  their standard rating bands, in `text-error` and the warning tone.
- **Absolute timestamps render client-only**: `prettyDateFormat` output never appears in SSR'd markup (the server host
  and the browser rarely share a time zone). Render the date with `ClientDate`, and wrap title-tooltip spans that bind
  `prettyDateFormat` in `ClientOnly`. The same holds for anything formatted with the browser's locale
  (`toLocaleString()`, `viewerLocale()`): the server formats it in its own.
- **Data several components of one page read under one key** (capability states, the project list) passes
  `dedupe: 'defer'` and `getCachedData: reuseWithinRender` (`app/utils/shared-fetch.ts`). Without them each caller
  fetches again during the server render: the default `dedupe: 'cancel'` restarts a pending request, and nothing is
  reused from the render once it resolved.
- **What the first screen does not need loads in the browser** (`server: false`, `lazy: true`): a counter, a menu's
  contents, a card further down. What it shows, or what would make it jump (capability states hiding a tab), stays in
  the server render.
- **A `useFetch({ server: false })` loading state reads `status`, not `pending`**: the server renders it `idle`, and
  the client starts the fetch before it hydrates, so gate the spinner on
  `status.value === 'idle' || status.value === 'pending'` (see `pages/projects/[id]/locators.vue`) — gating on
  `pending` renders the empty state on the server and the spinner in the browser.
- **Date/time formatting is locale-aware — never hardcode a format.** `prettyDateFormat` and `formatRelativeTime` read
  the viewer's effective locale and time zone from the active prefs holder (`app/utils/locale-format.ts`), set by
  `app/plugins/locale.client.ts` from three layers: the per-browser override (Settings → Localization), then
  `PIWI_LOCALE` / `PIWI_TIME_ZONE`, then the stored instance default, then the built-in `en-US`. Call sites need no
  change — use `ClientDate` / `prettyDateFormat` / `formatRelativeTime` and they localize automatically. The pure
  formatter and the resolution/validation helpers live in `#shared/i18n/locale-format`; format via `Intl`
  (`formatAbsolute`), never a hand-written `M/d/yyyy`. `en-US` output is byte-identical to the historical format, so it
  is the safe default for screenshots and tests.
- **Page-level tab strips MUST use one pattern**: `UDashboardToolbar` + `UNavigationMenu` with `highlight`
  (`DetailPageLayout` is the reference). `DetailPageLayout` already renders it — pages using
  `DetailPageLayout` never touch the strip themselves, and no other page-level strip (UTabs pill, hand-rolled
  tablist) may be introduced. Content-level tab switches inside a card (e.g. an mcp code-client picker) are
  free to differ. The strip is a navigation menu, not an ARIA tablist: panels carry **no** `tabpanel` role,
  the active item carries `aria-current`, and inline `HelpHint`s render beside the strip for the active tab
  (never inside a navigation trigger's label — that nests buttons). The strip carries
  `:ui="{ list: 'overflow-x-auto', root: 'min-w-0', item: 'shrink-0' }"` so it scrolls as one row when the
  tabs overflow instead of shrinking every label to an ellipsis, and **below `sm` it is replaced by a
  full-width `USelect`** (the strip is `hidden sm:flex`) — the horizontal row collapses to unreadable icons
  on a phone. `DetailPageLayout` does both already.
- **A settings surface with many sections uses a vertical section menu**, not a tab strip: Settings
  (`pages/settings.vue`, one route per page) and a project's Settings tab (`ProjectSettingsPanel.vue`, one
  `?section=` per section) put a vertical `UNavigationMenu` (`orientation="vertical"`, grouped with one
  `{ type: 'label' }` row per group, `lg:w-52`, sticky) beside the content from `lg` up, and a full-width
  `USelect` grouped the same way below `lg`. Add a page to the registry (`SETTINGS_PAGES`) or a section to the
  panel's list; never add a horizontal strip back.
- **Spreadsheet exports people click are Excel (.xlsx), never CSV**: build them with `renderXlsx` /
  `plainXlsxTable` from `#shared/reports/render-xlsx` (numbers and dates as typed cells, text never a formula,
  bold frozen header) and save them with `useDesktopDownload().saveBlob`, since a download link does nothing in
  the desktop shell. CSV stays only for machine consumers (the API `format=csv`, `/api/rollups`, the CLI).
  Page code imports the renderer lazily (`await import(...)`).
- **Every search ignores case and accents** (`resume` finds `Résumé`). In memory, compare with `foldText` from
  `#shared/utils/fold-text` on both sides (`foldText(name).includes(foldText(query))`) and mark matches with
  `foldTextWithOffsets`; in SQL use `foldedContains` / `foldedEquals` from `#shared/utils/fold-text-sql`. Never
  `.toLowerCase().includes(...)` or `lower(col) LIKE ...` for a typed search. A `UCommandPalette` /
  `UDashboardSearch` passes `:fuse="{ fuseOptions: { ignoreDiacritics: true } }"`; `USelectMenu` and `UInputMenu`
  already ignore both.
- **Test lists search and order one way.** A list of tests searches with `TestSearchInput` and the language in
  `#shared/test-search` (in memory with `compileTestSearch`, in SQL with `testSearchConditions` from
  `#shared/utils/test-search-sql`), marks matches with `SearchHighlight`, and orders and groups its rows with
  `app/utils/test-list-order.ts` (run order, file order, File + Describe). Never add a second search syntax, a separate
  tag / lock / browser filter control next to it, or another describe-tree builder. A new qualifier is an entry in
  `TEST_SEARCH_FIELD_DEFS` plus its row in `apps/docs/reference/test-search.md` (the drift test checks the page).
- Add a `title` attribute to any control whose purpose is not obvious from its label.
- **Clickable source paths**: render any repo-relative path or `file:line[:col]` with `OpenInIdeLink`, never a bare
  `<span>`/`<code>`. Pass `filePath` (+ `line`/`column`) or `location`, and thread `projectKey` (the Piwi project **id**)
  and `projectName` when in scope so per-project workspace overrides resolve. IDE preferences are a **per-browser client
  preference** (`useOpenInIde`, `piwi-ide-prefs`) — deliberately not in `SETTINGS_PAGES` and with no `PIWI_*` var, since
  the source lives on the user's machine. Only the Piwi JetBrains plugin (`/api/piwi/open`, `PiwiOpenHandler.kt` in
  `apps/jetbrains`) confirms a file opened. The IDE Remote Control probe only shows an IDE is listening, and
  `vscode://` / `jetbrains://` launches are fire-and-forget, so never report a confirmed "opened" for those.
- **Data fetching in tab children**: for self-contained components rendered conditionally, use `watch` + `$fetch` with
  reactive triggers rather than `useFetch({ lazy: true })`, which may not fire before mount. Use `v-if` on tab-switched
  components for clean mount/unmount. Pass props from the page only for data already fetched at page level.
- `DetailPageLayout` renders summary + tab bar + panels; `tabPanelClass` lets a tab with self-scrolling content use
  `overflow-hidden flex flex-col` instead of the default `overflow-y-auto`.
- **Anything the UI opens outside `$fetch` carries `useRuntimeConfig().app.baseURL`**: `window.open`, an `href`, a
  download URL. The demo is served from `/demo/` and its service worker only intercepts that prefix, so a root-relative
  `/api/...` escapes the scope and 404s against the static host. `fileApiUrl` and `getTraceViewerUrl` exist for this.

## Guide anchors, the guided tour and the demo

- **An element carrying `data-tour` is a guide anchor.** Moving, renaming or removing it updates the registry in
  `shared/guide-anchors/` and every guide pointing at it, in the same commit; a block someone could ask about gets an
  anchor. Rules: [`shared/guide-anchors/AGENTS.md`](../shared/guide-anchors/AGENTS.md).
- **A change to a screen a tour stop or an authored guide shows updates that stop in the same commit**, its copy in
  every tour language included. Rules: [`utils/demo-tour/AGENTS.md`](utils/demo-tour/AGENTS.md).
- **A UI-visible change updates the demo** (seed, demo handlers, simulator): see
  [`demo/AGENTS.md`](demo/AGENTS.md#demo-data-requirements).
