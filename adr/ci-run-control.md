# Holding and pausing a CI test from anywhere

- Status: accepted
- Date: 2026-11-21

A test running in CI can be watched from the run page, the editors and Piwi Picker's Runs window, and its page
inspected at each call ([`features/live-view`](../apps/docs/features/live-view.md),
[`features/live-inspect`](../apps/docs/features/live-inspect.md)), but nothing makes it wait: a failure is gone a
second after it happens, and a test that waits on an element goes on past the moment worth seeing. This plan lets the
people who may already re-run a project's CI make a CI test wait where they can look at it: first held at its failure,
then paused at its next call, from any surface that watches it. It narrows one decision of the
[run control ADR](run-control.md) (D8, "the team instance never steers a run") for these two cases, and says how
far.

**Status.** Built: all five Delivery PRs, accepted 2026-11-21. Step 1 is built on the run page (Delivery PR 2): the project setting, `hold` and
`controller` on the CI worker's stream, the held stop and **Let it go** in the lane panel, the demo's Held CI failure
and the page [Hold a failing CI test](../apps/docs/features/hold-ci-failure.md); the run control ADR's D8 links here
(D10). Step 1 is built on the editors' worker view and the Runs window too (Delivery PR 3): the instance tells a
controller's watch it counts as one (`hello`'s `controller`), and VS Code's worker panel, the JetBrains **Worker** tab
and the Runs window show the hold in the run page's words (`@piwitests/run-model/ci`) and offer **Let it go** on that
watch. Step 2 is built on the run page (Delivery PR 4): the second setting, `pause` beside `hold` on the CI worker's
stream and the call log through instrumentation while it is on, **Pause**, **Resume** and **End the test** in the lane
panel of a CI lane (one route, `POST /api/test-runs/:id/live-view/control`), the paused stop read as
`Paused by Ana · until 12:05`, the demo's paused CI lane and the page [Pause a CI test](../apps/docs/features/pause-ci-test.md).
Step 2 is built on the editors' worker view and the Runs window too (Delivery PR 5): the editor service sends each
CI lane's paused test, its Pause asked or dropped and the controls its watch offers as a controller's in the run page's
words, VS Code's worker panel and the JetBrains **Worker** tab show them and send `piwi/ciControl` with the command, and
the Runs window does the same through its own connection, each asking one control in each state of the lane. Every
surface says what reaches a CI run from it: nothing but the controls of a CI test held or paused for you. Nothing was
left out. Step 1 takes over Part 8 of
[`live-view-next.md`](../proposals/live-view-next.md) (its D11 and open questions 3 and 4), which now points here.

**Summary.**

- **Step 1, hold a failing CI test.** With the project's setting on, a CI test that fails while someone who may
  control the project's runs watches its lane waits at its failure, for the project's length (five minutes by
  default), so its viewers can inspect the page as it failed. **Let it go** ends it.
- **Step 2, pause a CI test.** With a second setting on, the same people may pause a watched CI test at its next call,
  resume it and end it, from the run page, the editors' worker view and the Runs window, as they do a local run's.
- **Never**: input into a CI page, code run in it, a connection to the CI machine, or a run held by someone not allowed
  to re-run it.

Of the five jobs [`ROADMAP.md`](../ROADMAP.md) says Piwi is for, this serves the second, **explain the failures**, and
feeds the third, **hand back a fix**: Inspect's picker on the page where the test failed or waits.

## Terms

