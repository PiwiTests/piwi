# Coverage and the Test Map: one answer to "what do your tests miss"

- Status: accepted
- Date: 2026-10-21

## Context

The fourth thing Piwi is for ([`ROADMAP.md`](../ROADMAP.md), *What Piwi is for*) is finding what the tests miss. Two
programs answer it, built a week apart:

- **Code coverage** ([`unified-code-coverage.md`](../proposals/unified-code-coverage.md),
  [`test-coverage-view.md`](test-coverage-view.md), [`combined-code-coverage.md`](combined-code-coverage.md)): which
  lines and functions each test, and each suite of a commit, ran.
- **The Test Map** ([`scenario-gaps.md`](scenario-gaps.md),
  [`test-map-accuracy.md`](../proposals/test-map-accuracy.md)): which routes, pages and controls the tests reach and
  would notice breaking, and the tests that do not exist yet, as **scenario gaps**.

Each is sound on its own. Side by side, an audit on 2026-10-21 found them telling one question in two voices:

- **"Gap" named two things.** The Test Map's gap is a test to write. The coverage file view called a range of lines
  no suite ran a gap too ("Gap 1 of 3", *Next gap*), while the API, the editors and the rest of the page already said
  *not run* (`unrunLines`, `notRun`, "no suite ran").
- **"Uncovered" had four definitions.** The pull-request section's count, its file list, the *changed, unreached*
  detector and the import scan each decided differently whether a changed file was reached. A file the comment
  counted as reached (by a test of the last 30 runs) still opened a *changed but not reached* gap.
- **Uncovered changes and patch coverage counted different files.** Patch coverage applied the project's coverage
  scope; uncovered changes counted every changed file, so a changed lockfile, README or deleted file read as an
  uncovered change and fed the gate's warning.
- **The comment named no changed line.** A file a test visited counted as covered even when its coverage showed none
  of the changed lines ran, the item the unified study left as "uncovered changed lines" (part 4).
- **One capability hid the other.** Declining the Test Map dropped patch coverage, a coverage measure, with it.
- **The links ran one way.** The Test Map's graph linked a `file` node to its coverage; nothing on the coverage side
  led to the Test Map, and the Gaps tab had no address for a node, so no page could open it on one.
- **Wording claimed more than it knew.** The commit status said "no observed reach" when unit suites counted; the
  comment ended with "Gate `maxUncoveredChanges`: warn." whether or not a gate was configured, and said its window was
  "on `main`" when it is the project's last 30 runs.

## Decision

| D | Decision | Why |
|---|---|---|
| D1 | **Two lenses on one question.** Coverage measures the code: which lines and functions ran. The Test Map measures the application: which routes, pages and controls the tests reach and would notice, and turns what they miss into tests to write. Neither stands in for the other, and each page says where the other is. | A page every test visits can hold a branch no test runs; a line every test runs can sit behind a control no test checks. |
| D2 | **One name per concept** (table below). "Gap" is the Test Map's alone. | The coverage page's "gap" collided with the Test Map's at the one place both meet, the file. |
| D3 | **Each lens leads with its own number, both with their denominator, neither fails a build.** Coverage leads with the line ratio over reference lines ([combined D5, D7](combined-code-coverage.md)); the Test Map with open gaps ranked by exposure, a percentage only over a declared surface ([test-map-accuracy D3](../proposals/test-map-accuracy.md)). | Recorded here so a third surface does not invent a third headline. Unchanged behavior. |
| D4 | **One rule says whether a changed file is reached**, `changeReach`, and every consumer reads it: the count, the comment's lists, the commit status, the gate, MCP, the *changed, unreached* detector and its closing, the import scan. | Four rules gave four answers to one question. |
| D5 | **A changed file counts only when a test could run it**: in the project's coverage scope, not deleted, and observable (a route or page convention maps it, a locator call site, a spec or code reach touches it, or the head commit's coverage counts its changed lines). The others are counted apart, by reason, never as uncovered. | Uncovered changes and patch coverage now count the same files; "nothing can be said" is no longer reported as "no test reaches it". |
| D6 | **Lines where the coverage knows them.** For each changed file the head commit's coverage counts, change coverage carries its changed lines, those that ran, those undetermined, and the ranges no suite ran. The comment names the changed lines not run of every file, reached files included. `--min-patch-coverage` is the gate's line form, `--max-uncovered-changes` its file form; both warn only. | A visit is not a run of the change. This is the unified study's part 4 item "uncovered changed lines" and "the gate's line form", with no new flag. |
| D7 | **Each measure follows its own capability.** The file list is the Test Map's (`test-map`, and the mute of the *changed, unreached* detector); the lines are coverage's. Declining the Test Map keeps the lines; the section goes only when neither has anything to say. | A team that declines the Test Map still uploads coverage, and should still see what of the change ran. |
| D8 | **The lenses meet at the file.** A page file is its page node, a route handler file its handler node and the routes it handles, any executed file its `file` node. The coverage file view lists the file's Test Map nodes with their tests and open gaps, each opening the Gaps tab on it (`?tab=gaps&node=<kind>:<key>`); the graph links a `file` or `handler` node to its coverage when any test or suite recorded it. Each link shows only when its target's capability is not hidden. | The file is the one key both share; the Gaps tab needed an address for a node to be a link target. |

