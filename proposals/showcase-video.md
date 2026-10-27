# A showcase video, made by a script that runs every Piwi tool together

A plan for a short video that shows Piwi as one product: a red CI run on the dashboard, the editor opening at the
failing line, the test paused in its browser, Piwi Picker beside it, the fix written into the code, the run green again
on the team instance. The video is not edited by hand. A script plays the story on the real tools (the dashboard, VS
Code with Piwi's extension, Piwi Picker in Chrome, the reporter, the test's browser) on one virtual screen, records it,
and renders the cut: the zooms, a cursor that reads at any size, subtitles and, if asked, a voice. Played without the
recording, the same script is a check that the tools still work together, which no test does today.

**Status.** Proposed 2026-10-27. Nothing is built. Two measurements in the [appendix](#appendix-what-was-measured)
settle how the screen is captured and how the cut is rendered. The story needs pieces of
[`run-control.md`](run-control.md) that are not merged yet: the editor's controls (its PR 2, beats 4 and 8), the Runs
window (PR 3, beats 3 and 5), **Assert a region** (PR 4, beat 7), **Debug in my editor** (PR 7, beat 2) and the
dashboard's live view (PR 8, beat 9). A first cut can be made once its PR 3 has shipped, with today's **Open in IDE**
in place of **Debug in my editor** and the run page's **Live activity** in place of the live view. Nothing here is on [`ROADMAP.md`](../ROADMAP.md).

**Summary.**

- **One story, three minutes**: an order the shop's redesign broke, fixed from the failure page to the green run,
  every step on a real tool (the [story](#the-story)).
- **Filmed from a script, on the real tools**: the sample app and its suite, a local dashboard, VS Code with the built
  extension, Chrome with the built Piwi Picker, the test's own browser, on one Xvfb screen at twice the output's size.
- **The cut is rendered, not edited**: a stage page draws each frame from the recording, the camera on the window that
  matters, a cursor and click marks from the input log, subtitles and cards; ffmpeg encodes it.
- **Subtitles always, a voice on request**: the script's lines are the subtitles; a voice is synthesized from them, or
  read by a person from the exported cue sheet. Voice and picture are timed from the lines before filming.
- **The same script is a check**: without capture or holds it runs in a few minutes and asserts each beat, the only
  end-to-end check across the dashboard, the editor, the extension and the reporter.
- **Every release can re-film it**: the cut follows the UI as the screenshots do; short clips of single beats serve the
  docs pages.

## The story

**Acme Shop's checkout redesign.** The sample app's shop (`examples/sample-app`, its Nitro backend) gains a redesign
on `main`: **Place order** becomes **Pay now**, and the shipping form gains a required **I accept the terms** box. The
suite's `places an order` test (`@critical`) fails in CI on the button. The developer fixes it without reading a trace:

| # | Beat | What the viewer sees | Surfaces | Needs | ≈ s |
| --- | --- | --- | --- | --- | --- |
| 0 | Title | Piwi's logo; "From a red run to a fixed test, without leaving your flow." | card | | 4 |
| 1 | The red run | The project's runs; CI run on `main`, red; the failure page of `places an order`: the screenshot, the timeline, **Most likely** naming the missing button, the healing panel's candidate `getByRole('button', { name: 'Pay now' })` | dashboard | shipped | 22 |
| 2 | To the editor | **Debug in my editor**: VS Code opens `checkout-page.ts` at the failing line and runs the test headed with a breakpoint there | dashboard, VS Code | run-control PR 7 (first cut: **Open in IDE**, then the breakpoint and the run from the editor) | 14 |
| 3 | The run, followed | The test's browser opens beside the editor; the Piwi Picker Runs window follows it: the test, its last call | VS Code, test browser, Piwi Picker | run-control PR 3 | 10 |
| 4 | Paused | The test stops at the line: the execution point and its inlay in VS Code, Piwi's pause bar in the page, the stop in the Runs window with an image | all three | run-control PRs 2–3 | 14 |
| 5 | The right locator | **Pick** in the Runs window; the picker in the test's window; a click on **Pay now**; the line in VS Code becomes `getByRole('button', { name: 'Pay now' })` | Piwi Picker, test browser, VS Code | shipped (the pick), PR 3 (from the Runs window) | 18 |
| 6 | The missing step | **Record here**: a click on **I accept the terms**; VS Code writes `await this.page.getByLabel('I accept the terms').check();` above the line in the page object | test browser, VS Code | shipped | 18 |
| 7 | Check the order | **Run to Cursor** on the spec's summary check, past the thank-you page; **Assert a region** on the order summary: a `toMatchAriaSnapshot` lands in the spec | Piwi Picker, VS Code | run-control PRs 2 and 4 | 18 |
| 8 | Green | **Resume**: the test passes; the Runs window's verdict; VS Code's test tree green | VS Code, Piwi Picker | run-control PRs 2–3 | 8 |
| 9 | Back on the team | The change pushed; the CI run on the dashboard; **Watch** on its worker: the page streaming beside its step; the run turns green | dashboard | run-control PR 8 (first cut: the run page's **Live activity**) | 22 |
| 10 | Coda (one of) | A coding agent finishes a test through Piwi's tools (run-control PR 9), or the desktop app's Flake Lab reproduces a flaky test (run-control PR 6) | VS Code or desktop | PR 9 or PR 6 | 18 |
| 11 | End | Install lines: the reporter, VS Code and JetBrains, Chrome and Firefox; `piwitests.dev` | card | | 6 |

About three minutes. Each beat is also a short clip of its own (Part 6). Caption drafts, one or two per beat, live
with the script (Part 2); for example, beat 4: "The test stops at your breakpoint. The editor, the page and Piwi
Picker show the same place."

## What exists

| Piece | Where | What it gives this plan |
| --- | --- | --- |
| The landing page's video | `apps/application/scripts/record-demo-video.mjs`, `apps/docs/public/demo-live-run.mp4` | Playwright's `recordVideo` of the demo's run simulator, turned into H.264 by ffmpeg: 12.6 s, 245 KB, committed. One surface, no zoom, no text. |
| Feature screenshots | `apps/application/scripts/take-feature-screenshots.mjs` (`SCENES`), `npm run app:screens` | Scenes against a seeded local dashboard, recaptured as the UI changes; the model for "re-film on every release". |
| VS Code, driven | `apps/vscode/scripts/take-screenshots.mjs`, `lib/vscode-window.mjs`, `lib/editor-fixture.mjs` | `_electron.launch` of a downloaded VS Code with the built extension, under Xvfb at 2×, quiet settings, the palette driven through the DOM ([`real-editor-checks.md`](real-editor-checks.md) §3). |
| JetBrains, driven | `apps/jetbrains/scripts/take-screenshots.mjs`, `scripts/xinput.py` | WebStorm under Xvfb at 2×, input through XTEST, a written keymap; the license is the cost ([`real-editor-checks.md`](real-editor-checks.md) §2). |
| Piwi Picker, driven | `apps/extension` e2e (`launchWithExtension`, the docs-screenshots spec) | The built extension in a persistent Chromium context at 2×, its popup and pages driven by Playwright. |
| The sample app | `examples/sample-app` (Nitro backend, `tests/shop.spec.ts`, page objects) | A real shop and a real suite that reports to a dashboard, backend logs included. |
| A local dashboard with data | the run-app skill, the demo seed (`generate-demo-seed.mjs`) | A dev server and seeded history; a real run reaches it through the reporter. |
| A display in CI | `.github/workflows/nightly-vscode.yml` (`xvfb-run`) | The nightly pattern for a job that needs a screen. |
| Tools on the machine | ffmpeg (libx264, SVT-AV1, VP9, Opus, AAC, libass), Xvfb, ImageMagick | Capture, subtitles, encoding; no TTS installed. |

## Decisions

| | Decision | Why |
| --- | --- | --- |
| D1 | The video is made by a script, from beats written as code, and re-made on release. | A hand-edited video is stale at the next UI change; the screenshots already follow the UI this way. |
| D2 | Everything on screen is real: the sample app and its suite, a local dashboard, the built VS Code extension and editor service, the built Piwi Picker, the reporter, the test's browser. Only the "CI" run is made by the script, a real headless run of the redesign's commit reported with `PIWI_ORIGIN=ci`. | The video then proves what it shows, and the script can check it (D9). Stubs (the editor fixture's stub instance) look the same but test nothing together. |
| D3 | One Xvfb screen at 3840 × 2160, every app at device scale 2, recorded whole by ffmpeg's `x11grab` at 24 frames a second; the cut is 1920 × 1080. | Playwright's `recordVideo` and `page.screencast` record at the page's CSS size, 960 × 600 for a 2× page asked for 1920 × 1200 (appendix): a zoom would blur. The X screen holds every window on one clock. 4K at 30 fps dropped to 23.7 here. |
| D4 | The windows are tiled without overlap, each at a fixed place; the cut composes them. | Capture stays simple and every window is always fully visible in the master; the stage can still move, scale and overlap them on its own background (Part 4). No window manager: on a bare X server the keys go to the window under the pointer (to check per app in V1). |
| D5 | What the viewer sees done is done as a person does it: the pointer moves and clicks and the keys are typed through XTEST, at screen coordinates computed from each element's box. Waits and reads go through Playwright, the DOM and the editor's API. | The apps get trusted input (the picker and the recorder need it), the same in Chromium, Electron and a JetBrains IDE; the script stays robust because it waits on state, never on time. |
| D6 | The cut is rendered by a stage page, frame by frame: the master's frame, the camera, a cursor and click marks from the input log, subtitles, cards; Playwright screenshots each frame and ffmpeg encodes. | Eased zooms, rounded window frames with shadows, a large cursor and branded cards are CSS. ffmpeg's `zoompan` and `drawtext` cannot ease or lay out; Remotion does all this but needs a company license past three people. 0.29 s a frame measured (appendix). |
| D7 | Timing comes from the lines: before filming, each line's voice (or its reading time without one) sets the least a beat holds. | Picture and voice then line up without retiming; a beat that runs longer than its line simply shows more. |
| D8 | Subtitles always (burned into the social cut, a `.vtt`/`.srt` beside the others); a voice on request: none by default, a local TTS, a hosted one with a key from the environment, or a person reading the exported cue sheet. | The landing page plays muted; a synthetic voice is fine for review, maybe not for the release; the choice stays the maintainers'. |
| D9 | The script has two modes: **film** (capture, holds, the cut) and **check** (no capture, no holds, every beat's assertions). Check runs nightly. | Nothing else runs the dashboard, the editor service, both editors' clients, the extension and the reporter together. |
| D10 | Large files never go into git: the full cut is a release asset (and wherever the maintainers post it); only the teaser (as small as `demo-live-run.mp4`), the posters and the subtitles are committed. | The repository already keeps its one video at 245 KB. |

## Part 1: The set

- **The workspace**: a temporary copy of `examples/sample-app` made a git repository with two commits, the shop before
  the redesign (the suite green) and the redesign (`places an order` red), on the Nitro backend so no .NET is needed.
  The fix is made on camera.
- **The instance**: a local dashboard (the run-app skill's dev server) on a fresh database: the demo seed for a
  believable history, the project of the sample app, and the "CI" runs: a real headless run of the first commit, green,
  then one of the redesign, red, both reported with `PIWI_ORIGIN=ci` and a branch of `main`. The healing panel's
  candidate and **Most likely** come from that real failure.
- **The developer's browser**: Chromium with the built Piwi Picker in a persistent profile, paired with VS Code's Send
  to editor listener and with the instance's login, the dashboard in its first tab. The testing build's infobar must
  not show (check the launch flags).
- **The editor**: VS Code through `lib/vscode-window.mjs` at 2×, the built extension, the workspace open, quiet
  settings, the instance named through `PIWI_DASHBOARD_URL` and the project. JetBrains is a second cut (Open question
  5).
- **The test's browser**: started by the run the editor starts; its place and size come from the workspace's
  Playwright config (`launchOptions.args`: `--window-position`, `--window-size`, `--force-device-scale-factor=2`).
- **The layout** on the 3840 × 2160 screen (device pixels):

```
┌───────────────────────────────┬──────────────────────────────┐
│ VS Code            2160 × 1440 │ Test's browser   1600 × 1080 │
│                                │                              │
│                                ├──────────────────────────────┤
│                                │ Piwi Picker Runs  1600 × 1000│
├───────────────────────────────┤ (the developer's browser    │
│ (free: terminal, toasts)       │  holds the dashboard in its  │
│                                │  own window, full screen when│
│                                │  beats 1, 2 and 9 need it)   │
└───────────────────────────────┴──────────────────────────────┘
```

The dashboard's window is raised over the tiles for beats 1, 2 and 9 and lowered after (`XRaiseWindow` needs no
window manager); the stage shows only the window the beat is about.

## Part 2: The script

A beat is a function and its text:

```ts
beat({
  id: 'pick',
  lines: { en: ['Pick the button on the page.', 'The locator is written at the line where the test stopped.'] },
  focus: ['runs', 'test-browser', 'vscode'],          // the windows the camera moves through, in order
  async run({ runs, testBrowser, vscode, gesture }) {
    await gesture.click(runs.getByRole('button', { name: 'Pick' }));
    await gesture.click(testBrowser.getByRole('button', { name: 'Pay now' }));
    await vscode.waitForLine('tests/pages/checkout-page.ts', /getByRole\('button', \{ name: 'Pay now' \}\)/);
  },
  async check({ workspace }) {
    expect(workspace.read('tests/pages/checkout-page.ts')).toContain("getByRole('button', { name: 'Pay now' })");
  },
});
```

- **`gesture`** turns a Playwright locator (or an editor position) into screen coordinates: the element's box, the
  window's content origin on the screen (`window.screenX`, `screenY` and the frame's offsets, times the device scale),
  then moves the X pointer there along an eased path at 60 steps a second and clicks through XTEST; typing goes key by
  key at a person's pace. Every gesture is logged with its time and its screen box.
- **Waits are on state**: a locator visible, a line in a file, the session's stop in the editor service, the run's
  status on the instance. A beat that does not reach its state in its budget fails with a capture of the whole screen
  and the logs of each app.
- **`focus`** and the logged boxes tell the camera where to look; a beat can name a box (`focus: [['vscode', box]]`).
- **The lines** are the subtitles; the voice, when asked, is made from them. Each line is at most two rows of 42
  characters and is read at 17 characters a second at most; the script fails a line that breaks that.

## Part 3: Capture

- `ffmpeg -f x11grab -framerate 24 -video_size 3840x2160 -draw_mouse 0`, lossless (`libx264 -preset ultrafast -qp
  0`): the real pointer is left out, the stage draws its own (Part 4). About 1 MB a second on a calm screen.
- **One clock**: the capture's start and every log entry are wall-clock times; a sync flash (a white square shown by
  the stage page in its own window for one frame at start) checks the offset.
- **A take is the whole story**, about four minutes with the holds; a beat that fails ends the take. The set is
  rebuilt from scratch for each take, which a script makes cheap.

## Part 4: The cut

The stage is an HTML page the size of the output (1920 × 1080, or 3840 × 2160 for a 4K cut). For each output frame
at time `t` it shows:

- **The windows** of the beat, each cut from the master frame (decoded once to JPEG frames with ffmpeg), on Piwi's
  background, with rounded corners and a soft shadow; a window can slide in or out between beats.
- **The camera**: a transform moving from one focus to the next with an ease of 0.6 to 0.9 s, never closer than 2×
  (the master's own pixels at 2×), holding still while a line is read.
- **The cursor**: a large pointer moving along the gesture log's path, a ring at each click, a key strip for shortcuts
  (`F5`, `Ctrl+Shift+5`) when the beat uses one.
- **The subtitles**: the current line, bottom centre, white on a dark plate; burned into the social cut only.
- **The cards**: title, chapter labels in a corner (`Paused`, `The right locator`), the end card; the logos in
  `apps/docs/public/` and the docs site's fonts.

Playwright screenshots the stage at each frame (30 a second for the output; the 24 fps master's nearest frame) and
ffmpeg encodes H.264 for the MP4, VP9 or AV1 for the WebM, Opus or AAC for the voice. Rendering is about 0.3 s a frame,
25 minutes for three minutes in one renderer, and splits across renderers by time range.

## Part 5: Voice and subtitles

- **Lines first**: `voice` renders each line to a WAV before filming (or estimates its length at 15 characters a second
  without a voice); the beat holds at least that long, plus 0.4 s.
- **Providers**: `none` (default); `local` (a neural TTS such as Piper, offline; check the voice model's license);
  `hosted` (a provider's API with a key from the environment, never committed); `person`: the script writes a cue sheet
  (line, start, length) for someone to read, and their recording replaces the track.
- **Mixing**: the lines at their start times, a music bed if one is supplied (CC0 or owned), ducked under the voice;
  loudness normalized for the web (−16 LUFS).
- **Subtitles out**: `.vtt` for the docs' player, `.srt` for video sites; English first, other languages from
  translated lines with the same cues (Open question 3).

## Part 6: What comes out, and where it goes

| Output | Size | Where |
| --- | --- | --- |
| The full cut, 1080p MP4 and WebM, subtitles burned in or not, with or without voice | ≈ 3 min | A release asset; the maintainers post it where they choose |
| The 4K master cut | ≈ 3 min | A release asset |
| The teaser: beats 1, 4, 5 and 8, muted, subtitled | ≈ 30 s, 1 MB at most | `apps/docs/public/`, the landing page and the README beside or in place of `demo-live-run.mp4` |
| One clip per beat, muted | 10–20 s each | The docs page of its feature (`editor-run-control.md`, the Runs window's page, the failure timeline) |
| Posters, the chapter list, the cue sheet, the subtitles | | Beside the cut; posters and subtitles committed |

## Part 7: As a check

- **Check mode** builds the same set, plays every beat with no capture, holds or voice, and runs each beat's `check`.
  It takes a few minutes; it needs VS Code downloaded, Chromium, a display (`xvfb-run`), and the editor service and
  extension built.
- **Nightly**, beside `nightly-vscode.yml`: a failure keeps the whole screen's capture of the failing beat, each app's
  log (the dashboard, the editor service, VS Code's extension host, the extension's worker) and the workspace.
- It covers what no suite covers today: the reporter reaching a real instance, the failure page's clue and candidate on
  a real failure, the editor's open link, a breakpoint run from the editor, the session in the editor service, the
  extension's hub connection, a pick and a recording landing in the file, and the run's result reaching the instance.

## Delivery

Each PR is usable on its own; sizes are relative (S, M, L).

| PR | Content | Size | Needs |
| --- | --- | --- | --- |
| V1 | The set and the script in check mode: the workspace and its history, the instance and its "CI" runs, VS Code, Piwi Picker paired, gestures through XTEST, the beats of today's tools (1, 3–6, 8 and 9 as **Live activity**), each checked; the nightly job. | L | run-control PR 3 |
| V2 | Capture and the cut: the master, the stage, the camera, the cursor, subtitles, cards; the full cut, the teaser, the clips, the posters. | M | V1 |
| V3 | Voice and publishing: the providers, lines-first timing, mixing, the cue sheet; the teaser on the landing page; the docs' clips. | S | V2 |
| V4 | The story complete: **Debug in my editor**, **Assert a region**, **Watch**, the coda; a JetBrains cut if wanted. | M | run-control PRs 4, 7, 8 (and 6 or 9) |

The script lives in `apps/showcase/` (a private workspace, never published), with its own guide.

## Verification

- **The script**: check mode passes locally and nightly; each beat's check fails when its feature is broken (break one
  on purpose per beat while V1 is built).
- **The cut**: a contact sheet, one frame per beat at its line's middle, reviewed before a release's video is posted;
  the subtitles' lint (rows, characters, reading speed); the teaser's size checked like the docs' images.
- **By hand**: watch the full cut once, sound on and off, at 100 % and on a phone.

## Risks

- **A long script across five programs is fragile.** Each beat waits on state with a budget and fails with the whole
  screen; the set is rebuilt each take; check mode runs nightly so drift shows the day it happens.
- **Capture at 4K is heavy**: 23.7 frames a second for 30 asked on four cores here, hence 24. On a smaller machine,
  3200 × 1800 (1.67× headroom) is the fallback; the cut is unchanged.
- **The look of a bare X server**: no window titles, no dock; the stage draws its own frames, so the video does not
  pretend to be a given OS. Fonts must be installed for the apps to look as on a desktop (the container has a few).
- **Rendering time**: about 25 minutes per three minutes of cut in one renderer, less across several.
- **Voices and music** carry licenses; nothing is committed that the project may not publish, and no key is.
- **What the video shows**: a fictional shop, fictional people and addresses; no real token on screen (the pairing is
  made before filming); no real company's brand.
- **JetBrains** needs a license or the trial on the machine that films ([`real-editor-checks.md`](real-editor-checks.md) §2).
- **The run-control pieces may move** while they are built; the beats that need them come last (V4).

## Open questions

1. **The voice**: none, a synthetic one, or a person's (the cue sheet)? Recommendation: subtitles and a synthetic voice
   for review; a person's voice, or none, for the release.
2. **Length**: three minutes for the full cut, thirty seconds for the teaser? Recommendation: yes.
3. **Languages**: English only, or French subtitles too? Recommendation: English first; French subtitles from the same
   cues if wanted.
4. **Where the full cut is posted**: a release asset only, or a video site too? Recommendation: both, the landing page
   linking to it.
5. **The editor**: VS Code only, or a second cut in WebStorm? Recommendation: VS Code; WebStorm when the license on the
   filming machine is settled.
6. **The coda**: the coding agent (run-control PR 9) or the desktop app's Flake Lab (run-control PR 6)? Recommendation:
   the agent; the desktop app filmed on a machine that builds it, as its own clip.
7. **The look**: dark editor and dashboard, as `demo-live-run.mp4`? Recommendation: dark, with the brand's background
   behind the windows.

## Not in this plan

- **A hand-edited video.** The script can export its master and log for someone who wants one.
- **Filming on macOS or Windows.** The script targets Linux under Xvfb, where CI runs; a maintainer can film the
  desktop app on their own machine for its clip.
- **The desktop app in the main story.** Its shell needs a build toolchain the filming container does not have; its
  web UI in desktop mode (the screenshot harness's `mode: 'desktop'`) cannot run tests.
- **Screen readers' audio or sign language.** The subtitles are the accessible version; an audio description track is
  a later question.

## Appendix: what was measured

Run in this repository's container (four cores), with its Playwright 1.64.1 and Chromium, and ffmpeg.

- **Playwright's recordings are at CSS size.** A page at 960 × 600 with `deviceScaleFactor: 2`, `recordVideo` asked
  for 1920 × 1200: the video is 1920 × 1200 with the page in its top-left 960 × 600, unscaled. `page.screencast` asked
  for 1920 × 1200 on the same page: 960 × 600 frames. Neither gives the 2× pixels a zoom needs.
- **The X screen at 2× is sharp.** Xvfb at 3840 × 2160, Chromium with `--force-device-scale-factor=2`, `x11grab` at 30
  frames a second for 10 s with `libx264 -preset ultrafast -qp 0`: 237 frames (23.7 a second), 10.6 MB, text crisp at
  a 1:1 crop.
- **The stage renders.** A stage page with a window frame, an eased zoom, a drawn cursor with click rings and
  subtitles, seeking a 1920 × 1200 H.264 source (every frame a keyframe) and screenshotted by Playwright at
  1920 × 1080: 159 frames at 0.29 s each, encoded by ffmpeg into a 5.3 s MP4.
- **ffmpeg here** has libx264, SVT-AV1, VP9, Opus, AAC and libass (`subtitles`), `zoompan` and `xfade`.
