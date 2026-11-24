# One run button

A plan to give every page that runs or re-runs tests the same split button and the same dialog. The dialog's
**Where** lists both the person's own apps ([Run on my machine](run-on-my-machine.md)) and the project's
[CI actions](../adr/ci-actions.md). The plan also records every CI dispatch, matches the run it starts as soon as that
run starts, and lets a project start its whole suite on CI. It builds steps 2 to 5 of
[#1292](https://github.com/PiwiTests/piwi/issues/1292), with a wider scope than the issue: there the dialog was for CI
only, a main click dispatched at once, and the run page was not one of the places.

**Status.** Accepted 2026-11-23, with the five questions settled as [Settled questions](#settled-questions) records. PR
2 is built: the `ci_dispatches` table, with each cluster's stored last re-run copied in and the column dropped; every
dispatch stored before it is sent (cluster, execution, Flake Lab, MCP), refused ones with the provider's error, and a
repeat within 10 seconds answered 409 with the first (D13); matching at `/start` and `/begin` by the dispatch id or the
provider's id (a Flake Lab run by its experiment's test), and at finish by those or the files (D10, D11); GitHub's run
id (D12); the `unreported` sweep and the 90-day retention (D18); the action that started the failed run picked first,
with the values it was sent with (D2); and "Last re-run" linking the run with its result. The demo seeds a matched and
an unreported re-run, and its runs report the Jenkins job their project re-runs in. PR 3 is built on the server, MCP
and demo side: one dispatch route for every source (D15), with the branch checked against git's rules and the target's
branch mode (D6) and the choice inputs against the action (D7); the reads of a dispatch and of a project's dispatches;
the actions offered for a place, with each one's branch mode, inputs and readiness, the D2 default and the place's last
dispatch; the branches an action may run on; `rerun_cluster_in_ci`'s `ref` and `inputs`, and `get_ci_dispatch` (D16).
The per-place routes are gone (Q5), and the cluster and execution pages, and the Flake Lab next step, dispatch through
the new route. PR 4 is built: `RunButton` and `RunDialog` on every place under [Per place](#per-place), Run on my
machine's modal folded into the dialog, the cluster's ⋮ entry and the execution's Verify buttons gone. The dialog
opens on the last Where, kept per browser and per project, else the D2 default; lists the person's apps and the
project's CI actions, a row that cannot take the What disabled with the reason; and shows the fields of the pick (an
app's environment and run options, a CI action's branch by its mode, its choices and its fixed inputs). The chevron
holds the D3 one-click runs, and the Next actions `rerun-in-ci` and `flake-lab-ci` open the dialog on CI.
`RunFollowUp` shows a request and a dispatch through one view (`#shared/run-follow-up`), after Send and in "Last
re-run", reading a dispatch every 5 then 30 seconds, with the likely causes after 30 minutes and a toast when its run
reports while the dialog is closed. The docs moved the CI actions' configuration to a page of its own. PR 5 is built:
in the desktop window, **Where** lists _This computer_ in place of the apps, first; the button runs its first What
there in one click, unless the last Where is a CI action that takes it ("Run on this computer or CI", which opens the
dialog), and shows a run of those tests while it goes on; its menu keeps the desktop button's command, one-off runs,
options and fixes, with the one-click runs on CI; **Run with options…** opens the dialog on This computer, whose
fields are the ones of the dialog it replaces; a selection of a run's tests has a button of its own, on This computer
alone; the run page offers the flaky tests there; and the desktop button and its dialog are gone. PR 6 is built: a
project's runs list shows, above its runs, each dispatch no run has answered yet ("Waiting for CI · Smoke · staging on
main · dispatched 2 minutes ago by Ana · Open in CI") to everyone who reads the project, and the viewer's own run
requests still going on, to them alone. A matched dispatch's row reads "Running · Open run #N" until its run ends,
since the list's scope may leave a partial run out; a request's run is never in the list, so its row links that run and
leaves once the request ends. The rows show whatever the filters say, five before **Show all**, but not under **Kept
runs only** or a period from Analytics; dispatch rows only while the project's CI actions are on. The dispatches are
read with the page's server render, the viewer's requests in the browser, and both again on each run event of the
project and when the tab shows again; while a row shows, a dispatch every 30 seconds, a request every 5 seconds until
its run starts, then every 30. Remain: PR 7 (tags), and a demo dispatch moving to `running` and `ended`
against a seeded run: it stays `dispatched`, and so does its row. Step 1 of #1292, the CI actions, shipped in [#1379](https://github.com/PiwiTests/piwi/pull/1379) and is
recorded in [ci-actions.md](../adr/ci-actions.md).

## What existed

As it stood when this plan was written; the Status paragraph says what changed since.

| Page           | On the person's machine                                                                    | On CI                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Project page   | Nothing                                                                                    | Nothing. The **Default for Run on CI** setting (`suite` kind) can be set, but nothing dispatches it.                                |
| Run page       | Run on my machine (failed or all), Copy retry command, and the desktop window's run button | Nothing, and no route dispatches a run's tests                                                                                      |
| Execution page | Run on my machine, and the desktop window's run button                                     | The Verify section's **Re-run this test in CI** and **Re-run the cluster in CI**; the Next actions `rerun-in-ci` and `flake-lab-ci` |
| Test page      | Run on my machine, and the desktop window's run button                                     | Nothing                                                                                                                             |
| Cluster page   | The desktop window's run button, in the fix plan's Verify                                  | **Re-run in CI**, in the ⋮ menu only                                                                                                |
| MCP            | Nothing                                                                                    | `rerun_cluster_in_ci`, with an optional `action`                                                                                    |

Behind those buttons:

- **Only a cluster keeps a record of its dispatch** (`failure_clusters.last_rerun_dispatch`, its last one only). A
  test re-run from an execution that has no cluster, a Flake Lab experiment and a whole suite are recorded nowhere.
- **A run is matched to its dispatch only when it finishes** (`matchCiRerunRun`, from `runFinalizeSideEffects`), and
  only against the clusters' last dispatches.
- **A whole suite can't be matched without its dispatch id.** The fallback match needs a branch, a time window and the
  exact spec files, and a whole-suite dispatch names none. Relaxing that rule would let a dispatch on `main` claim any
  push run of `main` for six hours.
- **GitHub's dispatch can return the run it created.** A request with `return_run_details: true` answers `200` with
  `workflow_run_id`, `run_url` and `html_url`; without it, `204` as before
  ([changelog](https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids)). The reporter
  already records `GITHUB_RUN_ID` as `ci.runId`. Piwi doesn't ask for it yet.
- **Two dialogs.** Run on my machine has a modal (What, Where, Environment, run options, then the request's progress).
  CI has none: its buttons dispatch the default action at once, and a choice input always sends its default
  (`ciActionInputValues`).

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **One split button and one dialog, everywhere.** `RunButton` and `RunDialog` are shared components, and `RunFollowUp` shows what was sent. The label names the destinations available: "Run on my machine", "Run on CI" or "Run on my machine or CI". The button hides only when neither is available. Apps need sign-in, the `machine-runs` capability and `run:request` (the rules of `useRunOnMyMachine`). CI needs CI actions on, `run:control` and one action that accepts what the place sends and serves its repository. It is a neutral outline button, like the buttons it replaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D2  | **The main click opens the dialog, with the person's last Where already picked** (kept per browser and per project). When that Where isn't offered here, a re-run place picks its default action. That is the action that produced the failed run, with the values it was sent with; else the action whose environment matches the run; else the kind's default. On the project page it picks the `suite` default, and anywhere else the first online app. This replaces #1292's "the main click dispatches at once": with two kinds of destination the button can't know where to run, and a team run that spends CI minutes takes one more click.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D3  | **The chevron keeps one-click shortcuts.** One row per CI action that takes the place's first What, the default first (for example "Re-run on CI · Smoke · staging (GitHub)"), and one per online app ("Send to Piwi Desktop · <machine>"). A shortcut sends the default branch and each choice's default. There is no **Customize…** row, since the main click opens the dialog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D4  | **The dialog is Run on my machine's modal, extended.** From top to bottom: a sentence that follows the pick, then **What**, **Where** and the fields of the pick. An app's sentence says the run is private ("only you see it"). A CI action's says it is a team run: it counts in the project's history, sends its notifications and pull request feedback, spends CI minutes, and runs against the action's environment. **Where** has two groups, _Your apps_ and _CI_. Each CI row shows its target ("GitHub · e2e.yml") and its environment. A row that can't take the chosen What is disabled and says why.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D5  | **The fields follow the pick.** An app shows the environment picker and the run options of Copy retry command (headed, trace, repeat each, workers, project). A CI action shows the branch, its choice inputs as selects, and its fixed inputs as one line of facts ("Sends sut=compose"). It hides the environment picker, because the action carries its environment, and hides the run options, because a dispatch sends only `file:line` and `--project` (`buildRetryArgs`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D6  | **The branch.** A re-run defaults to the failed run's branch; the project page and a whole suite from the run page default to the project's default branch and the run's branch. The availability check reports each action's branch mode. GitHub, GitLab and Bitbucket are `list`: the branches the project has run on, most recent first, then the repository's live branches through the action's SCM credential (`ScmProvider.listBranches`). A Jenkins job with `{branch}` in its path, or a Custom request with `{{ref}}` or `{{branchJob}}`, is `typed`, with the run branches as suggestions. Any other CI server target is `fixed`, and the dialog says "Runs on the job's configured branch". A typed name is checked against git's ref-name rules before it is sent, and in a Jenkins path it also goes through `segmentClimbsWhenDecoded`. The provider's error text (a branch that doesn't exist, a workflow missing on the branch) reaches the dialog as it was written.                                                                                                                                                |
| D7  | **The server checks the inputs.** A dispatch may send only the action's choice inputs, each with one of its options. A fixed input can't be overridden, and an input the action doesn't declare is refused with 400.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D8  | **A `ci_dispatches` table holds one row per dispatch**, refused ones included, for the audit. Its columns are listed under [The dispatch record](#the-dispatch-record). A cluster's last re-run reads from it, and `failure_clusters.last_rerun_dispatch` is copied into it and dropped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D9  | **A dispatch is `dispatched`, `running`, `ended`, `unreported` or `refused`.** It is `running` once a run is matched, and `ended` once that run finishes; the result is read from the run, never copied. `unreported` is final, set when no run matched within the matching window (six hours, `CI_DISPATCH_MATCH_WINDOW_MS`). `refused` means the provider answered with an error, kept in `detail`. A `running` dispatch whose run was cancelled or interrupted is open again, so a retry of the same job can answer it. After 30 minutes in `dispatched`, the follow-up view gives the likely causes while matching goes on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D10 | **A run is matched when it starts**, at `/start` and `/begin`, where the reporter's metadata arrives (`/setup` holds none), against the project's open dispatches, strongest identifier first. (1) The dispatch id, which the run carries as `PIWI_ORIGIN_REF`. (2) The provider's id for the run: GitHub `ci.runId`, GitLab `ci.pipelineId`, Bitbucket `ci.buildNumber`. A Jenkins job always gets the dispatch id as a parameter, since Jenkins answers a queue item and no build number. A Flake Lab run in CI, whose ref names its experiment rather than the dispatch, matches the newest Flake Lab dispatch of the experiment's test and kind, made before the experiment, on its branch; a developer's own `piwi flake` never does. Each CI's run id counts only from a run that CI reported. (3) At finish only, the file match: branch, a start within the window and exactly the dispatched spec files. It is for `tests` and `flakeLab` dispatches only, never `suite`. A run not matched at start is tried again at finish with all three, which also covers a batch upload, which creates a run and finishes it at once. |
| D11 | **What a match changes on the run.** A run matched to a `tests` dispatch is stamped `ci-rerun` with the dispatch id as its ref, as today. A `flakeLab` run keeps the `flake-lab` origin its command sets. A `suite` run keeps `ci` (Q4). The link always lives on the dispatch row (`run_id`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D12 | **GitHub links straight to its run.** A GitHub dispatch sends `return_run_details: true`. A `200` stores `workflow_run_id` as the provider's id and `html_url` as the link. A `204` keeps today's behavior: the workflow's runs list and the other matches. A `422` that names the parameter (a GitHub Enterprise Server without it) is sent once more without it, which is safe because a `422` dispatched nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D13 | **A double click is refused.** A dispatch with the same project, action, kind, arguments, branch and inputs as one stored in the last 10 seconds (refused ones aside) answers 409 with the existing dispatch, and the dialog shows that dispatch's follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D14 | **One follow-up view for both kinds** (`RunFollowUp`), shown in the dialog after **Send** and by "Last re-run". A run request shows sent, running, then ended, with **Stop** and **Run again** as today. A dispatch shows "Dispatched to <target> · Open in CI · waiting for the run to report…", then **Open run #N** with the run's result once matched. Without a run, it shows the likely causes: the job doesn't pass on `PIWI_ORIGIN_REF`, the reporter isn't set up in that job, or the job failed before Playwright started. A dispatch has **Run again** and no **Stop**: a CI run is cancelled in the CI. Both map to one shared view type (`#shared/run-follow-up`), so the component never reads two state models. While the page is open, it reads the dispatch every 5 seconds until it is matched, then every 30 seconds until it is final. A toast offers **Open run #N** when the run reports, and the page never navigates on its own.                                                                                                                                                                              |
| D15 | **One route dispatches for every place**, `POST /api/projects/:id/ci-dispatches`. Each place calls it with its source, and the per-place routes go (Q5). Under [API](#api).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D16 | **MCP.** `rerun_cluster_in_ci` takes an optional `ref` and `inputs` and returns the dispatch id. A new read tool, `get_ci_dispatch`, returns a dispatch's state, its run and the run's result, so an agent can follow what it started. Starting a whole suite from MCP is left out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D17 | **Permissions.** Dispatching any action needs `run:control` on the project, and reading the actions offered for a place needs it too. Reading a dispatch needs `project:read`, so the audit (who dispatched what, and when) is visible to the project's readers. Restricting an action to some roles stays a follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D18 | **Rows are kept 90 days**, then deleted by the retention sweep.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Per place

The dialog opens with the place's What already filled in. A test list that comes from a cluster or a test is shown and
locked.

| Place                                          | What                                         | Your apps                                                                  | CI                                                                                |
| ---------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Project page, in the navbar's actions          | The whole suite                              | Not offered: a request has no project-wide source                          | `suite`, on the project's default branch                                          |
| Run page header                                | The failed tests · Every test                | The run's failed tests, or all of them (at most 200, `RUN_REQUEST_LIMITS`) | `tests` with the failed tests · `suite`: the whole suite on the run's branch (Q3) |
| Execution page header                          | This test · Every test of its cluster        | This test; its cluster is disabled, with the reason                        | `tests`                                                                           |
| Test page header                               | This test · Flake Lab                        | This test (its newest execution); Flake Lab is disabled                    | `tests` · `flakeLab`                                                              |
| Cluster page header and its Verify             | Its affected tests                           | Disabled, with the reason                                                  | `tests`                                                                           |
| The Next actions `rerun-in-ci`, `flake-lab-ci` | Open the dialog with that What and CI picked | —                                                                          | —                                                                                 |

The new button replaces these: Run on my machine everywhere; the execution page's Verify buttons; the cluster's ⋮ entry.
The desktop window's run button and Copy retry command are Q1 and Q2.

## The dispatch record

`ci_dispatches`, in both dialects:

| Column                                        | Holds                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`                                          | The dispatch id, 16 hex digits, which the run hands back as `PIWI_ORIGIN_REF`                                          |
| `project_id`                                  | The project (cascade)                                                                                                  |
| `action_id`, `action_name`                    | The action, and its name at the time, so the row still reads after the action is renamed or removed                    |
| `origin`                                      | What started it: `page`, `mcp` or `api`. `schedule` is kept for [#1559](https://github.com/PiwiTests/piwi/issues/1559) |
| `kind`                                        | `tests`, `suite` or `flakeLab`                                                                                         |
| `source_run_id`, `cluster_id`, `test_case_id` | Where its tests came from, each null when there is none (set null on delete)                                           |
| `provider`, `preset`                          | Where it went                                                                                                          |
| `ref`                                         | The branch sent; null when the target runs its configured branch                                                       |
| `inputs`                                      | The values sent, fixed and chosen (JSON)                                                                               |
| `args`, `files`, `tests`                      | The Playwright arguments, and the spec files and test count they name                                                  |
| `url`                                         | The provider's run once known, else its runs list                                                                      |
| `provider_run_id`                             | GitHub's run id, GitLab's pipeline id, Bitbucket's or a Custom request's build number                                  |
| `state`, `detail`                             | D9, and the provider's error text                                                                                      |
| `run_id`                                      | The matched run, with no foreign key (as `run_requests.run_id`), so deleting a run never waits on it                   |
| `by_user_id`, `by_name`                       | Who pressed it (set null on delete; the name stays)                                                                    |
| `created_at`, `matched_at`, `updated_at`      |                                                                                                                        |

Indexes: `(project_id, created_at)`, `(project_id, state)`, `(cluster_id)`, `(provider_run_id)`.

The table comes in three generated migrations per dialect: the table, a custom migration that copies each cluster's
`last_rerun_dispatch` into a row (`ended` when it has a run, `dispatched` when it is less than six hours old, else
`unreported`), and the drop of the column.

## API

- `GET /api/projects/:id/ci-actions/offered`, with the place's source as query keys: the actions that take it. Each
  comes with its target label, environment, branch mode and default branch, its inputs, and whether it can be sent.
  The response also says which action is the default for the place under D2, and gives the place's last dispatch.
  Needs `run:control`.
- `GET /api/projects/:id/ci-actions/:actionId/branches?q=`: the branches of D6, each with where it came from.
- `POST /api/projects/:id/ci-dispatches` with `{ source, action?, kind?, ref?, inputs? }`. The source is one of
  `{ clusterId }`, `{ executionId, scope: 'test' | 'cluster' }`, `{ runId, tests: 'failed' }`, `{ runId }` for a
  whole suite on its branch, `{ testCaseId, flakeLab: 'reproduce' | 'verify' }`, or `{}` for the project's whole suite.
  Answers 201 with the dispatch, 400 for a bad branch or input, 404 for an id outside the project or an unknown
  action, 409 under D13, and 502 with the provider's text for a refused dispatch, which is stored as `refused`.
- `GET /api/ci-dispatches/:id` and
  `GET /api/projects/:id/ci-dispatches?state=open|taken|all&clusterId=&testCaseId=&limit=`.
- Removed (Q5): `GET`/`POST /api/failure-clusters/:id/rerun`, `GET`/`POST /api/test-run-cases/:id/rerun` and
  `POST /api/test-cases/:id/flake-lab-ci`.

The demo serves every route. A dispatch there moves to `running` and then `ended` against a seeded run after a few
seconds, the way the demo's seeded app answers run requests.

## Delivery plan

1. **This record**, with the scope update posted on #1292 once it is merged.
2. **The dispatch record** (#1292 step 2, server side). `ci_dispatches` and its migrations; every dispatch recorded,
   from the cluster, the execution, Flake Lab and MCP; D10 to D13; the `unreported` sweep and D18; D2's "the action
   that produced the run". "Last re-run" reads from the table and links to the Piwi run with its result. Also the demo
   seed, the docs' _Matching the run_, and the 1.0 register (D30 updated, a new D69 for the routes, the view and the
   states).
3. **The dispatch API**: D6, D7, D15 and D16. `RunFollowUp` and its dispatch side replace the toasts of today's CI
   buttons, which switch to the new route.
4. **The button and the dialog** (#1292 step 3) on every place under [Per place](#per-place), with Run on my machine's
   modal folded into `RunDialog`. Also the docs (`features/ci-rerun.md`, `features/run-on-my-machine.md`), the demo,
   the tour stops that show these screens, and before and after screenshots at 390 px and 1280 px.
5. **This computer** in the desktop window (Q1).
6. **The waiting row** (#1292 step 4): the project's run list shows its open dispatches ("Waiting for CI · Smoke ·
   staging on main · dispatched 2 minutes ago by Ana · Open in CI"), and the viewer's own waiting requests, which only
   they see.
7. **Tags** (#1292 step 5): an action accepts `tags`, and **What** gains "Tests tagged…" from the project's tags,
   sent as one `--grep`. This is CI only, until a run request takes tags.

## Settled questions

- **Q1. The desktop window's run button.** It runs at once, doubles as the status of a run of the same tests, and its
  menu holds one-off runs, option toggles and fixes. Run on my machine is hidden in the desktop window, so the window
  would show only _CI_ under Where. Settled: a _This computer_ row in Where folds that button in, built on its own
  (PR 5, built as the Status paragraph says). Before it, the button stayed beside the new one in the desktop window,
  and so did the run's test list's own.
- **Q2. Copy retry command.** It copies a command and runs nothing, it is the run page's primary action on a red run,
  and a guide anchor points at it (`run-retry-command`). Settled: it stays its own button.
- **Q3. "Every test" on the run page.** An app runs the run's own tests (capped at 200). Settled: CI runs the action's
  whole suite on the run's branch, and the line under What says so, though it differs from the run's tests when the
  run was partial (a selection or a grep). A list of a few thousand `file:line` could exceed the size a workflow input
  or a pipeline variable takes.
- **Q4. The origin of a matched whole-suite run.** Settled: it keeps `ci`. It is an ordinary full CI run, so it feeds
  flakiness and trends like any CI run, while a `ci-rerun` run is a re-run of failures. A new origin would have
  changed the run-origin register entry (D29).
- **Q5. The per-place routes.** Settled: PR 3 removes them with a `BREAKING CHANGE:` footer, following the register's
  convention of no compatibility aliases.

## Non-goals

- Free-text command-line arguments in the dialog; nested actions or presets of actions; editing a CI workflow from
  Piwi.
- Running tests on shared runners Piwi would manage ([#1558](https://github.com/PiwiTests/piwi/issues/1558), closed as
  not planned): CI runs teams' jobs, and this plan starts them.
- Scheduling runs ([#1559](https://github.com/PiwiTests/piwi/issues/1559)). The table keeps room for it: `origin`
  `schedule` and an action's dispatch with no person behind it.
- Stopping a CI run from Piwi, and an app run of a cluster's tests or of a whole project, which a run request can't
  name yet.
