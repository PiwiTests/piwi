---
title: Flake Lab
description: "Make a flaky test fail on demand: piwi flake replays each suspect from the test's history next to a control run, and piwi flake verify proves the fix under the same condition."
lang: en-US
---

# Flake Lab

<Needs reporter fixtures />

A flaky test costs the most when nobody can make it fail: the fix is a guess, and "it passed ten times in a row"
proves nothing about a failure that happens one time in twenty. The [Flakiness tab](./flaky-tests#suspects) ranks
**suspects** from the test's history, such as a request that is slower when it fails. The **Flake Lab** tests them:
`piwi flake` replays each suspect as a condition on your machine or in CI, next to a control run, until the failure
reproduces. A reproduced condition proves the cause, and the same condition later proves the fix.

## Run an experiment

From the project root, name the test by its test case id (the number in its dashboard URL) or by its spec file and
line:

```bash
npx @piwitests/reporter flake 1842
npx @piwitests/reporter flake tests/checkout.spec.ts:42
```

The command reads the test's plan from the dashboard, so it needs the reporter's `PIWI_DASHBOARD_URL` and
`PIWI_API_KEY` (or the project's `.env`). The specs must use the
[capture fixtures](/guide/capture-fixtures), which apply the conditions inside the page. In the
[desktop app](./desktop#reproducing-a-flake), **Reproduce this flake** on the Flakiness tab runs it at the commit
of the latest failure, and a bisect of a reproduced flake runs its arm at each step (`flake verify --bisect`).

It runs, one after the other:

1. **The control**: the test alone, 10 times, with no condition.
2. **One arm per suspect**: the test under that suspect's condition, up to 10 times, stopping at 3 failures with the
   same error as in CI. Suspects no experiment tested run first, most likely first; one that did not reproduce runs
   last, never dropped.

Every run has retries off and runs the checkout you are in. Before it starts, it prints an estimate from the test's
median duration; `--budget` (15 minutes by default) stops it from starting another arm once spent.

```text
  control                            0/10
  1  delay GET /api/cart 1.8 s       3/4    stopped at 3 · same error as in CI          reproduced
  2  run with admin › resets catalog 1/10   same error as in CI                         not reproduced
Verdict: reproduced by delay GET /api/cart 1.8 s (3/4 against 0/10, p = 0.011)
```

## The conditions

| Suspect | Condition | How the arm applies it |
|---|---|---|
| A slow route | delay it to the failures' median duration | the fixtures hold each response until that long after the request started |
| A failed route | fail it with the same status, or abort it | the fixtures answer with the status, or reset the connection |
| Load | throttle the CPU ×4 | a DevTools session, so Chromium only |
| Another test alongside | run both together | both tests on two workers; only rounds where they overlapped count |
| The test just before | run that test first | both tests on one worker; only rounds where it ran just before count |
| A browser | pin the Playwright project | `--project` |

`--suspect <n>` runs only suspect `n`'s arm. `--all` also runs every condition at once when none reproduces alone.

## Reading the verdict

A failure counts toward an arm only when its error matches one of the test's failures in history (the same masked
error message, so a different timeout or id still matches). A condition that breaks the test some other way, such
as a delay that trips a timeout the test never hit in CI, is shown apart and has not reproduced the flake.

| Verdict | When |
|---|---|
| **Reproduced** | at least half the arm's runs failed with a matching error, and a one-sided Fisher exact test against the control gives p < 0.05 |
| **Amplified** | p < 0.05, but under half the runs failed |
| **Not reproduced** | anything else |

The command prints the commit it tested next to the commit of the test's latest failure, and warns when they
differ: a condition that reproduces on today's code says little about last month's failure. The control catches a
test that simply fails on this machine.

**Not reproduced is not ruled out.** Ten clean runs only show the condition fails in under about 26% of runs (95%
confidence): a one-in-twenty flake can still come from it, so the next experiment runs it after the untested ones.

## Verify a fix

After the fix, rerun the condition that reproduced it:

```bash
npx @piwitests/reporter flake verify 1842
```

It reruns the reproducing arm and its control for enough runs that a failure at the rate it reproduced would have
shown with 95% confidence (`⌈ln 0.05 / ln(1 − rate)⌉`, at least 5), and stops at the first matching failure. With
none, the fix is **verified**. The verify experiment appears on the Flakiness tab next to the one it verifies, and the
test reads [verified fixed](./flaky-tests#verified-fixed): off the flaky ranking until it retry-passes again, and a
quarantined test is proposed for release at once.

**Exit codes:** `0` an arm reproduced the failure (`verify`: the fix held) · `1` nothing reproduced (`verify`: it
still fails, or too few runs passed to say) · `2` error.

## Where results show

- The project's **Flake Lab** tab lists every flaky or tested test with where it stands (not tested, reproduced, fix
  verified) and the command it needs next, then the project's newest experiments.
- The test's **Flakiness** tab lists its experiments and each suspect's latest result, with buttons that copy both
  commands.
- The **flaky list** marks a test whose latest experiment reproduced it.
- The [clue](/reference/clues) `known-flake-suspect` turns strong on a failure showing a reproduced suspect.
- Over [MCP](/features/mcp), `get_flake_profile` and `plan_flake_experiment` give an agent the experiments and the
  arms to run; the `stabilize-flaky-tests` [agent skill](/features/agent-skills) follows this loop.

The lab's own runs are stamped as flake-lab runs, kept out of the flaky score, clusters, notifications, quarantine,
the suspects, the editor's CI failures and every other comparison between runs.

## From the editor and the failure pages

- **In the [editor](./editors#the-tests-behind-each-line)**, a flaky test's line shows its flaky rate and top suspect
  ("flaky 18% · top suspect: GET /api/cart slower (reproduced 7 of 10)"), with **Reproduce this flake** and, once
  reproduced, **Verify the flake fix**, run in a terminal against the instance the editor reads. Beside a team
  instance, **Reproduce this flake in the desktop app** (also on a failure with an untested suspect) runs the
  instance's plan in the [desktop app](./desktop#jobs-from-your-editor) once you confirm it; **Share on …** records
  the results on the instance, as run from `desktop`.
- **On a flaky failure's page**, the next step reproduces it under the top untested suspect, then verifies the fix.
- **Home** lists the tests waiting for a verify, then those whose top suspect is untested.

## Run it in CI

A local machine is not CI: a delay reproduces a race anywhere, but load and interference depend on the machine. To
run the lab where the flake lives, add a manual workflow and start it with the test case id:

```yaml
# .github/workflows/flake-lab.yml
name: Flake Lab
on:
  workflow_dispatch:
    inputs:
      test:
        description: Test case id, or file:line
        required: true
jobs:
  flake:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx @piwitests/reporter flake "${{ inputs.test }}"
        env:
          PIWI_DASHBOARD_URL: ${{ vars.PIWI_DASHBOARD_URL }}
          PIWI_API_KEY: ${{ secrets.PIWI_API_KEY }}
```

The experiment is recorded with the source `ci`. Exit code 1 (nothing reproduced) fails the job; add
`continue-on-error: true` to the step when you only want the result on the tab.

To start it from a failure's next step (**Reproduce in CI**, **Verify in CI**), make the input the command's arguments
(<code v-pre>npx @piwitests/reporter ${{ inputs.piwi_flake }}</code>) and name the workflow as the **Flake Lab** target in the project's
[CI re-run](./pr-feedback#re-run-from-the-dashboard) settings. It receives `flake 1842` or `flake verify 1842`.

## Without the dashboard

`--no-upload` keeps the results off the dashboard, but the plan still comes from it. When the dashboard cannot be
reached, pass a plan saved earlier with `--plan <file>`: the response of the plan endpoint, or the `plan` the
`plan_flake_experiment` MCP tool returns. The verdict is computed locally the same way.

## Limits

- `cpu` needs Chromium; on another browser the arm reports the condition as skipped.
- A failure that depends on another team's run on a shared environment has no condition; it stays context on the
  Flakiness tab.
- Order across whole files is not controlled: an `after` arm counts only the rounds Playwright happened to run in
  the order it asked for.

## Try it in the demo

The [live demo](https://piwitests.dev/demo/) cannot run the lab, but it holds experiments:

<DemoExamples />

## Related

- [Flaky tests & quarantine](./flaky-tests): the flaky score and the suspects the lab tests
- [Piwi CLI](/reference/cli#flake): every flag of `piwi flake`
- [Clue rules](/reference/clues): `known-flake-suspect`
- [Agent skills](./agent-skills): `stabilize-flaky-tests`
- [Desktop app](./desktop#reproducing-a-flake): the lab and a flake-aware bisect in a worktree