### Vocabulary

Each term is used with this meaning only, in the dashboard, the pull-request comment, the API, MCP and the docs.

| Term | Meaning |
|---|---|
| **Scenario gap** (gap) | A test that does not exist yet, proposed by a detector of the Test Map, with its evidence. Never a range of lines. |
| **Lines not run** | Executable lines no test, or no suite, ran. Wire name `unrunLines`; the editors' `notRun`. |
| **Incomplete coverage** | Coverage a backend lost during a run (it restarted, or could not be reached). |
| **Uncovered change** | A changed file of a diff that is counted (D5) and that no test reached. |
| **Patch coverage** | The share of a diff's changed reference lines that ran, on the head commit's combined coverage. |
| **Changed lines not run** | Of one changed file, the changed reference lines no suite ran. |

### The rule (D4, D5)

`changeReach(file)` is one of:

| Value | When | Counted | Gap |
|---|---|---|---|
| `reached` | a test of this run reached the file, or a suite of the head commit's coverage ran one of its changed lines | yes, reached | closes an open one |
| `reached-earlier` | no test of this run did, but a test of the project's last 30 runs did: a narrowed run, not a missing test | yes, reached | closes an open one |
| `unreached` | observable, and nothing above | yes, **uncovered** | opens *changed, unreached* |
| `not-observable` | nothing maps the file to a test: no convention, call site, spec, code reach or coverage line | no | none |
| `out-of-scope` | the project's coverage scope leaves it out (tests, build output, generated code by default) | no | none |
| `deleted` | the change removed it | no | none |

## Consequences

- **The *changed, unreached* detector opens fewer gaps.** A file reached only in the window, or one Piwi cannot
  observe, no longer opens one; such gaps opened earlier close when their file reaches by any route of the rule. This
  amends the detector row of [`scenario-gaps.md`](scenario-gaps.md) (*no `reaches` edge from any test in this run*)
  and its low-confidence variant for files without evidence.
- **`--max-uncovered-changes` warns on fewer files**: counted, unreached ones. A project that relied on it to flag
  changes Piwi cannot observe sees them in the comment's *Not counted* line instead.
- **Wire changes, before 1.0**: `ChangeCoverageFile.reachBasis` is replaced by `reach`, files gain `lines`,
  `ChangeCoverage` gains `notCounted`, `get_change_coverage` returns both, and `GET /api/projects/:id/gaps/file`
  is new. Registered in [`1.0-stabilization.md`](../proposals/1.0-stabilization.md) (D57).
- **Left as they are**: the internal names of incomplete coverage (`serverCoverageGaps`, `run-coverage-gaps.ts`, the
  `server_coverage_gaps` column) say "gap" while every word a person reads says *incomplete*. Renaming them is a
  column migration and a wire key, for the 1.0 review rather than this change.
- **Not in this decision**: a dashboard view of one run's uncovered changes (today they live in the pull-request
  comment, MCP and the API), per-file gap counts on the coverage overview, and the unified study's code-level gap
  detectors (its part 6.3), which will be scenario gaps whose evidence names lines, under this vocabulary.
