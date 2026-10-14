# A test's coverage on the execution page

Since the unified coverage work ([`unified-code-coverage.md`](unified-code-coverage.md)), Piwi stores the **coverage**
of each test: the server files, functions and lines an ASP.NET Core backend ran for it, and the browser files its
pages ran. Nothing shows it to a person yet. Suspect lines, the AI context and the API read it, but the execution page
cannot answer the first question a reader has about it: what did this test run? This plan adds that answer to the
execution page, then a file view that answers the reverse question (which tests run this file), and shows both in the
demo.

**Status.** Proposed 2026-10-14. Not built.

## Why

- **Reading a failure without a change behind it.** Suspect lines name the changed lines a failing test ran. When the
  failure has no change behind it (a data problem, a configuration, a flaky dependency), the reader still wants the
  backend path the test took: which services and handlers ran, and which did not.
- **Trusting what was recorded.** A team turning coverage on has no way to check it today short of calling
  `GET /api/test-run-cases/:id/coverage`: whether the paths are repository-relative, whether the backend's files are
  there, whether a test's capture was incomplete.
- **Finding gaps by hand.** "Which tests reach this file, and which of its lines does none of them run?" is the
  question a developer asks before changing a file. The file view answers it on the web, as the editors will
  (study, part 5).

## What exists

| Piece | What it gives |
|---|---|
| `GET /api/test-run-cases/:id/coverage` | An execution's coverage: per file, its path, `runtime` (`browser` or `server`), `blob`, the `functions` and `lines` that ran, and `incomplete` |
| `GET /api/projects/:id/coverage?file=&branch=` | A file's distinct coverages on a branch (one per file version and set of ranges) and the tests behind each, with their latest outcome |
| `run_coverage` | The run's coverage of each server file, with its **executable** lines; written by `PUT /api/test-runs/:id/coverage`, read by no endpoint yet |
| The source control providers | A file at a commit (`fetchFileAtRef`); a local clone (desktop app) can read any blob by id |
| `OpenInIdeLink` | A path and a line, opened in the developer's editor |
| The execution page's evidence tabs | Timeline, Screen, Source, Locators, Network, Console, State, Performance |
| The demo | Browser file coverage on cluster 5; server line coverage of an ASP.NET Core file on cluster 10 |

## The proposal

### 1. A Coverage section in the execution page's Source tab

**Where.** In the **Source** tab, below the test's source, rather than a ninth tab: the tabs sit above the fold, and
several seeded execution pages are already at or over the 25 controls the page budget allows above the fold
(`app:measure`). Coverage is about source, so the tab fits it (see decision 1).

**What it shows.**

