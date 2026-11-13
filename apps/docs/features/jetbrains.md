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
within four folders of the project's (in Rider, the solution's) or of its Git root, and looks again on **Tools → Piwi →
Reload Piwi**. It reads the connection the reporter already uses; otherwise, **Settings → Tools → Piwi** signs you in
with the browser: [Editor connection](./editor-connection).

In a project opened in safe mode, Piwi runs nothing and says it waits for your trust; trusting the project starts it.

**Settings → Tools → Piwi** opens on the connection in use, with **Reconnect**, then the instance saved for the project,
then the desktop app. When the environment or the workspace `.env` names another instance, the page says so above the
fields, and an empty **Server URL** shows its address. **Test connection** beside the URL says whether the address typed
there answers and asks for a key, before you apply it. While the service cannot start, the page and the **Piwi** tool
window offer **Node.js settings…**, and the service starts again once you close the settings.

When the service stops, the **Piwi** tool window says so and offers **Restart the editor service** and **Open log**, as
does a balloon that says it is not running; both are also under **Tools → Piwi** and in the tool window's gear. The
**Log** tab holds the service's starts and stops, why it could not start, its errors and the requests that failed.

The first trusted project with a Playwright config that nothing connects yet shows one notification, once per
installation, with **Connect…**, **Open the failures** and **Learn more**.

Piwi reads Playwright Test suites in JavaScript and TypeScript. A Rider solution whose Playwright tests are written in
C# (a `.csproj` referencing `Microsoft.Playwright`) and that holds no Playwright config gets no tool window or status
item: a notification says so, once per project.


## Where things are

The IDE's LSP client shows warnings, quick fixes (Alt+Enter) and hover in open files.

<figure>
  <img src="/screenshots/jetbrains-heal.png" alt="WebStorm: a broken locator's failure at its line, and Alt+Enter offering the heal that replaces it">
  <figcaption>The heal of a broken locator, offered with Alt+Enter.</figcaption>
</figure>

The rest is native, and every action is under **Tools → Piwi**:

