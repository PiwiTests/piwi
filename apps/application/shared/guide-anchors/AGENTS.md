# Guide anchors and authored guides: agent guide

Rules for the guide anchor registry (`shared/guide-anchors/`), the guide engine (`useGuide`, `app/utils/guide/`) and
the authored guides (`app/utils/guides/`). Read [`../../AGENTS.md`](../../AGENTS.md) first. The demo's guided tour is
one guide: its own rules are in [`app/utils/demo-tour/AGENTS.md`](../../app/utils/demo-tour/AGENTS.md).

A guide is a list of stops, each a driver.js popover on one element of a page. A guide points only at **guide
anchors**: the registry lists every element a guide can name, by its `data-tour` attribute. It is plain ESM, like
`shared/demo/demo-examples.mjs`, so the app, the tests and `scripts/check-demo-runtime.mjs` read the same files: one
`.mjs` file per area of the dashboard (`layout`, `home`, …, `demo` for the demo banner), each exporting its anchors and
its coverage exemptions, joined in `index.mjs` as `GUIDE_AREAS` (a new area is one import and one entry there). The
entry shape and the meaning of each field are documented in `index.d.mts`.

## Anchors

- **One element per anchor.** Its `data-tour` value is static, kebab-case and names the content. It is set on exactly
  one element in one component: a template's `data-tour="…"`, or a static `'data-tour': '…'` key the component hands
  on (an item of a Nuxt UI menu, a `NavbarActions` action's `attrs`, a static `attrs` map spread with `v-bind`, as
  `settings/ai.vue`'s `ROLE_META` and `Toolbox.vue`'s `SECTION_ANCHORS`). Never a bound `:data-tour` or a computed
  string: the source test reads literals. An element can carry both `data-tour` and the harness's `data-shot`.
- **A demo-only anchor (`requires.demo`) is set in a component under `app/components/demo/`.**
- **`pages` lists the patterns of `app/pages` it renders on, the main one first**, or `['*']` alone for the layout and
  the demo banner. A route opens a pattern when each `[param]` is an id, or for `/analytics/d/[id]` a built-in
  dashboard's key (`PARAM_KEYS` in `shared/guide-stops.ts`, read from `BUILTIN_DASHBOARDS`).
