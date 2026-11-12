---
title: Runs window
description: "Piwi Picker's Runs window follows the tests your editor runs, from a window beside them: pause, step, resume and end them, write code from a stop, watch a test's page live while it runs, click and type on it at a stop, pick a locator on its image, and share a run live with your team."
lang: en-US
---

# Runs window

<Needs reporter fixtures extension />

Piwi Picker's Runs window, a window of its own beside the test's browser, follows the runs VS Code or a JetBrains IDE
starts: it pauses, steps and resumes them, writes code from a stop through the editor and, for a headless or remote
test, shows its page live, takes your clicks and keys on it, and picks a locator on its image. The editor shows the
same stops: [Pause and step from the editor](./editor-run-control).

## Open it

With Piwi Picker [paired with VS Code or a JetBrains IDE](./editor-recording#send-from-piwi-picker), or with the
[desktop app](./bug-reports#running-it-with-playwright-in-the-desktop-app), the popup shows a **Runs** tile under
**More tools**, muted with **Not connected** while none of them answers. It opens the Runs window where you left it last. While a test waits at a stop for you (a breakpoint, a **Pause**, a failure held
at its line, not a stop an agent drives), the tile says how many in amber, as do the toolbar's badge and the Runs
window's title (`1 waiting · Runs · Piwi Picker`); while none waits, how many failed, in red, a run that failed while
the Runs window was not in front counted until you bring it there. For each run
the editor [started](./editor-runs): its folder and command, how many of its tests ended (`3 of 9 tests · 1 failed`),
then each worker's test and whether it runs or where it stopped (the file and line, the call about to run, an image of
the page). A run that ended says how: passed, failed with its first
failure, timed out or interrupted. The count and the outcome need `@piwitests/reporter` newer than 0.67.0. A run
without [**Watch**](#watch-live) and no test stopped says how one stops: a breakpoint, a `page.pause()` or **Pause**. A run [started outside Piwi](./terminal-runs) shows too, marked **Terminal** or **Test runner**.
[CI runs](./watch-running-test#a-ci-run-of-your-branch) show read-only, with **Watch** on a running test.

## The controls

**Pause** stops a running test before its next call; while the test waits in a long one, its row says which (a
locator call, for how long), with [**End the test**](./end-the-test#while-a-pause-waits-for-a-call). At a stop, **Resume**, **Step**, **Finish** and
[**End the test**](./end-the-test) do what they do [in the editor](./editor-run-control#the-controls); Run to cursor
stays in the editor. A live run of several workers shows one at a time, behind tabs marked with their state, with
**Pause all** and **Resume all** under its name. A new stop takes the tab from a worker neither stopped nor watched,
and **Resume** or **End the test** moves it to the next stopped test. **Stop the run** ends a run an editor or the
desktop app started, not a terminal's or test runner's. Resume, Step and Finish have
[keys](/reference/keyboard-shortcuts#piwi-picker-s-runs-window), and the
[run shortcut](/reference/keyboard-shortcuts#the-run-shortcut) resumes or pauses every run from any window.

A failing test is held at its line, a headless one while its run's
[**Hold failures**](/guide/concepts#hold-failures), a switch on each run, is on: **Failed at** in red, its error under
it. **Resume** lets it end as it failed; **Pick** replaces the failing locator.

**Share live**, under the run's name, shares the run with your team: [Share a run live](./share-live).

Each run names who else has it open (**Also open in the desktop app**, **An agent follows this run**), and each worker
who watches its page (**Watched by you and Visual Studio Code**). One tool drives a stop at a time: an agent that
paused it or acts on it, else the last whose person clicked, typed or picked there. While another tool drives it or an
agent follows the run, **Take control** makes it yours: an agent's actions there are refused until you **Give back**. A
stop an agent asked for reads **Paused by the agent**: [driving a stop](/guide/concepts#presence-driving-a-stop).

## Code from a stop

The actions under **Code** (the last two in **More** once five show) send code to the editor, which writes it at the
stopped line, when its Piwi extension and your reporter take them. **Pick** and **Record** start the pause bar's **Pick
a locator** and **Record here**, **Assert** the recorder's **Check an element**, and **Assert a region** a pick whose
ARIA snapshot becomes `toMatchAriaSnapshot`.
They run in the test's page: where the pause bar shows, or, at a headless stop you [watch](#watch-live), through the
view; else they show held, saying **Watch to use**. **Mock a request** lists the page's fetch
and XHR requests, credentials hidden: the one you choose becomes a `page.route`. Under the test, the window says the
code went to the editor, with what to review in it, or why not.

<figure>
  <img src="/screenshots/picker-runs.png" alt="The Runs window beside a shop page stopped before a click on Checkout: the test, a card saying where it stopped with the call and its place, its controls and code actions, then the image of the page">
  <figcaption>The Runs window, beside a test stopped at a breakpoint.</figcaption>
</figure>

## Watch a test {#watch-live}

**Watch**, on a worker's row, shows its test's page as it paints, running or stopped, and **Pause and watch** pauses
it too: [Watch a running test](./watch-running-test). The last frame stays, marked **Running…**, until the next one
comes. An older reporter's row says to update it; with one newer than 0.61.0, its stops have their own **Watch**,
which watches each stop alone and, left on, the worker's next ones.

The view fills the window's width, ten frames a second at most, under a red **Live** badge. Only the window that
asked gets the frames, stored nowhere, from the test's worker through the editor service and the extension's
background worker, on your machine or the port your IDE forwards from a [remote window](/guide/remote-development).
Watching ends when you turn it off, the run ends or you close the window, and pauses while the window is minimized or
the editor is out of reach.

Under the page, from a reporter newer than 0.68.0, the window shows what pixels cannot, as the editor does
([beside the image](./watch-running-test#beside-the-image)): **Why it waits**, **Events**, **Text** (**Show the
page's text** reads it at each test, secret fields hidden, then follows the test's trace) and **Filmstrip** (a click
enlarges an image, with its call), kept in memory alone. **Open the trace so far**, in a watched page's head, opens
Playwright's trace viewer on the running test's trace up to now, on the machine the run runs on, with a reporter
newer than 0.68.0: [Watch a running test](./watch-running-test#open-the-trace-so-far).

At a headless stop, which nobody sees, the picker, the recorder's panel and the check panel appear in the watched
view, answered there as in a headed browser; their code reaches the editor the same way.

<figure>
  <img src="/screenshots/picker-runs-live.png" width="488" alt="The Runs window at a headless stop, watching the shop page live: Watch and Interact pressed in the page card's head, the Live badge on the view, the picker over the page, with Resume, Step and Finish in one group, End the test apart, and Pick, Record, Assert and More under Code">
  <figcaption>A headless test's page watched live, with Pick started in it.</figcaption>
</figure>

<figure>
  <img src="/screenshots/picker-runs-ci.png" width="488" alt="The Runs window listing CI run #78 on main with its two running tests, each with Watch and Watch on the dashboard, the second watched: its page live under a Live badge, with the call it is at">
  <figcaption>A CI run's test, watched read-only.</figcaption>
</figure>

## Click and type on the view

While you watch, [**Interact**](./watch-running-test#interact), beside **Watch**, sends your
pointer, wheel and keys on the view to the page as a person's would, the picker and the recorder included. Which
reach the page, a paste included, and which stay the window's: the
[keyboard shortcuts](/reference/keyboard-shortcuts#piwi-picker-s-runs-window).

A hint under the view says so the first time. What you hold down is let go before the test goes on.

## Pick on the image

**Pick on the image**, above the image, or a `Shift`+click on the image or the view, names the element a click
under the pointer would reach (a dialog or a banner over the page included), without touching the page: the locator
the pause bar's **Pick a locator** would rank first for it, sent to the editor in place of the stopped line's. The
window shows it, or why there is none, with **Copy** when no editor took it, on a headed stop's image too. `Esc` turns
it off. It needs Playwright 1.60 or later, and says so on an older one.

## The desktop app's runs

[Paired](./bug-reports#running-it-with-playwright-in-the-desktop-app) with the [desktop app](./desktop), the window
lists the runs the app starts beside your editor's, marked **Desktop app**: reproductions, bisect steps and bug reports
included, with the same controls and live view, and its failures to reach the app name the app (**Not connected to the
desktop app**). With no editor paired, it follows the app alone. The app holds no
editor, so **Pick**, **Record** and **Assert** in the test's window are not offered; the code of **Assert a region**
and **Mock a request** goes to the app's window to copy, as the window here says: [Desktop app runs](./desktop-runs).

## Limits

- **The top frame.** Pick on the image refuses an element inside an iframe.
- **What a view shows.** A test's own screencast, a heavy page, a popup, a download and a dialog: [Watch a running
  test](./watch-running-test#limits).
- **The middle button stays the window's.** It would open a link in a tab the view does not show; `Shift`+click picks
  instead of clicking.

## Related

- [Pause and step from the editor](./editor-run-control): the controls and the paused line, in the editor.
- [Code from a pause](./editor-stop-code): what each action writes, and where.
- [Browser extension](./extension): Piwi Picker's other tools, and its permissions.
- [Remote development](/guide/remote-development): the runs of a dev container or a remote window.
- [Piwi Picker and your editor](./editor-pairing): how the pairing reaches each editor window and the desktop app,
  on your machine alone.
