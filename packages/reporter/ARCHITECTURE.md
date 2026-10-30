# Reporter architecture

A map for contributors. The `@piwitests/reporter` package collects Playwright
test results and sends them to a Piwi Dashboard server. It also ships the `piwi`
command line (`src/cli/`) and the agent skills that `piwi init` installs
(`templates/skills/`). The rules to follow when you change it are in
[`AGENTS.md`](AGENTS.md).

## Public and internal code

If it's exported from **`src/index.ts`** (the `.` entry, the package's single
public surface), it's the **public API** and changing it is a breaking
change. Everything under **`src/internal/`** is private plumbing, except the
capture modules the dashboard's own tests import (see [Build output](#build-output)).

| Public surface | Where | What |
|---|---|---|
| `PiwiDashboardReporter` (default + named) | `public/reporter.ts` | the Playwright reporter |
| `wrapConfig` | `public/config-wrapper.ts` | injects the reporter and the global setup into a Playwright config |
| `createGlobalSetup` | `public/global-setup.ts` | registers the run before the user's own `globalSetup`, after checking each `baseURL` answers when `checkBaseUrl` is on |
| `resolveSelection` | `public/selection.ts` | resolves `PIWI_SELECTION` from an ESM config, returns a grep and stamps the run |
| `piwiFixtures`, `extendPiwiFixtures` | `internal/capture/capture-fixtures.ts`, re-exported by `index.ts` | the capture fixtures (imported from `@piwitests/reporter`) |
| `piwiAiFixtures`, `extendPiwiAi` | `internal/ai/ai-fixtures.ts`, re-exported by `index.ts` | the AI-step fixtures (`page.piwiLocator`, `page.piwiRun`), replayed from committed artifacts |
| `PiwiDashboardOptions`, `PlaywrightTestConfig` | `public/options.ts` | the options type (types) |
| `PiwiFixtures`, `PiwiWorkerFixtures`, `PiwiAi`, `AiMode`, `AiOnMiss` | `internal/capture/capture-fixtures.ts`, `internal/ai/ai-fixtures.ts` | the fixtures' types |
| `ResolveSelectionResult`, `ResolveSelectionOptions` | `public/selection.ts` | `resolveSelection`'s types |
| `PiwiConfig`, `PiwiCodegenConfig` | `public/piwi-config.ts` | the `'@piwi'` section of a Playwright config, which the editor service reads |

Two **external contracts** beyond the npm API:

- **Wire types** (`types/wire.ts`): the JSON sent to and received from the server.
  The small leaf shapes (`BrowserConfig`, `TestStepEvent`, …) are re-exported from
  `@piwitests/core/wire`. The per-case `WireTestCase` and the stream union stay here,
  kept compatible with the server's `TestCasePayload` and `StreamEventPayload` by the
  dashboard's `wire-shared-drift.test.ts`. A change here is a server-contract change.
- **Side effects**: what a user's suite can observe, listed below.

## Side effects

What the package does to a user's run, process by process.

**Configuration and logs**

- `PIWI_*` env vars (`internal/config/env.ts`). `PIWI_DASHBOARD_URL`, `PIWI_API_KEY`
  and `PIWI_PROJECT_NAME` are also read from the `.env` in the Playwright config's
  folder, below the environment, by the reporter and the global setup alike.
- `piwi-*` testInfo attachment names (`internal/capture/attachments.ts`), temp files in
  `os.tmpdir()`, and `[Piwi Dashboard]`-prefixed logs (`internal/support/logger.ts`).

**In each test worker** (the capture fixtures)

- The `__piwiProbeElement` page global, seeded via `addInitScript`
  (`internal/capture/capture-fixtures.ts`), so a capture ships a stub call rather than
  the probe's source.
- The boxed stack prefix `internal/capture/quiet-capture.ts` adds for this package's
  `dist/`, so a wrapped action is located at the test's line.
- The resource ledger's listener on the worker's Playwright instrumentation, and its
  wrappers on the browser types' `launch`/`connect` (and `connectOverCDP`)
  (`internal/capture/resource-ledger.ts`).
- On Linux, `5` written to `/proc/<pid>/clear_refs` of the processes the worker started,
  at each test's start, which resets their peak RSS for the test
  (`internal/capture/worker-metrics.ts`). In Chromium, a DevTools session on each page
  that outlives its test.
- The API request proxy (`internal/capture/api-requests.ts`): the fixtures wrap
  `playwright.request.newContext` and hand out every API request context behind a
  proxy that records each call, the `request` fixture's and each browser context's own
  `request` (`page.request`) included.
- Code reach (`internal/capture/code-reach.ts`): a `beforeunload` listener on each
  document of a covered page, added in an isolated world.
- With server coverage on (`coverage.server`), the `X-Piwi-Coverage` request ids of each
  test's responses, its pages' and its API calls' (`piwi-server-coverage-requests`).

**The editor's breakpoints** (`internal/capture/pause-at.ts`, a headed local run with `PIWI_PAUSE_AT`)

- Each context stops through `context.debugger` before every call it can stop at, on
  the lines `PIWI_PAUSE_AT` names, and shows the pause bar. The bar's answer is read
  from the `__piwiPauseState` page global.
- `PW_CODEGEN_NO_INSPECTOR` is set in the worker, except while a `page.pause()` it
  leaves to Playwright runs. It wraps `Page.prototype.pause`, so every `page.pause()`
  of the worker's Playwright goes through it; one of a second copy of Playwright does
  not, and stops with neither bar nor Inspector.
