---
title: CI runs in your editor
description: "Follow a Playwright CI run of your branch from VS Code or a JetBrains IDE while it runs: its tests and progress, the line each running test is at, and its pages from the team instance's live view, read-only."
lang: en-US
---

# CI runs in your editor

<Needs editor />

While CI runs your branch, the [editor extensions](./editors) show that run beside your own: its progress, its tests
as they end, the line each running test is at, and, when its project has the [live view](./live-view) on, its pages.
It is read-only: nothing pauses, steps, holds or shares a CI run from the editor.

## Which runs

A CI run of the branch your workspace reads or has checked out, or a teammate's on it or on the branch your results
are [compared with](./editor-status-bar#compare-with-another-run), shows while it runs. The editor finds it as the
instance announces it, or as it reads the latest run of the branch in progress. It follows the two newest runs of a
branch at most, and stops following a run as it ends, as a newer run takes its place, or when the workspace reads
another instance, project or branch.

VS Code's status bar says `CI run #125` or `run #126`, and its Testing view `Piwi: CI run #125 on main`, with results
as they end; your own run keeps the status bar. A test line Piwi marks keeps its own latest result, and its hover
names the CI run running it.

## The CI run's tests

- **The CI Runs view** of VS Code's Piwi panel, and the **CI run** tab of the JetBrains Piwi tool window, show while a
  CI run runs. Each lists `CI run #78`, its branch and progress, **Open run #78** and its tests: those running, then
  the latest that ended, failures first. A running test opens the call it is at, else its spec (a double click in
  JetBrains).
- **The line each running test is at** ends with a plain mark in the CodeLens or inlay color, `CI run #78 · worker 2:
  Click getByRole('button')`: a [CI position](/guide/concepts#ci-position), never a stop, on the line of the run's
  commit. It shows in a file of your workspace only, placed from the run's own steps: never one in `node_modules` or
  outside the workspace.
- **Piwi Picker's Runs window** lists them too: [CI runs](./runs-window#open-it).

## Watch a CI lane

**Watch**, under a running test whose project has the [live view](./live-view) on, opens its lane read-only, named
`CI run #78 · worker 2`, in the VS Code worker panel, the JetBrains **Worker** tab or the Runs window: no
**Interact**, no pick. It follows the lane through its next tests, and ends with the run, as you hide or close the
view, or as the instance closes it, saying why. Its images come from the
[team instance](./live-view#what-is-sent-to-whom-and-what-is-kept), read with the editor's connection; under the
image, the same layers as a local lane ([Beside the image](./watch-running-test#beside-the-image)).

**Watch on the dashboard** opens the lane on the run's page, offered where the editor cannot show it (an older
instance, a refused **Watch**).

## Limits

- **Read-only.** No control, share or hold reaches a CI run, and its position is never a stop.
- **One worker per editor.** The worker panel or tab watches one lane, a local worker's or a CI run's: watching another
  moves it there.
- **A run's steps.** The positions come from the steps the CI run's reporter streams, so a run whose reporter streams
  none lists its tests without them.

## Related

- [Watch a running test](./watch-running-test): a test running on your machine.
- [Live view of a run](./live-view): the team instance's view of a run, which a CI lane comes from.
- [Failures in the editor](./editor-failures): the CI run's failures once it ended.