- **`reveal` lists, in order, what makes the anchor show**: `{ query }` selects a tab or pane through the URL;
  `{ unfold: <anchor> }` clicks a folded section's toggle while it reads `aria-expanded="false"`; `{ open: <anchor> }`
  clicks the opener of a menu, drawer or modal when the anchor is not rendered, one step per level (as for the user
  menu's Open in IDE settings).
- **`parts` lists the parts inside it a stop can number**: an element inside the anchor's element carrying a static
  `data-tour-part` (one line of a block, one control of a row), each with its `id` (kebab-case, unique within the
  anchor), `describes` and, when it does not always render, `shownWhen`. The value is a template's
  `data-tour-part="…"` or a static `'data-tour-part': '…'` key of a map spread with `v-bind` (`SituationBlock`'s
  `ROW_PARTS`), never a bound value. `find_anchors` returns the parts, so the assistant numbers them too. The source
  test checks that every part is set in the source and every `data-tour-part` is a part; `check-demo-runtime.mjs`
  finds each part inside its anchor at the anchor's sample, which therefore shows every part.
- **`describes` and `shownWhen` are one sentence each, of 160 characters at most**, in the docs' voice. `sample` is a seeded demo route where it
  renders, with every `query` its reveal needs, the persona to act as and the `expect` the seed must hold there.
- **Four checks hold every anchor, and a new anchor ships with its sample and passes all four**:
  - `tests/unit/guide-anchors.test.ts`: the registry against the source (one element per id, every `data-tour` an
    anchor, the pages, the reveal, the sample route and query, the sentences, the capability);
  - `tests/unit/guide-anchor-coverage.test.ts`: the coverage below, each `kind` and each `help` key;
  - `tests/unit/demo-seed-consistency.test.ts`: each sample's `expect` against the generated seed;
  - `scripts/check-demo-runtime.mjs`: each sample in the built demo as its persona, revealed, then visible once
    scrolled into view. An element that is, or sits in, one with a computed opacity of 0 fails it, so a control shown
    only while the pointer is over its row is no anchor (anchor what always shows, such as the Failure inbox's keyboard
    line).
- **A change that moves, renames or removes an anchored element updates the registry in the same commit**, and the
  guides pointing at it (the tour's stops, the authored guides' stops).

## Coverage

- **Every block someone could ask about has an anchor.** The coverage test applies five rules (`page`, `tab`, `field`,
  `help`, `nav`, listed in its header), reads what each asks for from the source (`tests/unit/guide-anchor-source.ts`),
  and lists every item no anchor covers with the files that set it and the pages it renders on.
- **A new tab list the URL selects gets an entry in `TAB_LISTS`** (`guide-anchor-source.ts`). A tab held only in a
  component's state has no URL to reveal it, so it is anchored as a block.
- **An item that gets no anchor is exempted** in its area file's exemptions: `{ rule, key, reason }`, the key as the
  report names it (`/projects/[id]?tab=runs`, `case.network`, `ai.diagnosis`) and the reason in one sentence. The test
  fails on an exemption that names no item, names one an anchor covers, or repeats another.
- **Each item belongs to one area**, whose agent or change covers it (`fileArea` in `guide-anchor-source.ts`): a page,
  tab or field by its page's path; a help topic by `COMPONENT_AREAS` for its component, else the component's directory
  (`COMPONENT_DIR_AREAS`), else the first area it renders on (a `components/shared/` component), and `TOPIC_AREAS` for
  a topic set in several areas; a sidebar destination is `layout`. With `GUIDE_AREA=<area>` set,
  `npx vitest run tests/unit/guide-anchor-coverage.test.ts` asserts that area's items, anchors and exemptions only.

## Checking anchors in a browser

- **Check new anchors on a running server**:
  `node scripts/check-demo-runtime.mjs --url http://localhost:3000 --area <area>` (or `--anchors <id,id,…>`, or both)
  opens each sample on the dev server instead of the built demo; `npm run app:seed:dev` gives that server the demo's
  seeded ids. It skips an anchor whose sample acts as a persona or needs the demo build, since authentication is off
  on a dev server. `--anchors-only` checks the same selection in the built demo without the tours and the other checks;
  with no flag, the script checks everything in the built demo, as CI does.
- **An anchor of the desktop app (`requires.desktop`, its sample on `surface: 'desktop'`) is skipped by every other
  run, CI included**: check it with `node scripts/check-demo-runtime.mjs --desktop`, which boots a dev server with
  `NUXT_PUBLIC_DESKTOP=true` on a throwaway copy of the demo seed (port 3050) and the mocked Tauri bridge
  (`scripts/lib/desktop-bridge.mjs`). `--area` and `--anchors` narrow it; `--url` drives a desktop server already
  running.

## The engine

`app/composables/useGuide.ts` plays a `GuideRun` (`app/utils/guide/types.ts`); its pure parts are in
`app/utils/guide/` (`stopRoute`, the `**bold**` markup, `path.ts`).

- **Before each move it makes (another page, a query value, an `unfold` toggle, an `open` opener), the engine points
  at the control that makes it** for `WAY_MS`, a ring and its label (`piwi-guide-way`): the toggle or the opener; a
  link on the screen to the route (`linkMatch`), or to its page when the route is on another page; and when no link
  named the tab the move selected, that tab once selected (`role="tab"` with `aria-selected`, or a tab strip's item
  with `aria-current="true"`). A control that does not show gets no pointer.
- **The popover's first line (`piwi-guide-path`) says where the stop is**: the breadcrumb of the page's navbar without
  its home level, or its title, then the tab each query value of the anchor's reveal selects and the control of each
  other reveal step, the segments the move to the stop opened marked (`guidePath`). It reads the page, so a page
  keeps its breadcrumb or title in its `UDashboardNavbar`.
- **A stop's `points` are listed under its body (`piwi-guide-points`) and numbered on the page
  (`piwi-guide-badge`)**, each badge over its part inside the highlighted element; an item whose part does not render
  is marked `data-missing`.

- **The engine never lets `scrollIntoView` run**: the dashboard scrolls inside its content panel, and `scrollIntoView`
  would shift the layout around it. The engine scrolls the target's panels itself and stubs driver.js's own call on the
  target and the popover.
- **driver.js, its CSS and `app/assets/css/guide.css` load only when the first guide starts** (`loadEngine`): never
  import them statically.
- **The popover's attributes are what the checks read**: `data-guide`, `data-guide-stop`, `data-guide-anchor` (empty
  when the stop shows centered), `data-guide-settled` once settled, `lang` and the run's `dataset`. Keep them.
