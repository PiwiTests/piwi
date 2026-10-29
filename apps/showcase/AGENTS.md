# Showcase: agent guide

Rules for working inside `apps/showcase/`: the script that plays Piwi's showcase story on the real tools together (the
dashboard, VS Code with the Piwi extension and its editor service, Piwi Picker, the reporter, the test's browser) on one
X screen. Played without capture, it is a check of those tools together, run nightly (`nightly-showcase.yml`);
filmed (the virtual take), the cut renders the video from the recording; the voice, publishing and the native take
come later ([`proposals/showcase-video.md`](../../proposals/showcase-video.md)). It is a directory of scripts, not an
npm workspace: it runs on the root's `node_modules`. Read [`../../AGENTS.md`](../../AGENTS.md) first. How the set, the
script, the beats, the take and the cut work is in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Rules

- **Everything on screen is real.** The set runs this commit's dashboard, reporter, Nitro integration, VS Code
  extension and Piwi Picker, built, and the sample app's suite; no stub instance, worker or editor. The stand-ins are
  the system's parts a bare X server lacks, each named in [The set](ARCHITECTURE.md#the-set): the `vscode://` handler
  and the host grant **Pair** asks for.
- **Fictional content only.** The shop, its people, addresses and commits are made up (`lib/workspace.mjs`,
  `story.mjs`); no real company's brand, and no real token in a file or on screen. A literal shaped like a secret is
  built from parts, which push protection otherwise rejects.
- **A beat acts through `gesture` and waits on state, never on time.** `gesture.click`, `type` and `press` log each
  move with its box on the screen, which the cut draws; a wait is a locator, a line on disk, the instance's API or
  `waitFor`, never `waitForTimeout`. ([The script](ARCHITECTURE.md#the-script))
- **Every beat with a `run` has a `check` that fails when its feature breaks**, read from what the feature left: the
  file on disk, the instance's API, the editor's or the Runs window's DOM.
- **A check skips an assertion only for a known product bug, and only once it has seen that bug's state**
  (`context.skip(bug, what)`, e.g. `instance.whyNoHealing`), never unconditionally: the skip goes away by itself when
  the bug is fixed. Each one is listed in [Known bugs](ARCHITECTURE.md#known-bugs).
- **A line is at most two rows of 42 characters, and a beat's lines read at 17 characters a second at most**
  (`lintLines`; `node showcase.mjs --lint`). The lines are the subtitles, and every beat has a `title`, its chapter.
- **A take's holds are the take's, named, never a beat's**: a beat is held until its lines are read (`lineMs`: 15
  characters a second, then 0.4 s) and its end has shown for `SETTLE_MS` (`hooks.ended` in `lib/take.mjs`). Check mode
  has none, and a beat still waits on state, whatever the mode.
- **The stage draws a frame from its state alone** (`stage/stage.js`): every motion, fade and timing is computed in
  `lib/cut-plan.mjs` from the take log, so two renderers draw the same frame alike. No CSS transition, animation or
  timer in the stage. The plan's pure parts are tested (`npm run showcase:test`, run by `ci.yml`).
- **A master is never decoded to files**: the cut streams its frames in order to the stage (`Decoder` in
  `lib/cut.mjs`); 4K frames on disk are gigabytes. Nothing a take or a cut makes is committed (`results/` is
  gitignored); publishing the teaser, the clips and the posters is the design's next step.
- **The set lives in a new folder of the temporary directory, which every app's temporary files, the editors'
  discovery files and the desktop app's file go into (`TMPDIR`, `PIWI_EDITORS_DIR`, `PIWI_DESKTOP_CONFIG`), and the
  take removes it with every process still working there or started with them** (`createSet` and `endStrays` in
  `lib/set.mjs`). A process the set starts inherits them; never point one at `~/.piwi`. Keep the folder's path short: VS Code's and the editor
  service's sockets must stay under 107 characters.
- **A take that stops keeps what it saw before anything closes**: a failed beat, a set that fails to build, a signal
  (`keepEvidence` in `showcase.mjs`). A new app of the set leaves its log in `results/logs/` and the signals to the
  take (Playwright's `handleSIGINT: false`).
- **The checkout's packages are linked from this repository, never installed** (`linkPackages` in
  `lib/workspace.mjs`): a run tests this commit's reporter.
- **A label a beat finds by its name is part of the check**: renaming a button or a command title a beat clicks (the
  dashboard's **Debug in my editor** and **Watch**, the Runs window's, VS Code's lenses and commands) updates
  `story.mjs` in the same change. The nightly job is no pull request check, so nothing else tells.

## Commands

From `apps/showcase/`, once `npm run reporter:build` (packages/reporter), `npm run build` (integrations/nitro),
`npm run vscode:build` (apps/vscode) and `npm run extension:build` (apps/extension) have built what it plays:

```bash
xvfb-run -a -s "-screen 0 3840x2160x24" npm run showcase:check   # the whole story in check mode
xvfb-run -a -s "-screen 0 3840x2160x24" node showcase.mjs --until paused --keep   # up to a beat, the set kept
xvfb-run -a -s "-screen 0 3840x2160x24" npm run showcase:film    # the virtual take: results/master.mkv, take.json
npm run showcase:cut                                             # the cut of results/ into results/cut/
node showcase.mjs --cut results --beats paused --out results/paused   # one beat's cut, to look at the stage
node showcase.mjs --lint                                         # the lines alone
npm run showcase:test                                            # the cut's pure parts
npm run showcase:lint                                            # :fix to fix
npm run showcase:format                                          # :check to verify only
```

- VS Code comes from `apps/vscode/.vscode-test/` (the extension's suites download it there), else
  `SHOWCASE_VSCODE_CACHE`. A take needs ports 3077 (the instance), 4173 (the shop) and 9334 (the test's browser) free.
- A virtual take and the cut need ffmpeg (x11grab, libx264, libvpx-vp9) and the stage's fonts, Inter and JetBrains
  Mono (the cut names a missing one and draws in the fallback). A full take is about 6 minutes and its master a few
  hundred megabytes; check `df` first.
- A failed beat leaves `results/failed-<beat>/`: the whole screen, every app's log, the gestures and the checkout;
  a set that fails to build `results/failed-set/`, and a take stopped by Ctrl+C or another signal
  `results/interrupted/`. `--out <dir>` writes elsewhere: a take empties only a folder it marked as its results.

## Map

- `showcase.mjs`: the command line; builds the set, plays the story (checked or filmed), keeps what a failure leaves,
  runs the cut.
- `story.mjs`: the beats, their titles, lines, runs and checks.
- `lib/script.mjs`: `beat`, the gestures and their log, the lines' lint, `play`.
- `lib/take.mjs`, `lib/capture.mjs`: the virtual take (the holds, the raises, the take log), the x11grab capture and
  the sync flash.
- `lib/cut.mjs`: the renderer and the outputs; `lib/cut-plan.mjs`, `lib/timeline.mjs`, `lib/camera.mjs`,
  `lib/cursor.mjs`: the plan, pure (the clock, the cues and subtitle files, the camera, the pointer and keys);
  `stage/`: the page each frame is drawn on; `tests/`: their `node --test` suites.
- `lib/set.mjs`: the set and its layout; `lib/workspace.mjs`, `lib/instance.mjs`, `lib/editor.mjs`,
  `lib/browser.mjs`: the shop's repository, the instance and its "CI" runs, VS Code, the developer's and the test's
  browsers; `lib/agent.mjs`: the coda's agent.
