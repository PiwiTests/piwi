---
title: Runs window
description: "Piwi Picker's Runs window follows the tests your editor runs, from a window beside them: pause, step, resume and end them, write code from a stop, watch a headless test's page live, click and type on it, pick a locator on its image, and share a run live with your team."
lang: en-US
---

# Runs window

<Needs reporter fixtures extension />

Piwi Picker's Runs window follows the test runs VS Code or a JetBrains IDE starts, from a window of its own beside
the test's browser. It pauses, steps and resumes them, writes code from a stop through the editor, and, for a test
that runs headless or in a remote container, shows its page live, takes your clicks and keys on it, and picks a
locator on its image. The editor shows the same stops: [Pause and step from the editor](./editor-run-control).

## Open it

With Piwi Picker [paired with VS Code or a JetBrains IDE](./editor-recording#send-from-piwi-picker), the popup shows a
**Runs** tile under **More tools** while the editor answers. It opens the Runs window, to keep beside the test's
browser. For each run the editor [started](./editor-runs), it shows the folder and the command, then each worker's test
and whether it runs or where it stopped: the file and line, the call about to run, and an image of the page. A run you
[started in a terminal](./terminal-runs) shows too, marked **Terminal**.

## The controls

**Pause** stops a running test before its next call. At a stop, **Resume**, **Step**, **Finish** and
[**End the test**](./end-the-test) do what they do [in the editor](./editor-run-control#the-controls); Run to cursor
stays in the editor.

A failing test is held at its line, a headless one only while a Runs window is open: **Failed at** in red, its error
under it. **Resume** lets it end as it failed; **Pick** replaces the failing locator.

**Share live**, under the run's name, lets a teammate watch the run from its page on your team's instance, in a
project whose live view is on. The first time in a window, it says what goes out and to whom; shared, the run says
how many views are open, with its page's link to copy, until **Stop sharing**:
[Share a run from your machine](./live-view#share-a-run-from-your-machine).

## Code from a stop

The other actions send code to the editor, which writes it at the stopped line, when its Piwi extension and your
reporter take them. **Pick** and **Record** start the pause bar's **Pick a locator** and **Record here**, **Assert**
the recorder's **Check an element**, and **Assert a region** a pick whose ARIA snapshot becomes `toMatchAriaSnapshot`.
They run in the test's page: where the pause bar shows, or, at a headless stop, once you [watch it
live](#watch-live), driven through the view. **Mock a request** lists the page's fetch and XHR requests, credentials
hidden: the one you choose becomes a `page.route`. Under the test, the window says the code went to the editor, with
what to review in it, or why not.

<figure>
  <img src="/screenshots/picker-runs.png" alt="The Runs window beside a shop page stopped before a click on Checkout: the test, its place, an image of the page, its controls and code actions">
  <figcaption>The Runs window, beside a test stopped at a breakpoint.</figcaption>
</figure>

## Watch live

With a reporter newer than 0.61.0 and an editor extension of the same release, a stop has **Watch live** above its
image. It shows the page as it paints, in place of the image, at most ten frames a second, at the window's width, with
a red **Live** badge. Only the window that asked gets the frames, and nothing stores
them: they go from the test's worker to the editor service and the extension's background worker, on your machine or
through the port your IDE forwards from a [remote window](/guide/remote-development).

The view ends with the stop, when you turn **Watch live** off, minimize the window, or close it. Left on, it starts
again at the worker's next stop, and as the window shows again.

At a headless stop, nobody sees the test's page: **Pick**, **Record**, **Assert** and **Assert a region** show once you
watch it. The picker, the recorder's panel and the check panel appear in the view, and you answer them there as in a
headed browser; their code reaches the editor the same way.

<figure>
  <img src="/screenshots/picker-runs-live.png" width="488" alt="The Runs window at a headless stop, watching the shop page live: Watch live pressed, the Live badge on the view, the picker over the page, and Pick, Record, Assert and Assert a region among the controls">
  <figcaption>A headless test's page watched live, with Pick started in it.</figcaption>
</figure>

## Click and type on the view

While you watch, your input on the view goes to the page as a person's would, the picker and the recorder included:

- **The pointer**: moves, left and right clicks, double and triple clicks as your system counts them, drags, and the
  wheel once the view has the focus. `Ctrl`, `Alt` and `⌘` held with a click are held in the page too.
- **The keys**, while the view has the focus (a focus ring around it): characters are typed, named keys (Enter, the
  arrows, Backspace, Delete, Home, End) pressed, with Shift, and `Ctrl` (`⌘` on macOS) with A, Z, Y, Enter and the
  editing keys. A paste types the clipboard's text.
- **What stays the window's**: the browser's other shortcuts, the function keys, and `Esc`, which gives the keys
  back to the window and moves the focus to **Watch live**. `Tab` moves the focus on past the view, unless you
  clicked into it: then `Tab` and `Shift+Tab` go to the page too, until `Esc`.

A hint under the view says so the first time. What you hold down is let go before the test goes on.

## Pick on the image

**Pick on the image**, beside **Watch live**, or a `Shift`+click on the image or the view, names the element a click
under the pointer would reach (a dialog or a banner over the page included), without touching the page: the locator
the pause bar's **Pick a locator** would rank first for it, sent to the editor in place of the stopped line's. The window shows that locator, or why there is none. It works on a headed stop's image too. `Esc`
turns it off.

## The run shortcut

The run shortcut resumes the stopped tests, else pauses every run. It has no key until you set one: **Set a
shortcut** opens the browser's shortcuts page, where you give it a key and, in Chrome and Edge, the **Global** scope.
In Firefox, it works while Firefox has the focus.

## The desktop app's runs

[Paired](./bug-reports#running-it-with-playwright-in-the-desktop-app) with the [desktop app](./desktop), the window
lists the runs the app starts beside your editor's, marked **Desktop app**: reproductions, bisect steps and bug reports
included, with the same controls and live view. With no editor paired, it follows the app alone. A failure of a run
nobody attends (a Flake Lab run, a bisect, a lab job) goes on while the window is open. The app holds no editor, so
**Pick**, **Record** and **Assert** in the test's window are not offered; the code **Assert a region** and **Mock a
request** make goes to the app's window, to copy there, and the window here says so: [Desktop app runs](./desktop-runs).

## How it connects

The background worker reaches the editor's services on `127.0.0.1` only once the paired port proves it holds the
pairing's token ([how the pieces connect](./editor-run-control#how-it-works)), as the desktop app proves it holds its
own. The window talks to that worker alone, and makes no network call of its own. An older editor extension gives the
image and the controls alone.

## Limits

- **The top frame.** Pick on the image refuses an element inside an iframe.
- **A test's own screencast.** When the test records its own (a video, a trace with screenshots), the view takes its
  size and quality; when none can start, it is an image of the page twice a second.
- **A heavy page.** A frame over 384 KB gives way to a lighter image of the page, twice a
  second; when even that is too heavy, the window says so under the stop's image.
- **The browser's keys stay its own.** A shortcut of the browser, a function key and `Esc` never reach the page.
- **No input method.** Characters an input method composes (Chinese, Japanese, Korean) do not reach the page; paste
  them instead.
- **The test's own page alone.** A popup the page opens is not shown.
  A download your click starts and a dialog the page opens go to the test as its own would: Playwright deletes the
  download with the test's context, and dismisses the dialog unless the test handles it.
- **The middle button stays the window's.** It would open a link in a tab the view does not show; `Shift`+click picks
  instead of clicking.

## Related

- [Pause and step from the editor](./editor-run-control): the controls and the paused line, in the editor.
- [Code from a pause](./editor-stop-code): what each action writes, and where.
- [Browser extension](./extension): Piwi Picker's other tools, and its permissions.
- [Remote development](/guide/remote-development): the runs of a dev container or a remote window.
- [Desktop app runs](./desktop-runs): the same runs, in the desktop app's window.
