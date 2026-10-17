---
title: Uncovered changes in pull requests
description: "The files a pull request changed that no test observably reaches, posted on the pull request as a comment section and a commit status, with a warn-only gate flag."
lang: en-US
---

# Uncovered changes in pull requests

<Needs reporter scm />

A pull request that changes `server/api/orders/[id].patch.ts` while no test ever requests that route passes CI and
proves nothing about the change. When a run finishes, Piwi joins the files its change touched to the tests that
[observably reach](/guide/concepts#reach) them, and names the changed files nothing reaches. Each one is a
*changed, unreached* [scenario gap](/features/scenario-gaps), with a draft scenario to start from.

<figure>
  <img src="/diagrams/uncovered-changes.svg" alt="A pull-request run's changed files are joined to the tests that reach them; each is reached, a changed-unreached gap, or without evidence; the gaps go to the pull request">
</figure>

## What counts as reached

A changed file counts as reached when a test that ran recently touches it:

- a route or page the file serves, matched by the framework's file naming (`server/api/**`, `server/routes/**`, Nuxt
  `pages/**`), that a test requested or visited;
- a test step whose locator is written in the file (a page object, a helper), or the file is the spec that defines
  the test.
- with [code reach](/features/code-reach) on, a test executed one of the file's functions;
- with [combined coverage](/features/combined-coverage) uploaded for the head commit, a suite (a unit suite or the
  Playwright suite) ran one of the lines the change added or modified.

"No test in this run" is always paired with the count from the last 30 runs, so a run narrowed by a
[selection](/features/test-selection) is never mistaken for a gap. A skipped test reaches nothing. A file that no route,
page or test source maps to says so: no evidence either way.

The diff comes from the [source control](/guide/source-control) connection: a pull-request run is compared with its
base branch, any other run with the commit of the last passing run. With no SCM token or no diff, nothing appears.

## On the pull request

With [pull-request feedback](/features/pr-feedback) turned on, the comment gains an **Uncovered changes** section,
grouped by ticket (read from the commit messages and the pull request):

```md
#### 🟣 Uncovered changes · 3 of 7 files · 2 tickets
Observed reach, not instrumented coverage. This run and the last 30 on `main`.

**PROJ-418**
- `server/api/orders/[id].patch.ts` · changed (+41 −3) · 0 tests in 30 runs
  → *a scenario that exercises [id].patch.ts* · draft
```

When the head commit has [combined coverage](/features/combined-coverage), the section opens with the change's patch
coverage, counted on the lines that can run:

```md
**Patch coverage 82.9%**: 34 of the 41 changed lines ran (unit 28, end to end 19), at `a1b2c3d`.
```

A coverage report uploaded for the commit after the comment, or the run's own coverage arriving after it, posts the
comment again a few seconds later; a later push's comment is never overwritten by an earlier commit's.

When commit statuses are on too, a second status joins the run's own: `piwi/tests/change-coverage` with the default
status context, described as *3 of 7 changed files have no observed reach*, with the patch coverage when there is one. It is always **success**, so it informs a
reviewer without blocking the merge. The section and the status are left out while the *changed, unreached*
detector is [muted](/features/scenario-gaps#triage) on the project, or where the Test Map is declined.

## From an agent

The [`get_change_coverage`](/reference/mcp-tools#get_change_coverage) MCP tool returns the same join for a run or for
an explicit base and head commit, grouped by ticket, without recording anything. The
[write-the-missing-test](/features/agent-skills) skill takes it from there. The REST endpoint is in the
[API docs](https://piwitests.dev/demo/docs).

## The gate flag

`piwi gate --max-uncovered-changes <n>` adds a warning to the [gate](/guide/ci#blocking-a-merge) result when more
than `n` changed files have no observed reach. It is **warn-only**: it never changes the verdict or the exit code,
because observed reach is evidence, not proof. Without the flag, the gate ignores uncovered changes.

`piwi gate --min-patch-coverage <percent>` warns, the same way, when fewer of the changed lines ran, or when the head
commit's coverage names none of them. Run it after the unit-test jobs uploaded their reports.

## Limits

- **Observed reach, not coverage.** A reached file may still hide an untested branch; an unreached one may be dead
  code.
- **Naming conventions.** Files map to routes and pages through Nitro and Nuxt file naming; other frameworks rely on
  locators and spec files, so more of their files show as *no evidence*.
- **Ten files listed.** The comment names at most ten uncovered files and counts the rest.

## Related

- [Scenario gaps & the Test Map](/features/scenario-gaps): the other gaps, and triage
- [Pull-request feedback & re-run](/features/pr-feedback): the comment this section joins
- [Source control](/guide/source-control): the token that provides the diff
- [Piwi CLI: gate](/reference/cli#gate): every gate flag
