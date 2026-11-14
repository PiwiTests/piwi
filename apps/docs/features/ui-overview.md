---
title: UI overview
description: "A map of the dashboard: its main pages and tabs, what each is for, and the page of these docs that explains it."
lang: en-US
---

# UI overview

This page is a **map of the dashboard**: where the main views live and which page of these docs explains each.

Pages refresh on their own when runs start or finish, and keep their lists as you left them until a reload. Blocks
that need it carry a help icon with a short explanation and a **Learn more** link into these docs, and every source
path [opens in your IDE](./ide-integration).

## Home

`/`: a health check across all projects. A **Filters** block (environment, full runs only), a **stat strip** whose every number but the average [pass rate](/guide/concepts#pass-rate) is a link, a **Project health** table with run-history bars and a tendency badge
beside the recent activity, then the **failure inbox** of open clusters, triaged from the row or keyboard
([Failure clusters & the inbox](./failure-clusters#the-failure-inbox)). **Starred projects** lead Project health and the
sidebar.

<figure>
  <img src="/screenshots/home.png" alt="Home in the light and dark themes: filters, stat strip, project health and recent activity">
  <figcaption>Home.</figcaption>
</figure>

## Analytics

`/analytics`: trends across projects and over time, where Home shows what is happening now. The filters at the top
scope every widget; the widgets are listed on [Analytics widgets](/reference/analytics-widgets), and the filters and
period comparisons on [Analytics](./analytics). The page is the built-in *Overview* [dashboard](./dashboards), and the
header switcher opens the others. [Timeline markers](./timeline-markers) overlay deploys and infrastructure changes on
the trend charts.

## Quality reports

`/reports`: the report snapshots kept and the schedules that send them; `/reports/:id` opens one snapshot. See
[Quality reports](./quality-reports).

## Projects

`/projects`: every project with search, tag filters, its last run and pass/fail bar. A project is created on its
first result, or with **New project**.

## Project detail

`/projects/:id`: one project's history. The **header** names the project, its description and tags, and where it
stands: the latest run that [ran to its end](/guide/concepts#test-run) and the [pass rate](/guide/concepts#pass-rate) of the last 20 such runs, then the open clusters, flaky tests
and quarantined tests, each a link. The **Filters** block under it (environment, branch, full runs only) scopes the
header and every tab that reads run history; with no branch picked it reads the
[default branch](./branches#the-default-branch), and a note counts the runs it hides,
[your own](/guide/getting-started#_3-run-your-tests) aside, which the runs table lists all the same. Beside the
[**Import**](/guide/importing-runs) button, **More actions** holds Edit,
[Test functions](./test-functions), [Selections](./test-selection), [Locators](#locators), [Bug reports](./bug-reports),
**Schedule a quality report…**, Delete and Refresh. The tabs:

- **Runs**: the run trend chart, with its [timeline markers](./timeline-markers), over the filtered runs, and the runs table,
  25 to a page; select two and **Compare** [what changed](./run-changes) between them, or select any
  number, page by page, and [delete them](/operate/storage#storage-management).
- **Tests**: every test case with its pass rate and last run, in file order, with the
  [test search](/reference/test-search) and a status filter, groupable by file, or by file and describe block.
- **Failures**: the [failure clusters](./failure-clusters), the [flaky tests](./flaky-tests#flaky-test-detection) and the
  [quarantine](./flaky-tests#quarantine-with-a-way-out) list.
- **Flake Lab**: where each flaky test stands in the [Flake Lab](./flake-lab) and the command it needs next, and the
  project's newest experiments. Hidden with the Flake Lab off.
- **Coverage**: what the suite does not test, in three views: **Gaps**, the tests to write, proposed from the Test Map
  ([Scenario gaps & the Test Map](./scenario-gaps)); **Map**, the feature map and the graph view; **Code**, every
  suite's [combined coverage](./combined-coverage) of a commit. Hidden with both the Test Map and coverage off.
- **Performance**: duration trends, the slowest tests, timeout opportunities and the slow endpoints
  ([Slow tests & wasted time](./slow-tests)).
- **Settings**: one section at a time, picked from a menu beside it: the label, tags and status,
  [members](/operate/project-access), [source control](/guide/source-control) (token, default branch),
  [AI instructions](./ai-diagnosis#custom-instructions), the [live view](./live-view),
  [capabilities](/operate/capabilities), coverage, [targets](./analytics#targets), the
  [issue tracker](./issue-tracking), [CI](./ci-rerun), keys in test tags, [test management](./test-management),
  [browser extension URLs](./extension-connection#url-patterns) and, in the desktop app, the
  [local folder](./desktop#running-tests-from-the-app).

## Locators

`/projects/:id/locators`: check pasted locators against the ones the project's tests use, and browse every locator
chain in the locator index, per branch. See [Who uses a locator](./locator-usage#the-locators-page).

## Test run detail

`/test-runs/:id`: one run. The header carries the status, the primary action ([**Copy retry command**](./ci-rerun) on a red run,
the HTML report on a green one) and one facts line, and a **count bar** filters the tests by status. While it runs,
results stream in and the tab title shows its progress. When ingest left something out or rebuilt
it, the facts line counts **ingest notes** and **Details** lists them: steps and console entries over the
[ingest caps](/reference/configuration#ingest-limits), traces not stored, evidence rebuilt from a trace, and the
reporter's fallback to send the run.
[Errors outside the tests](/reference/test-metadata#errors-outside-the-tests) that Playwright reported (a global setup
that threw, a spec that did not load) show under the facts line. The tabs:

- **Tests**: every execution with its failure headline, in run order, grouped by cluster (the default when opened red),
  file, describe block or [lock](/reference/test-metadata#test-locks), with the same
  [test search](/reference/test-search) as a project's Tests tab and bulk triage.
- **Changes**: what differs against one baseline run. See [What changed in a run](./run-changes).
- **Timeline**: each worker's tests on one time axis, with hooks, waits, locks and [breakpoint](./editor-breakpoints)
  stops, the slowest tests and the worker distribution ([Slow tests & wasted time](./slow-tests)).
  - **Hooks**: hatched over each test's bar, setup (`beforeAll`, `beforeEach`, fixtures) at the start,
    teardown (`afterEach`, `afterAll`, worker cleanup) at the end. A failed hook is dark red and counted in
    the header, even with **Show hooks** off; hover it for the hooks, times and error,
    click it for the test's steps on that hook. Playwright leaves `beforeAll` and `afterAll` hooks and worker
    fixtures out of a test's duration; the bar spans them, and its tooltip gives Playwright's duration.
    Older reporters send no hook list.
  - **Gaps**: a lane is one [worker](/reference/test-metadata#worker-lanes). Playwright replaces a worker process
    after a failed test, so a lane can hold several processes in turn: **↻** marks where a new one took
    over, and the stretch before it is that replacement. A dashed line is time the
    worker ran no test; hover either for details.
  - **Retries**: a retried test has one bar per attempt, the last solid, the earlier ones pale. Hover one to join
    them with arrows.
  - **Resources**: the run's CPU, memory and open pages, above the worker rows and under each of them.
- **Video**: the tests' videos in sequence beside a checklist ([Run video](./run-video)).
- **Resources**, when the run sent a resource report ([CPU, memory & disk](./cpu-memory-disk#in-the-dashboard)).

## Test case detail

`/test-run-cases/:id`, the **execution page**: one attempt, read from its situation block
([Your first failure, explained](/guide/first-failure)) down through its evidence ([Failure evidence](./evidence)), and
exportable as a file ([Offline export](./offline-export)). `/test-cases/:id`: the test's history
([The test case page](./evidence#the-test-case-page)).

## Failure cluster detail

`/failure-clusters/:id`: every test that failed for one cause, with its state, what changed, the affected tests and
the ways to fix it ([The cluster page](./failure-clusters#the-cluster-page)).

## Settings

`/settings` (user menu, or `g` then `s`): your **Account** and connected accounts ([OAuth](/operate/authentication#oauth-google-github)),
**Users** ([Authentication](/operate/authentication), [API keys](/operate/api-keys)), **Groups**
([Groups](/operate/project-access#groups)), **Permissions** ([Permission grid](/operate/project-access#permission-grid)),
**Roles** (what each role can do, read-only), **Storage**
([Storage](/operate/storage#storage-management)), **Tags**, **Pull requests** ([Pull-request feedback](./pr-feedback)),
**Auto-heal** ([Auto-heal PRs](./auto-heal)), **Integrations** ([Integrations](/operate/integrations)),
**Performance** ([wasted-time patterns](./slow-tests#wasted-time) and timeout hygiene), **AI** ([AI provider](/guide/ai-provider)),
**Notifications** ([Notifications & alerts](./notifications)), **Localization**
([Localization](/operate/localization)) and **About**, and in the [desktop app](./desktop) **Desktop app** first. A setting backed by
an environment variable is shown read-only with the variable's name ([Configuration reference](/reference/configuration)).

## Setup

The **Setup** section of Settings: **Connect a suite**, the
[connect wizard](/guide/getting-started#_2-connect-your-suite); **Capabilities**, for administrators, which optional
capabilities this instance uses ([Choose what you use](/operate/capabilities)); **MCP server**
([MCP server](./mcp)); **API reference**, the instance's own OpenAPI reference; and **Companion tools**.

## Live demo

The [live demo](https://piwitests.dev/demo/) runs in your browser and adds these controls. **Simulate a test run**
replays a reporter's stream, to watch a run arrive. **Acting as** switches between seeded identities, whose
[roles](/operate/project-access) change what each sees and can do, including changes made on the
[permission grid](/operate/project-access#permission-grid). **Guided tour** asks what you do (**Developer**,
**QA engineer**, **Product owner** or **DevOps / platform**) and walks you through that role's screens, pointing at one
element on each. The tour is in English, French, Spanish and German; the dashboard stays in English. **Reset data**
restores the sample data. With no model,
**Ask Piwi** answers [prepared questions](/features/assistant#asking-a-question) from the sample data.

## Related

- [Core concepts](/guide/concepts): the words this map uses
- [Your first failure, explained](/guide/first-failure): the page you open most, read top to bottom
- [All features](/reference/features): every feature and where it lives
- [Keyboard shortcuts](/reference/keyboard-shortcuts): the command palette and the go-to keys
