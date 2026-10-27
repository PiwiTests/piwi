# Dashboard front end: agent guide

Rules for the Vue front end (`app/`: pages, components, composables, utils). Read [`../AGENTS.md`](../AGENTS.md) first.
Narrower guides hold the rules of the page layouts ([`pages/AGENTS.md`](pages/AGENTS.md)), the run page's timeline
([`components/run/AGENTS.md`](components/run/AGENTS.md)), the demo ([`demo/AGENTS.md`](demo/AGENTS.md)) and the
guided tour ([`utils/demo-tour/AGENTS.md`](utils/demo-tour/AGENTS.md)).

## Reuse the shared primitives

**Build from `app/components/shared/` before writing new markup.** `SectionCard` / `CollapsibleSectionCard` (headers
and folding), `EmptyState` / `LoadingState` / `ErrorState`, `StatTile` + `StatTileGrid` (never hand-rolled tile
markup), `FiltersBlock` + `FilterBar`, `FilterToolbar`, `TableScroller`, `NavbarActions`, `BreadcrumbNav`,
`ChartCard`, `DurationValue`, `ErrorText` (never print a raw error string: it carries ANSI codes), `DiffPatch` /
`DiffFile`, `HelpHint`, `DocLink`, `EnvManagedBadge` / `EnvManagedAlert`, `SettingsField`, `OpenInIdeLink`. What each
one does: [`ARCHITECTURE.md`](../ARCHITECTURE.md).

- **A detail page's title is its `BreadcrumbNav`**: the navbar never repeats it.
- **Copy text through `useCopy` / `useCopyRich`**, which give the copied state and the toast, never through
  `navigator.clipboard` by hand. Copying an image (`app/utils/chart-export.ts`) is the one direct use.

## Responsive / mobile

- **Usable at ~375 px with no horizontal page scroll.** Write mobile-first (stacked default, add `sm:`/`md:`/`lg:`
  upward). **Never hide data** with `max-sm:hidden`, only decorations.
- **A wide table (5 columns or more) gets a mobile form**: a `md:hidden` card list beside a `hidden md:block` table
  (preferred for dense tables, see `ProjectTrendTable`), or a `TableScroller`.
- **On a phone, a fixed-height detail layout scrolls as one document**: never `overflow-hidden` clipping a tall
  summary. `DetailPageLayout` does it.
- **Verify new or changed screens at 375 px before committing.**

## Feature screenshots

- **A change that adds or visibly reworks UI ends with screenshots sent to the user in the conversation**, not only
  in the PR. Add or update its scene in the `SCENES` registry of `scripts/take-feature-screenshots.mjs` and capture it
  (`npm run app:screens -- <scene>`). Send the before and the after when existing UI changes, narrow (~390 px) and
  wide (~1280 px) when the change is about layout. A user-facing change is never reported done without them.
- **A `data-shot="…"` attribute is what a scene captures**: do not remove or rename one without updating its scene.
  The harness's modes and options: [`scripts/AGENTS.md`](../scripts/AGENTS.md#feature-screenshots).

## Inline help

- **A new block-level shared component with a header takes `help?: HelpTopicKey`** and renders
  `<HelpHint v-if="help" :topic="help" />`. Its copy is one entry of `HELP_TOPICS` (`shared/help-content.ts`), never a
  string hardcoded at a call site.
- **Hint text is Markdown** (`app/utils/help-markdown.ts`): identifiers and commands in `code`. A hint longer than 1–2
  sentences becomes a lead sentence and a `- **Label** — …` list (it then opens wider and scrolls).
- **Hint only what is not obvious** (no hint on counters, search boxes, basic CRUD forms or the theme switcher), and
  remove the always-on prose the hint replaces.
- **A setting a `PIWI_*` variable can override lists it in the topic's `envVars`** (`PiwiEnvVarName[]`), so the
  popover shows it to administrators.
- **`i-lucide-circle-help` is the help icon**; `i-lucide-info` is for informational and empty-state callouts.
- **A topic's `title` is never a substring of a nearby button's label**: it becomes the accessible name
  `Help: <title>`, and Playwright's substring `getByRole('button', { name })` would match both.

## Settings surface

