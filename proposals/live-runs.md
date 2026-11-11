# Live runs across the tools

An analysis of how a running Playwright run is followed and watched in every Piwi tool, and a plan to make it one
experience. A run can start from a terminal, CI, VS Code, a JetBrains IDE, the desktop app or a coding agent, and be
watched from the dashboard's run page, the editor, Piwi Picker's Runs window, the desktop app's tray, an agent's MCP
tools and the terminal itself. Each of those works on its own. Together they do not feel like one tool: a view ends at
every test, your own running test cannot be seen without broadcasting it to the team, each tool calls the same run and
worker by its own name, and a few ordinary conditions break the live page without a word. This plan names what breaks,
proposes one model of a live run that every tool renders, and adds ways to watch a test besides its pixels.

**Status.** Proposed 2026-11-05, against `main` at v0.66.0 (`e82b429f`). Built from P0: the connection budget of
#1106. One tab of the browser holds the notification stream, through a lease in `localStorage` (Web Locks exist only
on secure origins, and the limit bites on plain HTTP), and that stream opens at once with a comment. A run page or a
live view whose stream has not opened within 5 s, or within 10 s of a drop, says so, with **Retry** on the run page,
which opens a new stream without refetching the run; a run page whose own stream is not open when its run ends hears
the end on the instance's stream. A list whose first connection opens after a run event it missed
(`/api/stream` says when the last went out, read against the server's render time) refreshes once hydrated. The
execution page closes its stream while its tab is hidden, and reads the execution again when shown. The run page keeps its stream while hidden, since its tab
shows the run's progress; carrying the run's and the view's streams on one connection is left until a measurement asks
for it. Built from P0's live steps (the first items of #1107): the reporter brings its first heartbeat
forward once the dashboard first says nobody watches, and sends the steps its tests are in at once when someone
opens the run, in one request; step events name their shard, and the run page files each step by shard and worker;
the instance keeps each worker's latest step until its test completes, or until it tells that worker's reporter
nobody watches, and replays it to whoever opens the run later; the demo keeps them the same way. `parallelIndex` and
the retry on step events come with P1, which reads them. Built from P0's step hygiene: Piwi's own fixtures
(`piwiCapture`, `piwiResources`) and the steps inside them stay out of the stream, `test.step` streams, the live view's
caption names its call with the call's target, and a run's Tests tab says **Global setup** (then **Starting N tests**
while the page hears the run) with the time since the run began, until its first test. A `test.step` streams as a step
of its own, not as the parent of the calls inside it. The caption following the worker's step on a still page waits
for P1, where an image carries the worker's time to compare it with the step's. Built from P1's list that holds still
(the rest of #1107): `test-begin` carries the attempt, the retries allowed, the tags, the locks and the metadata, and
`test-completed` the last three, so a retry reads **Retry 1 of 2** while it runs, unlinked, the attempt it followed
keeps its bar on the timeline, and the search's qualifiers find a row that streamed in; the grouping is decided once
per page view and the list follows the newest row only in run order. Built from P1's watch of a lane: a worker
sends its lane (`parallelIndex`), and how its test ended; a view opened on it follows the lane through its next tests and
the worker Playwright starts in it again, waiting 30 s for it, says how each test ended, and **Follow the worker's next
test** off keeps it to its test, and a view hidden for 10 minutes closes; the view, the rows and the Timeline name a
worker by its lane from 1. Built from the rest of P1: **Watch** sits at each row's end and opens the view docked
beside the run page (a sheet below 1024 px), resizable, full screen, with a click to zoom and **Zoom to the element**;
the view lists the lane's earlier tests, keeps a failed call's error with its outcome and says the run's verdict as the
run ends; `?watch=<shard>.<worker>` opens it and names the lane while it is open, and `test.stuck` links to it; a
view that does not open says why; the reporter sends each test's lane, which the dashboard stores, so the Timeline
places each worker on its real lane and every MCP tool says `worker: N`;
the header's primary action is decided once the run has ended; frames carry the worker's time, so the caption names
the step begun after the image. Built from P2: the reporter asks again for a `/begin` or `/start` that got no answer, a
server error, a 408 or a 429, with backoff for the run's life, keeps the run's events meanwhile within
`maxStreamBufferBytes`, sends them once the stream opens and says once how late it started; a CI run's log says the
live view is on for the specs that use Piwi's fixtures and names the first spec file that runs without them; a run
without a key names its real cause (`streaming: false`, a global setup that did not run, an instance that did not
take its registration, with its error, or the setting off), outside CI in `PIWI_LIVE_VIEW` too; and `merge-reports`
says nothing of the live view. A CI worker's live view retries every 30 to 60 s for the run's life after its fast
retries, its count reset by a steady stream, and the run's log says once when it is lost and once when it is back,
relayed through the global setup's process; each key's digest is stored with its run, so a restarted instance takes a
running run's key back, and the setting turned off and on again; **Share live** works again after either; a Project
admin turns the live view on from a running run's status, which then says it starts with the next run. P2 is built;
its run links stay with P5. Built from P3's notification of #1109: a run whose workers connect to a hub's run channel
says so at `/begin` (or `/start`) as `piwiInteractive: { client, ref }` in its metadata, beside `piwiOrigin` (the
client is the editor's name from its discovery file, else the launcher `PIWI_ORIGIN` names), so its later requests
carry it too; its `test.stuck` follows the `stuck-notifications` use, which sends none for any run started on a
developer's machine. Its long test is still marked **Stuck?**, until Stuck? reads stop state. Built from the rest of P3: an unknown worker state reads as `other` and an unreadable worker or `live` is left out, the run kept; `welcome` and
the desktop app's live answer list a hub's `features` (`peers`); each hub names the other live hubs of
`~/.piwi/editors` to its subscribed connections, without their tokens, and the Runs window asks the paired editor
again for one it holds no token for, and every minute while it is open; a VS Code window takes the pairing port once
the window holding it closes; a lost hub's runs stay grayed, as last heard, and Watch live, kept by run and slot,
starts again once it answers; the Runs window says how each paired tool stands, retries an unproven pairing four
times on its backoff, then once a minute while it is open, reads a proofless 404 as no editor, and frees a command's buttons after 25 s; the popup keeps a muted Runs tile
while a paired tool does not answer; and the local live view and stop image are masked as the team's, the image at
CSS scale and of the viewport's shape, every call's and stop's title through `hideTypedText`, the pause bar's and the
terminal's included; the pause bar's band is painted over in every frame of a headed stop's lane view, in the
same pass, a viewer's press on it not played, and while a viewer's keys play the bar is inert and leaves Escape to
the page.
In the desktop app, a client plugin holds the hub stream from the window's start, through the TV layout and again after
a reload while the hub says runs go on (`hub-runs`); stopping a local run takes its own progress alone off the OS bar;
and a bisect's, a reproduction's or a Flake Lab's steps flash nothing, the job's verdict once. P3 is built;
the tray's own runs and its Hold failures choices are still lost on a reload, and its separate output windows still
close with it. Built from P4: a worker keeps one live view of its lane's page (`lane-feed.ts`: the running test's page,
the stop's while it stands at one), which the editor's stop view, its lane view and the instance's live view share,
each at its own pace, masked once with every sink's masks; `run-attach` lists `view-lane` in a new `features`, `takes`
being at its 16 entries. A hub whose `welcome` lists `lanes` takes `watch` on a lane and sends its `lane-frame`s to its
viewers alone, through its tests, its stops and the worker Playwright starts in its place; at a stop of the running
test a viewer of the lane drives it as that stop's viewer, and an older reporter is told to update. Piwi Picker's Runs
window offers **Watch** and **Pause and watch** on a running worker, keeps the last image dimmed across a Step, a
Resume and between tests, brings a watched lane that stops into view with its controls above the image, and holds
Pick, Record and Assert with **Watch to use** at a headless stop nobody watches; the desktop app watches its own
running rows the same way, from the run page's rows and the tray. The run's own process (the reporter's main process)
connects to the hub on its own line (`run-begin`, `run-progress`, `run-end`), so the editors' status bars and the Runs
window say `3 of 9`, and the Runs window how a run ended. `piwi/laneView` gives the editors a lane: VS Code's **Piwi: worker N** watches
it running or stopped, with Interact at its stops, and JetBrains' **Worker N** tab watches it. While a Pause waits for
the call a test runs, the worker says which (`waiting`, from a reporter that lists `give-up` in its `features`), and the
editors' status bars and lane views, the Runs window and the desktop app's tray say it with how long it has run, and
offer **End the test** there (`give-up`): a locator call is given up through its end signal, and after any other call
the test is skipped at its next locator call. In both editors, a new stop takes the focus only while no other held
stop's file is open or on the worker slot the person is on, a slot only watched in a lane view not counting, and the
paused page keeps its stop while held, waiting 10 s at most for a slot stepped from the editor. The Windows
thumbnail's Open restores a minimized window, and its Stop is disabled while no local run runs. P4's showcase beat is
not built yet. Built from P5's run name and link: every run outside CI records a `piwiRunRef` (`PIWI_RUN_REF`, else an
editor's `PIWI_ORIGIN_REF`, else `local-<pid>-<time>`); `/setup`, `/start`, `/begin`, `/finish` and the batch routes
answer `runUrl` under `PIWI_SITE_URL` when it is set, which the reporter prints (`View live progress`), writes to its
output and leads its failure links under, falling back to the address it reached; a run outside CI tells each stop as
text through a private file its workers append to (`PIWI_STOP_NOTES`), as `test-stopped` and `test-resumed` with the
stop's reason, call, place, start and the time stood stopped, whoever watches (the stuck check reads them, so they
do not travel like live steps, D7); the instance keeps the stop on the running test for a page that opens later, rows
word it by reason in one set of words (`stop-words.ts`) with how long it has stood, Stuck? leaves the stopped time out
and never marks a test while it stands stopped (#1109), and the header names the origin and the steering tool. The
demo plays it as **Stopped at a breakpoint**. Built from the rest of P5: the reporter's own process names the run's
page to its hub once it knows it (`run-page`: from the global setup, else as its stream opens), which the hub keeps
and passes on (`HubSession.page`); the Runs window shows **Run #78 · Open · Copy link** while the run goes and after
it ended, VS Code's run-control item `#78 · 3 of 9` and **Piwi: Open the run page**, both status bars **Open run #78
(running)** first while your run goes and your own run whichever config the file belongs to, JetBrains' item its
progress beside a stop or a share, and the desktop app **Run #78 · Open** under each hub run (a team instance's run
request's included) and **Open run #78** in the tray; **Debug in my editor** names the run (a `ref` the editor service
checks) and follows it, "Following run #81 in VS Code · Open". A requested run is named by its request's id. The
terminal's start line is the run's page, the plumbing lines at `PIWI_VERBOSE`, a piped run an editor would have
followed says why it does not, and the stop line says why the test stopped and names the editor that steers it
(`workerHost`). One set of stop words (D6) holds the dashboard, both editors, Piwi Picker and the terminal together
(`stop-words-drift.test.ts`), and the docs gain a **Live runs** glossary and a **Watch a run** page. VS Code's Testing
view and status bar name a CI run of the branch so (`LiveRun.ci`), its tests never shown running as yours. The hub
names a stop's line where it stands after an edit (`lineNow`), the "did not reach the instance" notice tells a reporter
that ran from a missing one (`heardFrom`), and a pick on an image says "sent" only when an editor took it, else offers
**Copy**. Left of P5: Piwi Runner links no run page (it has no hub to hear `run-page`), the desktop app's run end still
leads to the run rather than its failure and its runs reach Piwi Picker without their command, the Runs window still
words the desktop app's failures as the editor's, the desktop tray counts a run's output lines rather than the run's
own progress, **Watch** and **Watch live** still name one view twice, and Stop sharing is still one click. From P6,
D12's split: **Hold failures** is each run's own (`hold {on, by}` on the hub's session, `piwi/holdRun`, the hub's
command `hold`, `run_follow`'s `hold`), on from the start of a run built to be watched, set from the editors, the Runs
window, the desktop tray and by agents; the hub's `follow` holds nothing, so an open Runs window no longer holds every
failure (RW19). Then presence and one driver: the hub's feature `presence` names who has each run open (Runs windows
that follow the runs, the desktop app's window, an agent following the run), who watches each worker's page and who
drives each stop (`presence`, `watchers`, `driver`, each connection's own marked `self`); the agent drives a stop it
asked for or acted on, a person's input, pick, intent or `drive` takes it, the agent hears `taken` and is refused
while a person drives; every surface shows it, and the Runs window labels the agent's stops (IO7, RW24). Then the
editors' start options: **Run headed** and **Hold failures** chosen for every run of an editor window (`RunStartOptions`,
VS Code's and the JetBrains plugin's settings and toggles), so a rerun starts the same way (E11); whether a breakpoint
the run cannot reach (application code) should leave it headless stays open (E10), since no file rule tells it apart
from a page object reliably. Then the desktop app's start options: **Hold failures** set where a run starts (the run
button's menu, **Run with options…**, a project's defaults) and kept by **Run again**, and a repeated run that offers
**Stop at the first failing repetition** (`--max-failures=1`), which a person attends, so it can hold that failure;
the test page's **Run this test** stops at it (DK3 in part, DK4). Watch live still resets with each run. Then **Show
the browser** at a stop of a headed run, on every surface: the worker brings the stopped page's window to the front
(`front`, a feature of the run channel and an action of the hub, `piwi/stopAction` `front`, `RunWorker.showsWindow`),
as far as the system lets a window come forward (E18). Then the Runs window's own controls: **Pause all** and **Resume
all** for a run of several workers (RW8 in part), Resume, Step and Finish on `F8`, `F10` and `Shift+F11` for the test
whose row holds the focus (RW17), the window opened where the person left it (RW16), and the run shortcut leaving a
run nobody attends alone, with its sign on the toolbar badge, and **Look again** saying it looks (RW22). Then **Stop
the run** in the Runs window, for a run an editor or the desktop app started (the rest of RW8): the hub's `stop` (its
feature `stop`), carried out as each tool's own Stop does, the editor through its client (`piwi/stopRun`: VS Code's
task, the JetBrains plugin's process) and the desktop app through the window whose tray holds the run, never for a run
started in a terminal. Then one input model (IO19, RW5, E15): **Interact** after **Watch live** or **Watch** in every
view, the Runs window and the desktop tray included, sticky for the worker's slot across its stops, its first input
driving the stop, and turned off with watching, **Give back** or by `Esc` on the view, which gives the stop back once
the input sent before has reached the page (the hub's `drive`, the editors' `piwi/driveStop`). Then `Esc` reaching the
page while an action runs there (RW20): the worker says when a pick or a check runs in the test's window
(the run channel's `acting`), the stop carries it (`RunStop.acting`, `HubStop.acting`), and every view sends `Esc` to
the page meanwhile, else gives the stop back. Then attention and the ambient state, in part: what the runs ask of the
person is one state (`runAttention`, `runsAttention`: a test waiting at a stop, failing, running), which Piwi Picker's
toolbar badge, Runs tile and Runs window title say (amber for the tests waiting, red for those failed, a run that
failed while no Runs window had the focus counted until one takes it), as do the desktop app's taskbar or Dock, title
and tray dot (`1 test waits for you`, the dot amber); only a run the window started from its tray flashes its end, as
it ends (DK8), and the Windows thumbnail's Stop stops the window's run started last. The editors' status bars say the same of their own runs. Remaining
of attention: a teammate asking to watch, which P9's **Ask to watch** builds. Then the editors' unattended
runs: Verify ×3, a fix plan's verification and the Flake Lab lines run on the run channel as runs nobody attends,
listed, paused and stopped as the editor's others, holding no failure (`piwi/followCommand`, E12); JetBrains Run tabs
are named after what they run; VS Code's Testing view writes in a run's output each test a worker starts, each stop
and each stop answered (E23); and the editors' status bar tooltips say what each worker runs now (E6). Then the desktop tray menu's **Show the stopped
test**, first in the menu while a test of the app's runs waits at a stop for the person (**Show a stopped test (2 wait)**
for more): it brings the window up with its Local runs tray open on the first of them (`firstWaiting`), from a page
without the tray too. Then P7, every local run has a hub, in part: a run started in a terminal or by an editor's test
runner picks its hub in order (D9: the launcher's channel, the editor whose workspace holds it, the desktop app whose
linked folder holds it, none; the reporter's `hub.ts`), and a run piped to a file or another program attaches
unattended (its ref ending in `-unattended`: listed, paused, never stopped at a breakpoint nor holding a failure) unless
`PIWI_EDITOR=on`, its start line saying so (open question 3, F9 in part). `desktop.json` names the app's server as a hub
(`runChannel`, `send`, `hub`, contract 4, both sides) once its session loaded, so the app steers a terminal's run in a
linked folder (DK11, IO5 in part), its picks coming to the window; an editor's channel is its record channel too, so
**Record here** and **Assert** work in a terminal's run. The desktop server observes the editors' runs (`EditorRuns`:
the editor's hub takes a process of this machine with no `Origin` after its token, and a `subscribe` with `observe`
answers no stop), and their tests that wait count on the taskbar, Dock, title and tray dot. The tray's stop place opens
in the IDE (DK16), a worker opens in a window of its own kept above the others (**Open in a window**, DK6), and the run's
page shows the run of the app while it goes on (**On your machine**: Stop, Hold failures, the workers and the output,
DK5 in part). DK22 is done: the desktop page documents the taskbar, Dock, title, tray dot and thumbnail buttons. Then
**Pick a locator** in a terminal's run an editor follows: the editor's discovery file names where a run's picks go
(`send`, the client's Send to editor pairing, from `InitializationOptions.runPairing` and `piwi/setRunPairing`), which
the reporter hands the run (`PIWI_EDITOR_SEND`); and the desktop app's run page says where an editor's run that reports
to it waits (**In Visual Studio Code**, read only, DK12), from the editors' runs the server observes. Left of P7: a
reproduction the desktop app launches for an editor on that editor's channel (IO6), whose jobs run in a throwaway
worktree at the failing commit, outside the editor's workspace, so where its stop shows and where its code goes is to
be decided; and the tray as a compact list. Then P8, agents are clients like any other: `npx @piwitests/reporter mcp`
routes an agent's calls to every host of the machine as one set of tools under one user-scope entry, with no run logic
of its own (each editor's discovery file names its agents' server, `agents`, and the desktop app's `/mcp` is reached
once its server proved its token): `run_list` asks every host and names each run's host, `run_start` goes to the
editor whose workspace holds the spec, any other call to the host of its run (IO3, IO12). `run_start {file, line?,
headed?, hold?}` builds the run as a person's and has the client run it where the developer sees it, labeled with the
agent's name (`piwi/startRun`, `InitializationOptions.startsRuns`); `run_list` names each run's launcher, page,
progress, Hold failures, sharing and presence, and each worker's lane (IO23 in part); VS Code lists the desktop app's
MCP server with `?runs=off` while it serves its own runs, so its agent hears one set (IO13); the skills that verify a
fix lead with `run_start`. Left of P8: `run_start` on the desktop app, whose runs the shell starts from its window.
Then P9, share by intent and ask to watch (IO15, IO16, DB13, LV-10, F6). Both editors share "this run" or "this
window's runs until I stop" (open question 5: it ends with the window): `piwi/shareRun { scope: 'window' }`, said in
the status bar (`piwi/shareWindowChanged`) and as each run is shared, each run's workers naming on their stream the run
shared before it (`share`'s `after`), which the instance links (`test_runs.continued_in_id`): the earlier run's page
says **Continued in run #78** and follows it. A run whose test was ended at a stop is marked **Ended at a stop**, a mark
with every status kept (open question 8), counted by the reporter (`endedAtStop`). **Ask to watch** (open question 6:
any signed-in reader, both named, a project setting on by default, `projects.ask_to_watch`): the instance keeps an ask
in memory and hands it to the run's reporter in an answer of the run's stream, which hands it to its hub (`run-ask`),
whose tool asks the developer (`piwi/askToWatch`, the desktop app's toast) or, with no hub, prints it; **Not now** goes
back the same way (`ask-answer`, `askAnswer`), and sharing answers it. `PIWI_SHARE_LIVE=1` shares a run from its start
outside CI, and **Not shared live** shows once, in the run page's toolbar, with **Ask to watch**. Left of P9: Piwi
Picker's Runs window offers no window scope. Then P10's first half, the run at a glance (RT7, DB14, DB15, DB16,
DB20, DB22, LV-12): `/api/stream` carries `run-progress`, at most one per run every 2 s and sent before the run's next
lifecycle event, and Home, a project's runs list and the Projects page move a running run's row on from it, in the demo
too; the live Timeline reads as lanes, grouped by shard, its header saying which shards have started, each running
attempt a bar to now over the pale bar of its test's usual time (the passes the Stuck? rule reads, one query a run),
amber once marked **Stuck?**, and the test search takes `is:stuck`, `worker:` and `shard:`; a CI run on GitHub Actions
prints a `::notice` with its page as it starts; a run outside CI makes its page an OSC 8 link in its terminal and shows
its progress as OSC 9;4 in the terminals that read it (`PIWI_TERMINAL_PROGRESS`); and a CI run posts a pending commit
status under the project's status context at most once a minute (open question 7: the same status and switch as the
final one), replaced by its final status or closed by an error status. The rest of P10 and the later phases are
proposed. The bugs the analysis
confirmed are filed as #1106 (the run page never goes live with a few tabs open), #1107 (live steps missing or on the
wrong row), #1108 (the reporter does not recover from a short outage), #1109 (a paused local test is marked Stuck? and
notifies the team), #1110 (the Runs window misses a later editor window and loses its live views), #1111 (desktop app
shell slips) and #1112 (the default trace's ARIA snapshots slow large pages). The phases below fix the first six: P0
to P3 most of them, and the rest later (#1108's run links and #1109's Stuck? mark in P5, #1110's editor focus in P4,
#1111's stopped state and the thumbnail's Stop on one run in P6). #1109's notification is fixed already: no run started on a developer's
machine (a terminal, the desktop app, an editor, `piwi preflight --run`, `piwi bug --write`) sends `test.stuck`, the
`stuck-notifications` use of `run-eligibility.ts`. #1112 is fixed on its own: the default trace takes no ARIA
snapshots. Nothing
here is on [`ROADMAP.md`](../ROADMAP.md) yet. It revises parts of [`live-view-next.md`](live-view-next.md) and extends
decisions of [`run-control.md`](../adr/run-control.md); [Changes to other plans](#changes-to-other-plans) lists them.
The contracts it adds are entry D63 of [`1.0-stabilization.md`](1.0-stabilization.md).

**Summary.**

- **Fix what breaks first.** The run page stalls with three dashboard tabs open over HTTP/1.1, a view dies at each
  test and hides the error as the test fails, live steps start 15 s late, a CI view never comes back after a 31 s
  outage, a developer's breakpoint pages the team as Stuck?, and the Runs window never sees a second editor window.
- **Watch follows a lane, not a test.** A view opens on a worker slot and keeps it through tests, retries, stops and
  the run's end, with an outcome card at each test's end. "Worker 2" means the same slot on every surface.
- **Watch your own running test on your machine.** The run channel already reaches every local tool; it carries the
  running page's frames, not only a stopped one's, and nothing leaves the machine.
- **One run, one name, one link.** Every local run gets one ref, bound to the instance's run number; every surface shows
  `Run #77 · Open`, its origin and the tool that steers it.
- **Several windows on one run.** Presence (who watches, who drives), one Hold failures policy with who set it, one
  input model, and each moment that needs the person told once.
- **The call first, pixels as one layer.** The call the test is in and Playwright's log of it, the page's errors and
  pending requests, a text (ARIA) view, a filmstrip of the test's calls, a crop of the element it waits on, and
  Playwright's own trace viewer on the growing trace. Pixels stay on by default in a focused view, and a tap away on a
  phone.
- **The team instance still never steers a run** ([run-control D8](../adr/run-control.md)). It shows CI and shared
  runs, carries a teammate's request to watch, and learns that a local test is stopped as text, never as frames.

## Terms

- **Run**: one `npx playwright test` command and its workers.
- **Lane**: one worker slot of a run, `parallelIndex + 1`, written **Worker 2**, or **Shard 2 · Worker 1** in a
  sharded run. A worker that Playwright restarts after a failure keeps its lane.
- **Watch**: open a lane's view and keep it open.
- **Hub**: the local process that steers a run's workers over the run channel: the editor service of an IDE window, or
  the desktop app's server. Every other local tool is a **window** onto that hub.
- **Attended**: a run started from a tool that shows its stops (an editor, the desktop app, an agent's `run_start`), or
  one a person or an agent follows; it may stop on its own (breakpoints, held failures). A run a script started, or
  whose output is piped, is **unattended**: listed and pausable, never waiting for someone who is not there.
- **Layer**: one kind of thing a view shows (the call, the log, the image, the text view, the requests…).

## How a run is watched today

### Two live views that never meet

Piwi has two live views, built at different times for different people, and a person moving between tools meets both.

| | The local view of a stop | The team's live view |
|---|---|---|
| For | The developer, at a stop of a run their editor or desktop app steers | A teammate, on a CI run or a run its developer shares |
| When | **Only while the test is stopped** | **Only while the test runs, one test at a time** |
| Where | VS Code's and JetBrains' paused page, the Runs window, the desktop tray | The run page's **Watch** |
| Transport | Run channel → hub → client (`packages/core/src/run-view.ts`) | Worker → instance relay → viewer (`packages/core/src/live-view.ts`) |
| Image | Asks up to 1280×800, quality 60, 10 a second | Asks up to 640×400, quality 50, 4 a second, 256 KB/s |
| Under `wrapConfig`'s default trace | The trace's screencast: up to 800 px, quality 90 (RT18) | The same |
| Input | Yes, after **Interact** (editors) or at once (Runs window, tray) | Never |
| Call log, action point | No | In CI runs |
| Masking | None | In the worker |

A developer running a headless test from VS Code sees its page only once it stops. To see it run, they set a
breakpoint, which changes the run, or **Share live** to the team instance and open the run page in a browser, which
sends frames off the machine. A run reporting to the desktop app cannot be watched while it runs at all.

### Who sees what

The analysis drew the full table of every origin against every watcher
([Appendix B](#appendix-b-every-origin-against-every-watcher)). Its shape:

| Run started from | Team run page | Editor | Runs window | Desktop app | Agent (MCP) |
|---|---|---|---|---|---|
| CI | Steps, **Watch** while a test runs, call log | A count in the status bar | Nothing | Nothing | Counts (`list_runs`) |
| VS Code, JetBrains | Steps; "Not shared live"; a stop invisible, then **Stuck?** | Stops, paused page, controls | Stops, controls | "See its page at a stop" | Runs of that window |
| A terminal, in an editor's folder | As above | Stops, marked "run in a terminal" | Stops, if the editor window was open before the Runs window | "See its page at a stop", a dead end | Runs of that window |
| A terminal, output piped | Steps | Nothing, silently | Nothing | Nothing | Nothing |
| The desktop app | Steps, if it reports to the team instance | Nothing | Stops, if paired with the app | Tray: stops, controls | The app's own tools |
| An agent's shell | Steps | Nothing (output piped) | Nothing | Nothing | "Start one from the editor" |

### What works

The live core is good. On real runs the first image came 0.4 s after **Watch**. A click waiting on a disabled button
showed the dashed outline on it, "Running for 11 seconds · Its element is not enabled" and Playwright's log: that
answers "why is it stuck?" faster than a trace. On one machine the tools agree within a second: a stop reaches the
page's pause bar, the Runs window and VS Code within 0.7 s; **Watch live** starts in about 0.22 s; **Share live**
reaches VS Code and the dashboard in under 0.4 s, and the viewer count comes back to the sharer.

### Measured

| Moment | Measured |
|---|---|
| A run page opened with Home and the runs list in two other tabs (HTTP/1.1) | Never live in a 75 s run: "Live view connecting", "No tests recorded" |
| Run page opened in a run's first seconds → first live step | 11 to 14 s |
| Run page opened mid-run → first live step | 3.9 s |
| **Watch** → first image (team) | 0.37 to 0.46 s; 1.2 s for the run's first view |
| Images a second (team), longest gap | 2.9 to 4.1; 1.8 s |
| The watched test ends | The view dims with "The test ended.", for a pass and a failure alike |
| Following one worker through 5 tests and their retries | 6 clicks on **Watch** |
| A CI run in the showcase, watched from its first test | The view was dead for 12 of its 16 s |
| **Watch** buttons in a 4-worker run, sampled 15 s | 33 moves across 11 rows, 31 of them 20 px or more |
| Image of the page on a 390 px phone | 324×202 px, its text unreadable |
| A stop → the pause bar and the Runs window; VS Code's controls; the Runs window's image; VS Code's lens | At once; 0.15 s; 0.55 s; 0.69 s |
| **Watch live** → first frame: Runs window, VS Code paused page | 0.22 s, 0.23 s |
| **Share live** → dashboard row says Paused, with **Watch** | 0.36 s |

## What the analysis found

159 findings stand after review. 134 come from reading the code, each checked by a second reader who tried to refute
it (108 confirmed, 26 confirmed in part; one more was refuted and dropped), and 25 from two hands-on sessions.
Appendix A lists them. They come down to nine causes.

### 1. It breaks silently in ordinary setups

- **A few dashboard tabs stop the run page from going live** (LV-1, #1106). Over HTTP/1.1 a browser opens six
  connections per host. Each dashboard tab keeps `/api/notifications/stream` open, hidden or not, and `/api/stream`
  while visible; the run page adds its run stream and **Watch** one more. With Home and a runs list open, the run
  page's stream waited the whole run. The default Docker deployment serves plain HTTP.
- **Live steps start late, and not at all for a second viewer** (LV-3, RT2, DB2, #1107). The first heartbeat is
  scheduled at the 15 s "watched" interval; the catch-up replays running tests but not their open steps, so whoever
  opens the run after the first person sees "In progress…" on a stuck test.
- **One shard's steps overwrite another's** (DB1). Step events carry no shard.
- **A short outage ends the run's live life** (RT3, RT4, RT14, #1108). One failed `/begin` sends the whole run as a
  batch at its end; a CI worker gives up its live view after 31 s of errors and the log still says "Live view on";
  after a restart a shared run can never be shared again.
- **A developer's breakpoint pages the team** (IO11, #1109). The instance learns of a local stop only when the run is
  shared live, and Stuck? ignores even those: it marks the test **Stuck?** and sends `test.stuck` to the project's
  channels for a full local run.
- **The Runs window never finds an editor window opened after it connected** (IO4, #1110).

### 2. A view lives for one test

The team's view belongs to the test whose row opened it (`RunLiveView.vue:67-74`). It ends with "The test ended."
for a pass and a failure alike, and hides the failed call's error at the moment it matters (LV-2, DB3). Following a
worker means close, find the row, **Watch** again, for every test and retry (LV-4, F1). The modal covers the list and
shows one worker (DB8); it moves as the log grows (LV-7); views are titled by Playwright's `workerIndex` ("Worker 6" in
a 4-worker run) while the Timeline numbers lanes 0 to 3 (LV-8, IO9); nothing links to a worker's view (DB21, RT13);
the run's end is not said (LV-9).

### 3. Your own running test cannot be seen without broadcasting it

The local view needs a stop: the reporter's `view` needs `stop` and the hub's needs `since`
(`packages/core/src/run-hub.ts:302-306`). Every local surface shows a running test's title and "Running", but neither
its page nor its current call, until it stops (IO1, E1, RW1, DK1, RT1, F11). The editor never shows which call or line a
running test is at (E2), though agents get every call with its place (IO14). Stepping blanks the image and restarts the
stream at each step (E9, DK7), and a second worker's stop takes the focus and the single paused page, ending the view in
use (E8).

### 4. One run, five names, no links

The hub knows a ref, the instance a number, the Runs window a `parallelIndex + 1`, the team page a `workerIndex`
(IO2, IO9). The Runs window and the editors never link a run to its page (F3); VS Code's status bar offers the
*previous* run while yours runs (E4); after **Debug in my editor** the dashboard loses the run it caused and hides it
as partial (F2). The same word means different things: **Watch** is a running test on the dashboard and a stopped page
in the editor (E16); **Live** is a local view in the Runs window, a share in VS Code and a link in the tray; **follow**
is three things; **Stop** is two (IO18, DK17, DB18).

### 5. Each tool sees a slice

No tool sees every run on the machine (IO5). A run piped to a file skips the editor silently (F9, RT12). An agent's
own shell run is invisible to its run tools (IO3), and its MCP server is per workspace under one shared name (IO12,
IO13). A desktop run never reaches an open editor: its code is copy-only and its place not a link (IO6, DK16). A
terminal run with the desktop app open and no IDE has no hub, and the app says "See its page at a stop" (DK11). VS
Code shows a CI run's tests as spinners like your own (F4); no local tool can watch a CI run (E24).

### 6. Nobody knows who else is there, and policies depend on which window is open

Three tools can watch and drive one stop with no sign of each other (IO7, F5). An agent's stop reads as a plain
"Paused" in the Runs window (RW24). Whether a failure is held depends on whether a Runs window happens to be open,
minimized included (IO8, RW19, RW13); the tray's **Hold failures** reads off while the Runs window holds them. Input
needs **Interact** in the editors and is on at once in the Runs window and the tray (IO19, RW5, E15). **Share live**
and **Watch live** are lost at each re-run, so a teammate's view dies in the edit-and-run loop (F6).

### 7. Told too much, or not at all

A bisect's bad steps flash "Run failed" and bounce the Dock at every step (DK8). A test waiting at a stop reads
"Running 3/5" everywhere outside the tray (DK9). Nothing outside the Runs window says a test stopped or failed (RW2).
The paused page reopens and takes the focus at every headless stop (E17).

### 8. Away from the run page, a live run is a word

Home and the runs lists freeze a running run at page load: "Running · Run #93 · —" for 68 s (DB14, LV-12). A pull
request shows nothing from Piwi until the run finalizes (DB15, RT7). A CI job that reaches the instance by an internal
name prints links nobody can open (RT8). An initializing run reads "No tests recorded for this run." (DB11, LV-11).

### 9. Pixels are the only explanation people get

At 390 px the image is unreadable, with no zoom (LV-5). The page's console errors and failed requests reach agents and
never the person in the editor (E19). The call stream agents already receive (`run-events.ts`) is the cheapest, most
searchable answer to "what is it doing", and no person sees it.

## Beyond video: what a live view can show

A live view is a lane described by a small stream of events, the **call** being the unit: what the test does, where in
the code, and what Playwright says it waits for. Each other kind of content is a layer of that call, priced in
bytes, worker time and privacy, and produced only while a viewer subscribes to it.

| Layer | Shows | Source | Cost | Default on |
|---|---|---|---|---|
| Progress | Done of total, failed so far, elapsed against the usual, shard states, verdict | Run channel `test-end`, counted by the hub; the instance's `run-progress` | Bytes a test | Every surface |
| The now-line | Each lane's test, its call with the locator, its place in the code, how long it has run, the `test.step` path | Client `_instrumentation` (`run-events.ts` already reads it), plus a call-begin; on the team side `onStepBegin` keyed by lane | ~200 B a call, 4 updates a second a lane | Every surface, rows included |
| Running cursor | A dim execution mark on the running call's line, the call and its time after the line | The now-line's places, mapped by the service's `RunLines` | None | VS Code, JetBrains |
| Why it waits | Playwright's log of the call, elements matched, the element's box and state, the action point | `_enable()` in CI (as today); the in-process instrumentation listener in runs Piwi may pause | A few messages a second | Every lane view |
| Page events | Console errors, uncaught errors, failed requests, requests pending long ("POST /api/checkout pending 17 s"), the backend's logged errors | `run-events.ts` listeners, turned on for any watcher | Small, capped | Lane view, the editors' output, a Runs window ticker |
| Pixels | The page as it paints, with the action point and the element's box drawn by the viewer | `page.screencast` through `page-view.ts` | 15 to 40 KB an image; 10/s local, 4/s team; 2/s while a masked field shows | A focused lane view |
| Crop to the target | The element the call waits on, sharp, with a margin | The viewer crops the frame around the box the worker already sends | Free | Phones, narrow windows, hovers |
| Text (ARIA) | The page as roles and names: searchable, copyable, the target node marked, change since the last call | The trace's `aria/<callId>-<phase>.json` (written when the project's trace sets `snapshots.aria`; `wrapConfig`'s does not), else `ariaSnapshot` on request | A few KB, hundreds of KB on a heavy page; 120 to 300 ms there if taken | Phones, agents, screen readers |
| Filmstrip | One thumbnail per finished call of the current test, for a late joiner | Locally the trace's `screencast/*.jpeg`; for the team the view's own masked frames, taken only while someone watches, kept in the worker's memory | No capture locally | A strip under the view |
| Lanes at a glance | A bar per attempt per lane, the usual duration as a ghost, Stuck?, tiles of every lane at 1 fps | Lane state, the last ten passes per test | One query a run; tiles at 1/s | The run page, the desktop run page |
| The DOM at each call | Inspect and pick a locator on a running test | Locally Playwright's trace viewer on the test's growing trace; for the team [live-view-next Part 4](live-view-next.md) | File reads | A hand-off locally |
| Presence | Who watches, who drives, who paused, who set Hold failures | The hub's clients; the instance's viewer count | Bytes | Every surface |
| Terminal | One start line with the link, stop and stuck lines, OSC 8 links, OSC 9;4 progress (error after a failure, warning while a test waits) | The reporter's main process | None | Terminals, CI logs |
| OS presence | Running, failing or waiting for you on the taskbar, Dock and tray; one flash per job | The desktop app, fed from every local run | None | The desktop app |

The screencast JPEGs come free from what Playwright already records under `wrapConfig`'s trace, the ARIA files only
under a trace that sets `snapshots.aria`, and Playwright's trace viewer opens a test's growing trace as a live view
(`npx playwright show-trace <outputDir>/.playwright-artifacts-<workerIndex>/traces/<name>.json`, where `<name>` is the
test's id, with `-retry<k>` for a retry and `-recording<N>` for each recording after the worker's first; the viewer
builds that `.json` over the growing `<name>.trace`). Others were weighed and left
out ([Not in this plan](#not-in-this-plan)): WebRTC and VNC, a recorder in the page, following Playwright's video file,
images in the terminal.

## The model

A person learns one model, and every surface renders it.

- **A run** started on a developer's machine has one ref from its start (from its launcher, or set by the reporter),
  bound once to the instance's number; a CI run is known by its number. Every surface names it **Run #77**, or by its
  target before the instance answers, with its origin (CI on main, VS Code, a terminal, the desktop app, Claude Code)
  and, for a local run, the tool that steers it.
- **A lane** is in one state: starting, between tests, running a test at a call, waiting (a call past 3 s, with why),
  pausing (still showing its call), stopped at a reason by someone (a breakpoint, a step, Pause, `page.pause()`, a
  held failure, the agent), done.
- **Watch** opens a lane and keeps it until you close it, the run ends, or the view has been hidden for 10 minutes. Each
  test's end leaves an outcome card (**Passed in 4.2 s**, or **Failed** with its error, **Open the failure** and **Watch
  the retry**) and the view rolls on. **This test only** and **Follow what needs attention** are modes; a manual choice
  pins the view.
- **Local or team.** Your own run is watched through your hub, and nothing leaves the machine. A CI run, or a run its
  developer shares, is watched on the team instance. The view, its layers and its words are the same.
- **Roles.** Everyone watches. One person or agent at a time drives a stopped page, shown to everyone; **Interact**
  takes control and `Esc` gives it back. Pause, Resume and Step belong to any local window, and each says who did it.
  The team instance only watches.
- **Policies belong to the run**, chosen at start or later, kept by **Run again**, shown with who set them:
  **Hold failures**, **Share live** (this run, or this window's runs until stopped), **Run headed**.
- **Attention.** One state for every corner of the screen: running, failing, or waiting for you. The moments that need
  a person (a test waiting at a stop, a held failure, a teammate asking to watch, a run that ended while you were
  away) interrupt once, where the run was launched, and show as a badge everywhere else until answered.

## Decisions

| | Decision | Why |
|---|---|---|
| D1 | **A view follows a lane**, not a test or a stop. Lanes are `parallelIndex + 1` per shard on every surface and in every agent tool; `workerIndex` is never shown. | A view that dies at each test is the most visible failure (F1, LV-2, LV-4). `workerIndex` grows at each restart. The Timeline approximates the slot from timing today; the reporter starts sending `parallelIndex` with each test, so every surface uses the real slot. |
| D2 | **One page source per lane in the worker, two sinks.** The run channel (hub) and the live-view link (team) subscribe to one feed: one `page-view.ts` source, masked once. One size per sink: the hub at its largest viewer, the team at 640×400. | Today the stop view and the team view are two capture paths with two sets of rules. Per-viewer re-encoding would run on the test's thread. |
| D3 | **Mask every sink, the local one included.** Frames through `live-mask.ts`, the pause bar's box painted too; every text through `hideTypedText` and `hideSecretsInText`. | Today the local stop view is unmasked, and the titles of run-channel calls and stops skip `hideTypedText` (`packages/reporter/src/internal/capture/run-events.ts:69`, `run-channel.ts:496-505`). One rule is simpler to trust. Whether a field the developer types into at an Interact stop stays gray is an open question. |
| D4 | **The call is the unit, and pixels one layer of it.** Each layer is keyed by the call's id and produced only while subscribed, reusing what the trace already writes. | Revises live-view-next D1's first half; keeps its second. Generalizes "no image while nobody watches" to every layer. |
| D5 | **The lane model lives in `@piwitests/core/live-lane` (MIT, written anew): ids, states, a reducer.** The hub and the instance reduce; surfaces receive ready lane state. | The Kotlin plugin cannot run a TypeScript reducer, and a window that reduces on its own can drift from its hub: one reducer per producer side keeps every surface in step. |
| D6 | **Words stay in the FSL surfaces; core carries enums.** A drift test holds the dashboard's, the desktop's and the extension's words for each enum together. | The root guide forbids moving FSL code into MIT packages; enums are new code. |
| D7 | **The team instance never steers** ([run-control D8](../adr/run-control.md) stands). It may carry a request (**Ask to watch**) that a local tool shows for the developer to accept, and it receives a local stop as text. It never learns a hub's address. | Consent stays local. A stop as text is the same class of data as a live step, but goes whoever watches: the stuck check reads it, and it is a few words per stop. Widened by [run-on-my-machine.md](run-on-my-machine.md) to starting and stopping a run a person asked for, which the local tool shows first. |
| D8 | **Hubs accept a native client without an `Origin` that holds the discovery token**, so the desktop server can read an editor's sessions and `npx @piwitests/reporter mcp` can reach every hub. This widens run-control's D8 ("a WebSocket only from the extension's origin") and is recorded as superseding that point when it ships. | Web pages still always send an `Origin` and stay refused. The token is the user's own, in an owner-only folder; the Windows check of that folder needs the same review. |
| D9 | **One owner per run, and no daemon** (amended by [run-on-my-machine.md](run-on-my-machine.md): Piwi Runner is one more program, a run target and never a hub). The hub is picked in order: the launcher's channel, the editor whose workspace holds the folder, the desktop app whose linked folder holds it, none. A piped run attaches unattended by default (open question 3). | Extends run-control D5. A new daemon is one more process to install and secure; the editor service and the desktop server already are hubs. |
| D10 | **Peers name hubs, never their tokens.** A hub tells its clients of the other hubs in `~/.piwi/editors`; the desktop hub is named without the desktop token, and Piwi Picker pairs with the desktop app through its own **Allow**. | The desktop token opens the app's whole API; handing it on would skip the user's consent. |
| D11 | **Features, not versions.** `run-attach`, the hub's `welcome` and the desktop's live answer carry `features: string[]`; readers treat an unknown state as `other`. Lenient readers ship a release before any new state. | Six release trains (two marketplaces, a browser store, the desktop updater, npm, the instance) update independently, and `RUN_TAKES` is at its 16-entry cap (`packages/core/src/run-channel.ts:127-146`). |
| D12 | **`follow` splits into `presence` and `hold`.** `presence` says a window shows the run and turns events on; `hold` is the run's policy with who set it. The desktop hub's `show`, which means Hold failures today, keeps that meaning. | A hidden Runs window holding every failure (RW19) comes from one word meaning two things. |
| D13 | **A run that a hub steers is `interactive` at `/begin`.** Its stops reach the instance as text; Stuck? leaves stopped time out; the run's outbound effects follow one stated policy for local runs, as `test.stuck` already does (`stuck-notifications`). | A developer's pause is not a hang (IO11), applying run-control D10. |
| D14 | **Pixels relayed by the instance stay for CI and shared runs only**; local watching never needs a key or a team instance. | Watching your own run must work offline and with the desktop app. |

## Architecture

**Worker** (MIT, `packages/reporter/src/internal/capture/`). A new `lane-feed.ts` tracks the lane (`shard`, `slot`,
`workerIndex`), the current test and call, the step path, the stop and the last frame. Its subscribers are the hub link
(`run-channel.ts`) and the team link (`live-view.ts`). Frames come from one `openPageView` on the test's page (the
`page` fixture's, else the first page the browser patch saw), masked once; stills are taken at CSS scale with their
aspect checked. Later layers join the same feed: the call log from the in-process instrumentation listener, ARIA from
the trace's files, thumbnails from its screencast.

**Run channel** (MIT, `packages/core/src/run-channel.ts`). `run-attach` gains `features`, `slot` and `attend`;
`request view` takes a lane scope that needs no stop, input still needing one; `layers {on, size}` joins `events`,
which the hub still sends to a worker whose `features` lack `layers`; events gain `call-begin`, and the worker's
`test-end` gains the test's duration (`ms`); `hold {on, by}` can come at any time. A main-process connection
opens in `onBegin` when the run has a hub: `run-begin {ref, launcher, run {id, page}, total, workers, shard,
attended}`, `run-end {status, counts, first failure}`, and asks from the instance.

**Hub** (FSL, `packages/editor/src/run-sessions.ts`, `run-hub.ts`, `protocol.ts`, reused by
`apps/application/server/utils/desktop-runs.ts`). A `HubSession` gains `run`, `origin`, `launcher`, counts, lanes,
watchers, `hold {on, by}` and `share {scope, by}`. New commands `watch {ref, slot, size, layers}`, `drive`, `hold`,
`ack`; new messages `lane`, `frame` keyed by slot, `attention`, `peers`. The hub keeps lane state per slot and replays
it to a newcomer. `internal/config/editors.ts` becomes `hub.ts` with the pick of D9.

**Instance** (FSL, `apps/application/server`). Step events carry `shardIndex`, `parallelIndex` and `retry`;
`server/utils/run-events.ts` keeps each lane's open step and state in memory and `stream.get.ts` replays them;
`live-view/watch.get.ts` keys a watch by lane and carries test markers and the run's end; `/setup`, `/begin`, `/start`
and `/finish` answer the public `runUrl` from `PIWI_SITE_URL`, as `gate.post.ts:251` does; `/events` takes
`test-stopped` and `test-resumed`; the live-view key's digest is stored with the run, as stream tokens' are, so a
restarted instance accepts its workers again.

**Browser.** `/api/stream` carries the notifications and, as subscriptions, the run and live-view streams of the tab:
one connection per tab, closed while the tab is hidden unless a view or a picture-in-picture window shows. A stream
that has not opened after 5 s says why and offers **Retry**. Sharing one connection across tabs (a Web Locks leader
and `BroadcastChannel`) follows only if measurement shows six tabs still stall.

**Surfaces** render lane state: `LanePanel.vue` (the dashboard and the desktop app, from `RunLiveView.vue`), the Runs
window (`apps/extension/src/runs/main.ts`), the VS Code worker panel (`apps/vscode/src/run-view.ts`,
`paused-page-client.ts`), JetBrains' Piwi tool window (`PiwiRunControl.kt`), the desktop tray. Agents reach every hub
through `npx @piwitests/reporter mcp`, a stdio router modeled on the desktop's `piwi-desktop mcp-stdio` bridge. The
terminal gets lines from the reporter's main process.

## What each surface becomes

- **Dashboard run page.** Goes live whatever other tabs are open, or says why within 5 s. Rows are shard-aware and get
  their step within 5 s, at once for later viewers. **Watch** opens a docked, resizable lane view beside the list (a
  sheet on phones) that follows the lane with outcome cards; `?watch=<shard>.<slot>` opens it; **Watch** sits in a fixed
  slot at each row's end; grouping holds still while the run is live. The header names the origin and the steering tool;
  a local stop reads by its reason ("Stopped at a breakpoint · in VS Code"); your own runs are always listed; "Not
  shared live" shows once, with **Ask to watch**. Later: the Lanes view, the filmstrip, the Text and Requests tabs.
- **Home and the runs lists.** A running run shows done of total, failed so far, elapsed against the usual, a Stuck?
  count and **Watch**.
- **VS Code.** "Piwi: worker N" replaces the paused page: it watches running or stopped, carries Resume, Step, Run to
  cursor, Finish, End and the code actions, keeps the last frame across a Step, and a new stop never takes it over. A
  dim mark on the running call's line with the call after it; a "Piwi: Page" output; `Run #78 · 3/9 · Open` first in
  the status bar whatever file is open; the Live item opens a menu. Later a Piwi Runs view of every lane, CI included,
  read-only. The Testing view's running state is kept for this window's runs.
- **JetBrains IDEs.** The same answers in the Piwi tool window (a Runs tab, a worker tab), an inlay for the running
  line, a status bar that composes progress with the stop or the share, and Run tabs named after their target with
  Pause and Step.
- **Piwi Picker's Runs window.** A window opened later appears within seconds; a lost hub's runs stay grayed and their
  views come back; one status line per paired tool. Compact lanes with the now-line, **Watch** on running lanes, the
  controls above the image, the stopped lane scrolled into view, `#77 · Open`, progress and the outcome; run-level
  Pause all, Resume all and Stop; presence chips, the agent's stops labeled. It holds failures only when asked.
- **Desktop app.** **Watch** on running rows of its own runs. The run page is a run's home (Stop, Hold failures, Share
  live, Output, lanes inline); the tray a compact list. The fallback hub for terminal runs in linked folders. The
  taskbar, Dock and tray show every local run, amber while one waits, one flash per job; the window re-attaches after
  a reload. Stop places open in the IDE.
- **Terminal and CI log.** One start line as soon as `/setup` answers, with the public link and where the run is
  steered, or why nothing steers it; stop lines naming the tool and who stopped the test; a stuck line; one "live view
  lost" and one "back" line in CI; an end line with the first failure. In a terminal, OSC 8 links and OSC 9;4
  progress.
- **Pull request.** An opt-in pending commit status for CI runs from `/begin`, its link the live run page, resolved at
  finalize or by the stale-run cleanup.
- **Agents.** One `npx @piwitests/reporter mcp` entry in user scope reaches every hub. `run_start` opens a run the
  person sees, labeled "from Claude Code"; `run_list` gives the ref, slot, origin, run id and page; `run_follow` can
  hold a failure. The agent shows as a presence chip and in "Paused by the agent" everywhere.

## Journeys

| Journey | Today | After |
|---|---|---|
| Open a CI run from its log in the first seconds, with other Piwi tabs open | The page may never go live; alone, no step for ~14 s; a second viewer never sees the step | Live at once or "why" within 5 s; every lane's call within 5 s, on its own shard's row |
| A teammate follows a CI run until it turns green | The view dies at the first test, hides the error; 6 clicks for 5 tests | One **Watch**; outcome cards with the error, **Open the failure**, **Watch the retry**; the verdict at the end |
| The instance restarts during a 40-minute CI run | The view is gone for good; the log still says it is on | One "lost" and one "back" line; the page says "reconnecting", then images |
| Two IDE windows and one Runs window | The second window's runs never show | They show within seconds; closing one window loses only its runs |
| Watch my headless test from VS Code while it runs | Only at a stop, or by sharing to the team | **Watch** on worker 1: the page in ~0.2 s, the call and why it waits, a failed request in the output; nothing leaves the machine |
| **Debug in my editor**, then back to the dashboard | A toast; the run hidden as partial, "In progress…" through a 3-minute stop, then **Stuck?** | "Following run #77 in VS Code · Open"; the row says where it stopped; never Stuck? |
| A desktop run in the tray, the Runs window and an agent | Three drivers with no sign of each other; holds differ by window | Presence chips; one driver shown to all; **Hold failures** "on · set by the agent" everywhere |
| A terminal run with the desktop app open and no IDE | No hub: no Pause, no Watch, a dead-end note | The app steers it: lanes, **Watch**, Pause, progress on the taskbar |
| An agent writes a test, runs it and looks at the failure | Its piped run is invisible to its own tools | `run_start`, a visible run, the held failure, the run id for `get_run` |
| A teammate wants to see a local run stopped at a breakpoint | "Not shared live", no way to ask | **Ask to watch**; the developer answers where they are; the share survives the re-run |
| A reviewer wonders why the checks take long | Nothing from Piwi until the end | A pending status linking the live run, with its progress |
| Checking a stuck test from a phone | A 324 px image | The call, why it waits, a crop of the element, the pending request; pixels a tap away |

## Origins and environments

| Case | What it gets |
|---|---|
| UI mode, `--debug`, `PWDEBUG` | Unchanged: the reporter stays out of UI mode, and Playwright's own debugger keeps its runs. |
| Microsoft's Playwright Test for VS Code | Its runs go through Playwright's test server, which serves one client: Piwi never connects to it (a second client takes its events). They attach unattended at most, beside that extension's own debugger. |
| `merge-reports` in CI | No live run: Piwi's reporter runs at merge time. The docs say so, and no start line, pending status or live-view line prints. |
| A partial CI re-run (one shard) | Shards that never begin are not shown as waiting forever: after the first shard's end, unstarted shards read "not run". |
| Remote browsers (`connectOptions`, grids) | The now-line and pixels; no free ARIA or filmstrip (the trace's files arrive when the chunk stops); no in-process listener. The view says which layers are absent and why. |
| Remote development, WSL, dev containers | Hubs and discovery files live on the remote; peers name only forwarded ports; the desktop app's fallback does not reach a WSL or container home, and says so. |
| Windows | Named pipes for the run channel; OSC sequences only where the terminal declares support; the discovery folder's privacy check reviewed. |
| Several instances | A run binds to the instance it reports to; `Open run #N` points there; an ask from another instance is refused. |
| An editor window reloads mid-run | Workers cannot re-attach (their channel is fixed at start): the run is listed "steered by a window that closed", and a held failure goes on. |
| Authentication off | **Ask to watch** and named presence need sign-in; with authentication off a teammate sees counts, and asking is not offered. |
| Electron, API-only and component tests | The now-line only: no page Piwi can show. |

## Delivery

Each phase ships alone, removes a failure seen on real runs or adds one capability, rides optional fields or
`features`, and names its verification. P0 to P4 answer the request on their own: a live view that works, follows and
survives, and a local test watched while it runs.

### P0. The run page goes live, on time, on the right row

The fixes of #1106 and of #1107's first three items (the rest in P1).

- `/api/stream` carries the notifications and the tab's run and live-view subscriptions; per-tab streams close while
  the tab is hidden, unless a view or a picture-in-picture window shows; a stream not open after 5 s says why, with
  **Retry**; the self-hosting docs name HTTP/2 behind TLS. `useRunStream` refreshes its subscribers on the first open.
- The reporter re-arms the heartbeat at the unwatched interval on the first `watched: false`, and flushes the
  replayed open steps at once.
- Step events carry `shardIndex`, `parallelIndex` and `retry` (one PR with the dashboard, contract 2); live steps are
  keyed by lane; the catch-up replays each lane's open step.
- The view's caption uses the lane's step when it is newer than the image's call, and names the call with its locator.
  Piwi's own fixture steps are left out; `test.step` streams with its nesting.
- Before the first test: "Global setup · 2 m 10 s" (the test count arrives with `/begin`: global setup runs before the
  tests load).
- **Verification**: an E2E on the HTTP/1.1 dev server with Home, the runs list, three hidden tabs and the run page in
  one browser context, the rows of a simulated run shown within 2 s; a reporter fake-timer test of the heartbeat; a
  server test of two shards' steps.
- Addresses LV-1, LV-13, LV-3, RT2, DB1, DB2, DB10, RT10, RT11, LV-14, DB11, LV-11.

### P1. Watch follows its worker and keeps the outcome

- `RunLiveView.vue` becomes a docked, resizable `LanePanel.vue` (a sheet below 640 px): a fixed-height image region,
  the log beside it from `lg`, full screen, zoom and **Zoom to the element** (a crop around the box the worker sends).
  **Watch** sits in a fixed slot at each row's right edge.
- A watch is of a lane: the relay keys viewers by shard and slot and follows a restarted worker in the same lane; the
  stream carries test markers (status, duration, execution id) and the run's end.
- An outcome card at each test's end, then a divider into the lane's next test; **This test only** keeps today's
  behavior; the run's end drops "live" and shows the verdict.
- **Worker N** everywhere (the view, the rows, the Timeline, every MCP tool); a restart is noted.
- `?watch=<shard>.<slot>` opens the view; `test.stuck` links to it. Refusals say why (the worker left, the viewer
  limit, signed out).
- The list holds still: grouping decided once per page view, auto-scroll only in run order; `test-completed` carries
  the failure cluster; `test-begin` carries the retry, tags, metadata and locks; a retry shows as **Retry 1 of 2**.
- The header's primary action is decided once per page view, not by when the page was opened.
- A view hidden for 10 minutes closes, so lasting views do not exhaust the bound of four per person and 16 per run.
- **Verification**: the showcase's `back-on-the-team` beat asserts images keep coming until the run is green; an E2E
  of a failing test's card and its retry.
- Addresses F1, LV-2, LV-4 to LV-9, DB3 to DB9, DB17, DB19, DB21, RT13, IO9.

### P2. A CI live view that survives outages and says so

The fixes of #1108 but its run links (P5).

- The reporter retries a failed `/begin` or `/start` with backoff for the run's life, the queue kept within the
  on-disk buffer's cap, and prints one "streaming started late" line.
- In CI, after the fast retries, the worker retries every 30 to 60 s for the run's life and resets its reconnect count
  after a steady stream; it prints one "live view lost: <cause>" and one "back" line.
- The live-view key's digest is stored with the run; a restarted instance accepts a running worker's key once the run
  is active and the setting on, so **Share live** comes back too.
- Honest lines: "Live view on for the specs that use Piwi's fixtures", naming the first that does not; each
  "unregistered" line names its cause; `merge-reports` prints none.
- An admin turns the live view on from the run page's help, and the status says it starts with the next run.
- **Verification**: reporter tests against a fake instance that is down 4 s at the start, answers 503 for 40 s
  mid-run, then restarts: one "lost" and one "back" line, events delivered.
- Addresses RT3, RT4, RT5, RT6, RT14, DB12.

### P3. Local tools that tolerate each other and never page the team

The fixes of #1110 but its editor focus (P4), and of most of #1111.

- An unknown worker state reads as `other`; an unreadable field is dropped, not the session. `features` in
  `run-attach`, `welcome` and the desktop's live answer. This ships a release before any new state.
- Hubs push peers from `~/.piwi/editors` (D10); the Runs window connects to a new window within seconds, re-reads
  `GET …/live` every 60 s as a fallback and keeps **Look again**. Any live service answers `…/live` from the folder.
  A lost hub's runs stay grayed and their views restart; views are keyed by run and slot.
- The Runs window shows one status line per paired tool, a broken pairing included; an unproven pairing stops
  retrying after a bounded backoff, and a 404 reads as "not an editor"; the popup's Runs tile names the window; a
  request the worker drops times out and frees its buttons.
- A run that follows a hub sends `interactive {client, ref}` at `/begin` (D13).
- The local stop view is masked like the team's, the pause bar's box included (D3); the stop image is taken at CSS
  scale and its aspect checked.
- The desktop app opens its hub stream from a plugin at window start, outside the default layout, and rehydrates it
  after a reload; stopping one run removes only its own progress; a bisect's steps flash once, on the job's verdict.
- **Verification**: an extension test with a second hub appearing after the first; the showcase compares the stop image
  with a screenshot of the page.
- Addresses IO4, IO10, IO11, IO21, RW3, RW4, RW11, RW12, RW23, RW25, DK8, DK13, DK14, DK20, F5, F7.

### P4. Watch your own running test, on your machine

- `lane-feed.ts` in the worker (D2), serving the hub at up to 10 images a second and the team at up to 4, 2 a second
  while a masked field shows; nothing runs without a subscriber.
- The run channel's lane-scoped view needs no stop and is the feature `view-lane`; images carry the test and stop; a
  stop no longer restarts the view. A hub facing an older reporter says "Update the reporter to watch a running test".
- `@piwitests/core/live-lane` (D5); the hub reduces events to lane state, counts done and failed locally, and replays
  it to a newcomer; events are on while any window shows the run.
- The main-process hub link opens in `onBegin` when the run has a hub: `run-begin` (ref, launcher, total, workers,
  shard, attended, and the run's number and page once the instance answers) and `run-end` (status, counts, first
  failure); `RunSession` gains them, so progress reads "3 of 9" from local events.
- Every viewer keeps the last image across a Step or Resume, dimmed and marked "running…"; **Pausing…** shows the
  call it waits in and for how long, and offers **End the test** where the reporter can give up a waiting call.
- VS Code's "Piwi: worker N" and JetBrains' worker tab (as above), the running line marked, a Page output, per-worker
  Pause and **Pause and watch**. The status bar and the Testing view count from the hub's events, so they work offline
  and with the desktop app.
- The Runs window: **Watch** and **Pause and watch** on running lanes, compact rows, controls above the image, the
  stopped lane in view, Pick, Record and Assert shown disabled with "Watch to use". The desktop app: **Watch** on its
  own running rows, and the tray brings the stopped lane into view.
- **Verification**: reporter tests with a fake hub that one request receives images across two tests, a password
  field is painted, nothing is captured with no view, and a watched test's CPU stays within budget; a showcase beat
  watches a running test in the Runs window for 5 s.
- Addresses IO1, RT1, E1, RW1, DK1, F11, IO14, E2, E3, E7, E8, E9, E13, E17, E19, RW6, RW7, RW9, RW14, RW15, RT17,
  RT18, DK2, DK7, DK15.

### P5. One run, one name, one link

- The reporter sets a ref for every run outside CI (`PIWI_RUN_REF` from the launcher, else one of its own) and records
  `ref` and `launcher` for every origin. `/setup`, `/begin`, `/start` and `/finish` answer the public `runUrl`; the
  reporter prints and shares only that URL, falling back to its own address.
- `#77 · Open` beside every Copy: the Runs window card with its progress and outcome (passed, failed, ended at a stop),
  both status bars ("Open run #78 (running)", your run first), the tray. The Live item opens a menu.
- A local stop reaches the instance as text (`test-stopped`, `test-resumed`: reason, call through `hideTypedText`,
  place, the kind of tool, and the attempt's stopped time so far), whoever watches, since the stuck check reads it.
  Rows word it by reason; Stuck? leaves the
  stopped time out. The
  header names the origin and the steering tool; your own runs are always listed; **Debug in my editor** becomes
  "Following run #81 in VS Code · Open".
- One start line, the plumbing at `PIWI_VERBOSE`; a piped run that skips its editor says why; the stop line names the
  tool and who stopped it.
- The words (D6): one per concept, held by a drift test; the docs get a glossary and one **Watch a run** page.
- VS Code's Testing view keeps its running state for this window's own runs; a CI run of the branch shows as such,
  not as the person's tests spinning.
- Smaller: the service publishes a stop's line mapped by `RunLines`; the "did not reach the instance" notice tells an
  attached reporter from a missing one; a pick says "sent" only when an editor took it, and offers **Copy**.
- **Verification**: an E2E from **Debug in my editor** to the row's stop text; unit tests of the ref and the URL
  fallback; the drift test.
- Addresses IO2, IO17, IO18, IO20, IO22, F2, F3, F4, F8, F10, E4, E5, E14, E16, E20, E22, E25, RW10, RW18, RW21,
  DK10, DK17, DK18, DK21, DB18, RT8, RT12, RT15, RT16.

### P6. Several windows on one run

- Presence: who watches each lane and who drives a stop, as chips on every surface; one driver at a time; a person's
  click takes control back from an agent, with a notice on both sides; the Runs window labels the agent's stops.
- `follow` splits into `presence` and `hold` (D12); **Hold failures** is per run, set from any window or by
  `run_follow`, sent to running workers; on for an editor debug run, a reproduction and an agent that asks, off
  otherwise. A Runs window no longer holds failures by being open.
- Start options on every run command: **Hold failures** and **Run headed**, kept by **Run again**; a ×N run offers
  "Stop at the first failing repetition"; a breakpoint the run cannot reach never makes it headed; **Show the browser**
  at a headed stop.
- One input model: **Watch**, then **Interact**, sticky for the view; `Esc` reaches the page while an action runs
  there, else gives control back.
- Attention: each waiting stop, held failure and run that ended while you were away interrupts where it was launched,
  and shows as a badge elsewhere until answered. The ambient state (running, failing, waiting for you) on the status
  bars, the Runs window's title and badge, the desktop's taskbar, Dock, tray dot and tray menu (**Show the stopped
  test**). The Windows thumbnail's Open restores a minimized window; its Stop acts on one run.
- Editors: Verify ×3, the fix plan's verification and Flake Lab lines get the run channel, unattended; JetBrains Run
  tabs named after their target; the Testing view gets output and a stop message; each editor lists what each worker
  runs now.
- The Runs window: run-level Pause all, Resume all and Stop; keys for Resume, Step and Finish; it keeps its place on
  screen; the run shortcut and **Look again** answer, and the shortcut leaves unattended runs alone.
- **Verification**: a hub test of two windows and an agent on one stop; an E2E of the per-run hold.
- Addresses IO7, IO8, IO19, RW2, RW5, RW8, RW13, RW16, RW17, RW19, RW20, RW22, RW24, E6, E10, E11, E12, E15, E18,
  E21, E23, DK3, DK4, DK9, DK19.

### P7. Every local run has a hub

- `desktop.json` gains `runChannel` and `hub` (contract 4, both sides); `hub.ts` picks the hub (D9). A piped run
  attaches unattended, marked as the desktop's unattended runs already are; its start line says so;
  `PIWI_EDITOR=off` opts out.
- Terminal and test-runner runs get the record and editor-send channels, so **Pick**, **Record** and **Assert** work
  as for runs the editor starts.
- The desktop app launches a reproduction for an editor on that editor's channel, so one hub owns it: its stop shows at
  the failing line and its code is written in the editor. The desktop server reads the editors' sessions for its run
  page and OS surfaces ("Paused in VS Code") and steers none of them.
- The desktop run page becomes the run's home; **Open in a window** gives an always-on-top lane window; stop places
  open in the IDE.
- The desktop page documents the taskbar, Dock, title, tray dot and thumbnail buttons.
- **Verification**: a reporter test of the hub pick in each case; a desktop E2E of a terminal run steered by the app.
- Addresses IO5, IO6, DK5, DK6, DK11, DK12, DK16, DK22, F9.

### P8. Agents are clients like any other

- `npx @piwitests/reporter mcp`: a stdio router with no run logic, reading the discovery files (the editor's gains its
  agent endpoint, owner-only), forwarding the hosts' tool lists and routing each call by ref. One user-scope entry for
  every repository; VS Code keeps its own registration and stops listing a second set.
- `run_start {file, line?, headed?, hold?}` goes to the host whose workspace holds the folder, which builds and checks
  the command as for the editor and runs it visibly, labeled with the agent's name.
- `run_list` returns ref, slot, origin, launcher, run id and page, presence, hold and share; `run_follow` subscribes to
  lane events and can hold; a following agent counts as a watcher.
- **Verification**: a router test against two fake hosts; the skills lead with `run_start`.
- Addresses IO3, IO12, IO13, IO23.

### P9. Share by intent, ask to watch

- Share scope is "this run" or "this window's runs until I stop", ending with the window, shown in the status bar,
  announced at each run; the team view of a replaced run says "Continued in run #78" and follows it.
- A run whose test was ended at a stop is marked "ended at a stop", not a plain pass.
- **Ask to watch**: a signed-in reader of an unshared local run asks once per five minutes; the ask rides the
  reporter's next answer to the hub and interrupts where the run was launched ("Dana asks to watch run #77 · Share
  live · Not now"); the teammate's page shows the answer. A run with no hub prints the ask in its terminal.
- `PIWI_SHARE_LIVE=1` shares a run that has no hub, after printing what goes out.
- "Not shared live" shows once in the toolbar, with **Ask to watch**.
- Addresses IO15, IO16, DB13, LV-10, F6.

### P10. The run at a glance, wherever people look

- Watch all builds on live-view-next PR 4 (binary images and sizes from the viewer), which ships after P3.
- **Watch all**: one watch connection per page carries a 320 px tile per lane at 1 image a second and full images for
  the focused lane; the bound becomes 16 page connections and a byte rate. **Follow what needs attention** moves to a
  lane that failed, got stuck or stopped, and says why.
- A Lanes view from the live Timeline: lanes by shard, a bar per attempt, the usual duration as a ghost bar, amber by
  the Stuck? rule (one rule, not a second threshold); `is:stuck`, `worker:` and `shard:` filters.
- Home and the runs lists show progress from the global `run-progress` event.
- A `::notice` with the live link; a pending commit status for CI runs that are not interactive, opt-in until open
  question 7 is answered, updated at most once a minute.
- OSC 8 links and OSC 9;4 progress in a terminal outside CI; `PIWI_TERMINAL_PROGRESS=off` turns them off.
- CI runs of the branch as read-only sessions in the editors and the Runs window, from the stream the editor already
  holds; their **Watch** opens the same lane view over the instance.
- Addresses RT7, DB14, DB15, DB16, DB20, DB22, LV-12, E24.

### P11. Beyond the image

- The call log in runs Piwi may pause, from the in-process instrumentation listener
  (`context._connection.toImpl(context).instrumentation`): feature-checked, synchronous, removed with the context,
  absent for a connected browser; `_enable()` stays CI-only.
- **Text**: from the trace's ARIA file when present, else `ariaSnapshot` (AI mode, shallow) on request. Playwright 1.64
  writes field values into ARIA snapshots, and the existing maskers read the live page, not a snapshot file: the layer
  ships with a masker of its own for ARIA trees, proven by tests that feed a password, a card number and a short code.
- **Requests and console**, with pending requests and the backend's logged errors (live-view-next Part 3).
- **Filmstrip**: locally from the trace's JPEGs; for the team from the view's own masked images, taken only while
  someone watches and kept in the worker's memory for late joiners (this widens live-view-next D10, which allows only
  the trace's or the video's images).
- **Inspect**: locally, **Open the trace so far** in Playwright's trace viewer, its path never leaving the hub, and the
  desktop app's snapshot view on the same file; for the team, live-view-next Part 4.
- Addresses LV-5, and the layers of [Beyond video](#beyond-video-what-a-live-view-can-show).

### Throughout

The demo mirrors every visible change and API field (`app/demo`); new variables go in `shared/piwi-env-vars.ts`, new
routes carry their OpenAPI meta and permission, new commands go in the CLI reference; the lane view announces stops
and outcome cards to screen readers and keeps a keyboard exit from **Interact**; a change to what the run page loads
runs the performance check.

## Changes to other plans

- **[live-view-next.md](live-view-next.md)** (its PRs 1 to 3 are built): P0 to P3 here come before its PR 4. Its D1 is
  revised (the call is the base, pixels a layer); its D2 amended (pausable runs get their call log from the in-process
  listener); its D10 widened (a team filmstrip from the view's own masked images); Part 1's Stuck? reads stop state;
  Part 5's Follow becomes the default lane view, with **Follow what needs attention** a mode, Watch all built on lane
  watches (answering its open question 6), and "the last 30 seconds" becoming the call-indexed filmstrip; Part 6 is
  rewritten onto the lane view and the local hub; Part 7 also applies to the local sink. D12, VP9 and holding a failing
  CI test (Part 8) stay as written, after P11.
- **[run-control.md](../adr/run-control.md)** (shipped): this plan's ADR supersedes what it extends. Parts 2 and 6: a
  lane-scoped view needs no stop. D5: the desktop app is the fallback hub, piped runs attach unattended. D7: every
  image hides the pause bar and the local stop view is masked. D8: a hub accepts native clients that hold its token.
  D10: an interactive run's stops reach the instance as text. Of its Status's left-out items, the Runs window naming an
  agent's stop is delivered (P6); so are two limits its Status records for the built PRs: the last call ticking and
  the verdict (P4, P5), and code from a desktop run reaching an editor (P7).
- **[desktop-run-progress.md](desktop-run-progress.md)**: the OS surfaces are fed from every local run; the amber
  state comes from stops; app jobs flash once; the thumbnail's buttons act on one run.
- **[developer-loop-audit.md](developer-loop-audit.md)**: §9's one vocabulary is carried out by D6; V1 and V2 are built
  and P0 closes what they left (RT2, DB2), V4 closes with P6, V6 with P6 and P7, R5 with P3, S6 and S7 with P3, R13 with
  P5, D9, D11 and D12 with P5 and P6.
- **Reporter contracts**: contract 3 changes (the stop text of an interactive run while someone has it open; the local
  stop view masked); contract 4 changes (`desktop.json` gains `runChannel` and `hub`).

## Risks

- **Watching becomes observable.** Masking every local image runs on the test's own thread (about 48 ms an image at
  640 px, 2 a second at most while a masked field shows). A watched test runs slower than an unwatched one. One size
  per sink bounds it, and masking can move to a worker thread if the budget fails.
- **More traffic through one server.** A view that follows its lane keeps images flowing for minutes. Hidden views
  close after 10 minutes, and Watch all bounds by bytes.
- **A local stop reaches the instance as text**, whoever watches: the same class of data as a live step,
  but a change to contract 3, said in the docs and the live-view setting.
- **Native hub clients** (D8) widen who can connect to a hub; they need their own security review, with the Windows
  folder check.
- **Version skew across six release trains.** Every message rides `features` or an optional field; lenient readers ship
  first; every surface names the side to update. `follow` is read as `presence` plus `hold` for as long as Runs windows
  that send it are in use.
- **Playwright internals** carry the richest layers: client `_instrumentation`, the in-process listener, the trace
  folder's layout, the screencast's first-client rule. Each is feature-checked with a named fallback and covered by
  the reporter's floor job, and the view says which layers are unavailable.
- **Piped runs that now appear** in an IDE may surprise people; the start line says why and how to opt out.
- **The default trace takes no ARIA snapshots** (#1112). Unless a project's trace sets `snapshots.aria`, the Text
  layer takes `ariaSnapshot` on request (120 to 300 ms on a heavy page), and only the screencast JPEGs come free.
- **Scope.** Twelve phases across every app. Each later phase is usable alone.

## Open questions

1. At an **Interact** stop, should the developer's own local images stay masked, or show the field they type into?
2. Should an interactive run's stop text reach the instance by default, with an opt-out per developer, or only when the
   developer opts in?
3. Should piped runs attach unattended by default, or only with `PIWI_EDITOR=on`?
4. Is the in-process instrumentation listener, Playwright's deepest internal, acceptable for the call log of pausable
   runs, or should those show the call and the element's state only?
5. Should "this window's runs until I stop" expire after a time, or with a branch change? Answered: neither, it ends
   with the window (built in P9).
6. **Ask to watch**: who may ask (any reader, or members only), is each side named to the other, and can a project
   turn it off? Answered: any signed-in reader, the asker named to the developer and the answer shown to the asker,
   and a project setting, on by default (built in P9).
7. The pending pull-request status: on by default where pull-request feedback is set up? A commit status or a check
   run? What is GitLab's equivalent? Answered: the project's own commit status and switch, GitLab's `pending` and
   Bitbucket's `INPROGRESS` (built in P10).
8. Should a run whose test was ended at a stop get a run status of its own rather than a mark (a wire change)?
   Answered: a mark, every status kept (built in P9).
9. JetBrains: keep Swing, fed with the service's words, or host the lane view in JCEF?
10. Should a run with breakpoints stay headed by default, now that a headless stop can be watched?
11. `run_start`: a spec and a line only, or any argument the service's checker accepts? Should an agent's first run in
    a session ask the person?
12. Does Document Picture-in-Picture work from an MV3 extension page, before it is offered in the Runs window?

## Not in this plan

- **A machine registry of runs** (`~/.piwi/runs/<ref>.json`). A run with no Piwi tool open has no local viewer, and the
  main process's hub link carries identity, totals and the verdict to the hub that matters. Revisit if adopting a run
  that started before any tool opened proves worth it.
- **Every host a client of every other hub.** The desktop server reads the editors' sessions; the Runs window gets
  peers; that covers the journeys.
- **A daemon, or a hub inside the reporter.** One more process to install and secure, or FSL hub code inside the MIT
  reporter.
- **Watching your own run by sharing it to the team instance.** The run channel already reaches every local tool.
- **A team page reaching local tools from the browser.** Chrome's Local Network Access prompts, and the hub refuses web
  pages. The team page's existing loopback probe for JetBrains (`useOpenInIde.ts`) is a candidate to move to a
  navigation link too.
- **Playwright's test server as a shared channel.** It serves one client; a second takes the VS Code extension's
  events.
- **`browser.bind` or Playwright's dashboard as everyone's watch channel.** Full control to any local process, and its
  `_enable()` moves Piwi's breakpoints. Both stay explicit hand-offs at a stop.
- **WebRTC and VNC.** CI networks refuse inbound connections; masking must happen before encoding; VNC needs a headed
  browser per machine.
- **A recorder in the page (rrweb and the like).** Contract 6: nothing of Piwi in the page. Playwright's own snapshots
  are taken without it.
- **Following Playwright's video file.** It is written in 256 KiB blocks, the first about 15 s in.
- **Images in the terminal** (kitty, iTerm2, sixel). They break under tmux and in CI logs; the terminal gets the start,
  stop, stuck and end lines and a link to the view.
- **A dormant live-view key for every CI run**, so an admin could turn the view on mid-run. Every CI worker of every
  project would hold a stream while the view is off.
- **A shared custom-element renderer** for five hosts (a VS Code webview, JCEF, an MV3 page, Nuxt, Tauri). One Vue
  `LanePanel` serves the dashboard and the desktop app; the others render the same lane state natively.

## Appendix A. Findings

Ids are those of the analysis: DB (the dashboard), RT (the reporter, the terminal and CI), E (the editors), RW (Piwi
Picker's Runs window), DK (the desktop app), IO (across the tools), LV (seen on the dashboard) and F (seen across the
tools through the showcase). A finding marked "in part" was confirmed with a correction to its scope or evidence. A
plan named in parentheses already lists the finding. Lines are at `e82b429f`.

### The dashboard (DB)

| | Finding | Severity | Where |
|---|---|---|---|
| DB1 | Sharded runs: a worker's live step lands on another shard's row | medium | `packages/reporter/src/public/reporter.ts:731-740` |
| DB2 | A second viewer, or a reload, never sees the step a running test is in | medium | `apps/application/server/api/test-runs/[id]/stream.get.ts:91-116` |
| DB3 | The Watch view hides the failure at the moment the test fails, and ends in a dead end | medium | `apps/application/app/components/run/RunLiveView.vue:20-29, 94-98, 284-308` |
| DB4 | The live list regroups itself as the first test fails and again when it retries | medium | `apps/application/app/components/run/TestCasesList.vue:235-245, 793-799` |
| DB5 | Failures that stream in sit under 'Ungrouped failures' with no cluster | medium | `apps/application/server/utils/persist-run-cases.ts:655` |
| DB6 | A retrying test looks like a first run and links to its failed attempt | medium | `apps/application/app/pages/test-runs/[id].vue:127-130, 253-273` |
| DB7 | Search qualifiers miss every row that streamed in | medium | `apps/application/server/api/test-runs/[id]/events.post.ts:106-117, 182-210` |
| DB8 | The Watch view is a modal that hides the run, one worker at a time (live-view-next Part 5) | medium | `apps/application/app/pages/test-runs/[id].vue:114-124, 1166-1176` |
| DB9 | Every Watch refusal reads the same guess | low | `apps/application/server/api/test-runs/[id]/live-view/watch.get.ts:31-36` |
| DB10 | A shared run's caption shows the previous call while the page holds the current step (live-view-next Part 1 / D2) | low | `packages/reporter/src/internal/capture/live-view.ts:540-575, 608-627` |
| DB11 | Before the first test, the run page says 'No tests recorded for this run.' | low, in part | `apps/application/app/components/run/TestCasesList.vue:1089` |
| DB12 | Turning the live view on cannot help the run that prompted it | low, in part | `apps/application/server/api/test-runs/setup.post.ts:78-82` |
| DB13 | 'Not shared live' names no one and offers no way to ask | low | `apps/application/app/components/run/RunHeader.vue:331-393` |
| DB14 | Home and the runs lists freeze a running run at page load | medium | `apps/application/app/composables/useRunStream.ts:90-106` |
| DB15 | The pull request shows nothing from Piwi while its run runs | low | `apps/application/server/utils/run-finalize-side-effects.ts:151` |
| DB16 | Nothing helps find the stuck or slowest running test among many workers (live-view-next Part 5) | low | `apps/application/app/components/run/TestCasesList.vue:313-316` |
| DB17 | Image and call log cannot be seen together on a laptop; the image is small (live-view-next Part 7) | low | `apps/application/app/components/run/RunLiveView.vue:215-219, 299-308` |
| DB18 | The same action has different names and lifetimes across tools (developer-loop-audit §9 lists other actions' names) | low | `apps/application/app/components/run/TestRowLiveWorker.vue:49-59` |
| DB19 | The header's primary action depends on when the page was opened | low | `apps/application/app/components/run/RunHeader.vue:107-118` |
| DB20 | No run-level signal that a running run is slower than usual (live-view-next Part 1) | low | `apps/application/app/components/run/RunHeader.vue:333-338` |
| DB21 | Links into a live run cannot open the Watch view (live-view-next Part 6) | low | `apps/application/shared/notification-events.ts:739-743` |
| DB22 | A sharded run does not say which shards have started | low | `apps/application/app/components/run/RunHeader.vue:399-402` |

### The reporter, the terminal and CI (RT)

| | Finding | Severity | Where |
|---|---|---|---|
| RT1 | A developer cannot watch a running headless local test's page anywhere on their own machine | medium | `packages/reporter/src/internal/capture/run-channel.ts:854-861` |
| RT2 | Live steps start up to ~17 s after someone opens a run during its first 15 s (developer-loop-audit V2) | low, in part | `packages/reporter/src/internal/streaming/stream-manager.ts:302-303, 345-357, 514-532, 541-555` |
| RT3 | One failed /start or /begin hides the whole run until it ends, even if the instance is back seconds later | medium | `packages/reporter/src/internal/streaming/stream-manager.ts:178-200, 313-327, 626-633` |
| RT4 | A CI worker's live view dies for good after a 31 s outage or an instance restart, and the CI log never says so | medium | `packages/reporter/src/internal/capture/live-view.ts:62-66, 304-315, 399-420, 476-501` |
| RT5 | The CI log says 'Live view on' for a run nobody can watch because the specs skip the capture fixtures | low | `packages/reporter/src/public/reporter.ts:572-591, 697-708, 141-152` |
| RT6 | Every 'unregistered' live view message blames a missing wrapConfig, whatever the cause | low | `packages/reporter/src/public/reporter.ts:572-580` |
| RT7 | No CI-native place links to the live run while it runs | medium | `packages/reporter/src/internal/support/ci-output.ts:47-56` |
| RT8 | A CI job that reaches the instance by an internal name prints links nobody can open | medium, in part | `packages/reporter/src/internal/support/run-url.ts:2-3` |
| RT10 | The live view caption names the call without its locator, unlike its own call log and the docs | low, in part | `packages/reporter/src/internal/capture/capture-fixtures.ts:2364-2398` |
| RT11 | `test.step` names never stream live, while Piwi's own fixtures do | low | `packages/reporter/src/public/reporter.ts:675-687` |
| RT12 | A terminal run that does not follow its editor says nothing about why | low, in part | `packages/reporter/src/internal/config/editors.ts:57-74` |
| RT13 | No address for a worker's live view, and a view ends with each test (live-view-next) | medium | `apps/application/app/pages/test-runs/[id].vue:738, 861-916` |
| RT14 | After an instance restart or a setting toggle, a shared local run can never be shared again, though the docs say Share live shows again | low | `packages/reporter/src/internal/capture/live-view.ts:219-226, 307-312, 409-410, 476-485` |
| RT15 | The run link is buried among plumbing lines that are still printed at info (developer-loop-audit R10 and R13) | low | `packages/reporter/src/public/reporter.ts:422-427` |
| RT16 | During a long global setup the run is on the dashboard but the log has no link to it | low | `packages/reporter/src/public/global-setup.ts:221` |
| RT17 | 'This test has no page to show yet' for tests whose pages are not the `page` fixture (live-view-next) | low, in part | `packages/reporter/src/internal/capture/capture-fixtures.ts:3869-3880` |
| RT18 | With wrapConfig's default trace, the live view is 720–800 px at quality 90, not the documented 640×400 at quality 50 (adr/run-control) | low, in part | `packages/reporter/src/public/config-wrapper.ts:16-19` |

### The editors (E)

| | Finding | Severity | Where |
|---|---|---|---|
| E1 | A headless test's page can be seen only while it is stopped, never while it runs | high | `packages/editor/src/run-sessions.ts:815-856, 1268-1274, 1303-1313` |
| E2 | The editor never shows which call or line a running test is at, though agents get every call with its place | medium | `packages/core/src/run-channel.ts:326-332` |
| E3 | Progress, running icons and per-test results come only from the instance round trip, though the run channel has them locally | medium | `packages/editor/src/run-watch.ts:1-11, 364-365` |
| E4 | While your run is in progress, the status bar's only run link opens the previous run | medium, in part | `packages/editor/src/server.ts:1466-1476` |
| E5 | The editor's own run disappears from the status bar when the active file belongs to another Playwright config | low | `apps/vscode/src/glue.ts:151-163, 225-228` |
| E6 | Neither editor lists what each worker runs now; Piwi Picker's Runs window and the desktop tray do | low, in part | `apps/vscode/src/run-control.ts:536-585` |
| E7 | Pause is all or nothing: no per-test Pause and no 'Pause and watch' in the editor | low | `apps/vscode/src/run-view.ts:926-931` |
| E8 | With several workers, every new stop takes the focus and the single paused-page panel, ending the view in use | medium | `apps/vscode/src/run-view.ts:223-227, 351-355, 429-433, 542-555` |
| E9 | Stepping a headless test blanks the image and restarts the stream at every step | medium, in part | `apps/vscode/src/run-view.ts:456-496, 556-562` |
| E10 | Whether a run is headed depends on any breakpoint under the config's folder, application code included | low | `apps/vscode/src/breakpoints.ts:36-47` |
| E11 | The editor has no way to run headed or to hold a headless failure; the desktop tray has Hold failures, the Runs window holds by being open | medium | `packages/editor/src/server.ts:1714, 1749, 3187, 3225` |
| E12 | Verify ×3, the fix plan's verification and the Flake Lab lines run without the run channel: no Pause, no Stop, no page | low | `packages/editor/src/server.ts:649-651, 3309-3336, 696-701, 2490-2501` |
| E13 | The paused page has no controls: Resume, Step and the code actions live elsewhere | low | `apps/vscode/src/run-control.ts:993-997` |
| E14 | JetBrains' status bar replaces the run's progress while a test is stopped or the run is shared | low | `apps/jetbrains/src/main/kotlin/dev/piwitests/jetbrains/PiwiStatusBar.kt:117-141` |
| E15 | Interact resets at every stop in the editors; the Runs window and the tray take input as soon as you watch | low | `apps/vscode/src/run-view.ts:376, 466-473` |
| E16 | 'Watch' means a running test on the dashboard, but 'Watch live' means a stopped page in the editor | low | `apps/vscode/src/run-control.ts:996` |
| E17 | The paused page reopens itself at every headless stop, with no way to opt out | low | `apps/vscode/src/run-view.ts:429-462, 554` |
| E18 | At a headed stop the editor cannot bring the test's browser forward | low, in part | `apps/vscode/src/run-view.ts:313-316, 957-962` |
| E19 | The page's console errors, uncaught errors and failed requests reach agents, never the person in the editor | medium | `packages/core/src/run-channel.ts:326-332` |
| E20 | Share live offers to copy the run page's link, never to open it | low | `apps/vscode/src/run-view.ts:727-731` |
| E21 | JetBrains' Run tool window names every Piwi run 'Piwi' and has no Pause or Step (adr/run-control) | low | `apps/jetbrains/src/main/kotlin/dev/piwitests/jetbrains/PiwiCommands.kt:246-256, 337-341` |
| E22 | 'did not reach … is the Piwi reporter in the Playwright config?' shows even when the run's workers attached with the reporter | low | `packages/editor/src/run-watch.ts:441-447` |
| E23 | The Testing view's test runs carry no output and do not show a stopped test | low | `apps/vscode/src/test-explorer.ts:338-361, 465-470` |
| E24 | A CI run of the branch in progress shows in the editor as a count only: no Watch, no line (proposals/live-view-next) | low | `apps/vscode/src/glue.ts:116-125` |
| E25 | The terminal runs page says only Piwi Picker can watch a stop live; the editor's paused page can too | low | `apps/docs/features/terminal-runs.md:22-24` |

### Piwi Picker's Runs window (RW)

| | Finding | Severity | Where |
|---|---|---|---|
| RW1 | A running test's page cannot be seen in the Runs window: the view exists only at a stop | high | `packages/core/src/run-hub.ts:301-306` |
| RW2 | Nothing outside the window says a test stopped or failed | low, in part | `apps/extension/runs.html:6` |
| RW3 | A hub connection lost mid-stop makes the run vanish, and Watch live does not come back on its own | low | `apps/extension/src/background/run-hubs.ts:172-176, 491-504` |
| RW4 | Watch live silently turns off when Playwright replaces a worker after a failure | low | `apps/extension/src/shared/runs.ts:439-441` |
| RW5 | A click on the live view goes straight to the page, where both IDEs ask for 'Interact' first | medium | `apps/extension/src/runs/main.ts:642-666, 1563` |
| RW6 | At a headless stop, Pick, Record and Assert are hidden until Watch live, with no hint | low, in part | `apps/extension/src/shared/runs.ts:296-318` |
| RW7 | The controls sit under the image and jump at every Step; a phone-sized page pushes them off screen | medium, in part | `apps/extension/src/runs/main.ts:1469-1491, 1609-1622` |
| RW8 | No run-level controls: Pause and Resume one worker at a time, and no Stop | low | `apps/extension/src/runs/main.ts:1268-1270, 1061-1134` |
| RW9 | Several stopped workers stack full-width images, and nothing brings the new stop into view | medium | `apps/extension/src/runs/main.ts:1109, 1469-1491, 1551-1603` |
| RW10 | No progress or result, and the run page only as 'Copy' while shared | medium, in part | `packages/core/src/run-hub.ts:189-235` |
| RW11 | With an editor paired, a broken desktop app pairing is never shown | low | `apps/extension/src/runs/main.ts:969-1014` |
| RW12 | Nothing on the path to pairing mentions the Runs window (developer-loop-audit S6 lists the hidden tile) | medium | `apps/extension/public/_locales/en/messages.json:960, 1466` |
| RW13 | Opening the window mid-run does not hold a terminal run's failures, and the window never says whether it holds them | medium | `packages/editor/src/run-sessions.ts:541-545, 1113-1124` |
| RW14 | No 'Pause and watch': the desktop app pauses and watches in one click, the Runs window takes two steps and a wait | low | `apps/extension/src/runs/main.ts:1268-1269, 1557-1558` |
| RW15 | Frames are sent at up to 1280×800 for a view about 370 px wide (live-view-next Part 7) | low, in part | `packages/core/src/run-view.ts:11-21` |
| RW16 | The window forgets where the person placed it | low | `apps/extension/src/background/runs-window.ts:23, 123-124` |
| RW17 | No keys for Resume, Step and Finish in the window | low | `apps/extension/src/runs/main.ts:769-773, 699-724, 1378-1428` |
| RW18 | 'Editor' wording for the desktop app's runs and failures (developer-loop-audit §9 row 'The desktop app's runs') | low | `apps/extension/runs.html:566, 581` |
| RW19 | A hidden or minimized window still holds every headless failure (developer-loop-audit V4) | medium | `apps/extension/src/runs/main.ts:776-783` |
| RW20 | Esc never reaches the page, so the picker started through the view cannot be skipped (developer-loop-audit D9) | low | `apps/extension/src/shared/view-input.ts:83` |
| RW21 | Pick on the image says the locator was sent even with no editor to take it, and offers no Copy (developer-loop-audit D11) | low, in part | `apps/extension/src/runs/main.ts:765, 1494-1500` |
| RW22 | The run shortcut and Look again give no sign; the shortcut also pauses the desktop app's unattended runs (developer-loop-audit D12) | low | `apps/extension/src/background/index.ts:161-164` |
| RW23 | An unproven pairing is retried forever, and a 404 reads as an outdated editor (developer-loop-audit S6) | low | `apps/extension/src/background/run-hubs.ts:506-516, 534-537` |
| RW24 | An agent's stop is not told apart (adr/run-control) | low | `packages/core/src/run-hub.ts:95-96` |
| RW25 | A request the worker drops leaves the worker's buttons waiting forever | low, in part | `apps/extension/src/runs/main.ts:187-204, 226-246` |

### The desktop app (DK)

| | Finding | Severity | Where |
|---|---|---|---|
| DK1 | A running headless test of a desktop run can never be watched without stopping it: the desktop build refuses the live view | high | `apps/application/server/api/test-runs/setup.post.ts:78-82` |
| DK2 | Pause (and Pause and watch) on a test stuck inside a call shows 'Pausing…' until that call times out | medium | `packages/reporter/src/internal/capture/pause-at.ts:528-538` |
| DK3 | No way to start a run with Hold failures or Watch live on; both reset with each run | low, in part | `apps/application/app/composables/useDesktopLocalRuns.ts:979, 994-996` |
| DK4 | The test page's 'Run this test' (×20) is a run nobody attends: it can never stop at the failing repetition | low | `apps/application/app/pages/test-cases/[id].vue:51-52, 194-201` |
| DK5 | One run, two half-views: the tray and the run page each lack what the other has | medium | `apps/application/app/pages/test-runs/[id].vue:106-112` |
| DK6 | The live view is confined to the 600px tray; only the console can be popped out (proposals/desktop-native) | medium | `apps/application/app/components/desktop/DesktopLocalRunsTray.vue:255, 282` |
| DK7 | Each Step makes the worker's page vanish and reload: layout jumps and the view restarts | medium, in part | `apps/application/app/components/desktop/DesktopRunWorker.vue:259-282` |
| DK8 | A bisect's bad steps (and the app's other runs) flash 'Run failed' and ask for attention on the OS shell | medium | `apps/application/server/api/desktop/events.get.ts:37-44` |
| DK9 | A test held at a stop looks like a running test on every surface outside the tray (proposals/developer-loop-audit) | medium, in part | `apps/application/app/components/desktop/DesktopLocalRunsTray.vue:94-114` |
| DK10 | A Re-run that reports to the team instance is invisible to the app's run links and OS progress | medium | `apps/application/app/composables/useDesktopLocalRuns.ts:1142-1170, 806-826` |
| DK11 | A terminal run in a linked folder can be followed only by an editor, never by the app, yet the app says 'See its page at a stop' | medium | `packages/reporter/src/internal/config/editors.ts:17-27, 183-200` |
| DK12 | An editor's run that reports to the app reads as running on the app's run page while it is paused in the editor | medium | `apps/application/app/composables/useDesktopRunHub.ts:184-188` |
| DK13 | After a reload, the window never re-attaches to runs still going in the hub (proposals/developer-loop-audit) | medium | `apps/application/app/components/desktop/DesktopLocalRunsTray.vue:57, 73-78` |
| DK14 | Opening an analytics dashboard in TV mode closes the runs' hub stream and every separate output window | low | `apps/application/app/layouts/default.vue:599` |
| DK15 | The tray opens on a stop but does not bring the stopped worker into view | low | `apps/application/app/components/desktop/DesktopLocalRunsTray.vue:94-104, 133-151, 282-300, 399-409` |
| DK16 | The tray's stop place and its code are copy-only; the run page links the same place to the IDE | low | `apps/application/app/components/desktop/DesktopRunWorker.vue:266-269` |
| DK17 | One run, many names: Live in Piwi, Open run, Show its page, Watch live vs Watch, Piwi vs Piwi Dashboard (proposals/developer-loop-audit) | low | `apps/application/app/components/desktop/DesktopLocalRunsTray.vue:375-385` |
| DK18 | The app's runs reach Piwi Picker and agents with no title or command | low | `apps/application/server/utils/desktop-runs.ts:345-349` |
| DK19 | Windows thumbnail Open may not restore a minimized window; Stop is always enabled and stops every run (proposals/developer-loop-audit) | low | `apps/desktop/src-tauri/src/taskbar_win.rs:105-113, 137-150` |
| DK20 | Stopping one local run drops every newer active run of its project from the OS progress bar | low | `apps/application/app/plugins/desktop-run-progress.client.ts:189-204` |
| DK21 | The run's end leads to the run, not the failure; the stopped page vanishes with the session | low | `apps/application/app/composables/useDesktopLocalRuns.ts:717-835` |
| DK22 | The taskbar, Dock, title, tray dot and thumbnail buttons are still in no docs page (proposals/developer-loop-audit) | low | `apps/docs/features/desktop.md:43-49` |

### Across the tools (IO)

| | Finding | Severity | Where |
|---|---|---|---|
| IO1 | A local run's page can be watched only at a stop; watching it while it runs means sharing it with the team instance | high | `packages/core/src/run-hub.ts:302-306, 582-586` |
| IO2 | A run has no shared identity: hub refs, dashboard ids and run pages never meet | high | `packages/core/src/run-hub.ts:203-235` |
| IO3 | A run a coding agent starts from its shell is invisible to the agent's own run tools | medium | `packages/reporter/src/public/reporter.ts:363-367` |
| IO4 | The Runs window never finds an editor window that opens after it connected | high | `apps/extension/src/background/run-hubs.ts:432-454, 497-516, 530-533` |
| IO5 | No surface sees every run on the machine, and a run with no hub gets the dead-end note 'See its page at a stop' | medium | `packages/reporter/src/internal/config/editors.ts:17-27` |
| IO6 | Desktop app runs never reach an open editor: code is copy-only and the stop's place is not a link (developer-loop-audit) | medium | `apps/desktop/src-tauri/src/hub_env.rs:85-107` |
| IO7 | No surface knows who else is watching or steering a stop, and agent stops look like the person's in the Runs window (adr/run-control) | medium | `packages/editor/src/run-sessions.ts:325-334, 557-570` |
| IO8 | Whether a failure is held depends on which tool happens to be open, and an agent's follow never counts (developer-loop-audit) | medium | `packages/editor/src/run-sessions.ts:541-545, 557-566, 1110-1124` |
| IO9 | The same worker has a different number on each surface | low | `apps/extension/src/runs/main.ts:1236` |
| IO10 | Runs vanish or freeze in the Runs window when the hub is newer, and nothing negotiates features | low, in part | `packages/core/src/run-hub.ts:658-661, 728-757, 760-774, 348-355` |
| IO11 | The team instance marks a paused local test Stuck?, and a full local run notifies the team | medium | `apps/application/server/utils/stuck-tests.ts:24-80` |
| IO12 | An agent's runs server is one per workspace, copied under one name into user scope, and agents cannot discover it | medium, in part | `apps/vscode/src/extension.ts:221, 420-425, 1337-1339` |
| IO13 | VS Code connected to the desktop app gives its agent two sets of run tools with the same names | low | `packages/editor/src/server.ts:3486-3508` |
| IO14 | The Runs window shows nothing of a running test or of a finished run, though an agent gets the call stream | medium | `packages/core/src/run-hub.ts:171-185` |
| IO15 | 'Not shared live' is a dead end for the teammate, and the developer does not know someone is waiting | low | `apps/application/app/utils/live-row-note.ts:22-26` |
| IO16 | Sharing ends in copy-paste, and a run that no hub steers cannot be shared at all | low | `apps/vscode/src/run-view.ts:723-731` |
| IO17 | The team run page says 'Paused' for every stop, a held failure and an agent's stop included | low | `apps/application/app/components/run/TestRowLiveWorker.vue:16-37` |
| IO18 | One concept, several words, and one word for several concepts (developer-loop-audit) | low | `apps/extension/public/_locales/en/messages.json:7918-7920, 7409, 7567` |
| IO19 | Input on a watched page needs Interact in the editors but is on with Watch live in the Runs window and the tray | low | `apps/vscode/src/run-control.ts:996` |
| IO20 | The terminal's stop line names neither the editor nor the Runs window, nor who stopped the test | low | `packages/reporter/src/internal/capture/capture-fixtures.ts:1970-1975` |
| IO21 | Closing the VS Code window that holds the pairing port cuts the Runs window off from every other window (developer-loop-audit) | low, in part | `apps/vscode/src/extension.ts:876-879` |
| IO22 | A locator picked on the image of a terminal run's stop cannot be copied from the Runs window (developer-loop-audit) | low, in part | `apps/extension/src/runs/main.ts:13, 747-766, 1191` |
| IO23 | An agent sees less of a run's context than a person | low | `packages/editor/src/run-agent.ts:916-930, 408-514` |

### Seen on the dashboard (LV)

| | Finding | Severity |
|---|---|---|
| LV-1 | A few dashboard tabs open stop the run page from ever going live: it says 'Live view connecting' and 'No tests recorded' for the whole run | high |
| LV-2 | The view of a failing test ends with a neutral 'The test ended.' and hides the error | high |
| LV-3 | A run page opened in the first seconds of a run shows no live step for up to 15 s | medium |
| LV-4 | A view never follows its worker: every test needs close, find the row, Watch again | medium |
| LV-5 | Phone and laptop: the image is unreadable at 390 px, and at 1366x720 the call log falls below the fold | medium |
| LV-6 | Watch buttons move under the pointer while steps stream | low |
| LV-7 | The modal re-centers as the call log grows, so the image jumps up and down | low |
| LV-8 | Worker names disagree: the live view uses Playwright's workerIndex ('Worker 3' in a 1-worker run) and the timeline its lanes ('Worker 0–3') | low |
| LV-9 | The run ending with a view open is not said: the view still reads '· live' and 'The test ended.' | low |
| LV-10 | A terminal run cannot be shared, and its terminal says nothing; the viewer only sees 'Not shared live' twice | medium |
| LV-11 | An initializing run reads 'No tests recorded for this run.' | low |
| LV-12 | Home and the runs list say almost nothing about a running run | low |
| LV-13 | A list whose /api/stream opens after a run started keeps its server-rendered rows until the run ends | low |
| LV-14 | Internal steps show as the running test's current step | low |

### Seen across the tools, through the showcase (F)

| | Finding | Severity |
|---|---|---|
| F1 | Dashboard Watch on a CI run dies at the end of the first watched test; there is no way to follow a worker | high |
| F2 | You can't see your own stopped run in the dashboard without broadcasting it to the team, and the run is hidden by default | high |
| F3 | The Runs window and VS Code never link a run to its dashboard page; ended runs say nothing of their outcome | medium |
| F4 | A CI run looks like a local run in VS Code, and no tool but the dashboard lets you watch it | medium |
| F5 | Three separate live views of the same stop, and every live frame paints Piwi's controls into the picture | medium |
| F6 | Share live and Watch live are lost on every new run, so a teammate's view breaks at each re-run | medium |
| F7 | Runs window's image of the first stop was tiled 2×2; the showcase check doesn't catch it | medium |
| F8 | After an edit at a stop, the tools disagree on the line | low |
| F9 | Terminal runs: piped output skips the editor silently, and stops offer fewer code actions than the page bar | medium |
| F10 | Stopping a share is one unconfirmed click on what looks like a status indicator | low |
| F11 | The Runs window shows nothing of a running test, only stops | medium |

## Appendix B. Every origin against every watcher

As the code stood at `e82b429f`. "Steps" are the run page's live steps; a "stop" is a breakpoint, a step, Pause,
`page.pause()` or a held failure.

| Origin → watcher | While a test runs | At a stop | Controls | Share | Where |
|---|---|---|---|---|---|
| Terminal (a person's TTY, an editor open on the folder) → Team dashboard run page | Live steps while the page is open. 'Not shared live' on running rows when the project's live view is on. No page. | Unshared: the last step keeps ticking, then Stuck? (the instance does not know the stop). Shared: 'Paused · call', and Watch shows frames. | None (run-control D8). | Cannot share; it can only show a page someone shared from a hub surface. | `apps/application/app/utils/live-row-note.ts:22-26` |
| Terminal → Desktop app window and tray | Only when the run reports to the app (no team instance named): run page with live steps. The tray shows nothing (not its hub). | 'See its page at a stop' on the run page; the stop itself shows only in the editor and the Runs window. | None. | No (the app hands out no key). | `apps/application/app/components/shared/TestRow.vue:380-387` |
| Terminal → Editor (the window whose workspace holds it) | The session marked 'run in a terminal'; Pause in the status bar; no current call. | Execution point and CodeLens 'Paused · … · run in a terminal'; paused page image; Watch live plus Interact. | Pause, Resume, Step, Run to cursor, Finish, End the test; Assert a region and Mock a request (written). No Stop. No Pick or Record in the test's window. | Share live command (team instance), Share with Playwright tools. | `apps/vscode/src/run-control.ts:235-241` |
| Terminal → Runs window (Piwi Picker) | 'Terminal' badge, each worker's test, 'Running'. Missing if its editor window opened after the Runs window connected (IO4). | Image, Watch live with input, Pick on the image (locator shown, no Copy). | Pause, Resume, Step, Finish, End the test, Mock a request, Assert a region at a watched headless stop. | Share live; Copy the run page's link once shared. | `apps/extension/public/_locales/en/messages.json:7567` |
| Terminal → Agent over MCP (the editor window's piwi-runs) | `run_list` lists it with no terminal flag; `run_follow` gives call and page events while it follows. | `stopped` event; `page_snapshot` (ARIA, image on request). | `run_control` (pause, step, run-to, resume, finish, end), `page_act`, `code_write` through the editor. | Never (a person's choice). | `packages/editor/src/run-agent.ts:404-535` |
| Terminal → The terminal itself | 'Following this run in Visual Studio Code (pid …)', 'View live progress: <url>', Playwright's output. | '[piwi] Paused at … before …: Resume, Step or Finish in the editor.' | Ctrl+C only. | No. | `packages/reporter/src/public/reporter.ts:368-371` |
| VS Code (Piwi's run) → Team dashboard run page | Live steps; origin 'editor'; 'Not shared live' when keyed. | Unshared: a ticking step, then Stuck? (no notification: 'editor' is excluded). Shared: 'Paused', Watch. | None. | No. | `apps/application/shared/run-eligibility.ts:203-208` |
| VS Code → Desktop app window and tray | When VS Code reads the desktop app: run page live steps; tray nothing. | 'See its page at a stop' (the stop is in VS Code). | None. | No. | `apps/application/app/components/shared/TestRow.vue:380-387` |
| VS Code → Editor (VS Code itself) | Status bar Pause and Stop, progress counts. | Execution point, CodeLens, paused page (image, Watch live, Interact), locator match count at the caret. | Every control, Stop included; Pick, Record, Assert, Assert a region, Mock a request. | Share live, Share with Playwright tools. | `apps/vscode/src/run-view.ts:1-22` |
| VS Code → Runs window (Piwi Picker) | Folder, command, each worker's test, 'Running'. | Image, Watch live with input, every code action including Pick and Record in the test's window. | Pause, Resume, Step, Finish, End the test, the code actions (Run to cursor stays in the editor). | Share live, Copy link. | `apps/docs/features/runs-window.md` |
| VS Code → Agent over MCP | VS Code's own agent gets 'Piwi runs' registered automatically; others copy the configuration. `run_follow` events. | `page_snapshot`, `page_locator`. | `run_control`, `page_act`, `code_write` (written by VS Code, one undo). | Never. | `apps/vscode/src/extension.ts:1415-1433` |
| VS Code → The terminal itself | The task terminal's Playwright output and reporter lines. | The [piwi] stop line (headless) or the pause bar in the browser (headed). | The task's Stop or Ctrl+C. | No. | `apps/vscode/AGENTS.md` |
| JetBrains IDE (Piwi's run, or the IDE's own runner) → Team dashboard run page | As VS Code. The IDE runner's run is origin 'local' with no ref. | As VS Code; Stuck? after the threshold. | None. | No. | `packages/reporter/src/internal/collect/metadata-collector.ts:139-156` |
| JetBrains IDE → Desktop app window and tray | When the project reads the app: run page steps only. | 'See its page at a stop'. | None. | No. | `apps/application/app/utils/live-row-note.ts:24` |
| JetBrains IDE → Editor (the IDE) | Status bar item's menu with Pause; a runner run is labeled 'run by the editor's test runner'. | Inlay 'Paused · …', paused page with Watch live and Interact. | Every control (the debugger's shortcuts). Stop is the Run tool window's own. A runner run gets no Pick or Record in the test's window. | Tools → Piwi → Share the Run Live. | `apps/jetbrains/src/main/kotlin/dev/piwitests/jetbrains/Glue.kt:1426-1437` |
| JetBrains IDE → Runs window (Piwi Picker) | Listed through the same pairing; a runner run is marked 'Test runner'. | As VS Code (a runner run as a terminal run). | As VS Code. | Share live. | `apps/extension/public/_locales/en/messages.json:7571` |
| JetBrains IDE → Agent over MCP | The project's runs server (copied as http, or through mcp-remote for the AI Assistant). | `page_snapshot`. | The same seven tools. | Never. | `apps/jetbrains/src/main/kotlin/dev/piwitests/jetbrains/Glue.kt:1102-1109` |
| JetBrains IDE → The terminal itself | The Run tool window's console. | The [piwi] line, or the pause bar when headed. | The Run tool window's Stop. | No. | `apps/docs/features/terminal-runs.md:7-16` |
| Desktop app (Re-run, reproduce, bisect, Flake Lab) → Team dashboard run page | Only a Re-run in a folder naming the team instance reports there: steps; 'Not shared live'. | Once shared from the tray: 'Paused', Watch. | None. | No (the tray shares). | `apps/docs/features/desktop-runs.md:92-104` |
| Desktop app → Desktop app window and tray | Tray: each worker, Running, Pause, Hold failures, output. Run page: Pause and watch. 'Live in Piwi — Run #N' when it reports to the app. | The tray opens on the stop: image, Watch live with input, Pick on the image, Assert a region, Mock a request; run page 'Show its page'. | Every control but Run to cursor; code to copy. | Share live (a run reporting to a team instance); Copy the run page's link. | `apps/application/app/components/desktop/DesktopLocalRunsTray.vue:365` |
| Desktop app → Editor | Nothing: the run never follows an editor (PIWI_ORIGIN and PIWI_RUN_CHANNEL set). | Nothing. A reproduction the editor asked for only polls the verdict. | None. | No. | `packages/reporter/src/internal/config/editors.ts:60-61` |
| Desktop app → Runs window (Piwi Picker) | With the app paired too: 'Desktop app' badge, workers. | Image, Watch live; Pick, Record and Assert in the window are refused. | Pause, Resume, Step, Finish, End the test, Assert a region and Mock a request (code to the app's window). | Share live. | `apps/application/server/utils/desktop-runs.ts:115-127` |
| Desktop app → Agent over MCP | The app's /mcp run tools, attended runs only; the editor's piwi-runs sees nothing. | `page_snapshot`; the stops it asked for hold only while the app's window is open and go on two minutes after its last call. | The seven tools; `code_write` makes code to copy in the tray, and returns it in the answer. | Never. | `apps/application/server/utils/mcp/run-tools.ts:1-28` |
| Desktop app → The terminal itself | No terminal: output in the tray or its own output window. | The tray opens. | Stop in the tray or the output window. | No. | `apps/docs/features/desktop-runs.md:37-42` |
| CI → Team dashboard run page | Live steps; Watch (live view on and wrapConfig) with the call log, action point and match count; Stuck? plus test.stuck. | Never stops. | None. | The page URL; share links cover executions only. | `apps/docs/features/live-view.md:47-58` |
| CI → Desktop app window and tray | Nothing. | n/a | None. | No. | `apps/application/server/utils/desktop-runs.ts:1-5` |
| CI → Editor | The branch's running CI run as progress counts in the status bar. | n/a; failures after. | None. | No. | `packages/editor/src/run-watch.ts:3-4` |
| CI → Runs window (Piwi Picker) | Nothing (live-view-next Part 6 proposes a read-only list). | n/a | None. | No. |  |
| CI → Agent over MCP (instance) | `list_runs` with status running, `get_run` counts; no current call, no image. | n/a | None (`rerun_cluster_in_ci` afterwards). | No. | `apps/application/shared/mcp-tools.ts:188` |
| CI → The terminal itself | The CI log: '[Piwi Dashboard] Live view on: …' or why not; View live progress. | n/a | Cancel the job. | No. | `apps/docs/features/live-view.md:30-36` |
| Agent (shell tool, piped output) → Team dashboard run page | Steps; origin 'local' with no ref; 'Not shared live' when keyed. | With PIWI_EDITOR=on and an editor open: a stop the instance does not know about, then Stuck?. | None. | Cannot be shared (no hub). | `packages/reporter/src/internal/collect/metadata-collector.ts:139-146` |
| Agent (shell tool) → Desktop app window and tray | When it reports to the app: run page steps; tray nothing. | Never stops; 'See its page at a stop' is a dead end. | None. | No. | `apps/application/app/utils/live-row-note.ts:24` |
| Agent (shell tool) → Editor | Nothing: the output goes to a pipe, so the run follows no editor. | n/a | None. | No. | `packages/reporter/src/internal/config/editors.ts:72` |
| Agent (shell tool) → Runs window (Piwi Picker) | Nothing. | n/a | None. | No. | `packages/reporter/src/internal/config/editors.ts:57-74` |
| Agent (shell tool) → Agent over MCP | `run_list`: 'No run of this editor window runs now: start one from the editor.' | n/a | None over its own run. | No. | `packages/editor/src/run-agent.ts:391` |
| Agent (shell tool) → The terminal itself | The piped output, as the agent's tool returns it; no 'Following' line. | n/a | Its tool's timeout or kill. | No. | `packages/reporter/src/public/reporter.ts:368-372` |

## Appendix C. How the analysis was done

- **Reading.** Six analysts each mapped one area from the user's side (the dashboard; the reporter, the terminal and
  CI; the editors; the Runs window; the desktop app; the seams between tools), walking its journeys and citing a file
  and line for every finding. A second reader per area then tried to refute each finding against the code and the git
  history, and kept it only when the code showed it: 108 confirmed, 26 confirmed with a correction, 1 refuted.
- **Running.** One session drove the dashboard's live view on real runs: the dev server over HTTP/1.1, a small shop
  suite with a slow button, a failing test and a flaky one, CI-like and local runs, one and four workers, phone and
  laptop widths, timings sampled every 20 to 150 ms. The other played the showcase's beats on the real tools (VS Code
  1.143 with the extension, the editor service, Piwi Picker's Runs window, the dashboard, the reporter, the test's
  browser) under Xvfb, and probed each tool between beats. The desktop app and the JetBrains plugin were read, not run.
- **Playwright.** The installed 1.64.1 was read for what it offers a live view (screencast, debugger, live traces, the
  trace viewer, the test server, `browser.bind`, ARIA snapshots, instrumentation), with small scripts on Chromium for
  the claims that mattered; Firefox and WebKit were read only.
- **Prior art.** Session replays, cloud browsers' live views, test runners' live results, debug protocols and
  multi-client tools were read for what makes several surfaces feel like one tool.
- **Design.** Four designs were drawn independently from the findings (interop first, layers beyond video, journeys
  first, risk first), scored, merged, and checked by a critic against every finding and the code; its corrections are
  in the plan.