- A summary line: "Ran 12 server files (184 lines) and 5 browser files." When the capture was incomplete (the backend
  no longer held a request's coverage, or the collection failed), the line says so, with a help hint on why.
- Two groups, **Server** and **Browser**. Each file row: its repository-relative path, opening in the editor at its
  first executed line; its precision (lines, functions or file); its counts (executed lines, functions that ran).
  A file the cluster's suspect lines name, or changed since the last passing run, carries a mark linking to the
  cluster's What changed card.
- Order: server files by executed lines, most first; browser files by path. The first 20 rows, then "Show all".
- Empty states, each one sentence with a help hint:
  - coverage off: "This run recorded no coverage" and the reporter option that turns it on;
  - a test that only uses Playwright's `request` fixture: no server coverage yet (see section 5);
  - no instrumented backend: browser files only, and the backend packages that add the server side.

### 2. The source of a covered file

Expanding a server file row shows its source **at the coverage's blob**, the exact version the line numbers refer
to, with the executed lines marked (the same left bar the diff uses for suspect rows) and, when the run recorded run
coverage, the executable lines that did not run in a lighter style. Functions that ran are listed above the source,
each a link to its first line.

- **Source by blob**, a new endpoint, `GET /api/projects/:id/source?path=&blob=`, through the project's source control
  provider: `git cat-file blob` in a local clone, GitHub's and GitLab's blob APIs, and for a provider without one, the
  file at the run's commit, used only when its blob id matches. Cached by blob id (a blob never changes), capped at the
  size the AI context already reads. The dashboard already fetches source from the same providers for the AI
  context, so nothing new leaves the instance.
- **Executable lines** come from `run_coverage`, read for the execution's run through a new read endpoint (or the
  source endpoint's answer).
- A browser file stays at file level until browser lines are captured (study, D13): its row has no source view.

### 3. The file view: which tests run this file

A page under the project, `/projects/:id/coverage?file=`, reachable from a coverage row, from a file node of the Test
Map and from the code index:

- The file's source at the latest coverage's blob, each line marked by how many tests ran it, a line no test runs
  marked as such when executable lines are known.
- A click on a line lists the tests that ran it, with their latest outcome, each linking to its latest execution.
- When the tests recorded different versions of the file, a version selector ("a1b2c3d, 8 tests; 9f8e7d6, 2 tests").

It reads `GET /api/projects/:id/coverage?file=`, the endpoint the editors' coverage index will use, so the web view and
the editors show the same data.

### 4. The demo

- Cluster 10's executions (server lines of the ASP.NET Core API file) and cluster 5's (browser files) already carry
  coverage. The seed adds a few more server files to the Web Dashboard's passing executions, so the list and the file
  view have more than one file to show, and the canned history holds each C# file's full content for the source view.
- The demo router serves the new endpoints from the canned history and the seed, as it does the existing ones.
- A demo example and a tour stop: "Web Dashboard › Users table paginates 25 rows per page: the server lines this test
  ran".
- A screenshot scene for the docs.

### 5. Close first: API tests record no server coverage

The capture fixtures do not wrap Playwright's `request` fixture, so a test that only calls the API records neither
its network requests nor the `X-Piwi-Coverage` ids of its responses: an API suite, the one most likely to run against
an ASP.NET Core backend, gets no server coverage at all. Wrapping the `request` fixture's responses (status, timing,
`X-Piwi-Logs`, `X-Piwi-Trace`, `X-Piwi-Coverage`), as the page capture does, closes it, and gives API suites their
backend logs and network capture too. It is independent of the view and can ship before it.

### 6. The 1.0 surface

The new endpoints (source by blob, run coverage read, the file view's data if it grows) need an entry next to D55 in
[`1.0-stabilization.md`](1.0-stabilization.md).

## Rollout

| PR | Content | Size |
|---|---|---|
| 0 | Capture the `request` fixture's responses (section 5) | 1 |
| 1 | The Coverage section: list, counts, incomplete, empty states, editor links, suspect marks; demo seed and example; docs line | 2 |
| 2 | Source by blob, executable lines from run coverage, the expanded file row | 2 |
| 3 | The file view and its entry points from the Test Map and the code index; tour stop and screenshots | 2 |

Sizes are relative (1 small, 3 large), as in the study's delivery table.

## Decisions for you

1. **A section in the Source tab, or a Coverage tab.** Recommended: the section. The tabs are above the fold, the page
   is at its controls budget on several seeded pages, and coverage is about source. A tab is easier to find; if
   chosen, it counts against the budget.
2. **Source by blob, or line numbers only.** Recommended: by blob, cached, falling back to the numbers when the
   provider cannot serve the blob. Line numbers alone are hard to read.
3. **Show the executable lines that did not run.** Recommended: yes, when the run recorded run coverage; executed
   lines only otherwise. It turns the view into a gap finder, at the price of one more read.
4. **The file view as a page or a drawer.** Recommended: a page, so it can be linked from the Test Map, a pull request
   comment or a chat.

## Non-goals

- Coverage percentages or thresholds per test; trends belong to the reports (study, 6.5).
- Exports (LCOV, Cobertura) and the editors' gutter marks: the study's parts 4 and 5.
- Browser lines and functions: the study's D13 (Istanbul), a capture change, not a view.
