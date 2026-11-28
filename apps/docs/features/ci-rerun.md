---
title: Re-run in CI
description: "Run a cluster's, a run's or a test's tests, the tests carrying some tags, or the whole suite, in CI from the dashboard's run button: a GitHub workflow, a GitLab or Bitbucket pipeline, or a Jenkins job or any CI server reached by one HTTP request."
lang: en-US
---

# Re-run in CI

<Needs reporter />

A [filtered run that passes every affected test closes a cluster](./failure-clusters#did-the-fix-work). Piwi can start
that run in CI, and others: a page's **run button** opens a dialog whose **Where** lists the project's
[CI actions](./ci-actions) beside your own apps ([Run on my machine](./run-on-my-machine)). It reads **Run on CI**,
**Run on my machine** or **Run on my machine or CI**, after what you may use there; in the desktop app, it says what it
runs on [this computer](./run-on-this-computer):

| Page | What CI runs |
|---|---|
| Project | The whole suite, or the [tests carrying some tags](#tagged-tests), on the project's default branch |
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
  default for Run on CI, or for tagged tests, and the test page your first online app. In the desktop app, **This
  computer** takes your apps' place and comes first: [Run on this computer](./run-on-this-computer).
- A CI row shows its target and environment. It is disabled, with the reason, when the action does not take the
  chosen **What** or cannot be sent. Picked, the dialog says what a team run is: it counts in the project's history,
  sends notifications and pull-request feedback, and spends CI minutes. A Flake Lab experiment is a lab run instead,
  kept out of the history.
- **Branch**: a GitHub, GitLab or Bitbucket action offers the branches the project's runs reported, then the
  repository's; a Jenkins job with `{branch}` in its path, or a Custom request naming the branch, takes a typed name;
  any other CI server job runs its configured branch. A name git refuses is not sent.
- Each choice input offers its options; the fixed ones are listed.
- An action on a [per-user credential](/operate/per-user-credentials) says *in your name*, and asks for your own
  token the first time.
- The button's menu sends the page's first **What** in one click, to one action or app, on the branch the dialog
  would pick, with the default choices. In the desktop app, it is This computer's menu, with these runs on CI in it.

After **Send** the dialog follows the dispatch: *waiting for the run to report*, with **Open in CI**, then the run and
its result once [matched](#matching-the-run), which a toast says if you closed the dialog. With no run after 30
minutes, it lists the likely causes. **Run again** sends it again; a CI run is cancelled in the CI. The Verify section
of a cluster and of its executions shows the cluster's last re-run.

*Copy retry command* is the local counterpart: it copies an `npx playwright test` command to run the same tests on your
machine. On a run's page, its menu adds run options the browser remembers (headed, trace, repeat each up to 10 without
retries, workers up to 4), and one project the tests ran in.

An action that accepts **Flake Lab** runs `piwi flake` for one flaky test: [Run it in CI](./flake-lab#run-it-in-ci)
shows the GitHub workflow, and [Flake Lab on Jenkins](./ci-actions#flake-lab-on-jenkins) the Jenkins job.

## Tagged tests

On the project page, **What** also offers **Tests tagged…**. Pick up to 10 of the tags of the tests that ran in the last
30 days, each listed with how many of those tests carry it, spellings that differ only in case counted as one, and, for
two or more, whether a test carrying **any of them** or **all of them** runs. Only an action that accepts **Tagged
tests** takes them; the others are disabled, with the reason. Your apps take no tags: a run request names its tests.

<figure>
  <img src="/screenshots/run-dialog-tags.png" alt="The project page's run dialog on Tests tagged: @api and @regression picked, All of them chosen, the nightly action picked and the smoke action disabled because it takes no tagged tests">
  <figcaption>Two tags, a test carrying both: the action that takes no tagged tests is disabled.</figcaption>
</figure>

CI gets one `--grep` over what Playwright greps, a test's titles and its tags, ignoring case, so `@smoke` in a title
and in the `tag` option both match. Each tag runs up to a space or the end, after any character, as Playwright reads a
tag from a title (`@example.com` in `emails user@example.com`); one of 60 characters, the most Piwi keeps of a tag,
matches as a tag's start. **All of them** for `@smoke` and `@checkout` sends:

```text
--grep="^(?=[^]*@smoke(?=\s|$))(?=[^]*@checkout(?=\s|$))"
```

It is double-quoted like every argument Piwi sends, and reads the same in bash, PowerShell, cmd and
[`rerun`](/reference/cli#rerun). A tag holding a space, a double quote, or one of `$`, `` ` ``, `\`, `%` and `!` is not
offered.

## Waiting rows

A project's runs list shows each dispatch no run has answered yet as a row above its runs, to everyone who reads the
project: *Waiting for CI*, what it runs, its action and the branch it names, when and by whom it was dispatched, and
**Open in CI**. After 30 minutes it reads *No run reported yet*, with the likely causes under **Why?**. Once a run is
[matched](#matching-the-run) to it, the row reads *Running* with **Open run #N** while that run goes on, since the
list's filters may leave the run out (a re-run is a partial run), and leaves when the run ends. A dispatch no run is
matched to within six hours leaves then.

Your own [run requests](./run-on-my-machine) wait there as well, seen by you alone. A requested run is never in the
list, so its row stays while the run goes on, with a link to it, and leaves once the request ends.

The rows show whatever the filters say, five at a time with **Show all**, but not under **Kept runs only** or a period
opened from Analytics; dispatches show while the project's CI actions are on. The page reads the dispatches with
itself, your requests once it has loaded, and both again on each run event of the project and when the browser tab
shows again; while a row shows, a dispatch every 30 seconds, a request every 5 seconds until its run starts, then every
30.

## Matching the run

Piwi matches each dispatch's run as it starts: by the `PIWI_ORIGIN_REF` the run carries, else by the CI's own run id
(GitHub's run, GitLab's pipeline, Bitbucket's build), and a Flake Lab run by its experiment's test. At its end, a CI
server re-run, or a GitHub one answered without a run, matches by branch, a start within six hours and exactly its spec
files.

A matched re-run's [origin](/reference/test-metadata#run-origin) is `ci-rerun`. The run of a whole suite or of tagged
tests keeps `ci`, and the grep of tagged tests makes theirs a partial run, as any grep does. The last re-run links its
build and run with its result, or reads *no run reported* after six hours. A repeat within ten seconds is refused; dispatches are kept
90 days.

A workflow GitHub answers with its run needs no change; otherwise the dispatch id input, optional since GitHub refuses
undeclared ones and passed on as `PIWI_ORIGIN_REF`, alone matches a whole suite or tagged tests:

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
- The demo runs only CI server actions: it records a dispatch without sending it, so its follow-up and its row in the
  runs list keep waiting for the run, and its Check answers as a job that declares the default parameters.

## Related

- [CI actions](./ci-actions): the workflows, pipelines and jobs a dispatch goes to
- [Pull-request feedback](./pr-feedback): the result posted on the pull request
- [Source control](/guide/source-control): the SCM credential and its scopes
- [Failure clusters](./failure-clusters): the clusters a re-run acts on
- [Flake Lab](./flake-lab): the experiment a Flake Lab action runs in CI
- [CLI](/reference/cli#rerun): the `rerun` command a pipeline runs
