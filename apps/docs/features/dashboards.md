---
title: Dashboards
description: "Saved analytics dashboards: your own arrangement of widgets with its own scope, private or shared, refreshed live, shown in TV mode or scheduled as a report."
lang: en-US
---

# Dashboards

<Needs reporter />

A **dashboard** is a named arrangement of [analytics](./analytics) widgets in bands, with a default
[scope](./analytics#scope): its projects, filters and period. The analytics page is the built-in
**Overview** dashboard; anyone can keep their own dashboards, share them with the team, schedule them
as a [quality report](./quality-reports), and put them on a wall screen.

![A shared dashboard: the checkout smoke tests over the current sprint, with a list, the period's releases and a note](/screenshots/saved-dashboard.png)

## Built-in and saved dashboards

The header's switcher lists every dashboard you can open, with a search:

- **Built-in**: Overview (the analytics page, four bands and fifteen widgets), and the report dashboards
  Executive, Engineering, Team (only once a test in scope has an owner) and Gaps digest (only where the
  [Test Map](./scenario-gaps) is not declined). A built-in dashboard cannot be changed, only duplicated.
- **Shared**: saved dashboards someone shared with every signed-in user.
- **Personal**: your private dashboards.
- **Unused**: shared dashboards nobody opened for 90 days, where their owner or an administrator can
  delete them.

`/analytics/d/<id>` opens one dashboard; *Manage dashboards* (`/analytics/dashboards`) lists them all,
with *New dashboard* (empty, or a copy of any dashboard you can open), *Rename…*, *Duplicate* and *Delete*.
*Rename…*, also in a dashboard's **⋯** menu, changes the name and the description of a saved dashboard you
can edit; duplicate a built-in one first.

## Your default dashboard

`/analytics` opens, in this order: the dashboard you picked with *Make it my default* (kept in this
browser), the dashboard an administrator set for everyone under *Manage dashboards* (a built-in or a
shared one), else Overview. Overview keeps the scope you used last in this browser; another dashboard
opens on its own saved scope. Either way the address carries the scope, so a copied link shows what you
saw.

## Editing a dashboard

*Edit* (or *Duplicate*, on a dashboard you cannot change) turns the page into the editor:

- Each band gets a title, a description, *Add widget* and a menu to move or remove it; *Add band* is at
  the bottom.
- Each widget gets a menu: *Configure*, *Half width* or *Full width*, *Move up*, *Move down*, *Move to
  band*, *Duplicate*, *Remove*. Moves are buttons, so the editor works on a phone and from a keyboard.
  Below the `xl` breakpoint every widget is full width.
- The **Filters** block, titled *Default filters*, sets the scope the dashboard opens with.
- Widgets preview from your unsaved changes. *Save* writes them; *Save as…* writes a new dashboard.

![The dashboard editor: band title and description, Add widget, and a widget's menu](/screenshots/dashboard-editor.png)

If someone saved the dashboard while you were editing it, *Save* says so and offers to reload their
version or save yours as a copy; nothing is overwritten.

### Widgets

*Add widget* lists every widget, grouped by the band it usually belongs to, with a search: the fifteen of
Overview, the report widgets (verdict, what is being done, risks, scenario gaps), the engineering
widgets (ownership, environment comparison, movers; see [Analytics widgets](/reference/analytics-widgets)), and:

- **Metric**: one number of the metric catalog, drawn as a number, a line, bars, a table or a heatmap
  (below).
- **List**: the latest runs of the period, the open failure causes with the most occurrences, the
  flakiest tests, or the highest-scored open scenario gaps, top 5 to 25, each linking to its page.
- **Timeline markers**: the [timeline markers](./timeline-markers) of the period, optionally of some categories.
- **Note**: text in Markdown. Raw HTML is shown as text, so a shared dashboard cannot carry a script.
- **One project**: spec health, slowest tests, performance trend, timeout opportunities and selection
  health, the analyses of the project page. They need a scope with exactly one project and say so
  otherwise.

A widget a later release removed shows "This widget is no longer available" instead of breaking the
dashboard.

### The metric widget

Pick a metric, a display and, optionally, a **breakdown**: "wasted CI minutes by browser", "pass rate by
project tag", "open failure causes by assignee". The breakdowns a metric offers depend on what it
counts:

| Metric counts | Breakdowns |
|---|---|
| Runs and tests (pass rates, durations, wasted and CI minutes, regressions) | project, project tag, environment, branch, run kind; browser, test tag, owner, priority, feature, spec directory |
| Failure causes | project, project tag, error type, status, assignee |
| Quarantined tests | project, project tag, owner, test tag |

With a breakdown, *Bars* and *Table* show one row per group for the period, *Line* one line per group
(the first eight), *Heatmap* one row of buckets per group. Groups are sorted worst first; the top 5 to 25
are shown, the rest grouped as *Other*. Breakdowns by project, environment, branch or run kind
read the daily rollups, so they reach as far back as the rollups do; breakdowns by test or browser read
the stored executions, as far back as retention keeps them.

### Periods and filters per widget

*Configure* also sets a widget's own scope: a period that replaces the dashboard's (a *Last 7 days*
number on a quarterly dashboard), and filters that **narrow** the dashboard's (only some projects, a
selection, test tags, browsers). A widget never widens the dashboard's filters, so what a dashboard
covers can be read off its **Filters** block.

## Sharing and access

- A dashboard is **private** (its owner) or **shared** (listed for every signed-in user). Anyone signed in
  keeps private dashboards; sharing needs the Maintainer role or above on at least one project, or an administrator.
- A shared dashboard is changed by its owner or an administrator; everyone else duplicates it.
- With authentication off, every dashboard is shared.
- **A dashboard grants no access.** Every widget is computed for the projects you can open, and the line
  under the dashboard's name says how many projects of the dashboard's scope are hidden from you
  ("1 project hidden (no access)").
- A private dashboard whose owner is deleted goes with the nightly orphan sweep; a shared one stays,
  editable by administrators.

## Live refresh and TV mode

An open dashboard refreshes a widget when a run of one of its projects finishes, at most once every 30
seconds per widget. Widget answers are cached on the server for 60 seconds.

**TV mode** (*TV mode* in the menu, or `?tv=1`) is for a wall screen: no navigation, larger type, and a full refresh every five minutes on top of the live one. Add `?cycle=12,15&every=60`
to rotate through several dashboards, one every 60 seconds (15 at least). TV mode needs a signed-in
session; a wall screen with nobody signed in opens a [live dashboard link](./share-links#live-dashboard-links)
instead.

## Scheduling and exporting a dashboard

*Export* renders the dashboard on screen as a [quality report](./quality-reports) (the saved dashboard
is offered first), and *Schedule…* creates a [report schedule](./quality-reports#report-schedules) on
it. Deleting a dashboard that schedules render names them first; they stop, shown as inactive with the
reason on the Reports page, until their owner picks another dashboard.

## From an agent

The [MCP server](./mcp) has `list_dashboards` and `get_dashboard`, which returns every widget's data,
the JSON the page renders, over the dashboard's scope; each key you pass replaces the dashboard's.

## Related
- [Analytics](./analytics): the scope, the periods and the widgets of Overview
- [Quality reports](./quality-reports): a dashboard as a document, on a schedule
