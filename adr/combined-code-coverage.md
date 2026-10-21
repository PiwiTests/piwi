# Combined code coverage: end-to-end and unit tests, per commit

- Status: accepted
- Date: 2026-10-17

A study of how to compute one code coverage ratio that counts every test a team runs: the Playwright suite Piwi
already records ([`unified-code-coverage.md`](../proposals/unified-code-coverage.md), browser and server), and the unit tests of the
front end and the back end, whose coverage reports Piwi would import. It answers three questions: how to combine
reports from tools that do not agree on which lines can run, where the denominator comes from, and what Piwi shows on
top that a coverage service does not. The numbers below were measured on Piwi's own Vitest suite and on the .NET
instrumentation tests run under three tools; [Appendix A](#appendix-a-measurements) gives the method and the raw
numbers.

**Status.** Proposed 2026-10-16. Decided with the author: Piwi imports and combines the reports (rather than only
exporting its own coverage for Sonar or Codecov to combine), reports are keyed by commit, and the browser end-to-end
suite counts by functions first and by lines later. The unit tools to support first are coverlet, Microsoft code
coverage and Vitest. The plan builds on browser function coverage (`coverage.browser: 'functions'`) and coverage on
every page and document a test opens, both on main since 2026-10-16. How .NET lines are counted on a large solution,
and what it costs, is [Part 6](#part-6-net-lines-on-a-large-solution). New wire fields, options and
endpoints freeze at 1.0 and need an entry in [`1.0-stabilization.md`](../proposals/1.0-stabilization.md).

**Built** 2026-10-17 in #819: delivery PRs 1 to 9, with the 1.0 entry (D56). Left for later, as the plan says: PR 10
(browser lines through `ast-v8-to-istanbul`) and the suite behind a line on hover in the editors.

**Summary.** The arithmetic is a union of line ranges; the work is in agreeing on which lines count. On the same 71
.NET tests, Microsoft code coverage counts **1,058 executable lines** in 14 files where Piwi's compiler instrumentation
counts **755**: 288 of the 312 extra lines are braces. Taking the union of both as the denominator understates code
that only the end-to-end tests ran by **16 points** (39.6% against 55.6%). Taking the **span table as the one
denominator**, and counting the unit tool's executed lines on it, lands within **1.3 points** (54.6% against 55.9%).
The denominator comes mostly from the unit reports: Vitest lists every file `coverage.include` names, run or not (148
of Piwi's 704 files ran no line), and both .NET tools list every line of each assembly they instrument. Files no
report names are counted from the commit's file inventory (its tracked files), outside the percentage. On the browser, V8's function coverage
already reports the functions that did not run, so a browser function ratio costs nothing beyond
`coverage.browser: 'functions'`. Storage is small: Piwi's 704-file Vitest report (1.48 MB of LCOV) is 350 KB in
Piwi's model, 67 KB gzipped, and a commit a day later shared 94.2% of its file records with it. On a synthetic
solution of 1.35 million lines of C#, reading every span table takes 0.3 s and the backend's run-level report 0.5 s,
while Microsoft code coverage and coverlet add 42 to 93 s to a one-test run and write 176 to 185 MB of Cobertura.

## What the reader gets

- **One ratio per commit**, with its denominator: "71.4% of 12,480 lines ran, 3 suites", per suite and per folder.
- **Per line, which suites ran it**: unit only, end to end only, both, none. "End to end only" is what the Playwright
  suite alone protects; "unit only" is code no user path reaches in the tests, a candidate for an end-to-end test or
  dead code.
- **Patch coverage in the pull-request comment**, counting unit tests: "34 of the 41 changed lines ran (unit 28, end
  to end 19)".
- **Uncovered changes that stop reporting a changed file a unit test covers**: today such a file shows as a gap.
- **Trends** in Analytics and the quality reports, kept after retention.
- **An export** of the combined coverage as LCOV or Cobertura, for Sonar or Codecov.

## Vocabulary

Each term below is used with this meaning only. Terms from the coverage study (coverage, granularity, span table,
fragment, runtime) keep theirs.

| Term | Meaning |
|---|---|
| **Coverage report** | One tool's coverage of one suite's whole run, for one commit: per file, its executable lines and the lines that ran. Attributed to no test. |
| **Suite** | The tests a report comes from, named by the team when uploading (`unit-back`, `unit-front`), of kind `unit` or `e2e`. `e2e` is the Playwright suite Piwi records itself. Not Playwright's `describe` block. |
| **Executable lines** | The lines a tool can mark as run. Each tool decides which lines these are. |
| **Reference lines** | The executable lines the ratio counts for one file version, taken from one tool (D5). |
| **Undetermined lines** | Reference lines no suite ran, inside a function that a suite recording functions only ran: the browser end-to-end suite, until it records lines. |
| **File inventory** | The tracked files of a commit and their git blob ids, from `git ls-tree`, sent with each upload. |
| **Carried forward** | A suite's coverage of a file reused from an earlier commit where the file has the same blob id. |
| **Patch coverage** | The share of a change's added and modified lines that ran. |
| **Scope** | The include and exclude patterns that decide which files count, set per project. |

## What exists

- **`run_coverage`**: a run's coverage per file, attributed to no test, written by `PUT /api/test-runs/:id/coverage`
  from each backend's `/__piwi/coverage/run`. Server files carry their **executable lines** from the span table.
  Browser coverage is per test only (`test_coverage`): files, or, with browser function coverage, the functions that
  ran.
- **Executable lines per file version**: `getExecutableLines` (`server/utils/coverage.ts`) reads them for a blob from
  any run, since they depend on the file's content alone.
- **A per-file ratio** in the file view: "ran X of its Y executable lines" (`app/utils/file-coverage.ts`). No total
  over files exists anywhere.
- **Range helpers** in `@piwitests/core/coverage`: `normalizeLineRanges`, `intersectLineRanges`, `countLines`,
  `encodeLineRanges`, and the content-addressed `coverage_fragments`.
- **Blob ids** from the reporter's checkout (`gitHashObjects`, `git hash-object --stdin-paths`).
- **Runs** carry `is_full_run` and `branch` as columns; the commit is only in `metadata.scm.commit`.
- **Uncovered changes** join changed files to observed reach: routes and pages by Nitro and Nuxt conventions, locators,
  and coverage. No unit test counts.
- **Nothing reads coverage from outside Playwright.** The unified study lists unit-test coverage under "Not in this
  plan"; this proposal replaces that line.

## What the tools produce

Measured on Vitest 4.1.10 (v8 provider), coverlet.collector 6.0.4, Microsoft.NET.Test.Sdk 18.10.1 and Piwi's
instrumentation built with the .NET 10.0.402 SDK:

| Tool | Format used | Paths in the report | Files nothing ran | Executable lines |
|---|---|---|---|---|
| **Vitest** | LCOV, Cobertura (also Istanbul JSON) | LCOV relative to Vitest's root (`app/composables/useAiStatus.ts` for a root of `apps/application`); Cobertura: the root as `<source>`, relative file names; JSON: absolute | listed only with `coverage.include` set, and only when every test ran (not with `--changed` or a single file) | Istanbul statements, converted from V8 by `ast-v8-to-istanbul` |
| **coverlet** | Cobertura (also LCOV, OpenCover) | the common directory of a module's files as `<source>`, relative file names | every line of each assembly it instruments | PDB sequence points |
| **Microsoft code coverage** | Cobertura | absolute file names, no `<source>` | every line of each module it instruments | PDB sequence points |
| **Piwi, ASP.NET Core** | Piwi's model | repository-relative | every statement of each module that ran a method (prerequisite 1) | compiler statement spans |

- **coverlet and Microsoft code coverage agree**: on the 7 files both instrumented, 497 common executable lines and 7
  more for coverlet (declaration lines).
- **The compiler spans differ**: against Microsoft code coverage, they skip braces, `catch` keywords and the
  declaration lines of static fields and constructors (312 lines, 288 of them braces), and count 9 auto-property lines
  it does not.
- **A tool can leave code out without failing**: coverlet did not instrument the library under test, an assembly
  with an ASP.NET Core framework reference. Only its diagnostic log said so (it could not resolve
  `Microsoft.Extensions.Logging.Abstractions`), and its suggested `PreserveCompilationContext` did not help. Such code
  is visible only as files no report names (D7).

## Decisions

| D | Decision | Why |
|---|---|---|
| D1 | A coverage report is keyed by project, commit and suite; it records the branch, the tool and the suite's kind (`unit` or `e2e`). The `e2e` suite is the union of the run coverage of the commit's full Playwright runs. Reports of the same commit and suite merge, like shards. | Unit and end-to-end tests run in different jobs, often different pipelines; the commit is what they share. Four portals' Vitest reports go up as one `unit-front` suite. |
| D2 | Cobertura and LCOV are the formats read first. Istanbul JSON, OpenCover and JaCoCo wait for a request. | Cobertura alone covers the three tools in use (Vitest has a `cobertura` reporter); LCOV is Vitest's and coverlet's other common output. |
| D3 | Reports are parsed and their paths resolved by the CLI, before upload. The dashboard receives Piwi's model only (`{ v: 1, files }` with executable lines). | No XML parser on the server, and the checkout, needed for paths and blob ids, is on the machine that ran the tests. |
| D4 | Lines combine only within one file version, the git blob, as everywhere in coverage. | A line number means nothing across versions. |
| D5 | **Reference lines per file version**: the span table's executable lines when any run recorded them for that blob; otherwise the unit report's; the union when two unit tools report the same version. A suite's executed lines count on the reference lines only. | Measured: the union of a span table and Microsoft code coverage understates end-to-end-only code by 16 points; the span table as reference stays within 1.3 points (Appendix A). |
| D6 | The browser end-to-end suite counts in the **function ratio** now, with the functions V8 reports as not run as its denominator, and in the line ratio as **undetermined lines** until it records lines. | Decided with the author. Counting every line of a function that ran would overstate; ignoring them would hide what the Playwright suite runs. |
| D7 | Files in scope that no report names count as **files without coverage data**, from the file inventory, never in the percentage. | The Test Map's rule: a percentage only over a known denominator ([`test-map-accuracy.md`](../proposals/test-map-accuracy.md), D3). It also exposes code a tool left out. |
| D8 | A suite missing at a commit is **carried forward** from the newest earlier commit with that suite, on the same branch then on the default branch, file by file where the blob id matches the inventory, and labeled with that commit. | Not every pipeline runs every suite on every commit; a blob match keeps line numbers valid. |
| D9 | One scope per project (include and exclude patterns), applied when totals are computed; a change recomputes the totals of the reports still kept. Default excludes: test files (`*.test.*`, `*.spec.*`, `tests/`, projects named `*Tests`), `obj/`, `bin/`, generated sources. | Each tool has its own excludes; one scope keeps the suites comparable. |
| D10 | No gate fails a build on coverage. `--min-patch-coverage` warns only, like `--max-uncovered-changes`. | The study's rule, unchanged: the number informs, it is not a target. |
| D11 | A report carries coverage only: no test names, no results, no hit counts. | Piwi stays Playwright-only ([`ROADMAP.md`](../ROADMAP.md), Non-goals): unit tests are an input to coverage, never results Piwi keeps. |
| D12 | `run_coverage` stays as the end-to-end storage of the executed lines; uploaded reports get their own tables, sharing `coverage_fragments`. Executable lines are stored once per file version, in their own table, not on every run. | No migration of the executed lines; the uploads, repeated on every commit, are the volume content addressing saves. Executable lines depend on a file's content alone: on 1.35 million lines of C#, they are 1.4 MB that every run would otherwise store again (Part 6). |
| D13 | The CLI sends paths, line numbers and blob ids, never source code. | The privacy page's promise for the `functions` and `lines` granularities, extended to uploads. |
| D14 | No solution or project file is read. A .NET file's executable lines come from the span table the compiler wrote into its assembly; which projects count is which projects reference the coverage package; files outside them come from the file inventory and the scope. | The span table lists exactly what each assembly compiled (linked files, Razor views at their `.cshtml` lines, no `obj/` output), which a `.sln` or `.csproj` tells only through an MSBuild evaluation: the .NET SDK on the uploading machine, and seconds per project (Part 6). |

## Part 1: the upload

### 1.1 The command

```
piwi coverage upload <file or pattern>... --suite <name> [--kind unit|e2e] [--root <dir>] [--format cobertura|lcov]
```

- `--suite` names the suite (`unit-back`, `unit-front`); `--kind` is `unit` by default.
- `--root` is the directory a report's relative paths start from. Without it, each path is tried against the report's
  `<source>`, the current directory, the report's directory and the repository root, and the first that names an
  existing file wins. A path that matches no file is dropped and counted: "12 paths matched no file in the checkout:
  check `--root`".
- `--format` is detected from the content when absent.
- The project, server URL and API key are read as the reporter reads them (`PIWI_PROJECT_NAME`,
  `PIWI_DASHBOARD_URL`, `PIWI_API_KEY`), the branch from the CI variables or `PIWI_BRANCH`, the commit from git.
- Patterns are expanded by the command itself, so `"**/coverage.cobertura.xml"` works the same in bash and PowerShell.
- The same command uploads a backend's run-level report from its own tool, for a stack Piwi does not instrument (c8
  for a Node server, coverage.py, JaCoCo through a Cobertura converter): `--kind e2e --suite e2e-server`.

### 1.2 Paths and blob ids

- Paths become repository-relative POSIX paths: backslashes turned into slashes, the repository root stripped from
  absolute paths, the deterministic `/_/` root (a .NET build with `ContinuousIntegrationBuild`) read as the repository
  root, as `PiwiSourceFiles` does.
- Blob ids come from `git ls-tree -r HEAD` for files the checkout leaves unchanged, from `git hash-object` for the
  others, as the reporter computes them.
- The **file inventory**: the paths and blob ids of the tracked files in the project's scope (read from the
  dashboard), sent once per commit.

