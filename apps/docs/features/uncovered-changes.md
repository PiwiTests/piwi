---
title: Uncovered changes in pull requests
description: "The files a pull request changed that no test observably reaches, and the changed lines no suite ran, posted on the pull request as a comment section and a commit status, with warn-only gate flags."
lang: en-US
---

# Uncovered changes in pull requests

<Needs reporter scm />

A pull request that changes `server/api/orders/[id].patch.ts` while no test ever requests that route passes CI and
proves nothing about the change. When a run finishes, Piwi joins the files its change touched to the tests that
[observably reach](/guide/concepts#reach) them, and names the changed files nothing reaches: the **uncovered
changes**. Each one is a *changed, unreached* [scenario gap](/features/scenario-gaps), with a draft scenario to start
from. When the head commit has [combined coverage](/features/combined-coverage), the same section counts the changed
lines too, and names those no suite ran, in every file.

<figure>
  <img src="/diagrams/uncovered-changes.svg" alt="A pull-request run's changed files are joined to the tests that reach them; each is reached, an uncovered change (a gap), or not counted, with the reason; the result goes to the pull request">
</figure>

## One rule for every changed file

The comment, its commit status, the gate, the MCP tool and the *changed, unreached* detector read one rule. A changed
file is:

| Reach | When | Counted |
|---|---|---|
| **Reached** | a test of this run reached it, or a suite of the head commit's coverage ran one of its changed lines | yes |
| **Reached earlier** | no test of this run did, but a test of the project's last 30 runs did: a run narrowed by a [selection](/features/test-selection), not a missing test | yes |
| **Unreached** | Piwi can observe the file, and nothing above reached it: an **uncovered change**, and a *changed, unreached* gap | yes |
| **Not observable** | nothing maps the file to a test, so nothing can be said either way | no |
| **Out of scope** | the project's [coverage scope](/features/combined-coverage#the-coverage-scope) leaves it out: tests, build output and generated code by default | no |
| **Deleted** | the change removed it | no |

A test reaches a file when it:

- requested a route or visited a page the file serves, matched by the framework's file naming (`server/api/**`,
  `server/routes/**`, Nuxt `pages/**`);
- ran a step whose locator is written in the file (a page object, a helper);
- executed one of the file's functions, with [code reach](/features/code-reach) on.

Piwi can observe a file when one of these could happen to it, or when the head commit's coverage counts its changed
lines. A skipped test reaches nothing. A *changed, unreached* gap closes as soon as its file is reached by any of these
routes.

The diff comes from the [source control](/guide/source-control) connection: a pull-request run is compared with its
base branch, any other run with the commit of the last passing run. With no SCM token or no diff, nothing appears.

## On the pull request

With [pull-request feedback](/features/pr-feedback) turned on, the comment gains an **Uncovered changes** section.
The uncovered changes come first, grouped by ticket (read from the commit messages and the pull request):

```md
#### 🟣 Uncovered changes · 3 of 7 files · 2 tickets
Changed files no test reached, in this run or the last 30 runs. Observed reach, not instrumented coverage.

**PROJ-418**
- `server/api/orders/[id].patch.ts` · changed (+41 −3) · 0 tests in 30 runs
  → *a scenario that exercises [id].patch.ts* · draft
```

When the head commit has [combined coverage](/features/combined-coverage), the section also counts the change's lines
that can run (its patch coverage), and names the changed lines no suite ran in the files a test did reach: a test
visiting a file is not a test running the change.

```md
**Patch coverage 82.9%**: 34 of the 41 changed lines ran (unit 28, end to end 19), at `a1b2c3d`.

**Changed lines no suite ran**
- `api/Orders/OrderService.cs` · 7 of 12 ran · not run: 14 to 18, 40
```

The section ends with what it did not count: *Not counted: 2 files Piwi cannot observe, 1 file outside the coverage
scope.*

<figure>
  <img src="/screenshots/uncovered-changes.png" alt="The Uncovered changes section of a pull-request comment">
  <figcaption>Patch coverage, the changed files no test reaches, and the changed lines no suite ran.</figcaption>
</figure>

A coverage report uploaded for the commit after the comment, or the run's own coverage arriving after it, posts the
comment again a few seconds later; a later push's comment is never overwritten by an earlier commit's.

When commit statuses are on too, a second status joins the run's own: `piwi/tests/change-coverage` with the default
status context, described as *3 of 7 changed files no test reached*, with the patch coverage when there is one. It is
always **success**, so it informs a reviewer without blocking the merge.

The files no test reached are the Test Map's part: they are left out while the *changed, unreached* detector is
[muted](/features/scenario-gaps#triage) on the project, or where the Test Map is declined. The changed lines are
coverage's part and stay either way.

## From an agent

The [`get_change_coverage`](/reference/mcp-tools#get_change_coverage) MCP tool returns the same join for a run or for
an explicit base and head commit, grouped by ticket, without recording anything: each file's `reach`, its `lines`
when the coverage counts them, and the files not counted. The [write-the-missing-test](/features/agent-skills) skill
takes it from there. The REST endpoint is in the [API docs](https://piwitests.dev/demo/docs).

## The gate flags

Two flags of [`piwi gate`](/guide/ci#blocking-a-merge) read the same rule, one per form:

- `--max-uncovered-changes <n>` warns when more than `n` changed files are uncovered changes (the file form);
- `--min-patch-coverage <percent>` warns when fewer of the changed lines ran, or when the head commit's coverage names
  none of them (the line form). Run it after the unit-test jobs uploaded their reports.

Both are **warn-only**: they never change the verdict or the exit code, because the numbers inform rather than prove.
Either warns too when the run has no source control diff to count. Without them, the gate ignores uncovered changes.

## Limits

- **Observed reach, then lines.** Without coverage, a reached file may still hide an untested branch; with it, the
  changed lines no suite ran name it. An unreached file may be dead code.
- **Naming conventions.** Files map to routes and pages through Nitro and Nuxt file naming; other frameworks rely on
  locators, code reach and coverage, so without those more of their files are *not observable* and not counted.
- **Ten files listed.** The comment names at most ten files per list and counts the rest.

## Related

- [Scenario gaps & the Test Map](/features/scenario-gaps): the other gaps, and triage
- [Combined coverage](/features/combined-coverage): the coverage the changed lines are counted on
- [Pull-request feedback & re-run](/features/pr-feedback): the comment this section joins
- [Source control](/guide/source-control): the token that provides the diff
- [Piwi CLI: gate](/reference/cli#gate): every gate flag
