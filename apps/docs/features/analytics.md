---
title: Analytics
description: "Cross-project trends over a period you choose: filters, comparison periods, targets, drill-down to the rows behind a number, and chart export."
lang: en-US
---

# Analytics

<Needs reporter />

The **Analytics** page (`/analytics`) steps back from single runs and tests: it aggregates every
project over a period you choose, to show where the suite as a whole is drifting.

## Scope

The **Filters** block at the top sets what every widget counts, with *Reset* in its header. On a phone
it folds to a one-line summary.

- **Period**, with the comparison and the buckets (below). The line under it states the resolved dates,
  the comparison and any note (a project without the chosen selection, a deleted marker).
- **Runs**: the projects (intersected with the ones you can see), environments and branches (optional
  multi-select, see [Environment](/guide/concepts#environment)), the branch policy (*Default branch* or
  *All branches*, below) and *Full runs only*, which excludes partial runs. All but the projects are the
  **Filters** block a project page opens with, so a drill-down lands on the same runs.
- **Tests**: optional; a selection, test tags or browsers (below).

Probe runs (the fault-injected replays `piwi probe` produces) are never counted, whatever the filters.
Two widgets read past the period: **Flakiest tests** ranks each project's last 50 runs whatever the
period or *Full runs only*, and applies an environment or branch only when exactly one is picked; **Failure
clusters** lists every open cluster, using the period only for its resolved count.

### Periods

- **Rolling**: the last 7 days to 12 months, in whole UTC days, today included.
- **Calendar**: this or last week, month, quarter or year. Boundaries follow your time zone (the one set
  under Settings → Localization, else your browser's); a week starts on your locale's first day.
- **Custom range**: two dates, both included.
- **Since a marker**: from a [timeline marker](./timeline-markers) to now.
- **Release cycle**: between two consecutive `release` markers, the current one or the previous one.
- **Sprint**: a start date and a length, this sprint or the last.
- **All time**: everything still stored.

### Comparison and buckets

Every change on the page is measured against the **comparison**: the previous period of the same length
(the default), the previous calendar unit, release cycle or sprint, the same period a year earlier, or
nothing.

**Buckets** decide how the trends and the heatmap cut the period: automatic (about 31 buckets), daily,
weekly or monthly. Buckets start at UTC midnight, so a heatmap cell is one UTC day.

### Branch policy

By default only runs on each project's **default branch** count, so a broken feature branch does not
move the trends. A run whose branch is unknown (a trace import, a run outside git) counts only in a
project that never reported a branch. The default branch is the project's setting, else
the one its latest run reported, else `main`. *All branches* counts every run; branches picked in the
Filters block override both.

### Test filter

The *Tests* filter narrows every number to some tests:

- a **selection**, by key: `smoke` resolves in each project to that project's
  [selection](/features/test-selection) with that key, so a convention shared across projects works on the
  cross-project page; a project without it is left out and named;
- **test tags**: tests carrying all of them;
- **browsers**: the Playwright projects the executions ran on.

It means the tests that match **today**, with their whole history. The widgets then count from the
stored executions, final attempt per test, browser and `--repeat-each` repetition, so they reach back only
as far as retention keeps runs. A widget that cannot narrow (the failure clusters) says so above its card.

With one project in scope, *Save as selection* stores the tags as a selection you can run with
`piwi run <key>`.

### Sharing a view

The address carries the scope (`?period=last-month&sel=smoke`), so a copied link opens on what its
sender saw; without it, the page opens on the scope you used last in this browser. To keep your own
view, save an [analytics dashboard](./dashboards).

### Where the numbers come from

The pass rates, run counts, durations, CI time, wasted time and regression counts are read from
**daily rollups**, one precomputed row per project, UTC day, environment, branch and run kind, kept at
ingest and checked nightly against the stored runs. When [retention](/operate/storage#data-retention)
deletes old runs, their numbers stay in the rollups, so a one-year pass-rate line survives a 30-day
retention window. Lists of tests and clusters, and anything under a test filter, read the stored runs.
The rollups also [export](/operate/metrics) to a BI tool or a Prometheus scraper. The coverage trend reads the
[combined coverage](./combined-coverage) kept per project and day, which outlives the reports it came from.

## Widgets and metrics

The page is the built-in **Overview** dashboard, in four bands. [Analytics widgets](/reference/analytics-widgets)
lists every widget an [analytics dashboard](./dashboards) can place, and [Metrics](/reference/metrics) defines every
number they show, with its unit and which direction is better.

## Hand-back outcomes

The **Hand-back outcomes** section, in the *Where the pain is* band, says what became of what Piwi handed back over
the period, one line per kind:

- **Locator heals**: call sites whose code now uses the recommended locator, whoever changed it, and the
  [auto-heal](./auto-heal) pull requests merged or closed.
- **AI diagnoses**: those written, rated helpful, and confirmed by a fix that changed the files they named.
- **CI gate**: failed [gate verdicts](./pr-feedback#the-gate-verdict), and pull requests merged anyway, with any
  failure that came back.
- **Flaky tests**: fixes a [Flake Lab](./flake-lab) verify run proved, and those that flaked again.
- **Fix attempts**: fixes a person or an agent reported, and what the runs made of them.

![Hand-back outcomes: locator heals, AI diagnoses, the CI gate and a verified flaky test](/screenshots/analytics-handbacks.png)

A rate needs 10 ratings, pull requests or fixes; below that the line says the sample is too small. The counts
survive retention, and are kept per project and day, so branch and environment filters do not narrow them. A
project that declined a kind's capability is left out of it. Each number is also a [metric](/reference/metrics).

## From a number to its rows

A number links to the list behind it, opened with the same period and filters. In the portfolio, a
project's runs, flaky tests and open failure clusters open that project's lists; each heatmap cell opens
the project's runs of that day. With one project in scope, the headline tiles and every bucket of a chart
do the same. The project page says the list came from Analytics and offers **Show every run**.

## Exporting a chart

Every chart carries a menu in its header. **Copy as PNG** puts the chart, with its title, on the clipboard
as an image, ready to paste into a slide; a browser that cannot copy images downloads the PNG instead.
**Download Excel** saves the numbers behind the chart as an .xlsx workbook, one row per bucket or group:
numbers and dates are real cells, and a test title is never run as a formula. To send a whole
dashboard, export it as a [quality report](./quality-reports) instead.

## Targets

A project can carry **targets**, set in the **Targets** section of its **Settings** tab: a test pass rate to reach, and
limits on flaky tests, wasted CI minutes per week, the age of the oldest open failure cause and the median time to fix.
Each one is optional. Over the period a dashboard shows, a target is **met** or **missed**:

- the headline tiles mark each number that has a target, met or missed, with one project in scope;
- the portfolio's **Targets** column counts the targets each project meets;
- the insights feed says which target a project missed, and by how much;
- a quality report lists every target, met or missed, and its risks name the missed ones.

A weekly target (wasted CI minutes) is scaled to the length of the period, so a 30-day period is checked
against about four weeks of it.

## Marking what you changed

[Timeline markers](./timeline-markers) record a deploy, a CI-runner migration or a dependency bump
against a project, drawn as a vertical line across the trend charts. On the analytics page, with one project in scope every marker
is drawn; across projects only `release`, `infra` and `incident` markers are, labeled with their project — so "the slowdown started the day we switched runners"
becomes something you can see rather than remember.

## Related

- [Dashboards](./dashboards): analytics dashboards of your own
- [Quality reports](./quality-reports): this page as a document, with **Export**
- [Flaky tests](./flaky-tests): the per-project analysis these widgets aggregate
- [Timeline markers](./timeline-markers): annotate the trends with real-world events
- [Cut costly flakiness](/recipes/flaky-cleanup): from the flaky leaderboard to an afternoon of fixes
- [Cut the time it costs](/recipes/faster-suite): where the CI minutes go, and how to get them back
- [UI overview](./ui-overview#analytics): where this sits in the navigation
