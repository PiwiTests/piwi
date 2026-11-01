---
title: Desktop app
description: "The whole dashboard as a local desktop app: no Docker or Node, local test runs from the window, and one-click MCP setup for AI assistants."
lang: en-US
---

# Desktop app

<Needs desktop />

The desktop app runs the **entire dashboard on your machine**, with no Docker, no `npx` and no server to set up. It
bundles the Docker image's server in a native window and adds what only a local app can do.

## What it does

- **Receives your local runs** with no URL or token in your Playwright config.
- **Links a project to its checkout**, so a run page can re-run the failed tests here.
- **Reproduces and bisects** a failure, or a flake, in a throwaway worktree, also for your editor.
- **Imports** a blob report or trace dropped on the window.
- **Connects AI assistants** to its MCP server by writing their config for them.

Everything binds to `127.0.0.1`, so nothing is exposed to the network.

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
folder** show it. Back up the parent folder while the app is closed; its `secret.key` decrypts stored AI keys and SCM
tokens.

Closing the window quits the app unless **Run in background** is on in the tray menu; **Start on login** launches
it hidden into the tray. The windows open where you left them, and Cmd or Ctrl with +, - and 0 zoom the dashboard. On macOS the app menu
holds Settings (⌘,), Import Playwright report (⌘O), Back and Forward (⌘[ and ⌘]) and the docs. While tests run from
the app, the machine does not go to sleep on its own, and a run that fails while you look elsewhere bounces the Dock
icon or flashes the taskbar button. In the background, [notifications](/features/notifications#browser) arrive as OS notifications,
with no setup, and an unread count on the dock icon or the tray tooltip.

It listens on port 3000, or the one set in the `.exe` installer or on **Setup → Desktop app** (`serverPort` in
`settings.json`), a free one when taken.

## Sending results to it

While the app runs, the reporter finds it by itself: a config with only a `projectName` reports here. It reads the
address and token the app writes to `~/.piwi/desktop.json` only when nothing else sets a server, so a CI job is never
redirected ([details](/guide/reporter#finding-the-desktop-app-automatically)). A suite that reports to a shared dashboard sends
its local runs here with
[`desktopApp: 'prefer'`](/guide/reporter#local-runs-to-the-desktop-app-ci-to-a-team-server), which the snippets on
**Setup** carry once you turn on **CI reports to a team server**.

<figure>
  <img src="/screenshots/setup-connect-desktop.png" alt="The connect wizard in the desktop app: the one init command with no server URL, the fixtures import and the test command, and the CI reports to a team server switch, off">
  <figcaption>The desktop app's connect wizard: no URL to set.</figcaption>
</figure>

When the tests run as another user or in a container, **Setup → Send results to this app** gives the
address and the token to configure by hand. Keep the token in `PIWI_API_KEY`.

A dashboard link opened in your browser opens in the app, and its tab closes.

## Projects from local folders

**Projects → New project → Choose folder…** creates a project from a checkout on this machine, named as it would report, and
checks the setup (a Playwright config, Playwright, the reporter):
`npx @piwitests/reporter init` in the folder fixes what is missing. The link to the folder
stays on this machine, under **project page → Settings → Local folder**, with the same checks and **Change** and
**Unlink**. Linking a folder offers to import the runs already in its `blob-report/` and `test-results/` folders;
[Open in IDE](/features/ide-integration) resolves source links against it when no workspace root is set; and a clone
of the repository serves its git history without an [SCM token](/guide/source-control#on-the-desktop-app).

## Running tests from the app

A run, an execution, a cluster or a test runs again here, with the folder's own Playwright, and its button says what:
**Re-run 3 failed tests**, **Re-run this test**, or **Run this test** (20 times, traced) on a test case.

- **The arrow next to the button** shows the command, runs it once headed, in the inspector or UI mode, and sets its
  options: tests by `file:line`, title or file, a trace, `--repeat-each` (up to 1,000 in **Run with
  options…**). The button names what differs from Playwright's defaults (**· headed · ×5**); set the project's in
  **Settings → Local folder**.
- **On a run**, the arrow also re-runs its flaky tests or all of them, and the **Tests** tab a selection.
- **Runs keep going while you browse**, in the **Local runs** tray, each under what it runs; its results come here,
  with **Compare with run #N**. A [bug report](/features/bug-reports#running-it-with-playwright-in-the-desktop-app)
  from Piwi Picker runs there too.
- **Wrong folder?** With none of the tests in it, the button opens the link's dialog.
- **Pause, step and watch** each worker from the tray, at a `page.pause()` or a failure: [Desktop app
  runs](/features/desktop-runs).

### Reproducing a failure and finding the breaking commit

The [reproduce and bisect](/features/fix-plans#reproduce-and-bisect) recipe of a fix plan can run here, against the
linked folder, **without touching your checkout**:

- **Reproduce here** checks out the failing commit in a throwaway
  [`git worktree`](https://git-scm.com/docs/git-worktree), installs its dependencies (reusing yours on an
  unchanged lockfile outside a workspace) and any missing browser, and runs the failing test with that commit's own
  Playwright.
- **Find the breaking commit here** bisects between the last green commit and the failing one, with live
  progress and a **Stop** that kills the test and what it started, resets the bisect and removes the worktree. The
  first bad commit is linked to your SCM host and recorded on the failure cluster.

The application under test has to build from the same checkout, started at each commit by a Playwright `webServer`; without one, a reproduction or
bisect exercises test changes only.

### Jobs from your editor

On a failure of a team instance, the [editor extensions](/features/editor-failures#ci-failures-in-the-problems-panel) offer
**Reproduce in the desktop app** and **Find the breaking commit in the desktop app**; on a flaky test, or a failure
whose test has an untested suspect, a [Flake Lab](/features/flake-lab#from-the-editor-and-the-failure-pages) run of
the team instance's plan. The window shows the commits, tests or arms, and runs nothing until you start it. The editor
gets the verdict and can share it on the team instance with its own key, which the app never holds.

## Importing local files

Drop a Playwright blob report or trace (`.zip`) on the window, or open one with **Open with → Piwi Dashboard**, and
pick the project: it is imported as on the [import page](/guide/importing-runs), several traces forming one run. A
[`.piwibug`](/reference/bug-report-file) becomes a [bug report](./bug-reports).

## Connecting AI assistants

The app serves the [MCP server](/features/mcp) with local tools a hosted instance cannot offer:
`import_local_report` (a local `.zip` into a project), `read_local_source` (the file on disk now),
`apply_locator_fix` (a recommended locator fix applied to the file, previewed by default), and the
[run tools](./desktop-runs#for-agents) for the runs it starts. It registers as `piwi-desktop`, beside a hosted Piwi.

The **MCP server** page detects Claude Code, Claude Desktop, Cursor, Opencode, VS Code, Windsurf and Gemini CLI, and
connects each in one click, writing a `piwi-desktop` entry with the address and token into its config.
It keeps a backup and rewrites only that entry, again when the port changes. Claude Desktop, which takes only
local commands, is pointed at the app's built-in bridge (`piwi-desktop mcp-stdio`), so no token is copied; the app must
run. Restart the client after connecting. The page also installs the
[agent skills](/features/agent-skills) into a linked folder.

## Updates

**Settings → About → Updates** checks for a newer release, downloads it and applies it on restart, and checks at
startup unless turned off. The `.exe` updates silently, without admin rights; the `.msi` asks for them. Downloads are
verified against the project's signing key.

## Limits

- **One machine, one user.** The app accepts results only from this machine; a team needs the
  [Docker image](/operate/deployment).
- **Local runs need the checkout**: a linked folder with Playwright installed, and `git` and your package manager for
  reproduce, bisect (one repository) and the lab.
- **No public address**: no [pull-request feedback](/features/pr-feedback), [auto-heal](/features/auto-heal) or Jira
  webhook, and email only with SMTP set.

## Related

- [Reporter](/guide/reporter#finding-the-desktop-app-automatically): how the reporter finds the app
- [MCP server](/features/mcp): the tools the assistants get
- [Fix plans, reproduce & bisect](/features/fix-plans): the recipes the app runs
- [Importing runs](/guide/importing-runs): the same import from the dashboard
- [Desktop app runs](/features/desktop-runs): pause, step and watch the runs the app starts
