---
title: Desktop app
description: "The whole dashboard as a local desktop app: no Docker or Node, local test runs from the window, and one-click MCP setup for AI assistants."
lang: en-US
---

# Desktop app

<Needs desktop />

The desktop app runs the **entire dashboard on your machine**, with no Docker, no `npx` and no server to set up. It
bundles the Docker image's server in a native window and adds what only a local app can.

## What it does

- **Receives your local runs** with no URL or token in your Playwright config.
- **Links a project to its checkout**, so a run page can re-run the failed tests here.
- **Reproduces and bisects** a failure, or a flake, in a throwaway worktree, also for your editor.
- **Imports** a blob report or trace dropped on the window.
- **Connects AI assistants** to its MCP server by writing their config.

Everything binds to `127.0.0.1`; nothing is exposed to the network.

## Where it is

Download the installer from the [latest release](https://github.com/PiwiTests/piwi/releases/latest):

| OS | Installer |
|----|-----------|
| **Windows** | `.exe` (per-user, no admin) or `.msi` (per-machine) |
| **macOS** 13.5+ (Apple silicon) | `.dmg` |
| **Linux** (x86-64) | `.AppImage`, `.deb` or `.rpm`, each needing a system WebKitGTK (`webkit2gtk-4.1`) |

The installers are **unsigned**: on macOS, open the app once, then **Open Anyway** in **Privacy & Security**; on
Windows, **More info** then **Run anyway** in SmartScreen.

Data lives in the app-data folder (`%APPDATA%\io.piwitests.dashboard\.data` on Windows,
`~/Library/Application Support/io.piwitests.dashboard/.data` on macOS, `~/.local/share/io.piwitests.dashboard/.data`
on Linux): `piwi.db` (SQLite) and `storage/`. **Settings → Storage → Data location** and the tray's **Open data
folder** show it. Back up the parent folder while the app is closed: its `secret.key` decrypts stored AI keys and SCM tokens.

Closing the window quits the app unless **Run in background** is on in the tray menu; **Start on login** launches it
hidden in the tray. The windows open where you left them, and Cmd or Ctrl with +, - and 0 zoom the dashboard. On macOS the app menu
holds Settings (⌘,), Import Playwright report (⌘O), Back and Forward (⌘[ and ⌘]) and the docs; Windows and Linux
use Ctrl. The tray lists the tests running from the app, each with Stop, and the machine stays awake while they run.
While you look away, a failed run bounces the Dock icon or flashes the taskbar button, a bisect or a lab only at its verdict; a run the window's tray does not list (a `piwi flake` from a terminal or an
editor, a probe, another window's, or one from before a reload) never does. In the background,
[notifications](/features/notifications#browser) arrive as OS notifications with no setup, plus an unread count on the
dock icon or tray tooltip.

It listens on port 3000, or the one set in the `.exe` installer or in **Settings → Desktop app** (`serverPort` in
`settings.json`), a free one when taken.

## Sending results to it

While the app runs, the reporter finds it itself: a config with only a `projectName` reports here. It reads the
address and token the app writes to `~/.piwi/desktop.json` only when nothing else sets a server, so a CI job is never
redirected, and sends the token only to a server that proves it holds it
([details](/guide/reporter#finding-the-desktop-app-automatically)). A suite reporting to a shared dashboard sends its
local runs here with
[`desktopApp: 'prefer'`](/guide/reporter#local-runs-to-the-desktop-app-ci-to-a-team-server), which the
**Connect a suite** snippets carry once you turn on **CI reports to a team server**.

<figure>
  <img src="/screenshots/setup-connect-desktop.png" alt="The connect wizard in the desktop app: the one init command with no server URL, the fixtures import and the test command, and the CI reports to a team server switch, off">
  <figcaption>The desktop app's connect wizard: no URL to set.</figcaption>
</figure>

When the tests run as another user or in a container, **Settings → Desktop app** gives the
address and token to configure by hand. Keep the token in `PIWI_API_KEY`.

A dashboard link opened in your browser opens in the app and its tab closes. A `piwi://open/<page>` link opens its
page there, starting the app if needed (macOS: from Applications; Linux: after one run).

## Projects from local folders

**Projects → New project → Choose folder…** creates a project from a checkout on this machine, named as it would
report, and checks the setup (a Playwright config, Playwright, the reporter): `npx @piwitests/reporter init` in the
folder fixes what is missing. The link stays on this machine, under **project page → Settings → Local folder**, with
the same checks and **Change** and **Unlink**. Linking a folder offers to import the runs already in its `blob-report/` and `test-results/`;
[Open in IDE](/features/ide-integration) resolves source links against it when no workspace root is set; and a clone
serves its git history without an [SCM token](/guide/source-control#on-the-desktop-app).

## Running tests from the app

A run, an execution, a cluster or a test runs again here with the folder's own Playwright, and its button says what:
**Re-run 3 failed tests**, **Re-run this test**, or **Run this test** (20 times, traced) on a test case.

- **The arrow** shows the command, runs it once headed, in the inspector or UI mode, and sets its
  options: tests by `file:line`, title or file, a trace, `--repeat-each` without retries (up to 1,000 in **Run with
  options…**). The button names what differs from Playwright's defaults (**· headed · ×5**); set the project's in
  **Settings → Local folder**.
- **On a run**, the arrow also re-runs its flaky tests or all of them, and the **Tests** tab a selection.
- **Runs keep going while you browse**, in the **Local runs** tray, each under what it runs; results come here, with
  **Compare with run #N**. A [bug report](/features/bug-reports#running-it-with-playwright-in-the-desktop-app)
  from Piwi Picker runs there too.
- **Wrong folder?** With none of the tests in it, the button opens the link's dialog.
- **Watch, pause and step** each worker from the tray, running or at a stop: [Desktop app
  runs](/features/desktop-runs).

### Reproducing a failure and finding the breaking commit

A fix plan's [reproduce and bisect](/features/fix-plans#reproduce-and-bisect) recipe can run here, against the linked
folder, **without touching your checkout**:

- **Reproduce here** checks out the failing commit in a throwaway
  [`git worktree`](https://git-scm.com/docs/git-worktree), installs its dependencies (reusing yours on an
  unchanged lockfile outside a workspace) and any missing browser, and runs the failing test with that commit's own
  Playwright.
- **Find the breaking commit here** bisects between the last green commit and the failing one, with live progress and
  a **Stop** that kills the test and what it started, resets the bisect and removes the worktree. The first bad commit
  is linked to your SCM host and recorded on the failure cluster.

### Jobs from your editor

On a team instance's failure, the [editor extensions](/features/editor-failures#ci-failures-in-the-problems-panel) offer
**Reproduce in the desktop app** and **Find the breaking commit in the desktop app**; on a flaky test, or a failure
whose test has an untested suspect, a [Flake Lab](/features/flake-lab#from-the-editor-and-the-failure-pages) run of
the team instance's plan. The window shows the commits, tests or arms and runs nothing until you start it. The editor
gets the verdict and can share it on the team instance with its own key, which the app never holds.

## Importing local files

Drop a Playwright blob report or trace (`.zip`) on the window, or open one with **Open with → Piwi Dashboard**, and
pick the project: it imports as on the [import page](/guide/importing-runs), several traces forming one run. A
[`.piwibug`](/reference/bug-report-file) becomes a [bug report](./bug-reports).

## Connecting AI assistants

The app serves the [MCP server](/features/mcp) with local tools a hosted instance lacks:
`import_local_report` (a local `.zip` into a project), `read_local_source` (the file on disk now),
`apply_locator_fix` (a recommended locator fix applied to the file, previewed by default), and the
[run tools](./desktop-runs#for-agents) for the runs it starts. It registers as `piwi-desktop`, beside a hosted Piwi.

**Settings → MCP server** detects Claude Code, Claude Desktop, Cursor, Opencode, VS Code, Windsurf and Gemini CLI and
connects each in one click, writing a `piwi-desktop` entry that runs the app's built-in bridge
(`piwi-desktop mcp-stdio`) as a local command. No address or token is copied; the bridge finds the app at start and
sends the token only to a server that proves it holds it. The app must run. It writes only its own entry and keeps the first backup (`<file>.piwi-backup.json` beside the
config). When the app moves, it points that entry at itself again at startup, as it does for an earlier version's
address-and-token entry; nothing else is touched. One you edited, even by one field, shows **Needs update**, and
**Update** replaces it. Restart the client after the entry changes. The page also installs the [agent skills](/features/agent-skills) into a linked folder.

## Updates

**Settings → About → Updates** checks for a newer release (also at startup), lists what changed since your version,
breaking changes first, and installs it on restart. The `.exe` needs no admin rights; the `.msi` does. Downloads are
signature-checked.

## Limits

- **One machine, one user.** The app accepts results only from this machine; a team needs the
  [Docker image](/operate/deployment).
- **Local runs need the checkout**: a linked folder with Playwright installed, plus `git` and your package manager for
  reproduce, bisect (one repository) and the lab.
- **No public address**: no [pull-request feedback](/features/pr-feedback), [auto-heal](/features/auto-heal),
  [share links](/features/share-links) or Jira webhook; email only with SMTP set.

## Related

- [Reporter](/guide/reporter#finding-the-desktop-app-automatically): finding the app
- [MCP server](/features/mcp): the assistants' tools
- [Desktop app runs](/features/desktop-runs): pause, step and watch its runs