- **A settings page or field is an entry of `SETTINGS_PAGES`** (`shared/settings-metadata.ts`, which `useSettingsNav`
  and the assistant's `explain_setting` read). To add a field: (1) its env var in `shared/piwi-env-vars.ts`, (2) its
  `HELP_TOPICS` entry with `envVars`, (3) its `fields` entry in `SETTINGS_PAGES`, (4) render it with `SettingsField`,
  (5) its guide anchor of kind `field` ([`shared/guide-anchors/AGENTS.md`](../shared/guide-anchors/AGENTS.md)).
- **Never hand-roll an env-managed `UAlert` or lock icon**: use `EnvManagedBadge` / `EnvManagedAlert`.

## UTable

- **Cells are template slots, never `cell:` callbacks** with `h()` / `resolveComponent()`:
  `#<accessorKey>-cell="{ row }"` (`#<id>-cell` for an id-only column), `#<accessorKey>-header` for a header. The one
  render function allowed is `createSortHeader<T>('Label')` (`app/utils/index.ts`) in `header:`, which every sortable
  column uses; a non-sortable column's header is a plain string.
- **Sticky headers**: the `sticky` prop and a `max-h-*` class on the table root. Never wrap a table in
  `overflow-y-auto`.
- **Row highlighting**: `:meta="{ class: { tr: '…' } }"`, never `:row-attrs` (Nuxt UI v4 dropped it).
- **Actions column**: `{ id: 'actions', header: 'Actions' }` with right-aligned `#actions-header` / `#actions-cell`
  slots.
- **Never `header: ''`**: tanstack's `FlexRender` renders a bare `''` that Vue cannot place, a hydration mismatch. A
  column with no visible title keeps a real label and hides it in its slot:
  `<template #actions-header><span class="sr-only">Actions</span></template>`.

## Typography and emphasis

Emphasis tells the reader where to look, and only works when it is rare. These rules apply to every block a page opens
on and to any card that states facts (the situation block, page headers, summaries, list rows). Dense tables and code
views are exempt only where a rule says so.

- **Four text styles per block, no more**: a heading (`text-lg sm:text-xl font-semibold text-highlighted`, one per
  block at most), a body (`text-sm text-highlighted leading-relaxed`, every sentence), a label
  (`text-sm font-semibold text-highlighted`) and a meta style (`text-xs text-muted`: qualifiers, facts, footers). Code
  (a locator, a path, a commit) is the body or meta style in `font-mono`. No `text-toned`/`text-dimmed` mixed with
  `text-muted`, no italics, no uppercase micro-labels, no `font-semibold` on a sentence. One exception: the commit
  range of a _What changed_ setup gap (`a1b2c3d..e4f5a6b since the last passing run`) is a line of facts and keeps the
  meta style.
- **Structure with layout, not styling**: a block with several kinds of lines gets one label column (as
  `SituationBlock`'s `<dl>`), never a badge, a color or a bold span to tell two lines apart.
- **The two failure pages share one rule each for Most likely and Next**: the execution page and the cluster page pick
  Most likely with `shared/most-likely.ts` and handle the Next actions through `useNextStepActions`, never with
  page-local logic.
- **The situation block reads explanation, then action, then context**, in the one order of `SITUATION_ROWS`
  (`app/utils/situation-rows.ts`). A page fills the lines it has; a new line is an entry of that list, never a
  reordering. Facts about the execution itself (since when, whether it is the latest) go in the meta line under the
  headline.
- **The situation block's left edge carries the page's status color** (`SituationBlock :edge`: the execution's outcome,
  the cluster state's dot). Nothing else in the block repeats it.
- **One accent color per screen: the primary action.** The solid `color="primary"` button is the only saturated element
  meant to be clicked. Every other button is `color="neutral"`: `variant="outline"` for a secondary action,
  `variant="ghost"` for a disclosure or a menu trigger; no `warning`, `success` or `soft` buttons for ordinary actions.
  A selection is neutral too: `SELECTED_TAB_CLASS` (a tab strip), `SEGMENTED_SELECTED_CLASS` (a segmented control),
  `SELECTED_ROW_CLASS` (the row that picks what the page shows), `CURRENT_ITEM_RING_CLASS` (the current item in a strip
  of status-colored marks), all in `app/utils/index.ts`. The one exception is a card's header icon (`CARD_ICON_CLASS`,
  marked `data-card-icon`). On the failure pages, `tests/unit/evidence-accent.test.ts` scans the evidence card's and the
  affected tests' components (add a new one to its list) and `tests/failure-page-accent.spec.ts` checks the rendered
  pages.
- **A link inside a sentence keeps the sentence's color**:
  `underline decoration-dotted underline-offset-2 hover:decoration-solid`. `text-primary` links are for navigation lists
  and tables.
- **Badges are for exceptions, two per screen at most**: the status chip and one exceptional state (_Quarantined_, a
  did-not-run cause). A strength, a confidence, an error type, a tag or a mark such as `@fixme` is plain meta text. Two
  red chips on one screen is a bug.
- **An icon only where it carries meaning the text does not** (a status dot, a disclosure or menu chevron, the check
  of a copied button), never in front of a label, a heading or a fact.
- **Code inside a heading or a sentence of the situation block sits in a chip**: a locator syntax-highlighted
  (`<LocatorCode chip>`, `<FailureHeadline chip>`), a commit in the sentence's color (`CODE_CHIP_CLASS`). Elsewhere in
  prose a locator stays plain mono (`<LocatorCode plain>`).
- **A recorded step renders from core's parts, never from its sentence**: `<BugStepText>` (from `describeStepInParts`
  or `describeExpectationInParts`) styles each name, value, key and code, in the steps list as in the situation block.
  Never split the Markdown sentence at its backticks or quotes.
- **Say a fact once, in one style**: when it could be a chip and words, keep the words.
- **Measure it.** `npm run app:measure -- --check` fails when the execution or failure-cluster page breaks a budget at
  1280×800 (`scripts/lib/detail-page-budgets.mjs`). Run it before committing a change to either page; CI runs it on the
  build (`Failure page budgets`), and raising a budget needs a reason in the PR. It finds the Next action by
  `data-next-action` and what it copies by `data-copies`: keep both when you move either. What it reports: the
  `run-app` skill.

## Filters

- **A page's filters sit in one `FiltersBlock`** (Home, a project page and Analytics use it), never in the navbar or
  loose above the content. Below `sm` it folds to the one-line summary the page passes (`filterBarSummary`,
  `app/utils/filter-summary.ts`).
- **What a filter hides is a note in the block, never an alert**: its `notes` slot names the count and the action that
  brings the rows back (`HiddenRunsNote`: _Include partial runs_, _Show all branches_). No full-width `UAlert`, no solid
  button.
- **A list's own controls stay with the list**: a search box, status chips, a sort or a window only one list reads go
  in its card or toolbar (`FilterToolbar`). Exception: the run page's outcome filter is the count bar in its header, so
  its Tests list has no status chips ([`adr/run-page-room.md`](../../../adr/run-page-room.md)).
- **A page shows its lists as the user left them** when they come back (Back, a breadcrumb, a link): search, filters,
  sort, open groups, page, _Show all_, scroll position. Hold that state with `useViewState(key, init)`
  (`app/composables/useViewState.ts`, kept per route path until a reload), never a plain `ref`: a `UTable` sort is
  `v-model:sorting` on a `useViewState` value, and a scrolling list calls `useViewScroll` on its scrolling element
  (`dashboardPanelBody(id)` for a `UDashboardPanel` body), keyed by tab when tabs share it.
- **Other view state keeps its own home**: a value the URL carries stays in the URL and wins over the kept one; a
  preference shared by every page of a kind stays a cookie (`useGroupByCookie`); a row selection or an open dialog
  stays a plain `ref`. Two components writing the query in the same tick go through `replaceQuery`
  (`app/utils/route-query.ts`).
- **Every tab of the project page that reads run history follows its filters' run scope** (`#shared/project-run-scope`:
  environments, branches, branch policy, full runs only). The page passes `projectRunScopeQuery(scope)`, the endpoint
  reads it with `parseProjectRunScope`, and its handler adds `projectRunScopeConditions`
  (`shared/handlers/project-run-scope.ts`). With no branch picked, the scope reads the default branch
  (`projectDefaultBranch`) and the runs that report none, as Analytics does. A new tab or endpoint that reads runs takes
  the scope; a request without its keys keeps its unscoped reading for API callers.

