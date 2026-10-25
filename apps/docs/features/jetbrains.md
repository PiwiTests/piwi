---
title: JetBrains plugin
description: "The Piwi plugin for WebStorm, IntelliJ IDEA Ultimate, Rider and the other JetBrains IDEs with the LSP API: what it needs, and where it shows the failures, the lines above the code, the status bar and the recording controls."
lang: en-US
---

# JetBrains plugin

The Piwi plugin brings the [editor extensions](./editors) to the JetBrains IDEs with the LSP API: WebStorm, IntelliJ
IDEA Ultimate, Rider and the others, from 2024.1. It runs the same editor service as the VS Code extension, so the
editor pages describe it too, with the JetBrains names of each action. This page lists what the plugin needs, and
where it shows what VS Code shows differently.

<figure>
  <img src="/screenshots/jetbrains-failures.png" alt="WebStorm: the failing tests tinted in the spec, the Piwi tool window below with the run's failures">
  <figcaption>WebStorm: the latest run's failures in the Piwi tool window, a local run laid over them, the failing tests tinted above.</figcaption>
</figure>

## Install and start

Install **Piwi** from **Settings → Plugins** or the
**[JetBrains Marketplace ↗](https://plugins.jetbrains.com/plugin/34674-piwi)**. IntelliJ IDEA Community Edition and
Android Studio lack the LSP API the plugin needs.

The plugin starts the editor service with the project's Node.js interpreter, 20 or later (**Settings → Languages &
Frameworks → Node.js**, which the status bar opens when it is missing or older), once it finds a Playwright config
within four folders of the project's (in Rider, the solution's) or of its Git root, and looks again on **Tools → Piwi
→ Refresh**. It reads the connection the reporter already uses; otherwise, **Settings → Tools → Piwi** signs you in
with the browser: [Editor connection](./editor-connection).

The first trusted project with a Playwright config that nothing connects yet shows one notification, once per
installation, with **Connect…**, **Open the Failures** and **Learn More**.

## Where things are

The IDE's LSP client shows warnings, quick fixes (Alt+Enter) and hover in open files; the rest is native, and every
action is under **Tools → Piwi**:

- **The Piwi tool window** names the connection and holds the [failures view](./editor-failures#the-failures-view),
  since the IDE highlights open files only.
- **Code Vision** shows the lines above files, locators and failing lines; each test's result is in the gutter, and a
  click on its icon opens the test in the dashboard.
- **The status bar** shows the latest run, or the run in progress, of the selected file's Playwright config, with an
  icon for its state and the error color while its tests fail; a click opens a menu of the actions, led by what the
  item calls for: [the status bar](./editor-runs#the-status-bar).
- **The editor's context menu** of a spec holds **Run the Test at the Caret**, **Verify the Test at the Caret ×3** and
  **Run This Spec**.
- **[Recording](./editor-recording)** starts from **Record Here**, Alt+Enter or Alt+Insert, and **File → New → Record
  a New Test File…**; its controls are in a banner above the editor.
- **[A paused run](./editor-run-control)**: the line a run Piwi started is stopped at has an arrow in the gutter and
  an inlay above it with **Resume**, **Step**, **Run to Caret** and **Finish**; they are also first in the status bar
  item's menu and under **Tools → Piwi**, with **Pause the Run** and **Stop the Run**. A headless test's page shows in
  the Piwi tool window's **Paused Page** tab.
- **The severity of a failure**: **Settings → Tools → Piwi → Runs** chooses it
  ([CI failures in the Problems panel](./editor-failures#ci-failures-in-the-problems-panel)); an information shows as a
  weak warning.
- **Piwi's MCP server for the agent**: **Settings → Tools → Piwi → AI Assistant** chooses whether the copied
  configuration holds the IDE's key or has the agent sign in through the browser
  ([Piwi's MCP server for the agent](./editors#piwi-s-mcp-server-for-the-agent)).
- **[Open in IDE](./ide-integration#jetbrains-ides-the-piwi-plugin)**: a path clicked in the dashboard or the desktop
  app opens at its line, with nothing to set up.

The shortcuts are those of VS Code ([Commands](./editors#commands)), but a run's controls, which use the debugger's
shortcuts of your keymap while they apply: in the default keymap `F9` pauses and resumes, `F8` steps, `Alt+F9` runs
to the caret and `Shift+F8` finishes. **Settings → Keymap** changes them (search `Piwi`).

## Related

- [Editor extensions](./editors): what the editor shows from your suite, in both editors.
- [Editor connection](./editor-connection): the instance the plugin reads, and its key.
- [Open in IDE](./ide-integration): open a path from the dashboard in the IDE.
