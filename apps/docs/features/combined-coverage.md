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

Upload from the full unit-test run. Vitest lists the files nothing ran only when every test ran (not with `--changed`
or a single file) and when `coverage.include` names them; a report without its untested files counts less code than
there is.

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
totals are recomputed a few seconds after each upload and each run coverage of the commit; read them with the
[API](https://piwitests.dev/demo/docs) or the MCP `get_coverage_summary` tool.

- **One set of executable lines per file version.** Tools disagree on which lines can run, so every suite counts on
  the same lines: the span table's, from [server coverage](./server-coverage), when a run recorded them for that
  version of the file; otherwise the reports' own. A line a tool marks outside them is ignored. On 71 .NET tests,
  taking both tools' lines together understated the code only the end-to-end tests ran by 16 points; the span table as
  the one reference stayed within 1.3.
- **Undetermined lines.** The browser suite records functions, not lines. An unrun line inside a function it ran is
  undetermined: shown beside the ratio, never counted as run.
- **Functions** count across suites by their start line: one ran when any suite ran a function starting there.
- **Classes of lines.** Each executable line is unit only, end to end only, both, none, or undetermined. "End to end
  only" is what the Playwright suite alone protects; "unit only" is code no user path reaches in the tests.
- **Files without coverage data** are the commit's tracked files in scope that no suite names, from the upload's
  inventory, counted apart from the percentage.
- **Carried forward.** A suite the commit lacks comes from its newest earlier report, on the commit's branch then on
  the default branch, file by file where the file's version is unchanged, and the totals say from which commit.

## How paths are matched

A report's paths are made repository-relative before anything is sent:

- Vitest writes paths relative to its root; the command tries them against the report's `<source>`, the current
  directory, the report's directory and its parent (Vitest writes `coverage/` under its root), and the repository
  root, and keeps the first that names a file of the checkout.
- coverlet writes the common directory of a module's files as `<source>`; Microsoft code coverage writes absolute
  paths; a .NET build with `ContinuousIntegrationBuild` writes `/_/`, read as the repository root.
- `--root <dir>` replaces those guesses with one directory.

A path that names no file of the checkout is dropped and counted: "12 paths matched no file in the checkout: check
`--root`". Each file is named by the git blob of its content in the checkout, so its line numbers stay tied to that
version of the file.

## The coverage scope

A project's coverage scope decides which files count: include and exclude patterns over repository-relative paths, in
the syntax CODEOWNERS uses. With no include pattern every file is included; an exclude pattern wins. By default the
scope leaves out test files (`*.test.*`, `*.spec.*`, `tests/`, `__tests__/`, projects named `*Tests`), build output
(`bin/`, `obj/`) and generated sources (`*.g.cs`, `*.Designer.cs`, `*.generated.*`). Set it with the
[API](https://piwitests.dev/demo/docs) (a project's `coverageScope`). The upload sends only the files in scope, and with
them the commit's file inventory: its tracked files in scope and their blob ids, so a file no report names still counts
as a file without coverage data.

## What is sent

Paths, line numbers and blob ids: for each file, its executable lines, the lines and functions that ran, and every
function the tool knows. No source code, no test names, no hit counts: a unit test is an input to coverage, never a
result Piwi keeps.

## Limits

- **Formats:** Cobertura and LCOV. Istanbul JSON, OpenCover and JaCoCo are not read; JaCoCo has converters to
  Cobertura.
- **Tools disagree on which lines can run.** Microsoft code coverage and coverlet count braces and declaration lines
  that the C# compiler's span table, which server coverage reads, does not.
- **A tool can leave code out without failing.** coverlet does not instrument an assembly it cannot resolve the
  dependencies of, and says so only in its diagnostic log.
- **One commit, one checkout.** Upload from the checkout the tests ran in: the blob ids and the inventory come from it.
- **Functions match by start line.** coverlet starts a method at its opening brace, the compiler's span table at its
  declaration, so a .NET function both report can count twice.

## Related

- [Code reach](./code-reach) and [Server coverage](./server-coverage): the coverage the Playwright suite records
- [Coverage cost](/reference/coverage-cost)
- [Piwi CLI](/reference/cli#coverage)
- [Privacy](/guide/privacy)
