---
title: Test card
description: "A test's card in VS Code's hover and on a click of its result icon in a JetBrains IDE: its latest runs as a strip, each linked to its run, how many passed, its median duration, its last failure, its owner, tags and quarantine."
lang: en-US
---

# Test card

<Needs editor />

A test's card answers "my bug or a flake?" without leaving the editor. In VS Code it is the test's hover on its
`test(…)` line; in a JetBrains IDE, a click on the test's result icon opens it.

<figure>
  <img src="/screenshots/vscode-test-card.png" alt="VS Code: the hover on a failing test's line, its card: the latest runs as colored bars, how many passed and the median duration, the run it last failed in and why, then Run, Open in dashboard and More…">
  <figcaption>VS Code: the card in the hover on the test's line.</figcaption>
</figure>

<figure>
  <img src="/screenshots/jetbrains-test-card.png" alt="WebStorm: the card a click on a failing test's result icon opens: the test's title, its latest runs as colored bars and how they went, the run it last failed in and why, then Run, Open in dashboard and More…">
  <figcaption>A JetBrains IDE: the card a click on the test's result icon opens.</figcaption>
</figure>

## What it shows

- **The strip**: the test's latest runs, oldest on the left, one bar each in the dashboard's color for its outcome:
  green passed, red failed, fuchsia flaky (it passed on a retry), gray skipped. A run is one bar, whatever its retries,
  repetitions and projects: failed when one of them ended failed, flaky when one passed on a retry. Each bar links to
  its run, and its tooltip names the run, the outcome and how long the test took.
- **How far back**: twenty runs at most, read from the test's last 50 attempts, so a test run in three projects shows
  about sixteen, and one run with `--repeat-each` fewer still. The dashboard's test page holds its whole history.
- **How they went**: `Passed 17 of the last 20 runs · 2 flaky · median 1.4 s`, skipped runs left out.
- **The last failure**: the run it failed in, how long ago, and why in one line, in the editor's error color: the
  headline of its error (`Expected true, got false — toBe`).
- **Its owner, tags and quarantine**: the owner its `piwi:owner` annotation names, its Playwright tags, and, while it
  is [quarantined](./flaky-tests#quarantine-with-a-way-out), for how long and how many passes it has toward release.

Under the card, **Run** runs the test, **Open in dashboard** opens its page, and **More…** opens the test's actions:
[Runs from the editor](./editor-runs) lists them.

## Where it comes from

The editor reads the test's history from the instance as the card opens, and keeps it for 30 seconds. It waits for it
one and a half seconds at most: past that, the hover shows the test's result in one line, and a click in a JetBrains
IDE opens the test's actions. A test the instance does not know yet has no card.

## Related

- [Runs from the editor](./editor-runs)
- [Flaky tests](./flaky-tests)
