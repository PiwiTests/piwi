---
title: Desktop app
description: "The whole dashboard as a local desktop app: no Docker or Node, local test runs from the window, and one-click MCP setup for AI assistants."
lang: en-US
---

# Desktop app

<Needs desktop />

The desktop app runs the **entire dashboard on your machine**, with no Docker, `npx` or server to set up. It
bundles the Docker image's server in a native window and adds what only a local app can. Its runs:
[Local runs tray](./local-runs-tray) for each run, [Desktop app runs](./desktop-runs) for each worker.

## What it does

- **Receives your local runs** with no URL or token in your Playwright config.
- **Links a project to its folder**, so a run page can re-run the failed tests here.
- **Reproduces and bisects** a failure, or a flake, in a throwaway worktree, also for your editor.
- **Imports** a blob report or trace dropped on the window.
- **Connects AI assistants** to its MCP server by writing their config.

Everything binds to `127.0.0.1`.

## Where it is

<DownloadApps app="desktop" />

What each installer needs:

| OS | Installer |
|----|-----------|
| **Windows** (x64) | `.exe` (per-user, no admin) or `.msi` (per-machine) |
| **macOS** 13.5+ (Apple silicon) | `.dmg` |
| **Linux** (x86-64) | `.AppImage`, `.deb` or `.rpm`, each needing a system WebKitGTK (`webkit2gtk-4.1`) |

The installers, [Piwi Runner](./piwi-runner)'s too, are **unsigned**: on macOS, open the app
once, then **Open Anyway** in **Privacy & Security**; on Windows, **More info** then **Run anyway** in SmartScreen.

