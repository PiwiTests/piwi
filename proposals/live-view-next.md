# The live view's next parts

What remains of a plan for the run page's live view. The **live view**
([`features/live-view`](../apps/docs/features/live-view.md)) shows a worker of a CI run, or of a run a developer shares,
to the people watching it: while someone watches, the worker sends images of its test's page, and the instance relays
them and keeps none. Most of the plan is built, much of it through the [live-runs ADR](../adr/live-runs.md), which
took it further: a view follows a lane, and the call the test is in comes first, its pixels one layer of it. This file
keeps the parts not built yet. Where one revisits a decision of the [run control ADR](../adr/run-control.md), it says
so.

**Status.** Proposed 2026-10-30; trimmed to its remaining parts on 2026-11-16. Built: the call log, the action point
and the element count (Part 1); **Stuck?** and `test.stuck`, which leave out the time a test stands stopped since
live-runs P5 ([`features/stuck-tests`](../apps/docs/features/stuck-tests.md)); the secret fields and the project's
masked elements painted over in the worker (Part 2); the page's errors, its failed, pending and API requests and the
backend's logged errors, as a layer of the lane panel (Part 3, through live-runs P11,
[`features/live-view-layers`](../apps/docs/features/live-view-layers.md)); **Inspect**, the page at each call as a
document, with the snapshot picker and its search by text (Part 4,
[`features/live-inspect`](../apps/docs/features/live-inspect.md)); **Watch all** and **Follow what needs attention** on
one watch of the run (Part 5, as live-runs P10 revised it, [`features/watch-all`](../apps/docs/features/watch-all.md)),
and a filmstrip of the test's calls in place of the last 30 seconds (live-runs P11); a CI run of the branch in the
editors and in Piwi Picker's Runs window, read-only (Part 6, through live-runs P10); images as binary bodies at the
size the viewers show them (Part 7, without video); and of Part 9, the live view setting's text, which names everything
a watched worker sends and what the instance keeps, and the demo's call log and Inspect page, which its run simulator
plays without a browser. Left: the parts below. The plan as
proposed, with every part, the decisions D1 to D12, spikes A to H and the defect it found (fixed before its first PR),
is at commit `46c65e9fd`; the live-runs ADR cites its parts, PRs and open questions by those numbers. Parts and decisions keep their numbers here;
the delivery steps and the open questions are numbered anew. Nothing here is on [`ROADMAP.md`](../ROADMAP.md) yet. Its
contracts are entry D62 of [`1.0-stabilization.md`](1.0-stabilization.md); of them, the WebM stream, `get_live_test` and the
share link to a running run are still to come; a held failure moved to [`ci-run-control.md`](../adr/ci-run-control.md).

**Summary.** What remains, in the order it should be built:

- **Where a stuck test waits.** A **Stuck?** row, which names the step the test is in, also says how long that step
  usually takes.
- **The test's other pages**, each a tab of the lane view, not only the `page` fixture's.
- **The ARIA tree in Inspect**, beside each call's snapshot.
- **The last passing run's image** of the same step, beside the live one.
- **VP9 video** from the ffmpeg that Playwright installs, where the worker and the viewer's browser can play it.
- **`get_live_test`**, an MCP tool of the instance, for an agent to read a running CI test, and a **watch link** for
  someone without an account.
- **Holding a failing CI test while someone watches it** moved to its own plan,
  [`ci-run-control.md`](../adr/ci-run-control.md), with pausing a CI test.

Of the five jobs [`ROADMAP.md`](../ROADMAP.md) says Piwi is for, this serves the second, **explain the failures**: a
stuck test placed in its step. It feeds the third, **hand back a fix**.

## Terms

- **Call**: one call of Playwright's API that the test makes (`click`, `fill`, `expect(...).toBeVisible()`), as
  Playwright's trace and its errors name it.
- **Call log**: the lines Playwright writes about a call while it runs
  (`waiting for getByRole('button', { name: 'Pay' })`, `element is not enabled`, `retrying click action`).