## Brand assets

- **Logos, favicons and app icons are generated, never edited by hand**:
  [`scripts/AGENTS.md`](../scripts/AGENTS.md#brand-assets). Show the wide lockup with `<BrandLogo>`, which swaps in the
  reversed drawing on a dark page. The accent (`primary` in `app/app.config.ts`) is the brand violet.
- **Every document Piwi writes for use outside the dashboard ends with the Piwi credit** of `shared/brand.ts` (the
  offline exports, the quality reports, the emails, and any new format): `piwiCreditHtml`, `drawPiwiCredit` for a PDF,
  `piwiCreditMarkdown`; `emailLayout` draws it in every email. The mark (`shared/brand-mark.json`) never loads over
  the network: inline SVG in HTML, vector paths in a PDF, an attachment in an email (`sendEmail` attaches it when the
  message shows it). Data files (CSV, XLSX, JSON) carry none.

## Test outcome colors

- **Each outcome has one color everywhere**: the `--color-status-*` tokens in `app/assets/css/main.css` (passed,
  failed, flaky, skipped, didn't run, running; violet is the accent, never an outcome). Timed-out and interrupted count
  as failed, a pass that needed a retry as flaky, and a `test.fixme()` skip is the second grey `fixme`
  (`isFixmeSkip` / `fixmeSkipPredicate`, `shared/utils/skip-kind.ts`), carved out of skipped as flaky is out of passed.
- **Never hardcode a status color** in a bar, chart, legend, dot, history cell, timeline bar or filter chip: use
  `STATUS_PALETTE` / `statusPalette(status, retries?)` (`app/utils/status-palette.ts`; `bg-status-*` in HTML,
  `var(--color-status-*)` in an SVG `style`), the shared `StatusFilterChip`, and `getStatusColor` for badges (`flaky` is
  a registered Nuxt UI color). A view needing another shade adds it to the palette entry, not to the component.
- **A pass rate takes its band and color from `app/utils/pass-rate.ts`** (`passRateTone`, `passRateTextClass`,
  `PASS_RATE_TONES`, `passRateStep` for heatmap cells), never from a threshold or color written at the call site.

## Other UI rules

- **Copy**: sentence case headings and labels ("Test runs"); relative dates through `formatRelativeTime` with the full
  timestamp on hover; human-readable durations with the exact ms on hover, or `DurationValue` where a tight `210ms`
  reads better than "0.21 seconds". A control whose purpose its label does not make obvious gets a `title`.
- **A duration in an execution's evidence** (a step or a request, on the Timeline, the Network tab or the trace's
  request list) is a `DurationValue`, never `Math.round(ms) + ' ms'`. It is colored only when `durationStandout`
  (`#shared/duration-standout`) says it stands out in its test or against its usual time (the `usual` the timeline
  sends, from `getUsualDurations`), in the one tone of `app/utils/duration-tone.ts`, never by a threshold at the call
  site. `tests/timeline-durations.spec.ts` checks which durations stand out. The Timeline and the Network tab read the
  timeline through `useExecutionTimeline`, one key per execution. Web Vitals keep their standard rating bands, in
  `text-error` and the warning tone.
- **Dates format through the locale helpers, never a hardcoded format**: `ClientDate`, `prettyDateFormat` and
  `formatRelativeTime` read the viewer's locale and time zone (`app/utils/locale-format.ts`), and the pure formatter is
  `formatAbsolute` in `#shared/i18n/locale-format` (`Intl`, never a hand-written `M/d/yyyy`). `en-US`, the default, is
  the format screenshots and tests expect.
- **Absolute timestamps render client-only**: the server and the browser rarely share a time zone. Render a date with
  `ClientDate`, and wrap a `title` tooltip that binds `prettyDateFormat` in `ClientOnly`. The same holds for anything
  formatted with the browser's locale (`toLocaleString()`, `viewerLocale()`).
- **Data several components of one page read under one key** (capability states, the project list) passes
  `dedupe: 'defer'` and `getCachedData: reuseWithinRender` (`app/utils/shared-fetch.ts`). Without them each caller
  fetches again during the server render.
- **What the first screen does not need loads in the browser** (`server: false`, `lazy: true`): a counter, a menu's
  contents, a card further down. What it shows, or what would make it jump (capability states hiding a tab), stays in
  the server render.
- **A `useFetch({ server: false })` loading state reads `status`, not `pending`**: gate the spinner on
  `status.value === 'idle' || status.value === 'pending'` (as `pages/projects/[id]/locators.vue`). The server renders
  `idle`, so gating on `pending` renders the empty state on the server and the spinner in the browser.
- **A tab-switched component fetches with `watch` + `$fetch`** on reactive triggers, not `useFetch({ lazy: true })`,
  which may not fire before mount, and mounts with `v-if`. The page passes props only for data it already fetched.
- **Spreadsheet exports people click are Excel (.xlsx), never CSV**: build them with `renderXlsx` / `plainXlsxTable`
  from `#shared/reports/render-xlsx` (imported lazily, `await import(...)`), and save them with
  `useDesktopDownload().saveBlob`, since a download link does nothing in the desktop shell. CSV stays for machine
  consumers (the API's `format=csv`, `/api/rollups`, the CLI).
- **Every search ignores case and accents** (`resume` finds `Résumé`): `foldText` on both sides and
  `foldTextWithOffsets` for highlights (`#shared/utils/fold-text`), `foldedContains` / `foldedEquals` in SQL
  (`#shared/utils/fold-text-sql`). Never `.toLowerCase().includes(...)` or `lower(col) LIKE ...`. A `UCommandPalette` /
  `UDashboardSearch` passes `:fuse="{ fuseOptions: { ignoreDiacritics: true } }"`; `USelectMenu` and `UInputMenu`
  already ignore both.
- **Test lists search and order one way**: `TestSearchInput` and the language of `#shared/test-search`
  (`compileTestSearch` in memory, `testSearchConditions` from `#shared/utils/test-search-sql` in SQL), `SearchHighlight`
  for matches, `app/utils/test-list-order.ts` for order and groups. Never a second search syntax, a separate tag, lock
  or browser filter next to it, or another describe-tree builder. A new qualifier is an entry of
  `TEST_SEARCH_FIELD_DEFS` plus its row in `apps/docs/reference/test-search.md`, which `docs-drift.test.ts` checks.
- **A source path is clickable**: render any repo-relative path or `file:line[:col]` with `OpenInIdeLink`, never a bare
  `<span>`/`<code>`. Pass `filePath` (with `line`/`column`) or `location`, plus `projectKey` (the project **id**) and
  `projectName` when in scope, so per-project workspace overrides resolve. IDE preferences are a per-browser client
  preference (`useOpenInIde`, `piwi-ide-prefs`), deliberately not in `SETTINGS_PAGES` and with no `PIWI_*` variable.
  Only the Piwi JetBrains plugin (`/api/piwi/open`, `PiwiOpenHandler.kt` in `apps/jetbrains`) confirms a file opened:
  the IDE Remote Control probe and the `vscode://` / `jetbrains://` launches never report a confirmed "opened".
- **Anything opened outside `$fetch` carries `useRuntimeConfig().app.baseURL`** (`window.open`, an `href`, a download
  URL): the demo is served from `/demo/` and its service worker only intercepts that prefix, so a root-relative
  `/api/...` 404s there. `fileApiUrl` and `getTraceViewerUrl` do it.

## Guide anchors, the guided tour and the demo

- **An element carrying `data-tour` is a guide anchor**: moving, renaming or removing it updates `shared/guide-anchors/`
  and every guide pointing at it in the same commit, and a block someone could ask about gets one
  ([`shared/guide-anchors/AGENTS.md`](../shared/guide-anchors/AGENTS.md)).
- **A change to a screen a tour stop or an authored guide shows updates that stop in the same commit**, in every tour
  language ([`utils/demo-tour/AGENTS.md`](utils/demo-tour/AGENTS.md)).
- **A UI-visible change updates the demo** (seed, demo handlers, simulator):
  [`demo/AGENTS.md`](demo/AGENTS.md#demo-data-requirements).
