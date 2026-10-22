---
title: Open in IDE
description: "Open any source path shown in the dashboard at its file and line in VS Code or JetBrains, and how to set up each method."
lang: en-US
---

# Open in IDE

<Needs reporter />

Every source path the dashboard shows is clickable: the failing call stack ("Failed here"), a run's test-case list, a
test case's file, flaky lists, cluster evidence, the AI suggested fix. Hover a path and a small **open in IDE** control
appears: click it to open that file, at its line, in your local editor, or open the chooser to pick a method.

The dashboard runs in your browser while the source lives on your machine, so the mapping from a repo-relative path
(`tests/checkout.spec.ts`) to a real file is set **per browser** and stored there.

## JetBrains IDEs: the Piwi plugin

With the [Piwi plugin](./jetbrains) installed in Rider, WebStorm, IntelliJ IDEA Ultimate or another JetBrains IDE,
clicking a path opens it there with **nothing to set up** once the project is connected to the instance the dashboard
belongs to:

- The dashboard asks every JetBrains IDE running, on its built-in server (ports 63342 to 63361). The IDE whose open
  project holds the file opens it at its line and brings its window to the front.
- The dashboard then shows **Opened in Rider** (or the IDE's name), or, when no open project holds the file, says so
  and lists the projects the IDE has open.
- The path, relative to the folder the tests ran in, is looked up under each Playwright config's folder in the
  project, the project folder and its content roots, so a Rider solution in a subfolder, or a monorepo, needs no
  workspace root and no project name. A workspace root, when set, is tried first; the file must still be in the
  project.
- When several IDEs hold the file, the one matching the **JetBrains product** you set wins; when several projects do,
  the one connected to the same Piwi project wins.

The IDE answers only a page of the Piwi instance one of its open projects is connected to (**Settings → Tools →
Piwi**, or `PIWI_DASHBOARD_URL` in the environment or the workspace `.env`), or of the [desktop app](./desktop.md) on
the same machine, and finds files only in the projects connected to that instance. A page from any other address,
another page on your machine included, gets no answer whatever the IDE's built-in server settings allow, and the first
address refused in an IDE session is named in a notification. When the dashboard you use is the project's instance
under another address, connect the project to that address.

## VS Code: the Piwi extension

With the [Piwi extension](./editors#install-and-connect) installed in VS Code, Cursor or VSCodium, a path opens there
with **no workspace root**: the dashboard hands the editor a `vscode://piwitests.piwi/open` link with the path as the
run reported it, and the extension looks for it under the folder of each Playwright config in the window, then the
workspace folders. It opens the file at its line and column, and never a file outside the workspace folders.

- The editor hands the link to its window **focused last**. When that window holds no such file, a warning there says
  so: focus the window of the project and click the path again.
- Like any URL scheme, the link reports nothing back: the dashboard shows **Asked the Piwi extension in VS Code**, and
  if nothing opens, the extension is not installed in the flavor you chose.
- With a workspace root, or a project's linked folder in the desktop app, the absolute path opens instead, through
  `vscode://file` or the desktop app's launcher (below).

## Set it up

1. Hover any source path and click the **⌄** caret, then **Configure…**, or open it from the user menu (bottom-left)
   → **Open in IDE…**.
2. For VS Code without the Piwi extension, or a JetBrains IDE without the Piwi plugin, set your **workspace root**: the
   absolute path of the folder the tests run from, such as `/home/me/my-repo` (or `C:\Users\me\my-repo` on Windows).
   Repo-relative paths are joined onto it. With the Piwi extension, leave it empty and keep **The Piwi extension is
   installed in VS Code** ticked, as it is by default.
3. Pick a **method**, or leave it on **Auto**. The **Test** row's **Open package.json** and **Open &lt;your Playwright
   config&gt;** open a known file with your current settings. In the desktop app, the config's file name is read from the linked folder; elsewhere it is `playwright.config.ts`.

## Methods

| Method | How it opens | Needs |
|--------|--------------|-------|
| **VS Code** | `vscode://file/<abs-path>:<line>` URL scheme with a workspace root; without one, the Piwi extension's `vscode://piwitests.piwi/open` link | A workspace root (for the absolute path), or the [Piwi extension](./editors#install-and-connect) in the editor. Flavors: VS Code, Insiders, VSCodium, Cursor. |
| **JetBrains (URL)** | The Piwi plugin, then `jetbrains://<product>/navigate/reference?project=<name>&path=<rel>:<line>` | Without the plugin: [JetBrains Toolbox](https://www.jetbrains.com/toolbox-app/), the IDE product tag (e.g. `idea`, `rider`) and the open project name (in Rider, the solution's name). |
| **JetBrains (local server)** | The Piwi plugin, then `http://localhost:63342/api/file/<path>:<line>` | Without the plugin: the IDE running with the **[IDE Remote Control](https://plugins.jetbrains.com/plugin/19991-ide-remote-control)** plugin and **Settings → Build → Debugger → "Allow unsigned requests"** enabled, which lets any page reach the IDE's local server. |
| **Auto** | The Piwi plugin, then the other methods in turn (see below) | Whatever the method that answers needs. |

### Desktop app: direct launch

In the [desktop app](./desktop.md), whatever method you pick, clicking a path first runs your IDE's **command-line
launcher**:

- VS Code family: `code --goto <file>:<line>:<column>` (or `cursor`, `codium`, `code-insiders`, matching the flavor
  you chose);
- JetBrains: `<product> --line <line> --column <column> <file>`, where `<product>` is the product tag you set
  (`rider`, `idea`, `webstorm`, …).

Unlike a URL scheme, it reports whether the launcher started, and flags a missing file. It needs a workspace root, or
the project's [linked folder](./desktop.md), which stands in for it. The app finds the launcher on your
`PATH`, then where the IDEs install it, since an app started from the Dock or the Start menu does not see the `PATH`
your shell sets:

- **Windows:** the Toolbox scripts folder, then the IDE's `bin` folder under `%LOCALAPPDATA%\Programs` or
  `C:\Program Files\JetBrains`, newest version first; VS Code's `bin` folder.
- **macOS:** the Toolbox scripts folder, `/usr/local/bin`, `/opt/homebrew/bin`, then the app bundles in
  `/Applications` and `~/Applications`.
- **Linux:** the Toolbox scripts folder, `~/.local/bin`, `/usr/local/bin`, `/usr/bin`, `/snap/bin`, then
  `/opt/<IDE>/bin`.

When no launcher is found, the app falls back to the URL scheme of the chosen method.

### Auto: the first method that works

Only the **Piwi plugin** can confirm the file opened. The IDE Remote Control server cannot, and the URL schemes are
handed to the operating system with **no success signal** but the browser's own "Open &lt;app&gt;?" prompt. **Auto**
tries, in order:

1. The Piwi plugin in any JetBrains IDE running. If an IDE answers that none of its open projects holds the file,
   Auto says so rather than launch another editor.
2. In the desktop app, the command-line launchers: JetBrains first when a JetBrains IDE is running, VS Code first
   otherwise.
3. The IDE Remote Control local server, reported as **Sent to JetBrains**, not as opened.
4. A single URL scheme: VS Code when a workspace root is set, otherwise `jetbrains://` when a JetBrains project name
   is set, otherwise the Piwi extension in VS Code while **The Piwi extension is installed in VS Code** is ticked,
   reported as "opening…" or "asked".

If you only use one editor, set the method explicitly to skip the other steps.

::: warning HTTPS and the IDE on localhost
The Piwi plugin and the local server are reached on `http://127.0.0.1` or `http://localhost`. When the dashboard is
served over **HTTPS** from another address, some browsers block that request as mixed content, and recent Chrome
versions ask once for permission to reach apps on your device. These two methods work best with the dashboard on
**http / localhost**, or in the desktop app; over HTTPS, Auto still falls back to the URL schemes.
:::

## Per-project overrides

If you view several projects that live in different local checkouts (or a monorepo), open **Configure…** from a path
inside that project: the dialog then offers a **workspace root override** and a **JetBrains project name** for that
project alone. Everything else falls back to your global settings. The Piwi plugin needs neither.

## Privacy

The method, workspace roots, editor flavor and JetBrains product and port live in your browser's `localStorage` under
`piwi-ide-prefs`. Nothing about your local filesystem is sent to the Piwi server. The Piwi plugin is asked from your
browser directly, on your own machine, with the file path, the workspace root and the Piwi project's name; the Piwi
extension's link carries the file path and line to VS Code through your operating system. Neither goes anywhere else.

## Related

- [Editor extensions](./editors): Piwi's answers inside VS Code and the JetBrains IDEs.
- [JetBrains plugin](./jetbrains): what the plugin needs, and where it shows what.
