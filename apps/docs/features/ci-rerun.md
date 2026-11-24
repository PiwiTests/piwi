---
title: Re-run in CI
description: "Run a cluster's, a run's or a test's tests, or the whole suite, in CI from the dashboard's run button: a GitHub workflow, a GitLab or Bitbucket pipeline, or a Jenkins job or any CI server reached by one HTTP request."
lang: en-US
---

# Re-run in CI

<Needs reporter />

A [filtered run that passes every affected test closes a cluster](./failure-clusters#did-the-fix-work). Piwi can start
that run in CI, and others: a page's **run button** opens a dialog whose **Where** lists the project's
[CI actions](./ci-actions) beside your own apps ([Run on my machine](./run-on-my-machine)). It reads **Run on CI**,
**Run on my machine** or **Run on my machine or CI**, after what you may use there:

| Page | What CI runs |
|---|---|
| Project | The whole suite, on the project's default branch |
| Run | Its failed tests, or the action's whole suite on the run's branch |
| Execution | The test, or every test of its cluster |
| Test | The test, or a [Flake Lab](./flake-lab#run-it-in-ci) experiment |
| Failure cluster, and its Verify section | Its affected tests |

A re-run sends each test's `file:line` from its latest failure and the projects it failed in, at most 100 tests, on
the branch of the run it comes from. The **Re-run in CI** next step, and a Flake Lab one, open the dialog on CI.

CI is **off by default**: a project starts it through the [CI actions](./ci-actions) of its **Settings**, each saying
where Piwi starts CI and what it sends. The dialog, MCP and the API can name another action than the default, a branch
and a value for each choice input.

CI shows to people with [`run:control`](/operate/project-access#what-each-role-can-do) once an action that takes the
page's tests can be sent: it serves the run's repository with a credential, and a re-run's tests have a path
Playwright takes.

<figure>
  <img src="/screenshots/run-dialog.png" alt="The run dialog of a failed run: its failed tests or every test, three CI actions, one disabled because it takes no re-runs, and the picked action's branch and input">
  <figcaption>A failed run's dialog: an action that takes no re-runs is disabled, with the reason.</figcaption>
</figure>

## The run dialog

- **Where** opens on the one you last sent to in this project, from this browser. Otherwise a re-run picks the action
  that started its run, else the one of its environment, else the default for re-runs; the project page picks its
  default for Run on CI, and the test page your first online app.
- A CI row shows its target and environment. It is disabled, with the reason, when the action does not take the
  chosen **What** or cannot be sent. Picked, the dialog says what a team run is: it counts in the project's history,
  sends notifications and pull-request feedback, and spends CI minutes. A Flake Lab experiment is a lab run instead,
  kept out of the history.
- **Branch**: a GitHub, GitLab or Bitbucket action offers the branches the project's runs reported, then the
  repository's; a Jenkins job with `{branch}` in its path, or a Custom request naming the branch, takes a typed name;
  any other CI server job runs its configured branch. A name git refuses is not sent.
- Each choice input offers its options; the fixed ones are listed.
- The button's menu sends the page's first **What** in one click, to one action or app, on the branch the dialog
  would pick, with the default choices.

After **Send** the dialog follows the dispatch: *waiting for the run to report*, with **Open in CI**, then the run and
its result once [matched](#matching-the-run), which a toast says if you closed the dialog. With no run after 30
minutes, it lists the likely causes. **Run again** sends it again; a CI run is cancelled in the CI. The Verify section
of a cluster and of its executions shows the cluster's last re-run.

*Copy retry command* is the local counterpart: it copies an `npx playwright test` command to run the same tests on your
machine. On a run's page, its menu adds run options the browser remembers (headed, trace, repeat each up to 10 without
retries, workers up to 4), and one project the tests ran in.

An action that accepts **Flake Lab** runs `piwi flake` for one flaky test: [Run it in CI](./flake-lab#run-it-in-ci)
shows the GitHub workflow, and [Flake Lab on Jenkins](./ci-actions#flake-lab-on-jenkins) the Jenkins job.

## Matching the run

Piwi matches each dispatch's run as it starts: by the `PIWI_ORIGIN_REF` the run carries, else by the CI's own run id
(GitHub's run, GitLab's pipeline, Bitbucket's build), and a Flake Lab run by its experiment's test. At its end, a CI
server re-run, or a GitHub one answered without a run, matches by branch, a start within six hours and exactly its spec
files.

A matched re-run's [origin](/reference/test-metadata#run-origin) is `ci-rerun`; the last re-run links its build and run
with its result, or reads *no run reported* after six hours. A repeat within ten seconds is refused; dispatches are kept
90 days.

A workflow GitHub answers with its run needs no change; otherwise the dispatch id input, optional since GitHub refuses
undeclared ones and passed on as `PIWI_ORIGIN_REF`, alone matches a whole suite:

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

## Limits

- A dispatch is one request: Piwi does not poll the CI, it waits for the run to report.
- The demo runs only CI server actions: it records a dispatch without sending it, so its follow-up keeps waiting for
  the run, and its Check answers as a job that declares the default parameters.

## Related

- [CI actions](./ci-actions): the workflows, pipelines and jobs a dispatch goes to
- [Pull-request feedback](./pr-feedback): the result posted on the pull request
- [Source control](/guide/source-control): the SCM credential and its scopes
- [Failure clusters](./failure-clusters): the clusters a re-run acts on
- [Flake Lab](./flake-lab): the experiment a Flake Lab action runs in CI
- [CLI](/reference/cli#rerun): the `rerun` command a pipeline runs