- **Lane**: a worker slot of a run (`parallelIndex + 1`, per shard), which a view follows through its tests (live-runs
  D1).
- **Viewer**: a person, or an agent, with a lane's view open.

## What exists

### In Piwi

- **The lane panel** of the run page (`LanePanel.vue`; the worker's side in
  `packages/reporter/src/internal/capture/live-view.ts` and `lane-feed.ts`; the relay in
  `apps/application/server/utils/live-view.ts`). While someone watches a lane of a CI or shared run, its worker posts
  JPEG images of the lane's page as binary bodies (`application/vnd.piwi.live-frame`), at the size and pace its viewers
  ask (1280×800 at most), the page's secret fields and the project's masked elements painted over (`live-mask.ts`,
  with `jpeg-js`, two images a second at most while one shows). The run page reads one watch of the run, a stream of
  length-prefixed messages (`@piwitests/core/live-view`) that also carries **Watch all**'s tiles: 16 watches a run, 4
  a person, 4 MB of images a second for the run's workers together. The instance relays it in one server's memory and
  keeps none. Beside the image: the call, its log, its element count and its action point. Under it, the layers a
  viewer asks for (`@piwitests/core/live-layers`): the filmstrip, the page's events, the page's text as roles and
  names; and **Inspect**.
- **The page a lane shows** is its stop's while it stands at one, else the `page` fixture's, else the first open page
  its test used (`lanePageShown` in `lane-feed.ts`): one source a lane, shared by every sink (the instance's view and
  the local hubs'). A viewer cannot pick another page.
- **Stuck?** (`#shared/stuck-tests`, `server/utils/stuck-tests.ts`): an attempt past the longer of two minutes
  (`STUCK_FLOOR_MS`) and three times (`STUCK_FACTOR`) the longest of its test's last ten passing durations on its
  browser. The row says how long it has run against that duration (`TestRowStuck.vue`), and with the run open the live
  steps name the step it is in. Each execution's steps are stored with its run.
- **Inspect** (`LaneInspect.vue`, `@piwitests/core/live-inspect`, the reporter's `live-inspect.ts`): the snapshot view
  on a call's DOM, before it, at its action and after it, with the picker and a search by text, from the runner's
  growing trace or a live trace of Piwi's own. It shows no ARIA tree. The lane panel's text layer shows the page's ARIA
  text apart from it, from the trace's ARIA files when the project's trace writes them, else from a snapshot taken as
  asked, masked by `maskAriaSnapshot` (`lane-layers.ts`).
- **Hold failures** (live-runs P6): a local run holds a failing test's page for whoever watches it, set per run from
  the editors, the Runs window, the desktop app or an agent. Nothing holds a CI run: run control's D8, "The team
  instance never steers a run; it may show one".
- **Agents** follow a run on their own machine through the local hubs (`run_list`, `run_follow`, live-runs P8). The
  instance's MCP server has no tool for a running test.
- **Share links** ([`public-share-links.md`](../adr/public-share-links.md)): anonymous, read-only links to an
  execution, a failure cluster, a report or a dashboard, behind the default-off `PIWI_SHARE_LINKS_ENABLED`. **Share
  live** ([`features/share-live`](../apps/docs/features/share-live.md)) shows a developer's run to the project's
  members, not to someone without an account.

### In Playwright 1.64

- **`page.screencast`**: one per page; the first client's size and quality apply to the others.
- **`context.pages()` and `context.on('page')`**: a context's pages, and each new one as it opens.
- **The trace's ARIA snapshots**: with `snapshots: { aria: true }`, a trace writes the page's ARIA snapshot before each
  call, at its action and after it (`aria/<callId>-<phase>.json`). `wrapConfig`'s trace does not ask for them.
- **ffmpeg 1013**, which Playwright 1.64 installs with its browsers to record videos: a VP9 encoder (`libvpx-vp9`), the
  WebM format, JPEG images read from a pipe, no network protocol ([spike C](#c-vp9-from-playwrights-ffmpeg)), and no
  filter that paints a box nor any raw image input ([spike E](#e-masking-an-image-in-the-worker)). Playwright 1.63
  and earlier install ffmpeg 1011, whose one encoder is VP8. The reporter supports Playwright from 1.59.

## Decisions

The plan's decisions that bear on what remains. D1 to D8 and D10 are built, or revised by the live-runs ADR, and stay
in the plan as proposed.

| | Decision | Why |
| --- | --- | --- |
| D9 | **Video is a form of the same view, not a second one**: VP9 in WebM from Playwright's ffmpeg, a keyframe every half second, each cluster opening on one (`-dash 1`), when the worker has ffmpeg 1013 and the viewer's browser shows a frame of it within two seconds; images otherwise. | [Spike C](#c-vp9-from-playwrights-ffmpeg): ten images a second as VP9 took a third fewer bytes than four a second as JPEG, at about 4 ms of CPU an image. [Spike G](#g-the-live-webm-in-three-browsers): Chromium and Firefox play it 0.7 to 1.4 s behind, a late viewer from the last keyframe; WebKit on Linux showed nothing in two runs of three. |
| D11 | **Holding a failing CI test** moved to [`ci-run-control.md`](../adr/ci-run-control.md) (its D1 to D3). | It grew a second step, pausing a CI test, and a rule for who may do either. |
| D12 | **One server still relays a run.** A relay shared between servers is a plan of its own, together with the run's live events. | The run page's live events have the same limit; lifting one without the other changes nothing for a viewer. |

## Part 1: Where a stuck test waits

With the run open, a **Stuck?** row names the step the test is in (`TestRowLiveStep.vue`) and how long the test has
run against its usual time (`TestRowStuck.vue`). It also says how long that step usually takes: the median over the
test's last passing executions on its browser, as the failure timeline already reads it for each step
(`getUsualDurations` in `shared/handlers/test-cases.ts`), so a reader tells a test stuck in one step from one slow
throughout. Without the run open, the row and `test.stuck` stay as they are.

## Part 3: The test's other pages

- Every page of the contexts the test uses (`context.pages()`, `context.on('page')`) is a tab of the lane view, the
  `page` fixture's first. A viewer watches one page at a time, and the worker films only the pages someone watches.
- `lane-feed.ts` keeps one source a lane, shared by every sink; this needs one a watched page, each masked as the
  lane's page is, within the run's byte rate. Inspect and the page's text follow the tab shown.

## Part 4: The ARIA tree in Inspect

Inspect shows each call's snapshot as a document, with the picker and a search by text. Beside it goes the ARIA tree of
the same moment: from the trace's `aria/<callId>-<phase>.json` where the project's trace writes them, masked by
`maskAriaSnapshot` as the text layer is, sent with the snapshot while a viewer has Inspect open. A trace that writes
none shows no tree: an ARIA snapshot taken now is not the page at that call, and the text layer already shows the page
as it is now.

## Part 5: The last passing run's image

Beside the live image, the screenshot the trace of the test's last passing execution took at the same step, by title
and line, when one is stored. It is shown, not compared.

## Part 6: An agent and a watch link

- **An agent.** An MCP tool of the instance, `get_live_test`, answers for a running test of a CI or shared run: its
  call, its call log, its element count and the page's latest ARIA snapshot as the text layer gives it, between the
  page-content markers the run agent already uses. It takes a viewer's place in the run's watches and steers nothing.
- **A watch link.** A share link to a running run, read-only, behind `PIWI_SHARE_LINKS_ENABLED`, which ends with the
  run: for someone without an account, such as a customer watching an acceptance run. Its anonymous route serves the
  images and the calls' titles, never the DOM, the page's text, the logs or the requests
  ([open question 2](#open-questions)).

## Part 7: Video

The worker pipes its masked images into Playwright's ffmpeg (VP9, real-time, no look-ahead, its input read as it comes,
a keyframe every half second, WebM with each cluster opening on a keyframe), the relay keeps the WebM header and the
stream since the last keyframe, and the viewer plays it through `MediaSource` from its newest frame (D9). A viewer that
joins starts from the last keyframe, half a second back at most. The view is 0.7 to 1.4 s behind the page; the call
log, sent apart, is not held back with it. ffmpeg paints nothing itself, so the image `live-mask.ts` painted over is
the one encoded, at two a second while a masked element shows. **Watch all**'s tiles stay images. The worker falls back
to images when ffmpeg 1013 is missing (Playwright 1.63 or earlier) or fails, and the viewer asks for images when no
frame shows within two seconds, as WebKit on Linux did ([spike G](#g-the-live-webm-in-three-browsers)).

## Part 8: Holding a failing CI test

Moved to [`ci-run-control.md`](../adr/ci-run-control.md), step 1.

## Part 9: Documentation

- Each new feature gets its own page and catalog entry, linked from the live view page, as Inspect and Watch all are
  (Stuck tests is not linked from it yet): the other pages (Part 3) and video (Part 7) replace sentences of the live view page; the step a stuck test waits in goes on the Stuck tests page,
  the ARIA tree on the Inspect page.
- `get_live_test` on the generated MCP tools page; the watch link on the
  [share links](../apps/docs/features/share-links.md) page.
- The live view setting's text (`ProjectLiveViewSettings.vue`, and `project.live-view` in `shared/help-content.ts`)
  says what goes out, to whom and what is kept for what is built: the images, the call log, the page's events and its
  text, the filmstrip, and Inspect's DOM and resources, kept in the instance's memory while their test runs. It says it
  again for the watch link.
- The demo plays a stuck test with its call log and an Inspect page: its run simulator's workers send each running
  test's call log over the demo's event channel, the stuck PayPal test's retrying the disabled Pay button, and the
  page's own watch keeps them for a lane panel opened later; Inspect shows the checkout page from a committed trace,
  served by the demo's service worker with the server's renderer; the image, page events, text and filmstrip stay
  empty, the panel saying why. It mirrors each part below where it can.

## Part 10: Security

- **Masked in the worker**: another page's images are masked as the lane's page is, and a video encodes the masked
  images. The ARIA tree in Inspect goes through `maskAriaSnapshot`.
- **Who sees it**: who may open the run, as today. `get_live_test` gives an agent the page's text only between the
  page-content markers. A watch link carries the images and the calls' titles alone, and ends with the run.
- **Nothing kept**: the relay holds the WebM since its last keyframe in memory, and drops it with the run.
- **Steering**: none ([`ci-run-control.md`](../adr/ci-run-control.md) plans the hold and the pause).
- **ffmpeg** reads the images of the test's own page from a pipe; it opens no file and no connection.

## Delivery

Each PR is usable on its own; sizes are relative (S, M).

| PR | Content | Size |
| --- | --- | --- |
| 1 | Built: the live view setting's text for what is built, and the demo's call log and Inspect snapshot (Part 9). | S |
| 2 | How long the step a stuck test is in usually takes (Part 1). | S |
| 3 | The test's other pages as tabs (Part 3). | M |
| 4 | The ARIA tree in Inspect (Part 4). | S |
| 5 | The last passing run's image (Part 5). | S |
| 6 | Video (Part 7), once Safari is checked. | M |
| 7 | `get_live_test` and the watch link (Part 6), each its own PR if it runs long. | M |
| 8 | Moved: [`ci-run-control.md`](../adr/ci-run-control.md). | |

## Verification

- **The reporter**, against a fake instance, as `tests/live-view*.spec.ts` do: a second page's images masked, and
  filmed only while its tab is watched; the WebM's clusters each opening on a keyframe, and the fallback to images
  without ffmpeg 1013.
- **The app**: unit tests of the step's usual duration, of the watch link's anonymous route (images and titles alone)
  and of `get_live_test`; an E2E test of the run page with a simulated worker; the performance suite for the run page.
- **Safari**, on a Mac, before the video PR: the one browser spike G could not reach.

## Risks

- **Playwright's internals**: the ffmpeg Playwright installs, its place and version, is Playwright's own layout. It is
  checked before use, with images as the fallback.
- **The worker's cost**: the encoder (about 4 ms an image, spike C); each watched page another source. Each runs only
  while someone watches.
- **The viewer's browser**: `MediaSource` with VP9 differs between browsers: WebKit on Linux buffered the stream and
  showed nothing in two runs of three, and Safari is untested (spike G). Images stay the fallback, chosen by the viewer
  when no frame shows.
- **The watch link**: a running test's images, to someone without an account, until the run ends.
- **The one server's memory**: the WebM since the last keyframe of each watched worker.

## Open questions

1. **Stuck?**: are two minutes and three times the longest passing duration right, and should a project change them?
   `STUCK_FLOOR_MS` and `STUCK_FACTOR` are fixed.
2. **The watch link**: the images alone, or the call log too?
3. **The hold**: moved to [`ci-run-control.md`](../adr/ci-run-control.md), which answers it (D2).
4. **The record of a narrowed decision**: answered there too (D10).
5. **Safari**: does it play the live WebM through `MediaSource`, and how far behind?
6. **Video on the developer's machine**: the live-runs ADR applies Part 7 to the local lane view too; does a view on the
   same machine, where bytes cost little, gain anything from video?
7. **The masking codec**: masking ships with `jpeg-js`, two images a second while a masked element shows. Is a
   WebAssembly JPEG codec worth its weight in the published reporter, for video above all?

## Not in this plan

- **VNC or noVNC.** It needs a headed browser under Xvfb, shows one screen per machine rather than per worker, runs on
  Linux alone, carries more bytes, and its input is control of the CI machine. A team that wants it can run it beside
  Piwi.
- **WebRTC between the worker and the viewer.** CI networks rarely allow the direct connection; the relay through the
  instance works from any CI that reaches it.
- **Remote DevTools, the Chrome DevTools Protocol through the instance.** The protocol evaluates code in the page and
  the browser; a team instance that relays it breaks run control's D8 far beyond Part 8.
- **A recording script in the page's own world**, as rrweb records a session: the reporter's contract 6, nothing the
  capture does shows up as the test's own. The DOM between calls could come later from a `MutationObserver` in an
  isolated world, once Inspect has shown the DOM at each call is worth it.
- **Input into a CI page from the dashboard**: run control's D8 stands ([`ci-run-control.md`](../adr/ci-run-control.md) D6).
- **A relay shared between servers** (D12).
- **Keeping the live view as the run's video**: the trace and video settings keep the record, and the live view keeps
  nothing.

## Appendix: the spikes

The three spikes that bear on what remains, run on 2026-10-30 in a sandbox with 4 cores and 15 GB of memory, Node.js
22.22, Playwright 1.64.1 and its Chromium 156.0.8078.4; spike G also with its Firefox 157.0 and WebKit 27.2 (Linux,
GStreamer). The scripts lived outside the repository. Spike E is cut to what bears on video and the codec; the rest
of it and the other five spikes are in the plan as proposed (commit `46c65e9fd`).

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

### E. Masking an image in the worker

The 39 images spike C kept at ten a second (640×400, quality 50, 8.8 KB on average), and `jpeg-js` as
`playwright-core/lib/utilsBundle` exports it:

- **Decoding** an image took 14.7 ms; decoding, painting a box and encoding again at quality 50, 47.6 ms: 19 % of a core
  at four images a second, 10 % at two.
- **Size**: the masked image came out 1.55 times the screencast's at quality 50, 1.51 at 40 and 1.40 at 30 (encoding in
  29, 23 and 21 ms): Chrome's encoder is more compact than `jpeg-js` at the same quality.
- **ffmpeg 1013** has no filter that paints a box (its video filters are `scale`, `crop`, `pad`, `format`,
  `transpose`, the flips and `trim`) and reads no raw images, only JPEG: on the video path too, the worker paints a
  decoded image and encodes it again before ffmpeg.

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
