---
title: Editor connection
description: "Connect the Piwi extension for VS Code or the JetBrains plugin to your instance: the connection the reporter already uses, a browser sign-in that creates an API key for the editor, or the desktop app running on your machine, beside a shared instance."
lang: en-US
---

# Editor connection

The [editor extensions](./editors) read everything from your Piwi instance. They find it in this order, and the first
that names an instance wins:

1. the [desktop app](/features/desktop), while it runs, when you chose it with **Piwi: Connect** on this machine;
2. `PIWI_DASHBOARD_URL`, `PIWI_API_KEY` and `PIWI_PROJECT_NAME` in the environment the editor was started with;
3. the same variables in the `.env` next to the Playwright config, then at the repository root (a URL there takes only
   its own key);
4. the instance saved with **Piwi: Connect**;
5. the desktop app, while it runs.

A project set up for the reporter needs nothing more. An editor started from the Dock or the Start menu may not see
the variables your shell exports: the `.env` or Connect work either way.

## With the desktop app

The desktop app needs no pairing with the editor: while it runs, it publishes its address and a local token in
`~/.piwi/desktop.json`, which the editor reads, as the reporter does. The editor notices within seconds when the app
starts or quits. With nothing else naming an instance, the editor uses the app as soon as it runs.

### Beside a shared instance

When the environment, a `.env` or Connect names your team's instance, the desktop app sits beside it rather than
replacing it. Run **Piwi: Connect**: it lists the desktop app, the instance the workspace names, and **Another
instance**, and marks the one in use. Choose **The Piwi desktop app**, and the editor reads the app first while it
runs, then the shared instance again when the app quits. Choosing the shared instance in the same list switches back;
its address, project and key stay saved throughout.

The choice is kept on your machine only (VS Code's workspace state, `.idea/workspace.xml` in a JetBrains IDE), never
in a file the team shares. In a JetBrains IDE, **Settings → Tools → Piwi** shows it too, as **Read this project from
the desktop app while it runs**. When the app starts while the editor reads another instance, the editor offers the
switch once per workspace.

### The project

With the app chosen, the project is the one picked with Connect, else the one whose **linked folder** holds the
workspace's Playwright config (link the folder on the project's page in the desktop app), else `PIWI_PROJECT_NAME`.
When the app is used because nothing else names an instance, `PIWI_PROJECT_NAME` comes first, since the reporter
sends its runs there under that name too.

## Connect

Run **Piwi: Connect** from the command palette, or click **Piwi: connect** in the status bar. In a JetBrains IDE it is
the **Connect…** button of **Settings → Tools → Piwi**, in the **Piwi** tool window's toolbar, and under
**Tools → Piwi**.

1. When the desktop app runs, Connect lists it first, with the instance the workspace already names: choose
   **The Piwi desktop app**, and pick the project if none is linked to the folder, or choose the instance to switch
   back to it. Otherwise, or with **Another instance**, give the instance's address, such as
   `https://piwi.example.com`.
2. When the instance has a login, choose **Sign in with the browser**. The instance's page opens with a code: check
   that the editor shows the same code, then click **Allow**. The editor receives an [API key](/operate/api-keys)
   created for you and named after it, such as "Piwi in WebStorm on macOS", which you can revoke with your other keys.
   Or paste a key you created yourself. An instance without a login needs no key.
3. Pick the project.

When the environment or a `.env` names another instance, Connect saves your choice and says which source comes first.
In a JetBrains IDE, an instance on your machine is reached at `localhost`, `127.0.0.1` or `[::1]`, whichever it
listens on: Connect tries all three and saves the one that answered.

## What is saved where

| | VS Code | JetBrains IDEs |
|---|---|---|
| Address and project | `piwi.serverUrl` and `piwi.project` in the workspace settings | `.idea/piwi.xml` |
| The desktop app chosen, and its project | The workspace state, on this machine only | `.idea/workspace.xml`, on this machine only |
| API key | The editor's secret storage | The IDE's password safe |

The address and the project can be shared with the team. The key never goes to a file, and is saved for its instance
only: a repository whose settings name another instance never receives it. **Piwi: Disconnect** (the **Disconnect**
button in a JetBrains IDE) forgets the address, the project, that instance's key and the choice of the desktop app.

## Which connection is in use

The status bar's tooltip names the instance and where it came from, and says when the desktop app runs while another
instance is in use, or was chosen and is not running. In a JetBrains IDE, **Settings → Tools → Piwi** and the **Piwi**
tool window say the same, or why the editor is not connected. The plugin starts its service when you
open a file of a project that holds a Playwright config; until then, both say so, and Connect still finds the desktop
app.

## An unreachable instance

When the instance does not answer, or answers with an error, the status bar reads **Piwi: unreachable** instead of
**Piwi: connect**: the connection is kept, and the editor reads the instance again on its own, 15 seconds later, then
twice as long each time, up to every five minutes. A click on the item, or **Piwi: Refresh**, reads it at once. A key
the instance refuses still reads **Piwi: connect**, since only signing in again helps.

**Piwi: Open settings** in VS Code opens the extension's settings.
