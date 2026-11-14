---
title: Pull-request feedback
description: "Piwi posts a run's result on the pull request, new failures apart from pre-existing ones, and sets a commit status from the CI merge gate's verdict."
lang: en-US
---

# Pull-request feedback

<Needs reporter scm />

The run URL a CI job prints is a link somebody has to click. Piwi can instead post the result onto the pull request
itself, which is where the person who broke the test already is. To re-run a fixed cluster's tests from the dashboard,
see [Re-run in CI](./ci-rerun).

## What gets posted

A comment and a commit status get posted when a run finishes, unless it is one of the runs that
[send nothing](/reference/test-metadata#run-origin), such as a run from an editor or one flagged as an
[environment incident](./environment-incidents):

- **A summary comment** on the run's open pull request (the one its CI names when the CI runs in the repository Piwi
  posts to, a pull request from a fork included, else the one open on its branch): one comment per pull request, edited on each later run rather than appended, so a busy
  branch doesn't collect a comment per push.
- **A commit status**: passed or failed against the run's commit, pull request or not, so a pull request shows the result in its checks
  list. Required for a branch-protection rule. A run whose only failures are [quarantined](./flaky-tests#quarantine-with-a-way-out)
  tests passes, and the status says how many (`118/120 passed, 2 quarantined`); turn on **Quarantined failures fail
  the commit status** under the project's **Settings → Source control** to fail it on any failure. **Only comment on
  failures** follows the same rule: such a run gets no comment, unless it fixed a failure cluster, left a new leak,
  closed one, or its change left a file no test reached, which the [uncovered changes](./uncovered-changes) section
  names. When the run has a
  diff to read, a second status that never fails joins it, `/change-coverage`
  ([what it counts](./uncovered-changes#on-the-pull-request)).
- **A pending status while a CI run runs**, under the same context: how many of its tests have a result and how many
  results failed (`Running: 120 of 400 tests, 2 failed`; a retry counts its failed attempt until the run ends), linking
  the live run, the first as the run reports and then at most once a minute. Bitbucket shows it as in progress. The
  run's final status replaces it; a run cancelled, deleted, interrupted or with no result to report ends it with an
  error status that says so. A pending status an instance posted before it restarted is replaced by the run's final
  status alone.

What the comment says, in this order:

1. **New failures**: failing now, passing in the last green run. This change caused them.
2. **Pre-existing failures**: already broken before this change. Separated so nobody debugs someone else's bug.
3. **Flaky**: passed on a retry after an earlier attempt failed.
4. **Looks fixed**: `test.fail()` tests that passed, each with "remove `test.fail()`" and its file, since the bug they
   reproduce no longer shows.
5. **New failure clusters**: root causes never seen before in this project.
6. **Fixed by this change**: clusters this pull request closed, with how long they were open. See
   [Did the fix work?](./failure-clusters#did-the-fix-work)
7. **Left open by this change**: [resource leaks](./leak-history) and servers or processes left running that the base
   branch never showed, each with the line that opened it, its last use and where its close goes: its test, an
   `afterAll`, or its fixture's teardown.
8. **Closed by this change**: open leaks, servers and processes of the default branch that the run no longer shows.
   Listed only for a full run of a pull request into the default branch, and only for a leak whose spec file had a
   test that passed in the run and none that failed; a fixture's leak is never listed. The run is read as the change
   merged with its target, as GitHub's `pull_request` checkout is: a branch built on its own head, behind a leak
   added to the default branch since it forked, may list that leak.

Each failure carries its error, its owner and tags when the test declares them (see
[ownership metadata](/reference/test-metadata#ownership-metadata-piwi-annotations)), and, when a locator broke, the
[replacement locator](./locator-healing) captured from the last passing run. The footer reports the CI minutes the run
spent on waits and failed attempts. When there is a diff to work with, the comment adds
[Uncovered changes](./uncovered-changes): the changed files no test reached and, with
[combined coverage](./combined-coverage), the changed lines no suite ran, then **Locators this change breaks**: the locators whose label, test id, placeholder or
translation the diff removes or renames, matched against the base branch's locator index as
[Locator preflight](./preflight) does. It lists only breaks none of whose tests ran in this run (a failing one is
already listed with its failure, a passing one was updated), so it names what the run did not exercise: tests outside
the selection, on another shard set, or in a nightly suite. Each comes with its call site and, for a rename, the
rewritten locator.

<figure>
  <img src="/screenshots/pr-comment.png" alt="The summary comment on a pull request: the run's counts, one new failure with its headline, owner and suggested locator, a pre-existing failure tracked in Jira, a flaky test also flaky on main, a new cluster, a cluster this change fixed, and the CI minutes wasted">
  <figcaption>The summary comment on a pull request.</figcaption>
</figure>

## The gate verdict

With **Gate status** on under the project's **Settings → Source control**, each verdict of the
[CI merge gate](./merge-gate) made with the CI key is also posted as your status context plus `/gate`
(`piwi/tests/gate`), so a branch rule can require the gate rather than the run. It needs **Set a commit status** on.
What is stored, and how merges past a failed gate are counted:
[On the pull request](./merge-gate#on-the-pull-request).

## Turn it on

Turn it on in **Settings → Pull requests** (off by default). It needs:

- **`PIWI_SITE_URL`** set on the dashboard. Every link in the comment is built from it; without it nothing is posted,
  because a comment full of unreachable links is worse than no comment.
- **An SCM token with write access** to the repository, set instance-wide or per project: `repo` on GitHub, `api` on
  GitLab, `repository` and `pullrequest` on Bitbucket. [Source control](/guide/source-control) explains where to set
  it and what else uses it.
- **Branch and commit metadata on the run**, which the reporter [detects automatically](/guide/ci#what-gets-detected).

## Limits

- Pull-request feedback posts on GitHub, GitLab and Bitbucket Cloud, not on Bitbucket Server or Data Center. On
  Bitbucket the commit status is a build status keyed by the status context, shown on the pull request of the run's
  branch, and the comment's marker is a link reference definition, which Markdown does not render.
- Piwi only ever edits a comment it wrote itself (identified by a hidden marker), so a human comment is never
  overwritten.
- Everything here is best-effort: the run is already stored by the time it runs, and a missing token or an unreachable
  host is logged rather than failing your pipeline.
- A comment reports; it does not block. To fail the build on a policy, use the [CI merge gate](./merge-gate).

## Related

- [CI & sharding](/guide/ci): run the reporter in CI
- [CI merge gate](./merge-gate): fail a CI job on the run's analysis
- [Source control](/guide/source-control): the SCM token and its scopes
- [Auto-heal PRs](./auto-heal): the pull request Piwi opens itself
- [Failure clusters & the inbox](./failure-clusters): the clusters the comment reports
- [Re-run in CI](./ci-rerun): re-run a cluster's tests from the dashboard
