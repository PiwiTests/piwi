---
title: Runs window
description: "Piwi Picker's Runs window follows the tests your editor runs, from a window beside them: pause, step, resume and end them, write code from a stop, watch a test's page live while it runs, click and type on it at a stop, pick a locator on its image, and share a run live with your team."
lang: en-US
---

# Runs window

<Needs reporter fixtures extension />

Piwi Picker's Runs window follows the test runs VS Code or a JetBrains IDE starts, from a window of its own beside
the test's browser. It pauses, steps and resumes them, writes code from a stop through the editor, and, for a test
that runs headless or in a remote container, shows its page live while it runs, takes your clicks and keys on it, and
picks a locator on its image. The editor shows the same stops: [Pause and step from the editor](./editor-run-control).

## Open it

With Piwi Picker [paired with VS Code or a JetBrains IDE](./editor-recording#send-from-piwi-picker), or with the
[desktop app](./bug-reports#running-it-with-playwright-in-the-desktop-app), the popup shows a **Runs** tile under
**More tools**, muted with **Not connected** while none of them answers. It opens the Runs window, to keep beside the
test's browser, where you left it last. For each run the editor [started](./editor-runs), it shows the folder and the command, how many of
its tests ended (`3 of 9 tests · 1 failed`), then each worker's test and whether it runs or where it stopped: the file
and line, the call about to run, and an image of the page. A run that ended says how: passed, failed with its first
failure, timed out or interrupted. The count and the outcome need `@piwitests/reporter` newer than 0.67.0. While none
of its tests is stopped, a run without [**Watch**](#watch-live) says how one stops: at a breakpoint, a `page.pause()`
or **Pause**. A run [started outside Piwi](./terminal-runs) shows too, marked **Terminal** or **Test runner**.

## The controls

**Pause** stops a running test before its next call; while the test waits in a long one, its row says which (a
locator call, for how long), with [**End the test**](./end-the-test#while-a-pause-waits-for-a-call). At a stop, **Resume**, **Step**, **Finish** and
[**End the test**](./end-the-test) do what they do [in the editor](./editor-run-control#the-controls); Run to cursor
stays in the editor. A run of several workers has **Pause all** and **Resume all** under its name. Resume, Step and
Finish have [keys](/reference/keyboard-shortcuts#piwi-picker-s-runs-window).

A failing test is held at its line, a headless one while its run's
[**Hold failures**](/guide/concepts#hold-failures) is on: **Failed at** in red, its error under it. **Resume** lets it
end as it failed; **Pick** replaces the failing locator. **Hold failures**, on each run, turns it on or off.

**Share live**, under the run's name, lets a teammate watch the run from its page on your team's instance, in a
project whose live view is on, as in the editor: [Share a run live](./share-live).

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
They run in the test's page: where the pause bar shows, or, at a headless stop, once you [watch it](#watch-live),
driven through the view; until then they show held, saying **Watch to use**. **Mock a request** lists the page's fetch
and XHR requests, credentials hidden: the one you choose becomes a `page.route`. Under the test, the window says the
code went to the editor, with what to review in it, or why not.

<figure>
  <img src="/screenshots/picker-runs.png" alt="The Runs window beside a shop page stopped before a click on Checkout: the test, its place, an image of the page, its controls and code actions">
  <figcaption>The Runs window, beside a test stopped at a breakpoint.</figcaption>
</figure>

## Watch a test {#watch-live}

**Watch**, on a worker's row, shows its test's page as it paints, running or stopped, and **Pause and watch** pauses
it too: [Watch a running test](./watch-running-test). The last frame stays, marked **Running…**, until the next one
comes. An older reporter's row says to update it; with one newer than 0.61.0, its stops have **Watch live**, which
watches each stop alone and, left on, the worker's next ones.

The view fills the window's width, at most ten frames a second, with a red **Live** badge. Only the window that asked
gets the frames, and nothing stores them: they go from the test's worker to the editor service and the extension's
background worker, on your machine or through the port your IDE forwards from a [remote
window](/guide/remote-development).

Watching ends when you turn it off, the run ends or you close the window, and pauses while the window is minimized or
the connection to the editor is lost.

At a headless stop, nobody sees the test's page. Watched, the picker, the recorder's panel and the check panel appear
in the view, and you answer them there as in a headed browser; their code reaches the editor the same way.

<figure>
  <img src="/screenshots/picker-runs-live.png" width="488" alt="The Runs window at a headless stop, watching the shop page live: Watch live pressed, the Live badge on the view, the picker over the page, with Resume, Step and Finish in one group, End the test apart, and Pick, Record, Assert and More under Code">
  <figcaption>A headless test's page watched live, with Pick started in it.</figcaption>
</figure>

## Click and type on the view

While you watch, your input on the view goes to the page as a person's would, the picker and the recorder included:

- **The pointer**: moves, left and right clicks, double and triple clicks as your system counts them, drags, and the
  wheel once the view has the focus. `Ctrl`, `Alt` and `⌘` held with a click are held in the page too.
- **The keys**, while the view has the focus (a focus ring around it): characters are typed, named keys (Enter, the
  arrows, Backspace, Delete, Home, End) pressed, with Shift, and `Ctrl` (`⌘` on macOS) with A, Z, Y, Enter and the
  editing keys. A paste types the clipboard's text.
- **What stays the window's**: the browser's other shortcuts, the function keys, `Esc` and `Tab`, as the
  [keyboard shortcuts](/reference/keyboard-shortcuts#piwi-picker-s-runs-window) say.

A hint under the view says so the first time. What you hold down is let go before the test goes on.

## Pick on the image

**Pick on the image**, above the image, or a `Shift`+click on the image or the view, names the element a click
under the pointer would reach (a dialog or a banner over the page included), without touching the page: the locator
the pause bar's **Pick a locator** would rank first for it, sent to the editor in place of the stopped line's. The window shows that locator, or why there is none, with
**Copy** when no editor took it. It works on a headed stop's image too. `Esc`
turns it off. It needs Playwright 1.60 or later, and says so on an older one.

## The run shortcut

The run shortcut resumes the stopped tests, else pauses every run, but a run
[nobody attends](/guide/concepts#hold-failures); Piwi Picker's toolbar icon shows what it did for a moment. It has no
key until you set one: **Set a
shortcut** opens the browser's shortcuts page, where you give it a key and, in Chrome and Edge, the **Global** scope.
In Firefox, it works while Firefox has the focus.

## The desktop app's runs

[Paired](./bug-reports#running-it-with-playwright-in-the-desktop-app) with the [desktop app](./desktop), the window
lists the runs the app starts beside your editor's, marked **Desktop app**: reproductions, bisect steps and bug reports
included, with the same controls and live view. With no editor paired, it follows the app alone. The app holds no
editor, so **Pick**, **Record** and **Assert** in the test's window are not offered; the code **Assert a region** and
**Mock a request** make goes to the app's window, to copy there, and the window here says so: [Desktop app
runs](./desktop-runs).

## Limits

- **The top frame.** Pick on the image refuses an element inside an iframe.
- **What a view shows.** A test's own screencast, a heavy page, a popup, a download and a dialog: [Watch a running
  test](./watch-running-test#limits).
- **No input method.** Characters an input method composes (Chinese, Japanese, Korean) do not reach the page; paste
  them instead.
- **The middle button stays the window's.** It would open a link in a tab the view does not show; `Shift`+click picks
  instead of clicking.

## Related

- [Pause and step from the editor](./editor-run-control): the controls and the paused line, in the editor.
- [Code from a pause](./editor-stop-code): what each action writes, and where.
- [Browser extension](./extension): Piwi Picker's other tools, and its permissions.
- [Remote development](/guide/remote-development): the runs of a dev container or a remote window.
- [Desktop app runs](./desktop-runs): the same runs, in the desktop app's window.
- [Piwi Picker and your editor](./editor-pairing): how the pairing reaches each editor window and the desktop app,
  on your machine alone.
