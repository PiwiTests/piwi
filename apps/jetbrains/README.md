# Piwi for JetBrains IDEs

Your Playwright suite's history at the line you are editing, from a [Piwi](https://piwitests.dev) instance, in
WebStorm, IntelliJ IDEA Ultimate and Rider. Piwi keeps every run CI throws away, groups the failures by root cause and
finds the locator you should have used; this plugin brings that into the IDE. It runs the same editor service as the
[VS Code extension](../vscode/README.md), so both show the same things.

Install it from the [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/34674-piwi) (**Settings → Plugins**),
in any JetBrains IDE with the LSP API and JavaScript support, from 2024.1, with Node.js 20 or later.

## What it shows

- **The latest CI failures at their lines.** Each failure of the latest run on your branch is an error at the line
  that failed, with the reason, the screenshot and the trace one action away. A run you make locally lays over it the
  moment it ends: a test you fixed leaves, one you broke joins.
- **The heal as a quick fix.** On a broken locator, the replacement Piwi recommends from the last passing run is an
  Alt+Enter away: the same edit an auto-heal pull request would make.
- **The Piwi tool window.** The run's failures as a tree, grouped by file, cluster or owner, with your runs since; each
  test re-runs, opens its trace or its page in one click. Compare with another branch, a run by its id, or your local
  runs only.
- **The tests behind each line.** Each test's latest result in the gutter, a failing test's body tinted, and above
  each locator line and each application file the tests that use or reach it, ready to run (Code Vision).
- **Coverage marks.** With coverage recorded, the lines your tests ran, in TypeScript, JavaScript and C# alike, the
  tests behind each function, and the lines changed since the coverage run.
- **Brittle locators and breaking changes.** A warning on a locator that will not survive a restyle, and on an unsaved
  change that renames a string your tests find elements by, each with a quick fix.
- **Tests recorded at the caret.** **Tools → Piwi → Record Here** opens a browser through your project's own
  Playwright and writes what you do there into the test, calling your page objects when connected. No instance needed.
- **The status bar.** The latest run, the run you started as it runs, and what it changed once it ended.

## Connect

The plugin reads the connection the Piwi reporter already uses: the `PIWI_*` variables in the environment or the
workspace `.env`, or the Piwi desktop app. Otherwise, **Settings → Tools → Piwi** signs you in with the browser. Paths
clicked in the dashboard open at their line in the IDE, locators picked in the Piwi Picker browser extension land at
the caret, and Piwi's MCP server is one copy away for the AI Assistant.

Nothing from your project is sent to the instance: its locator index, code reach and latest run are compared with your
files locally.

[Editor extensions](https://piwitests.dev/features/editors) documents everything the plugin shows, with the differences
from VS Code under [JetBrains IDEs](https://piwitests.dev/features/editors#jetbrains-ides).
