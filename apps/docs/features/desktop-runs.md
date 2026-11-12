---
title: Desktop app runs
description: "Pause, step and watch the Playwright runs the desktop app starts, from its Local runs tray: each worker's test, its page live as it runs and at a stop, a pick on its image, the code a stop makes, to copy, a run shared live with your team, and the same runs for a coding agent."
lang: en-US
---

# Desktop app runs

<Needs desktop fixtures />

Every Playwright run the [desktop app](./desktop) starts names the app as its hub: a **Re-run** of tests, a reproduction, a
bisect step, a [Flake Lab](./flake-lab) run and a bug report's run. Its **Local runs** tray shows each worker of the
run beside its output, and steers the test as the editor does: [Pause and step from the editor](./editor-run-control).
Nothing leaves your machine unless you [share a run live](#share-live).

## Each worker

While a run goes on, the tray shows each worker's test, project and attempt, and whether it runs.
**Pause** stops the test before its next call that acts on or checks the page. A test also stops at a `page.pause()`,
and a headed one shows Piwi's [pause bar](./editor-breakpoints#pause-a-run) there.

At a stop, the tray says why the test stopped, the call about to run (**Next**) and its place in your code (**At**),
with an image of the page. **Resume** lets the test go on, **Step** runs one call and stops before the next, **Finish**
runs it to its end without stopping again, and [**End the test**](./end-the-test) skips the rest.

A run of several workers shows one at a time, behind a tab each (**worker 2**) marked with its state. A new stop takes
the tab from a worker that runs unwatched, and **Resume** or **End the test** there moves it to the next stopped test.
**Pause all** and **Resume all** steer every worker at once.

**Hold failures**, on each running run, holds a failing test at its line: **Failed at**, its error under
it, and **Resume** to let it end as it failed. It is on from the start for **Reproduce**, which runs to show you the
failure, and a run started with it on; **Run again** keeps it. It is [the run's own](/guide/concepts#hold-failures),
off again as the app's last window closes. A run [nobody attends](/guide/concepts#hold-failures) never holds one, and
its switch says why.

<figure>
  <img src="/screenshots/desktop-run-live.png" alt="The Local runs tray of the desktop app: a running run with its Hold failures switch, and its checkout test stopped at its page.pause() before its click on Pay now, its page watched live with Interact on, with Resume, Step, Finish, Assert a region and Mock a request">
  <figcaption>A run the desktop app started, stopped at a <code>page.pause()</code> and watched live.</figcaption>
</figure>

The tray opens at each stop, where a headless test waits for you. With the window in the background, the system tells
you of a failure or a `page.pause()`, never of a step or a pause you asked for. The window listens on every page, again
as soon as it reloads while a run of the app goes on. On a page without the tray (an analytics dashboard in TV mode,
an error page), the system tells you of every stop, whatever the window shows, and no failure is held; a
`page.pause()`, a step or a breakpoint waits until the tray shows it again, or [Piwi Picker's Runs
window](./runs-window) or [an agent](#for-agents) answers it. With no run of the app going on, the window stops
listening, and a stop goes on at once.

## Its output

Each run shows its output under its workers, in Playwright's terminal colors. **Open the output in a
separate window**, the window button on the run, moves it to a window of its own, beside your editor or on another
screen, still updating, with the run's **Stop**. Closing that window, or the same button, now **Show the output
here**, brings it back; the window closes with the app.

## Watch

**Watch**, on a running worker in the tray or its test on the run's page, shows its page as the test runs and at each
stop, until you turn it off. Between two images, and with an older reporter: [Watch a running
test](./watch-running-test).

At a stop of a worker nobody watches, **Watch** shows the stopped page as it paints, in place of its image, and stays
on for the worker's next stops until you turn it off. [**Interact**](./watch-running-test#interact), beside it, sends
your clicks, the wheel and your keys on the view to the page; `Tab` leaves the view unless a click into it took the
keyboard. Nothing keeps the [frames](/guide/concepts#watch-share-live).

**Pause and watch**, on a running test of the run's page in the app (**Open run #N** on the run in the tray), pauses
the test as **Pause** does and watches its worker: the tray opens at the stop, the page live, and the row says where
it stopped, with **Show its page** to open the tray on it again.

**Pick on the image** (Playwright 1.60 or later), or a `Shift`+click on the image or the view, names the element under
the pointer: its locator shows under the test, with **Copy**.

Under a watched page, from a reporter newer than 0.68.0, the tray shows what pixels cannot, as the editor does
([beside the image](./watch-running-test#beside-the-image)): **Why it waits**, **Events**, **Text** (**Show the page's
text** reads it at each test, secret fields hidden, then follows the test's trace) and **Filmstrip** (a click enlarges
an image, with its call), kept in memory alone. **Open the trace so far**, in a watched page's head, opens Playwright's
trace viewer on the running test's trace up to now, on your machine, with a reporter newer than 0.68.0: [Watch a
running test](./watch-running-test#open-the-trace-so-far).

**Inspect**, beside it, shows that test's page at each call as [on the run page](./live-inspect), with the locator
picker, read from the test's own trace on your machine while open and the window shows, and let go as the test ends
([what it reads](/guide/concepts#trace-so-far)).

## Code to copy

The app holds no editor, so the code a stop makes comes to the tray, under **Code from the runs**, rather than into
your file:

- **Assert a region** picks a region of the page, once you watch a headless stop live: its ARIA snapshot becomes a
  `toMatchAriaSnapshot` check.
- **Mock a request** lists the page's fetch and XHR responses, credentials hidden: the one you choose becomes a
  `page.route`, with what to review in it.
- **A locator picked**, on the image or with the pause bar's **Pick a locator**, shows with the line it was picked
  for.

Each code shows the line it goes above and, apart, its import lines, each with **Copy**, made from the file as it is
on disk in the folder linked to the project.

<figure>
  <img src="/screenshots/desktop-run-live-code.png" alt="Code from the runs in the desktop app's tray: a mocked request, the page.route call to write above tests/checkout.spec.ts:18, with Copy">
  <figcaption>A mocked request, as code to copy above the stopped line.</figcaption>
</figure>

## Share live

A run that reports to your team's Piwi instance can be [shared live](./share-live#from-the-desktop-app) there for a
teammate to watch: who sees what, and why a run cannot be.

## For agents

The app's [MCP server](./mcp) (its **MCP server** page connects your coding agent) serves these runs with
the tools of [Run control for agents](./agent-run-control). An agent follows a run, pauses or steps it, and reads
and acts on the stopped page as you can and no further: [what keeps it safe](./agent-run-control#what-keeps-it-safe).

The tray shows what it does: a stop it asked for says so (**Paused by the agent**), as does its first action at a
stop. The code `code_write` makes (the steps it took, an assertion, or a locator for the stopped line) comes under
**Code from the runs**, to copy, and back to the agent in its answer: no file is written. A run nobody attends is not
served, so an agent sees no Flake Lab run, bisect or lab job.

The tray names who else is there: the tools that have a run open (**Also open in Piwi Picker · An agent follows this
run**), who watches a worker's page, and who [drives a stop](/guide/concepts#presence-driving-a-stop): **Take control**
from an agent, and **Give back**.

An agent pauses, steps or runs to a line only while the app's window is open, in the tray included: a headless stop
goes on with no window to show it. A stop it asked for goes on two minutes after its last call, so a run never waits
for an agent that left.

## Limits

- **No recording.** **Record here**, and **Pick** and **Assert** in the test's window, end in an editor: run the test
  from VS Code or a JetBrains IDE to use them.
- **A linked folder.** A reproduction or a bisect step runs in a throwaway worktree, which no project links: its
  stops make no code.
- **A file changed since the run started** makes no code: run the test again.
- **A reload forgets the tray's runs.** A run still going shows among the app's other runs, without **Hold
  failures**: its failures go on, a reproduction's included.
- **Run to cursor** stays in the editor, which has the file.

## Related

- [Desktop app](./desktop): what it runs, and how it links a project to its folder.
- [Pause and step from the editor](./editor-run-control): the same stops, in VS Code and the JetBrains IDEs.
- [Code from a pause](./editor-stop-code): what each action writes.
- [Runs window](./runs-window#the-desktop-app-s-runs): Piwi Picker's window, paired with the app, for the same runs;
  the code it starts at their stops comes to this tray.
- [Run control for agents](./agent-run-control): the tools an agent steers the runs with.
- [Flake Lab](./flake-lab#in-the-desktop-app): **Reproduce this flake** and a flake-aware bisect, run by the app.
