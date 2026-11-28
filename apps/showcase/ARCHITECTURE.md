# Showcase: architecture

The map of `apps/showcase/`: how the set is built, how a beat plays and is checked, what each beat asserts, how a take
films the story and how the cut renders the video. The rules are in [`AGENTS.md`](AGENTS.md); the plan, with the parts
still to build (the voice, publishing, the native take), is
[`proposals/showcase-video.md`](../../proposals/showcase-video.md).

## The set

`createSet` (`lib/set.mjs`) makes the set's folder, new in the temporary directory, and points every process the set
starts at it: their temporary files (`TMPDIR`), the editors' discovery files (`PIWI_EDITORS_DIR`, which the editor
service writes and the reporter reads for a run started in a terminal) and the desktop app's file
(`PIWI_DESKTOP_CONFIG`, which the reporter and the editor service read). A developer's own editors and desktop app stay
out of the take, and the set's out of theirs; the build checks the editor service's discovery file lands there.
`buildSet` builds the set in it from scratch for each take, and `close` ends every app, then every process still
working in the folder or whose environment names it (`endStrays`), and removes it. Before anything, `showcase.mjs` takes a CI provider's variables
out of its environment (`CI_VARIABLE`): the developer's runs must not read as CI, which `detectCi` decides from them.

| Piece              | Built by                                     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The instance       | `startInstance` (`lib/instance.mjs`)         | The dashboard's dev server on port 3077, on a database seeded with the demo's history (`seedThrowawayDb`), its output in `results/logs/dashboard.log`. The shop's project `acme-shop` is created with its live view on, and its CI tests held at a failure and paused at a call for those who may control its runs (`liveViewHold`, `liveViewPause`; with authentication off, every viewer may).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The repository     | `buildWorkspace` (`lib/workspace.mjs`)       | `examples/sample-app` with the shop's suite alone (`SHOP_SUITE`), as a git repository with two commits on `main` by a fictional developer: the shop as it shipped, then the redesign (**Pay now** in place of **Place order**, a required **I accept the terms** box). Pushed to a bare `origin.git`; `shop/` is the developer's checkout, with a `.env` naming the instance and the project. The checkout's Playwright config (`headedConfig`) gives actions a 10 s timeout, `SLOW_MO`, and, outside CI, the test's browser its tile and a debugging port.                                                                                                                                                                                                                                                                                                            |
| The "CI" runs      | `startCiRun`                                 | A fresh clone of `origin` at a commit on `main`, the whole suite run headless with `CI=true` (which the reporter's `detectCi` reads, so its global setup asks for a live view key) and `PIWI_ORIGIN=ci` (the run's origin). The shipped commit's run is green, the redesign's red; beat 9 runs the fix's. Each run's JSON report is kept beside its log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| VS Code            | `launchEditor` (`lib/editor.mjs`)            | `apps/vscode/scripts/lib/vscode-window.mjs`'s window, the built extension packaged (`vsce package`) and installed as a person has it, the dark theme, at its tile. Its workbench shows the code and Piwi's marks, little else (`SETTINGS` and `STORAGE` in `lib/editor.mjs`): no side bar, activity bar, menu bar, breadcrumbs, sticky lines or squiggles of the code's problems, Piwi's lenses on a failure alone, Piwi's item alone in the status bar, no count badge, no notification toast but **Debug in my editor**'s question, which beat 2 answers (`hideToasts`, a rule of the window's style), and the terminal a run opens at its tabs and last lines (`shrinkPanel`); Piwi's links trusted (`extensions.confirmedUriHandlerExtensionIds`) and the editor service's traffic traced in its log, a modal question drawn in the window (`window.dialogStyle`). |
| Piwi Picker        | `launchDeveloperBrowser` (`lib/browser.mjs`) | Chromium with the built extension in a profile of its own, paired through its settings page with the address **Piwi: Copy the pairing address for Piwi Picker** copies; its Runs window opened from the popup's **Runs** tile and placed at its tile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The dashboard      | `buildSet`                                   | The developer's browser's first window, over the whole screen, the visitor's Open in IDE choice VS Code with the extension (`IDE_PREFS`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The test's browser | the run                                      | Opened by each headed run, placed by the checkout's config, reached by `attachTestBrowser` over its debugging port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

The stand-ins for what a bare X server lacks:

- **The `vscode://` handler.** The dashboard hands its link to a hidden frame; an init script
  (`HAND_OVER_EDITOR_LINKS`) takes it from the frame's `src` before the browser loads it, and passes it to VS Code's
  command line with the window's profile (`Editor.openUrl`), as the system's handler does. The browser never loads the
  link, so it asks nothing, and no handler of the machine opens it.
- **The host grant Pair asks for.** The extension is copied with the editor's address in its `host_permissions`
  (`pickerWithGrant`), as the prompt that **Pair**'s click opens would grant it; the settings page then pairs at once.

The layout, in CSS pixels at device scale 2 on a 3840 × 2160 screen (`TILES`): VS Code at the top left (1080 × 720), the
test's browser at its right (800 × 540), the Runs window below it (800 × 500), and the dashboard's window over the
screen, raised for the beats about it, its tab zoomed to 125 % (`DASHBOARD_ZOOM`, Piwi Picker's `chrome.tabs.setZoom`):
its page at 2.5 device pixels a CSS pixel, a 1536 × 794 viewport, still at its widest layout, so that it reads at the
cut's size. The zoom holds for the dashboard's origin alone: the Runs window, in the same browser, keeps its 800 × 500
at 2×, which a device scale factor of 2.5 for the whole browser would cut to 640 × 400. A page's place on the screen
counts its window in the browser's pixels and its viewport in its own (`contentOnScreen` in `lib/script.mjs`). Each beat
raises the first window of its `focus`. No window manager runs: Playwright's input reaches its page whatever the
windows' stacking and the pointer's place, in VS Code, the developer's browser and the test's.

## The script

A beat (`beat` in `lib/script.mjs`) has an `id`, its chapter's `title`, its `lines` by language, its `seconds` in the
cut, its `focus`, a `budget`, and, unless it is a card, a `run` and a `check`. A beat that names a `part`
(`{ title, what }`) opens a part of the story, which the beats after it join until the next; the story's first beat
opens one (`lintLines`). The five parts are the video's contents: **CI is red** (`red-run`), **Debug in VS Code**
(`to-the-editor` to `paused`), **Fix the test** (`right-locator` to `green`), **Watch it run** (`watch-running` to
`resumed`) and **Hand it to an agent** (`new-test`, `agent`). `play` runs the beats in order: it calls
`hooks.started`, raises the beat's first window, runs the beat, its check, then `hooks.ended`, all within the budget;
check mode has no hooks, and a take's hold its lines there. A failure
writes `results/failed-<beat>/` (`keepEvidence` in `showcase.mjs`: the screen from ImageMagick's `import`, the VS Code
profile's logs with the extension host's and the Piwi output, every log of `results/logs/` (the dashboard's, the CI
runs' with their reports, Piwi Picker's worker and pages' console), the gestures and the developer's checkout) and ends
the take.

A set that fails to build, or a take whose filming fails to start, leaves the same in `results/failed-set/`, a VS Code
window that did not come up still open for its screen and logs (`keepOnFailure`). A take stopped by SIGINT, SIGTERM or
SIGHUP writes `results/interrupted/` first, synchronously, so nothing has closed yet: Playwright's own handlers, which
close the browsers and exit on SIGINT, are off (`handleSIGINT: false` for the developer's browser, removed after VS
Code's launch), and the dev server's helper stops the server without exiting (`exitOnSignal: false`). The take then ends
the set, the dev server by its process group and the rest by `endStrays`, removes the set's folder, and exits with 128
plus the signal's number.

`--out` names another results folder. A take empties only a folder it marked (`.piwi-showcase-results`) or an empty
one; it refuses one holding other files, and the file system's root, the home folder, the repository's root and the
current folder outright.

The context a beat gets: `set`, `editor` and `vscode` (its page), `dashboard`, `runs` (the Runs window's page),
`testPage()` (the test's page of the run going on), `instance`, `repo`, `gesture`, `palette(title)` (a VS Code command
from F1), `state` (what a beat leaves the next ones) and `skip(bug, what)`.

`Gestures` acts through Playwright, which is trusted input in Chromium and Electron, and logs each move: when it starts
(`t`) and when it acts (`act`), the window, the element's box and the point Playwright acts at in device pixels (the
window's content origin from `screenX`/`screenY`, times the scale; a position given to the click, else the box's
middle, within the window), the text, the key or the palette's command. Its `pace` (a wait before each move, a delay
between keys) is zero in check mode; a take's (`FILM_PACE`, 900 ms and 55 ms) gives the cut's pointer the time to
travel, and scrolls the element into view before its box is read. An agent's tool calls and the push are notes: the
agent's carry what it was asked, or a call's tool and its words (`agent`), which the cut's agent panel shows.

## The beats

| #   | Beat               | What it does                                                                                                                                                                                                                                                                                                           | What its check asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `title`            | a card                                                                                                                                                                                                                                                                                                                 | its line's lint                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 1   | `red-run`          | the project's runs, the red run, the failure page of `places an order`                                                                                                                                                                                                                                                 | the run is red, CI, on `main`; the headline names `getByRole('button', { name: 'Place order' })` as not found; the healing's candidate is `getByRole('button', { name: 'Pay now' })`                                                                                                                                                                                                                                                                                         |
| 2   | `to-the-editor`    | **Source**, **Debug in my editor**, the prompt's **Debug** in VS Code                                                                                                                                                                                                                                                  | the link names the page object's line 19, the spec and the test, with `debug=1`; VS Code has `checkout-page.ts` open at line 19                                                                                                                                                                                                                                                                                                                                              |
| 3   | `run-followed`     | the test's browser opens; the Runs window follows                                                                                                                                                                                                                                                                      | the Runs window's run names `acme-shop`, VS Code and `npx playwright test tests/shop.spec.ts:21 --workers=1 --headed`; the test's browser stands at its tile                                                                                                                                                                                                                                                                                                                 |
| 4   | `paused`           | the run stops at line 19                                                                                                                                                                                                                                                                                               | VS Code's lens `Stopped at a breakpoint · Click getByRole('button', { name: 'Place order' })` and its status bar controls; the pause bar in the page; the Runs window's stop at the line, with the page's image, alike a screenshot of the page without the pause bar (`likeness`, `lib/likeness.mjs`: their luminance on a 40 × 25 grid correlated, 0.95 at least, each tile of 4 × 2 cells within 6 levels of the page's, and their shapes within 2 %), drawn at its shape |
| 5   | `right-locator`    | **Pick** in the Runs window, a click on **Pay now**, the candidate chosen, saved                                                                                                                                                                                                                                       | line 19 on disk clicks `getByRole('button', { name: 'Pay now' })`                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | `missing-step`     | **Record at the stop**, a click on the box, **Stop**, saved                                                                                                                                                                                                                                                            | the recorded `check()` of the box stands on line 19, the click on line 20                                                                                                                                                                                                                                                                                                                                                                                                    |
| 7   | `check-order`      | **End the test** (the stopped test runs its old code), F9 on the spec's summary check, **Debug the test at the cursor** (headed, it stops at the editor's breakpoints, which a plain run passes), **More** and **Assert a region** on the order's card, saved                                                          | a `toMatchAriaSnapshot` above the summary check, read past the thank-you page                                                                                                                                                                                                                                                                                                                                                                                                |
| 8   | `green`            | **Resume**, the Testing view                                                                                                                                                                                                                                                                                           | `places an order (Passed)` in VS Code's Testing view; the developer's run on the instance, the test passed                                                                                                                                                                                                                                                                                                                                                                   |
| 9   | `watch-running`    | the Testing view closed; **Run the test at the cursor** on `places an order`, headless and slowed (`SLOW_MO` in the checkout's `.env` for the beat); once VS Code marks the line the test runs, **Piwi: Watch a worker's test**: the worker's panel beside the editor, 5 s of it, the run to its end, the panel closed | the running line names the worker and its call (`Worker 1 · …`, the decoration's text, `runningLines`); the panel's image showed at each look of the 5 s, 3 images or more, never one for longer than 3 s, no stop's controls (`watchedProblems`); the breakpoint's stop showed in the panel; the test passed on the instance                                                                                                                                                |
| 10  | `back-on-the-team` | commit and push, the fix's CI run on three workers (one a test), its run page, **Watch all**, the tile of `places an order` in full, **Pause** in its lane panel                                                                                                                                                       | Watch all showed the page of two workers or more (`tileProblems`); the lane panel says the CI test is paused (`Paused`, `live-paused-by`) and the test's row too (`data-reason` `pause`), the test not ended                                                                                                                                                                                                                                                                 |
| 11  | `resumed`          | **Resume** in the lane panel, the run to its end, the view closed once it said how the run ended                                                                                                                                                                                                                       | the lane panel showed images through the lane's test, never 15 s apart up to the run's end, named its calls under the image (two at least), showed their filmstrip, and stayed open until it said the run passed (`laneLogProblems`, `lib/watching.mjs`, from the watch recorded in its page as it changed, `recordWatch`); the CI run green, on `main`, at the pushed commit, and so on its page                                                                            |
| 12  | `new-test`         | a new test pasted at the end of the spec's describe, a click on its last line, F9, **Debug the test at the cursor** to it                                                                                                                                                                                              | the new test's last line where it was pasted; the Runs window shows it stopped there                                                                                                                                                                                                                                                                                                                                                                                         |
| 13  | `agent`            | **Copy the runs' MCP server configuration**; the agent, asked to finish the test: `run_list`, `page_snapshot`, `page_act`, `page_snapshot`, `code_write` twice, `run_control`; the file saved once the run ended                                                                                                       | the agent's click and check stand above the test's last line; the test passed on the instance                                                                                                                                                                                                                                                                                                                                                                                |
| 14  | `end`              | a card                                                                                                                                                                                                                                                                                                                 | its lines' lint                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Known bugs

The assertions a check skips, each only once it saw the bug's state. None does: a new skip lists its bug here.

## The take

`--take virtual` (`npm run showcase:film`) plays the same beats, checks included, at a person's pace and films them.
`startFilming` (`lib/take.mjs`), after the set is built:

- opens the dashboard's run page, failure page and **Source** tab once, then the project's runs again (`warmDashboard`):
  the dev server builds a page on its first visit, 20 s a take would film;
- measures each window's content on the screen (`window.screenX`, `outerHeight - innerHeight`, times the scale), the
  test's browser when a beat first reaches it;
- starts the capture (`startCapture`, `lib/capture.mjs`): `ffmpeg -f x11grab -draw_mouse 0 -framerate 24` of the
  whole 3840 × 2160 screen into `results/master.mkv`, H.264 lossless (`-qp 0`, ultrafast, 4:2:0, which is 4:4:4 at the
  1080p cut's size), `-fps_mode cfr` so a frame the grab misses is the one before, repeated, and the master's frame `n`
  is `n / 24` s after its first. Where the system allows it (as root, or through `sudo -n nice` when
  `SHOWCASE_CAPTURE_SUDO=1` says sudo needs no password, as on CI's runners), the capture runs at a higher priority than
  the set's apps, which wait on state and lose nothing by yielding; the take says when it cannot. Up to 128 grabbed
  frames wait for the encoder (4 GB at 4K; 64 measured a capture a quarter of whose frames were repeats);
- shows the sync flash (`syncFlash`): a black window of its own at the screen's bottom-right corner whose square turns
  white for a second, timed at the frame after the one that drew it, then closes;
- follows the test's browser: its debugging port polled every 250 ms says when its window is up (`presence`);
- raises, before each gesture (`prepare`), the layer its window is in: the dashboard's window, which covers the screen,
  or every tile over it (`raise`). Raising needs no window manager. Each raise is logged: the cut shows a window only
  while the master shows it.

Each beat is held (`hooks.ended`) until its lines have been read, one after another from its start, each for its length
at 15 characters a second plus 0.4 s (`lineMs`), or with `--voice` its reading's length plus 0.4 s (`spokenMs`), and
its last action has shown for `SETTLE_MS` (1.2 s). These holds are
the take's, never a beat's: a beat still waits on state. `finish` stops the capture (ffmpeg's `q`, once its encoder has
written up to the stop's time: `q` drops the grabbed frames still waiting) and writes the take log; a beat that fails
ends the take as in check mode, the master and the log kept beside the evidence. The take tells the frames the capture
grabbed against those it wrote: at a constant frame rate a repeated frame matched by a dropped one is a grab that came
late, and repeats beyond the drops are frames missed (it warns past 5 %). The take fails when the capture did
(`captureProblem`): an ffmpeg that did not run, that ended before the take (which the next beat's end notices) or with
an error, or a master holding fewer than 95 % of the frames of the time since its first.

### The take log

`results/take.json`, every time the wall clock's in ms, every rectangle in the screen's device pixels:

| Field      | What it holds                                                                                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `screen`   | `width`, `height` and `scale` (device pixels a CSS pixel)                                                                                                                                                                              |
| `windows`  | each window's content and its page's `dpr`: `vscode`, `dashboard`, `runs`, and `test-browser` once a beat reached it                                                                                                                   |
| `master`   | the file, its `fps`, when ffmpeg was `spawned`, `running` (its first frame) and `stopped`, whether it was `raised`, its counts (`frames` written, `dup` repeated, `drop`), its exit (`code`, `signal`, `error`, `early`) and `problem` |
| `flash`    | `t`, the frame after the one that drew the square, and the square's `box`                                                                                                                                                              |
| `beats`    | each beat played: `id`, `start`, `end` (after its hold), its `lines` with their `text`, `start` and length (`ms`)                                                                                                                      |
| `story`    | every beat of the story, cards included: `id`, `title`, `card`, `part`, `seconds`, `focus`, its lines' texts                                                                                                                           |
| `gestures` | the gestures' log (`t`, `act`, `beat`, `kind`, `window`, `box`, `point`, and the `key`, `text`, `title`, or a note's `what` and an agent's `call`)                                                                                     |
| `raises`   | `{ t, up, window }`: the layer raised (`dashboard` or `tiles`) and the window it was raised for                                                                                                                                        |
| `presence` | `{ t, window, open }`: the test's browser's window coming up or going                                                                                                                                                                  |
| `voice`    | with `--voice`: the voice's `name`, the folder of its readings (`dir`, in the take's results) and each line's reading by its text (`readings`: `file`, `ms`)                                                                           |
| `outcomes` | each beat's outcome, as `outcomes.json`                                                                                                                                                                                                |

### The voice

`--voice` (`lib/voice.mjs`) has the voice read every line of the story before the take, lines first: Kokoro (Kokoro-82M,
Apache-2.0), a local neural voice, with `am_michael`, a young US man's, at its own speed (`VOICE`), from the model files
the kokoro-onnx project releases, downloaded once into `~/.cache/piwi-showcase/voices` (`SHOWCASE_VOICE_CACHE`) and
checked by their SHA-256. `lib/voice.py` reads the lines in one run of a Python with kokoro-onnx (`SHOWCASE_PYTHON`,
else `python3`), the model loaded once. Each reading is a WAV in `results/voice/`, named by a hash of the voice, its
model, its speed and the line, its length read from its header (`wavMs`); a beat holds for those lengths. The whole
story's 31 lines read in about 40 s on four cores, 108 s spoken against the 110 s their reading time estimates.

## The cut

`--cut <take's results>` (`npm run showcase:cut`) renders the video into `<take>/cut/`, or `--out`. `--size 2160`
renders the 4K cut (the camera then never zooms: the master's own pixels are the limit), `--renderers` the number of
stage pages side by side (2), `--beats a,b` those beats alone, without the cards (the parts' included). The cut
refuses an `--out` that is, or holds, the take it reads (`refusal`, `lib/results.mjs`), and a master that ends before
the take's last beat. A signal stops it: every ffmpeg ends, the browser closes and its work folder goes; a renderer
that fails stops the others, and the work folder goes once their encoders have ended.

`planCut` (`lib/cut-plan.mjs`) reads the take log, pure, and gives every output frame its state:

- **The clock.** The flash's frame in the master (`findFlash`: a 3 × 3 grid of the square and its surround, the square
  white and the rest black) ties the wall clock to the master's frames. The cut is the title card, each beat played
  from its start to its end, each part's card before the first of its beats, and the end card, each card as long as
  its `seconds` or its lines, a part's as its line's reading (the first, which lists them all, longer: `PART_CARD`).
  A quiet stretch of a beat (no line read, no gesture, no window coming or going) longer than 3 s plays at 4×, but for
  0.6 s at each end, with a `▶▶ ×4` badge (`FAST`, `pieces`). Output frame `i` (30 a second) shows the master's
  frame nearest its time (`masterFrame`).
- **The world.** Each window is drawn at its place on the screen, in a frame of the stage's own (a bar naming it, its
  corners rounded, a shadow): the right column moved off VS Code and the Runs window off the test's browser by a gap
  (`world`). VS Code keeps its own title bar: its command center drops Quick Open and the command palette over it. A beat shows the windows of its focus and
  of its gestures, each while the master shows it (its layer raised, the test's browser up), fading in and out.
- **The camera** (`lib/camera.mjs`): a view of the world at 16:9, eased (cubic, in and out) over 0.6 to 0.9 s from
  wherever it is, never closer than one output pixel a master pixel, a window shown whole framed below the parts'
  rail (`RAIL_BAND`). A beat starts on its first window, moved to under a part's card before it; a raise brings
  it to the window raised (before the gesture that needs it waits for its element); a gesture in another window moves it
  there (with the other tiles that gestures act in within 2.5 s); a gesture in a window shown smaller than 0.7 zooms in
  on its point and back out 1.4 s after it acts; a window that comes up brings the camera to it and the beat's other
  tiles; a beat without gestures shows the next window of its focus at each line, its last line all of them when there
  are more windows than lines. Between those, the camera holds still. Of those shots it keeps only the moves that earn
  their place (`calmShots`, `CALM`): a move to what is already on screen is left out when it would come closer by less
  than 1.35× or when the wide view already reads (a page's CSS pixel at an output pixel or more, `windows[id].dpr`),
  and moves of a beat 2.5 s apart or less join into one, to a view holding both, left out when it comes out barely
  different. `cut.json`'s `camera` lists the moves planned and kept, each with its two scales.
- **The pointer and the keys** (`lib/cursor.mjs`): the pointer leaves for a gesture's point when it starts, along an
  arc, arrives within 0.65 s and before it acts, a ring grows where it clicks, and it fades after 2.5 s idle. The key
  strip shows a key's caps, a palette command (`F1` and its title), an agent's tool call or a note, for 1.6 s.
- **The cards and the rail**: the title card (the logo and the first line); each part's card, the story's contents
  with the parts done ticked, the part to come named large with its line, the rest dimmed, fading in over the beat
  before it (the first lies under the title card) and out over its first beat, which it holds until then; the end card
  (the install lines and `piwitests.dev`); and the parts' rail across the top through the beats, each part done
  ticked, the one shown with its progress through its beats and the beat's title.
- **The agent's panel** (`agentPanel`): a window the stage draws itself in the Runs window's place, named as scripted
  for the video, up from the agent's first note: what it was asked, then each tool call it made in words, its tool's
  name beside it, the last one running until the next starts or the agent is done. The agent's calls are not on the key
  strip.

The stage (`stage/`) is a page of 1920 × 1080 CSS pixels (at device scale 2 for 4K) that draws a state and nothing
else: each window's content drawn on a canvas from the master's frame, cropped and scaled (`imageSmoothingQuality:
'high'`). `renderRange` (`lib/cut.mjs`) runs one stage page per time range: a `Decoder` (ffmpeg) streams the master's
frames from the range's first as JPEG, in order, which a local server hands the page; each state is drawn and
screenshotted (CDP, PNG), or the last screenshot sent again when neither the state nor the master's frame changed, and
piped into ffmpeg (H.264, CRF 12). No frame is written to disk. The ranges' files, concatenated, are the render, from
which ffmpeg makes the outputs; the subtitles are the stage's plates (PNG with transparency, one a cue), overlaid.

| Output (in `cut/`)                                   | What it is                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `piwi-showcase.mp4`, `piwi-showcase-subtitled.mp4`   | the full cut, H.264 (CRF 20), without and with the subtitles burned in, its voice in AAC when voiced           |
| `piwi-showcase.webm`, `piwi-showcase-subtitled.webm` | the same, VP9 (CRF 34), its voice in Opus                                                                      |
| `piwi-showcase-voice.m4a`                            | the voice track, when the take was voiced or `--voice-track` was given                                         |
| `piwi-showcase.cues.csv`                             | the cue sheet: each line's start and end, its beat and its text, for a person who reads them                   |
| `piwi-showcase.en.vtt`, `.en.srt`                    | every line, the cards' too (the burned subtitles leave those to the cards)                                     |
| `piwi-showcase.chapters.txt`, `.chapters.vtt`        | the parts as video sites read them, none under 10 s (`foldChapters`), and as a `<track kind="chapters">`       |
| `teaser.mp4`, `teaser.webm`                          | the story from the red run to the green test (`TEASER_BEATS`), about 45 s, subtitled, 1920 × 1080, within 7 MB |
| `clips/<nn>-<beat>.mp4`                              | each beat, muted, without subtitles                                                                            |
| `posters/`                                           | the title card's, the teaser's first frame, each clip's at the middle of its lines                             |
| `contact-sheet.jpg`                                  | a frame of the subtitled cut per beat and card but the parts', at the middle of its lines                      |
| `cut.json`                                           | the summary: the render's time, each output's size and encoding time, the segments                             |

The voice track lays each line's reading at its cue, the cards' too (`mixArguments`: `adelay`, `amix`), as long as the
cut, at −16 LUFS and a true peak of −1.5 dBTP (`loudnorm`, `LOUDNESS`), 48 kHz; a line plays at its own speed, as the
cut never plays a line fast. `--voice-track <recording>` takes a person's recording of the cue sheet in its place, laid
from the cut's start. The teaser and the clips stay muted.

The teaser takes each of its beats from its start through its lines and 0.6 s more, grown or shrunk evenly to about
45 s (`teaserParts`), crossfades them, and is encoded in two passes at about the full cut's bitrate (6 MB), lower until
it stays within 7 MB. Its beats leave out no step the next one needs: the failure page's way to the editor, the box the
recording ticks.

## The nightly job

`.github/workflows/nightly-showcase.yml` builds what the set plays, caches VS Code as the VS Code nightly does, starts
Xvfb at 3840 × 2160 in a step of its own, runs the take as the step's own process (`exec`, so the runner's SIGINT on a
cancel or the job's timeout reaches it; `xvfb-run` would not pass it on), and uploads `results/` when the take fails
or is stopped, for two weeks, the master left out. Run by hand with its `film` input, the job installs ffmpeg and the
stage's fonts (Inter, JetBrains Mono), films the virtual take in place of the check, renders the cut and uploads
`results/cut/` as `showcase-cut`, for two weeks. Its `voice` input (on by default) installs kokoro-onnx in a virtual
environment outside the checkout, caches the model by `lib/voice.mjs`'s hash, and films with `--voice`.
