---
title: Write, run and fix a test
description: "The loop from a new Playwright spec to a passing test across Piwi's tools: record it from the editor or the browser, run it with Piwi, stop it at a breakpoint, write the fix at the stop, and debug a failure from its page."
lang: en-US
---

# Write, run and fix a test

<Needs reporter fixtures />

This page takes a new test from an empty spec to a passing run, and names the tool for each step. Each step has a page
of its own; this one is the map. The editor does most of it, in VS Code or a JetBrains IDE; Piwi Picker, the browser
extension, does the same steps from the browser, and the desktop app runs them on your machine without an editor.

## Before the first test

- **The capture fixtures** in your specs: a test that imports `test` from `@playwright/test` runs, but never stops at a
  breakpoint, and the run says so ([Capture fixtures](/guide/capture-fixtures)).
- **The editor extension**, connected to your instance or to the desktop app ([Editor extensions](./editors),
  [Editor connection](./editor-connection)).
- **Optional:** [Piwi Picker](./extension), paired with the editor, to pick and record in your everyday browser and
  follow runs in its [Runs window](./runs-window).

## The steps

| Step | In the editor | Outside the editor | Read on |
|---|---|---|---|
| Write the test | **Record a new test file**, or **Record here** at the cursor | Piwi Picker's **Record actions**, then **Send to editor** | [Record tests from the editor](./editor-recording), [Recorded code](./recorded-code) |
| Run it | **Run with Piwi** from the gutter, the Testing view or the test at the cursor; **Verify ×3** | the desktop app's **Re-run** of tests | [Runs from the editor](./editor-runs), [Desktop app runs](./desktop-runs) |
| Watch it | the status bar, and the run's page on the instance | the Runs window, and the page itself once you **Watch live** at a stop | [Live view of a run](./live-view), [Runs window](./runs-window) |
| Stop it | a breakpoint, **Pause**, **Step**, **Run to cursor** | the pause bar in the test's page | [Breakpoints in the browser](./editor-breakpoints), [Pause and step from the editor](./editor-run-control) |
| Fix it at the stop | **Pick a locator**, **Record here**, **Assert**, **Mock a request** | **Pick a locator** and **Record here** from the pause bar; all four from the Runs window | [Code from a pause](./editor-stop-code) |
| Debug a failure | **Debug in my editor**, from the failure's page | the failure page's Locator fix | [Debug in my editor](./debug-in-editor), [Locator healing](./locator-healing) |

## Write it

**Record a new test file** offers the spec beside the one you are in, else in the config's `testDir`, and writes what
you do in the browser as a test, with locators verified on the page and the page objects of your suite where they
match. **Record here** writes steps at the cursor, in a test, a page object or a helper. A flow recorded in Piwi Picker
lands at the cursor the same way through **Send to editor**: at the top level of a spec, as a new test.

## Run and watch it

A run Piwi starts reports to the instance like any other, with the run's origin. In a project that runs in CI, a
failure seen only in developers' own runs stays out of the team's inbox until someone shows it; one that fingerprints
like a failure CI saw joins that cluster ([Failure clusters & the inbox](./failure-clusters)). A run you start in a
terminal is followed too, when the editor is open: [Runs started outside Piwi](./terminal-runs).

## Stop it and write the fix there

Set a breakpoint on the line you are working on and run the test. It stops before that line's call, in a headed
browser with Piwi's pause bar, or, headless, with the page shown in the editor. **Pick a locator**, **Record here**,
**Assert** and **Mock a request** write their code where the stopped statement stands now, after the edits you made
since the run started ([Code from a pause](./editor-stop-code)); **End the test** skips the rest of it
([End the test](./end-the-test)).

## When it fails

In a run Piwi started, a failing test holds its page where someone can see it (a headed browser, or while the Runs
window is open), and the editor shows the failure as a stop, with the same actions. Otherwise its page on the
instance explains it: the clues rank the likely cause, and the Locator fix panel offers the replacement locator.
**Debug in my editor** on that page runs the failing test again from the editor and stops at the line it failed on.

## Related

- [Editor extensions](./editors): what the editor shows from your suite.
- [Failure clusters & the inbox](./failure-clusters): where failures land once they reach the team's runs.
- [Run control for agents](./agent-run-control): the same stops, steered by an agent.