- The stops shown (the bar's, and those the run connection holds) end as the test
  function ends, before Playwright's own failure screenshot: through the runner's
  `_onDidFinishTestFunctionCallbacks` (feature-checked), else as the test's page or
  context closes, or at teardown.
- The runner's count of a test function that ended under a stop is set back to what it
  held as the stop began (`_timeoutManager.defaultSlot()`, feature-checked). The call
  the stop let go, and the requests after it, are then waited for, 2 seconds at most:
  before a page or context of the test closes, and at the test's teardown.
- The stops shown, at the bar or in the editor, are attached as `piwi-pauses`.
  `internal/collect/pause-events.ts` sends them with the test's step events, as `pause`
  events: the steps keep their clock, and the step statistics leave the stopped time out.
- A locator picked at the bar is posted to the editor's `PIWI_EDITOR_SEND` address.
- With `PIWI_RECORD_CHANNEL`, **Record here** and `page.pause()` connect to the editor
  service's local socket and relay the recorder's binding calls over it
  (`internal/capture/record-handoff.ts`).

**The editor's run connection** (`internal/capture/run-channel.ts`, with `PIWI_RUN_CHANNEL` and `PIWI_ORIGIN_REF`)

- The run's name on it, its `run-attach`'s `ref`, is `PIWI_RUN_REF` when set, else `PIWI_ORIGIN_REF`. The desktop app
  sets `PIWI_RUN_REF` (`desktop-<its run id>`) on the runs it starts, whose `PIWI_ORIGIN_REF` names the failure cluster
  or bug report they were started for; its bundled server is their hub.
- `PIWI_RUN_CHANNEL` names the same local socket as `PIWI_RECORD_CHANNEL`. Each worker
  connects to it in the `piwiResources` worker fixture, before its first test (it waits
  2 seconds at most), and stays connected until the worker ends. The messages are defined
  in `@piwitests/core/run-channel`.
- The first message, `run-attach`, lists what the worker takes (`takes`: the intents
  `pick`, `record`, `assert`, `assert-region`, the queries `requests`, `mock`,
  `locator`, for a viewer outside the page, `view`, `input` and `pick-at`, for an agent,
  `agent` (its requests `snapshot`, `act` and `ref-locator`), `events` and `bind`, and
  the control `end`) and the stops it holds for an editor that shows them (`holds:
  ['failure']`). `pick` needs `PIWI_EDITOR_SEND`, and the intents that record or check
  `PIWI_RECORD_CHANNEL` (`workerTakes`): a run started in a terminal takes neither. The
  list holds 16 entries at most: an editor service released before `agent` reads a
  longer one as none.
  The worker then sends each test's begin and end, each stop it shows, and each stop's
  end (`running`).
- The editor's controls (Pause, Step, Resume, Finish, Run to a line) and its breakpoints,
  which replace `PIWI_PAUSE_AT`, go through the same stop policy as `PIWI_PAUSE_AT`.
- **End the test** (`end`, the editor's control or the bar's button, `endTest` in
  `capture-fixtures.ts`). While the test function runs (its `beforeEach` hooks and the
  fixtures set up before it included), each locator call the proxy delegates carries the
  attempt's end signal among its options (`withEndSignal` in `pause-at.ts`, beside a
  signal the test gave, through `AbortSignal.any`): End aborts it before the debugger
  lets the held call go, so Playwright gives that call up before it runs. The attempt
  then stops nowhere more, and is skipped by the runner's own `testInfo.skip(true,
  ENDED_REASON)` as the call rejects, at its next locator call, as a `page.pause()` it
  stopped at goes on, or as its function ends (`_onDidFinishTestFunctionCallbacks`,
  feature-checked, only when it passed). A call the proxy does not delegate (a
  navigation, a key press, a page's own assertion) runs first, which the editor hears
  (`notice`). At a failure, or once the function ended (an `afterEach` hook, a fixture's
  teardown), End goes on as Resume does, the result kept; the bar offers it at neither.
  `afterEach` hooks and the fixtures' teardown run as after any skip, and the next
  attempt and test start as they would (`tests/run-channel-end.spec.ts`).
- While the connection is open, a headless run stops too (never under CI or Playwright's
  own debugger): the stop waits for the editor's answer, and goes on if the connection
  closes. In a headed run the pause bar shows as well, and the first answer wins: the
  editor's answer takes the bar down.
- A stop answered in the editor is attached to `piwi-pauses` like one answered at the
  bar. A stop that ends unanswered (the test function ended, its page or context closed,
  or, for a stop whose page the worker cannot tell, any page of its context closed) ends
  the same way with or without a bar, and the editor gets `running`.
- The editor can ask for an image of the stopped page: a JPEG screenshot without the
  pause bar, taken through an internal call. It gets none for a stop whose page the
  worker cannot tell (a navigation or a key press in a context with several pages).
- At a stop the bar shows, the editor can start the bar's **Pick a locator** or **Record
  here** (an intent: a `request` with `what: 'pick' | 'record'` that names the stop).
  `BarIntents` (`pause-at.ts`) hands it to the bar, which takes it as a click on its own
  button: the same picker, the pick posted to `PIWI_EDITOR_SEND`, the same hand-off over
  `PIWI_RECORD_CHANNEL`. The test's window is brought to the front, and the pick or the
  recording ends with the stop. The worker answers at once whether it started. It
  refuses at a stop that ended or is ending (its test ended, its page or context began to
  close), at one no bar shows whose live view nobody watches, at one whose page it cannot
  tell, Record here and Assert when
  the run has no `PIWI_RECORD_CHANNEL`, and any intent while a pick, a check or a
  recording runs.
- **Assert** is the same hand-off in its `check` mode, naming the stop: the editor's
  recorder opens the check panel's Check an element alone, and the editor service writes
  the check.
- **Assert a region** is the bar's picker, then the confirmed locator's `ariaSnapshot()`,
  sent as `region` (`region-snapshot.ts`). The snapshot leaves out the value of a field
  that holds a secret (a password field's, or one whose `autocomplete` asks for a
  password, a one-time code or a card's number or code: `SECRET_AUTOCOMPLETE` of
  `@piwitests/core/mask`, read through a locator, so in open shadow roots too) and a
  link's URL holding a credential; a link left without a child ends without its colon,
  so `toMatchAriaSnapshot` reads it. A region its locator does not find alone, or whose
  snapshot is too long, is sent as `region` with `refused` instead.
- At any stop, headless included, `requests` lists the responses the test kept and
  `mock` hands over one of them with its body (`kept-responses.ts`). While the run
  connection is open, the fetch and XHR answers of the test's pages whose type is text
  or unnamed are kept: the latest 50, 256 KB each at most as their `content-length` says
  (one that says none is listed without a size), each as its `Response` in the worker's
  memory alone. A body is read only when `mock` asks for it, through an internal call,
  refused when the browser no longer holds it or it is not text; it is never in an
  attachment, and is dropped as the test ends. Every URL listed or handed over has its
  credentials hidden part by part, its host and ids kept (`hideSecretsInUrl`).
- `locator` counts a chain (`chain-locator.ts`, built through the chain grammar's calls
  alone) on the stopped page, one count after the other, and, where the bar shows,
  outlines its matches with Playwright's highlight, the one before taken down first and
  the last before the stop ends.
- **The live view**, for a viewer outside the page (Piwi Picker, through the editor's
  hub). `view` shows the stopped page live: its screencast (`page.screencast.start`
  through an internal call, at its viewport scaled to fit 1280 by 800, JPEG quality 60,
  unless a client that came first, the test's video or its trace's images, set its own
  size and quality, which every later client gets; the view stops its own client alone,
  and the video stays whole). One frame at a time waits for its acknowledgment, an
  interval at most (`FrameAcks`), so a browser the view alone holds paints ten a second at
  most; a frame that comes while one waits (another client acknowledged the one before)
  is acknowledged at once, so none the view drops is held. Each goes as `frame` with the
  viewport in CSS pixels; one like
  the frame before is dropped. One over 384 KB is dropped too, and an image of the page at
  quality 30 goes in its place, two a second at most; when that one is over 384 KB as well,
  the viewers hear once why no frame goes (`frame` with `refused`), until one goes again.
  The latest alone waits while the connection is backed up; the latest sent is kept in
  memory until the view ends, and sent again as the view is asked again (a viewer that
  comes later, which a still page paints no other frame for); none is stored nor attached. Where the screencast cannot start (the test
  runs its own), an image of the page goes twice a second.
- `input` plays a viewer's mouse, wheel, key and text events (`@piwitests/core/run-view`:
  Playwright's key names alone, nothing evaluated) with `page.mouse` and `page.keyboard`
  through internal calls: trusted input that reaches whatever is at the point, Piwi's
  overlays included (the picker, the recorder, a headed stop's pause bar, whose buttons
  answer the stop as a click in the window does). Only while that stop's view is watched,
  200 events a second at most, and what it holds down is let go before the test goes on.
- At a stop no bar shows, Pick a locator, Record here, Assert and Assert a region run in
  the page while its view is watched (`viewHere` in `pause-at.ts`), driven through that
  input. They end with the view or the stop, leaving nothing of theirs in the page (the
  picker's choice list included, `__piwiChoiceCleanup`).
- `pick-at` (`pick-at.ts`) reads the page's ARIA snapshot in AI mode with its boxes, and
  takes, of the elements under a point, the innermost that is or holds the element a click
  there lands on: the page's hit test in paint order (`elementsFromPoint`, into open shadow
  roots), so a dialog, a fixed banner or a sticky header over another element is the one
  taken. Piwi's overlays are left out (each root an `__piwi` id or a `piwi-…-host`), an
  iframe refused. It ranks it as the bar's pick does, with `locator.normalize()`'s locator
  among the candidates,
  and posts the first that finds it alone to `PIWI_EDITOR_SEND` (`page.getByRef` and the
  boxes feature-checked, refused before Playwright 1.64). An image of a stopped page names
  its viewport (`width`, `height`), the CSS pixels a point is in.
- For an agent (the editor's MCP server), at the stop held alone, one request after the
  other, 10 seconds at most each, an `act` the page takes longer over answered `late`
  and again once it was played (`agent-page.ts`): `snapshot` reads the page's ARIA
  snapshot in AI mode to a depth (`page.ariaSnapshot({ mode: 'ai', depth })`), its
  credentials hidden by `hideSecretsInText` and each secret field's value written as
  `<hidden>` (`withoutFieldSecrets`: an AI snapshot shows a field's value, quoted when
  YAML needs it), with an image whose secret fields are masked when asked, in each frame;
  a secret field is a password field or one whose `autocomplete` names a password, a
  one-time code or a card's number or security code (`SECRET_FIELDS`, from
  `SECRET_AUTOCOMPLETE`); `ref-locator` ranks the element a
  ref names (`page.getByRef`, 1.64) as Pick does, with the project's `testIdAttribute`,
  each candidate checked to find it alone, and reads its text (its `textContent` with
  whitespace collapsed, as a text assertion compares it, 1,000 characters at most and
  `textCut` past them), value (none of a secret field, `el.matches(SECRET_FIELDS)`) and
  checked state, each text's credentials hidden before it is cut; `act` plays a click, a fill, a key press, a check or a select
  on it with Playwright's own action (trusted input, 5 seconds at most), after ranking it
  for the step it makes. Each runs as an internal call, never a step of the test.
- `events` (`run-events.ts`): while the editor asked and a test runs, each call of the
  test as it ends, through Playwright's `_instrumentation` (feature-checked; it never
  hears an internal call), with its place in the user's code, and each page's navigation,
  console error or warning, uncaught error and failed request (a failure, or a status of
  400 or more), at most 50 a second, the others counted (`dropped`), their texts' and
  URLs' credentials hidden.
- `bind` shares the stopped context's browser with Playwright's own tools
  (`browser.bind('piwi-<ref>-w<worker>', { workspaceDir })`, feature-checked), until the
  test ends (`unbind` on `test-end`), or stops sharing it.
- The view stops before the stop's `running`, as its page closes and as the connection
  does: no frame of a stop goes once it began to end. A frame carries whatever the page
  shows: it goes to the editor service alone, which sends it to the paired, authenticated
  viewers that asked for it.
- One stop shows at a time in a worker. A stop that waits for its turn is decided again
  when its turn comes. It goes on without showing, and the editor never hears of it,
  when the test ended meanwhile (as on Finish), when its page or context began to close,
  or when it is a breakpoint's stop and that breakpoint was removed or the stop before
  was answered with Finish. The Step, Pause or Run to a line it would have used then
  applies to the next stop.
- Closing a context, directly or through its browser, first lets the call its debugger
  holds go on, since the close does not.
- **A held failure** (`holdFailure` in `capture-fixtures.ts`). A test that fails while
  the connection is open to an editor that shows a held failure (`editorShows`: the
  editor answered the `run-attach`'s `holds` with `attached` naming `failure`; one that
  predates it says nothing, and no failure is held) holds its page once the test
  function, its hooks and the fixtures built on `page` are done (Piwi's `page` fixture,
  after `use(page)`; a page the test left open, at the capture fixture's teardown). Not
  an expected failure, never under CI nor Playwright's own debugger, never from a close
  while the test runs. Its evidence is read first and kept as it was (`frozenAt`: no
  request, console entry or dialog of the hold is recorded, and its context's code reach
  ends; Playwright's own trace and video record the hold too), and the test timeout is
  held while the stop shows.
- **The host's name.** `attached` also says what the service calls itself when it is not
  the editor (`host`: the desktop app, whose server is the hub of the runs its shell
  starts). The worker's lines name it then (`runHost`): `Resume in the desktop app`, `The
  connection to the desktop app closed`, and a pick that could not be sent; else they
  name the editor.
- It is a stop with the reason `failure` at the failing line (where the error's stack
  enters the test's code, else the failing locator's, else the call a test timeout cut
  short, the runner's step in progress, else the test's declaration). It names its error
  to the editor (`error`, `failureError`: the failing error's lines up to a blank one or
  its call log, four at most, without ANSI codes nor the `Error: ` the runner writes
  before a plain error's message), its title and error with the credentials of the URLs
  they name hidden (`hideSecretsInText`). The bar says `Failed at …` with Resume, Pick a
  locator (which replaces the failing locator, and is folded into its snapshot) and
  Record here. Any answer lets the test end as it failed, and the editor service lets
  one go at once in a run nobody watches.
- While each test runs, the capture fixtures take `PIWI_RUN_CHANNEL` and
  `PIWI_EDITOR_SEND` out of the worker's `process.env` (`hideRunChannel`), whether a run
  connection is open or not, so a process the test starts does not connect to the run
  and does not get the pairing's token. Picks still go to the pairing
  (`editorSendAddress`). Both are put back after the test, since Playwright passes a
  worker's environment changes to the projects that depend on its project.
  `PIWI_RECORD_CHANNEL` stays, for **Record here**.

**The instance's live view** (`internal/capture/live-view.ts`, with `PIWI_LIVE_VIEW`)

- The global setup's `/setup` of any run asks for a live view key (`liveView: true`); the
  instance gives one for a project with the live view on, for that run alone, and the setup
  file keeps it. In `onBegin` the reporter names it in `PIWI_LIVE_VIEW`
  (`<instance>/api/test-runs/<id>/live-view#<key>`, `@piwitests/core/live-view`), which
  Playwright hands the workers it starts after: a CI run (`detectCi`, which the run's origin
  reads too) says so in its `Live view on` line, a run outside CI that a run channel follows
  in its `Live view ready` line. A run outside CI with no key names why instead
  (`none:no-instance`, `none:unregistered`, `none:off`, and `none:local` for the desktop
  app, which gives none: `liveView.refused: 'local'`); a run the reporter registers itself,
  without the global setup, has none.
