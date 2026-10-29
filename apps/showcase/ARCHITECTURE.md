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

| Piece              | Built by                                     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The instance       | `startInstance` (`lib/instance.mjs`)         | The dashboard's dev server on port 3077, on a database seeded with the demo's history (`seedThrowawayDb`), its output in `results/logs/dashboard.log`. The shop's project `acme-shop` is created with its live view on.                                                                                                                                                                                                                                                                                                                                     |
| The repository     | `buildWorkspace` (`lib/workspace.mjs`)       | `examples/sample-app` with the shop's suite alone (`SHOP_SUITE`), as a git repository with two commits on `main` by a fictional developer: the shop as it shipped, then the redesign (**Pay now** in place of **Place order**, a required **I accept the terms** box). Pushed to a bare `origin.git`; `shop/` is the developer's checkout, with a `.env` naming the instance and the project. The checkout's Playwright config (`headedConfig`) gives actions a 10 s timeout, `SLOW_MO`, and, outside CI, the test's browser its tile and a debugging port. |
| The "CI" runs      | `startCiRun`                                 | A fresh clone of `origin` at a commit on `main`, the whole suite run headless with `CI=true` (which the reporter's `detectCi` reads, so its global setup asks for a live view key) and `PIWI_ORIGIN=ci` (the run's origin). The shipped commit's run is green, the redesign's red; beat 9 runs the fix's. Each run's JSON report is kept beside its log.                                                                                                                                                                                                    |
| VS Code            | `launchEditor` (`lib/editor.mjs`)            | `apps/vscode/scripts/lib/vscode-window.mjs`'s window, the built extension, the dark theme, at its tile; Piwi's links trusted (`extensions.confirmedUriHandlerExtensionIds`) and the editor service's traffic traced in its log.                                                                                                                                                                                                                                                                                                                             |
| Piwi Picker        | `launchDeveloperBrowser` (`lib/browser.mjs`) | Chromium with the built extension in a profile of its own, paired through its settings page with the address **Piwi: Pair with Piwi Picker** copies; its Runs window opened from the popup's **Runs** tile and placed at its tile.                                                                                                                                                                                                                                                                                                                          |
| The dashboard      | `buildSet`                                   | The developer's browser's first window, over the whole screen, the visitor's Open in IDE choice VS Code with the extension (`IDE_PREFS`).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The test's browser | the run                                      | Opened by each headed run, placed by the checkout's config, reached by `attachTestBrowser` over its debugging port.                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The stand-ins for what a bare X server lacks:

- **The `vscode://` handler.** The dashboard hands its link to a hidden frame; an init script
  (`HAND_OVER_EDITOR_LINKS`) takes it from the frame's `src` before the browser loads it, and passes it to VS Code's
  command line with the window's profile (`Editor.openUrl`), as the system's handler does. The browser never loads the
  link, so it asks nothing, and no handler of the machine opens it.
- **The host grant Pair asks for.** The extension is copied with the editor's address in its `host_permissions`
  (`pickerWithGrant`), as the prompt that **Pair**'s click opens would grant it; the settings page then pairs at once.

The layout, in CSS pixels at device scale 2 on a 3840 × 2160 screen (`TILES`): VS Code at the top left (1080 × 720),
the test's browser at its right (800 × 540), the Runs window below it (800 × 500), and the dashboard's window over the
screen, raised for the beats about it. Each beat raises the first window of its `focus`. No window manager runs:
Playwright's input reaches its page whatever the windows' stacking and the pointer's place, in VS Code, the developer's
browser and the test's.

## The script

A beat (`beat` in `lib/script.mjs`) has an `id`, its chapter's `title`, its `lines` by language, its `seconds` in the
cut, its `focus`, a `budget`, and, unless it is a card, a `run` and a `check`. `play` runs the beats in order: it calls
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
travel, and scrolls the element into view before its box is read. An agent's tool calls and the push are notes.

## The beats

