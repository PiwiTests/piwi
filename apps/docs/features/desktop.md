---
title: Desktop app
description: "The whole dashboard as a local desktop app: no Docker or Node, local test runs from the window, and one-click MCP setup for AI assistants."
lang: en-US
---

# Desktop app

<Needs desktop />

The desktop app runs the **entire dashboard on your machine**, with no Docker, no `npx` and no server to set up. It
bundles the same server as the Docker image in a native window, keeps your data in a local folder, and adds what only
a local app can do.

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

The installers are **unsigned**: on macOS, open the app once, then **Open Anyway** in the **Privacy & Security**
settings; on Windows, **More info** then **Run anyway** in SmartScreen. Linux shows no prompt.

Data lives in the OS app-data folder (`%APPDATA%\io.piwitests.dashboard\.data` on Windows,
`~/Library/Application Support/io.piwitests.dashboard/.data` on macOS, `~/.local/share/io.piwitests.dashboard/.data`
on Linux): `piwi.db` (SQLite) and `storage/`. **Settings → Storage → Data location** and the tray's **Open data
folder** show it. Back up the parent folder while the app is closed; its `secret.key` decrypts stored AI keys and SCM
tokens.

Closing the window quits the app unless you turn on **Run in background** in the tray menu; **Start on login** launches it hidden into the tray. While the window is in the background, your
[notifications](/features/notifications) arrive as OS notifications, with an unread count on the dock icon or in the
tray tooltip.

## Sending results to it