- **The Piwi tool window** names the connection and holds the [failures view](./editor-failures#the-failures-view),
  since the IDE highlights open files only.
- **Code Vision** shows the lines above files, locators and failing lines, a line's entries side by side (a failing
  line's reason, **Run this test**, **Screenshot** and **Trace**), up to the number the IDE's Code Vision settings show
  per line (five by default), in a group named Piwi under **Settings → Editor → Inlay Hints → Code Vision**, where they
  can be moved or hidden; each test's result is in the gutter, and a click on its icon opens the test in the dashboard.
  Its right-click menu holds **Run with Piwi** and **Verify ×3 with Piwi**, which report to the instance as Piwi's own
  runs do.
- **The status bar** shows the latest run, or the run in progress, of the selected file's Playwright config, with an
  icon for its state and the error color while its tests fail. It counts a run you started (`3 of 9 · 1 failed`) as
  the run itself reports it, with no instance too; with one, the run's node in the Piwi tool window counts it the same
  way. A click opens a menu of the actions, led by what the item calls for:
  [the status bar](./editor-runs#the-status-bar). While a run is [shared live](./share-live), the menu opens its page,
  copies its link, and has **Stop sharing the run…**, which asks first.
- **The editor's context menu** has one **Piwi** submenu, in the VS Code extension's order: on a spec, **Run the Test at
  the Caret**, **Verify the test at the caret ×3** and **Run this spec**, then **Run the tests that reach this file**,
  **Record here** and a recording's controls. There and in **Tools → Piwi**, an entry that does not apply is left out.
- **[Recording](./editor-recording)** starts from **Record here**, Alt+Enter or Alt+Insert, and **File → New → Record
  a New Test File…**; its controls are in a banner above the editor.
- **[A paused run](./editor-run-control)**: the line a run is stopped at, Piwi's or [one the IDE's own **Run**
  started](./terminal-runs), has an arrow in the gutter and an inlay above it with **Resume**, **Step**, **Run to
  Caret**, **Finish** and **End test**; they are also in the status bar item's menu, after each stop to go to, and
  under **Tools → Piwi**, with **Pause the run** and **Stop the run**. A headless test's page shows in the Piwi tool window's **Paused page**
  tab, where a click on the image picks the locator of the element under it (Playwright 1.60 or later). On a JetBrains
  Gateway backend, forward the ports **Pair with Piwi Picker** names:
  [Remote development](/guide/remote-development#jetbrains-gateway).
- **[A running test](./watch-running-test)**: while the **Worker** tab watches one, an inlay after the line of
  the call it runs names it, and the **Page** tab lists its page's console and uncaught errors, each test named first
  (closed, it stays closed until the next run).
- **[Code from a pause](./editor-stop-code)**: the inlay, the arrow's menu, the status bar item's menu and **Tools →
  Piwi** also offer **Pick a locator**, **Record here**, **Assert**, **Assert a region** and **Mock a request** (the
  inlay names them shorter), whose code goes above the stopped line in one undoable edit; the end of the caret's line
  says how many elements its locator matches on the stopped page, and a failure held there reads `Held at its failure · …`.
- **The IDE's Playwright runner**: **Settings → Tools → Piwi → Runs → Run the tests in the IDE's Playwright runner**,
  off by default, runs Piwi's test runs there, with its test tree, Debug and Rerun Failed Tests, rather than in the Run
  tool window's console. The runner comes with the IDE's JavaScript plugin, as in WebStorm, IntelliJ IDEA Ultimate
  and Rider; where it lacks one, the option is off and says why.
- **The severity of a failure**: **Settings → Tools → Piwi → Runs** chooses it
  ([CI failures in the Problems panel](./editor-failures#ci-failures-in-the-problems-panel)); an information shows as a
  weak warning.
- **Piwi's MCP server for the agent**: **Settings → Tools → Piwi → AI Assistant** chooses whether the copied
  configuration holds the IDE's key or has the agent sign in through the browser
  ([Piwi's MCP server for the agent](./editors#piwi-s-mcp-server-for-the-agent)).
- **[Run control for agents](./agent-run-control)**: **Tools → Piwi → Copy the Runs' MCP Server Configuration for
  Agents** gives the AI Assistant or another agent the test runs the project starts, to follow, stop and act on, and
  **…for Claude Code or Cursor** the HTTP entry they read; **Reset the runs' MCP server token** gives it a new token;
  **Settings → Tools → Piwi → AI Assistant** turns it off. A stop's menu and **Tools → Piwi** offer **Share the
  Stopped Browser with Playwright Tools**, after a warning.
- **[Open in editor](./ide-integration#jetbrains-ides-the-piwi-plugin)**: a path clicked in the dashboard or the desktop
  app opens at its line, with nothing to set up.

The shortcuts are those of VS Code ([Commands](./editors#commands)), but a run's controls, which use the debugger's
shortcuts of your keymap while they apply and the debugger does not take them ([the
controls](./editor-run-control#the-controls)): in the default keymap `F9` resumes, `F8` steps, `Alt+F9` runs to the
caret (`Alt+Shift+9` in the Linux default keymaps) and `Shift+F8` finishes, and Pause has none; in the Visual Studio
keymaps `F5`, `F10`, `Ctrl+F10` and `Shift+F11`, and Pause the debugger's `Ctrl+Alt+Break`. **Settings → Keymap**
changes them (search `Piwi`).

Each Piwi balloon is titled Piwi and filed by kind in **Settings → Appearance & Behavior → Notifications**: Piwi
(results), Piwi requests (Debug in my editor, a run shared live: they stay until answered), Piwi suggestions, Piwi
problems and Piwi confirmations (Copied., Connected to …), so muting one kind keeps the others.

## Related

- [Editor extensions](./editors): what the editor shows from your suite, in both editors.
- [Editor connection](./editor-connection): the instance the plugin reads, and its key.
- [Open in editor](./ide-integration): open a path from the dashboard in the IDE.
