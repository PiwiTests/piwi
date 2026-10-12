---
title: Scenario gaps & the Test Map
description: "The Test Map: one graph per project of what the application exposes and which tests reach it, and the scenario gaps it finds: routes, pages and controls no test reaches."
lang: en-US
---

# Scenario gaps & the Test Map

<Needs reporter fixtures />

The test catalog lists the tests you have. **Scenario gaps** describe the ones you don't: the route no test requests,
the page nothing visits, the test that is the only thing standing between a page and no test at all. Each gap is a
suggestion with its evidence and a next step, never a verdict.

Gaps come from the **[Test Map](/guide/concepts#test-map)**: one graph per project of what the application exposes
(routes, pages, controls, links, and the handlers and dependencies behind them) and which tests
[reach](/guide/concepts#reach) each of them. It is built from what the reporter and the [capture fixtures](/guide/capture-fixtures) already record: the requests
and page visits of every run.

> **Observed reach, not coverage.** A gap says a test *observably reached* something, or that nothing did, measured
> from real runs, never from instrumented code coverage. "No edge" means "no evidence", not "proof of absence".

<figure>
  <img src="/diagrams/test-map-graph.svg" alt="Tests reach pages and routes; routes lead to handlers and dependencies; nodes colored by gap class">
  <figcaption>Three rows of a Test Map: a route whose test missed a probe, a page only one test reaches, and surface no test reaches.</figcaption>
</figure>

## What a gap is

A **[detector](/guide/concepts#detector)** reads the Test Map and the last 30 runs and reports one kind of gap: a
route observed only with success statuses, a node exactly one test reaches, a page that appeared in the latest run, a
declared route nothing requests. [Gap detectors & exposure](/reference/gap-detectors) lists every detector with its
evidence. Each gap names its detector and its **[class](/guide/concepts#gap-class)**:

| Class | Meaning | Example |
|---|---|---|
| **blind-spot** | nothing reaches it | `Observed 412 times over the last 30 runs, always 200` |
| **false-comfort** | the tests pass without checking it: a [probe](/features/probes) broke it, or the app logged an error, and they still passed | `Tests pass when POST /api/orders breaks` |
| **fragile** | what reaches it could stop at any time | `Only checkout › coupon reaches this` |

[Server probes](/features/probes#server-probes) add **findings** in two more classes, **unhandled** and **degraded**:
the application itself did not cope with the fault, whatever the tests saw.

Gaps are ranked by **[exposure](/guide/concepts#exposure)**, a score from how often the code around a node changes,
how old it is, whether it was part of an earlier escaped failure, and the priority of the tests near it. The score
and its factors show on every gap. Counts are per class, never a coverage percentage: a percentage over an observed
surface looks complete exactly when that surface is sparse.

A changed file no test reaches is a gap too, raised at pull-request time: see
[Uncovered changes in pull requests](/features/uncovered-changes). So is a page with open
[bug reports](/features/bug-reports): a defect that escaped the suite there.

## The Gaps tab

The project page has a **Gaps** tab: gaps and findings grouped by feature and ranked, each with its class, its score
factors and its evidence lines.

The tab opens on the **feature map**: one circle per feature (from the
[`piwi:feature` tag](/reference/test-metadata)), sized by the routes, pages and controls it groups, colored by its
worst open gap, and linked to the features it shares nodes with. A feature also groups what its tests miss nearby,
such as the controls on its pages, and a **hub** most tests reach links no features
([how features group](/reference/gap-detectors#features)).

<figure>
  <img src="/screenshots/scenario-gaps-feature-map.png" alt="Feature map: four feature circles colored by worst gap, beside their counts">
  <figcaption>Four features of an admin console, each with what it groups, its tests and its worst gap.</figcaption>
</figure>

A feature, or a gap's node, opens in the **feature graph**: the node in the middle, what leads into it on the left,
what it leads to on the right, nodes colored by class and edges by kind. The **neighbors** list under it has every
neighbor; click a node to recenter on it. Agents walk the same graph with the
[`get_feature_graph`](/reference/mcp-tools#get_feature_graph) MCP tool.

<figure>
  <img src="/screenshots/scenario-gaps-graph.png" alt="Feature graph centered on the page /settings/api and its neighbors">
  <figcaption>A page one test reaches: what leads to it on the left, what it contains, links to and loads on the right.</figcaption>
</figure>

## Triage

Every gap takes the same four verbs as an inbox item:

<figure>
  <img src="/screenshots/scenario-gaps-tab.png" alt="Five ranked gaps of the Users feature with evidence and triage verbs">
  <figcaption>The top gaps of one feature, ranked, each with its evidence and the inbox verbs.</figcaption>
</figure>

- **Accept** copies a draft test skeleton to your clipboard: a title from the gap, the `piwi:` annotations of the
  nearest test, the path from a reached page to the gap as steps, and a TODO where the assertion goes.
- **Snooze** for a day, a week, or until the node changes.
- **Dismiss** with a reason: *not worth testing*, *covered elsewhere* (which records the covering test as reaching the
  node), or *wrong*.
- **Covered by** names the test that covers it and closes the gap. A gap closed this way stays closed when its
  detector raises it again, and the covering test is recorded as reaching the node.

Gaps persist, so triage survives recomputation: a dismissed gap keeps its verdict, and a gap **closes itself** when
the detector no longer finds it, for example once its node gains a trusted test, so "closed this month" is real. A
closed gap that comes back reopens, unless it was closed with **Covered by**. Home lists the gaps accepted more than a week ago whose test was never written.

<figure>
  <img src="/diagrams/scenario-gaps-loop.svg" alt="Sources feed the Test Map, detectors, ranking and delivery; triage flows back">
</figure>

Every verdict is also a labeled example: accepted and covered-by count *for* a detector, dismissed as *wrong* counts
*against* it. A detector below 60% precision on a project with twenty or more verdicts **mutes itself** there: its
rows leave the pull-request comment and the Gaps digest, its gaps sort last in the Gaps tab, and the Gaps tab and
**Settings → About** say so.

The top new gaps of each project are the **Gaps digest**
[quality report](/features/quality-reports#what-a-report-contains); [schedule it](/features/quality-reports#report-schedules)
to your channels. Agents list, draft and triage gaps with the
[MCP tools](/reference/mcp-tools#list_scenario_gaps), and the
[write-the-missing-test](/features/agent-skills) skill drives the loop.

## What feeds the map

Every run adds the routes its tests requested on the application's own origin and the pages they ran locator calls
on or ended on. Three optional sources add the rest:

- **The page inventory.** With `capturePageInventory` on (off by default), the reporter records the controls (role
  and accessible name) and links of each page a passing run visits, at most 200 of each per page, never a field
  value. Control and link nodes, and the detectors that read them, appear only then. See
  [Page inventory](/guide/concepts#page-inventory).
- **Server spans.** With the [backend instrumentation](/guide/backend-logs#server-spans) for Nitro, each route gains
  the handler that served it and the dependencies that handler called.
- **The declared surface**, below.

### Declared surface

Beyond what tests observe, the map can hold what the application *declares* it exposes, so a route or page nothing
reaches is named a **declared, never hit** blind spot instead of staying invisible. Three sources feed it:

- **The instrumentation's route manifest.** The [backend instrumentation](/guide/backend-logs#route-manifest) serves
  the application's routes at `/__piwi/manifest` outside production, and the reporter uploads it with the run.
- **A committed manifest.** A `piwi.manifest.json` next to your Playwright config (`{ "routes": [...], "pages": [...] }`)
  is uploaded whenever present, whatever the backend.
- **An OpenAPI URL**, set per project under Project → Settings → Capabilities → Scenario gaps. Piwi fetches the document
  on a recompute and records each route's documented response codes, so a *success only* gap can name the error codes a
  route documents but never returned under test.

### Map health

Under the gap list, **map health** counts each input against what it could hold and names the detectors it wakes;
an input that is short shows the step that fills it, so a quiet tab is not mistaken for a covered application.

<figure>
  <img src="/screenshots/scenario-gaps-map-health.png" alt="Map health: seven inputs of a Test Map, probes short at 7 of 16 routes">
  <figcaption>Six inputs complete; probes reach 7 of 16 routes, with the step that adds the rest.</figcaption>
</figure>

## What this is not

- **Not a test generator.** A gap proposes a scenario; the assertion is yours.
- **Not a gate.** Uncovered changes can only warn; see [the gate flag](/features/uncovered-changes#the-gate-flag).

The Test Map and its server probes are optional: [decline](/operate/capabilities#declining-a-capability) either per
project or for the instance, and these surfaces disappear.

## Try it in the demo

<DemoExamples />

## Related

- [Uncovered changes in pull requests](/features/uncovered-changes): the changed files no test reaches
- [Probes](/features/probes): whether a test that reaches a route would notice it breaking
- [Gap detectors & exposure](/reference/gap-detectors): every detector, the exposure factors, what the graph includes
- [Core concepts](/guide/concepts#test-map): the Test Map vocabulary
- [Agent skills](/features/agent-skills): write-the-missing-test
