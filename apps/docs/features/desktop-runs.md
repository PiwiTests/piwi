---
title: Desktop app runs
description: "Pause, step and watch the Playwright runs the desktop app starts, from its Local runs tray: each worker's test, the page at a stop, live, a pick on its image, and the code a stop makes, to copy."
lang: en-US
---

# Desktop app runs

<Needs desktop fixtures />

Every Playwright run the [desktop app](./desktop) starts names the app as its hub: **Run locally**, a reproduction, a
bisect step, a [Flake Lab](./flake-lab) run and a bug report's run. Its **Local runs** tray shows each worker of the
run beside its output, and steers the test as the editor does: [Pause and step from the editor](./editor-run-control).
Nothing leaves your machine.

## Each worker

While a run goes on, the tray shows each worker's test, its Playwright project and its attempt, and whether it runs.
**Pause** stops the test before its next call that acts on or checks the page. A test also stops at a `page.pause()`,
and a headed one shows Piwi's [pause bar](./editor-breakpoints#pause-a-run) there.

At a stop, the tray says why the test stopped, the call about to run and its place in your code, with an image of the
page. **Resume** lets the test go on, **Step** runs one call and stops before the next, and **Finish** runs the test to
its end without stopping again.

**Hold failures**, on each running run in the tray, holds a failing test at its line: **Failed at**, its error under
it, and **Resume** to let it end as it failed. It is off for a run you start, and on from the start for **Reproduce**,
which runs to show you the failure; while [Piwi Picker's Runs window](./runs-window) is open, failures are held too. A
run nobody attends never holds one, and its switch says so: a Flake Lab run, a bisect, a lab job, a run with
`--repeat-each` above 1 and UI mode go on past each failure.

<figure>
  <img src="/screenshots/desktop-run-live.png" alt="The Local runs tray of the desktop app: a running run with its Hold failures switch, and its checkout test stopped at its page.pause() before its click on Pay now, its page watched live, with Resume, Step, Finish, Assert a region and Mock a request">
  <figcaption>A run the desktop app started, stopped at a <code>page.pause()</code> and watched live.</figcaption>
</figure>

The tray opens at each stop: a headless test waits for you there. While the window is in the background, the system
tells you of a failure or a `page.pause()`, never of a step or a pause you asked for. When no run of the app is going
on, the window stops listening, and a stop goes on at once.

## Watch live

**Watch live** shows the stopped page as it paints, in place of its image, and stays on for the worker's next stops
until you turn it off. Your clicks, the wheel and your keys on the view go to the page. `Esc` gives the keyboard back
to the tray, and `Tab` leaves the view unless a click into it took the keyboard. The frames go from the test's worker
to the windows that watch that stop, the app's and Piwi Picker's Runs window, and nothing keeps them.

**Pick on the image**, or a `Shift`+click on the image or the view, names the element under the pointer: its locator
shows under the test, with **Copy**.

## Code to copy

The app holds no editor, so the code a stop makes comes to the tray, under **Code from the runs**, rather than into
your file:

- **Assert a region** picks a region of the page, once you watch a headless stop live: its ARIA snapshot becomes a
  `toMatchAriaSnapshot` check.
- **Mock a request** lists the page's fetch and XHR responses, credentials hidden: the one you choose becomes a
  `page.route`, with what to review in it.
- **A locator picked**, on the image or with the pause bar's **Pick a locator**, shows with the line it was picked
  for.

Each code shows the line it goes above, and its import lines apart, each with **Copy**. The code is made from the file
as it is on disk, in the folder linked to the project.

## From Piwi Picker

Paired with the app, [Piwi Picker's Runs window](./runs-window#the-desktop-app-s-runs) lists its runs beside your
editor's, steers them, and watches their pages live. Code it starts at a stop of the app's run comes to the app's tray
too.

## Limits

- **No recording.** **Record here**, and **Pick** and **Assert** in the test's window, end in an editor: run the test
  from VS Code or a JetBrains IDE to use them.
- **A linked folder.** A reproduction or a bisect step runs in a throwaway worktree, which no project links: its
  stops make no code.
- **A file changed since the run started** makes no code: run the test again.
- **Run to cursor** stays in the editor, which has the file.

## Related

- [Desktop app](./desktop): what it runs, and how it links a project to its folder.
- [Pause and step from the editor](./editor-run-control): the same stops, in VS Code and the JetBrains IDEs.
- [Code from a pause](./editor-stop-code): what each action writes.
- [Runs window](./runs-window): Piwi Picker's window for the same runs.