Its data, and how to back it up: [the desktop app's data](/operate/backup-restore#the-desktop-app).

The tray menu, in the editors' order: **Show the stopped test** if one waits, **Open Piwi Desktop**, **Stop** per
running test (machine kept awake), **MCP server…**, **Desktop app settings…**, **Run in background** (off, closing
the window quits), **Start on login**, **Check for updates…**, **Open data folder**, **Show logs**, **Quit Piwi Desktop**. The windows open where you left them, with [keyboard shortcuts](/reference/keyboard-shortcuts#desktop-app)
and macOS menu items. **Open in a
window**, on a worker of the [Local runs tray](./desktop-runs), keeps it on top, then says how its run ended.
While a run reports into the app, from the app, an editor, a terminal or CI, its progress shows on the taskbar button or
the Dock icon and the window's title (`Running 3/9`), and a dot on the system tray icon (and the taskbar button, on Windows)
says how it stands: blue while it runs, red once a test failed, violet while a test of the app's runs, or of an
editor's, waits at a stop for you (`1 test waits for you`). A run from the window's Local runs tray flashes its outcome
as it ends (slate when interrupted), whatever else runs, and, failed while you look away, bounces the Dock icon or
flashes the taskbar button, a bisect or a lab only at its verdict; an editor's, a terminal's or CI's run, or one from
before a reload, never does. On Windows, the taskbar button's thumbnail has **Open**, which restores the window, and
**Stop**, which stops the window's run started last, the next one at a second click. In the background,
[notifications](/features/notifications#browser) arrive as OS notifications with no setup, plus an unread count on the
dock icon or system tray tooltip.

It listens on port 3000, or the one set in the `.exe` installer or in **Settings → Desktop app** (`serverPort` in
`settings.json`), a free one when taken.

## Sending results to it

While the app runs, the reporter finds it itself: a config with only a `projectName` reports here. It reads the
address and token the app writes to `~/.piwi/desktop.json` only when nothing else sets a server, so a CI job is never
redirected, and sends the token only to a server that proves it holds it
([details](/guide/reporter#finding-the-desktop-app-automatically)). A suite reporting to a shared dashboard sends its
local runs here with
[`desktopApp: 'prefer'`](/guide/reporter#local-runs-to-the-desktop-app-ci-to-a-team-server), which the
**Connect a suite** snippets carry with **CI reports to a team server** on.

<figure>
  <img src="/screenshots/setup-connect-desktop.png" alt="The connect wizard in the desktop app: the one init command with no server URL, the fixtures import and the test command, and the CI reports to a team server switch, off">
  <figcaption>The desktop app's connect wizard: no URL to set.</figcaption>
</figure>

When the tests run as another user or in a container, **Settings → Desktop app** gives the
address and token to configure by hand. Keep the token in `PIWI_API_KEY`.

A dashboard link opened in your browser opens in the app, closing its tab. A `piwi://open/<page>` link opens its
page there, starting the app if needed (macOS: from Applications; Linux: after one run).

## Projects from local folders

A project's folder holds its Playwright config (a monorepo's subfolder, not its root).
**Projects → New project → Choose folder…** creates a project from one, named as it would report, and checks its
setup: `npx @piwitests/reporter init` there fixes what is missing. The link stays local, under
**Project → Settings → Local folder**, with its checks, **Unlink** and **Change**, which suggests folders and checks
your pick. Linking it offers to import its earlier runs; [Open in editor](/features/ide-integration) resolves source
links against it when no workspace root is set; and a clone serves its git history without an
[SCM credential](/guide/source-control#on-the-desktop-app).

## Running tests from the app

A run, an execution, a cluster or a test runs again here with the folder's own Playwright: its run button lists
**This computer** under **Where**, and says what one click runs, such as **Re-run 3 failed tests** or **Run this
test** (×20 until a failure, traced) on a test case. Its arrow, its options and its dialog:
[Run on this computer](./run-on-this-computer).

- **Runs keep going while you browse**, in the **Local runs** tray, each under what it runs; results come here, with
  **Compare with run #N**. A [bug report](/features/replay-a-bug-report#running-it-with-playwright)
  from Piwi Picker runs there too.
- **Watch, pause and step** each worker from the Local runs tray, running or stopped: [Desktop app
  runs](/features/desktop-runs). While it goes on, the run's own page shows the same (**On your machine**), with its
  **Stop**, [**Hold failures**](/features/watch-a-run#hold-failures) and output.

### Reproducing a failure and finding the breaking commit

A fix plan's [reproduce and bisect](/features/fix-plans#reproduce-and-bisect) recipe can run here **without touching
your checkout**:

- **Reproduce here** checks out the failing commit in a throwaway
  [`git worktree`](https://git-scm.com/docs/git-worktree), installs its dependencies (reusing yours on an
  unchanged lockfile outside a workspace) and any missing browser, and runs the failing test with that commit's own
  Playwright, [stopping in your editor](./desktop-runs#a-reproduction-in-your-editor) when one is open.
- **Find the breaking commit here** bisects between the last green commit and the failing one, with live progress and
  a **Stop** that kills the test and what it started, resets the bisect and removes the worktree. The first bad commit
  is linked to your SCM host and recorded on the failure cluster.

### Jobs from your editor

On a team instance's failure, the [editor extensions](/features/editor-failures#the-failures-view) offer
**Reproduce in the desktop app** and **Find the breaking commit in the desktop app**; on a flaky test, or a failure
whose test has an untested suspect, a [Flake Lab](/features/flake-lab#from-the-editor-and-the-failure-pages) run of
the team instance's plan. The window shows the commits, tests or arms and runs nothing until you start it. The editor
gets the verdict and can share it on the team instance with its own key, which the app never holds.

## Importing local files

Drop a Playwright blob report or trace (`.zip`) on the window, or open one with **Open with → Piwi Desktop**, and
pick the project: it imports as on the [import page](/guide/importing-runs), several traces forming one run. A
[`.piwibug`](/reference/bug-report-file) becomes a [bug report](./bug-reports).

## Connecting AI assistants

The app serves the [MCP server](/features/mcp) with local tools a hosted instance lacks:
`import_local_report` (a local `.zip` into a project), `read_local_source` (the file on disk now),
`apply_locator_fix` (a recommended locator fix applied to the file, previewed by default), and the
[run tools](./desktop-runs#for-agents) for the runs it starts. It registers as `piwi-desktop`, beside a hosted Piwi.

**Settings → MCP server** connects Claude Code, Cursor and other clients it detects in one click:
[the desktop app's client setup](/features/mcp#in-the-desktop-app).

## Updates

**Settings → About → Updates** checks for a newer release (also at startup), lists what changed since your version,
breaking changes first, and installs it on restart; the tray's **Check for updates…** installs and restarts.
The `.exe` needs no admin rights; the `.msi` does. Downloads are signature-checked.

## Limits

- **One machine, one user.** It accepts results only from this machine; a team needs the
  [Docker image](/operate/deployment).
- **Local runs need the checkout**: a linked folder (a monorepo's subfolder works) with Playwright installed, plus `git`
  and your package manager for reproduce, bisect (one repository) and the lab.
- **No public address**: no [pull-request feedback](/features/pr-feedback), [auto-heal](/features/auto-heal),
  [share links](/features/share-links) or Jira webhook; email only with SMTP set.

## Related

- [Reporter](/guide/reporter#finding-the-desktop-app-automatically)
- [MCP server](/features/mcp)
- [Run on this computer](/features/run-on-this-computer)
- [Desktop app runs](/features/desktop-runs)
- [Write, run and fix a test](./write-run-fix)