### 1.3 The parsers

In `@piwitests/core/coverage-formats`, pure and without dependencies (the MIT side):

- **Cobertura**: a tag scanner reading `<source>`, `<class filename>`, `<line number hits>`, and each `<method>`'s
  lines for its start and end line; no DTD, no entities. Class-level lines only, since methods repeat them. Vitest's
  Cobertura gives a method its declaration line only.
- **LCOV**: `SF`, `DA`, `FN`, `FNDA`, `end_of_record`. `FN` gives a function's start line, and its end line when the
  writer includes it; Vitest's gives the start line only.
- A function known by its start line only is matched with the other suites' functions by that line.
- A line with a hit count above zero ran; every listed line is executable. Measured: 4.4 MB of Cobertura scanned in
  0.1 s.
- Reports are read as a stream, never whole: on a 1.35-million-line solution, one test's Cobertura is 176 to 185 MB
  (Part 6).

### 1.4 The endpoint

`POST /api/projects/:id/coverage-reports` with `{ v: 1, commit, branch, suite, kind, tool, inventory?, files }`, each
file `{ path, blob, executable, lines, functions?, allFunctions? }`: `functions` keeps its meaning, the functions that
ran; `allFunctions` lists every function the tool knows, run or not, the function ratio's denominator. Permission
`run:submit` (the Uploader role). The
limits of run coverage apply (16 MB and 20,000 files per request); the CLI splits larger reports, and the parts merge.

