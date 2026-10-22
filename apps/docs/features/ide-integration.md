---
title: Open in IDE
description: "Open any source path shown in the dashboard at its file and line in VS Code or JetBrains, and how to set up each method."
lang: en-US
---

# Open in IDE

<Needs reporter />

Every source path the dashboard shows — the failing call stack ("Failed here"), a
run's test-case list, a test case's file, flaky lists, cluster evidence, the AI
suggested-fix — is clickable. Hover a path and a small **open in IDE** control
appears: click it to jump straight to that file (and line) in your local editor,
or open the chooser to pick a specific method.

Because the dashboard runs in your browser while the source lives on your
machine, the mapping from a repo-relative path (`tests/checkout.spec.ts`) to a
real file is configured **per browser** and stored locally — it is never sent to
the server.

To see Piwi's answers inside the editor instead — CI failures at their lines, the
tests behind each locator, the heal as a quick fix — install the
[editor extension](/features/editors).

## JetBrains IDEs: the Piwi plugin

With the [Piwi plugin](./editors#jetbrains-ides) installed in Rider, WebStorm,
IntelliJ IDEA Ultimate or another JetBrains IDE (from **Settings → Plugins**, or
**[the JetBrains Marketplace ↗](https://plugins.jetbrains.com/plugin/34674-piwi)**),
clicking a path opens it there with **nothing to set up** once the project is
connected to the instance the dashboard belongs to (the reporter's `PIWI_*`
variables, **Settings → Tools → Piwi** or the desktop app):

- The dashboard asks every JetBrains IDE running, on its built-in server
  (ports 63342 to 63361: a second IDE running takes the next free port). The IDE
  whose open project holds the file opens it at its line and brings its window
  to the front.
- The dashboard then shows **Opened in Rider** (or the IDE's name), or, when no
  open project holds the file, says so and lists the projects the IDE has open.
  No other method can confirm the file opened.
- The path, relative to the folder the tests ran in, is looked up under the
  folder of each Playwright config in the project, the project folder and its
  content roots. So a Rider solution in a subfolder, or a Playwright project
  inside a monorepo, needs no workspace root and no project name. A workspace
  root, when you set one, is tried first; the file must still be inside the
  project.
- When several IDEs hold the file, the one matching the **JetBrains product**
  you set wins; when several projects do, the one connected to the same Piwi
  project wins.

The IDE answers only a page of the Piwi instance one of its open projects is
connected to (**Settings → Tools → Piwi**, or `PIWI_DASHBOARD_URL` in the
environment or the workspace `.env`), or of the [desktop app](./desktop.md)
running on the same machine; an instance's page finds files only in the projects
connected to it. A page from any other address, another page on your machine
included, gets no answer whatever the IDE's built-in server settings allow, and
the first address refused in an IDE session is named in a notification. When the dashboard you use is the project's instance under another
address, connect the project to that address.

## VS Code: the Piwi extension

With the [Piwi extension](./editors#install-and-connect) installed in VS Code, Cursor or
VSCodium, a path opens there with **no workspace root**: the dashboard hands the
editor a `vscode://piwitests.piwi/open` link with the path as the run reported
it, and the extension looks for it as it does for a failure's file: under the
folder of each Playwright config in the window, then the workspace folders. It
opens the file at its line and column, and never a file outside the workspace
folders.

- The editor hands the link to its window **focused last**. When that window
  holds no such file, a warning there says so: focus the window of the project
  and click the path again.
- Like any URL scheme, the link reports nothing back to the dashboard: it shows
  **Asked the Piwi extension in VS Code**, and if nothing opens, the extension
  is not installed in the flavor you chose.
- **Auto** uses it when no workspace root and no JetBrains project name is set,
  while **The Piwi extension is installed in VS Code** is ticked (the default).
- With a workspace root, or a project's linked folder in the desktop app, the
  absolute path opens instead, through `vscode://file` or the desktop app's
  launcher (below).

## Set it up

1. Hover any source path and click the **⌄** caret, then **Configure…** — or open
   it from the user menu (bottom-left) → **Open in IDE…**.
2. For VS Code without the Piwi extension, or a JetBrains IDE without the Piwi
   plugin, set your **workspace root**: the absolute path of the folder the
   tests run from, e.g. `/home/me/my-repo` (or `C:\Users\me\my-repo` on
   Windows). Repo-relative paths are joined onto it, which is what VS Code needs
   to resolve a file. With the Piwi extension, leave it empty and keep **The Piwi
   extension is installed in VS Code** ticked.
3. Pick a **method** (or leave it on **Auto**), then hit **Test** to open
   `package.json` and confirm it lands in your editor. Close the dialog —
   clicking any path now opens it there.

## Methods

| Method | How it opens | Needs |
|--------|--------------|-------|
| **VS Code** | `vscode://file/<abs-path>:<line>` URL scheme with a workspace root; without one, the Piwi extension: `vscode://piwitests.piwi/open?file=<path>&line=<line>&column=<column>` | A workspace root (for the absolute path), or the [Piwi extension](./editors#install-and-connect) in the editor. Flavors: VS Code, Insiders, VSCodium, Cursor. |
| **JetBrains (URL)** | The Piwi plugin, then `jetbrains://<product>/navigate/reference?project=<name>&path=<rel>:<line>` | Without the plugin: [JetBrains Toolbox](https://www.jetbrains.com/toolbox-app/), the IDE product tag (e.g. `idea`, `rider`) and the open project name (in Rider, the solution's name). |
| **JetBrains (local server)** | The Piwi plugin, then `http://localhost:63342/api/file/<path>:<line>` | Without the plugin: the IDE running with the **[IDE Remote Control](https://plugins.jetbrains.com/plugin/19991-ide-remote-control)** plugin and **Settings → Build → Debugger → "Allow unsigned requests"** enabled, which lets any page reach the IDE's local server. It cannot confirm the file opened. |
| **Auto** | The Piwi plugin, then the other methods in turn (see below) | Whatever the method that answers needs. |

### Desktop app — direct launch (most reliable)

In the [desktop app](./desktop.md) there is a better path than any URL scheme: the
shell runs your IDE's **command-line launcher** directly. Whatever method you
pick, clicking a path first tries the launcher —

- VS Code family: `code --goto <file>:<line>:<column>` (or `cursor`, `codium`,
  `code-insiders`, matching the flavor you chose);
- JetBrains: `<product> --line <line> --column <column> <file>`, where
  `<product>` is the product tag you set (`rider`, `idea`, `webstorm`, …).

This needs **no** `vscode://`/`jetbrains://` protocol handler, no JetBrains
Toolbox, no open-project name to match and no "allow unsigned requests" — the
reasons the URL schemes are unreliable, on Rider especially — and unlike a URL
scheme it reports back whether the launcher started (and flags a missing file).
It needs a workspace root or a linked project folder. The app finds the launcher
on your `PATH`, then where the IDEs install it, since an app started from the
Dock or the Start menu does not see the `PATH` your shell sets:

- **Windows:** the Toolbox scripts folder (`rider.cmd`), then the IDE's own
  `bin` folder (`rider64.exe`) under `%LOCALAPPDATA%\Programs` (a Toolbox or
  per-user install) or `C:\Program Files\JetBrains`, newest version first;
  `code.cmd` in VS Code's `bin` folder.
- **macOS:** the Toolbox scripts folder, `/usr/local/bin`, `/opt/homebrew/bin`,
  then the app bundles in `/Applications` and `~/Applications`
  (`Rider.app/Contents/MacOS/rider`, VS Code's `Contents/Resources/app/bin/code`).
- **Linux:** the Toolbox scripts folder, `~/.local/bin`, `/usr/local/bin`,
  `/usr/bin`, `/snap/bin`, then `/opt/<IDE>/bin` (`rider` or `rider.sh`).

When no matching launcher is found the desktop app falls back to the URL scheme
for the chosen method, so nothing regresses. On desktop, a project's
[linked folder](./desktop.md) also stands in for the workspace root, so files
open with zero extra setup.

### Auto — "try all, stop on first success"

Only the **Piwi plugin** can confirm the file opened: its answer is one the page
can read. The IDE Remote Control endpoint can be reached but its answer not read,
so the dashboard only knows an IDE is listening; the `vscode://` and
`jetbrains://` URL schemes are handed off to the operating system with **no
success signal** — the browser's own "Open &lt;app&gt;?" prompt is the only real
confirmation.

So **Auto** goes, stopping at the first that works:

1. The Piwi plugin in any JetBrains IDE running. If an IDE answers that none of
   its open projects holds the file, Auto says so rather than launch another
   editor.
2. In the desktop app, the command-line launchers: JetBrains first when a
   JetBrains IDE is running, VS Code first otherwise.
3. The IDE Remote Control local server, reported as **Sent to JetBrains**, not
   as opened.
4. A single URL scheme: VS Code when a workspace root is set, otherwise
   `jetbrains://` when a JetBrains project name is set, otherwise the Piwi
   extension in VS Code while **The Piwi extension is installed in VS Code** is
   ticked, reported as "opening…" or "asked".

If you only ever use one editor, set the method explicitly to skip the other
rungs.

::: warning HTTPS and the IDE on localhost
The Piwi plugin and the local server are reached on `http://127.0.0.1` /
`http://localhost`. When the dashboard is served over **HTTPS** from another
address, some browsers block that request as mixed content, and recent Chrome
versions ask once for permission to reach apps on your device. These two
methods therefore work best when the dashboard is served over **http /
localhost**, or in the desktop app. Over HTTPS, Auto still falls back to the URL
schemes, which are unaffected.
:::

## Test your setup

The **Configure…** dialog has a **Test** row with two buttons — **Open
package.json** and **Open &lt;your Playwright config&gt;** — that open a known
file with your current settings, so you can confirm files land in your editor
without hunting down a real failure first. On the desktop app the Playwright
config's real file name is read from the linked folder; elsewhere it defaults to
`playwright.config.ts`.

## Per-project overrides

If you view several projects that live in different local checkouts (or a
monorepo), open **Configure…** from a path inside that project — the dialog then
offers a **workspace root override** and a **JetBrains project name** just for
that project. Everything else falls back to your global settings. The Piwi
plugin needs neither: it finds the file in the IDE's open projects.

## Privacy

All of this — the method, workspace root(s), editor flavor and JetBrains
product/port — lives in your browser's `localStorage` under `piwi-ide-prefs`.
Nothing about your local filesystem is sent to the Piwi server. The Piwi plugin
is asked from your browser directly, on your own machine: the file path, the
workspace root and the Piwi project's name go to the IDE, nowhere else. The
Piwi extension's link carries the file path and line to VS Code through your
operating system, nowhere else.