- In a CI run, each worker opens an event stream to that URL in the `piwiResources` worker
  fixture, without waiting for it, and keeps it until the worker ends. Outside CI, it holds
  the key and opens nothing until the run channel says `share` with `on: true` (**Share
  live**, `shareLiveView`), and closes the stream as it says `on: false`, posting `unshared`
  first so each viewer hears why; the run channel hears how it stands (`liveViewState`:
  `live`) after its attach and as that changes, and a sharing that connection asked for
  stops as it closes. Nothing goes to the instance while the run is not shared, its stops
  included. The stream never keeps the worker alive; a failed one is opened again after 1,
  2, 4, 8 and 16 seconds, 20 times at most over the worker's life (a 409 while the run is
  interrupted included), then given up and closed until the run is shared again, saying
  what the instance last answered, and a 401, 403, 404 or 410 gives the key up at once,
  the run channel hearing why. A stream replaced by another (shared again at once) or
  closed for good is done with: nothing is tried again for it.
- The same fixture takes `PIWI_LIVE_VIEW` out of the worker's `process.env` until its
  teardown, so no process the worker's fixtures, hooks or tests start gets the key. A
  listener put before Playwright's own on the worker's IPC puts it back for the
  `__stop__` message alone, as Playwright compares the environment with the one the
  worker started with and hands what changed to the projects that depend on its own,
  and takes it out again on the next tick.
