# Guide anchors and authored guides: agent guide

Rules for the guide anchor registry (`shared/guide-anchors/`), the guide engine (`useGuide`, `app/utils/guide/`) and
the authored guides (`app/utils/guides/`). Read [`../../AGENTS.md`](../../AGENTS.md) first. The demo's guided tour is
one guide: its own rules are in [`app/utils/demo-tour/AGENTS.md`](../../app/utils/demo-tour/AGENTS.md).

## The registry and the engine

A guide is a list of stops, each a driver.js popover on one element of a page; the demo's guided tour is one. A guide
points only at **guide anchors**: the registry in `shared/guide-anchors/` lists every element a guide can name, and
nothing else can be pointed at. It is plain ESM, like `shared/demo/demo-examples.mjs`, so the app, the tests and
`scripts/check-demo-runtime.mjs` read the same file: one `.mjs` file per area of the dashboard (`layout`, `home`,
`analytics`, `projects`, `runs`, `executions`, `clusters`, `test-cases`, `setup`, `settings`, and `demo` for the demo
banner), each exporting its anchors and its coverage exemptions, joined in `index.mjs` as `GUIDE_AREAS` (a new area is
one import and one entry there), with the entry shape in `index.d.mts`. An entry has:

- `id`, the value of the element's `data-tour` attribute;
- `kind`, what it names (`GUIDE_ANCHOR_KINDS`): `page` (a page's heading area), `tab` (a tab's panel, selected by its
  `query` reveal), `block` (a section or card), `row` (one row of a list, the first one shown), `field` (a settings
  field), `action` (a primary action button, or the button opening a menu) or `nav` (a sidebar destination);
- `pages`, the patterns of `app/pages` it renders on (`/test-run-cases/[id]`, `/`), the main one first, or `['*']` for
  the layout and the demo banner; a route opens a pattern when each `[param]` is an id, or for `/analytics/d/[id]` a
  built-in dashboard's key (`/analytics/d/engineering`; `PARAM_KEYS` in `shared/guide-stops.ts`, read from
  `BUILTIN_DASHBOARDS`);