## Part 2: storage

| Table | Holds | Key |
|---|---|---|
| `coverage_reports` | One suite's report for one commit: `project_id, commit, branch, suite, kind, tool, incomplete, created_at`, the inventory as a `case_payloads` row | unique `(project_id, commit, suite)` |
| `coverage_report_files` | Which fragment each file of a report has | unique `(report_id, path)` |
| `coverage_fragments` (exists) | Gains `executable`, for uploaded reports; the canonical string gains a sixth element only when executable lines exist, so existing fragment hashes stay valid | unique `(project_id, hash)` |
| `coverage_executable` | The executable lines of one file version, from the span table: `project_id, runtime, path, blob, lines`. Written by the first run that sends them, read by `getExecutableLines`; `run_coverage.executable` is no longer filled | unique `(project_id, runtime, path, blob)` |
| `coverage_totals` | Per project, commit and suite, plus `combined`: executable, executed and undetermined lines, known and run functions, files without data, files carried forward, the scope version | unique `(project_id, commit, suite)` |
| `coverage_daily` | Per project, day, branch and suite: the totals of the day's last commit with coverage | unique `(project_id, day, branch, suite)` |
| `test_runs.commit` (new column) | The run's commit as a column, from `metadata.scm.commit`, indexed with the project | |

- **Totals** are computed after each upload and each finished run with coverage, once per commit at most every few
  seconds, so four shards and three suites trigger one computation.
