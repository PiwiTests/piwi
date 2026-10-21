# Demo examples in the docs

A plan to link every feature page to a concrete example in the live demo, and to keep those links true as the demo
data changes. A reader of [Flake Lab](../apps/docs/features/flake-lab.md) learns what a verified fix is; the demo
holds one, on a real screen, one click away. Today the reader has to find it, and a question from a user ("I can't
find any example to test the Flake Lab in the demo, is that normal?") shows they often don't.

**Status.** Proposed 2026-09-29. **PR 1 built 2026-09-29**: the registry with five examples (three for Flake Lab, two
for AI diagnosis), `<DemoExamples />`, the seed check and the docs drift rules, with the Flake Lab and AI diagnosis
pages moved onto them. PR 1 took the recommended answer to "Where the section sits" and to "Word budgets"; the other two
decisions wait for PR 2 and PR 3. What changed while building PR 1:

- `<DemoExamples />` takes no `page` prop: it reads the page it renders on, so a page cannot show another page's
  examples. The `## Try it in the demo` heading stays in the page's Markdown, so the outline and its anchor keep
  working, and the drift test checks the component sits in that section, the last one before `## Related`.
- The links open in a new tab. VitePress's router loads every same-origin link without a `target` as a docs page, so
  a plain `/demo/…` link would load a docs 404.
- `shows` is plain text, rendered as text; a control's name is written out ("the Diagnose with AI button").
- The `expect` vocabulary as built: `testCase`, `project`, `cluster` (by its failure story's key), `diagnosis`
  (`'with-patch'` or `'none'`), `fixLanded`, and `lab`, a test's Flake Lab state computed with the app's own rules
  (`flakeLabTestState` and the verified-fix rule). `verifiedFix: true` in the first sketch became `lab: 'verified'`.
- `llms-full.txt` expands `<DemoExamples />` into the page's links, with absolute URLs, so language models read the
  same examples.

**Since PR 1**, feature pages added their own examples as they shipped: the registry holds 20, on 12 pages
(2026-10-17). PR 3's coverage is not done: most "seeded" and "audit" pages of [Coverage](#coverage) still have none
(failure clusters, evidence, locator healing, flaky tests, analytics, dashboards, quality reports, run changes, slow
tests…). PR 2 is not started: the screenshot scenes, the demo runtime check and the `run-app` skill do not read the
registry. The optional PR 4 is not built; the demo's guided tour reuses only the `expect` type.

## Why

- **The docs describe, the demo shows, and nothing connects them.** Of the 42 feature pages, one links to concrete
  demo screens (Flake Lab) and three to the demo's home page (AI diagnosis, UI overview, Share links); the site's 21
  other demo links all point at the API reference. The demo's data covers far more: stored AI diagnoses, a broken
  locator with ranked replacements, flaky tests with suspects, a verified flake fix, saved dashboards, report
  snapshots, scenario gaps.
- **Seeded ids are hardcoded everywhere, and nothing checks the docs' copies.** The seed is deterministic, so test
  case 35 is the pagination test until a story is added to the generator. Around 80 places rely on that: 74 routes in
  `scripts/take-feature-screenshots.mjs`, the routes in `scripts/check-demo-runtime.mjs`, the table in the `run-app`
  skill, and now the docs. A docs link is an external URL, so the drift test cannot resolve it: when an id moves, the
  link opens the wrong test and no check fails.
- **An example exists only if someone seeds it, and nobody knows which pages lack one.** The verified flake fix was
  seeded after the question above, not with the feature.

## The proposal

### 1. One registry of demo examples

`apps/application/shared/demo/demo-examples.mjs`, plain ESM like `failure-stories.mjs`, so the seed generator, the
scripts, the tests and the docs site (through the `#shared` alias it already uses for `<Needs>`) all read the same
file. One entry per example:

```js
export const DEMO_EXAMPLES = [
  {
    id: 'flake-lab-verified-fix',
    // The docs page that shows it; the drift test checks the page renders it.
    doc: 'features/flake-lab',
    title: 'UI Components › Table pagination works correctly',
    shows: 'One suspect reproduced it and one did not, a first fix still failed, and the second is verified.',
    route: '/test-cases/35?tab=flakiness',
    // What the seed must hold for the route to show it; checked against the generated seed.
    expect: { testCase: { id: 35, title: 'Table pagination works correctly' }, lab: 'verified' },
  },
  // …
];
```

The `expect` vocabulary stays small and named (a test case by id and title, a cluster by id and story key, a verified
fix, a stored diagnosis, a tab that must render), each backed by one SQL check in the consistency test. No free-form
predicates: an example says what it promises in words a reviewer can read.

### 2. A docs component

`<DemoExamples />` in `apps/docs/.vitepress/theme/components/`, registered like `<Needs>`,
renders the page's examples as one short list under a fixed heading ("Try it in the demo"): the title as the link,
then the `shows` sentence. Links are built with `withBase('/demo' + route)`, so the docs and the demo deployed together
on GitHub Pages stay on one host, and a fork that deploys both points at its own demo. A component-rendered anchor is
not a markdown link, so VitePress's dead-link check does not reject the `/demo/` path.

The Flake Lab and AI diagnosis pages move to the component in the first PR; their hand-written sections go.

### 3. Checks that keep the links true

- **Seed consistency** (`tests/unit/demo-seed-consistency.test.ts`): every entry's `expect` holds in the generated
  seed, and its route's id is the entity it names. A seed change that moves test 35 fails here, naming the example.
- **Docs drift** (`tests/unit/docs-drift.test.ts`): every `doc` is a real page that renders `<DemoExamples>` for
  itself, and every page that renders it has at least one entry. A new rule then lists the feature pages with no
  example, against an allow-list of the ones the demo cannot show (below).
- **Demo runtime** (`scripts/check-demo-runtime.mjs`): opens each route in the built demo and checks it renders
  without an error state. It already does this for three routes by hand; the registry makes it every example.

### 4. The other readers of seeded ids move onto the registry

- Screenshot scenes name an example instead of a route: `route: example('flake-lab-verified-fix')`, which throws on
  an unknown id. Scenes that capture screens no docs page links to keep a literal route.
- The `run-app` skill's "Want to see" table becomes a pointer to the registry, so agents and people read one list.
- The seed generator exports the ids it hands to the registry's stories (`FLAKE_FIX_DEMO.caseId`), and a unit test
  compares them with the registry, so a generator change that renumbers a story fails at seed time rather than in a
  browser.

## Coverage

What each feature page could link today. "Seeded" means the example is in the current seed and was checked by hand;
"audit" means the data probably exists and needs a look; "none" means the demo cannot show the feature, and the page
goes on the allow-list.

| Page | Example | State |
|---|---|---|
| Failure clusters & the inbox | cluster 10 | seeded |
| AI diagnosis | cluster 10, stored diagnosis with a validated patch | seeded |
| Evidence | execution 37, diagnosis tab | seeded |
| Locator healing | execution 13, ranked replacements | seeded |
| Flaky tests & quarantine | project 1's Flaky view; project 3's quarantine with a release proposal | seeded |
| Flake Lab | tests 9 and 35; project 3's Flake Lab tab | seeded |
| Run changes | run 2's insights, or a two-run compare | audit |
| Analytics, Dashboards | the Analytics page; the seeded dashboards | seeded |
| Quality reports | the two report snapshots and the schedule | seeded |
| Scenario gaps & the Test Map | a project's Gaps tab | audit |
| Slow tests & wasted time | project 1's Performance tab | audit |
| Timeline markers, Test selection, Bug reports, Probes, Code reach, Locator usage, Tested elements, Fix plans, Offline export | seeded tables exist for most | audit |
| Desktop app, Browser extension, IDE and editor pages, MCP, PR feedback, Notifications, Share links, Issue tracking, Auto-heal, Preflight, DevTools | | none |

## Rollout

1. **The registry, the component and the seed check**, with the Flake Lab and AI diagnosis examples moved onto them.
2. **The other readers**: screenshot scenes, the runtime check and the `run-app` skill read the registry; the docs
   drift rule lists pages without an example, with the allow-list.
3. **Coverage**: one example for each "seeded" and "audit" page, seeding what the audit finds missing, a page at a
   time. A new feature page then ships with its example, or with a line on the allow-list saying why not.
4. **Optional, the other direction**: the demo reads the same registry to offer a short tour ("Examples" in the demo
   banner), and a `?from=docs` visit shows a link back to the page that sent the reader.

## Decisions for you

- **A required example, or a reported one?** Recommended: required for feature pages whose feature renders in the
  demo (the drift test fails without one), with the allow-list for the rest. The softer option reports the gaps
  without failing.
- **Where the section sits.** Recommended: its own `## Try it in the demo` heading before `## Related`, the same place
  on every page. The alternative is inline links next to the paragraph each example illustrates, which reads better
  but cannot be checked for placement.
- **Icons.** An example could carry the icon of the tab it opens (the snowflake for the Flake Lab). The docs site
  installs no icon set today; adding the lucide icons the app uses is one dependency, and only worth it if the list
  reads better with them.
- **Word budgets.** The rendered list does not count toward a page's budget, since the drift test counts the
  markdown. Recommended: accept that, as the list is short and fixed in form; the alternative counts each entry's
  `shows` sentence against its page.

## Non-goals

- Screenshots in place of links. The committed illustrations stay; an example is the live screen next to them.
- Examples for the self-hosting and reference pages. They document configuration, not screens.
- A second demo dataset. The examples come from the one seed, so the demo stays one coherent story.
