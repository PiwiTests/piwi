# Runs from the dashboard, on the developer's machine

A plan to let a developer start, from a page of the team instance's dashboard, the work the IDE and the desktop app
already do on their machine: run a test, debug a failure at its line, reproduce it at its commit, find the commit that
broke it, run a flaky test's Flake Lab experiment, verify a fix, and write a missing test. The question was whether a
shared instance, with Piwi Picker paired both to it and to an IDE, could start a run from the dashboard, or do anything
the desktop app can do. It can, without the instance running or steering anything: the page asks Piwi Picker, Piwi
Picker asks the IDE or the desktop app on the same machine, and that program decides and runs, as it does today for
**Debug in my editor** and for the editor's desktop jobs. The run reports to the instance as any run does, and the page
follows it there.

**Status.** Proposed 2026-10-29. Nothing is built. The plan builds on [`run-control.md`](../adr/run-control.md) (the
run hubs, the Runs window, the live view), [`editor-local-runs.md`](../adr/editor-local-runs.md) (the editor's runs and
how it follows them) and the desktop jobs of [`1.0-stabilization.md`](1.0-stabilization.md) D36 and D51. It amends
run-control's D8 and Flake Lab's D4 ([Decisions](#decisions), D1). An unmerged design record of August 2026,
`proposals/desktop-remote-connect.md` on the branch `claude/desktop-remote-instance-connect-l1sbyt`, explored another
route to the same place: the desktop app's window showing the team instance. This plan does not depend on it, and the
run requests of [Part 1](#part-1-the-run-requests) would serve that route too.

**Summary.** The team instance is where a team sees its failures: the history, the clusters, the diagnoses, the live
view of a CI run. The IDE and the desktop app are where a developer acts on them: run, pause, pick, write. Each step
from one to the other is a copy. The failure pages' Next row copies a recipe, a patch, a locator, a Flake Lab command
or an AI prompt; the run header copies a retry command; the Flakiness tab and the saved selections copy commands. The
one step that is not a copy is **Debug in my editor**, a link the IDE asks about before it runs anything. Every piece
needed to turn the copies into actions exists but one: nothing lets a page of the instance ask the developer's machine
to start a run. A run hub steers runs and starts none; Piwi Picker's content script on the instance's pages only marks
them; the desktop app takes jobs from the editor and from Piwi Picker, never from a page. This plan adds that one link,
and keeps the rule that makes the rest safe: **the dashboard asks, the developer's machine decides and runs, the
instance only shows.**

The terms this record uses:

- A **team instance** is a Piwi server that several people and CI report to.
- A **run hub** is the process that started a run and holds its controls: the editor service of an IDE window for the
  runs that window starts, or the desktop app's server for its own (`@piwitests/core/run-hub`,
  [`run-control.md`](../adr/run-control.md) Part 4). The code calls it the hub.
- A **run request** is what a dashboard page sends: one entry of a closed list ([Part 1](#part-1-the-run-requests)),
  naming what to run by the instance's ids, never by a path, a command or code.
- A **target** is a program on the developer's machine that can take a run request: an IDE window, through its run
  hub, or the paired desktop app.
- A **job** is the desktop app's work on a commit in a throwaway worktree: a reproduction, a bisect or a Flake Lab
  experiment, as the editor's desktop jobs name it.

## What the developer gets

A CI run fails on `main`. On the team instance, a failure cluster groups seven tests whose `getByLabel('Coupon')` finds
no element. Its Next row offers the target Piwi Picker found for the project, the VS Code window whose workspace reports
to it:

```
Most likely  The coupon field's label changed in a1b2c3d.
Next         Debug on my machine · VS Code · shop      Reproduce at a1b2c3d      Re-run in CI
```

The developer clicks **Debug on my machine**. The first time, VS Code asks: "Run checkout.spec.ts › pays with a coupon,
as asked from piwi.acme.com? Run · Always for this workspace · Not now". They pick **Always for this workspace**.
VS Code opens `checkout.page.ts:30` and runs the test headed, one worker, stopped at the failing line, as Debug in my
editor does today, with Piwi's suggested locator outlined on the page. On the dashboard, the button has become the
run: "Stopped at checkout.page.ts:30 · VS Code · shop". **Show it here** opens the stop beside CI's failure
screenshot, with Resume, Step and Pick. **Pick**, then a click on the field in the test's window:
`getByRole('textbox', { name: 'Coupon code' })` replaces the locator on line 30, in the editor. **Resume**: the test
passes.

Back on the cluster, **Verify on my machine** runs the cluster's seven tests on the working tree, headless, with
retries off. The button reads "Passed · 7 tests · VS Code". The developer pushes, and **Re-run in CI**, or the next CI
run, verifies the fix as it does today.

The same failure, seen by a developer who has the desktop app paired and no IDE open: **Reproduce at a1b2c3d** opens
the desktop app's window with the job (the commit, the seven tests, the browser), which runs nothing until **Run** is
clicked there. The verdict comes back on the cluster page; the run itself stays in the desktop app.

The same page, in a browser without Piwi Picker, shows what it shows today: **Debug in my editor** through its link,
the copies, and **Re-run in CI**.

## What exists

| Piece | Where | What this plan takes from it |
| --- | --- | --- |
| The editor's runs | `piwi/runArgs` (`packages/editor/src/server.ts`), `src/commands.ts`, `src/run-watch.ts`; [`editor-local-runs.md`](../adr/editor-local-runs.md) | The service builds every command: test ids resolved through the instance's selection preview, `spec:line`, a saved selection, `--repeat-each` up to 100. It tags the run `PIWI_ORIGIN=editor` with a `PIWI_ORIGIN_REF`, and follows it on the instance through `GET /api/projects/:id/latest-run?origin&ref` and `GET /api/stream`. |
| Debug in my editor | `debugInIde` (`app/composables/useOpenInIde.ts`), `apps/vscode/src/debug-link.ts`, `PiwiOpenHandler.kt`, `packages/editor/src/debug-run.ts` | The one path from a page to a run today. A `vscode://` link, or the JetBrains plugin's `/api/piwi/open`, which takes only the desktop app's origin, `PIWI_DASHBOARD_URL` or the instance an open project reports to (`OpenOrigins.kt`). The IDE asks, then runs the test headed at its failing line; the command is built from the test the service finds in the spec, never from what the link named. |
| The run hubs | `@piwitests/core/run-hub`, `packages/editor/src/run-hub.ts`, `apps/application/server/utils/desktop-runs.ts` | A WebSocket on `127.0.0.1` that only a browser extension holding the run hub's token reaches, and a closed set of commands that follow and steer runs (`subscribe`, `follow`, `runControl`, `view`, `input`, `pick-at`, `share`, …). None starts a run. The `welcome` names the run hub's client and its first 64 workspace folders. |
| Piwi Picker | `apps/extension` | Connected to the instance (an API key from the device flow), paired with the editor (Send to editor, then `GET …/live` for the run hubs) and with the desktop app. The Runs window follows and steers the runs of both, with a stop's live view. `instance-marker.js`, a content script registered on the connected instance's origin alone, sets `data-piwi-picker` on its pages and sends nothing. |
| The desktop app's jobs | `POST /api/desktop/repro-requests` (`shared/desktop-repro.ts`), `packages/editor/src/desktop-jobs.ts`, `DesktopReproRequestModal.vue`, `apps/desktop/src-tauri/src/worktree.rs` | Reproduce, bisect and Flake Lab at a commit in a throwaway worktree, sent by the editor; a bug report's steps, sent by Piwi Picker. The window shows each and runs it only on the developer's click. The sender polls the verdict and records it on the team instance with its own key, which the app never holds. |
| Run origins | `RUN_ORIGIN_KINDS` (`packages/core/src/wire.ts`), `shared/run-eligibility.ts` | `editor`, `desktop`, `reproduce`, `bisect`, `flake-lab` and `ci-rerun`, each with a `ref` of letters, digits and `._:/#@-`, 200 characters at most. An `editor` run sends no notification and no pull-request feedback (editor-local-runs D11), and a run that paused is no signal either (run-control D10). |
| The live view | `server/utils/live-view.ts`, `RunLiveView.vue`, `TestRowLiveWorker.vue` | **Watch** on a CI run, or on a run its developer shares live, relayed in the server's memory and never stored. A running row of a run nobody shares says **Not shared live**, with where to share it from (#959). |
| CI re-run | `server/utils/ci-rerun.ts` | A cluster's tests, or a test's Flake Lab, re-run in CI through the project's SCM token, under `run:control`. |

## Decisions

| | Decision | Why |
| --- | --- | --- |
| D1 | The team instance never runs a test, and never starts or steers a run on its own. A person may ask their own machine, from the instance's pages in their own browser, for a run request of a closed list ([Part 1](#part-1-the-run-requests)); the target decides and runs. | Amends [`run-control.md`](../adr/run-control.md) D8 ("the team instance never steers a run") and [`flake-lab.md`](../adr/flake-lab.md) D4 ("the dashboard only plans and records") without reversing either: no request leaves the person's browser, and nothing runs that their machine did not accept. |
| D2 | Piwi Picker carries the requests. The page talks to the content script Piwi Picker registers on the connected instance's origin (`instance-marker.js`, extended), which passes each message to the background worker; the worker talks to the run hubs and the desktop app as it does today. | Piwi Picker already holds the three connections and keeps their secrets out of pages, and its content script is registered on the instance's origin alone. No new permission, and no `externally_connectable`, whose `matches` cannot name a self-hosted origin. |
| D3 | A run request names what to run by the instance's ids (an execution, a test case, a cluster, a run, a saved selection, a gap, a bug report) and a mode from a closed set. Never a path, a command line, an environment variable, a URL or code. Piwi Picker's worker reads what it needs from the instance with its own key; the target resolves the tests in its own workspace. | The rules that exist: Piwi Picker's worker never takes a project from a page; the editor service builds every command and takes none from the instance; a desktop job names commits, tests and lab conditions, never code. |
| D4 | The run hub gains one command, `start`, which hands the request to the run hub's own client: the IDE, or the desktop app's window. The client decides. A run of the workspace's tests as they stand (`run`, `debug`, `verify`, `impact`) asks the first time per instance and workspace, with **Run**, **Always for this workspace** and **Not now**. A job on a commit, and anything that writes a file, asks every time. | The pairing's token, which reads the run hubs' tokens, reaches the processes a run starts (a `webServer` keeps `PIWI_EDITOR_SEND`), and a holder of a run hub's token can already steer its runs and share them live with no prompt in the IDE. Starting a run must need more than a token. The IDE already asks before Debug in my editor runs, and the desktop app before a job runs. |
| D5 | The target checks that a request names the instance its workspace reports to, and the project that workspace reports as. Piwi Picker sends the origin of the instance it is connected to, and the project the instance names for the request. | A page of another instance must not start a run of this workspace. JetBrains' `OpenOrigins.kt` already makes this check for Open in IDE. |
| D6 | A start needs a person's action: the content script passes a `start` on only right after a click or a key press in the page that it heard itself as trusted (`isTrusted`), and one `start` per such event. | A script on a compromised page cannot start runs on its own. With **Always for this workspace** on, a person's click is the one thing between a page and a run. |
| D7 | The run's `PIWI_ORIGIN_REF` is the request's id (`dash-` and 16 hexadecimal characters), which Piwi Picker makes and returns to the page. `PIWI_ORIGIN` keeps the kind the target sets today (`editor`, `desktop`, `reproduce`, `bisect`, `flake-lab`). The page follows the run as the editor follows its own. | No new origin kind and no new route: `latest-run?origin&ref` and `/api/stream` already find a run by its ref, and run-control D10 and editor-local-runs D11 keep these runs out of notifications and pull-request feedback. |
| D8 | Where a request runs is chosen for the person and written on its button: the IDE window whose workspace reports to the page's project, else the paired desktop app for a job. When several windows do, the button's menu lists each, and the one used last for the project is remembered in this browser. The menu also lists CI, where the project dispatches re-runs, and **Copy the command**. | One verb per context and no setting to learn; the person always sees which program on which machine will run it. |
| D9 | The page learns which targets this browser reaches from the content script, for the page's project alone: each target's kind, its client's name (`VS Code`, `WebStorm`, the desktop app), the name of its workspace folder, the requests it takes, and the refs of the runs it has live. No token, no path, no address. | The buttons offer only what will work; the page learns nothing it could reuse. |
| D10 | A run shown in the page is shown by Piwi Picker: **Show it here** frames the Runs window for that run in the page, as an extension page, so a stop's image, its live view, its input and its controls pass between that frame and the worker, never through the page's scripts or the server. | The page can neither read a cross-origin frame nor press its buttons. The controls stay on the developer's own surface, as run-control D8 requires, and the frames stay on the machine unless the person shares the run live. |
| D11 | A job on a commit goes to the desktop app as the editor's desktop jobs do: Piwi Picker turns the request into the job the editor would send, from what it read with its own key; the window shows the job and runs nothing before the click there. Piwi Picker polls the verdict and records it on the instance with its key where the person's role allows the recording route (a bisect's `run:control`, a Flake Lab result's `run:submit`); otherwise the verdict shows on the page alone. The job's run stays in the app. | 1.0 D36 and D51: the app never holds the team's key. A key scoped to one run's upload would let the whole run reach the instance ([open question 3](#open-questions)). |
| D12 | The desktop window names the commit and the branch the instance recorded for the failing run, and says when that branch is a pull request's. | A job installs and runs the commit's own code, which for a pull request from a fork is that fork's. |
| D13 | No new permission. A request is offered to whoever may read the project, except where the instance's side asks for more today (a Flake Lab plan), which the page checks with `can()` before it offers it. Results reach the instance with the run's own credentials (`run:submit`), as today. | Running one's own tests on one's own machine changes nothing on the instance; what does change it keeps its permission. |
| D14 | Without a target, the page shows what it shows today: **Debug in my editor** through its link, the IDE asking each time; the copies; **Re-run in CI**. The link takes no other request. | A dead end costs the person the loop. A link cannot tell the page whether it was taken, and a `vscode://` link carries no origin the IDE can check. |

## Part 1: The run requests

`@piwitests/core/run-request` (MIT, beside `run-hub`) holds the types and one parser. The dashboard, Piwi Picker, the
editor service and the desktop app's server all read requests with it, and it refuses an unknown field or a value out
of bounds, field by field.

| Request | Names | What the target does | Targets | Asks |
| --- | --- | --- | --- | --- |
| `run` | `execution`, `testCase`, `run` (its failed tests), `cluster` (its affected tests) or `selection`; `headed`, `repeat` (1 to 100), `trace` | Resolves the tests (the instance's selection preview, for ids) and runs them as **Run this test** does | IDE; desktop app (as **Run locally**) | The first time per instance and workspace |
| `debug` | `execution` | What Debug in my editor does: the failing line as a breakpoint of that run alone, headed, one worker, the suggested locator counted and outlined at the stop | IDE | The first time |
| `verify` | `cluster` or `testCase` | The affected tests on the working tree with retries off, and `--repeat-each` for a test that was flaky | IDE | The first time |
| `impact` | the page's project | `piwi run impact --base <the project's default branch>` in the workspace | IDE | The first time |
| `reproduce` | `execution` or `cluster` | The desktop job: the failing commit in a throwaway worktree, and the tests at it | Desktop app | Every time |
| `bisect` | `cluster` | The desktop job: the last green and the failing commit, bisected in a worktree | Desktop app | Every time |
| `flake` | `testCase`; `kind`, `reproduce` or `verify` | The desktop job from the test's Flake Lab plan, or `piwi flake <id>` (`piwi flake verify <id>`) in the IDE's workspace | Desktop app; IDE | Every time in the app; the first time in the IDE |
| `apply-locator` | `execution`; the candidate's rank | Replaces the locator on the failing line with the healing panel's candidate, as `piwi/applyPick` does | IDE | Every time: the edit is shown first |
| `apply-patch` | `cluster` | Applies the diagnosis's validated patch as one edit | IDE | Every time |
| `write-test` | `gap` or `bugReport` | Writes a new spec from the gap's draft, or from the report's steps (`piwi codegen bug:<id> --fail`), and opens it | IDE | Every time |

A target reads what a request names through its own connection: the editor service through `src/piwi-client.ts`, with
its workspace's key. The desktop app gets its job from Piwi Picker, which builds it as the editor builds its jobs: the
execution's reproduce recipe (`GET /api/test-run-cases/:id/reproduce`), the cluster's bisect window, the test's Flake
Lab plan (`GET /api/test-cases/:id/flake-plan`). A request whose ids the target's key cannot read is refused with the
instance's answer.

## Part 2: The page and Piwi Picker

The content script on the instance's pages ([D2](#decisions)) keeps marking them, and adds a channel.

- **From the page**: `window.postMessage({ source: 'piwi-dashboard', type, id, … })` on the page's own window. The
  content script takes a message only when `event.source` is the page's window, on a page `isInstancePage` accepts,
  and reads it with the parser of [Part 1](#part-1-the-run-requests). The types are `targets`, `start` and `show`.
- **To the page**: `window.postMessage({ source: 'piwi-picker', type, id, … })`, with the types:
  - `targets`: the list of [D9](#decisions) for the page's project;
  - `started`: whether the target took the request, its ref and the target's name, or why not (refused by the person,
    not this workspace, no target, another instance);
  - `job`: a desktop job's state and verdict;
  - `ended`: a target went away.
- **The worker** checks the sender (the content script of a tab whose top URL is the connected instance's) and resolves
  the project from the ids through the instance, never from the page. It picks the target ([D8](#decisions)), sends it
  `start` and answers. The extension's guide gains the rules: the instance marker reads nothing from the page but these
  messages, makes no network call, and passes a `start` on only after a trusted action ([D6](#decisions)).

Firefox needs no `debugger` permission for any of it: the runs are the IDE's or the desktop app's. Its background page
may be suspended between messages; the worker connects to the run hubs again as a message comes, as it does for the Runs
window.

## Part 3: The run hub's `start`, and the targets

- **The command**: `{ type: 'start', id, request, instance }` on the run hub's WebSocket, after `hello`. The run hub
  answers at once that its client was asked, or why not. It tells the outcome later as `started` (`ref`, `ok`,
  `message`), and the run, once it starts, shows as any of the run hub's runs does: a `session`, and a run on the
  instance with its ref.
- **The folders' instances**: the `welcome` gains, for each workspace folder, the origin of the instance it reports
  to and its project, read from the service's contexts, so the worker can tell which window holds the page's project
  without a request.
- **In the editor service**: the run hub hands the request to the client through `piwi/startRequested`, a new request of
  `src/protocol.ts` changed in both clients at once. Before that, the service checks [D5](#decisions) against the
  context of the folder that holds the project, and refuses a request no context of the window can take.
- **In the IDE**: a notification names what will run and the instance that asked, with **Run**, **Always for this
  workspace** and **Not now**, or **Run** and **Not now** for a request that asks every time. **Always for this
  workspace** is kept per instance origin and workspace folder, listed in the extension's settings (VS Code) or under
  **Tools → Piwi** (JetBrains), and taken back there. A JetBrains project the IDE does not trust refuses, as it does for
  Debug in my editor. The run itself goes through the paths that exist: `piwi/runArgs`, and the debug run.
- **In the desktop app**: its server's run hub takes `start` for the jobs and passes each to the window as a repro
  request of the kind the editor sends (`reproduce`, `bisect`, `flake-lab`), with the instance's address for the
  window to show.

## Part 4: Following the run on the page

- The button that started a run becomes the run: its target, its tests' count, the step its worker is on as the run
  page shows it, then its outcome, then the action that comes next (Debug after a failed `run`, Verify after a passing
  `debug`).
- The page finds the run by `latest-run?origin=<kind>&ref=<ref>` and the `run-started` events of `/api/stream`, as
  `RunWatch` does in the editor service, and reads it through `GET /api/test-runs/:id/stream`. A run that never reaches
  this instance, because its workspace reports elsewhere or nowhere, says so on the button, from Piwi Picker's session
  of the run.
- A job's state comes from Piwi Picker (`job`, from its polling of the app): waiting for the click in the app's
  window, running, its verdict.
- **My runs on this machine**, in the navbar while one is live, lists the runs of the run hubs this browser reaches, for
  every project: what the popup's Runs tile counts today, each with **Show it here** and its run page.

## Part 5: Your run, shown in the page

- **Show it here**, on a run the page started or on any live run of a reachable run hub in the page's project, frames
  Piwi Picker's Runs window for that run alone: `runs.html` with the run's ref, listed in `web_accessible_resources`,
  with `use_dynamic_url` in Chrome.
- The worker takes the frame's port only from a frame whose tab's top URL is the connected instance's. The frame shows
  the run as the window does (its workers, a stop's image, Watch live, Pick on the image, the controls), with the same
  code.
- On the developer's own browser, a running row of that run offers **Show it here** where it says **Not shared live**
  today; anyone else keeps reading **Not shared live** (#959) until the developer shares the run, from the frame as
  from the window.
- Until this part ships, **Show it here** opens the Runs window beside the page, focused on the run, as the popup's
  Runs tile opens it: no manifest change.

## Part 6: The actions, page by page

| Page | Today | With this plan |
| --- | --- | --- |
| A failure's execution | Debug in my editor (the link); copy the retry command; the reproduce recipe | **Debug on my machine**; **Run on my machine**; **Reproduce at** the failing commit |
| A failure cluster | Copy the recipe, the patch, the locator; **Re-run in CI** | **Debug on my machine**; **Reproduce at** the commit; **Find the breaking commit**; **Verify on my machine**; **Apply the patch in my editor** |
| A run | Copy the retry command | **Run the failed tests on my machine** |
| A test case's Flakiness tab | Copy `piwi flake`; Reproduce or Verify in CI | **Flake Lab on my machine** (reproduce, verify) |
| The locator healing panel | Copy a candidate; pick on the snapshot | **Apply in my editor** |
| Saved selections | Copy the command | **Run on my machine** |
| A project | | **Run what my change affects** |
| A Test Map gap | Its draft | **Write this test in my editor** |
| A bug report | The Spec tab; Run with Playwright, from Piwi Picker | **Make it a failing test in my editor**; **Run it** |

Each action is offered where the page's Next logic offers its copy today (`shared/next-step.ts`,
`useNextStepActions`), the copy kept in its menu, and only to a person who may take it ([D13](#decisions)).

## Part 7: Later

- **Try a locator before writing it.** Debug on my machine already counts the suggested locator on the stopped page.
  Trying it means running the rest of the test with it: the capture fixtures' locator proxy, which sees every locator a
  test makes, would swap the chain at one call site for that run alone, read with `@piwitests/core/locator-chain`, and
  the run would say so on the test. It is a new side effect of the reporter (its contract 3), so it is a decision of
  its own.
- **CI as a target for any test.** CI re-run dispatches a cluster's tests and a test's Flake Lab. A run's failed tests,
  a test case and a saved selection could go through the same dispatch, under `run:control`.
- **Local evidence on a cluster.** The runs that reproduced a cluster at its failing commit (origin `reproduce`, the
  cluster as ref) could become a clue: a failure that passes on two machines at its failing commit and fails in CI
  points at the environment.

## With or without the rest

| Setup | What the dashboard offers |
| --- | --- |
| No Piwi Picker | Today's actions: Debug in my editor through its link, the copies, **Re-run in CI** |
| Piwi Picker connected, nothing paired | The same, and **Pair an editor** where a target would be |
| An IDE paired | **Run**, **Debug**, **Verify**, **Run what my change affects**, **Apply**, **Write this test**; the run reported to the instance the workspace reports to, followed on the page and shown in it |
| The desktop app paired | **Reproduce at**, **Find the breaking commit** and **Flake Lab** at a commit, confirmed in its window; the verdict recorded on the instance by Piwi Picker |
| Both | Each request goes to the target that takes it ([D8](#decisions)) |

## Delivery

Each PR is usable on its own; sizes are relative (S, M, L).

| PR | Content | Size |
| --- | --- | --- |
| 1 | `@piwitests/core/run-request`; the content script's channel and the worker's routing; the run hub's `start` and the folders' instances in `welcome`; `piwi/startRequested` and both IDE clients' prompt and **Always for this workspace**; `run` and `debug`; on the dashboard, the targets, **Debug on my machine** and **Run on my machine** on the execution, run and test case pages, the button following its run ([Part 4](#part-4-following-the-run-on-the-page)), **Show it here** opening the Runs window | L |
| 2 | `verify` and `impact`; the cluster and project pages; **My runs on this machine** | M |
| 3 | The desktop app's jobs from the page: `reproduce`, `bisect` and `flake`, with their verdicts recorded by Piwi Picker | M |
| 4 | The Runs window framed in the page ([Part 5](#part-5-your-run-shown-in-the-page)) | M |
| 5 | `apply-locator` and `apply-patch` | M |
| 6 | `write-test`, from gaps and bug reports | M |
| 7 | [Part 7](#part-7-later), each item as a decision of its own | |

Each PR updates the docs it changes in the same commit: a feature page for runs from the dashboard, the pages of
Debug in my editor, the Runs window, the desktop app and Piwi Picker's connection, and the guides whose rules change
(the extension's instance marker, the editor service's run hub, the dashboard's rule on Debug in my editor).

## Verification

- **Core**: the parser of [Part 1](#part-1-the-run-requests), each field and each refusal; the shape of the `targets`
  answer.
- **Extension**: an e2e spec on a stub instance page: the targets for the page's project; `start` after a trusted click
  and without one; a page on another origin, a message from another frame, and a request naming a project the key
  cannot read, each refused; the framed Runs window refused in a tab of another origin.
- **Editor service**: `start` handed to the client; [D5](#decisions) refusing another instance or project; the
  request's ref on the run; **Always for this workspace** kept per instance and folder.
- **IDE clients**: the prompt, and the choice kept and taken back (the VS Code integration suite, a JetBrains platform
  test).
- **Desktop app**: a job from the run hub's `start`, shown in the window and run only on its click, naming a pull
  request's branch ([D12](#decisions)).
- **Dashboard**: the buttons from a stubbed `targets` answer; a seeded run found by its ref; the fallbacks of
  [D14](#decisions). The demo shows the page as a browser without Piwi Picker sees it.
- **By hand**: VS Code and WebStorm, Chrome and Firefox, a team instance with authentication on, and an IDE window that
  reports to another instance.

## Risks

- **A compromised instance page** can ask its viewers' machines for runs of their own tests, within D3 to D6: ids
  alone, a trusted action for each, and the IDE's prompt or the person's earlier **Always for this workspace**. It can
  never start a job on a commit or a write without the person's click in the IDE or the desktop window.
- **Always for this workspace** lets one click on the dashboard start a run. A page script that waits for any click of
  the person can start one run of the workspace's tests for each click ([D6](#decisions) checks that a person acted,
  not on which button); the IDE shows each run as it starts.
- **The targets answer** tells the page which IDE and which folder name the person has open, and the instance's
  server could collect them.
- **Two IDE windows on one project**, such as two worktrees: the button names the one used last, and its menu lists
  the other ([D8](#decisions)).
- **The framed Runs window** makes an extension page loadable by any site. With `use_dynamic_url` its address changes
  every session in Chrome, and the worker refuses a frame outside the instance's tab.
- **A desktop job's run stays in the app**: the team sees its verdict alone, until open question 3 is decided.
- **The MV3 worker** must stay alive while a request waits on the IDE's prompt; the run hub's keepalive covers an open
  connection.

## Open questions

1. **Always for this workspace**: offer it for runs of the workspace's tests as they stand, or ask every time?
   Recommendation: offer it; a job on a commit and a write ask every time whatever the choice.
2. **A route without Piwi Picker**: the editor service already follows the instance's event stream with its
   workspace's key, so the instance could pass a person's own requests to that person's connected IDEs. It would serve
   a browser without Piwi Picker, a phone, and Codespaces in a browser, where no run hub is listed. But the server would
   send the requests, so the IDE would ask every time and [D6](#decisions) would not hold. Recommendation: not before
   the rest has been used.
3. **A desktop job's whole run on the team instance**, through an upload key the instance makes for one run (the shape
   [`remote-browsers.md`](remote-browsers.md) D6 proposes for grids), given to the job by Piwi Picker; or the verdict
   alone. Recommendation: the verdict alone first.
4. **Jobs on a commit in the editor service** (its own worktrees), so that an IDE alone can reproduce and bisect; or in
   the desktop app alone, as today. Recommendation: the desktop app alone until people ask.
5. **Who is on it**: say on a cluster that a teammate's run is reproducing it now, from that run's ref. It keeps two
   people from debugging one failure, and it shows a person's activity. Recommendation: off, turned on per project.

## Not in this plan

- **Running tests on the instance, or on a runner Piwi provides** ([D1](#decisions)): CI is the team's runner.
- **Starting or steering a run on another person's machine.**
- **A command line, an environment variable, a URL or code from a page** ([D3](#decisions)).
- **The developer's everyday browser as the test's browser**, for the reason [`run-control.md`](../adr/run-control.md)
  gives.
- **The desktop app's window showing the team instance**: the unmerged record named in the Status. The run requests of
  [Part 1](#part-1-the-run-requests) would serve it too.

## Defects found while researching this plan

1. **The desktop app's token can go to another server.** Reproduce, bisect and Flake Lab runs set `PIWI_DASHBOARD_URL`
   and `PIWI_API_KEY` to the app's own (`flake_lab_env` in `apps/desktop/src-tauri/src/worktree.rs`), but the reporter
   takes each from the environment only when the Playwright config leaves it unset (`ENV_FALLBACK_SPECS` and
   `resolveOptions` in `packages/reporter/src/internal/config/env.ts`). A config that names `serverUrl` and reads its
   key from the environment reports such a run to its own server with the app's token: the run reaches neither, against
   `flake_lab_env`'s comment, and the token goes to that server. Found by reading the code; not reproduced.
2. **Re-run in CI shows to people who cannot use it.** The execution page shows it whenever the cluster can be re-run
   (the `verify` section of `app/pages/test-run-cases/[id].vue`), and the Next row offers **Re-run in CI**, **Reproduce
   in CI** and **Verify in CI** the same way (`shared/next-step.ts`), without the viewer's `run:control`; the server
   then answers 403. The cluster page's menu checks `can('run:control', …)`.
3. **"Hub" names two things in the user docs**: a node most tests reach, in the Test Map (`guide/concepts.md`, the
   only definition), and the process that holds a run's controls (`features/desktop-runs.md`,
   `guide/remote-development.md`).
4. [`remote-browsers.md`](remote-browsers.md) says run-control's live view is proposed and not built; it shipped on
   2026-10-28.