- **Retention**: a branch's reports go with its other coverage rows (its pull request closed, or 30 days); on the
  default branch, the newest commit and one commit per day are kept for 90 days; `coverage_daily` is kept like the
  analytics rollups. Fragments no report or run references are collected by the existing rule, extended to report
  files.
- **Size**: Piwi's Vitest report is 350 KB in the model. A fragment is shared when a file's version and executed
  lines are both unchanged: between two commits a day apart, 94.2% of the files shared theirs, so a commit stored about
  20 KB (Appendix A).

## Part 3: the calculation

For one commit, per file version in scope (path and blob):

1. **Reference lines** (D5): the span table's when known for that blob, else the unit report's. A file can take its
   reference from different tools on two commits (a version no coverage build has run yet); the totals count the
   files of each kind, and prerequisite 1 gives every instrumented assembly its span table.
2. **Executed**: a reference line ran when any suite's report of that blob marks it, end-to-end server lines
   included. A line a tool marks outside the reference lines is ignored.
3. **Undetermined** (D6): reference lines no suite ran, inside a function the browser end-to-end suite ran. Shown next
   to the ratio, never added to it: "71.4% of lines ran; 3.1% more are in functions the end-to-end tests ran, lines not
   recorded".
4. **Functions**: the functions known per file version, matched by start line across suites (the unit reports'
   methods, the span table's methods, V8's functions run or not); a function ran when any suite ran it.
