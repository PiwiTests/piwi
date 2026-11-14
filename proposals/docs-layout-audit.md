# Docs layout audit: one sidebar for a dashboard and five tools

An audit of how the documentation site (`apps/docs/`) is laid out: the top navigation, the four sidebars, the feature
catalog that renders one of them, and where a reader of each tool finds its pages. State audited: `main` at v0.69.0
(`e3ddb84b`), 2026-11-14. It follows [`docs-restructure.md`](../adr/docs-restructure.md) (v0.26.1) and
[`docs-revamp.md`](../adr/docs-revamp.md) (v0.39.0), whose mechanisms shipped and are measured here against the site
they now hold.

**Status.** Proposed 2026-11-14. Built, by the pull request that adds this audit:

- **Step 1 of [the plan](#the-plan)**, all six items but one link. The Features groups are collapsed; the loop page
  is linked from the landing page, Getting started, Editor extensions and Browser extension, Tracing from Metrics and
  the Production checklist, What Piwi does from Getting started; the Reference sidebar has six groups; Codex CLI and
  DeepSeek CLI are nested under AI provider; `FeatureNeed` has `editor`, on the catalog entries and pages of the
  editor's features; Getting started has a section on where the tests are written. Left out: the loop page's link on
  Desktop app, a page at its word budget.
- **Step 2, the Tools section and the regrouping**, with every URL kept (decision 3) and the four jobs' wording left
  as it is (decision 2, not taken). The catalog's groups are the nine of Features below, five tool groups marked
  `section: 'tools'` and Self-hosting. `toolsSidebar()` renders the Tools sidebar: a tool's own page is its group's
  heading, and entries that share a `part` sit under its label. Each tool page is a sidebar key of its own, and the
  top navigation's patterns are built from the same list. The landing page shows seven cards: a job's card counts
  the narrower groups after it, and one card stands for the tools. Where it differs from the tree below: Explain the
  failures comes before Watch a run, so each narrower group follows its job; UI overview and Guides stay in Keep the
  history, with no Overview group; nothing is nested in the Features sidebar (Live view of a run and its three pages
  are siblings); the extension's bug pages sit under "Bugs"; Tools has no Command line group, the CLI staying in
  Reference; Remote development is a catalog entry, under Editor extensions. The Reference sidebar, at 1,225 px, is
  the one sidebar taller than a screen.

Step 3 and what was not done are under [Left for later](#left-for-later). What the pages say, as opposed to where
they are, is audited in [`docs-content-audit.md`](docs-content-audit.md).

**Summary.** The rules of the two earlier records work: every feature has its own page, no page is a 6,000-word dump,
nothing is copied, and the catalog keeps the sidebar, the landing page and All features in step. What they did not
plan for is volume and a second kind of feature. The site went from 65 pages to 153 in seven weeks, and 40 of the 93
feature pages now document a tool the reader installs (the editor extensions, Piwi Picker, the desktop app, Piwi
Runner, the agent surface) rather than something the dashboard does with results. The catalog groups features by job,
so those 40 pages sit in two groups by activity, and each tool is cut in two. The Features sidebar is 98 links in
seven open groups, 4.2 screens tall, with the page a reader needs first, Editor connection, as its last link. The
fix is not another rewrite: collapse the groups (one line, measured below), give hub pages their children, and add a
**Tools** section beside Features so a tool's pages sit together.

**Method.** The sidebars and the catalog were rendered from `.vitepress/navigation.ts` and
`apps/application/shared/piwi-features.ts`. Every hand-written page was measured: words outside code blocks,
headings, links in and out. The site was built and each sidebar measured in a 1440 × 900 browser window. Pages were
read for their opening, headings and the sections that share a heading with another page, not line by line against
the code: this audit is about where things are, not whether each sentence is true. Word counts are this audit's own
and can differ by a few words from the drift test's.

## By the numbers

| Measure | v0.26.1 (Sep 5) | v0.39.0 (Sep 26) | v0.69.0 (Nov 14) |
|---|---:|---:|---:|
| Pages | 40 | 65 | 153: 146 hand-written, 7 generated |
| Hand-written words, blog excluded | about 60,000 | about 82,000 | about 177,000 |
| Features sidebar | 38 links, the whole site | 29 links in 2 groups | 98 links in 7 groups |
| Largest sidebar group | 38 | 22 | 25, then 24 |
| Catalog entries | none | 84 at v0.63.0 | 102 |

| Sidebar | Links | Groups | Height in a 900 px window |
|---|---:|---:|---:|
| Guide | 17 | 3 | 904 px |
| Features | 98 | 7 | 3,788 px |
| Self-hosting | 18 | 4 | 1,003 px |
| Reference | 20 | 1 | 900 px |

Where the 93 feature pages go, by what they document:

| Subject | Pages | Words |
|---|---:|---:|
| What the dashboard does with results | 53 | 61,700 |
| Editor extensions (VS Code, JetBrains) | 14 | 19,000 |
| Piwi Picker | 13 | 13,700 |
| Desktop app and Piwi Runner | 5 | 6,200 |
| Coding agents (MCP server, skills, run control) | 3 | 3,900 |
| A local run across tools (the loop, watching, ending, sharing) | 5 | 5,800 |

## What works and should stay

- **One page per feature, one catalog.** No page has grown past its budget, and All features, the landing cards and
  the sidebar never disagree.
- **Sections are not copied.** 19 headings appear on two pages. The ones sampled hold a two-line pointer on one of
  them (`ai-diagnosis#enabling-ai-diagnosis` to the AI provider page, `editors#ci-failures-in-the-problems-panel` to
  Failures in the editor), kept so the anchor survives.
- **The Guide and Self-hosting sidebars fit about one screen**, and their groups answer one question each.
- **The drift test** makes every move below safe: it names each link a moved page breaks.

## Findings

### L1. The Features sidebar is 98 links, all of them open

`featuresSidebar()` sets `collapsed: false` on every group, so the sidebar is 3,788 px tall and "Editor connection"
sits at 3,636 px. `docs-revamp.md` planned the opposite: "Groups collapse, so only the reader's current group is
open." Tried on a local build: with `collapsed: true` the sidebar is 900 px on the first page and 1,344 px with the
largest group open, and VitePress opens the group that holds the current page by itself. The voice rules already say
why it matters: past about eight bullets nobody reads them.

### L2. The catalog has one axis, and the features now have two

The groups are jobs (keep the history, explain the failures, hand back a fix, find what the tests miss) and two
"routes". That fits the 53 dashboard pages. The 40 tool pages have a second property the reader cares about more:
which tool it is. They sit in **Write and debug tests** (14) and **Use it from elsewhere** (25), split by activity,
so each tool is in several places:

| Tool | Where its pages are |
|---|---|
| Editor extensions | 8 in Write and debug tests, 6 in Use it from elsewhere, 1 in Guide → Set up (Remote development) |
| Piwi Picker | 11 in Use it from elsewhere, 2 in Write and debug tests (Runs window, Piwi Picker and your editor) |
| Coding agents | 2 in Use it from elsewhere, 1 in Write and debug tests (Run control for agents) |
| `piwi` CLI | Reference only; a tool with 16 commands has no place among the tools |

Use it from elsewhere lists, in order: the MCP server, agent skills, three desktop pages, two Run on my machine
pages, eleven Piwi Picker pages, the test functions catalog, and then the editor pages, whose hub is entry 21 of 25.

### L3. Hub pages look like leaves

Five pages are maps of other pages: UI overview, Write, run and fix a test, Editor extensions, Browser extension and
Desktop app. `SidebarItem` has a `text` and a `link` and no `items`, so a hub has the rank of its children and is not
placed before them: the editor hub comes after eight of its pages, in another group. VitePress nests sidebar items,
each level collapsible.

### L4. The page for the loop cannot be found

`features/write-run-fix.md` was written to answer DOC1 of
[`developer-loop-audit.md`](developer-loop-audit.md). Two things link to it: the sidebar and the generated All
features table. The landing page's *I write Playwright tests* list does not, nor do Getting started, Editor
extensions, Browser extension or Desktop app. Other pages with almost no way in:

| Page | Links from other hand-written pages |
|---|---:|
| `operate/tracing` | 0 |
| `guide/what-piwi-does` | 1 (Why Piwi?) |
| `features/run-video`, `local-runs-tray`, `run-issues`, `test-management`, `guide/deepseek-cli`, `operate/localization` | 1 each |

### L5. The newcomer path ends at the dashboard

Getting started names the desktop app and Piwi Runner; it does not mention the editor extensions or Piwi Picker. The
landing page gives them one bullet and two gallery captions. In What Piwi does, the prose of "The pieces" names neither the editor extensions
nor Piwi Runner (the figure does). The complete table of pieces is the ninth section of All features, a reference
page. Where to install each tool is on four feature pages under three headings ("Where it is", "Install and
connect", "Install and start").

### L6. The framing text is behind the catalog

What Piwi does, the intro of All features and the header comment of the catalog all say: four jobs, and everything
else is a delivery route for them. Recording a test, running it from the editor and stopping it at a breakpoint
deliver no result to anyone: Write and debug tests is a fifth job in everything but the text.

### L7. The word budget now shapes the pages

49 of the 130 budgeted pages are within 5% of their budget, 38 of them feature pages. The budget did its job against
dumps. With a flat sidebar it has a cost the earlier records did not meet:

- **A split is a new sibling.** Watching a run is seven pages, told apart only by wording (L8).
- **True facts stay out.** The status of `developer-loop-audit.md` records two: `globalTimeout` and the hooks left
  out of the Breakpoints page's limits, and the bundled Node left off the Desktop app page, "both pages at their word
  budget".

Raising the budget brings the dumps back. Nesting (L3) removes the cost: a page split under its parent adds no entry
at the level the reader scans.

### L8. Labels that cannot be told apart

| Cluster | Labels |
|---|---|
| Watching | Watch a run · Live view of a run · Watch all workers · Watch a running test · Inspect a running test's page · Share a run live |
| Runs | Runs from the editor · Runs started outside Piwi · Runs window · Desktop app runs · Local runs tray · Run on my machine · Piwi Runner |
| Bugs | Report a bug · Bug reports · Replay a bug report |
| "Extension" and "editor" | Editor extensions · Editor connection · Extension connection · Browser extension · Open in editor · Piwi Picker and your editor |
| One word, two things | Guides (a feature) and Guide (the section) · Metrics (the metric catalog) and Metrics and rollup export · Integrations (Jira Cloud only) and Backend instrumentation (the `integrations/` packages) · Developer tools (Piwi Picker's DevTools panel) |

Most of these need no rename once the page has a parent: "Connection" under Piwi Picker, "Runs" under Desktop app.

### L9. Entries filed where few would look

- **Explain the failures** (20 pages, 4 recipes): seven pages are about watching a run while it goes, four about
  time and machine resources (Slow tests, Resource leaks, Leak history, CPU, memory & disk).
- **Hand back a fix** (16 catalog entries): four issue-tracker pages, three about choosing which tests to run (Test selections,
  Impact from a diff, Reuse forecast), and AI steps, which is a way to write tests. `docs-revamp.md` raised the last
  two groups of these in its first decision; the group has doubled since.
- **Keep the history**: UI overview and Guides, two navigation aids.
- **Guide → Set up**: Codex CLI and DeepSeek CLI are siblings of AI provider, whose sub-pages they are.

### L10. Three features have no entry in the Features sidebar

The sidebar keeps the catalog entries whose page is under `features/`. Import past runs and Backend logs live in the
Guide (the second under another name, Backend instrumentation). The third is the **CI merge gate**: its catalog entry
points to the whole CLI reference, 6,071 words, with no anchor. The gate has no page. It is explained in six places:
`guide/ci#blocking-a-merge`, `pr-feedback#the-gate-verdict`, `environment-incidents#the-ci-gate`,
`uncovered-changes#the-gate-flags`, the `gate` section of the CLI reference and the reporter options.

### L11. The editor features carry no prerequisite

`FeatureNeed` has `desktop` and `extension` and no value for the editor extensions. All features says Runs from the
editor and Failures in the editor need "reporter", and their pages show no chip for the tool they are part of.

### L12. Reference is one list of 20, and Core concepts is 7,410 words

The Reference sidebar has one group, in no order a reader could guess (Coverage cost between Reporter options and
Test metadata). Core concepts is the third step of Get started and holds 53 sub-headings, because every new term is
added to it: the live-run and Test Map vocabularies alone are 300 lines. 52 pages link into it, so its anchors must
stay; its place in the newcomer path need not.

### L13. Self-hosting, small things

- **Integrations is the Jira Cloud page**, with Zephyr Scale Cloud as its sibling: the label says more than the page.
- **Tracing with OpenTelemetry** sits under Data, with Metrics; both are observability.
- **Configuration reference and generator** are listed here and live under `/reference/`: a click swaps the sidebar.
- **The catalog's Self-hosting group lists 6 of the 16 operator pages**, so its landing card reads "6 features".

### L14. File names that say something else than the page

`ide-integration` (Open in editor), `test-management` (Results in Zephyr Scale), `backend-logs` (Backend
instrumentation), `change-impact` (Impact from a diff), `live-view-layers` (Page events, text and filmstrip),
`devtools` (Developer tools), `comparison` (Why Piwi?), `project-access` (Access, roles and groups). Each costs a
contributor a search and nothing to a reader. Rename one only when its page moves anyway.

## Against the app's own structure

The dashboard was started on the seeded data and walked. Its structure agrees with the layout proposed below more
than with the one the site has.

- **The app has a Tools page.** Settings → Companion tools ("Piwi tools" in the user menu) lists Piwi Picker, the
  desktop app, the reporter CLI, the MCP server and agent skills, the editor extensions and Open in editor, each
  with its install link and a link to its docs page. That is the Tools section, already drawn: the section takes
  those entries, and Piwi Runner, which the page lacks.
- **Each proposed group is one place in the app**, where "Explain the failures" today spans five:

| Proposed group | Its place in the dashboard |
|---|---|
| Keep the history | Home; Project → Runs |
| Watch a run | a running run's page |
| Explain the failures | Project → Failures (Clusters, Flaky, Quarantine) and Flake Lab; the execution and cluster pages |
| Time and resources | Project → Performance; Run → Timeline and Resources |
| Hand back a fix | the execution page's More ways to fix; Settings → Pull requests and Auto-heal |
| Issue trackers | Settings → Integrations; Project → Settings → Issue tracker and Test management |
| Run the right tests | Project → More actions → Selections |
| Find what your tests miss | Project → Coverage (Gaps, Map, Code) |
| Trends and reports | Analytics and Quality reports, in the main navigation |
| Tools | Settings → Companion tools |

- **The names differ.** The group is "Find what your tests miss", the tab is Coverage and the capability is
  "Scenario gaps"; "Time and resources" is the Performance tab. The job names are the product's positioning and can
  stay, if each group's intro line names its place, on the sidebar's landing and on All features.
- **The places are written by hand, and wrong.** The catalog's `where` hints name three tabs the app does not have,
  and the UI overview misses a run tab, five sections of a project's Settings and several pages:
  [`docs-content-audit.md`](docs-content-audit.md#docs-against-the-dashboards-structure) lists them and proposes
  one list of places that the app, the catalog and the drift test read.

## The proposed layout

Top navigation: **Guide · Features · Tools · Self-hosting · Reference · Blog · Demo**. Features keeps what the
dashboard does with results; Tools holds what the reader installs. Every group is collapsed until the reader is in
it, and `›` marks children nested under their parent.

```
Features                          53 pages, 5 recipes, 1 new page
  Overview                   UI overview · Guides · All features (link)
  Keep the history           Branches · What changed in a run · Offline export · Share links · Import past runs (link)
  Watch a run                Watch a run · Live view of a run › Watch all workers, Page events, text and filmstrip,
                             Inspect a running test's page · Share a run live · Stuck tests
  Explain the failures       3 recipes · Failure evidence › Run video · Failure clusters & the inbox ·
                             Environment incidents · Run environment · Flaky tests & quarantine › Flake Lab ·
                             AI diagnosis · Assistant
  Time and resources         1 recipe · Slow tests & wasted time · Resource leaks › Leak history in CI ·
                             CPU, memory & disk
  Hand back a fix            1 recipe · Locator healing · Who uses a locator · Locator preflight ·
                             Fix plans, reproduce & bisect · Auto-heal PRs · Pull-request feedback ·
                             CI merge gate (new) · Re-run in CI
  Issue trackers             Issue tracking (Jira) › Issues about a run or a test, Issue automation ·
                             Results in Zephyr Scale
  Run the right tests        Test selections · Impact from a diff · Reuse forecast
  Find what your tests miss  the 8 pages it has
  Trends and reports         the 5 pages it has

Tools                             41 pages
  Write, run and fix a test  the loop page, as the section's first page · Watch a running test · End the test ·
                             AI steps
  Editor extensions          Editor extensions (hub)
                               Set up        Editor connection · JetBrains plugin · Remote development (from Guide)
                               Write         Record tests from the editor · Recorded code
                               Run and debug Runs from the editor · Runs started outside Piwi ·
                                             Breakpoints in the browser · Pause and step from the editor ·
                                             Code from a pause · Debug in my editor
                               Read results  Failures in the editor · Coverage in the editor · Open in editor
  Piwi Picker                Browser extension (hub)
                               Set up        Extension connection · Piwi Picker and your editor
                               On the page   Pick an element · Record actions · Lint overlay · Tested elements
                               DevTools      Developer tools · Mock and slow down requests
                               Bug reports   Report a bug · Replay a bug report · Bug reports
                               Runs window
  Desktop app                Desktop app (hub) · Desktop app runs · Local runs tray · Run on my machine › Piwi Runner
  Coding agents              MCP server · Agent skills · Run control for agents · Test functions catalog ·
                             MCP tools (link)
  Command line               Piwi CLI (link)

Reference                         20 entries in 6 groups
  Product         All features · What's new
  Configuration   Configuration reference · Configuration generator · Reporter options · Coverage cost
  Reporter & CLI  Piwi CLI · Test metadata · Steps file format · Bug report file format
  Analysis rules  Clue rules · Locator stability rules · Gap detectors & exposure
  Dashboard       Test search · Keyboard shortcuts · Analytics widgets · Metrics
  Automation      MCP tools · Notification events & webhooks · API docs
```

The longest list a reader faces is one open group: 12 entries for Explain the failures, 15 for Editor extensions in
four labeled sub-groups, against 98 today.

**The catalog stays the one grouping.** Its groups change to the ones above, each with a `section` (`features` or
`tools`), and an entry may name a `parent`. `featuresSidebar()` renders two sidebars from it; All features gains the
same groups; the landing page shows one card per job and one for Tools, to stay within eight.

**URLs.** VitePress picks a sidebar by path prefix, and every tool page is under `/features/`. Either the Tools
sidebar is keyed by each page's own path, and no URL moves, or the 41 pages move to `/tools/` with 41 rows in
`public/404.html` and the in-app `doc:` links the drift test names. The first is cheaper and is what this audit
recommends; it needs one check that no Features page's path starts with a Tools page's path.

## The plan

**Step 1, no decision needed (one pull request, no URL moves), built:**

1. `collapsed: true` on the Features groups (L1).
2. Links to the loop page from the landing page, Getting started, and the three tool hubs; a link to Tracing from
   Metrics and the Production checklist; What Piwi does linked from Getting started (L4).
3. The Reference sidebar in six groups (L12).
4. Codex CLI and DeepSeek CLI nested under AI provider, which gives `SidebarItem` its `items` (L3, L9).
5. An `editor` value in `FeatureNeed`, with its chip linking Editor extensions (L11).
6. A next step in Getting started, "where you write the tests", naming the editor extensions and Piwi Picker (L5).

**Step 2, after decisions 1 to 3:** the catalog's new groups and `section`, the Tools section in the top navigation,
hubs with their children, and the framing text of What Piwi does, All features and the catalog comment (L2, L3, L6,
L8, L9).

**Step 3, each on its own:** a CI merge gate feature page that the six places link (L10); Core concepts cut to the
object model and the dozen terms a first run meets, with the rest as a glossary in Reference under the same anchors
(L12); the Self-hosting items (L13).

## Decisions for you

1. **Tools as its own section.** Recommended. The alternative regroups inside Features only: it fixes the order and
   the nesting and leaves 94 pages behind one top-navigation item.
2. **Is writing and debugging tests a fifth job?** The docs already treat it as one. Saying so changes "the four
   jobs" in `ROADMAP.md`, What Piwi does and the positioning of the tools; the alternative words it as the first
   group of Tools and leaves the four jobs alone.
3. **Keep every URL** (per-page sidebar keys) or move the tool pages to `/tools/`. Recommended: keep.
4. **The budget stays at 1,500 words, with nesting as the way to split.** Recommended over raising it.
5. **Core concepts as a short page plus a glossary.** Recommended; the anchors stay where the drift test finds them.
6. **Groups named for the job, with the place in the intro**, or renamed after the app's tabs (Coverage, Performance).
   Recommended: the first. The same question stands for the app, which groups its capabilities a third way
   ([`docs-content-audit.md`](docs-content-audit.md#what-the-app-could-change), item 13).

## Left for later

- **A CI merge gate page** (L10), and Core concepts as a short page plus a glossary (L12).
- **The Self-hosting items** (L13) and the file names that differ from their page's title (L14).
- **The loop page's link on Desktop app**, and a place for the `piwi` CLI among the tools.
- **Nesting inside a Features group**: Live view of a run over its three pages, Resource leaks over Leak history.
- **The Reference sidebar**, a screen and a third tall since it has six groups.
- **Decision 2**: whether writing and debugging tests is a fifth job in `ROADMAP.md` and What Piwi does.
