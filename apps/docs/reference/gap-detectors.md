---
title: Gap detectors & exposure
description: "Every Test Map detector with the class it reports, what it needs and its evidence, the exposure factors that rank gaps, and what the graph includes."
lang: en-US
---

# Gap detectors & exposure

The [detectors](/guide/concepts#detector) that turn the [Test Map](/features/scenario-gaps) into scenario gaps, the
**exposure** score that ranks them, and the rules that decide what the graph holds. Evidence counts use the last 30
runs of the project, probe runs excluded.

## Detectors

The Test Map is recomputed after every run, nightly, and on demand. Every detector reads the runs the
[capture fixtures](/guide/capture-fixtures) record; **Needs** names what else it reads, and a detector stays silent
without it.

| Detector | Class | Finds | Needs | Example evidence |
|---|---|---|---|---|
| **Success only** | blind-spot | a route observed at least five times, always with a 2xx or 3xx status: its error paths never ran | nothing more | `Observed 412 times over the last 30 runs, always 200` |
| **Declared, never hit** | blind-spot | a route or page the application declares that no test reaches | a [declared surface](/features/scenario-gaps#declared-surface) | `Declared in OpenAPI · 0 tests in 30 runs · documents 200, 404` |
| **Surface drift** | blind-spot | a route, page, control, link, handler or dependency first seen in the latest run that no test reaches; never a feature, and nothing in the run that built the graph first | nothing more | `Appeared in run #830; no test reaches it yet` |
| **Control nobody exercises** | blind-spot | a control on a page that no test's locator targets | the page inventory and the [locator index](/features/locator-usage) | `On 12 page(s) · no locator targets it` |
| **Reachable, unvisited** | blind-spot | a page other pages link to that no test navigates to | the page inventory | `Linked from 7 page(s) · never navigated to` |
| **Escaped defect** | blind-spot | a page with [bug reports](/features/bug-reports) no test names yet, one gap per page | Piwi Picker sending reports | `Bug report #37: Coupon not applied to the total — no test names it yet` |
| **Changed, unreached** | blind-spot | an [uncovered change](/features/uncovered-changes#one-rule-for-every-changed-file), at pull-request time: a changed file Piwi can observe that no test reached, in the run or the last 30, and no suite ran a changed line of | an SCM token | `+41 −3 · no test in run #812 or in the last 30 runs` |
| **Single covering test** | fragile | a node exactly one trusted test reaches, or that only untrusted tests reach | nothing more | `Only checkout › coupon reaches this`; `Only toggles dark mode (flaky) reaches this` |
| **Orphan test** | fragile | a test whose every reached node disappeared from the last 30 runs | nothing more | `All 3 node(s) it reaches disappeared from recent runs` |
| **Fix did not hold** | fragile | a failure cluster whose fix later regressed | nothing more | `Fixed in a1b2c3d · regressed 6 days later` |
| **Not noticed** | false-comfort | a route a probe broke while no test noticed | [probes](/features/probes) | `A probe (status-500) on POST /api/orders did not make checkout › pay fail` |
| **Passed with errors** | false-comfort | a test whose newest execution in the default branch's last 30 runs passed while the application reported an error: a 5xx from one of its routes, a backend log at error level, or a console error from its own origin | nothing more; backend logs need the [instrumentation](/guide/backend-logs) | `Passed · run #73 · the backend logged an error on PATCH /api/orgs/current` |
| **Assertion-light** | false-comfort | a page some test asserts on, every check there only that an element is visible, hidden, attached or in the viewport | the locator index | `2 tests assert on this page, only that elements are present` |
| **Catalog method, no test calls** | blind-spot | a page-object method or helper on a reached page that no test runs | the [test functions catalog](/features/test-functions) | `./pages/UsersPage · goToNextPage · page reached by 3, called by 0` |
| **Unprobed dependency** | false-comfort | a dependency a route's handler calls that no probe has failed | server spans | `Called by 4 route(s) · no probe has checked what happens when it fails` |
| **Not handled** | unhandled, degraded | the application did not cope with a server probe's fault; a finding, not a gap | [server probes](/features/probes#server-probes) | `A server probe made POST /api/orders fail; the application did not handle it` |

*Passed with errors* leaves out a console line from another origin's script and the browser's own *Failed to load
resource* line. A response no server sent, such as one the test's route handler fulfilled, is no 5xx of the
application, and a test that fulfills a failing response means to see the page fail, so its console errors do not
count either.
*Assertion-light* counts any other matcher (a text, a count, a value, an attribute) as a value check, and so is a read
of an element the index cannot name, or a visible element found by a text holding a number
(`getByText('Total: $42.00')`); an `expect` on no locator, such as a downloaded file's name, never reaches the index,
so a page checked only that way reads as light. A test calls a catalog method when one of its default-branch
locator uses does what one of the method's steps does, on the element that step names by test id or name, on a page
its URL pattern matches. A method whose every target comes from a parameter gets no decision.

A trusted test is one that is not flaky, not quarantined, and not skipped in its latest run. *Changed, unreached* is
covered on [Uncovered changes in pull requests](/features/uncovered-changes): its gap closes once a test reaches the
file. A finding never closes itself; triage it.

Runs record reach to routes and pages: a test reaches every route its page requested, every page it ran a locator
call on, and the page it ended on. Each recompute adds reach to controls and links from the default branch's
[locator index](/features/locator-usage), for uses seen in the last 180 days. A test reaches a control when one of its
locators names it by role and name, when an alternative captured for that locator does, or when the name matches as
Playwright matches it without `exact` (a case-insensitive part of exactly one name of that role). A label,
placeholder or title reaches the one input-like control (textbox, combobox, checkbox, radio, switch, …) carrying that
name. Triage adds reach too (*covered by* or *covered elsewhere*), but *Control nobody exercises* stays silent until a
locator reaches some control on the project. A test that clicks or fills an element no node matches, through a test
id or a CSS selector, might have used any control on that page, so neither *Control nobody exercises* nor *Single
covering test* raises those controls.

## Exposure

A gap's score is its detector's confidence times its **exposure**, the geometric mean of four factors. Each factor is
kept between 0.1 and 1, so a missing input lowers the score without zeroing it.

| Factor | From | Reaches 1 at |
|---|---|---|
| **Churn** | commits touching the files in the last 90 days | 12 commits |
| **Age** | the age of those files; older weighs more, since escaped defects concentrate there | one year |
| **Escape history** | whether a file was part of a failure cluster's fixing commit | yes, else 0.1 |
| **Priority** | the highest [`piwi:priority`](/reference/test-metadata#ownership-metadata-piwi-annotations) of the tests reaching the node: critical 1, high 0.7, medium 0.4, low 0.2 | critical |

Churn, age and escape history come from the [source control](/guide/source-control) connection and apply to the
files a pull request changed. A gap on a route, a handler or a dependency draws churn and escape history from the
handler files behind it, read from the diffs default-branch runs recorded over the last 90 days. Each run diffs from
its last green run, so churn counts distinct diffs, and the runs of a red streak count once. Escape history marks the
files in the diff that ended on a fixing commit, which holds every change since the last green run. Age needs each
file's history, so it stays at 0.1 there. The other detectors
rank by priority and confidence. A finding ranks by its severity (1 for unhandled, 0.5 for degraded) times the
route's reach.

## Features

A feature groups the routes, pages and controls the tests tagged with it reach. Each recompute also gives it what no
feature reaches, with a confidence below one: the controls on its pages (0.8), the pages they link to under the same
first path segment (0.6) and those pages' controls (0.5), and the declared routes under the same resource path as a
route it reaches, `/api/v1/orders` for `GET /api/v1/orders/:id` (0.6). A gap sits under one feature: the one whose
tests reach its node, else the most confident inference. A gap on a test sits under the test's feature, and one on a
catalog method under the feature owning most of the pages its URL pattern matches. So the map shows what a feature
misses, not only what its tests touch. Dependencies, links, and pages or declared routes under other paths stay
ungrouped.

With three features or more, a node more than half the tests reach, or that more than half the features and three at
least group, is a **hub**, such as the session route nearly every test calls. The feature graph still draws it, but
it adds no member, test, gap or link to a feature; its gaps sit under *Shared by most features*. The groups are rebuilt
on every recompute, so a feature that loses its tag leaves the map.

## What the graph includes

The graph stays proportional to the application's surface, not its data volume:

- **Your own origin only.** Route nodes come from requests to the Playwright `baseURL` of the run's projects (or the
  project's configured route origins); analytics beacons and CDN assets never become nodes.
- **Pages are path patterns.** `/orders/123` and `/orders/456` are one node, as is the same path from staging and
  production.
- **Routes drop the query.** `GET /api/orders?page=2` and `GET /api/orders?status=open` are one node, `GET /api/orders`.
- **Controls and links are templated.** Dates, ids and numbers in an accessible name become placeholders, and each
  page keeps at most 200 controls and 200 links.
- **Branches stay separate.** A default-branch run writes the canonical graph; any other branch writes rows tagged
  with it, so a route added on a pull request never shows as drift on the default branch. Those rows drop when the
  pull request closes, or after 30 days unseen. Detectors read the canonical graph; change coverage reads every branch.
- **Old nodes retire.** A node unseen for 30 default-branch runs that backs no open gap leaves the graph.

## Related

- [Scenario gaps & the Test Map](/features/scenario-gaps): the Gaps tab and triage
- [Probes](/features/probes): the source of the false-comfort and resilience classes
- [Core concepts](/guide/concepts#test-map): the Test Map vocabulary
