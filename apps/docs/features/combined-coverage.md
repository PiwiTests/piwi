---
title: Combined coverage
description: "Upload the coverage reports of your unit tests (Vitest, coverlet, Microsoft code coverage) for each commit, so Piwi counts them with the Playwright suite's coverage on one set of executable lines."
lang: en-US
---

# Combined coverage

Your Playwright suite is not the only one that runs your code: the unit tests of the front end and the back end do
too. `piwi coverage upload` sends their coverage reports to the dashboard, keyed by the commit they ran on and a suite
name you choose (`unit-front`, `unit-back`), so their coverage sits next to the coverage Piwi records from
[code reach](./code-reach) and [server coverage](./server-coverage) for the same commit.

## Upload a report

Run the unit tests with coverage in Cobertura or LCOV, then upload the report from the same checkout:

```bash
npx vitest run --coverage --coverage.reporter=cobertura
npx @piwitests/reporter coverage upload coverage/cobertura-coverage.xml --suite unit-front
```

```bash
dotnet test --collect "XPlat Code Coverage"
npx @piwitests/reporter coverage upload "**/TestResults/*/coverage.cobertura.xml" --suite unit-back
```

The command reads the project, the dashboard URL and the API key as the reporter does (`PIWI_PROJECT_NAME`,
`PIWI_DASHBOARD_URL`, `PIWI_API_KEY`), the commit from git and the branch from the CI or `PIWI_BRANCH`. The API key
needs the Uploader role on the project, the one a reporter uses. Every flag is on the
[CLI reference](/reference/cli#coverage).

| Tool | Format | Command |
|---|---|---|
| Vitest (`@vitest/coverage-v8`) | Cobertura or LCOV | `vitest run --coverage --coverage.reporter=cobertura` |
| coverlet | Cobertura | `dotnet test --collect "XPlat Code Coverage"` |
| Microsoft code coverage | Cobertura | `dotnet test --collect "Code Coverage;Format=cobertura"` |
| Piwi's .NET recorder | Piwi | `PIWI_COVERAGE_OUTPUT=TestResults/piwi/ dotnet test -p:PiwiCoverage=true` |

On .NET, run the unit tests on the coverage build [server coverage](./server-coverage) uses: each test host writes a
report there at exit, with the span table's lines, the ones the end-to-end suite counts, at a fraction of coverlet's
cost. Upload `"TestResults/piwi/*.json"`; set `VSTEST_TESTHOST_SHUTDOWN_TIMEOUT=30000`, as VSTest otherwise stops a
host 100 ms after its tests.

Upload from the full unit-test run: Vitest lists the files nothing ran only when every test ran and `coverage.include`
names them.

## In CI

The unit tests and the Playwright suite usually run in separate jobs: what ties them together is the commit, so each
job uploads its own report. A suite uploaded in parts (four portals, four shards) is merged on the dashboard.

::: code-group

```yaml [GitHub Actions]
- run: npx vitest run --coverage --coverage.reporter=cobertura
  working-directory: apps/web
- run: npx @piwitests/reporter coverage upload apps/web/coverage/cobertura-coverage.xml --suite unit-front
  env:
    PIWI_DASHBOARD_URL: https://piwi.example.com
    PIWI_PROJECT_NAME: shop
    PIWI_API_KEY: ${{ secrets.PIWI_API_KEY }}
```

```yaml [Bitbucket Pipelines]
- step:
    name: Unit tests
    script:
      - dotnet test --collect "XPlat Code Coverage"
      - npx @piwitests/reporter coverage upload "**/TestResults/*/coverage.cobertura.xml" --suite unit-back
```

```yaml [Azure DevOps]
- script: dotnet test --collect "Code Coverage;Format=cobertura" --results-directory $(Agent.TempDirectory)/coverage
- script: npx @piwitests/reporter coverage upload "$(Agent.TempDirectory)/coverage/**/*.cobertura.xml" --suite unit-back
  env:
    PIWI_API_KEY: $(PIWI_API_KEY)
```

:::

On Bitbucket and Azure DevOps, set `PIWI_DASHBOARD_URL`, `PIWI_PROJECT_NAME` and `PIWI_API_KEY` as repository or
pipeline variables. The project must exist on the dashboard: the first Playwright run creates it.

## One ratio per commit

For each commit, the dashboard counts every suite that ran the code: the reports uploaded for it, and `e2e`, the run
coverage of the commit's complete Playwright runs (a partial run, or a probe or flake-lab run, never counts). The
totals are recomputed seconds after each upload or run; read them with the
[API](https://piwitests.dev/demo/docs) or the MCP `get_coverage_summary` tool.

- **One set of executable lines per file version.** Tools disagree on which lines can run, so every suite counts on
  the same lines: the span table's, from [server coverage](./server-coverage), when a run recorded them for that
  version of the file; otherwise the reports' own. A line a tool marks outside them is ignored.
- **Undetermined lines.** The browser suite records functions, not lines. An unrun line inside a function it ran,
  outside a function nested in it that did not run, is undetermined: shown beside the ratio, never counted as run.
- **Functions** count across suites by start line: one ran when any suite ran a function starting there.
- **Classes of lines.** Each executable line is unit only, end to end only, both, none, or undetermined. "End to end
  only" is what the Playwright suite alone protects; "unit only" is code no user path reaches in the tests.
- **Files without coverage data** are the commit's tracked files in scope that no suite names, from the upload's
  inventory, counted apart from the percentage.
- **Carried forward.** A suite the commit lacks comes from the newest commit whose coverage arrived before it, on
  the commit's branch then on the default branch, file by file where the file's version is unchanged, and the totals
  say from which commit.

The project's **Coverage** page shows the commit whose coverage arrived last, and a run's header links its commit's.

<figure>
  <img src="/screenshots/combined-coverage.png" alt="A project's combined coverage page">
  <figcaption>Three suites of one commit, counted on the same lines.</figcaption>
</figure>

## Find what is not covered

Every bar on the coverage page splits lines as a file's marks do: both kinds of suite, unit only, end to end only,
undetermined, and the empty track for none. **Files** is a foldable tree of the repository, each folder and file with
its bar, sorted by name or lines not run, files without data greyed. Beside it, the selected
folder's suites and least-covered files. A file opens on its source, through the
[source control](/guide/source-control) connection, each line marked by the suites that ran it; **Next gap** jumps to
the next lines none ran.

## In pull requests

The [Uncovered changes](./uncovered-changes) section of the pull-request comment opens with the change's patch
coverage: "34 of the 41 changed lines ran (unit 28, end to end 19)". A changed file a suite ran a changed line of counts
as reached, so a file only a unit test covers is no longer reported as a gap. `piwi gate
--min-patch-coverage <percent>` warns under a minimum, and never fails the build.

## Over time

The **Coverage trend** [Analytics widget](./analytics) charts the combined line coverage per day, summed over the
projects in scope, with each suite's share as a dashed line and the change against the comparison period; the engineering
[quality report](./quality-reports) gives it as one line, "Line coverage: 61.2% (+1.4 pts)". Each project counts
once a day, at its last commit with coverage, on the default branch or the first of the scope's branches that has one.
Kept per day, the trend outlives the reports' retention.

## Export

The coverage page's card menu downloads the commit's combined coverage as LCOV or Cobertura, for Sonar, Codecov or an
IDE (`coverage-export?format=` in the API). A line any suite ran has 1 hit, else 0: Piwi keeps no hit counts and no
branches.

## How paths are matched

Each report path is made repository-relative before anything is sent (the [CLI reference](/reference/cli#coverage)
gives the order tried; `--root` replaces it), and each file is named by the git blob of its content in the checkout.
A path that names no file of the checkout is dropped and counted.

## The coverage scope

A project's coverage scope decides which files count: include and exclude patterns over repository-relative paths, in
the syntax CODEOWNERS uses. With no include pattern every file counts; an exclude wins. A pattern is at most 300
characters, with at most 20 `*`. The defaults leave out tests, build output and generated sources. Set it in the
project's **Settings › Coverage**, or with the [API](https://piwitests.dev/demo/docs) (`coverageScope`). The upload
sends only the files in scope, with the commit's inventory (its tracked files in scope and their blob ids), so a
file no report names still counts as without data.

## Areas

Name the parts of the code in the same settings (`coverageAreas` in the API): `front: apps/web/`, `back: src/Api/`. A
file belongs to the first area whose patterns match it, and every suite splits the same way: the coverage page gives
each area its totals and each suite's share; the coverage trend
draws one line per area (its *Lines beside every suite* option); the pull-request comment counts the changed lines per
area, "By area: front 28 of 30, back 6 of 11". A change recounts the commits still kept; a removed area leaves the
trend.

## What is sent

Paths, line numbers and blob ids: for each file, its executable lines, the lines and functions that ran, and every
function the tool knows. No source code, no test names, no hit counts.

## Limits

- **Formats:** Cobertura, LCOV and Piwi's own. Istanbul JSON, OpenCover and JaCoCo are not read.
- **A tool can leave code out without failing.** coverlet does not instrument an assembly it cannot resolve the
  dependencies of, and says so only in its diagnostic log.
- **One commit, one checkout.** Upload from the checkout the tests ran in: the blob ids and the inventory come from it.
- **Functions match by start line.** coverlet starts a method at its opening brace, the compiler's span table at its
  declaration, so a .NET function both report can count twice.

## Try it in the demo

<DemoExamples />

## Related

- [Code reach](./code-reach) and [Server coverage](./server-coverage): the coverage the Playwright suite records
- [Coverage cost](/reference/coverage-cost)
- [Piwi CLI](/reference/cli#coverage)
- [Privacy](/guide/privacy)
