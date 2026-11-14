---
title: Local runs tray
description: "The desktop app's Local runs tray: each Playwright run it starts, counted as the run's own process counts its tests, a failed run's end leading to its first failure, a compact list of one line a run, its output, and all of it kept through a reload."
lang: en-US
---

# Local runs tray

<Needs desktop />

The **Local runs** tray of the [desktop app](./desktop) lists every run the app starts: a **Re-run**, a reproduction, a
bisect, a [Flake Lab](./flake-lab) run, a bug report's run, a run an agent started. It sits at the bottom right of
the window and opens as a run starts, at each stop, and from **1 local run** in the sidebar. Closing it stops nothing.
This page is about the runs the tray lists: how far each is, **Stop**, **Run again**, the code their stops make, their
output and a reload. Each
run's workers, their stops and their page: [Desktop app runs](./desktop-runs).

<figure>
  <img src="/screenshots/desktop-runs-tray.png" alt="The Local runs tray: a run counted 5 of 12 tests, 1 failed, its first worker stopped at its page.pause() with Resume, Step and Finish and its page, beside Stop and Hold failures">
  <figcaption>A run that goes on, counted as its own process counts its tests.</figcaption>
</figure>

## Each run

A run says how far it is as its own process counts its tests: **5 of 12 tests · 1 failed**, a test held at its
failure among the failed, then the flaky ones and those [ended at a stop](./end-the-test). Its run button on the page
and **1 local run** in the sidebar count the same. Before its first test, and with a reporter that does not count,
the run counts the results Playwright prints.

Once it reported to the app, a run links **Open run #N**, and **Compare with run #N** when its tests come from another
run. A failed one leads to its failure: **Open the failure**, on the run and in the message at its end, opens the
page of its first failed test, the one its process named first; the run's page when the run names none. A run of
several Playwright projects reports one run for each: the failure is the first one of the first project that failed,
in that project's run. **Run again**
starts an ended run as it ran, with its options and its **Hold failures**.

A reproduction, a bisect step or a Flake Lab run that went to the editor open on the project's linked folder
([A reproduction in your editor](./desktop-runs#a-reproduction-in-your-editor)) says where its tests wait,
**In Visual Studio Code**, read only, with no **Hold failures**: the editor holds them. Its line reads **Waiting** while
one does, **Stop** still ends it, and it ends with its own verdict.

## Stops while you look elsewhere

The tray opens at each stop, where a headless test waits for you. With the window in the background, the system tells
you of a failure or a `page.pause()`, never of a step or a pause you asked for. The window listens on every page, again
as soon as it reloads while a run of the app goes on. On a page without the tray (an analytics dashboard in TV mode,
an error page), the system tells you of every stop, whatever the window shows, and no failure is held; a
`page.pause()`, a step or a breakpoint waits until the tray shows it again, or [Piwi Picker's Runs
window](./runs-window) or [an agent](./desktop-runs#for-agents) answers it. With no run of the app going on, the window
stops listening, and a stop goes on at once.

## Compact list

**Compact list**, in the tray's head, shows each run as one line: its state (**Running**, **Waiting** at a stop,
**Passed**, **Failed**), its name, how far it is, and the one action it needs now: **Show the stop**, **Stop**,
**Open the failure**, **Open run #N** or **Run again**. A click on a line shows the run whole, and **Show as one
line** folds it again. A stop shows its run whole, as the tray opens on it. The tray remembers the choice.

<figure>
  <img src="/screenshots/desktop-runs-tray-compact.png" alt="The Local runs tray as a compact list: a run waiting at a stop with Show the stop, one that passed with Run again, and one that failed with Open the failure">
  <figcaption>Three runs, one line each, each with the action it needs.</figcaption>
</figure>

## Code from the runs

The app holds no editor, so the code a stop of its runs makes comes to the tray, under **Code from the runs**:

- **Assert a region** picks a region of the page, once you watch a headless stop live: its ARIA snapshot becomes a
  `toMatchAriaSnapshot` check.
- **Mock a request** lists the page's fetch and XHR responses, credentials hidden: the one you choose becomes a
  `page.route`, with what to review in it.
- **A locator picked**, on the image or with the pause bar's **Pick a locator**, shows with the line it was picked
  for.
- **An agent's code** (`code_write`) comes here too ([for agents](./desktop-runs#for-agents)).

Each code shows the line it goes above and, apart, its import lines, each with **Copy**, made from the file as it is
on disk in the folder linked to the project.

<figure>
  <img src="/screenshots/desktop-run-live-code.png" alt="Code from the runs in the desktop app's tray: a mocked request, the page.route call to write above tests/checkout.spec.ts:18, with Copy">
  <figcaption>A mocked request, as code to copy above the stopped line.</figcaption>
</figure>

## Its output

Each run shows its output under its workers, in Playwright's terminal colors. **Open the output in a
separate window**, the window button on the run, moves it to a window of its own, beside your editor or on another
screen, still updating, with the run's **Stop**. Closing that window, or the same button, now **Show the output
here**, brings it back. The window stays open whatever page the app shows, an analytics dashboard in TV mode
included, and through a reload; it closes as its run leaves the tray (**Clear finished runs**) and with the app. A
window the reloaded tray no longer shows a run in closes.

## A reload

A reload of the window keeps the tray's runs. A run still going is followed again: its output goes on, with its
**Hold failures**, its separate window, and how far each of its ended projects came, as you left them. A run whose
step ended during the reload ends with that step's exit code, and goes on to its next step if it has one; a
reproduction, a bisect or a Flake Lab job that ended meanwhile still records its verdict, once. A run of tests that
was starting, its first Playwright project or its next, goes on with the one the app started. Any other run that was
starting as the window reloaded ends, saying so: run it again. What the run printed while the window reloaded is lost, and the tray
keeps the last 300 lines of each run's output through a reload.

## Limits

- **One window's runs.** Another window of the app lists its own; this tray shows their workers under **Other runs
  of the desktop app**.
- **A run that reports to the team instance** (a run it asked for) has no **Open run #N**, **Compare with run #N** or **Open the
  failure** here: under its workers, **Run #78 · Open** opens its page on the instance in your browser.

## Related

- [Desktop app runs](./desktop-runs): each worker, its stops, its page and the code a stop makes.
- [Desktop app](./desktop): what it runs, and how it links a project to its folder.
- [Share a run live](./share-live): let a teammate watch a run of the tray.