- **Hold**: a failed CI test waiting at its failure, its page and browser open, before its fixtures tear down.
- **Pause**: a running CI test waiting before its next call, as a local run's **Pause** makes it.
- **Controller**: a person, or a connection's identity, with the `run:control` permission on the run's project
  (Maintainer and Project admin: [roles](../apps/docs/operate/project-access.md#what-each-role-can-do)), watching the
  lane.
- **Lane**, **watch**, **stop**: as the [live-runs ADR](live-runs.md#terms) defines them.

## What exists

- **The CI worker's stream.** With the live view on, each CI worker opens one event stream to the instance before its
  first test, with the run's live view key (`packages/reporter/src/internal/capture/live-view.ts`). On it the instance
  says how many people watch the worker and at what size (`view`), the project's masks (`masks`), and what to resend
  (`resend`); the worker posts its images, call log, layers and stops (`stop`) back. The worker opens the connection;
  nothing listens on the CI machine.
- **Who watches.** The run page, the editors' worker view of a CI lane and the Runs window all watch through the
  instance's one watch of the run (live-runs P10), with the viewer's own sign-in or connection, so the instance knows
  who each viewer is and what they may do.
- **Local holds and pauses.** A local run holds a failing test for whoever watches it when its **Hold failures** is on
  (live-runs P6, `hold {on, by}` on the hub's session), and pauses, resumes and ends a test through the hub
  (`pause-at.ts`, the run channel's commands). Both suspend the test's timeout while it waits.
- **Where the call log comes from.** In a CI run that nothing pauses, the worker follows Playwright's own log stream,
  which moves where Playwright's debugger stops; a run something may pause follows Playwright's instrumentation instead
  (`live-view.ts`, `mayPause`).
- **D8.** The hub listens only for its paired clients; the team instance never steers a run. The CI live view takes no
  input, and **Inspect**'s picker copies a locator, nothing more.

## Decisions

| | Decision | Why |
| --- | --- | --- |
| D1 | **Two project settings, both off by default**, in **Project → Settings → Live view**: **Hold a failing CI test for its controllers** (step 1) and **Let controllers pause a CI test** (step 2, which needs step 1's on). A Project admin (`project:manage`) turns them on and sets one length for both: one to fifteen minutes, five by default. | A wait costs CI minutes and can make a job time out; a team chooses it. One length keeps the rule one sentence. |
| D2 | **Only a controller holds or pauses**: `run:control`, the permission that already re-runs a project's CI, bisects and runs Flake Lab. A Viewer or Contributor watching sees the hold or the pause, never makes one. | Answers live-view-next's open question 3. Stalling CI is in the power of whoever may re-run it; nobody else gains it. |
| D3 | **A hold needs a controller watching the lane in full as its test fails**, on any surface: the run page, an editor's worker view of the lane, the Runs window. Tiles of **Watch all** do not count. It ends at the length, at **Let it go**, as the last controller stops watching, or as the CI job ends. | A failure nobody looks at gains nothing from waiting. The surfaces all watch through the instance, so "from anywhere" is one rule. |
| D4 | **A pause is asked, never automatic**: **Pause** (at the next call), **Resume**, **End the test**, and **Let it go** at a hold: a closed set of four commands, the words and controls of a local run's ([`packages/run-model`](../packages/run-model/AGENTS.md)). A pause ends like a hold (D3's four ends). | The same controls everywhere, already learnt; nothing a local run cannot do. |
| D5 | **The instance decides, the worker obeys only its own stream.** A command reaches the instance from a signed-in viewer; the instance checks the setting, `run:control` and that the viewer watches the lane, records who asked, and sends it on that worker's stream. The worker accepts the four commands only on the stream it opened with the run's key, and only when the stream's opening said the project's setting is on. | Nothing new listens on the CI machine; the instance is already the one party both sides trust. A worker whose project has the setting off ignores a command even from a buggy or older instance. |
| D6 | **No input, no code, no new reach**: the page takes no click, key or text from a viewer; nothing is evaluated in it; **Inspect** and its picker stay read-only. | D8's reason: the CI page may be signed in to real systems with real secrets. A wait shows it; it never drives it. |
| D7 | **The test's timeout stops while it waits; the CI job's does not.** The worker suspends the test's timeout for a hold or a pause, as a local run does; the CI job's own timeout still runs, and the run page says so beside the hold. | Playwright's timeout would fail the wait itself; the job's timeout is CI's, which the worker cannot read or change. |
| D8 | **With step 2 on, a CI worker follows the call log through Playwright's instrumentation**, as a run that may pause does. | Playwright's log stream moves where its debugger stops, which a pause relies on. |
| D9 | **Who held or paused is said, not stored**: the run page, the editors and the Runs window show `Held for Ana · until 12:05` / `Paused by Ana`, and the instance logs each command (run, worker, command, user) at info level. No audit table. | The people watching need to know; a stored audit trail is a plan of its own, for every action of the instance. |
| D10 | **D8 is narrowed, not superseded.** The run control ADR keeps D8 and gains one line linking here: "narrowed for a hold and a pause of a CI test, behind a project setting (ci-run-control D1 to D6)". This plan becomes an ADR that says the same. | Answers live-view-next's open question 4: `adr/` supersedes a whole record; a narrowed decision is a link both ways. |

## Step 1: Hold a failing CI test

- **The setting** (D1) goes out on each CI worker's stream as it opens, with the masks: `hold: { ms }` or nothing.
- **The watch.** The instance already tells a worker how many watch it; it adds whether a controller watches it in full
  (`view`'s `controller`). A viewer's surface says nothing new: the instance knows who signed in.
- **The failure.** As a test fails with `hold` on and a controller watching, the worker holds it as a local run's
  **Hold failures** does: before teardown, the page open, the test's timeout suspended (D7), and posts a `stop` of kind
  `held` with its end time. The instance relays it to every viewer: the row and the lane panel read **Failed, held at
  its line · Held for Ana until 12:05**, with the error, **Inspect** on the failing page, its page events and text, and
  **Let it go** for a controller.
- **The end.** The worker ends the hold at its length, at **Let it go** (D5), as the instance says no controller
  watches any more, or as its stream closes for good; the test then tears down as it would have, its result unchanged.
- **The surfaces.** The run page's lane panel; the editors' worker view of a CI lane (VS Code's worker panel, the
  JetBrains **Worker** tab), which today has no controls for a CI lane; the Runs window's CI worker tab. Each shows the
  hold and, to a controller, **Let it go**.
- **The demo** plays a held CI failure on its simulator, as it plays the breakpoint scenario.

## Step 2: Pause a CI test

- **The setting** goes out on the stream as `pause: true` beside `hold`; with it, the worker follows the call log
  through Playwright's instrumentation (D8).
- **Pause** reaches the worker on its stream (D5); the test waits before its next call, its timeout suspended, and
  posts a `stop` of kind `pause`. **Resume** goes on; **End the test** ends it as failed with the local run's reason; a
  pause also ends at the length and as the last controller leaves (D3), each saying why.
- **The surfaces** are those of step 1, with the local run's controls for a CI lane, shown to a controller only, and
  the reason for any refusal as a local run's refusal says it ("The project's setting is off", "You may watch this run,
  not control it").
- **What stays out**: **Interact**, the picker acting on the page, **Show the browser**, **Stop the run** (cancelling a
  CI job belongs to CI), and agents (`get_live_test`, live-view-next Part 6, may later carry these commands for an
  agent acting for a controller).

## Security

- **Reach**: unchanged. The CI worker opens its stream to the instance as today; nothing listens on the CI machine;
  the instance relays four commands, never input or code (D6).
- **Who**: a controller only (D2), checked by the instance on each command (D5); the worker refuses commands while its
  project's setting is off.
- **Cost**: a held or paused test holds its CI job's minutes and runner for the project's length at most each time,
  fifteen minutes at the most, and the job's own timeout still applies (D7).
- **Seen**: the same masked images, call log, layers and **Inspect** as watching today; a hold shows nothing a watched
  failure would not have shown for a second.

## Delivery

Each PR is usable on its own; sizes are relative (S, M).

| PR | Content | Size |
| --- | --- | --- |
| 1 | This plan, and live-view-next Part 8 pointing here. | S |
| 2 | Step 1: the setting, `hold` on the stream, `controller` in `view`, the held stop, **Let it go**, on the run page; the docs page **Hold a failing CI test**; the demo; the run control ADR's line (D10). | M |
| 3 | Step 1 on the editors' worker view and the Runs window. | M |
| 4 | Step 2: the setting, the four commands on the run page, the call log through instrumentation when it is on. | M |
| 5 | Step 2 on the editors' worker view and the Runs window. | M |

## Verification

- **The reporter**, against a fake instance, as `tests/live-view*.spec.ts` do: a failing test held only with the
  setting on and a controller watching; let go at its length, at **Let it go**, as the last controller leaves and as
  the stream closes; its result unchanged; a command refused with the setting off; a pause, resume and end.
- **The app**: the commands' route refusing a Viewer, a Contributor and a project with the setting off; an E2E test of
  the run page with a simulated worker held, let go and paused; the editors' and the Runs window's tests of the CI
  lane's controls.

## Risks

- **CI minutes and job timeouts**: bounded by the length (D1) and by D3's ends; a job that times out during a hold
  fails as it would have, later.
- **A worker on an older reporter** ignores `hold` and `pause`: the surfaces offer neither for a worker that did not
  say it can (the stream's opening names the features the worker has).
- **A controller who leaves without letting go**: the hold ends as the last controller stops watching (D3).

## Open questions

1. **Several workers**: should a hold in one lane hold the others, as `--max-failures` stops them? This plan holds one
   lane; the others go on.
2. **The length**: is fifteen minutes the right ceiling, and should a controller extend a hold once?

## Not in this plan

- **Input into a CI page, remote DevTools, VNC**: D6, and live-view-next's
  [Not in this plan](../proposals/live-view-next.md#not-in-this-plan).
- **Holding a CI run nobody watches**, as a CI variable might ask: a wait nobody looks at only costs minutes.
- **A stored audit trail** (D9).
