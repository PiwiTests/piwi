---
title: Desktop app runs
description: "Pause, step and watch the Playwright runs the desktop app starts, from its Local runs tray: each worker's test, its page live as it runs and at a stop, a pick on its image, the code a stop makes, to copy, a run shared live with your team, and the same runs for a coding agent."
lang: en-US
---

# Desktop app runs

<Needs desktop fixtures />

This page is about each worker of a run the [desktop app](./desktop) starts: its stops, its page and the code a stop
makes. Every Playwright run the app starts names the app as its hub: a **Re-run** of tests, a reproduction, a bisect
step, a [Flake Lab](./flake-lab) run and a bug report's run. Its **Local runs** tray shows each worker of the run
beside its output, and steers the test as the editor does: [Pause and step from the editor](./editor-run-control).
Nothing leaves your machine unless you [share a run live](#share-live). The tray's runs themselves, their progress,
**Stop**, **Run again**, their output and a reload: [Local runs tray](./local-runs-tray).

## Each worker

While a run goes on, the tray shows each worker's test, project and attempt, and whether it runs.
**Pause** stops the test before its next call that acts on or checks the page. A test also stops at a `page.pause()`,
and a headed one shows Piwi's [pause bar](./editor-breakpoints#pause-a-run) there.

At a stop, the tray says why the test stopped, the call about to run (**Next**) and its place in your code (**At**),
with an image of the page. **Resume** lets the test go on, **Step** runs one call and stops before the next, **Finish**
runs it to its end without stopping again, and [**End the test**](./end-the-test) skips the rest.

A run of several workers shows one at a time, behind a tab each (**worker 2**), with **Pause all** and **Resume all**,
as in the [Runs window](./runs-window#the-controls).

[**Hold failures**](./watch-a-run#hold-failures), a switch on each running run, holds a failing test at its line:
**Failed at**, its error under it, and **Resume** to let it end as it failed. It is on from the start for
**Reproduce**, which runs to show you the failure, and for a run started with it on; **Run again** keeps it. The
switch turns off as the app's last window closes, unless another tool set it since.

<figure>
  <img src="/screenshots/desktop-run-live.png" alt="The Local runs tray of the desktop app: a running run with its Hold failures switch, and its checkout test stopped at its page.pause() before its click on Pay now, its page watched live with Interact on, with Resume, Step, Finish, Assert a region and Mock a request">
  <figcaption>A run the desktop app started, stopped at a <code>page.pause()</code> and watched live.</figcaption>
</figure>

The tray opens at each stop, and tells you of one in the background:
[stops while you look elsewhere](./local-runs-tray#stops-while-you-look-elsewhere).

## Watch

**Watch**, on a running worker in the tray or its test on the run's page, shows its page as the test runs and at each
stop, until you turn it off ([Watch a running test](./watch-running-test)).

At a stop of a worker nobody watches, **Watch** shows the stopped page as it paints, in place of its image, and stays
on for the worker's next stops until you turn it off. [**Interact**](./watch-running-test#interact), beside it, plays
your input on the page; `Tab` leaves the view unless a click into it took the keyboard. Nothing keeps the [frames](./watch-running-test#what-is-sent-and-kept).

**Pause and watch**, on a running test of the run's page in the app (**Open run #N** on the run in the tray), pauses
the test as **Pause** does and watches its worker: the tray opens at the stop, the page live, and the row says where
it stopped, with **Show its page** to open the tray on it again.

**Pick on the image** (Playwright 1.60 or later), or a `Shift`+click on the image or the view, names the element under
the pointer: its locator shows under the test, with **Copy**.

Under a watched page, the tray shows what pixels cannot ([beside the image](./watch-running-test#beside-the-image)),
and **Open the trace so far**, in its head, opens Playwright's trace viewer on the running test's trace up to now
([Open the trace so far](./watch-running-test#open-the-trace-so-far)).

**Inspect**, beside it, shows that test's page at each call as [on the run page](./live-inspect), with the locator
picker. The app's server reads the trace file **Open the trace so far** checks, while the tray shows the lane and the
window is not hidden; the window hears each page's call and reads the page rendered, never the file's path. Each page
is cleaned as a worker cleans it for the run page, the values any frame's secret fields held hidden in every page,
iframes included, and stays in memory until the test ends. As Inspect opens, it reads a page's snapshots since its
navigation, 8,192 or 16 MB at most; every lane's pages, with the snapshots read to build them, share 256 MB, past
which it keeps no more. A page with a frame it cannot read whole shows again from its next navigation, and the reading
stops when the trace folder, a folder above it or its `resources` folder becomes a link or no longer a folder: Inspect
says why each time.

## Code to copy

The app holds no editor, so the code a stop makes (**Assert a region**, **Mock a request**, a picked locator) comes to
the tray, to copy: [Code from the runs](./local-runs-tray#code-from-the-runs).

## Share live

A run that reports to your team's Piwi instance can be [shared live](./share-live#from-the-desktop-app) there for a
teammate to watch: who sees what, and why a run cannot be. **Stop sharing…** asks first, naming what closes there.

## For agents

The app's [MCP server](./mcp) (its **MCP server** page connects your coding agent) serves these runs with
the tools of [Run control for agents](./agent-run-control): an agent follows a run, pauses or steps it, and reads and
acts on the stopped page as you can and [no further](./agent-run-control#what-keeps-it-safe).
Its `run_start` starts a run of the tray, titled with the agent's name
([in the desktop app](./agent-run-control#in-the-desktop-app)).

The tray shows what it does: a stop it asked for says so (**Paused by the agent**), as does its first action at a
stop. The code `code_write` makes (the steps it took, an assertion, or a locator for the stopped line) comes under
**Code from the runs**, to copy, and back to the agent in its answer. An agent sees no Flake Lab run, bisect or lab
job: nobody attends them.

The tray names who else is there: the tools that have a run open (**Also open in Piwi Picker · An agent follows this
run**), who watches a worker's page, and who [drives a stop](/guide/concepts#presence-driving-a-stop): **Take control**
from an agent, and **Give back**.

An agent pauses, steps or runs to a line only while the app's window is open, in the tray included: a headless stop
goes on with no window to show it. A stop it asked for goes on two minutes after its last call.

## A reproduction in your editor

A job the app runs in a throwaway worktree of a commit (**Reproduce here**, a bisect step, a [Flake Lab](./flake-lab)
run) follows the editor window whose workspace holds the project's linked folder, by the rules a
[terminal run follows](./terminal-runs#which-editor-or-the-desktop-app), else the app. It follows only an editor
extension that knows these reproductions (an older one leaves it to the app), and a bisect step or a Flake Lab run,
which nobody attends, only one that knows such runs too.

- **Its stops show in the editor** at the failing line of the worktree's file, outside the workspace, marked
  **the desktop app's reproduction at commit abc1234, in a throwaway checkout**. A reproduction holds its failures from
  its start, as in the app.
- **Its code is to copy.** Assert, Assert a region and Mock a request offer the code with **Copy the code** and write
  nothing: "This reproduction runs at commit abc1234 in a throwaway checkout: copy the code into your own file."
  Record here is refused there, and a pick goes to the app's window, to copy.
- **The app keeps it.** Its Local runs tray says where its tests wait (**In Visual Studio Code**), read only, stops it,
  and shows its verdict when it ends; the editor offers no Stop.

## Limits

- **No recording.** **Record here**, and a stopped test's **Pick** and **Assert** buttons, which act in the test's
  window, end in an editor: run the test
  from VS Code or a JetBrains IDE to use them.
- **A linked folder.** A reproduction or a bisect step runs in a throwaway worktree, which no project links: its
  stops make no code here. With an editor open on the linked folder, the job runs on that editor instead, which offers
  its code to copy ([A reproduction in your editor](#a-reproduction-in-your-editor)).
- **A file changed since the run started** makes no code: run the test again.
- **Run to cursor** stays in the editor, which has the file.

## Related

- [Desktop app](./desktop): what it runs, and how it links a project to its folder.
- [Local runs tray](./local-runs-tray): the tray's runs, their progress, their output and a compact list.
- [Pause and step from the editor](./editor-run-control): the same stops, in VS Code and the JetBrains IDEs.
- [Code from a pause](./editor-stop-code): what each action writes.
- [Runs window](./runs-window#the-desktop-app-s-runs): Piwi Picker's window, paired with the app, for the same runs;
  the code it starts at their stops comes to this tray.
- [Run control for agents](./agent-run-control): the tools an agent steers the runs with.
- [Flake Lab](./flake-lab#in-the-desktop-app): **Reproduce this flake** and a flake-aware bisect, run by the app.