- On it the instance says how many people watch the worker (`viewers`). While anyone does,
  the test's `page` goes out as its screencast (`page-view.ts`, the helper the editor's view
  of a stop uses too), through internal calls: at most 640 by 400 at quality 50 unless the
  test's trace or video came first (their size and quality, 800 wide at 90), four frames a
  second and about 256 KB a second (a heavier frame holds the next one back longer), a
  frame over 192 KB replaced by an image at quality 30. One post is in flight at a time,
  the latest frame alone waiting; each frame carries the call the runner's steps say the
  test is on (`callInProgress`, its title through `hideSecretsInText`) and the test's
  title. Nobody watching, no screencast runs and no frame goes.
- In a CI run alone, while anyone watches, the worker also follows the call its test is in
  (`live-call-log.ts`): it turns the context's call stream on (`context.debugger._enable()`
  through `internalCall`, each member checked first; once on it stays on, and moves where
  the debugger stops an action, which nothing does in a CI run), and posts a `call-log` as
  the call shown changes, 300 ms apart at least, one in flight: the call that began last,
  its status, its log folded by `compressCallLog`, its action point and its error's first
  line, each text through `hideTypedText` or `hideTypedTextInLog`, then
  `hideSecretsInText`. While that call has waited a second, an internal `evaluateAll`
  reads, once a second, the elements its selector matches: how many, the first one's box
  and whether it is enabled. The selector comes from a listener on the worker's
  Playwright instrumentation (`trackLocatorCalls`, added by `piwiResources` when the live
  view can open), which never hears an internal call. A viewer that joins gets the latest
  call log again.
