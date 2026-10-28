# Showcase: architecture

The map of `apps/showcase/`: how the set is built, how a beat plays and is checked, and what each beat asserts. The
rules are in [`AGENTS.md`](AGENTS.md); the plan, with the parts still to build (capture, the cut, the voice, the native
take), is [`proposals/showcase-video.md`](../../proposals/showcase-video.md).

## The set

`buildSet` (`lib/set.mjs`) builds it from scratch for each take, in a new folder of the temporary directory that also
becomes the `TMPDIR` of every app, and `close` ends it. Before anything, `showcase.mjs` takes a CI provider's variables
out of its environment (`CI_VARIABLE`): the developer's runs must not read as CI, which `detectCi` decides from them.

| Piece              | Built by                                     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The instance       | `startInstance` (`lib/instance.mjs`)         | The dashboard's dev server on port 3077, on a database seeded with the demo's history (`seedThrowawayDb`), its output in `dashboard.log`. The shop's project `acme-shop` is created with its live view on.                                                                                                                                                                                                                                                                                                                                                  |
| The repository     | `buildWorkspace` (`lib/workspace.mjs`)       | `examples/sample-app` with the shop's suite alone (`SHOP_SUITE`), as a git repository with two commits on `main` by a fictional developer: the shop as it shipped, then the redesign (**Pay now** in place of **Place order**, a required **I accept the terms** box). Pushed to a bare `origin.git`; `shop/` is the developer's checkout, with a `.env` naming the instance and the project. The checkout's Playwright config (`headedConfig`) gives actions a 10 s timeout, `SLOW_MO`, and, outside CI, the test's browser its tile and a debugging port. |
| The "CI" runs      | `startCiRun`                                 | A fresh clone of `origin` at a commit on `main`, the whole suite run headless with `CI=true` (which the reporter's `detectCi` reads, so its global setup asks for a live view key) and `PIWI_ORIGIN=ci` (the run's origin). The shipped commit's run is green, the redesign's red; beat 9 runs the fix's.                                                                                                                                                                                                                                                   |
| VS Code            | `launchEditor` (`lib/editor.mjs`)            | `apps/vscode/scripts/lib/vscode-window.mjs`'s window, the built extension, the dark theme, at its tile; Piwi's links trusted (`extensions.confirmedUriHandlerExtensionIds`) and the editor service's traffic traced in its log.                                                                                                                                                                                                                                                                                                                             |
| Piwi Picker        | `launchDeveloperBrowser` (`lib/browser.mjs`) | Chromium with the built extension in a profile of its own, paired through its settings page with the address **Piwi: Pair with Piwi Picker** copies; its Runs window opened from the popup's **Runs** tile and placed at its tile.                                                                                                                                                                                                                                                                                                                          |
| The dashboard      | `buildSet`                                   | The developer's browser's first window, over the whole screen, the visitor's Open in IDE choice VS Code with the extension (`IDE_PREFS`).                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The test's browser | the run                                      | Opened by each headed run, placed by the checkout's config, reached by `attachTestBrowser` over its debugging port.                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The stand-ins for what a bare X server lacks:

- **The `vscode://` handler.** The dashboard hands its link to a hidden frame; an init script sees it and passes it to
  VS Code's command line with the window's profile (`Editor.openUrl`), as the system's handler does. The profile allows
  the scheme for the instance's origin, so the browser asks nothing.
- **The host grant Pair asks for.** The extension is copied with the editor's address in its `host_permissions`
  (`pickerWithGrant`), as the prompt that **Pair**'s click opens would grant it; the settings page then pairs at once.

The layout, in CSS pixels at device scale 2 on a 3840 × 2160 screen (`TILES`): VS Code at the top left (1080 × 720),
the test's browser at its right (800 × 540), the Runs window below it (800 × 500), and the dashboard's window over the
screen, raised for the beats about it. Each beat raises the first window of its `focus`.

## The script

A beat (`beat` in `lib/script.mjs`) has an `id`, its `lines` by language, its `seconds` in the cut, its `focus`, a
`budget`, and, unless it is a card, a `run` and a `check`. `play` runs the beats in order: it raises the beat's first
window, calls `hooks.started`, the run, `hooks.ended`, then the check in check mode, all within the budget. A failure
writes `results/failed-<beat>/` (the screen from ImageMagick's `import`, `dashboard.log`, the VS Code profile's logs
with the extension host's and the Piwi output, Piwi Picker's worker and pages' console, the CI runs' output, the
gestures and the developer's checkout) and ends the take.

The context a beat gets: `set`, `editor` and `vscode` (its page), `dashboard`, `runs` (the Runs window's page),
`testPage()` (the test's page of the run going on), `instance`, `repo`, `gesture`, `palette(title)` (a VS Code command
from F1), `state` (what a beat leaves the next ones) and `skip(bug, what)`.

`Gestures` acts through Playwright, which is trusted input in Chromium and Electron, and logs each move: its time, the
window, the element's box in device pixels (the window's content origin from `screenX`/`screenY`, times the scale),
the text or the key. Its `pace` (a wait before each move, a delay between keys) is zero in check mode.

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
  `instance.whyNoHealing` reads both from the instance's `locator_snapshots`.
- **A run page opened while its run sets up stays there** (beat 9). Outside the demo, the run page connects to its
  run's stream only once the run is live, and does not refetch on the global stream's `run-started`, so a page opened
  between the reporter's global setup and its `onBegin` shows `Initializing` and no test until it is reloaded. The beat
  reloads it then, and checks the rest.

## Toward the cut

The film mode (`--mode film`) is not built. It plugs in at `play`'s `hooks` (the capture's marks per beat, and each
beat's hold from its lines), the gestures' `pace` and their log (the cursor and the click marks), and `TILES` (the
windows the stage cuts from the master). The beats do not change.

## The nightly job

`.github/workflows/nightly-showcase.yml` builds what the set plays, caches VS Code as the VS Code nightly does, runs
`showcase:check` under `xvfb-run` at 3840 × 2160, and uploads `results/` when a beat fails, for two weeks.
