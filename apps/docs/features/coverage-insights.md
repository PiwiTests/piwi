---
title: Coverage insights
description: "What a test's recorded coverage answers beyond the files it ran: the code a failure took that its last pass did not, a path that depends on which tests ran first, the code only some tests run, and whether a new test reaches its target lines."
lang: en-US
---

# Coverage insights

<Needs reporter fixtures backend />

Once tests record [coverage](/guide/concepts#coverage), Piwi compares it in four ways: a failing execution against
the test's last passing one, a test's recent runs against each other, a set of tests against every other test, and a
test against the lines it was written to reach. Each answer is in the API, in an MCP tool for coding agents, and, for
a failure, in the AI diagnosis.

## Turn it on

The insights read the coverage your runs already record: set up [server coverage](./code-reach#server-code) with
`coverage: { server: 'lines' }` in the reporter options, or `PIWI_COVERAGE_SERVER=lines`. Line answers need the
`lines` granularity; `functions` gives function answers, and browser coverage, files only, gives file answers. A run
without coverage changes nothing, so a nightly job with coverage on is enough for the comparisons across runs.

Two rules hold in every answer:

- **Line numbers are compared only within one version of a file**, the git blob each covered file names. A file whose
  version differs between the sides is named as changed, never compared line by line;
  [suspect lines](/guide/concepts#suspect-lines) cover changes.
- **An incomplete capture never says that something did not run.** When the backend no longer held part of a test's
  coverage, or its collection failed, the claims that would need it are left out, and the answer says which side was
  incomplete.

## A failure's path against its last pass

For a failed or timed-out execution, Piwi takes the test's latest passing execution with coverage that started
before it: in the same Playwright project on the same branch first, then the same project on the default branch, then
another project on the same branch, then on the default branch, and among the newest three of that choice, a complete
capture first. The answer names that baseline (execution, run, start, branch, commit, project) and lists, per runtime
and file:

| Status | Meaning |
|---|---|
| `only-here` | Only the failing execution ran the file |
| `diverged` | Both ran the same version, not the same lines or functions: the lines and functions only each side ran |
| `only-baseline` | Only the passing execution ran the file |
| `changed` | They ran different versions of the file, not compared |

The failing side comes first: "the code this run took that the last passing run did not" is where an error path, a
fallback or a retry branch shows. The [AI diagnosis](./ai-diagnosis) carries the same comparison as its
**Code paths vs last pass** section, at most twelve files each way, when there is one.

## A path that depends on the tests before it

For a test, Piwi reads its last 30 executions with coverage outside lab runs, in the Playwright project that has most
of its recent executions, leaves out the incomplete ones, and compares them on the files every execution that ran
them ran at the same version. The code that ran in some executions only is grouped by the executions that ran it,
the most evenly split first, with how many ran it and how many of those failed.

It then looks for a test whose having run before predicts that split. The backend is shared by every worker, so the
first relation is **earlier in the run**: the other test finished before the execution started, in the same run. The
second is **earlier on the worker**, the same on the execution's worker and shard, reported when it predicts the split
better. A test is named only when:

- the group and the test each split the compared executions with at least **3 executions on each side**;
- it predicts at least **90%** of the executions that have a start time, either way: the code runs after it, or only
  when it has not run.

When at least two executions failed and 90% of them fall on one side of a group, the answer says the failures follow
that code. When they follow the code the earlier test predicts, the test is marked **order-dependent**: it depends on
state another test leaves behind, and the [flaky root-cause classification](./flaky-tests#root-cause-classification)
names it `order`, ahead of every other category. That check runs only for a test with at least two recent failures
that recorded coverage.

## What quarantining or deleting tests leaves uncovered

For up to 50 tests of a project, Piwi reads their latest coverage on the default branch and every other test's, and
lists per file and version the lines and functions no other **trusted** test runs. Trusted means not quarantined; the
tests asked about are left out of the others.

| Status | Meaning |
|---|---|
| `only-these` | No other trusted test runs the file |
| `only-flaky` | The only other trusted tests running it are flaky: they carry a flaky root cause |
| `partial` | Other tests run the file, not every line: the lines no other trusted test runs, and the lines only flaky ones run |
| `uncertain` | The other tests recorded the file only at another version, or without lines, so no line is claimed |

The MCP tools that quarantine or release tests add the same summary to their answer when the project records coverage:
what the quarantine leaves uncovered, or what the release covers again.

## Did a new test reach its target lines

Given a test, a file and target lines, Piwi reads the test's latest execution with coverage, or the execution you
name, and splits the target lines into those that **ran**, those that **did not run** (from a complete capture
only) and those it **cannot tell** (file granularity, or an incomplete capture). At function granularity a line ran
when a function around it ran. When a run recorded the file's executable lines for that version, target lines that
cannot run (blank lines, comments) are set apart.

When a target line did not run, the answer names the **nearest test**: the one running most of the function around
the first target line at that version, else of the target lines, else, at another version, of the file. It is the
test to copy. The `write-the-missing-test` [agent skill](./agent-skills) runs a new test with server coverage on and
checks its target lines this way until they run.

## For agents

Three read-only MCP tools, listed with the rest on [MCP tools](/reference/mcp-tools), carry these answers. They
belong to the `core` module and depend on the **Coverage** capability: declining it for the instance on the Setup page
drops them.
For a project with no coverage, each answers one sentence saying how to turn it on.

- `get_coverage`: a file's executed ranges grouped by the tests that ran them and its executable lines, with the
  nearest test for target lines; or an execution's files, one file's ranges, or which target lines a test ran. A test
  can be named by its spec file and title.
- `compare_coverage`: a failure against its last pass, or a test's recent runs against each other and the earlier test
  that explains them.
- `get_coverage_loss`: what quarantining, skipping or deleting tests would leave uncovered.

The same answers are in the dashboard's API; see the [API docs](https://piwitests.dev/demo/docs) (`/docs` on your
instance).

## Limits

- **As fresh as the last run with coverage.** A test's latest coverage can be a nightly job old; every answer names
  the executions it read.
- **Executed is not checked.** A line that ran may still be wrong with every test green.
- **Order needs times and variety.** An execution without a start time from the reporter takes no part in finding the
  earlier test, and a suite whose order never changes gives no split to explain.
- **Coverage loss reads each test's latest coverage as stored**: another test whose own capture was incomplete can
  make a line look run by these tests only.
- **What the capture cannot see** stays unseen: see the limits of [code reach](./code-reach#limits).

## Related

- [Code reach](./code-reach): recording coverage, browser and server
- [Flaky tests & quarantine](./flaky-tests): root causes and the quarantine these answers inform
- [AI diagnosis](./ai-diagnosis): the evidence a diagnosis reads
- [MCP server](./mcp): connecting an agent