- A page has one screencast client of its own. In a worker that can open a view (a run
  connection or a live view connection), `instrumentPage` hands the test `page.screencast`
  behind a proxy (`guardScreencast`): the test's `start` or `stop` first ends the client a
  view holds, and that view goes on with an image of the page every second, its caret as
  the page shows it, as does any later view of that page and a second view of a page
  another view holds.
- The view stops as nobody watches, as the test ends (the worker posts `ended`) and as its
  page closes; a viewer that joins gets the latest frame again, and one that joins while no
  test runs (a `beforeAll`, between tests) hears why no image shows. Each stop the
  fixtures show (`showStop`, at the bar or for the editor) is posted as it starts and ends
  (`stop`), with the test's title and the call's through `hideSecretsInText`, whoever
  watches, and the stop held is posted again on each stream the worker opens, so a run
  shared during a stop shows it; a CI run never stops, so this is for the run a person
  shares.

**In the reporter process**

- The run sampler reads `/proc`, the cgroup filesystem or `ps` on an unref'd timer
  (`internal/collect/process-sampler.ts`).
- While the dashboard says someone watches the run, another unref'd timer posts what the
  sampler and the censuses added since its last post to `/live-resources`, every five
  seconds (`internal/streaming/live-resources.ts`).
- `onBegin` writes `PIWI_RESOURCES_RESULTS` (see below) and, with coverage on,
  `PIWI_COVERAGE_BROWSER` / `PIWI_COVERAGE_SERVER` / `PIWI_COVERAGE_CSS` for the workers.
- **A run started in a terminal** (`internal/config/editors.ts`, `followEditor`). With
  no `PIWI_RUN_CHANNEL` and no launcher (`PIWI_ORIGIN`), its output going to a terminal
  or an editor's test runner having started it (`startedByTestRunner`: `PW_TEST_REPORTER`
  names a reporter's file, as a JetBrains IDE's Playwright runner does; else
  `PIWI_EDITOR=on`), never under CI, `PWDEBUG`, `--debug`, UI mode (`--ui`,
  `--ui-host`, `--ui-port`) or with `PIWI_EDITOR=off`, `onBegin` reads the editors'
  discovery files (`@piwitests/core/editor-discovery`, `~/.piwi/editors` or
  `PIWI_EDITORS_DIR`) from a folder this user owns that no other user can enter, only
  the files this user owns, of this machine, whose process runs as this user, written
  since the machine started, and (but on Windows, whose pipes tell no owner) whose run
  channel is this user's socket in such a folder, deleting none. It follows the editor one of whose
  workspace folders holds the config's folder or the working directory, real paths
  compared (`editorForRun`: the most specific, then the latest started), and sets
  `PIWI_RUN_CHANNEL` to its run channel and `PIWI_RUN_REF` to `terminal-<pid>-<time>`
  for the workers, which connect as an editor's run's do, with one `[Piwi Dashboard]`
  line naming the editor and `PIWI_EDITOR=off` (`tests/terminal-run.spec.ts`). A worker
  of a run a test runner started says so in its `run-attach` (`runner`).
- With server coverage on, it calls each origin's `/__piwi/coverage/collect` and
  `/__piwi/coverage/run`, and reads the covered files from the checkout for their blob
  ids (`internal/collect/server-coverage.ts`, `test-coverage.ts`).

## Two processes, two paths

Playwright runs the **reporter** in the main process and **fixtures** in each test
worker. They never share memory: they communicate through `piwi-*` testInfo attachments.