| #   | Beat               | What it does                                                                                                                                                          | What its check asserts                                                                                                                                                                                                    |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `title`            | a card                                                                                                                                                                | its line's lint                                                                                                                                                                                                           |
| 1   | `red-run`          | the project's runs, the red run, the failure page of `places an order`                                                                                                | the run is red, CI, on `main`; the headline names `getByRole('button', { name: 'Place order' })` as not found; the healing's candidate is `getByRole('button', { name: 'Pay now' })` (skipped, [known bugs](#known-bugs)) |
| 2   | `to-the-editor`    | **Source**, **Debug in my editor**, the prompt's **Debug** in VS Code                                                                                                 | the link names the page object's line 19, the spec and the test, with `debug=1`; VS Code has `checkout-page.ts` open at line 19                                                                                           |
| 3   | `run-followed`     | the test's browser opens; the Runs window follows                                                                                                                     | the Runs window's run names `acme-shop`, VS Code and `npx playwright test tests/shop.spec.ts:21 --workers=1 --headed`; the test's browser stands at its tile                                                              |
| 4   | `paused`           | the run stops at line 19                                                                                                                                              | VS Code's lens `Paused · Click getByRole('button', { name: 'Place order' })` and its status bar controls; the pause bar in the page; the Runs window's stop at the line, with the page's image                            |
| 5   | `right-locator`    | **Pick** in the Runs window, a click on **Pay now**, the candidate chosen, saved                                                                                      | line 19 on disk clicks `getByRole('button', { name: 'Pay now' })`                                                                                                                                                         |
| 6   | `missing-step`     | the lens's **Record**, a click on the box, **Stop**, saved                                                                                                            | the recorded `check()` of the box stands on line 19, the click on line 20                                                                                                                                                 |
| 7   | `check-order`      | **End the test** (the stopped test runs its old code), F9 on the spec's summary check, **Run the test at the cursor**, **Assert a region** on the order's card, saved | a `toMatchAriaSnapshot` above the summary check, read past the thank-you page                                                                                                                                             |
| 8   | `green`            | **Resume**, the Testing view                                                                                                                                          | `places an order (Passed)` in VS Code's Testing view; the developer's run on the instance, the test passed                                                                                                                |
| 9   | `back-on-the-team` | commit and push, the fix's CI run, its run page, **Watch**                                                                                                            | a frame of the worker's page in the live view; the CI run green, on `main`, at the pushed commit, and so on its page                                                                                                      |
| 10  | `coda`             | a new test pasted, F9 on its last line, run to it; the agent: `run_list`, `page_snapshot`, `page_act`, `code_write` twice, `run_control`                              | the agent's click and check stand above the test's last line; the test passed on the instance                                                                                                                             |
| 11  | `end`              | a card                                                                                                                                                                | its lines' lint                                                                                                                                                                                                           |

## Known bugs

The assertions a check skips, each only once it saw the bug's state:

- **No healing candidate for the story's failure** (beat 1). The reporter keeps no element of a click whose page
  navigates at once (a form's submit, a `location.assign` in its handler): the element capture runs after the action
  (`startElementCapture`), and the page is gone, so the passing runs record no fingerprint of **Place order**. And in
  an ES module suite, the call sites it records lose their leading slash (`captureCallerLocation` strips `file:///`
  from a POSIX path, then makes `tmp/…` relative to the working directory), so they never match a failure's place.
  The check first asserts the healing's answer has its fields and reads the broken locator; a candidate other than
  **Pay now** fails it. It skips the panel's assertions only on the first bug's exact state, which
  `instance.whyNoHealing` reads: the shipped run's JSON report (`ci-shipped.json`, its `piwi-locators` attachment) holds
  the click's snapshot at the failing line with `element: null`, and the instance stores no snapshot at that line. A
  report without snapshots, or a click with its element, fails the beat. The second bug is named when that snapshot's
  location reads the CI checkout's folder without its leading slash.
- **A run page opened while its run sets up stays there** (beat 9). Outside the demo, the run page connects to its
  run's stream only once the run is live, and does not refetch on the global stream's `run-started`, so a page opened
  between the reporter's global setup and its `onBegin` shows `Initializing` and no test until it is reloaded. The beat
  records the run's status as its page loads and waits for either **Watch** or the header still at `Initializing`
  once the instance holds a finished test of the run. It skips only when the run was `initializing` at the load and
  **Watch** shows after a reload; a page stuck otherwise fails it.

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
  is `n / 24` s after its first. Where the system allows it (root), the capture runs at a higher priority than the
  set's apps, which wait on state and lose nothing by yielding; up to 128 grabbed frames wait for the encoder;
- shows the sync flash (`syncFlash`): a black window of its own at the screen's bottom-right corner whose square turns
  white for a second, timed at the frame after the one that drew it, then closes;
- follows the test's browser: its debugging port polled every 250 ms says when its window is up (`presence`);
- raises, before each gesture (`prepare`), the layer its window is in: the dashboard's window, which covers the screen,
  or every tile over it (`raise`). Raising needs no window manager. Each raise is logged: the cut shows a window only
  while the master shows it.

Each beat is held (`hooks.ended`) until its lines have been read, one after another from its start, each for its length
at 15 characters a second plus 0.4 s (`lineMs`), and its last action has shown for `SETTLE_MS` (1.2 s). These holds are
the take's, never a beat's: a beat still waits on state. `finish` stops the capture (ffmpeg's `q`) and writes the take
log; a beat that fails ends the take as in check mode, the master and the log kept beside the evidence. The take tells
the frames the capture grabbed against those it wrote: at a constant frame rate a repeated frame matched by a dropped
one is a grab that came late, and repeats beyond the drops are frames missed (it warns past 5 %).

### The take log

`results/take.json`, every time the wall clock's in ms, every rectangle in the screen's device pixels:

| Field      | What it holds                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `screen`   | `width`, `height` and `scale` (device pixels a CSS pixel)                                                                                          |
| `windows`  | each window's content: `vscode`, `dashboard`, `runs`, `test-browser` (null when no beat reached it)                                                |
| `master`   | the file, its `fps`, when ffmpeg was `spawned` and `stopped`, and its counts: `frames` written, `dup` (repeated) and `drop`                        |
| `flash`    | `t`, the frame that drew the square, and the square's `box`                                                                                        |
| `beats`    | each beat played: `id`, `start`, `end` (after its hold), its `lines` with their `text`, `start` and length (`ms`)                                  |
| `story`    | every beat of the story, cards included: `id`, `title`, `card`, `seconds`, `focus`, its lines' texts                                               |
| `gestures` | the gestures' log (`t`, `act`, `beat`, `kind`, `window`, `box`, `point`, and the `key`, `text`, `title`, or a note's `what` and an agent's `call`) |
| `raises`   | `{ t, up, window }`: the layer raised (`dashboard` or `tiles`) and the window it was raised for                                                    |
| `presence` | `{ t, window, open }`: the test's browser's window coming up or going                                                                              |
| `outcomes` | each beat's outcome, as `outcomes.json`                                                                                                            |

## The cut

`--cut <take's results>` (`npm run showcase:cut`) renders the video into `<take>/cut/`, or `--out`. `--size 2160`
renders the 4K cut (the camera then never zooms: the master's own pixels are the limit), `--renderers` the number of
stage pages side by side (2), `--beats a,b` those beats alone, without the cards.

`planCut` (`lib/cut-plan.mjs`) reads the take log, pure, and gives every output frame its state:

- **The clock.** The flash's frame in the master (`findFlash`: a 3 × 3 grid of the square and its surround, the square
  white and the rest black) ties the wall clock to the master's frames. The cut is the title card, each beat played
  from its start to its end, and the end card, each card as long as its `seconds` or its lines. A quiet stretch of a
  beat (no line read, no gesture, no window coming or going) longer than 3 s plays at 4×, but for 0.6 s at each end,
  with a `▶▶ ×4` badge (`FAST`, `pieces`). Output frame `i` (30 a second) shows the master's frame nearest its time
  (`masterFrame`).
- **The world.** Each window is drawn at its place on the screen, in a frame of the stage's own (a bar naming it, its
  corners rounded, a shadow): the right column moved off VS Code and the Runs window off the test's browser by a gap
  (`world`). VS Code's own title bar is cut off: the stage's frame stands in. A beat shows the windows of its focus and
  of its gestures, each while the master shows it (its layer raised, the test's browser up), fading in and out.
- **The camera** (`lib/camera.mjs`): a view of the world at 16:9, eased (cubic, in and out) over 0.6 to 0.9 s from
  wherever it is, never closer than one output pixel a master pixel. A beat starts on its first window; a raise brings
  it to the window raised (before the gesture that needs it waits for its element); a gesture in another window moves it
  there (with the other tiles that gestures act in within 2.5 s); a gesture in a window shown smaller than 0.7 zooms in
  on its point and back out 1.4 s after it acts; a window that comes up brings the camera to it and the beat's other
  tiles; a beat without gestures shows the next window of its focus at each line, its last line all of them when there
  are more windows than lines. Between those, the camera holds still.
- **The pointer and the keys** (`lib/cursor.mjs`): the pointer leaves for a gesture's point when it starts, along an
  arc, arrives within 0.65 s and before it acts, a ring grows where it clicks, and it fades after 2.5 s idle. The key
  strip shows a key's caps, a palette command (`F1` and its title), an agent's tool call or a note, for 1.6 s.
- **The cards and the labels**: the title card (the logo and the first line), the end card (the install lines and
  `piwitests.dev`), each beat's chapter label, top left.

The stage (`stage/`) is a page of 1920 × 1080 CSS pixels (at device scale 2 for 4K) that draws a state and nothing
else: each window's content drawn on a canvas from the master's frame, cropped and scaled (`imageSmoothingQuality:
'high'`). `renderRange` (`lib/cut.mjs`) runs one stage page per time range: a `Decoder` (ffmpeg) streams the master's
frames from the range's first as JPEG, in order, which a local server hands the page; each state is drawn and
screenshotted (CDP, PNG), or the last screenshot sent again when neither the state nor the master's frame changed, and
piped into ffmpeg (H.264, CRF 12). No frame is written to disk. The ranges' files, concatenated, are the render, from
which ffmpeg makes the outputs; the subtitles are the stage's plates (PNG with transparency, one a cue), overlaid.

| Output (in `cut/`)                                   | What it is                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `piwi-showcase.mp4`, `piwi-showcase-subtitled.mp4`   | the full cut, H.264 (CRF 20), without and with the subtitles burned in             |
| `piwi-showcase.webm`, `piwi-showcase-subtitled.webm` | the same, VP9 (CRF 34)                                                             |
| `piwi-showcase.en.vtt`, `.en.srt`                    | every line, the cards' too (the burned subtitles leave those to the cards)         |
| `piwi-showcase.chapters.txt`, `.chapters.vtt`        | the chapters, as video sites read them and as a `<track kind="chapters">`          |
| `teaser.mp4`, `teaser.webm`                          | beats 1, 4, 5 and 8, about 30 s, subtitled, 1280 × 720, within 1 MB                |
| `clips/<nn>-<beat>.mp4`                              | each beat, muted, without subtitles                                                |
| `posters/`                                           | the title card's, the teaser's first frame, each clip's at the middle of its lines |
| `contact-sheet.jpg`                                  | a frame of the subtitled cut per beat and card, at the middle of its lines         |
| `cut.json`                                           | the summary: the render's time, each output's size and encoding time, the segments |

The teaser takes each of its beats from its start through its lines and 0.6 s more, grown or shrunk evenly to about
30 s (`teaserParts`), crossfades them, and is encoded in two passes at the bitrate that keeps it within 1 MB, lower
until it does.

## The nightly job

`.github/workflows/nightly-showcase.yml` builds what the set plays, caches VS Code as the VS Code nightly does, starts
Xvfb at 3840 × 2160 in a step of its own, runs the take as the step's own process (`exec`, so the runner's SIGINT on a
cancel or the job's timeout reaches it; `xvfb-run` would not pass it on), and uploads `results/` when the take fails
or is stopped, for two weeks, the master left out. Run by hand with its `film` input, the job installs ffmpeg and the
stage's fonts (Inter, JetBrains Mono), films the virtual take in place of the check, renders the cut and uploads
`results/cut/` as `showcase-cut`, for two weeks.