- `reveal`, what the engine does before the anchor shows, in order: `{ query }` (a tab or pane selected through the
  URL), `{ unfold: <anchor> }` (clicks the anchor, the toggle of a folded section, while it reads
  `aria-expanded="false"`; an open section, or an anchor that is no toggle, stays as it is),
  `{ open: <anchor> }` (clicks the opener of a menu, drawer or modal when the anchor is not rendered; one step per
  level, as for the user menu's Open in IDE settings);
- `describes` and `shownWhen`: one sentence each, in the docs' voice, on what the block shows and when it renders;
- `requires`: the capability, permission, desktop shell or demo build it needs; `help`: the `HELP_TOPICS` key of the
  inline help the block carries; `doc`: its docs page;
- `sample`: a seeded demo route where it renders (with every `query` its reveal needs), the persona to act as and
  the `expect` the seed must hold there.

The engine is `app/composables/useGuide.ts`: `start(run)` takes a `GuideRun` (`app/utils/guide/types.ts`: an id, a
language, the stops with their copy, the words of the popover's controls) and opens each stop's route (else its
anchor's main page when that is a fixed path), runs the anchor's reveal, scrolls the panels holding it and highlights
it. Its pure parts are in `app/utils/guide/` (`stopRoute`, the `**bold**` markup). A stop whose anchor does not render
shows centered, with the anchor's `shownWhen` under its body; an `absent` stop does so at once, without opening a page
or waiting. A stop whose anchor sits in what an `open` step opened (`opensLayer`) marks its popover
`data-dismissable-layer`, so Reka UI counts it as a layer opened from that one: Next taking focus leaves a popover
holding the anchor open (`scripts/check-demo-runtime.mjs` plays a guide in the run's **Details** popover to hold it).
Until the user scrolls, clicks or types, the engine scrolls a target that content loading above pushed out of view
back into it. The popover carries `data-guide`, `data-guide-stop`, `data-guide-anchor` (empty when centered),
`data-guide-settled` once settled, `lang` and the run's `dataset`, which is what the checks read;
`app/assets/css/guide.css` themes it (`piwi-guide*` classes).

- **One element per anchor**: an anchor's `data-tour` value is static (never a bound `:data-tour`), kebab-case, names
  the content, and is set on exactly one element in exactly one component: a template's `data-tour="…"`, or a static
  `'data-tour': '…'` key the component hands on: on an item of a Nuxt UI menu (the sidebar's and the user menu's
  items), which passes it to the item's link; in a `NavbarActions` action's `attrs`; or in a static
  `attrs: { 'data-tour': '…' }` (or a map of them) spread with `v-bind`, as `settings/ai.vue`'s `ROLE_META` puts one
  on each role's form and `Toolbox.vue`'s `SECTION_ANCHORS` on each section's toggle. The value stays a literal the
  source test reads, never a computed string. An element can carry both `data-tour` and the harness's `data-shot`. A
  demo-only anchor (`requires.demo`) is set in a component under `app/components/demo/`.
- **Four checks hold every anchor.** `tests/unit/guide-anchors.test.ts` checks the registry against the source:
  each id is the `data-tour` of exactly one element and every `data-tour` is an anchor, each page is a file of
  `app/pages`, a reveal names anchors on the same page, the sample route opens one of its pages with its reveal's
  query, the sentences fit (≤ 160 characters, one sentence) and the capability exists.
  `tests/unit/guide-anchor-coverage.test.ts` checks the coverage below, each `kind` and each `help` key.
  `tests/unit/demo-seed-consistency.test.ts` checks each sample's `expect` against the generated seed, as for a demo
  example. `scripts/check-demo-runtime.mjs` opens every sample in the built demo as its persona, runs the reveal and
  finds the anchor visible once scrolled into view, one check per anchor; an element that is, or sits in, one with a
  computed opacity of 0 fails it, so a control shown only while the pointer is over its row is no anchor (anchor what
  always shows, such as the Failure inbox's keyboard line).
- **Every block someone could ask about has an anchor.** The coverage test reads what each rule asks for from the
  source (`tests/unit/guide-anchor-source.ts`) and fails listing every item no anchor covers, with the files that
  set it and the pages it renders on:
  - `page`: every page pattern of `app/pages` has an anchor of kind `page` listing it;
  - `tab`: every tab the URL selects has an anchor of kind `tab` on its page whose `query` reveal is exactly the
    tab's: the project page's tabs, Failures segments and Settings sections, the run's, test's and bug report's tabs,
    and the execution's evidence tabs (`TAB_LISTS`, each read from its list in the code; a new tab list the URL
    selects gets an entry there). A tab held only in a component's state has no URL to reveal it, so it is a block;
  - `field`: every field of `SETTINGS_PAGES` has an anchor of kind `field` on its page whose `help` is the field's;
  - `help`: every help topic a `.vue` file sets statically (`help="…"`, `<HelpHint topic="…">`, a literal in a bound
    `:help` or `:topic`, `help: '…'` in the script) is the `help` of an anchor;
  - `nav`: every destination of the sidebar's items in `app/layouts/default.vue`, which the command palette lists
    too, carries the `data-tour` of an anchor of kind `nav`.
- **An item that gets no anchor is exempted** in its area file's exemptions: `{ rule, key, reason }`, the key as the
  report names it (`/projects/[id]?tab=runs`, `case.network`, `ai.diagnosis`) and the reason in one sentence. The
  test fails on an exemption that names no item, names one an anchor covers, or repeats another.
- **Each item belongs to one area**, whose agent or change covers it: a page, tab or field by its page's path; a help
  topic by the directory of the component setting it (`COMPONENT_DIR_AREAS`), else `COMPONENT_AREAS` for a component
  that renders on another area's pages, the first area a `components/shared/` component renders on, and
  `TOPIC_AREAS` for a topic set in several areas; a sidebar destination is `layout`. With `GUIDE_AREA=<area>` set,
  `npx vitest run tests/unit/guide-anchor-coverage.test.ts` asserts that area's items, anchors and exemptions only.
- **Check new anchors on a running server**:
  `node scripts/check-demo-runtime.mjs --url http://localhost:3000 --area <area>` (or `--anchors <id,id,…>`, or
  both) opens each sample on the dev server, once it hydrates, instead of the built demo. It skips an anchor whose sample acts as a persona or that needs the demo build, since authentication
  is off on a dev server; `npm run app:seed:dev` gives that server the demo's seeded ids. `--anchors-only` checks the
  same selection in the built demo, without the tours and the other checks. With no flag, the script checks
  everything in the built demo, as CI does.
- **An anchor of the desktop app** (`requires.desktop`, its sample on `surface: 'desktop'`) is skipped by those runs
  and checked by `node scripts/check-demo-runtime.mjs --desktop`: the screenshot harness's desktop mode, a dev server
  started with `NUXT_PUBLIC_DESKTOP=true` on a throwaway copy of the demo seed (booted on port 3050 for the run), with
  its mocked Tauri bridge (`scripts/lib/desktop-bridge.mjs`) and a linked folder. `--area` and `--anchors` narrow it;
  `--url` drives a desktop server already running instead.
- **A change that moves, renames or removes an anchored element updates the registry in the same commit**, and the
  guides pointing at it (the tour's stops, the authored guides' stops) with it. A new anchor ships with its sample and
  passes all four checks.
- **The engine never lets `scrollIntoView` run**: the dashboard scrolls inside its content panel, and
  `scrollIntoView` would shift the layout around it, so the engine scrolls the target's panels itself and stubs
  driver.js's own call on the target and the popover. driver.js, its CSS and `guide.css` load only when the first
  guide starts (`loadEngine`).

### Authored guides

Fixed guides for the tasks people ask about most (report a first run, configure AI, connect Jira, run the Flake Lab,
…), which need no model: the command palette's **Guides** group (`useAuthoredGuides().paletteGroups()`, in
`layouts/default.vue`) and the assistant panel's empty and unavailable states (`AuthoredGuideList`) list them on every
instance, each filtered by its `requires` against the capability states and `canAnywhere`. `app/utils/guides/` holds
them, all pure: `guides.ts` (`AUTHORED_GUIDES`, each guide's id, title, summary, lucide icon, keywords, `requires` and
stops), `resolvers.ts` (`GUIDE_RESOLVERS`) and `run.ts` (the `GuideRun` the engine plays, `guide-<id>` on its popover).

- **A stop names a registry anchor**, never a demo-only or desktop-only one, on the anchor's main page when that is a
  fixed path, else on the `page` a resolver fills (the anchor's main page by default). Its docs link is the anchor's
  `doc`. The guide's `requires` covers each stop's anchor: the anchor's capability is the guide's, and every role
  holding the guide's permission holds the anchor's.
- **An entity's page comes from a resolver**, never a seeded id: `GUIDE_RESOLVERS` is a closed set (the project
  updated last, the newest finished run, a failure of the newest failed run, a failure with a locator fix, the open
  cluster seen last, the flakiest test and its project, the first saved dashboard the user can edit), each reading API
  routes the demo serves too. A resolver that finds nothing makes its stops `absent`. A new resolver lists the pages it
  fills, and every one must find its entity in the demo seed, or the built-demo walk fails.
- **Limits**: 3–7 stops; a title ≤ 60 characters and a body ≤ 360, a guide title ≤ 60 and a one-line summary ≤ 80;
  English, in the docs' voice ([`apps/docs/AGENTS.md`](../../../docs/AGENTS.md#voice)); `**bold**` the only markup, a
  dashboard label bold and spelled as the screen shows it. A stop on the page the guide is already on adds no query
  value, since a page reads its `?tab=` when it opens. No stop on an anchor inside a modal.
- **Checks**: `tests/unit/authored-guides.test.ts` (the anchors, pages, resolvers, `requires`, limits, and every bold
  label against the source of the component setting the stop's anchor, the component carrying it or the page's
  files, so a renamed label fails; the resolvers on stubbed routes; the docs page listing every guide),
  `tests/guides.spec.ts` (the palette and the panel with no model, a declined capability), and
  `scripts/check-demo-runtime.mjs`, which starts every guide from the palette in the built demo and walks it, each stop
  highlighted on its anchor and in view, one guide at 390 px.
- **A change to a screen a guide stop shows updates the guide in the same commit**, as for the tour: moving or
  renaming an anchored element, renaming a label a stop puts in bold, a change that makes a resolver find nothing in
  the seed. A new guide, or a renamed one, updates the table of `apps/docs/features/guides.md`.