5. **Files**: a file in the inventory and the scope that no report names counts among the files without coverage
   data (D7). A browser file recorded at `files` granularity counts as reached, outside both ratios.
6. **Carried forward** (D8): for a suite absent at the commit, its newest earlier report fills the files whose blob is
   unchanged; the totals say how many files and from which commit.
7. **Full runs only** for the `e2e` suite: a partial run's coverage is stored and still feeds uncovered changes, but
   not the totals.

Each line falls in one class: **unit only**, **end to end only**, **both**, **none**, or **undetermined**. A folder's
breakdown is the sum of its files'; a suite's own ratio is computed on the same reference lines, so the suites'
ratios compare.

## Part 4: what it shows

- **The run page**: one line in the run summary when the run's commit has coverage: "Coverage at a1b2c3d: 71.4% of
  12,480 lines, 3 suites", linking to the project's coverage page.
- **The project's coverage page** (`/projects/:id/coverage` without `?file=`): the commit's totals per suite, the
  files without data, then a folder tree with each folder's ratio and breakdown. A file opens the existing file view,
  whose line marks gain the suite that ran each line.
- **Pull requests**: the comment gains a patch coverage line; the Uncovered changes section counts a changed file as
  reached when any suite ran one of its changed lines, unit suites included. `piwi gate --min-patch-coverage <percent>`
  adds a warning, never a failure (D10).
- **Analytics and quality reports**: a coverage trend widget and a report line, from `coverage_daily`.
- **MCP**: `get_coverage_summary` (a commit's totals and a folder's breakdown, read-only); `get_coverage` names the
  suites behind a line.
- **Export**: a commit's combined coverage as LCOV or Cobertura (the study's part 4).
- **Later, in the editors**: the suite behind a line on hover ("ran in unit-back").
- **No pollution**: a project with no coverage sees none of it; the Setup ladder offers it.

## Part 5: prerequisites found on the way

1. **.NET executable lines cover only the modules that ran a method.** A module registers on its first
   `CreatePayload` call (`PiwiCoverageRecorder.Register`), and `PiwiCoverageReport.AddExecutableLines` walks the
   registered modules: an instrumented assembly whose code never ran has no executable lines. Fix: at report time,
   also read the span table of every loaded assembly carrying `<DynamicAnalysisData>`, and of the assemblies in the
   application's base directory, through `System.Reflection.Metadata` without loading them.
2. **A backend built from another commit than the reporter's checkout** gets the checkout's blob ids on lines that
   belong to another version (`test-coverage.ts`, `BlobIds`). The span table's document rows hold each source file's
   checksum, which `SpanTable.cs` reads past. Serve it with the coverage, and have the reporter compare it with the
   checkout's file and drop the line data of a file that differs, marked incomplete. The checksum is over the bytes
   the compiler read, so both line ending forms are compared.
3. **Browser functions that did not run are dropped**: `executedFunctionRanges` (`packages/core/src/code-reach.ts`)
   skips V8's entries with a count of 0. Checked on Chromium: V8's function coverage lists the declared functions,
   arrow functions and class methods that did not run, but not the functions nested in a function that never ran,
   which the outer function's range contains. The reporter keeps them, as `allFunctions` of the run's browser
   coverage, sent at run end with the run coverage.
4. **`test_runs.commit`**: a column, filled from `metadata.scm.commit` for existing runs.
5. **Later, browser lines**: V8 block coverage converted by `ast-v8-to-istanbul`, the converter Vitest 4 uses, so
   browser lines count like Vitest's. It costs what block coverage costs (+29% to +35% of test time, study), so it
   belongs in a nightly job. Until then the browser end-to-end suite gives functions and undetermined lines.
