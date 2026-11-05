---
title: Share a run live
description: "Let a teammate watch the tests of a Playwright run on your machine from its page on the team instance, as a CI run's live view: Share live from VS Code, a JetBrains IDE, Piwi Picker's Runs window or the desktop app."
lang: en-US
---

# Share a run live

<Needs reporter fixtures />

A run on your machine sends the team instance nothing of its pages until you share it. Shared, it gets the
[live view](./live-view) a CI run gets: a teammate opens its page and watches each worker, and its stops show on its
rows. Sharing changes nothing for the run itself, and stops as you choose, or as the tool that shared it closes.

## Share and stop

Choose **Share live** while a local run executes to let a teammate watch it. The run must report to a team instance
whose project enables live view, and connect to an editor or the desktop app for controls.

| Where | Share | Stop |
|---|---|---|
| VS Code | **Piwi: Share the run live on the team instance**, or the status bar's broadcast icon | **Piwi: Stop sharing the run live**, or the status bar's **Live** |
| JetBrains IDEs | **Tools → Piwi → Share the Run Live** | **Tools → Piwi → Stop Sharing the Run Live** |
| Piwi Picker's [Runs window](./runs-window) | **Share live** under the run's name | **Stop sharing** |
| The desktop app's [Local runs tray](./desktop-runs) | **Share live** above the run's workers | **Stop sharing** |

The first share in a window asks for confirmation. The shared run shows its destination, viewer count and a link to copy.

Until then, its workers send nothing, and its running tests say **Not shared live** where **Watch** would be. Once
shared, its stops (the call, its file and line, the test's title) reach everyone with the run's page open, and images
only those watching. **Stop sharing** closes the views within seconds and clears **Paused** from the rows. Closing the
editor or the desktop app stops it too.

A run that cannot be shared says why: it reports to no instance or to the desktop app, its project has the live view
off, or the reporter's global setup did not register it. A sharing that stops on its own says why (the live view turned
off, the instance restarted or stopped answering), and **Share live** shows again.

## Related

- [Live view of a run](./live-view): what a teammate sees, what is sent and what is kept
- [Editor run control](./editor-run-control): the controls of a run your editor starts
- [Runs window](./runs-window): Piwi Picker's view of your runs
- [Desktop app runs](./desktop-runs): the desktop app's runs and its tray
