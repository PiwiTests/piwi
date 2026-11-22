# Component tests: the stories a test mounts

A proposal to make Piwi read component tests the way Playwright now writes them: ordinary tests that call the built-in
`mount(storyId, props)` fixture against a story gallery the project serves. It records what a spike showed, the design,
the stages and the questions left open.

**Status.** Proposed 2026-11-22, nothing built. A spike ran the reporter on such a suite ([section 2](#2-what-happens-today));
the one defect it found, code reach on a page Playwright keeps between tests, is
[PiwiTests/piwi#1611](https://github.com/PiwiTests/piwi/issues/1611), fixed apart from this plan (stage S0). Not on
[`ROADMAP.md`](../ROADMAP.md) yet. The contracts it would add are entry D69 of
[1.0-stabilization.md](1.0-stabilization.md).

**Summary.** Playwright removed its experimental component-testing packages (`@playwright/experimental-ct-react`,
`-vue`, `-svelte`) in 1.63. A component test is now an ordinary test: a `*.story.tsx` file next to a component exports
one scenario per story, a small gallery page the project owns renders a story on request, and the built-in `mount`
fixture navigates to the gallery and asks it for one. Piwi already records these runs: results, failures, clusters,
flaky scores and traces work unchanged, code reach too once [#1611](https://github.com/PiwiTests/piwi/issues/1611) lets it run beside the recommended `reuseContext`,
and the fixtures file `npx @piwitests/reporter init` writes already carries `mount`. What Piwi does not know is which story a test mounted, so a component suite reads as one page
tested many times: the Test Map holds the gallery as its only page and the gallery's own document as a route, every
locator sits on that page, and a story no test mounts goes unnoticed. This plan records each test's stories from its
`mount` calls, reads the project's story files, keeps the gallery out of the map, adds stories to the Test Map with a
gap for a story no test mounts, and tells component and end-to-end executions apart from the same data.

## Terms

- **Story**: a named export of a `*.story.*` file, or a `.story.vue` file as a whole, that renders one component in one
  scenario. Its **id**, in the grammar Playwright recommends, is the file's path under the source root without the
  `.story.*` extension, then the export's name: `src/components/Button.story.tsx` export `Primary` is
  `components/Button/Primary`.
- **Gallery**: the page the project serves at its component project's `baseURL`, by convention
  `/playwright/gallery/index.html` on the app's own dev server. It defines `window.mount({ story, props })` and
  `window.unmount()` and renders into `#root`. Each project writes its own.
- **Story inventory**: the stories the repository's story files declare, read by the reporter (3.2).
- **Component execution**: an execution that called `mount` at least once.
- **Experimental CT**: the removed packages, which compiled the JSX of the test file into a bundle served on `ctPort`.

## 1. Component testing in Playwright now

- **The packages are gone.** The last versions published are 1.62.1 for `experimental-ct-react`, `-vue` and `-core`,
  and 1.58.2 for `-svelte`. Playwright's migration guide (`references/migration.md` of its `playwright-component-testing`
  skill, which `npx playwright init-skills` installs) says they were removed in 1.63 and asks a team to migrate while
  pinned to 1.62.
- **`mount` is a fixture of `@playwright/test`** since 1.63. All it does: without `baseURL` it throws
  ``mount() requires `baseURL` to point at the component gallery. Set it in your Playwright config.``; otherwise it
  calls `page.goto(baseURL)`, then `page.evaluate` calling `window.mount({ story, props })` with `exposeFunctions: true`
  (so a function in `props` reaches the browser), and throws `The gallery page does not define window.mount().` when
  the gallery has none. It returns `page.locator('#root')` with `update(props)`, which calls `window.mount` again
  without navigating, and `unmount()`.
- **The recommended project**: `baseURL` set to the gallery's URL, `serviceWorkers: 'block'`, and `reuseContext: true`,
  a worker option that keeps one browser context per worker and resets it between tests, used only while video is off.
- **The gallery owns story resolution.** `mount` passes the id untouched. Playwright's example gallery also accepts any
  unique trailing suffix (`Button/Primary`), which a rename can silently send to another story.
- **Piwi's reporter supports Playwright 1.59 and later**, so a suite on 1.59 to 1.62 can still use experimental CT.

## 2. What happens today

The spike: Playwright 1.64.1, React 19, Vite 6, the reporter 0.75.0 installed from its packed tarball, the capture
fixtures from the file `init` writes, a local dashboard. Three story files (`Button` with `Primary` and `Counting`,
`UserCard`, which fetches `/api/users/:id`, and `Untested`, which no test mounts) and six tests: clicks recorded in a
hidden form, two mounts in one test, a request answered by `page.route`, a `toHaveScreenshot` of the root, and a
locator that matches nothing.

| What                                  | Result                                                                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup                                 | Nothing extra: `init`'s fixtures file extends the `test` of `@playwright/test`, which has `mount`                                                                     |
| Results and failures                  | Recorded; the locator that matched nothing got its one-line explanation (`… was not found on the page`)                                                               |
| The steps of a `mount`                | `Fixture "mount"`, `Navigate` to the gallery's URL, `Evaluate`: the story id is in no step title and no step parameter                                                |
| Test Map                              | One page node, `/playwright/gallery/index.html`; route nodes `GET /playwright/gallery/index.html` (the gallery's document) and `GET /api/users/:id` (the component's) |
| Locator index                         | Every use on the page `/playwright/gallery/index.html`, every locator starting `locator('#root')`                                                                     |
| Code reach, `reuseContext: false`     | Each test reached `playwright/gallery/main.tsx`, its story file and its component file; no test reached `Untested.tsx`                                                |
| A failing `toHaveScreenshot`          | `primary-expected.png`, `primary-actual.png` and `primary-diff.png` stored as plain image attachments beside the failure screenshot                                   |
| Code reach, `reuseContext: true`      | Every second test of a worker timed out while setting up `context` ([#1611](https://github.com/PiwiTests/piwi/issues/1611))                                           |
| Resource ledger, `reuseContext: true` | No finding: the context kept between tests is not reported as leaked                                                                                                  |

## 3. Design

### 3.1 The stories a test mounts (reporter)

- **The capture fixtures override `mount`** as they override `page` and `browser`
  (`internal/capture/capture-fixtures.ts`): `mount: async ({ mount, baseURL }, use) => use(wrapped)`. The wrapper calls
  the test's `mount` unchanged and keeps, for each call, the id as written and the call's line in the spec, read from
  the stack through the boxed frames every capture uses. An `update` keeps no new entry.
- **Invisible capture.** The override adds no step and no page call (contract 6 of
  [`packages/reporter/AGENTS.md`](../packages/reporter/AGENTS.md)). The list stays in memory until teardown, then goes
  as the `piwi-stories` attachment: `application/json`, `{ gallery, stories: [{ id, line }] }`, at most 20 stories per
  execution.
- **Defined only when the base `test` has `mount`.** An `extend` that overrides a fixture the base does not define
  fails, so `piwiFixtures` carries no `mount` key on Playwright 1.62 and older. A reporter spec drives a gallery written
  in plain DOM code (the contract needs no framework) and skips below 1.63 (`playwrightAtLeast`).
- **Props are never recorded.** They are the test's data, may hold a secret, and may hold functions.
- **Wire**: `stories?: { id: string; line?: number }[]` on the test case (`toWireTestCase`, the one place a per-case
  field is projected), and `galleries?: string[]`, each gallery's URL without its query, in the run's metadata.

### 3.2 The story files (reporter)

- **Once per run, in `onBegin`**, the reporter lists the repository's tracked
  `*.story.{tsx,jsx,ts,js,vue,svelte}` files (the git inventory coverage already takes,
  `internal/coverage-upload/git-inventory.ts`), and reads in each one its named exports by a plain scan
  (`export const X`, `export function X`, `export { X }`; a `.story.vue` is one story) and its relative imports.
- **Ids follow Playwright's recommended grammar** from the source root: the path under `src/` by default, set by a new
  reporter option, `stories: { root, glob }`, for a monorepo or another layout.
- **The inventory goes with the run once**: `storyInventory: { root, stories: [{ id, file }], imports: [{ from, to }] }`,
  at most 2,000 stories, left out when its hash matches the one the instance answered `/begin` with.
- **One import scan.** `extractImports` (`apps/application/shared/graph.ts`) moves to `@piwitests/core`, so the
  reporter and the server's change coverage share it: the reporter never imports the app's `shared/`.
- **Resolving a written id**: an exact match first, else the one story whose id ends with `/<written id>`. No match,
  or several, keeps the id as written and counts it in the run's ingest health (`metadata.ingestHealth`) with its spec
  line, since a suffix that matched another story after a rename fails nothing.

### 3.3 Stories in the Test Map (server)

- **A new node kind, `story`** (`GraphNodeKind` in `shared/graph.ts`), keyed by the resolved id, origin `convention`,
  its file in `attrs`.
- **Edges**: a test `reaches` each story it mounted (origin `observed`); a story file `imports` the component files it
  imports (origin `import`, through the existing `buildImportEdges`).
- **The gallery is not surface.** For a component execution, the ingest (`server/utils/graph-ingest.ts`) leaves out
  the page node of the gallery's URL, the `GET` route of the gallery's document, and, from code reach, the files under
  the gallery's folder (the folder of its URL path, `playwright/gallery/`). Every component test reaches them, so they
  say nothing about what one covers. A request the component makes stays a route node.
- **Detectors.** _Declared, never hit_ (`declared-never-hit`) also raises a story of the inventory that no test of the
  default branch mounted, confidence 0.7 as for a declared route, its evidence naming the story file. _Single covering
  test_ and _Surface drift_ apply to stories as to any node. With coverage on, _Code nobody executes_ already raises a
  component file no test runs.
- **Features**: a `piwi:feature` tag groups stories as it groups pages; with none, a story's first id segment
  (`components`) is the grouping key, as a page's first path segment is.
- **The locator index per story.** In a component execution, the capture fixtures record a locator call's page as the
  story the test mounted last (`story:components/Button/Primary`), so the index (`locator_usages.page`) and Piwi
  Picker's matching are per scenario instead of one page for the whole suite. The `#root` prefix stays: it is what the
  test wrote, through `component.getByRole(…)`.

### 3.4 Component and end-to-end executions side by side

- **An execution with stories is a component execution**; nothing else decides it, neither the config nor a project
  name. A test case keeps `kind = 'component'` from its latest execution, as it keeps its tags.
- **Filters**: Analytics, the flaky list and the test catalog get a _Component / End-to-end_ filter, carried by the URL
  like the others, both kinds by default. A project with one kind never shows it. The MCP tools that take a test filter
  take `kind`.
- **The execution page** names the stories under the title (_Mounted_ `components/Button/Primary`), each linking to its
  story file at the run's commit through the source control links.
- **Three clues** in `shared/failure-clues.ts`, read from Playwright's own errors and the inventory, so deterministic:
  - `gallery-not-loaded` (strong), on `The gallery page does not define window.mount().`: the page at `baseURL` loaded
    without the gallery's script, because the dev server served another page or the gallery's module failed to
    compile. The detail names the gallery's URL and cites the console errors.
  - `gallery-not-configured` (strong), on ``mount() requires `baseURL` ``: the project sets no `baseURL`.
  - `story-not-found` (strong): the test failed in a `mount` whose written id resolved to no story of the inventory.
    The gallery's own error text is the project's, so the clue reads the inventory and names the closest id.
- **Healing keeps the receiver.** A replacement for `component.getByRole(…)`, stored as `locator('#root').getByRole(…)`,
  is written back on `component`, never on `page`.

### 3.5 Setup and docs

- **`init` needs nothing new**: its fixtures file already carries `mount` on Playwright 1.63 and later.
- **Docs**: a _Component tests_ section in the capture fixtures guide: what Piwi reads from a gallery suite, the
  `stories` option, what the map shows, and Playwright's docs for writing the gallery. The reporter options page is
  generated from `options.ts`.
- **Experimental CT gets no support of its own.** Its results arrive as any test's do. Its configs, by convention
  `playwright-ct.config.ts`, stay outside `init`'s and the editors' config discovery (`cli/detect.ts`,
  `packages/editor/src/workspace.ts`, `apps/vscode/src/glue.ts`, `Glue.kt`), which read `playwright.config.*` alone. The
  docs point to Playwright's migration guide.

## 4. Left out

- **Screenshot comparisons.** Component suites are where `toHaveScreenshot` gathers, and Piwi stores its expected,
  actual and diff images as plain attachments. Showing them as a comparison, keeping a baseline's history and accepting
  a new one is its own piece of work, for every suite.
- **Requests a test fulfills.** A request answered by `page.route` is recorded as the application's route (in the spike,
  `GET /api/users/:id` with a 500 the test made up). The same holds in end-to-end suites.
- **Opening a story from the editors or Piwi Picker.** Not planned: Playwright's advice is to open the gallery and call
  `window.mount` from the console.

## 5. Stages

| Stage | Builds                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S0    | [#1611](https://github.com/PiwiTests/piwi/issues/1611): code reach on a page Playwright keeps between tests. Independent of the rest, first                                                                                    |
| S1    | The `mount` override and `piwi-stories`; the wire field; stories stored on the execution and the test case's kind; the execution page's _Mounted_ line; the three clues (`story-not-found` reads S2's inventory once it ships) |
| S2    | The story inventory and the `stories` option; `extractImports` in core; `story` nodes and their edges; the gallery left out of the map; `declared-never-hit` for stories; unresolved ids in ingest health                      |
| S3    | The locator index per story; the _Component / End-to-end_ filter in Analytics, the flaky list, the catalog and the MCP tools                                                                                                   |

Each stage ships with its docs section, the demo seed (a component project of a few stories, one never mounted) and
the reporter spec on a plain DOM gallery.

## 6. Open questions

- **Story ids from another grammar.** A gallery may resolve ids its own way (a Storybook-style `button--primary`, ids
  without the source root). Whether the `stories` option takes a function, or Piwi asks the gallery itself through a
  `window.stories()` list no gallery has yet.
- **`reuseContext` and the capture fixtures beyond code reach.** The spike saw no finding from the resource ledger; the
  live view, the run channel's stops and the editor's breakpoints have not been tried on a context kept between tests.
- **A second config file.** A team that keeps its component project in its own config (`playwright.components.config.ts`)
  is invisible to the editors, whose discovery reads `playwright.config.*` alone. That holds for any second config, not
  only components.
- **Healing on a receiver.** Whether today's auto-heal patch already keeps `component.` on such a line, or S3 has to
  teach it.