6. **.NET unit tests through Piwi's instrumentation**, recommended for a large solution (Part 6): a unit-test build
   with `-p:PiwiCoverage=true` and `PIWI_COVERAGE_MODE=run`, whose recorder writes its run-level report at process
   exit (`PIWI_COVERAGE_OUTPUT`), uploaded with `--format piwi`. Checked: a `ProcessExit` handler in the test host
   wrote the report of the 71 tests. Lines then match the end-to-end suite exactly; coverlet and Microsoft code
   coverage stay supported with the difference measured.

## Part 6: .NET lines on a large solution

How the ratio counts a C# file's lines, from which component, and what it costs on a solution far larger than the
applications measured so far.

### 6.1 Where each number comes from

| Number | Comes from | When |
|---|---|---|
| **Executable lines**, the denominator | The span table the C# compiler writes into each assembly built with `-p:PiwiCoverage=true`, read by `PiwiTests.Instrumentation.Coverage` | When the backend serves its run-level coverage; with prerequisite 1, for every instrumented assembly in its directory, read from disk without loading it |
| **Executed lines, end to end** | The same package's recorder, in the backend | Per test and per run, as today |
| **Executed lines, unit tests** | coverlet's or Microsoft code coverage's Cobertura, their hits counted on the span table's lines (D5); or the same recorder in the test host (prerequisite 6) | At upload |
| **Executable lines of a version no coverage build ran** | The unit report's own lines (D5) | Until a coverage build runs that version |

Nothing in Piwi parses C#: the compiler decided which lines are statements when it built the assembly, and Piwi reads
its table.

### 6.2 What it costs

A synthetic solution: 20 class libraries, 10,000 files, 1.35 million lines of C# (methods with loops, branches,
`async`, `try` and `catch`, `switch` expressions, LINQ lambdas, auto-properties), 560,000 executable lines in their
span tables. .NET 10 SDK, Release builds, a 4-core sandbox, each step run two or three times.

| Step | Cost |
|---|---|
| Build with `-p:PiwiCoverage=true` | 49 to 54 s, against 42 s without (+15% to +27%), after a warm-up build |
| Assemblies | 55 MB against 32 MB (+73%), of which 5.3 MB of span tables |
| Reading an assembly's span table, at the first call into it | 9 to 10 ms (median), 0.3 s for the 20 |
| Reading every span table from disk, without loading the assemblies (prerequisite 1) | 0.3 s |
| The backend's run-level report with executable lines | 0.5 s, 3.5 MB of JSON, 90 MB allocated while it is written |
| Blob ids of the 10,000 files | 0.3 s with `git hash-object --stdin-paths`, 0.02 s with `git ls-tree -r` |
| The dashboard reading that report (parse and normalize) | 0.2 s |
| Executable lines to store | 320,000 ranges, 1.4 MB as text |

The unit tools on the same solution, with one test calling one method per library: the fixed cost of instrumenting
and reporting, not the cost per test.

| | Test run | Cobertura | Executable lines | Read by the CLI, as a stream |
|---|---|---|---|---|
| No coverage | 2.1 to 2.3 s | | | |
| Microsoft code coverage | 44 to 48 s | 185 MB | 580,021 (+3.6% against the span tables) | 2.9 s, 333 MB of memory |
| coverlet | 95 s | 176 MB | 610,379 (+9%) | 2.7 s, 344 MB |

- **The span table is not the slow part.** Reading it takes well under a second for 1.35 million lines, at startup or
  at the run's end. The build is: a coverage build compiles 15% to 27% slower and its assemblies are 73% larger.
- **Executable lines are stored once per file version (D12).** At this size they are 1.4 MB, the same on every run
  of an unchanged file.
- **Cobertura is read as a stream.** The prototype kept each file's lines in sets (333 to 344 MB); two bits per
  source line, executable and executed, are about 340 KB for this solution.
- **For a large solution, unit tests through Piwi's recorder cost less** (prerequisite 6). When the pipeline already
  builds the coverage build for the end-to-end environment, the unit tests run on those binaries, and the report adds
  0.5 s and 3.5 MB at the test host's exit. Otherwise it costs that build, 49 to 54 s here: about what Microsoft code
  coverage adds, half what coverlet adds. The cost per call during a long suite was not measured here: in the study,
  `run` mode added 6% backend CPU on the pricing application, coverlet with hit counts 19%.
