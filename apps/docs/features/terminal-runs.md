---
title: Runs started in a terminal
description: "A Playwright run you start in a terminal, in a folder of your editor's workspace, follows that editor window: it stops at its breakpoints and takes its controls, as a run Piwi started does."
lang: en-US
---

# Runs started in a terminal

<Needs fixtures />

A run you start yourself, `npx playwright test` in a terminal, follows the VS Code or JetBrains window whose workspace
holds it, with a reporter and an editor extension newer than 0.62.0. It stops at the editor's breakpoints, shows in the
editor and in Piwi Picker's [Runs window](./runs-window) as a run in a terminal, and takes the same controls
([Pause and step from the editor](./editor-run-control)) but **Stop**: its process is the terminal's. It says so as it
starts:

```text
[Piwi Dashboard] Following this run in Visual Studio Code (pid 41230), whose breakpoints stop it: PIWI_EDITOR=off runs it alone.
```

It runs as its config says, headless by default, so the editor shows a stop as
[a headless run's](./editor-run-control#a-headless-run): an image of its page, which Piwi Picker can watch live.

## Which editor

Each editor window's Piwi service writes a file in `~/.piwi/editors` (`PIWI_EDITORS_DIR` names another folder) with
its workspace folders and where its runs connect. The run follows the window one of whose folders holds its Playwright
config's folder or its working directory, links resolved: the most specific folder wins, then the window that started
last. A window of another machine, another user's, or one whose process ended is never followed, nor is a file
written before the machine last started, any file of a folder another user can open, or (but on Windows) a window
whose runs would connect through a folder another user can open.

## When it follows one

- **Only a run whose output goes to a terminal.** One whose output goes to a file or a pipe runs alone, unless it sets
  `PIWI_EDITOR=on`.
- **Never** under CI, with Playwright's own debugger (`--debug`, `PWDEBUG=1`) or UI mode, when the run names its own
  `PIWI_RUN_CHANNEL`, or when the desktop app or another launcher started it.
- **`PIWI_EDITOR=off`** runs it alone.

## What it takes from the editor

- **The breakpoints.** It starts with the editor's breakpoints as they are, then takes them as you change them, while
  `piwi.breakpoints` (**Pause the runs Piwi starts at the editor's breakpoints** in a JetBrains IDE) is on. Without
  any, it runs as it would, and **Pause** stops it.
- **The controls**: Pause, Resume, Step, Run to cursor, Finish and [End the test](./end-the-test), and the code a stop
  makes, Assert a region and Mock a request, written in the editor ([Code from a pause](./editor-stop-code)).
- **Failures.** A failure is held only while the Runs window follows the editor's runs as the worker starts: nobody
  may be there to answer it otherwise, and it goes on, as without Piwi.

When the editor closes, or its service stops, the connection closes, and a stop with no pause bar goes on. The token
of the editor's connection reaches the run's workers alone, out of the tests' environment while they run, as for a run
the editor starts.

## Limits

- **No Pick, Record or Assert in the test's window.** They need the pairing a run Piwi starts carries: start the test
  from the editor to use them. Pick on the image names the locator, for you to copy, without writing it.
- **No Stop.** End the run in its terminal.
- **Piwi's reporter in the config.** The run looks for an editor as the reporter starts (`wrapConfig` adds it): with
  the capture fixtures alone, it runs alone.
- **Your machine.** A run in a dev container or over SSH follows an editor whose service runs there too.

## Related

- [Pause and step from the editor](./editor-run-control): the controls, and the paused line.
- [Breakpoints in the browser](./editor-breakpoints): the breakpoints a run takes.
- [Runs from the editor](./editor-runs): the runs Piwi starts.
- [Runs window](./runs-window): the same runs, in Piwi Picker.
