---
title: Impact from a diff
description: "The tests a change affects, read from the tests' history: the tests a changed file defines, those that failed inside it, those that executed it, and with recorded coverage only those that ran the changed lines."
lang: en-US
---

# Impact from a diff

`piwi run impact --base <ref>` runs only the tests your change affects. The reporter diffs the working tree against
`<ref>`, and the dashboard maps each changed file to tests through what they were seen to do, never a build-time
dependency graph:

- **Direct**: a changed file that _is_ a test file maps to the tests defined in it.
- **Reach**: a changed support file maps to the tests that failed inside it, per their source frames.
- **Code reach**: a changed application file maps to the tests that executed it
  ([code reach](/features/code-reach)), and a route handler to the tests that called its route.

```bash
npx @piwitests/reporter run impact --base origin/main
```

It fails safe, widening to the full suite with a warning, when a changed file maps to no test (stylesheets too) or
only through source frames, which miss passing tests. A docs-only change runs nothing. `piwi select impact` prints
the Playwright arguments instead of running them, and [`piwi preflight --run`](/features/preflight) runs the same
tests along with those of the locators the change breaks.

## Line level

When tests record coverage ([code reach](/features/code-reach) at `functions`, or
[server coverage](/features/server-coverage)), a modified file selects only the tests that ran the lines you changed,
not every test that touched the file. The reporter sends each modified file's changed lines with the git blob id of
its version before the change, and the dashboard reads them against each test's recorded coverage of that same
version:

| A changed line… | selects the tests that… |
| --- | --- |
| is a statement, with server coverage at `lines` | ran that line |
| sits inside a function: any other line, an insertion, or coverage at `functions` | ran that function |
| sits outside every function: module code, a declaration, an attribute | reach the file at all |

An added line counts by the lines around it, so it selects the tests that ran the code it was added to. A test whose
coverage cannot rule it out stays in: coverage of another version of the file, coverage with no line or function
ranges, or an incomplete capture. A test file, failure frames and route reach are never narrowed. Added, deleted and
renamed files count as whole files.

A changed line inside a function no test ran selects nothing from that file: no test can catch a mistake there. The
answer names it as `notRun`, the line a new test should cover.

The rule assumes a line a test did not run cannot change that test's path, as every coverage-based selection does,
and it reads each test's latest recorded coverage. Keep running the full suite on a schedule: it stays the reference.

## Read the answer

`piwi select impact --json` prints the resolution, and `impact.files` gives, for each changed file:

- `level`: `lines` when its tests were read against the changed lines, `file` when not, `none` when no test maps to it;
- `tests`, each with how it was selected: `test-file`, `lines`, `functions`, `frames`, `route`, or `file` (its
  coverage reaches the file and cannot rule it out), and the changed lines it ran;
- `ruledOut`, the tests that reach the file and ran none of its changed lines;
- `fileLevelLines` and `notRun`, as above.

## For agents

The `get_impacted_tests` [MCP tool](/reference/mcp-tools#workflow) takes a diff (`git diff --full-index <base>`) and
returns the same answer per file, the tests by name, and a command to run them. The `run-the-right-tests`
[agent skill](/features/agent-skills) calls it after every code change, and offers to write a test for the
`notRun` lines.

## Related

- [Test selections](/features/test-selection): saved subsets, shards and the CI guard
- [Code reach](/features/code-reach) and [server coverage](/features/server-coverage): what the tests record
- [Uncovered changes](/features/uncovered-changes): the changed lines no suite ran, on a pull request
- [Piwi CLI](/reference/cli#select-run): every flag of `select` and `run`