```
            TEST WORKER                                MAIN PROCESS
  ┌───────────────────────────┐            ┌──────────────────────────────────┐
  │ internal/capture/          │            │ public/reporter.ts (PiwiDashboard │
  │   capture-fixtures.ts      │  piwi-*    │   Reporter) — Playwright hooks     │
  │  • network / web-vitals    │ attach-    │   onBegin/onTestEnd/onEnd          │
  │  • console / aria snapshot │  ments     │     │ collects CollectedTestCase   │
  │  • locator snapshots       │ ─────────► │     ▼                              │
  │    (locator-healing.ts)    │            │ internal/submit/serializer.ts      │
  │  • resource census         │            │   → WireTestCase / run body        │
  │    (resource-ledger.ts)    │            │                                    │
  └───────────────────────────┘            │                                    │
                                           │     ▼                              │
                                           │ internal/submit/run-submitter.ts   │
                                           │   the fallback ladder ▼            │
                                           └──────────────────────────────────┘
```

The resource ledger also writes one file, as the lab modes do: a worker's last
census, taken as its `piwiResources` worker fixture tears down, belongs to no test.
The reporter names a temp file in `PIWI_RESOURCES_RESULTS` in `onBegin`, before
any worker starts; each worker appends that census to it, and `onEnd` reads it
back. `internal/collect/resource-verdicts.ts` stitches every census per worker
into the findings the reporter prints. The machine panel needs no worker: the
run sampler reads the processes under the runner from the reporter's own
process. `internal/collect/resource-wire.ts` projects what the server receives:
each test's cost on its wire test case, and the bounded run report (findings,
the run's profile, each worker's open pages) with the finish or the whole-run
submit.

## The submit/fallback ladder (`internal/submit/run-submitter.ts`)

On `onEnd`, the collected run is handed to `RunSubmitter`, which tries, in order:

1. **streaming `/finish`**: when a streaming session is open (`internal/streaming/`),
2. **multipart `/upload`**: when there are reports or traces to attach,
3. **plain JSON `/submit`**: last resort,
4. **crash recovery**: on total failure, persist the payload to disk for the next run: one owner-only file per
   dashboard and project, replayed to that dashboard only and deleted once it took the run (or refused it as
   invalid).

The ladder, including the stream drain and the remaining file uploads, runs within
the `submitTimeout` budget: when it runs out, `HttpClient.close` fails every request
in flight and every later one, so the ladder falls through to crash recovery.

A 401 with no credential configured, or a failed login, stops the ladder at once: no other rung can succeed, so
the run goes to crash recovery. Nothing in the ladder throws out of `onEnd`, since Playwright counts a reporter's
error as a failure of the run. Every rung carries one `deliveryKey` per run, so a dashboard that stored a slow
upload stores the `/submit` that follows it, or the recovery copy, once.

A run delivered by a later rung than its first choice carries `metadata.ingestHealth.submitFallback`
(`{ path: 'upload' | 'submit', reason }`), and a payload sent from crash recovery carries `{ path: 'recovery' }`,
so the dashboard can say how the run arrived.

All HTTP to the dashboard goes through `internal/transport/http-client.ts`, which throws `HttpError`
(carrying `status`) so callers branch on `error.status`, never the message text.

## Coverage (`internal/collect/test-coverage.ts`)

A test's `coverage` holds two parts:

- its **browser files**: code reach, and at `coverage.browser: 'functions'` the lines of each function that ran,
  from `piwi-browser-coverage`, with the blob ids the reporter reads from the checkout;
- with `coverage.server` on, the **server coverage** the reporter collects from the backend after the test ends,
  never in the worker.

Timing:

- `onTestEnd` queues the result event of such a test only once its coverage is in, or after 30 seconds; every
  other event keeps its place.
- Collection batches tests per origin (25 tests or 1 second). The run's last test ending sends what is queued at
  once and fetches the run-level coverage, since Playwright stops a `webServer` before `onEnd`.
- `onEnd` waits at most 15 seconds for the tests still collecting, before the ladder above. It sends the
  run-level coverage (`PUT /api/test-runs/:id/coverage`, in chunks) once the ladder returned the run id.

At `coverage.browser: 'functions'` the run-level coverage includes the browser's: per file, the functions any
test ran and every function V8 listed, run or not (`allFunctions`). The workers name each function once, in
`piwi-browser-functions` attachments, as many per test as the capture caps need.

