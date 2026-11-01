# One Coverage tab: the gaps, the map and the code together

A project's missing tests show in two places that do not know about each other. The **Gaps tab** lists the tests to
write, from what the tests reach: routes, pages, controls, features. The **coverage page** shows what the code ran:
suites, areas, folders, files, lines. They answer one question, *what is not tested?*, at two altitudes, and this
proposal makes them one project tab.

**Status.** Proposed 2026-11-01. Phase 1 is built: the project page's **Coverage** tab holds three views, Gaps, Map
and Code, and the coverage overview lives in Code. Phases 2 and 3 are not started.

## The problem

- **Two places.** Gaps is a tab of the project page. The coverage overview is a page of its own
  (`/projects/:id/coverage`), outside the tab strip, with its own breadcrumb. It is reached from one sentence on the
  Gaps tab ("which lines they ran is on the coverage page") and from a run's coverage fact.
- **No shared data on screen.** The overview's *Least covered here* list ends with "the Test Map's scenario gaps say
  which tests to write"; the Gaps tab names the coverage page in a sentence. Neither shows the other's facts.
- **The join exists in the data, keyed by file.** A *changed, unreached* gap is keyed by its file; a gap on a route,
  a handler or a dependency carries the handler files behind it (`exposureFactorsFor`); an *incidental catch* names
  its cause file; `fileRouteTarget` and `filePageTarget` map a file to the route or page it serves; the feature graph
  already reads a node's file coverage; the editor opens a file's gaps (`?gapFile=`). The screens do not use it.
- **The map and the to-do list share one long page.** The Gaps tab stacks the feature map, the feature graph, the
  ranked list and map health; a person who came to act on a gap scrolls past the map, and one who came to read the
  map scrolls past the list.

## The design

One project tab, **Coverage**, with three views behind a segmented switch, as the Failures tab holds Clusters, Flaky
and Quarantine:

| View | What it shows | Shown when |
|---|---|---|
| **Gaps** (default) | the ranked gaps with their verbs, the status filter, Recompute, the muted detectors | the Test Map is on |
| **Map** | the feature map, the feature graph of a node, map health | the Test Map is on |
| **Code** | the combined coverage at a commit: suites, areas, the file tree, *least covered here* | coverage is on |

- **The view is in the address**: `?tab=coverage&view=gaps|map|code`. `?node=` opens Map on that node; `?gap=`,
  `?gapPr=` and `?gapFile=` open Gaps on what they name; the Code view keeps `?commit=`, `?branch=`, `?folder=` and
  `?area=`. A view's own keys leave with it.
- **`?tab=gaps` stays an alias forever.** Pull-request comments, editor lenses, emails and the browser extension
  carry it, and a comment is never rewritten. It opens the Gaps view (Map when it names a node).
- **The file view stays a page.** `/projects/:id/coverage?file=` is a full-height source viewer, a detail page like
  an execution's: under the project header, the filters and the tab strip it would lose half its height. Its
  breadcrumb's *Coverage* leads back to the Code view. The overview's old address, `/projects/:id/coverage` with no
  file, redirects to the Code view with its query.
- **The tab follows both capabilities.** Gaps and Map need the Test Map (`test-map`), Code needs coverage
  (`coverage`); the tab shows when either is on and opens on the first view it has.
- **The name is the reader's word.** People look for *coverage*; the gaps are what coverage is for, so they are the
  view the tab opens on.

## Phases

1. **Move.** The tab, its three views and their addresses; the overview into Code; the redirect; every link the app
   builds to the overview or the tab; the guided tour, the guide anchors, the docs and the screenshots.
2. **Join.**
   - A gap shows its code: a gap with files names each with the share of its lines the tests ran, linking to the file
     view at its lines not run.
   - A file shows its gaps: the file view lists the open gaps on the file and on the route or page it serves, with
     their verbs, and the Code view's file tree counts open gaps beside *not run*.
   - One scope: the Code view follows the project's branch filter like every other tab, `?commit=` pinning a commit.
3. **Merge findings.** The coverage detectors of [`missing-tests-audit.md`](missing-tests-audit.md) (M7: code nobody
   executes, error path never executed, single covering test by function) raise gaps in the Gaps view's one ranked
   list, each linking to its lines.

## What stays as it is

- **The documentation keeps its pages.** Scenario gaps, combined coverage, coverage insights and uncovered changes
  each fit their word budget; the feature catalog already groups them as *Find what your tests miss*. The pages name
  the tab and its views.
- **The run page's coverage, the execution's coverage and the editor's coverage** stay where the run, the execution
  and the file are. They link into the tab's views.
- **The Home inbox's gap queues** link to the Gaps view.

## Open questions

1. **Whether the Map belongs in the tab at all, or in the Analytics page.** It reads the whole project graph and is
   not a list of work. It stays in the tab: its nodes open the gaps on them, and the gaps open their node.
2. **The filters the Code view ignores.** Coverage is read per commit, so the environment and *Full runs only* filters
   say nothing about it. Phase 2 takes the branch; the view should say which filters do not apply.
