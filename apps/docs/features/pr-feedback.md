---
title: Pull-request feedback & re-run
description: "Piwi posts a run's result on the pull request, new failures apart from pre-existing ones, and re-runs a cluster's tests in CI from the dashboard."
lang: en-US
---

# Pull-request feedback & re-run

<Needs reporter scm />

The run URL a CI job prints is a link somebody has to click. Piwi can instead post the result onto the pull request
itself, which is where the person who broke the test already is. And once a cluster is fixed, the cluster page can
start the CI run that proves it.

## What gets posted

Two things get posted when a run finishes, unless it is a run from an editor or a partial run from a developer's
machine or the desktop app ([run origin](/reference/test-metadata#run-origin)):

- **A summary comment** on the branch's open pull request: one comment per pull request, edited on each later run rather than appended, so a busy
  branch doesn't collect a comment per push.
- **A commit status**: passed or failed against the run's commit, pull request or not, so a pull request shows the result in its checks
  list. Required for a branch-protection rule. A run whose only failures are [quarantined](./flaky-tests#quarantine-with-a-way-out)
  tests passes, and the status says how many (`118/120 passed, 2 quarantined`); turn on **Quarantined failures fail
  the commit status** under the project's **Settings → Source control** to fail it on any failure. **Only comment on
  failures** follows the same rule: such a run gets no comment.

What the comment says, in this order:

1. **New failures**: failing now, passing in the last green run. This change caused them.
2. **Pre-existing failures**: already broken before this change. Separated so nobody debugs someone else's bug.
3. **Flaky**: passed only on a retry.
4. **Looks fixed**: `test.fail()` tests that passed, each with "remove `test.fail()`" and its file, since the bug they
   reproduce no longer shows.
5. **New failure clusters**: root causes never seen before in this project.
6. **Fixed by this change**: clusters this pull request closed, with how long they were open. See
   [Did the fix work?](./failure-clusters#did-the-fix-work)
7. **Left open by this change**: [resource leaks](./resource-leaks#in-ci) the base branch never showed, each with the
   line that opened it.

Each failure carries its error, its owner and tags when the test declares them (see
[ownership metadata](/reference/test-metadata#ownership-metadata-piwi-annotations)), and, when a locator broke, the
[replacement locator](./locator-healing) captured from the last passing run. The footer reports the CI minutes the run
spent on waits and failed attempts. When the [Test Map](./scenario-gaps) has a diff to work with, the comment adds the
changed files no test reached, then **Locators this change breaks**: the locators whose label, test id, placeholder or
translation the diff removes or renames, matched against the base branch's locator index as
[Locator preflight](./preflight) does. It lists only breaks none of whose tests ran in this run (a failing one is
already listed with its failure, a passing one was updated), so it names what the run did not exercise: tests outside
the selection, on another shard set, or in a nightly suite. Each comes with its call site and, for a rename, the
rewritten locator.

## The gate verdict

Each [merge gate](/guide/ci#blocking-a-merge) evaluation made with a key that can upload or control the project's runs
(the CI key `piwi gate` uses) is stored with its policy, its verdict, its violations and the pull request it judged. A
reader of the project gets the verdict only: nothing is stored or posted.

- **A commit status of its own.** Turn on **Gate status** under the project's **Settings → Source control** and each
  verdict is also posted as your status context plus `/gate` (`piwi/tests/gate`), so a branch rule can require the
  gate rather than the run. It needs **Set a commit status** on. An
  [environment incident](./environment-incidents) posts nothing.
- **Overrides and escapes.** Every ten minutes Piwi asks the host what became of the pull requests a gate failed on.
  One merged while its last evaluation still failed counts as an override; one fixed first, or closed, does not. When
  a cluster that evaluation caught as a new regression fails again on an eligible default-branch run within 30 days
  of the merge, the override also counts as an escape past the gate.

## Turn it on

Turn it on in **Settings → Pull requests** (off by default). It needs:

- **`PIWI_SITE_URL`** set on the dashboard. Every link in the comment is built from it; without it nothing is posted,
  because a comment full of unreachable links is worse than no comment.
- **An SCM token with write access** to the repository, set instance-wide or per project: `repo` on GitHub, `api` on
  GitLab. [Source control](/guide/source-control) explains where to set it and what else uses it.
- **Branch and commit metadata on the run**, which the reporter [detects automatically](/guide/ci#what-gets-detected).

## Re-run from the dashboard

Once a cluster is fixed, the fastest way to prove it is to re-run exactly the affected tests, and a
[filtered run that passes them all closes the cluster](./failure-clusters#did-the-fix-work). The cluster page can
trigger that run in CI for you: **Re-run in CI**, next to *Copy retry command*, dispatches a workflow or pipeline with
the cluster's retry arguments (each affected test's `file:line` from its latest failure, `--project` when they share
one) on the branch of the cluster's latest run, and links to the run it started. The configured ref is used only when
that run recorded no branch. The last dispatch (when, by whom, and a link) shows under the Test evidence header.

It is **off by default** and configured per project in the **Source control** section of the project's **Settings** tab,
under **CI re-run**. Turn it on and fill in the block for your provider:

| Provider | Target you configure | Token scope |
|---|---|---|
| **GitHub** | Workflow file name (e.g. `e2e.yml`), a ref, the `workflow_dispatch` input that receives the arguments, and optionally the input that receives the dispatch id | `actions:write` (a classic PAT's `workflow` scope) |
| **GitLab** | A ref and the pipeline variable name that receives the arguments | `api` |
| **Bitbucket** | The `custom:` pipeline name and the variable name that receives the arguments | `pipeline:write` |

The dispatch uses the project's SCM token, so that token needs the write scope above. The button is disabled with an
explanatory tooltip when the feature is off, no target is configured for the repository's provider, or no token is set.

An optional **Flake Lab** block names a second workflow or pipeline that runs `piwi flake` for one flaky test, started
from that test's next step: [Run it in CI](./flake-lab#run-it-in-ci) shows the workflow.

Your workflow has to actually consume the value. A minimal GitHub example that forwards the input to Playwright:

```yaml
on:
  workflow_dispatch:
    inputs:
      args:
        description: Playwright arguments
        required: false
        default: ''
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx playwright test ${{ inputs.args }}
```

On GitLab, read the variable in your test job (`npx playwright test $PW_ARGS`); on Bitbucket, reference it the same way
inside the `custom:` pipeline you named. GitHub's `workflow_dispatch` returns no run id, so the link goes to the
workflow's runs page filtered to the branch; GitLab and Bitbucket link straight to the pipeline.

When the re-run finishes, Piwi recognizes it and records its [origin](/reference/test-metadata#run-origin) as `ci-rerun`: by
GitLab's pipeline id or Bitbucket's build number, which the dispatch answered with, and on GitHub by the dispatch id
when the workflow passes it on. GitHub rejects an input the workflow does not declare, so that input is a separate,
optional setting. Declare it and hand it to the reporter as `PIWI_ORIGIN_REF`:

```yaml
on:
  workflow_dispatch:
    inputs:
      args:
        required: false
        default: ''
      piwi_dispatch:
        required: false
        default: ''
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx playwright test ${{ inputs.args }}
        env:
          PIWI_ORIGIN_REF: ${{ inputs.piwi_dispatch }}
```

Without it, a GitHub run is matched on its branch, a start within six hours of the dispatch, and running exactly the
dispatched spec files.

## Limits

- Pull-request feedback posts on GitHub and GitLab. On Bitbucket the settings page saves, but nothing is posted.
- Piwi only ever edits a comment it wrote itself (identified by a hidden marker), so a human comment is never
  overwritten.
- Everything here is best-effort: the run is already stored by the time it runs, and a missing token or an unreachable
  host is logged rather than failing your pipeline.
- A comment reports; it does not block. To fail the build on a policy, use the
  [merge gate](/guide/ci#blocking-a-merge).

## Related

- [CI & sharding](/guide/ci): run the reporter in CI and gate a merge
- [Source control](/guide/source-control): the SCM token and its scopes
- [Auto-heal PRs](./auto-heal): the pull request Piwi opens itself
- [Failure clusters & the inbox](./failure-clusters): the clusters the comment and the re-run act on
