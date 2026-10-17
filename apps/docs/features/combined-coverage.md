---
title: Combined coverage
description: "Upload the coverage reports of your unit tests (Vitest, coverlet, Microsoft code coverage) for each commit, so Piwi counts them with the Playwright suite's coverage on one set of executable lines."
lang: en-US
---

# Combined coverage

The unit tests of the front end and the back end run your code too. `piwi coverage upload` sends their coverage
reports to the dashboard, keyed by the commit they ran on and a suite name you choose (`unit-front`, `unit-back`), to
sit beside the coverage Piwi records from [code reach](./code-reach) and [server coverage](./server-coverage) for the
same commit.

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
needs the Uploader role, as a reporter's does. A path naming no file of the checkout is dropped and
counted (`--root` sets where paths start). Every flag is on the
[CLI reference](/reference/cli#coverage).

| Tool | Format | Command |
|---|---|---|
| Vitest (`@vitest/coverage-v8`) | Cobertura or LCOV | `vitest run --coverage --coverage.reporter=cobertura` |
| coverlet | Cobertura | `dotnet test --collect "XPlat Code Coverage"` |
| Microsoft code coverage | Cobertura | `dotnet test --collect "Code Coverage;Format=cobertura"` |
| Piwi's .NET recorder | Piwi | `PIWI_COVERAGE_OUTPUT=TestResults/piwi/ dotnet test -p:PiwiCoverage=true` |

On .NET, run the unit tests on the [server coverage](./server-coverage) build: each test host writes a report at exit
with the span table's lines, at a fraction of coverlet's cost. Upload `"TestResults/piwi/*.json"` and set
`VSTEST_TESTHOST_SHUTDOWN_TIMEOUT=30000`: VSTest otherwise stops a host 100 ms after its tests.

Upload from the full unit-test run: Vitest lists the files nothing ran only when every test ran and `coverage.include`
names them.

## In CI

The unit tests and the Playwright suite usually run in separate jobs, tied by the commit: each uploads its own report,
and a suite uploaded in parts (shards, portals) is merged on the dashboard.

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

On Bitbucket and Azure DevOps, set the three `PIWI_` variables as repository or pipeline variables. The first
Playwright run creates the project.

## One ratio per commit

For each commit, the dashboard counts every suite that ran the code: the reports uploaded for it, and `e2e`, the run
coverage of the commit's complete Playwright runs (never a partial, probe or flake-lab run). The
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
- **Files without coverage data** are tracked files in scope no suite names, counted apart from the percentage.
- **Carried forward.** A suite the commit lacks comes from the newest commit whose coverage arrived before it, on
  the commit's branch then on the default branch, file by file where the file's version is unchanged.

The project's **Coverage** page shows the commit whose coverage arrived last, and a run's header links its commit's.

<figure>
  <img src="/screenshots/combined-coverage.png" alt="A project's combined coverage page">
  <figcaption>Three suites of one commit, counted on the same lines.</figcaption>
</figure>

## What the numbers leave out

On a branch, each suite keeps only the report of the commit whose coverage arrived last; an earlier push keeps only
its totals, never recounted ("totals only" on its run). The default branch keeps its newest commit and each day's last
for 90 days, and totals for a year. Notes above the numbers say when a commit has only totals, a suite is
carried, a report was cut, a known suite is missing, no inventory was sent, the scope changed since, or runs did not
count.

<figure>
  <img src="/screenshots/coverage-notes.png" alt="A note above a branch's coverage">
  <figcaption>A suite carried from the push before.</figcaption>
</figure>

## Find what is not covered

Every bar on the coverage page splits lines as a file's marks do: both kinds of suite, unit only, end to end only,
undetermined, and the empty track for none. **Files** is a foldable tree of the repository, each folder and file with
its bar, sorted by name or lines not run, files without data greyed. Beside it, the selected
folder's suites and least-covered files. A file opens on its source, through the
[source control](/guide/source-control) connection, each line marked by the suites that ran it; **Next gap** jumps to
the next lines none ran.

<figure>
  <img src="/screenshots/combined-coverage-file.png" alt="A file's lines marked by suite">
  <figcaption>Line 40 ran in e2e and unit-back.</figcaption>
</figure>

## In pull requests

The [Uncovered changes](./uncovered-changes) section of the pull-request comment opens with the change's patch
coverage, the share of its changed lines any suite ran; a changed file any suite ran a changed line of counts as
reached. `piwi gate --min-patch-coverage <percent>` warns under a minimum, and never fails the build.

## Over time

The **Coverage trend** [Analytics widget](./analytics) charts the combined line coverage per day, summed over the
projects in scope, with each suite's share as a dashed line and the change against the comparison period; the engineering
[quality report](./quality-reports) gives it as one line. Each project counts
once a day, at its last commit with coverage, on the default branch or the scope's first branch with one.
Kept per day, it outlives the reports; a day without new coverage names the day it carries.

<figure>
  <img src="/screenshots/combined-coverage-trend.png" alt="The Coverage trend widget">
  <figcaption>A month of coverage, each suite dashed.</figcaption>
</figure>

## Export

The coverage page's card menu downloads the commit's combined coverage as LCOV or Cobertura, for Sonar, Codecov or an
IDE (`coverage-export?format=` in the API). A line any suite ran has 1 hit, else 0: Piwi keeps no hit counts and no
branches.

## The coverage scope

A project's coverage scope decides which files count: include and exclude patterns over repository-relative paths, in
the syntax CODEOWNERS uses. With no include pattern every file counts; an exclude wins. The defaults leave out tests,
build output and generated sources. Set it in the project's **Settings › Coverage**, or with the
[API](https://piwitests.dev/demo/docs) (`coverageScope`). The upload sends only the files in scope, and the commit's
inventory: its tracked files in scope and their blob ids.

## Areas

Name the parts of the code in the same settings (`coverageAreas` in the API): `front: apps/web/`, `back: src/Api/`. A
file belongs to the first area whose patterns match it, and every suite splits the same way: the coverage page gives
each area its totals and each suite's share; the coverage trend
draws one line per area (its *Lines beside every suite* option); the pull-request comment counts the changed lines per
area. A change recounts the commits that keep their reports; a removed area
leaves the trend.

## What is sent

Paths, line numbers and blob ids: for each file, its executable lines, the lines and functions that ran, and every
function the tool knows. No source code, no test names, no hit counts.

## Limits

- **Formats:** Cobertura, LCOV and Piwi's own. Istanbul JSON, OpenCover and JaCoCo are not read.
- **A tool can leave code out without failing.** coverlet does not instrument an assembly whose dependencies it
  cannot resolve, and says so only in its diagnostic log.
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