With `coverage.css: 'rules'`, the same per-page capture (`internal/capture/code-reach.ts`) also reads Chromium's
CSS rule usage, at each document's `beforeunload` pause and at the end. `internal/capture/css-coverage.ts` resolves
each sheet to its file (source map, a Vite dev server's `data-vite-dev-id`, or the served path) and its rules to
line ranges (`@piwitests/core/css-rules`). The matched rules ride `piwi-css-coverage` as browser files' function
ranges, whatever `coverage.browser` is. Every rule of the sheets rides `piwi-css-rules`, added to the run's
`allFunctions` as the browser functions are.

A backend's files whose source checksums (`checksums`) differ from the checkout's lose their line numbers
(`internal/collect/source-checksums.ts`).

Each backend answer names its process (`instance`, also the prefix of its request ids). The run-level coverage
of an origin gets the lines and functions its tests' coverage named added. It is sent with an `incomplete` entry
when another process answers it than the one that gave out the run's first ids (a restart), or when no run-level
answer comes (unreachable).

## Directory layout

```
src/
  index.ts                 public entry (.)            — re-exports the whole public API (incl. fixtures)
  global-setup-module.ts   default createGlobalSetup() — resolved by path at runtime (config-wrapper.ts)
  types.ts                 barrel re-exporting types/wire + types/collected

  public/      reporter, config-wrapper, global-setup, selection, options,
               piwi-config (the '@piwi' config section)            ← the supported API
  cli/         the `piwi` command line (package.json `bin`, its own tsup entry):
               index (the command switch), one file per command (init, skills, gate,
               quality-report for `report`, coverage, select for `select` and `run`,
               probe, flake, ai, codegen, preflight, bug); detect, configure (what
               init inspects and edits), add-reporter (`run`'s --add-reporter),
               report (the step results init and skills print)
  internal/
    submit/     run-submitter, uploader, serializer
    transport/  http-client (+ HttpError), backend-request
    streaming/  stream-manager, stream-buffer, bounded-queue, crash-recovery,
                live-resources (a watched run's CPU, memory and open pages,
                posted as it runs)
    collect/    metadata-collector, error-text, test-meta, external-ids,
                resource-verdicts (the censuses stitched into leaked, idle,
                piling-up and handle findings), process-sampler (the run's
                processes and the machine, sampled from the reporter),
                machine-panel (the end-of-run CPU, memory and disk lines),
                resource-wire (what the server receives), coverage-settings,
                server-coverage (the backends' collect and run endpoints,
                batched per origin), test-coverage (each test's coverage field,
                the wait before its result streams, the run's coverage),
                blob-ids (the git blob of each covered file), source-checksums,
                pause-events (the stops a test made, at the pause bar or in
                the editor, as the `pause` step events the dashboard draws and
                the step statistics leave out)
    manifest/   collect (the committed manifest, `/__piwi/manifest` per base URL or origin),
                run-manifests (the instrumented origins the run reached beyond its base URLs,
                fetched as each is first seen, uploaded once the run is submitted)
    files/      file-handler, compression
    capture/    capture-fixtures, locator-healing, attachments   ← runs in the worker
                quiet-capture (keeps the capture out of the test's own steps,
                trace and stack locations — Playwright internals, feature-detected)
                api-requests (the calls a test makes through Playwright's API
                request contexts: the `request` fixture, `page.request`)
                resource-ledger (the browsers, contexts, pages and API request
                contexts each worker opens, and the census per test),
                worker-metrics (what a test cost the worker and its browsers,
                and CDP reads of pages that outlive their test)
                code-reach, css-coverage (browser and style sheet coverage),
                locator-pages, page-interaction, page-inventory, failure-screenshot,
                inspect-on-failure, pick-on-failure (the failure-time overlay),
                pause-at (the editor's breakpoints: PIWI_PAUSE_AT, the stop policy
                over Playwright's debugger, the pause bar, a pick posted to
                PIWI_EDITOR_SEND), record-handoff (Record here:
                the paused page relayed to the editor's recorder, PIWI_RECORD_CHANNEL),
                run-channel (the worker's run connection to the editor,
                PIWI_RUN_CHANNEL: its tests and stops out, the editor's controls in,
                a stopped page's live view and the input played on it),
                page-view (a page's screencast for a viewer outside it, paced
                and capped: the editor's view of a stop, the instance's live view),
                live-view (the worker's stream to the instance's live view,
                PIWI_LIVE_VIEW: viewers in, frames and stops out),
                pick-at (the element under a point of an image of a stopped page),
                agent-page (a stopped page read and acted on by a ref for an agent,
                its browser bound for Playwright's tools), run-events (the test's
                calls and page events, for an agent following the run),
                kept-responses (the text bodies an interactive run keeps for
                Mock a request), chain-locator (a locator chain's source built
                against a page, for the locator at the editor's caret),
                region-snapshot (a region's ARIA snapshot without its secrets)
    ai/         ai-fixtures, artifact, keys, params, ground, compile, resolution
                (the authoring loop), interpreter (replay), check (`piwi ai check`)
    coverage-upload/  git-inventory, report-files (`piwi coverage upload`)
    config/     env (PIWI_* ↔ options, and the probe and flake-lab variables),
                desktop (the desktop app's discovery file), editors (the editor a run
                started in a terminal follows), dotenv (the `.env` reader)
    probe/      probe mode: plan matching, faults, the shared route interception
                (a matcher over route keys + an action), server-probe signing
    flake/      flake mode: the arm's plan, its conditions on the target's first
                page, the results file; lab (the command line's side of an arm)
    support/    logger, limiter, ci, ci-output, failure-links, run-url, instance-id,
                system-readers (`/proc`, cgroup and `ps` readers),
                cli-filters, setup-file, source-snippet, worker-index, errors,
                selection-client, selection-env, shard-info, aria-sampling,
                run-mode, test-paths, reporter-version, connection (the
                commands' dashboard), playwright-spawn (how commands start
                `playwright test` and package managers),
                base-url-check (the `checkBaseUrl` check the global setup runs)
  types/
    wire.ts        EXTERNAL server contract
    collected.ts   INTERNAL in-process model

templates/skills/<slug>/SKILL.md   the agent skills (see below)
```

## Agent skills (`templates/skills/`)

Each skill is one `SKILL.md`: a YAML front matter with `name` and `description`, then Markdown instructions for a
coding agent. `src/cli/skills.ts` declares them: `SETUP_SKILL` (`setup-piwi`) and the six `WORKFLOW_SKILLS`.

They reach users' agents four ways, all from the same files:

- `piwi init` installs the workflow skills by default (`--skills` picks others), and `piwi skills add` installs
  any of them, into `.claude/skills/` unless another folder is named (`--skills-dir` for `init`, `--dir` for
  `skills add`). Each installed file is stamped with the
  package version and a hash of what was written (`@piwitests/core/skill-stamp`): a later install updates an
  untouched skill from an older release and keeps one a person edited, unless `--force`.
- The dashboard bundles the workflow skills into its build (`piwi-skills` server assets in
  `apps/application/nuxt.config.ts`) and serves each one as an MCP prompt named after it (`investigate_failure`, …),
  its description taken from `apps/application/shared/mcp-prompts.ts`.
- The desktop app installs them into a project's linked folder, from the dashboard's `/api/agent-skills`.

## Conventions

- **Imports:** Node built-ins as `import * as x from 'node:x'`; type-only imports use
  `import type` (the `node:` protocol and the type imports are lint-enforced).
- **Classes** take dependencies as `private readonly` constructor parameter properties;
  an injected `logger` defaults to `new Logger()`. Stateless logic is a plain function module.
- **Errors:** throw `HttpError(status)` for non-2xx; `catch (error)` is `unknown`: narrow
  with `instanceof`, format with `errorMessage(error)` (`internal/support/errors.ts`).
- **Types:** `strict` is on. `any` is allowed only at the Playwright reporter-API / browser
  `evaluate` boundary (with a comment) and the dynamic options merge; everywhere else use
  precise types or `unknown`.
- **Wire changes** touch `types/wire.ts` and `internal/submit/serializer.ts` together, and must
  stay structurally compatible with `apps/application/shared/types.ts` (kept in sync by the drift test).

## Lab modes: probes and flake experiments

Two env-driven modes turn a Playwright run into an experiment rather than a real
run. Each forces `retries` to 0 (`public/config-wrapper.ts`), stamps the run's
metadata at `onBegin` so every submit path carries it (`public/reporter.ts`), and
has the capture fixtures act on the matching test only. A run is one or the
other: setting both stops it with a message (`labModeConflict`).

| | Probe mode | Flake mode |
|---|---|---|
| Switched on by | `PIWI_PROBE=1` + `PIWI_PROBE_PLAN` | `PIWI_FLAKE_PLAN` (one arm's plan) |
| Results | `PIWI_PROBE_RESULTS`, one line per probed test | `PIWI_FLAKE_RESULTS`, one line per finished attempt of the target and of an `alongside`/`after` companion |
| Plan format | `internal/probe/plan.ts` | `@piwitests/core/flake-plan` (`parseFlakePlan`, shared with the dashboard and the CLI) |
| Test match | file + title (+ describe path) | the same, plus the plan's Playwright project |
| Run stamp | `piwiProbe: true` | `piwiFlakeLab: { experimentId, armId }` |

Both apply route changes through `internal/probe/interception.ts`: one
`page.route('**/*')` handler walks a list of rules. Each rule has a matcher over
route keys, which of the matching requests it acts on (every one, or the Nth after
the first navigation), and a handler. A probe installs one rule that applies its
fault (`slow` is a 5-second `delay` action). A flake arm installs one rule per
`delay` or `fail` condition, matching a request when `requestRouteKey(method, url)`
(core) equals the condition's route, the key the dashboard's flake profile names
suspects by. The route actions are `delay` (fetch, hold until `ms` after the
request started, fulfill), `status` and `abort` (`connectionreset`).

Flake mode installs the conditions on the target's first instrumented page, and the
page-creating paths await the install, so they are on before the test navigates.
`cpu` and `network` go through a DevTools session (`Emulation.setCPUThrottlingRate`,
`Network.emulateNetworkConditions`) and are reported `skipped` outside Chromium.
`alongside`, `after` and `project` are applied by the command line's Playwright
arguments and reported `by-command`. Each results line carries the attempt's
status, error signature (`flakeErrorSignature`) and whether it matches one of the
plan's, start, duration, worker and parallel index, and one outcome per condition.
Workers append whole lines (`O_APPEND`) to the one file.

## Shared core (`@piwitests/core`)

Pure cross-cutting logic (locator generation/scoring, ARIA parsing, element-match
healing, the wire leaf shapes, the locator-method list) lives in the private
`@piwitests/core` workspace package and is the single source of truth shared with
the app. The in-page overlays (the element probe, the picker, the pause bar) come
from the private `@piwitests/picker-dom` package. The reporter **`import`s both and
tsup bundles them into `dist/`** at build time, so the published package stays
self-contained: no `@piwitests/core` runtime dependency and no monorepo path in the
public `dist/index.d.ts`. Reporter-only runtime that needs Node (`captureCallerLocation`)
stays in `internal/capture/locator-healing.ts`.

## Build output

`npm run reporter:build` runs tsup (`tsup.config.ts`): it bundles `src/`, `@piwitests/core` and
`@piwitests/picker-dom` into `dist/` as CommonJS with `.d.ts`, leaving `form-data` and `@playwright/test`
external.

- The package entries (`index`, `global-setup-module`) stay at `dist/` root so `package.json`
  `main`/`types`/`exports` don't move.
- The CLI is its own entry (`dist/cli/index.js`, the `piwi` bin), so the main bundle carries no CLI code.
- The capture modules the dashboard dogfoods (`locator-healing`, `capture-fixtures`, `inspect-on-failure`,
  `pick-on-failure`, `attachments`) are emitted as their own entries, so their `dist/internal/capture/` paths are
  preserved: `apps/application/tests/fixtures.ts` imports them from there.
- `templates/` ships beside `dist/` (`files` in `package.json`); `findTemplatesDir` finds it from `dist/cli/` and
  from `src/cli/` alike.
