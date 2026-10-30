# The live view's next parts

A plan for what the run page's live view shows next. The **live view**
([`features/live-view`](../apps/docs/features/live-view.md)) is the run page's view of a running test: while a person
watches a worker of a CI run, or of a run a developer shares, the worker sends JPEG images of its test's `page`, and the
instance relays them to the people watching that worker and keeps none. It answers "what does the page look like now".
Someone who opens a slow CI run usually asks something else: what is the test doing, and why does it not go on. This
plan adds what explains a running test, then the page as a document rather than an image, then ways to watch a whole run
from more places. Where it revisits a decision of the [run control ADR](../adr/run-control.md), it says so.

**Status.** Proposed 2026-10-30. PRs 1 and 2 are built: the call log, the action point and the element count in the
view of a CI run, and **Stuck?** with `test.stuck` (Part 1, as it now describes them; how long the step a stuck test is
in usually takes is not built). The rest is proposed. Spikes A to H in the [appendix](#appendix-the-spikes) ran on
Playwright 1.64.1 and are the evidence for the claims about Playwright and the costs; none of them is part of the
repository. Spike D settled that a run Piwi pauses never turns the call stream on (D2), spike F that the runner's own
trace needs no option to be read as it grows (D6), and spikes E, G and H set the masking rate, the video's settings and
what a viewer of the DOM receives (D5, D9, D7). Safari is the one browser no spike reached (spike G). A prototype
outside the repository then drove the sample shop through Parts 1, 2, 4 and 5 and the video of Part 7; it found the
defect listed under [Defects found while researching this plan](#defects-found-while-researching-this-plan), fixed
before PR 1. Nothing here is on [`ROADMAP.md`](../ROADMAP.md) yet. The contracts it would add are entry D62
of [`1.0-stabilization.md`](1.0-stabilization.md).

**Summary.** What the plan delivers, in the order it should be built:

- **What the test waits for.** Beside the image: the call the test is in, Playwright's log of that call as it goes
  (`element is not enabled`, `retrying click action`), the point it acts on drawn over the image, and the number of
  elements its locator matches. A test that has run far longer than it usually does is marked **Stuck?** on the run
  page, with a notification, whether or not anyone watches.
- **Secret fields masked** in every image before it leaves the worker.
- **More than the `page` fixture**: the test's other pages, the requests of a test with no page, the page's errors and
  failed requests, and the backend logs Piwi already reads from each response.
- **The page at each call, as a document**: from Playwright's live trace, in the dashboard's snapshot view, to inspect
  it, search it and pick a locator on a running CI test.
- **A whole run at once**: every worker in a grid, a view that follows the worker whose test just failed, retried or
  got stuck, the last 30 seconds again when the test's trace or video already records the page, and the last passing
  run's image of the same step.
- **More places to watch from**: the editor, Piwi Picker, an agent through the instance's MCP server, and a watch link
  for someone without an account.
- **Lighter transport**: images as binary rather than base64, image sizes from the viewer's window, and VP9 video from
  the ffmpeg that Playwright installs.
- **Holding a failing CI test while someone watches it**, a project setting off by default. It narrows run control's
  D8 for that one case and ships with an ADR that says so.

Of the four things [`ROADMAP.md`](../ROADMAP.md) says Piwi is for, this serves the second, **explain the failures**:
a slow or stuck test explained while it runs, with Playwright's own words for what it waits for. It feeds the third,
**hand back a fix**: a locator picked on the page a CI test is stuck on.

## Terms

- **Call**: one call of Playwright's API that the test makes (`click`, `fill`, `expect(...).toBeVisible()`), as
  Playwright's trace and its errors name it.
- **Call log**: the lines Playwright writes about a call while it runs
  (`waiting for getByRole('button', { name: 'Pay' })`, `element is not enabled`, `retrying click action`), the
  "Call log" of a Playwright error.
- **Action point**: the point of the page an input action (a click, a hover) acts on.
- **Live trace**: a Playwright trace written to disk as the calls happen, `tracing.start({ live: true })`.
- **Viewer**: a person, or an agent, with a worker's view open.

## What exists

### In Piwi

- **The live view** (`packages/core/src/live-view.ts`, `packages/reporter/src/internal/capture/live-view.ts`,
  `apps/application/server/utils/live-view.ts`, `RunLiveView.vue`). A worker of a CI run, or of a shared run, keeps one
  event stream open to the instance, on which it hears how many people watch it. While anyone does, it posts JPEG
  images of its test's `page`: at most 640×400, quality 50, four a second and 256 KB a second (`LIVE_FRAME_*`), one
  POST per image, the image in base64 inside JSON, with the call it was taken at and the test's title. The instance
  relays them, in the memory of one server, to the viewers of that worker, who read an event stream
  (`live-view/watch`), and keeps none. A test whose trace or video already records the page shares that recording's
  images. A worker's stops reach everyone with the run page open.
- **What the live view does not do.** It never steers a run (run control's D8: "The team instance never steers a run;
  it may show one"). It shows the `page` fixture's page alone. It holds sixteen viewers per run and needs one
  dashboard server.
- **The Runs window and the editors** show a stop's page, play input into it while it is watched, pick the element
  under a point of the image (`pick-at.ts`) and run the pause bar's actions in a headless page, on the developer's
  machine.
- **What an agent reads at a stop** (`agent-page.ts`, `run-events.ts`): the page's AI snapshot; each call of the test as
  it ends, with its place in the user's code; the page's navigations, console errors and warnings, uncaught errors and
  failed requests. Every text has its credentials hidden (`@piwitests/core/mask`), and a field that holds a secret
  (`SECRET_FIELDS`) is masked in the image the agent gets, through `page.screenshot`'s `mask` in every frame of the
  page.
- **The run page's Live activity**: each worker's step, from the reporter's `step-begin` and `step-end` stream, a
  second or so behind, with or without the live view. The reporter sends steps only while someone has the run open on
  the dashboard (`stream-manager.ts`); each test's start and result it always sends. The steps of every execution are
  stored with the run.
- **The dashboard's snapshot view** renders a trace's DOM snapshots with the page's live state
  (`server/utils/dom-snapshot-render.ts`, `shared/snapshot-picker-extras.ts`), runs none of the page's scripts, and its
  picker names a locator for the element clicked.
- **Backend instrumentation** ([`guide/backend-logs`](../apps/docs/guide/backend-logs.md)): the ASP.NET Core and
  Nitro packages attach the server's warnings and errors to each response's headers, and the capture fixtures read
  them as the test runs; the dashboard shows them after the run, next to the request.
- **Public share links** ([`public-share-links.md`](../adr/public-share-links.md)): an anonymous, read-only link to one
  execution or one failure cluster, behind the default-off `PIWI_SHARE_LINKS_ENABLED`.

### In Playwright 1.64

- **`page.screencast`**: JPEG images as the page paints (`size`, `quality`, `fps`). A page has one screencast: the
  first client's size and quality apply to the others. Its `showActions`, `showChapter` and `showOverlay` draw the
  action point, a title or HTML into the page, for a recording.
- **`context.debugger`**: the public pause (`requestPause`, `next`, `runTo`, `resume`, `pausedDetails`), and an
  internal call stream. `_enable()` makes it emit `apicallsupdated` with each running call's title, its place in the
  user's code, its status, the call log lines added since the last update, the action point of an input action and its
  error, batched every 500 ms ([spike A](#a-playwrights-call-stream)). The same switch moves the pause, and nothing
  turns it off again in that context: once it is on, `requestPause`, `next` and `runTo` stop an auto-waiting action
  before its input rather than before its wait (`setPauseBeforeWaitingActions` does nothing), so a click whose element
  never becomes ready never stops ([spike D](#d-the-pause-with-the-call-stream-on)).
- **`tracing.start({ live: true })`**: the trace written to an unarchived file as the calls happen, flushed with every
  event ([spike B](#b-a-live-traces-size)). With `snapshots`, each call writes DOM snapshots (before it, at its action,
  after it), each one referring to the unchanged nodes of earlier ones; 1.64 adds ARIA snapshots
  (`snapshots: { aria: true }`). Live, Playwright keeps the page's scripts among the trace's resources
  (`omitScripts: !live`). The resources are files named by their SHA-1 and extension. The test runner's `trace` option
  takes `live` too, undocumented: Playwright's test server, behind its UI mode, asks for `{ mode: 'on', live: true }`.
  It is not needed to read a trace as the test runs: the runner's own trace file already grows with each call, its
  snapshots as they are taken and its call log with the next of them, and `live` changes nothing in the archive it
  keeps ([spike F](#f-the-runners-own-trace-as-the-test-runs)).
- **ffmpeg 1013**, which Playwright 1.64 installs with its browsers to record videos: a VP9 encoder (`libvpx-vp9`), the
  WebM format, JPEG images read from a pipe, no network protocol ([spike C](#c-vp9-from-playwrights-ffmpeg)), and no
  filter that paints a box nor any raw image input ([spike E](#e-masking-an-image-in-the-worker)). Playwright 1.63 and
  earlier install ffmpeg 1011, whose one encoder is VP8. `playwright-core/lib/utilsBundle` exports the `jpeg-js` codec
  Playwright uses for its image comparisons.
- **`browser.bind` and Playwright's dashboard**: a live view, with Pause and Step, of a browser bound on the same
  machine. Run control's D11 keeps Piwi interoperable with it; it does not reach a CI machine.

## Decisions

| | Decision | Why |
| --- | --- | --- |
| D1 | **The image stays the base of the view, and every new layer belongs to a call**: the call's id from Playwright's call stream, else the step's. | The image shows motion on any page. The call is what the log, the action point, the DOM snapshot and the step have in common, so the viewer lines them up. |
| D2 | **The call log comes from Playwright's call stream (`context.debugger._enable()`, checked before use), in a CI run alone, which nothing pauses.** A shared run, which a developer steers, never turns it on: its call log comes from the attempt's own trace when the runner traces it, and is absent otherwise. | The stream gives the log while the call waits, which no public API does. Once on, it stays on in its context and moves the debugger's stops: a breakpoint on a click whose element never becomes ready would never stop ([spike D](#d-the-pause-with-the-call-stream-on)). |
| D3 | **Nothing is drawn into the page.** The viewer draws the action point and an element's outline over the image. | The reporter's contract 6: nothing the capture does shows up as the test's own. `screencast.showActions` would show in the test's own video and trace. |
| D4 | **The instance marks a test Stuck? from the test's start, which the reporter always sends, whether or not anyone watches**: the attempt has run longer than both a floor (two minutes by default) and three times the test's longest duration in its last ten passing executions. One `test.stuck` notification per attempt. With the run open, the live steps name the step it is in. | The reporter sends steps only while someone has the run open, but always the test's start; the durations of past executions are stored. The floor keeps short tests from flagging; the live view adds the why. |
| D5 | **Secret fields are masked in the worker, before an image leaves it**: the fields of `SECRET_FIELDS` and the project's own list, painted over with `jpeg-js`, at most two images a second while a masked element shows, and only an image whose boxes read the same just before and just after it. An image whose page shows none goes as it is. | The instance and the viewers never hold the value. Playwright's `mask` exists for screenshots, and draws into the page. Masking an image costs about 48 ms of CPU ([spike E](#e-masking-an-image-in-the-worker)), and Playwright's `onFrame` gives no scroll offset to place the boxes by. |
| D6 | **The DOM at each call comes from a trace read as it grows.** When the runner already traces the attempt, the reporter reads the runner's own trace file, with no option; when it does not, the reporter starts a live trace of its own while a viewer has **Inspect** open, stops it unsaved when the last one closes it, and gives way to a test that starts tracing itself, as `guardScreencast` does for the screencast. | A context has one tracing: a test's own `tracing.start` fails while Piwi's runs ([spike F](#f-the-runners-own-trace-as-the-test-runs)). The snapshot view and its picker already render and pick from trace snapshots. |
| D7 | **A viewer with Inspect open gets the watched page's snapshots since its last navigation, and the resources they name, once per run: stylesheets, fonts and images, never a script nor a document.** Nothing goes while no viewer has Inspect open. The worker removes the value of a secret field from each snapshot before it leaves. | A snapshot refers to earlier ones back to the page's last full snapshot. On the dashboard, that first snapshot weighs 0.5 to 0.8 MB and the stylesheets 0.6 MB ([spike H](#h-a-real-applications-resources)): too much to send unasked. A viewer cannot reach the CI machine's `localhost`, and the page's scripts must never run in the dashboard. |
| D8 | **No WebSocket.** An image goes as the binary body of its POST, with a short JSON header; a viewer reads one streamed GET of length-prefixed messages. | Both cross the reverse proxies the event streams already cross (`X-Accel-Buffering: no`, a heartbeat every 15 s); a WebSocket needs an upgrade rule in each proxy. Base64 makes every image a third larger. |
| D9 | **Video is a form of the same view, not a second one**: VP9 in WebM from Playwright's ffmpeg, a keyframe every half second, each cluster opening on one (`-dash 1`), when the worker has ffmpeg 1013 and the viewer's browser shows a frame of it within two seconds; images otherwise. | [Spike C](#c-vp9-from-playwrights-ffmpeg): ten images a second as VP9 took a third fewer bytes than four a second as JPEG, at about 4 ms of CPU an image. [Spike G](#g-the-live-webm-in-three-browsers): Chromium and Firefox play it 0.7 to 1.4 s behind, a late viewer from the last keyframe; WebKit on Linux showed nothing in two runs of three. |
| D10 | **The last 30 seconds come only from images the test's trace or video already takes**, kept in the worker's memory and sent only to a viewer who asks. | Taking images nobody watches would break the rule the live view keeps: no image is taken while nobody watches. |
| D11 | **Holding a failing CI test is a project setting, off by default**: a viewer of the worker as its test fails may hold the failing page, five minutes at most. It narrows run control's D8 for that one case, and ships with an ADR that says so. | Inspecting a CI failure where it happened is worth the CI minutes to some teams, not by default. A hold takes no input and runs no code, but it does steer the run. |
| D12 | **One server still relays a run.** A relay shared between servers is a plan of its own, together with the run's live events. | The run page's live events have the same limit; lifting one without the other changes nothing for a viewer. |

## Part 1: What the test waits for

**The call log.** In a CI run, while a viewer watches, the worker turns Playwright's call stream on (D2) and sends,
for the call the test is in: its title, its place in the user's code, its status, its log, its action point and the
first line of the error it ended with, with the test's title, at the stream's own pace (an update every 500 ms), four
a second at most (`live-call-log.ts`, the `call-log` message of `@piwitests/core/live-view`). The context's calls are
followed from the first view until the context goes, so a viewer who comes while a call waits sees it at once, and two
calls waiting together each keep their own log and time. The log goes folded as Playwright folds a
failed call's (`compressCallLog`: `11 × retrying click action`), its last 20 lines, each cut at 300 characters. Calls
of Piwi's own capture are internal and never reach the stream. Playwright names a `fill`, a `type` or a
`pressSequentially` by the text it types (`Fill "S3cr3t!Passw0rd" getByLabel('Password')`, `fill("S3cr3t!Passw0rd")`
in the log): the worker hides that text in every title and log line (`Fill "<hidden>" getByLabel('Password')`), and
the values an assertion quotes of a field whose locator names a secret (`unexpected value "…"`), then applies
`hideSecretsInText`, and the instance applies the same again as it reads the message.

**The element.** The call log names the element a locator resolved to, but not where it is, and says nothing while a
locator matches no element ([spike A](#a-playwrights-call-stream)). While a call waits, the worker reads, once a
second, the number of elements its locator matches and the box of the first, through `internalCall` (the call's
selector, from the worker's instrumentation, matched to the stream by the call's id), and whether that one is
enabled, while the watched page is its context's only one. The view outlines the box, and says
`No element matches its locator yet`, `3 elements match its locator` or `Its element is not enabled`.

**What the view shows.** Under the image, the call's title and line, as today, how long it has run (or how it ended)
with the element count, then its log in a box that follows its last line until the reader scrolls up. Over the image,
the action point as a dot and the element's outline, drawn by the viewer (D3). A shared run shows the call alone: the
call stream is never on outside CI, and its log from the runner's trace (D2) is not built.

**Stuck?** (D4). Every 15 seconds the instance compares each running attempt of its live runs with the test's last ten
passing executions on its browser (`server/utils/stuck-tests.ts`, the rule in `#shared/stuck-tests`), from the start
the reporter streams or, without one, from when its begin came; a test with fewer than two passes is never stuck. Past
the threshold, the test's row says **Stuck?** with how long it has run and the longest of those passes, kept with the
running test for a page opened later, and the instance sends `test.stuck` once per attempt, through the project's
notification channels, with a link to the run searched for the test (`?search=`). It needs no viewer and no live view.
With the run open, the row also names the step the test is in; with the live view on, the row's **Watch** shows the
why. The demo plays it (the **Stuck test** scenario), checking on the simulator's virtual clock.

## Part 2: Secret fields masked

- **What is masked**: the fields of `SECRET_FIELDS` (a password field, and the `autocomplete` values of
  `SECRET_AUTOCOMPLETE`), in every frame of the page, and the project's own list in **Project → Settings → Live view**,
  written as locators (`getByLabel('IBAN')`), read with `@piwitests/core/locator-chain`.
- **How**: while a masked element shows, the worker reads the boxes of the masked elements through `internalCall` just
  before and just after it takes an image (5 to 11 ms a read, [spike E](#e-masking-an-image-in-the-worker)), and sends
  the image only when both reads agree: Playwright's `onFrame` gives the viewport's size but not its scroll offset, so
  an image taken while the page moves is dropped rather than masked in the wrong place. The image is decoded, painted
  over and encoded again with `jpeg-js`, as Playwright exports it: about 48 ms of CPU for a 640×400 image, and an image
  1.5 times larger than Chrome's at the same quality. So a worker sends at most two images a second while a masked
  element shows, about 10 % of a core while someone watches, and none of this runs while none shows. With video
  (Part 7), the painted image goes to the encoder, since its ffmpeg paints nothing itself.
- **Not masked**: a secret that is not a field's value (a token printed in the page's text). The docs say so, as they
  do today for the images and traces a run keeps.

## Part 3: More than the `page`

- **The test's other pages.** Every page of the contexts the test uses (`context.pages()`, `context.on('page')`) is a
  tab of the view, the `page` fixture's first. A viewer watches one page at a time, and the worker films only the
  pages someone watches.
- **A test with no page.** Its API requests as they happen: method, URL with credentials hidden, status and duration,
  from the proxy every API request context is handed out behind (`api-requests.ts`).
- **The page's errors and failed requests**, from `run-events.ts`'s listeners, listed under the image while someone
  watches.
- **Backend logs.** The warnings and errors the backend instrumentation attaches to a response, as the capture
  fixtures read them, next to the request: a save that hangs shows the server's 500 and its exception as it happens.

## Part 4: The page at each call, as a document

**What a viewer gets.** **Inspect**, beside the image, opens the snapshot view on the latest call's DOM: the page as it
was before the call, at its action and after it, with the ARIA tree, a text search and the picker, which names a
locator for the element clicked, as it does for a stored trace. The snapshot follows each new call until the viewer
pins one. On a test stuck on a locator, the picker gives the locator to use while the test still waits.

**Where the snapshots come from** (D6):

- When the runner already traces the attempt (its `trace` mode records this one), the reporter reads the runner's own
  trace file (`.playwright-artifacts-<n>/traces/` under the output folder), which grows with each call as it is: no
  option is needed, and the archive the runner keeps is unchanged
  ([spike F](#f-the-runners-own-trace-as-the-test-runs)).
- Otherwise, the reporter starts `context.tracing.start({ live: true, snapshots: true })` through `internalCall` when
  the first viewer opens **Inspect**, and stops it unsaved when the last one closes it. A test that calls
  `tracing.start` itself meanwhile gets it: the reporter's guard stops Piwi's tracing first, as `guardScreencast` does.
- The worker reads the trace file as it grows, from the offset it last read, and keeps the watched page's snapshots
  since its last navigation. While a viewer has **Inspect** open, it sends them, then each new one, with the calls' ids
  and titles and the resources the snapshots name (D7). It sends no call's arguments: a `fill` writes its value
  there.

**What it costs.** On a page of 1,000 table rows, about 6,000 elements, the first two snapshots took 108 KB, and each
later one 0.5 to 8 KB: three per action, each repeating only what changed ([spike B](#b-a-live-traces-size)). On five
pages of the dashboard itself, served by its dev server, a page took 0.5 to 0.8 MB of snapshots, and the stylesheets,
images and data its snapshots name 0.7 MB once, beside 49 MB of scripts that are never sent
([spike H](#h-a-real-applications-resources)). The sample application's five pages took 25 KB of snapshots and 9 KB of
stylesheet.

**The relay** keeps a run's resources in memory, bounded per run (64 MB, the least recently used dropped first), and
drops them with the run. Nothing is written to the database or the disk. A script is never relayed (D7).

## Part 5: A whole run at once

- **Every worker.** **Watch all**, on the run page, shows each connected worker's image, 320 pixels wide, one a second.
  A click opens that worker's full view. Each worker in the grid counts as one viewer in the run's bound.
- **Follow.** In the full view, **Follow** moves to the worker whose test just failed, retried or got stuck (Part 1),
  and says why it moved.
- **The last 30 seconds** (D10). When the test's trace or video already records the page, the worker keeps its last 30
  seconds of images in memory, four a second (a few megabytes), and the view gets a slider under the image, the calls
  marked on it. Without such a recording there is no slider: the worker takes no image nobody watches.
- **The last passing run's image.** Beside the live image, the screenshot the trace of the test's last passing
  execution took at the same step, by title and line, when one is stored. It is shown, not compared.

## Part 6: More places to watch from

- **The editor.** The editors already read the latest run of the checked-out branch. A CI run of that branch that is
  still running shows its tests in the editor's run view, the line each one is at marked as a CI position, not a stop,
  and **Watch** opens its view in the panel that shows a paused page, read-only. The editor uses its own instance key,
  and needs what opening the run needs.
- **Piwi Picker.** The Runs window lists the project's CI runs in progress, read-only, through the instance the
  extension is connected to.
- **An agent.** An MCP tool of the instance, `get_live_test`, answers for a running test: its call, its call log, its
  element count and the latest ARIA snapshot when a live trace runs, the page's text between the page-content markers
  the run agent already uses. It takes a viewer's place and steers nothing.
- **A notification.** `test.stuck` (Part 1), with a link to the row.
- **A watch link.** A share link of a third kind, a running run, read-only, behind `PIWI_SHARE_LINKS_ENABLED`, which
  ends with the run: for someone without an account, such as a customer watching an acceptance run. Its anonymous
  route serves the images and the calls' titles, never the DOM, the logs or the requests.

## Part 7: Lighter transport

- **Binary images** (D8). The worker posts each image as the body of its request
  (`application/vnd.piwi.live-frame`: a length-prefixed JSON header with the call and the test, then the JPEG bytes).
  A viewer reads one streamed GET of length-prefixed messages through `fetch`, which carries images and the JSON layers
  alike. The instance keeps reading the JSON body of a reporter that predates it.
- **Sizes from the viewer.** A viewer says how wide it shows the image, in device pixels, up to 1280×800; the worker
  asks the screencast for the largest size its viewers asked. A page whose video records keeps the video's size, since
  the first client's size wins.
- **Video** (D9). The worker pipes its images into Playwright's ffmpeg (VP9, real-time, no look-ahead, its input read
  as it comes, a keyframe every half second, WebM with each cluster opening on a keyframe), the relay keeps the WebM
  header and the stream since the last keyframe, and the viewer plays it through `MediaSource` from its newest frame. A
  viewer that joins starts from the last keyframe, half a second back at most. The view is 0.7 to 1.4 s behind the
  page; the call log (Part 1), sent apart, is not held back with it. The worker
  falls back to images when ffmpeg 1013 is missing (Playwright 1.63 or earlier) or fails, and the viewer asks for
  images when no frame shows within two seconds, as WebKit on Linux did ([spike G](#g-the-live-webm-in-three-browsers)).

## Part 8: Holding a failing CI test

- **The setting**: **Project → Settings → Live view → Hold a failing test for its viewers**, off by default, for a
  Project admin, with a length from one to fifteen minutes (five by default).
- **When**: a test of a CI run fails while at least one person watches its worker. The worker holds the failing page,
  as the editor's failure hold does, and the viewers get the failure, **Inspect** (Part 4) on the failing page, its
  errors and requests, and **Let it go**. The hold ends at its length, at **Let it go**, or when the last viewer
  leaves.
- **What it costs**: CI minutes, and the CI job's own timeout still runs. The run page says the test is held, by whom
  and until when.
- **What it is not**: input, or code run in the page. It is a wait, at a failure, that a person asked for.
- **The record**: run control's D8 says the team instance never steers a run. This part narrows it for this case, and
  the ADR this plan becomes says so, with a link from the run control ADR ([open question 7](#open-questions)).

## Part 9: Documentation

- **`features/live-view.md` is at 1,485 words of its 1,500**: each new feature gets its own page and catalog entry,
  the live view page linking them. **Stuck tests** (Part 1), **Inspect a running test** (Part 4) and **Hold a failing CI
  test** (Part 8) are each a page; the masking (Part 2), the other pages and logs (Part 3) and the transport (Part 7)
  replace sentences of the live view page.
- `test.stuck` on the [notification events](../apps/docs/reference/notification-events.md) page, which the drift test
  checks against `NOTIFICATION_EVENTS`; `get_live_test` on the generated MCP tools page; the watch link on the
  [share links](../apps/docs/features/share-links.md) page; the settings' help topics in `shared/help-content.ts`.
- The live view setting's text, which says what goes out, to whom and what is kept, says it again for the call log, the
  DOM, the backend logs and the hold.
- The demo mirrors each part: the run simulator plays a call log, a stuck test and a snapshot.

## Part 10: Security

- **Masked in the worker** (Part 2, D7): the instance and the viewers never get a secret field's value, in an image or
  in a snapshot. Every text of the call log, the requests and the backend logs goes through
  `@piwitests/core/mask`.
- **No script of the page runs in the dashboard**: none is relayed, and the snapshot view runs none.
- **Who sees it**: who may open the run, as today. An agent reads the page's text only between the page-content
  markers. A watch link carries the images and the calls' titles alone.
- **Nothing kept**: the relay holds images, snapshots and resources in memory, bounded per run, and drops them with
  the run; the last 30 seconds stay in the worker.
- **Steering**: none, except the hold of Part 8, which takes no input, runs no code and is off by default.
- **ffmpeg** reads the images of the test's own page from a pipe; it opens no file and no connection.

## Delivery

Each PR is usable on its own; sizes are relative (S, M, L).

| PR | Content | Size |
| --- | --- | --- |
| 1 | The call log, the action point and the element count in the view (Part 1, without Stuck?), behind the feature check of D2. | M |
| 2 | **Stuck?** and `test.stuck` (Part 1), its page and the notification events page. | M |
| 3 | Secret fields masked, and the project's list (Part 2). | M |
| 4 | Binary images and sizes from the viewer (Part 7, without video). | S |
| 5 | The other pages, a test with no page, the page's errors and requests, the backend logs (Part 3). | M |
| 6 | The page at each call (Part 4): the live trace started or read, the relay of snapshots and resources, **Inspect**, its page. | L |
| 7 | **Watch all**, **Follow** and the last passing run's image (Part 5). | M |
| 8 | The last 30 seconds (Part 5). | S |
| 9 | Video (Part 7). | M |
| 10 | The editor, Piwi Picker, `get_live_test` and the watch link (Part 6), each its own PR if it runs long. | L |
| 11 | Holding a failing CI test (Part 8), its page and the ADR. | M |

PRs 1 to 3 are the first release.

## Verification

- **The reporter**, against a fake instance, as `tests/live-view*.spec.ts` do: the call log of a click on a disabled
  button (spike A's page), the element count of a locator that matches nothing, an image whose password field is painted
  over (its pixels checked), a live trace's snapshots without scripts and without a secret field's value, and the
  guard giving the tracing back to a test that starts its own.
- **The app**: unit tests of the Stuck? rule (once per attempt, the floor, the history), of the binary messages and of
  the relay's bounds; an E2E test of the run page with a simulated worker; the performance suite for the run page.
- **Safari**, on a Mac, before the video PR: the one browser spike G could not reach.

## Risks

- **Playwright's internals.** The call stream (`_enable()`, `apicallsupdated`) is undocumented, and the place of the
  runner's trace files (`.playwright-artifacts-<n>/traces/`) is Playwright's own layout. Each is checked before use and
  has a fallback: no call log, or Piwi's own live trace. A Playwright release may change them: the reporter's tests
  cover each one and its fallback, so the upgrade of Playwright in this repository shows it, and the docs name the
  Playwright versions each part was checked with.
- **The worker's cost**: the element count once a second while a call waits; while a masked element shows, two box
  reads an image and about 10 % of a core for the masking (spike E); a trace's writes and reads (spikes B and H: up to
  0.8 MB a navigation on a heavy page); the encoder (about 4 ms an image). Each runs only while someone watches.
- **The call stream in a run Piwi pauses** (D2): a breakpoint that never stops. The stream is turned on only where
  nothing pauses, and only a test of a CI run proves it.
- **More leaves the worker**: the DOM, the logs, the requests. The masking must be right and the setting's text exact.
- **The viewer's browser**: `MediaSource` with VP9 differs between browsers: WebKit on Linux buffered the stream and
  showed nothing in two runs of three, and Safari is untested (spike G). Images stay the fallback, chosen by the
  viewer when no frame shows.
- **The one server's memory**: a run's resources, up to 64 MB per run with an Inspect open.

## Open questions

1. **Stuck?**: are two minutes and three times the longest passing duration right, and should a project change them?
2. **The project's masked elements**: locators alone, or CSS selectors too?
3. **The masking codec**: is `jpeg-js` enough at two images a second, or is a WebAssembly JPEG codec worth its
   weight in the published reporter?
4. **The watch link**: the images alone, or the call log too?
5. **The hold**: may any viewer hold, or only a project member, and is fifteen minutes the right ceiling?
6. **Watch all**: for one run, or for every running CI run of a project? And against the bound of sixteen viewers a
   run: does a thumbnail count as a viewer, or does the bound become one of bytes a second?
7. **The record of a narrowed decision**: `adr/` supersedes a whole ADR; how does it record one decision narrowed by a
   later plan?
8. **Safari**: does it play the live WebM through `MediaSource`, and how far behind?

## Not in this plan

- **VNC or noVNC.** It needs a headed browser under Xvfb, shows one screen per machine rather than per worker, runs on
  Linux alone, carries more bytes, and its input is control of the CI machine. A team that wants it can run it beside
  Piwi.
- **Remote DevTools, the Chrome DevTools Protocol through the instance.** The protocol evaluates code in the page and
  the browser; a team instance that relays it breaks D8 far beyond Part 8. Part 4 gives the inspection without it.
- **A recording script in the page's own world**, as rrweb records a session: contract 6. The DOM between calls could
  come later from a `MutationObserver` in an isolated world, once Part 4 has shown the DOM at each call is worth it.
- **WebRTC between the worker and the viewer.** CI networks rarely allow the direct connection; the relay through the
  instance works from any CI that reaches it.
- **Input into a CI page from the dashboard**: D8 stands.
- **A relay shared between servers** (D12).
- **Keeping the live view as the run's video**: the trace and video settings keep the record, and the live view keeps
  nothing.

## Defects found while researching this plan

- **A typed password shows in clear in the live view's caption and the run page's live steps.** Playwright titles a
  `fill` step by the text it types: inside a test, the step of `getByLabel('Password').fill('S3cr3t!Passw0rd')` is
  titled `Fill "S3cr3t!Passw0rd"`. The live view's caption is that title (`runningCall` in `capture-fixtures.ts`)
  through `hideSecretsInText`, which leaves it whole, and the reporter streams `pw:api` steps with their raw title
  (`onStepBegin`, `onStepEnd`). The image shows the field's dots; the caption, beside it, shows the password to anyone
  who may open the run, and so does the run page's Live activity. The trace and Playwright's own report hold the same
  title. The agents' call events are not affected: Playwright's instrumentation gives them no title, and
  `run-events.ts` falls back to the method and its selector. **Fixed**: every title the reporter and the editor service
  send live hides the text a `fill`, `type` or `pressSequentially` types (`hideTypedText` in `@piwitests/core/mask`);
  the stored steps hide it when the field's locator looks secret or names none, the call log of an error always, and
  the instance applies the same rules to what an older reporter sends.

## Appendix: the spikes

Run on 2026-10-30 in a sandbox with 4 cores and 15 GB of memory, Node.js 22.22, Playwright 1.64.1 and its Chromium
156.0.8078.4; spike G also with its Firefox 157.0 and WebKit 27.2 (Linux, GStreamer). The scripts lived outside the
repository.

### A. Playwright's call stream

A page with a coupon field and a **Pay** button disabled for 2.5 s; `context.debugger._enable()`, then a `fill`, a
`click` on **Pay** and a `click` on a link that does not exist, with a 1.2 s timeout. Each update of
`apicallsupdated`, by time since the stream was turned on:

- `fill`: at 18 ms, running, no line; at 102 ms, `waiting for getByLabel('Coupon')`,
  `locator resolved to <input id="c"/>`, `fill("WELCOME10")`, `attempting fill action`; at 129 ms, done.
- `click` on **Pay**: at 632, 1,456, 1,971 and 2,489 ms, `waiting for element to be visible, enabled and stable`,
  `element is not enabled`, `retrying click action`, `waiting 500ms`; at 2,546 ms the action point
  (`{ x: 271.15, y: 18.5 }`) and `element is visible, enabled and stable`; at 2,609 ms, done.
- `click` on the missing link: at 3,111 ms, `waiting for getByRole('link', { name: 'Missing' })`, then no line until
  the error at 3,811 ms, `Timeout 1200ms exceeded.`: a locator that matches nothing says nothing more while it waits.

Each update named the call's title as Playwright renders it and its place in the script. With the stream on,
`setPauseBeforeWaitingActions` returns at once (`coreBundle.js`), so a pause of an auto-waiting action falls before
its input.

### B. A live trace's size

`context.tracing.start({ live: true, snapshots: true, screenshots: false })` in a browser launched with a `tracesDir`,
on a page of 1,000 table rows (four cells and a button each), 6 KB of inline style and a form, at 1280×800. The trace
file was measured after each call:

| After | DOM snapshots | Their bytes |
| --- | ---: | ---: |
| `setContent` | 2 | 108,082 |
| a `fill` | +3 | +1,552 |
| a `click` that changes one cell | +3 | +12,527 |
| five `click`s on the rows' buttons | +15 | +113,699 |
| a scroll into view | +2 | +12,856 |

The file grew after every call: it is written as the calls happen. It also held 74 call log events (7,252 bytes) and
seven input events with their action points. The `before` event of `setContent` carried its 93 KB of HTML: a call's
arguments go into the trace. The page loaded no file, so the trace held no resource.

### C. VP9 from Playwright's ffmpeg

The live view's screencast settings (640×400, quality 50) on a page with a spinner and a 300-row table, for 8.6 s:
typing 26 characters, eight scrolls of 600 pixels, then 2 s of the spinner alone. The screencast gave about 214
images, 8.9 KB each on average.

| Sent as | Bytes | Per second |
| --- | ---: | ---: |
| JPEG, four a second (the latest of each quarter second, 21 images) | 186,301 | 21.7 KB |
| JPEG, ten a second (39 images) | 344,361 | 40.1 KB |
| VP9, four a second | 65,026 | 7.6 KB |
| VP9, ten a second | 125,665 | 14.6 KB |

VP9 used `-c:v libvpx-vp9 -deadline realtime -cpu-used 8 -row-mt 1 -b:v 150k -g 40 -lag-in-frames 0`, and WebM with
`-live 1 -cluster_time_limit 1000`. Encoding the 39 images took 0.15 s of CPU, about 4 ms an image. Fed in real time
with the default input probing, ffmpeg wrote nothing until its input ended; with `-probesize 32 -analyzeduration 0
-fflags nobuffer`, its first bytes came 0.79 s after the first image at four a second, and 0.32 s at ten. ffmpeg 1011,
which Playwright 1.63 installs, has `libvpx` (VP8) and no VP9; ffmpeg 1013 has `libvpx-vp9` and no VP8.

### D. The pause with the call stream on

Run at Playwright's level, armed as the capture fixtures arm a context (`armStops`: `requestPause()`, then `next()` at
each stop Piwi does not show), not through Piwi's bar. A page with a coupon field, a **Pay** button enabled after
1.5 s and a text that appears after 3 s; five calls in a row, with the call stream off, then on. The time of each stop
after its call began:

| Call | Stream off | Stream on |
| --- | --- | --- |
| `fill` the coupon | 4 ms | 30 ms, at its input |
| `click` **Pay**, enabled at 1.5 s | 2 ms, **Pay** still disabled | 1,887 ms, once **Pay** was enabled |
| `expect(…).toBeVisible()` on the text | 6 ms | 1 ms |
| `textContent` | 2 ms | 2 ms |
| `click` on a link that does not exist, 2 s timeout | 0 ms | no stop: the call timed out |

**Pause** asked 500 ms into a click waiting for **Pay**: with the stream off, the test stopped at the next call, after
the click (1,961 ms); with it on, at the waiting click's input (1,908 ms). An assertion and a read stop before they run
either way; an input action, with the stream on, only once its element is ready. Nothing turns the stream off: the
client's `_enable()` sets `_apiCallsEnabled`, which only the debugger's constructor sets to false. At an input stop the
element exists, which suits Pick; but a breakpoint on an action whose element never comes would never stop, which is
why D2 keeps the stream out of every run Piwi pauses.

### E. Masking an image in the worker

The 39 images spike C kept at ten a second (640×400, quality 50, 8.8 KB on average), and `jpeg-js` as
`playwright-core/lib/utilsBundle` exports it:

- **Decoding** an image took 14.7 ms; decoding, painting a box and encoding again at quality 50, 47.6 ms: 19 % of a core
  at four images a second, 10 % at two.
- **Size**: the masked image came out 1.55 times the screencast's at quality 50, 1.51 at 40 and 1.40 at 30 (encoding in
  29, 23 and 21 ms): Chrome's encoder is more compact than `jpeg-js` at the same quality.
- **Reading the boxes** of the secret fields through a locator took 4.8 ms a read on a small page and 11.3 ms on the
  page of 1,000 rows.
- **A real frame**: a password typed into a field, filmed at 640×400 from a 1280×800 viewport (scale 0.5, as
  `onFrame`'s `viewportWidth` gives it), its box read, padded by 2 pixels and painted: none of the 1,128 pixels inside
  it kept a color off the mask's.
- **ffmpeg 1013** has no filter that paints a box (its video filters are `scale`, `crop`, `pad`, `format`,
  `transpose`, the flips and `trim`) and reads no raw images, only JPEG: on the video path too, the worker paints a decoded image and encodes it
  again before ffmpeg.

### F. The runner's own trace as the test runs

A project whose config asks for `trace: { mode: 'on', live: true }` only when a variable is set, and a reporter that
sets it in `onBegin`; a test of a dozen calls over 5 s, the trace files listed every half second.

- **The config is read twice**: in the main process, without the variable, and in the worker, with it. So the workers
  of a run can be asked for something the main process does not ask for.
- **With `live`**, the runner wrote a file of the test's own steps (`<test id>-test.trace`, 1.6 KB growing to 6.2 KB)
  beside the context's trace file (0.96 KB growing to 21.9 KB), both under
  `test-results/.playwright-artifacts-0/traces/`. **Without it**, the context's trace file grew the same way (6.1 KB to
  22.2 KB).
- **Read from inside the test, mid-run**, the context's trace file held the same events either way: 5 `before`, 5
  `after`, 9 `frame-snapshot`, 17 `log`, 4 `screencast-frame` and 2 `input`. Playwright writes a call's log lines with
  the next event it writes at once (`_appendTraceEvent`), so the log of a call still waiting may sit unwritten.
- **The archives** of the two runs held the same files and the same events, give or take one screencast image, and both
  runs wrote their HTML report: `live` changes nothing the runner keeps.
- **Piwi's own trace beside the test's**: with the runner's trace off, a trace started as the reporter would start one
  made the test's own `tracing.start` fail with `Tracing has been already started`; once that trace was stopped
  unsaved, the test's start went through and its archive was saved.

### G. The live WebM in three browsers

A page whose clock changes every frame, filmed at 640×400 and fed to ffmpeg at ten images a second for 9 s, the WebM
served to two viewers, one from the start and one joining 3.5 s later, each playing it through `MediaSource` and
timing each frame it showed with `requestVideoFrameCallback` against when that image was fed. Every browser said it
supports `video/webm; codecs="vp9"` and has `requestVideoFrameCallback`.

| Browser | Settings | From the start: frames shown of 90, delay (median) | Joining late |
| --- | --- | --- | --- |
| Chromium 156 | clusters of 1 s | 84, 1.49 s | 61, 1.84 s, from the keyframe it joined at |
| Chromium 156 | clusters of 250 ms, late viewer seeks to the newest frame | 88, 0.74 s | 58, 0.76 s |
| Chromium 156 | clusters of 100 ms | 89, 0.87 s | 60, 0.67 s |
| Chromium 156 | `-dash 1`, a keyframe every 5 images | 82, 1.42 s | 56, 0.96 s, from 3.1 s |
| Firefox 157 | clusters of 250 ms | 80, 0.88 s | 51, 0.72 s |
| Firefox 157 | `-dash 1`, a keyframe every 5 images | 81, 0.91 s | 50, 0.91 s, from 3.6 s |
| WebKit 27.2 | clusters of 250 ms, three runs | 51, 0.67 s in the first; none in the other two | none |

- **Joining late needs clusters that open on a keyframe.** With a keyframe every 20 images and clusters of 250 ms, two
  clusters in 9 s opened on one, so the late viewer was sent the stream from its start. With `-dash 1` and a keyframe
  every 5 images, 18 did, and the late viewer started from the last one. The stream weighed 78.9 KB with `-dash 1` and
  87.9 KB without: at a capped bit rate, the extra keyframes cost little.
- **The delay follows the cluster's length** down to about 250 ms: ffmpeg writes a cluster once it closes.
- **WebKit on Linux**, whose media goes through GStreamer, buffered the whole stream (0.1 to 9.0 s) in every run, and
  showed frames in one run of three. It says nothing of Safari on macOS, whose media stack differs; no Mac was at
  hand.

### H. A real application's resources

`context.tracing.start({ live: true, snapshots: true })`, a page opened, 2.5 s to settle, then one mouse move so the
trace holds the page as it shows; the trace's snapshots and its `resources/` folder measured after each page.

- **The sample application** (`examples/sample-app`, its pages and assets served as its backends serve them, without a
  backend): five pages, 32 snapshots, 25 KB in all. Resources: its stylesheet (9 KB), two scripts (13 KB) and the
  pages' own documents (9 KB).
- **The dashboard**, Piwi's own, from its dev server with the seeded data, on `/projects/1`, `/test-runs/2`,
  `/test-run-cases/37`, `/failure-clusters/10` and `/test-cases/1`: 30 snapshots, 2.99 MB, 0.51 to 0.79 MB a page.
  Resources: 49.4 MB of scripts (the dev server's modules, 1,600 files), and 1.7 MB of the rest: stylesheets 0.64 MB,
  the pages' own documents 0.97 MB, data 0.07 MB, images 0.03 MB. A production build would serve fewer, larger
  scripts and its stylesheets as files; it was not measured.
