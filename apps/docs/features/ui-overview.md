---
title: UI overview
description: "A map of the dashboard: every page and tab, what it is for, and the page of these docs that explains it."
lang: en-US
---

# UI overview

This page is a **map of the dashboard**: where each view lives and which page of these docs explains it.

Pages refresh on their own when runs start or finish, and keep their lists as you left them until a reload. Blocks
that need it carry a help icon with a short explanation and a **Learn more** link into these docs, and every source
path [opens in your IDE](./ide-integration).

## Home

`/`: a health check across all projects. A **Filters** block (environment, full runs only), a **stat strip** whose every number but the average pass rate is a link, a **Project health** table with run-history bars and a tendency badge
beside the recent activity, then the **failure inbox** of open clusters, triaged from the row or the keyboard
([Failure clusters & the inbox](./failure-clusters#the-failure-inbox)).

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
stands: the latest run and the pass rate of the last 20 runs, then the open clusters, flaky tests and quarantined
tests, each a link. The **Filters** block under it (environment, branch, full runs only) scopes the header and every
tab that reads run history; with no branch picked it reads the [default branch](./branches#the-default-branch), and a
note counts the runs it hides. The **More** menu holds Edit, [Test functions](./test-functions),
[Selections](./test-selection), [Import](/guide/importing-runs) and Delete. The tabs:

- **Runs**: the run trend chart, with its [timeline markers](./timeline-markers), over the filtered runs, and the runs table,
  25 runs to a page; select two runs and **Compare** to see [what changed](./run-changes) between them, or select any
  number, page by page, and [delete them](/operate/storage#storage-management).
- **Tests**: every test case with its pass rate and last run, in file order, with the
  [test search](/reference/test-search) (title, describe block, file, tag, lock, owner, priority, feature) and a status
  filter, and groupable by file, or by file and describe block.
- **Failures**: the [failure clusters](./failure-clusters), the [flaky tests](./flaky-tests#flaky-test-detection) and the
  [quarantine](./flaky-tests#quarantine-with-a-way-out) list.
- **Flake Lab**: where each flaky test stands in the [Flake Lab](./flake-lab) and the command it needs next, and the
  project's newest experiments. Hidden when the Flake Lab is switched off.
- **Gaps**: the tests the suite does not have yet, proposed from the Test Map, with the feature map and the graph view
  ([Scenario gaps & the Test Map](./scenario-gaps)). Hidden when the Test Map is switched off.
- **Performance**: duration trends, the slowest tests, timeout opportunities and the slow endpoints
  ([Slow tests & wasted time](./slow-tests)).
- **Settings**: one section at a time, picked from a menu beside it: the label and tags, the project's
  [members](/operate/project-access), [source control](/guide/source-control) (token, default branch, CI re-run),
  [AI instructions](./ai-diagnosis#custom-instructions), [capabilities](/operate/capabilities),
  [targets](./analytics#targets), the [issue tracker](./issue-tracking), the
  [browser extension URLs](./extension-connection#url-patterns) and, in the desktop app, the
  [local folder](./desktop#running-tests-from-the-app).

## Locators

`/projects/:id/locators`: check pasted locators against the ones the project's tests use, and browse every locator
chain in the locator index, per branch. See [Who uses a locator](./locator-usage#the-locators-page).

## Test run detail

`/test-runs/:id`: one run. The header carries the status, the primary action (**Copy retry command** on a red run,
the HTML report on a green one) and one facts line, and a **count bar** filters the tests by status. While it runs,
results stream in live, and the tab's icon and title show its progress. When ingest left something out or rebuilt
it, the facts line counts **ingest notes** and **Details** lists them: steps and console entries over the [ingest caps](/reference/configuration#ingest-limits), traces not stored,
evidence rebuilt from a trace, and the fallback the reporter took to send the run. The tabs:

- **Tests**: every execution with its failure headline, in run order, grouped by cluster (the default on a red run),
  file, describe block or [lock](/reference/test-metadata#test-locks), with the same
  [test search](/reference/test-search) as a project's Tests tab and bulk triage.
- **Changes**: what differs against one baseline run. See [What changed in a run](./run-changes).
- **Timeline**: each worker's tests on one time axis, with hooks, waits and locks, the slowest tests and the worker
  distribution ([Slow tests & wasted time](./slow-tests)).
  - **Hooks**: hook time is hatched over each test's bar: setup (`beforeAll`, `beforeEach`, fixtures) at the start,
    teardown (`afterEach`, `afterAll`, worker cleanup) at the end. A failed hook is drawn in dark red and counted in
    the header, even with **Show hooks** off; hover it for the hooks that section ran, their times and the error, and
    click it to open the test's steps on that hook. Playwright leaves `beforeAll` / `afterAll` hooks and worker
    fixtures out of a test's duration; the bar spans them anyway, and its tooltip gives the duration Playwright
    reported. Runs sent by an older reporter show the sections without their hook list.
  - **Gaps**: a lane is one worker. Playwright replaces a worker process after a failed test, so a lane can hold
    several processes one after another: **↻** marks where a new one took over, and the stretch before it is the old
    process shutting down and the new one starting. A dashed line is time the worker ran no test; hover either for
    the details.
  - **Retries**: a retried test has one bar per attempt, the last solid, the earlier ones pale. Hover one to join
    them with arrows.
  - **Resources**: when the reporter measured them, the machine's CPU, the run's memory and the pages open in the
    workers are drawn above the worker rows, and one metric of your choice under each worker row. Hover a track for
    its values; turn each off from the **Resources** menu. See [CPU, memory & disk](./cpu-memory-disk#in-the-dashboard).

## Test case detail

Two pages: an **execution** (`/test-run-cases/:id`) answers *"why did this attempt fail?"*, and a **test case**
(`/test-cases/:id`) answers *"how has this test behaved over time?"*. A failing execution opens on the situation block
([Your first failure, explained](/guide/first-failure)), then the evidence card and the **More ways to fix** toolbox
([Failure evidence](./evidence)). The test case page shows the test's history
([The test case page](./evidence#the-test-case-page)). Both can be exported as a file with
[Offline export](./offline-export).

## Failure cluster detail

`/failure-clusters/:id`: every test that failed for one cause. It opens on the same situation block, with the
state line right above the next step, then the issue, the occurrence sparkline and what changed. Under it, the section
the next step points at, such as the [AI diagnosis](./ai-diagnosis) or the [locator fix](./locator-healing), is a card
of its own above the affected tests and their evidence
([Failure clusters & the inbox](./failure-clusters#the-cluster-page)). The **More ways to fix** toolbox holds the
other sections and the [fix plan](./fix-plans); the occurrence chart and the activity fold to one line each below it.

## Setup

`/setup`, administrators only: the reporter setup steps and a checklist of which optional capabilities this instance
actually uses, judged from the data it holds ([Choose what you use](/operate/capabilities)).

## Settings

`/settings`: your **Account** and connected accounts ([OAuth](/operate/authentication#oauth-google-github)),
**Users** ([Authentication](/operate/authentication), [API keys](/operate/api-keys)), **Groups**
([Groups](/operate/project-access#groups)), **Permissions** ([Permission grid](/operate/project-access#permission-grid)),
**Roles** (what each role can do, read-only), **Storage**
([Storage](/operate/storage#storage-management)), **Tags**, **Pull requests** ([Pull-request feedback](./pr-feedback)),
**Auto-heal** ([Auto-heal PRs](./auto-heal)), **Integrations** ([Integrations](/operate/integrations)),
**Performance** (wasted-time patterns and timeout hygiene), **AI** ([AI provider](/guide/ai-provider)),
**Notifications** ([Notifications & alerts](./notifications)) and **Localization**
([Localization](/operate/localization)). A setting backed by an environment variable is shown read-only with the
variable's name ([Configuration reference](/reference/configuration)).

The sidebar also links the **MCP server** setup page, `/mcp` ([MCP server](./mcp)), and the **API docs**, `/docs`, the
instance's own OpenAPI reference.

## Live demo

The [live demo](https://piwitests.dev/demo/) runs in your browser and adds three controls. **Simulate a test run**
replays a reporter's stream, so you can watch a run arrive. **Acting as** switches between seeded identities to show
how [roles](/operate/project-access) change what each one sees and can do, including changes made on the
[permission grid](/operate/project-access#permission-grid). **Guided tour** asks what you do (**Developer**,
**QA engineer**, **Product owner** or **DevOps / platform**) and walks you through that role's screens, pointing at one
element on each. The tour is in English, French, Spanish and German; the dashboard stays in English. With no model,
**Ask Piwi** answers [prepared questions](/features/assistant#asking-a-question) from the sample data.

## Related

- [Core concepts](/guide/concepts): the words this map uses
- [Your first failure, explained](/guide/first-failure): the page you open most, read top to bottom
- [All features](/reference/features): every feature and where it lives
- [Keyboard shortcuts](/reference/keyboard-shortcuts): the command palette and the go-to keys
