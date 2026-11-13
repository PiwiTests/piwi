---
title: Runs started outside Piwi
description: "A Playwright run you start yourself, in a terminal or with a JetBrains IDE's own Run, follows the editor window whose workspace holds it, else the desktop app that links its folder: it stops at the editor's breakpoints and takes the same controls as a run Piwi started."
lang: en-US
---

# Runs started outside Piwi

<Needs fixtures />

A run you start yourself follows the VS Code or JetBrains window whose workspace holds it: `npx playwright test` in a
terminal, with a reporter and an editor extension newer than 0.62.0, or a JetBrains IDE's own Playwright run (the
gutter's **Run** and **Debug**, a Playwright run configuration), with a reporter newer than 0.63.0. It stops at the
editor's breakpoints, shows in the editor and in Piwi Picker's [Runs window](./runs-window), marked **Terminal** or
**Test runner**, and takes the same controls ([Pause and step from the editor](./editor-run-control)) but **Stop**: its
process is the terminal's or the IDE's. It says so as it starts:

```text
[Piwi Dashboard] Following this run in Visual Studio Code (pid 41230), whose breakpoints stop it: PIWI_EDITOR=off runs it alone.
```

With no editor window on its folder, a run in a folder [the desktop app](./desktop) links follows the app (a reporter
newer than 0.68.0): its Local runs tray lists it, pauses it and watches its workers, as it does
[the runs it starts](./desktop-runs), and Piwi Picker's Runs window holds its failures as you ask.

It runs as its config says, headless by default, so the editor shows a stop as
[a headless run's](./editor-run-control#a-headless-run): an image of its page, which the editor's paused page and Piwi
Picker's Runs window can watch live. To see the browser, add `--headed` to the command, or to the Playwright options
of the run configuration.

## Which editor, or the desktop app

Each editor window's Piwi service writes a file in `~/.piwi/editors` (`PIWI_EDITORS_DIR` names another folder) with
its workspace folders and where its runs connect. The run follows the window one of whose folders holds its Playwright
config's folder or its working directory, links resolved: the most specific folder wins, then the window that started
last. A window of another machine, another user's, or one whose process ended is never followed, nor is a file
written before the machine last started, any file of a folder another user can open, or (but on Windows) a window
whose runs would connect through a folder another user can open.

No window holding it, the run follows the desktop app whose linked folder holds it: the app names where its runs
connect in `~/.piwi/desktop.json` (`PIWI_DESKTOP_CONFIG` names another file) once its server is up, by the same rules.

## When it follows one

- **A run whose output goes to a terminal, or that a test runner started** (one that names its reporter's file in
  `PW_TEST_REPORTER`, as a JetBrains IDE's Playwright runner does), is attended: it stops at the breakpoints.
- **A run whose output goes to a file or a pipe**, as an agent's, follows unattended: it is listed and **Pause** stops
  it, but no breakpoint does and no failure waits. `PIWI_EDITOR=on` attends it. It says so as it starts
  ([the terminal's lines](./watch-a-run#the-terminal-s-lines)).
- **Never** under CI, with Playwright's own debugger (`--debug`, `PWDEBUG=1`) or UI mode, when the run names its own
  `PIWI_RUN_CHANNEL`, or when the desktop app or another launcher started it.
- **`PIWI_EDITOR=off`** runs it alone.

## What it takes from the editor

- **The breakpoints.** It starts with the editor's breakpoints as they are, then takes them as you change them, while
  `piwi.breakpoints` (**Pause the runs Piwi starts at the editor's breakpoints** in a JetBrains IDE) is on. Without
  any, it runs as it would, and **Pause** stops it.
- **The controls**: Pause, Resume, Step, Run to cursor, Finish and [End the test](./end-the-test), and the code a stop
  makes, Assert a region and Mock a request, written in the editor ([Code from a pause](./editor-stop-code)).
- **Record here and Assert** in the test's window, through the editor's recorder, and **Pick a locator**, which goes
  to the editor (its Send to editor pairing), as for a run Piwi starts.
- **Its stops on the desktop app's page of the run**, for a run that reports to [the app](./desktop): which tests wait
  for the editor (**In Visual Studio Code**), each place opening in the IDE.
- **Failures.** A failure goes on, as without Piwi, until you turn the run's
  [**Hold failures**](/guide/concepts#hold-failures) on, in the editor or the Runs window: nobody may be there to answer
  it otherwise.

When the editor closes, or its service stops, the connection closes, and a stop with no pause bar goes on. The token
of the editor's connection reaches the run's workers alone, out of the tests' environment while they run, as for a run
the editor starts.

## A reproduction from the desktop app

A job [the desktop app](./desktop) runs in a throwaway worktree of a commit (**Reproduce here**, a bisect step, a
[Flake Lab](./flake-lab) run) follows the editor window whose workspace holds the project's linked folder, by the same
rules, else the app as before. It follows only an editor extension that knows these reproductions (an older one
leaves it to the app), and a bisect step or a Flake Lab run, which nobody attends, only one that knows such runs too.

- **Its stops show in the editor** at the failing line of the worktree's file, outside the workspace, marked
  **the desktop app's reproduction at commit abc1234, in a throwaway checkout**. A reproduction holds its failures from
  its start, as in the app.
- **Its code is to copy.** Assert, Assert a region and Mock a request offer the code with **Copy the code** and write
  nothing: "This reproduction runs at commit abc1234 in a throwaway checkout: copy the code into your own file."
  Record here is refused there, and a pick goes to the app's window, to copy.
- **The app keeps it.** Its Local runs tray says where its tests wait (**In Visual Studio Code**), read only, stops it,
  and shows its verdict when it ends; the editor offers no Stop.

## Limits

- **Under the desktop app, a pick comes to its window to copy**, and Record here and Assert, which need an editor, are
  not offered. An editor extension older than this one names no pairing for the run: start the test from the editor
  to pick there.
- **No Stop.** End the run in its terminal, or with the IDE's own **Stop**.
- **Debug stops twice.** Under a JetBrains IDE's **Debug**, a breakpoint stops the test in the debugger, then at Piwi's
  stop, whose controls take no key while the debug session runs. `PIWI_EDITOR=off` in the run configuration's
  environment leaves the breakpoints to the debugger.
- **Piwi's reporter in the config.** The run looks for an editor as the reporter starts (`wrapConfig` adds it): with
  the capture fixtures alone, it runs alone.
- **Your machine.** A run in a dev container or over SSH follows an editor whose service runs there too; the desktop
  app's folders are this machine's alone.

## Related

- [Pause and step from the editor](./editor-run-control): the controls, and the paused line.
- [Breakpoints in the browser](./editor-breakpoints): the breakpoints a run takes.
- [Runs from the editor](./editor-runs): the runs Piwi starts.
- [Runs window](./runs-window): the same runs, in Piwi Picker.
- [Desktop app runs](./desktop-runs): the Local runs tray, which follows a run in a linked folder.