While the app runs, the reporter finds it by itself: a config with only a `projectName` reports here. It reads the
address and token the app writes to `~/.piwi/desktop.json` only when nothing else sets a server, so a CI job is never
redirected ([details](/guide/reporter#finding-the-desktop-app-automatically)). A suite that reports to a shared
dashboard sends its local runs here with
[`desktopApp: 'prefer'`](/guide/reporter#local-runs-to-the-desktop-app-ci-to-a-team-server), which the snippets on
**Setup** carry once you turn on **CI reports to a team server**.

When the tests run as another user or in a container, **Setup → Send results to this app** gives the
address (port 3000 unless it is taken) and the token to configure by hand. Keep the token in `PIWI_API_KEY`, not in
the config.

A dashboard link opened in your browser opens in the app instead.

## Projects from local folders

**Projects → New project → Choose folder…** creates a project from a checkout on this machine. The app detects the
name it would report under and checks the setup (a Playwright config, Playwright installed, the reporter wired in);
anything missing is a warning, and `npx @piwitests/reporter init` in the folder fixes it. The link to the folder
stays on this machine, under **project page → Settings → Local folder**, with the same checks and **Change** and
**Unlink**. Linking a folder offers to import the runs already in its `blob-report/` and `test-results/` folders;
[Open in IDE](/features/ide-integration) resolves source links against it when no workspace root is set; and a clone
of the repository serves its git history without an [SCM token](/guide/source-control#on-the-desktop-app).

## Running tests from the app

**Run locally**, on a run page or an execution page, re-runs the failed tests on this machine with the folder's own
Playwright and the app's bundled Node. The first time, it asks you to link the project to its folder.

- **The arrow next to the button** holds the options: headless, headed, the Playwright inspector or UI mode; tests
  by `file:line`, title or file; a forced trace; `--repeat-each` up to 100 times (1,000 in **Run with
  options…**, which shows the command). The last choice becomes the project's one-click default.
- **Runs keep going while you browse.** Output streams into the **Local runs** tray; stopping is always explicit.
- **More places to run from:** **Reproduce locally** on a test case (20 times with a trace), **Run locally**
  on a failure cluster, and a [bug report](/features/bug-reports#running-it-with-playwright-in-the-desktop-app)
  sent from Piwi Picker.
- **Wrong folder?** When none of the tests exist in the linked folder, the button opens the dialog to fix the link.

The run uses your project's Playwright config, so its results come here, and the tray links to the new run.

### Reproducing a failure and finding the breaking commit

The [reproduce and bisect](/features/fix-plans#reproduce-and-bisect) recipe of a fix plan can run here, against the
linked folder, **without touching your checkout**:

- **Reproduce here** checks out the failing commit in a throwaway
  [`git worktree`](https://git-scm.com/docs/git-worktree), installs its dependencies (reusing your `node_modules`
  when the lockfile is unchanged) and the browser if missing, and runs the failing test with that commit's own
  Playwright.
- **Find the breaking commit here** bisects step by step between the last green commit and the failing one, with live progress and a **Stop** that kills the test and what it started, resets the bisect and removes
  the worktree. The first bad commit is linked to your SCM host and recorded on the failure cluster.

It needs `git` and your package manager on this machine, and bisects one repository. The application under test has
to build from the same checkout, started at each commit by a Playwright `webServer`; without one, a reproduction or
bisect exercises test changes only.

### Jobs from your editor

On a failure of a team instance, the [editor extensions](/features/editor-failures#ci-failures-in-the-problems-panel) offer
**Reproduce in the desktop app** and **Find the breaking commit in the desktop app**; on a flaky test, or a failure
whose test has an untested suspect, a [Flake Lab](/features/flake-lab#from-the-editor-and-the-failure-pages) run of
the team instance's plan. The window shows the commits, tests or arms, and runs nothing until you start it. The editor
gets the verdict and can share a first bad commit, or the lab's results, on the team instance with its own key, which
the app never holds.

### Reproducing a flake

On a flaky test's Flakiness tab, **Reproduce this flake** runs the [Flake Lab](/features/flake-lab) here: it checks
out the commit of the test's latest failure in a throwaway worktree, installs, and runs `piwi flake` there, streaming
into the tray. Its options pick the arms (every suspect, all at once, or one), the runs and the budget. The experiment
lands on the tab, recorded as run from `desktop`.

Once an experiment has reproduced a test, **Find the breaking commit here** on its failure is flake-aware: each step
runs the reproducing arm (`piwi flake verify --bisect`), bad at a failure with the same error as in CI, good after
enough clean runs, which tells when a flake started.

## Importing local files

Drop a Playwright blob report or trace (`.zip`) on the window, or open one with **Open with → Piwi Dashboard**, and
pick the project: it is imported as on the [import page](/guide/importing-runs), several traces forming one run. A
[`.piwibug`](/reference/bug-report-file) becomes a [bug report](./bug-reports).

## Connecting AI assistants

The app serves the [MCP server](/features/mcp) with three local tools a hosted instance cannot offer:
`import_local_report` (a local `.zip` into a project), `read_local_source` (the file on disk now) and `apply_locator_fix` (a recommended locator fix applied to the file, previewed by default). It registers as
`piwi-desktop`, beside a hosted Piwi in the same client.

The **MCP server** page detects Claude Code, Claude Desktop, Cursor, Opencode, VS Code, Windsurf and Gemini CLI, and
connects each in one click by writing a `piwi-desktop` entry, with the address and token, into the client's own config file.
It keeps a backup and rewrites only that entry, at each launch if the port changed. Claude Desktop, which takes only local
commands, is pointed at the app's built-in bridge (`piwi-desktop mcp-stdio`), so no token is copied; the app has to be
running for it. Restart the client after connecting. The page also installs the
[agent skills](/features/agent-skills) into a linked folder.

## Updates

**Settings → About → Updates** checks for a newer release, downloads it and applies it on restart, and checks at
startup unless turned off. The `.exe` updates silently, without admin rights; the `.msi` asks for them. Downloads are verified against the project's signing
key; a dev build without it says so.

## Limits

- **One machine, one user.** The app accepts results only from this machine; a team needs the
  [Docker image](/operate/deployment).
- **Local runs need the checkout**: a linked folder with Playwright installed, and `git` for reproduce, bisect and
  the lab.

## Related

- [Reporter](/guide/reporter#finding-the-desktop-app-automatically): how the reporter finds the app
- [MCP server](/features/mcp): the tools the assistants get
- [Fix plans, reproduce & bisect](/features/fix-plans): the recipes the app runs
- [Importing runs](/guide/importing-runs): the same import from the dashboard