- **The gap between line counts depends on the code.** On this synthetic code, mostly expression-bodied members,
  which have no braces, the unit tools count 3.6% and 9% more lines than the span tables; on the real code of
  Appendix A, 40% more. Real code is closer to the second, so D5 matters.

### 6.3 Why not the solution file (D14)

- A `.sln` or `.slnx` file names projects. Which files a project compiles comes from evaluating it with MSBuild: SDK
  globs, `Compile Remove`, conditions per target framework, linked files, source generators. That needs the .NET SDK
  on the machine that uploads, and seconds per project.
- The span table already holds the result of that evaluation for each instrumented assembly. The
  `Directory.Build.props` item that adds the package (with `IsTestProject != true`) is where a team already says
  which projects count.
- A project left without the package still shows: its files are in the file inventory and in no span table, so they
  count among the files without coverage data, which the totals name.
- An assembly the end-to-end backend does not ship (a worker, a library only the unit tests reference) has no span
  table there. Its files take the unit report's lines (D5), or their own span table when the unit tests run through
  Piwi's recorder, which reads every instrumented assembly in the test host's directory.

## Delivery

| PR | Content | Needs | Size |
|---|---|---|---|
| 1 | .NET: executable lines of every instrumented assembly, read from disk; source checksums served; the reporter drops the lines of a file whose checksum differs | none | 2 |
| 2 | Core: Cobertura and LCOV parsers, read as streams, path resolution, `allFunctions`; reporter: browser functions that did not run, sent at run end | none | 2 |
| 3 | Dashboard: `test_runs.commit`, `coverage_executable`, `coverage_reports`, report files, fragments' executable lines, the upload endpoint, retention, the scope setting, the privacy page | 2 | 2 |
| 4 | CLI: `piwi coverage upload`, the file inventory, splitting; a docs page with CI steps for GitHub Actions, Bitbucket Pipelines and Azure DevOps | 2, 3 | 1 |
| 5 | The calculation: reference lines, undetermined lines, functions, carry forward, totals, `coverage_daily`; `GET /api/projects/:id/coverage-summary?commit=`; MCP `get_coverage_summary` | 3 | 2 |
| 6 | Screens: the run summary line, the project's coverage page and folder tree, suite marks in the file view; demo seed, a tour stop, screenshots | 5 | 3 |
| 7 | Pull requests and the gate: patch coverage, uncovered changes counting unit suites, `--min-patch-coverage` (warn-only) | 5 | 2 |
| 8 | Analytics widget, quality report line, LCOV and Cobertura export | 5 | 1 |
| 9 | .NET unit tests through Piwi's recorder (`PIWI_COVERAGE_OUTPUT`, `--format piwi`), recommended for large solutions | 1, 4 | 1 |
| 10 | Later: browser lines through `ast-v8-to-istanbul` | 2 | 2 |

Sizes are relative (1 small, 3 large), as in the study's delivery table. PRs 1 and 2 are worth shipping alone: they
fix the denominator and the version check of what Piwi already records.

## Verification

- **The three-tool comparison as a .NET test**: one library run under Microsoft code coverage and under Piwi's
  instrumentation; the reference rule within 2 points of the span table's own ratio, the union's understatement kept
  as the documented case.
- **Parsers** on small fixtures of each tool's real output: Vitest LCOV and Cobertura, coverlet and Microsoft
  Cobertura.
- **Paths**: a Vitest root in a sub-folder, coverlet's `<source>`, Microsoft's absolute paths, `/_/` paths, Windows
  paths with backslashes and drive letters.
- **End to end on Piwi's own repository**: the application's unit tests and the Playwright suite at one commit. Its
  `vitest.config.ts` leaves `app/` and `server/api/` out of unit coverage because "the Playwright E2E suite" exercises
  them; the combined ratio is what lets that include widen.

## Risks

- **Tools disagree on executable lines.** Measured, and handled by D5; the remaining difference with Microsoft code
  coverage is 1.3 points, from declaration lines and from code that behaves differently in a coverage build (10 of the
  13 lines that ran under one tool only check whether a coverage build runs).
- **A tool leaves code out without failing**, as coverlet did. The files without coverage data show it; the upload
  summary names the counts.
- **A partial unit run** (Vitest `--changed`, a filter) uploads a report without its untested files. The CLI cannot
  tell; the docs say to upload from the full run, and the totals warn when a suite's file count drops by more than a
  fifth from its previous report.