- **A stop whose anchor sits in what an `open` step opened (`opensLayer`) marks its popover `data-dismissable-layer`**,
  so Reka UI counts it as a layer opened from that one and Next taking focus leaves it open.
  `scripts/check-demo-runtime.mjs` plays a guide in the run's **Details** popover to hold it.

## Authored guides

Fixed guides for the tasks people ask about most (report a first run, configure AI, connect Jira, run the Flake Lab,
…), which need no model. The command palette's **Guides** group (`useAuthoredGuides().paletteGroups()`, in
`layouts/default.vue`) and the assistant panel's `AuthoredGuideList` list them on every instance, each filtered by its
`requires` against the capability states and `canAnywhere`. `app/utils/guides/` holds them: `guides.ts`
(`AUTHORED_GUIDES`), `resolvers.ts` (`GUIDE_RESOLVERS`) and `run.ts` (the `GuideRun`, `guide-<id>` on its popover).

- **A stop names a registry anchor, never a demo-only or desktop-only one**, on the anchor's main page when that is a
  fixed path, else on the `page` a resolver fills (the anchor's main page by default). Its docs link is the anchor's
  `doc`.
- **The guide's `requires` covers each stop's anchor**: the anchor's capability is the guide's, and every role holding
  the guide's permission holds the anchor's.
- **An entity's page comes from a resolver, never a seeded id.** `GUIDE_RESOLVERS` is a closed set, each reading API
  routes the demo serves too; a resolver that finds nothing makes its stops `absent` (shown centered). A new resolver
  lists the pages it fills, and must find its entity in the demo seed, or the built-demo walk fails.
- **Limits**: 3–7 stops; a stop title ≤ 60 characters and a body ≤ 360; 2–5 `points` of ≤ 160 characters each on a
  stop that numbers parts of its anchor, in reading order, the body introducing them; a guide title ≤ 60 and a
  one-line summary ≤ 80. English, in the docs' voice ([`apps/docs/AGENTS.md`](../../../docs/AGENTS.md#voice)); `**bold**` the only
  markup, a dashboard label bold and spelled as the screen shows it. A stop on the page the guide is already on adds
  no query value, since a page reads its `?tab=` when it opens. No stop on an anchor inside a modal.
- **Checks**: `tests/unit/authored-guides.test.ts` (the anchors, pages, resolvers, `requires` and limits; every bold
  label against the source of the component setting or carrying the stop's anchor, or the page's files, so a renamed
  label fails; the resolvers on stubbed routes; the docs page listing every guide), `tests/guides.spec.ts` (the palette
  and the panel with no model, a declined capability), and `scripts/check-demo-runtime.mjs`, which starts every guide
  from the palette in the built demo and walks it, each stop with its line saying where it is and a number on the page
  for each point, one guide at 390 px.
- **A change to a screen a guide stop shows updates the guide in the same commit**, as for the tour: moving or renaming
  an anchored element, renaming a label a stop puts in bold, a change that makes a resolver find nothing in the seed. A
  new or renamed guide updates the table of `apps/docs/features/guides.md`.
