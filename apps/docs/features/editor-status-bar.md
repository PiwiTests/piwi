---
title: "The editor's status bar"
description: "The Piwi item in the status bar of VS Code or a JetBrains IDE: the latest Playwright run of your branch or the run in progress, the config it speaks for, its menu, and when it turns red."
lang: en-US
---

# The editor's status bar

The Piwi item in the status bar of the [editor extensions](./editors) says how the latest run of your branch went, or
how far a run in progress is, for the Playwright config of the file you are editing.

The latest complete run on the branch: how many tests passed, failed and were flaky, or what still fails and what your
local runs fixed (`2 failing · 1 fixed locally`). While a run started from this editor, or [another run of the branch](./watch-running-test#a-ci-run-of-your-branch),
is in progress, the item counts it instead (`run #124 · 4 of 9 · 1 failed · yours`) and returns to the latest run when it ends.

With several Playwright configs, the item speaks for the config of the file you are editing, the deepest config folder
that holds it, and follows you from file to file; outside every config folder, it shows the first connected config.
Its tooltip names the config (`The active file's Playwright config, in apps/admin (one of 3)`), then holds the run's
counts, the baseline, your local runs since, the run in progress, and when the run was read (`Updated 12 s ago · live`
while the event stream is connected, `· read every minute` without it).

In VS Code, a click opens **Piwi: Open the Piwi menu**, in the JetBrains menu's sections, the item's own action first:
Enter reads the latest run and its failures again (**Refresh the latest run**), without the indexes **Reload Piwi** fetches.
When the extension is not connected, the item says why, and its first entry is **Connect…**, or **Reload Piwi** for an
[unreachable instance](./editor-connection#an-unreachable-instance) or a desktop app to restart.

The item turns red only for a new failure a run on your machine produced; `piwi.statusBarAlert` (Settings → Tools →
Piwi in a JetBrains IDE) chooses `any` or `never` instead. In a JetBrains IDE, an icon before the text shows the state
of the run the item counts (running, failing, passed) or of the connection. A
click opens a menu of the **Tools → Piwi** actions that apply, led by what the item calls for: **Refresh the latest
run**, **Reload Piwi** for an unreachable instance or a desktop app to restart, **Connect…** while not connected,
**Node.js settings…** when Node.js is missing or too old, or **Go to the recorded lines** while a recording runs, with
**Pause recording**, **Resume recording** and **Stop recording**.

## Related

- [Runs from the editor](./editor-runs): run tests from the editor and see their results.
- [Failures in the editor](./editor-failures): the failures a run leaves, at their lines and in the failures view.
- [Editor connection](./editor-connection): the instance the editor reads, and its key.