- **The percentage becomes a target.** The denominator is always shown, no gate fails (D10), patch coverage warns.
- **Positioning.** Unit tests are an input to coverage, never results (D11); the ROADMAP non-goal holds.
- **Version skew** between the tested backend and the checkout: prerequisite 2.

## Left to check during delivery

- coverlet on a library with an ASP.NET Core framework reference: whether another setting instruments it, for the
  docs page.
- The share of fragments consecutive commits share on a back-end suite (coverlet or Microsoft code coverage), where a
  test change moves more lines than in Piwi's pure-logic unit tests, to size retention.
- Vitest's v8 lines against Piwi's browser lines once PR 10 lands, on the same files.
- The recorder's cost per call over a long unit-test suite, against coverlet and Microsoft code coverage on the same
  suite: Part 6 measured only their fixed cost.

## Not in this plan

- Unit-test results, and which unit test ran a line.
- Branch (condition) coverage and hit counts.
- Istanbul JSON, OpenCover and JaCoCo as formats.
- A gate that fails a build on coverage.
- Per-test server coverage for Node backends (the study's open question 5); a Node backend's run-level report can be
  uploaded with `--kind e2e`.

## Appendix A: measurements

Environment: a 4-core sandbox, Node 24, Vitest 4.1.10 with `@vitest/coverage-v8` 4.1.10, the .NET 10.0.402 SDK,
coverlet.collector 6.0.4, Microsoft.NET.Test.Sdk 18.10.1, xunit 2.9.3, Playwright 1.63's Chromium.

**Vitest on Piwi's application** (`apps/application`, 441 test files, 7,414 tests, the repository's `coverage.include`):

| | Value |
|---|---|
| Files in the report | 704, of which 148 with no executed line |
| Executable lines | 38,585, of which 29,350 ran (76.1%) |
| Functions | 9,036, of which 6,720 ran (74.4%) |
| LCOV / Cobertura / Istanbul JSON | 1.48 MB / 4.4 MB / 13 MB |
| Piwi's model (executable and executed ranges) | 350 KB, 67 KB gzipped |
| Cobertura scan | 0.1 s |

**Reuse between two commits**: the same suite at `5fd51b43` and at `138f9ad3`, one day and 22 commits apart (five
merged pull requests). 663 of the 704 files had the same fragment (94.2%). Of the 668 files whose version did not
change, 5 ran different lines, their tests having changed; each of the 36 changed files needed a new fragment. A commit
then stores about 6% of a full report: some 20 KB before compression on this suite.

**.NET, one library under three tools.** The sources of `PiwiTests.Instrumentation.AspNetCore` and `.Core` compiled
into one library, exercised by 9 of the repository's test classes (71 tests), run three times: under Microsoft code
coverage (`--collect "Code Coverage;Format=cobertura"`), under coverlet (`--collect "XPlat Code Coverage"`), and built
with `-instrument:TestCoverage` against Piwi's recorder in `run` mode, its report written by a `ProcessExit` handler.
The 14 source files:

| | Piwi (span table) | Microsoft code coverage |
|---|---|---|
| Executable lines | 755 | 1,058 |
| Executed lines | 422 (55.9%) | 588 (55.6%) |
| Lines only this tool counts | 9 (auto-property declarations) | 312 (288 braces, 13 declarations, 11 others, `catch` lines among them) |
| Common lines run under one tool only | 13 of 746 (10 in code that checks whether a coverage build runs) | |

coverlet did not instrument this library (see *What the tools produce*); on the coverage package it did instrument,
it and Microsoft code coverage agreed on 497 lines, coverlet counting 7 more.

Combining the two reports as if each came from another suite:

| Rule | Code only the end-to-end side ran (true: 55.6% to 55.9%) | Code only the unit side ran |
|---|---|---|
| Union of executable lines | 39.6% (422 of 1,067) | 55.1% (588 of 1,067) |
| Span table as reference (D5) | 55.9% | 54.6% |
| Undetermined lines, if the union were kept | 235 lines, an upper bound of 61.6% | |

**Browser functions that did not run**: a page declaring a called function, an uncalled function holding an inner
function, an uncalled arrow function and a class with one called method; V8's precise coverage (`callCount: false`,
`detailed: false`) reported the uncalled function, the arrow function and the uncalled method with a count of 0, and
not the inner function.
