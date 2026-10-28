---
title: Remote development
description: "Use the Piwi editor extensions in a remote VS Code window (Remote SSH, WSL, Dev Containers, Codespaces) or on a JetBrains Gateway backend, and reach their runs from Piwi Picker through a forwarded port."
lang: en-US
---

# Remote development

In remote development the editor's window is on your computer, while the code, the
[editor service](/features/editors) and the test runs are on another machine: a server over SSH, WSL, a dev container
or a codespace. What the editor shows from the service works there as it does on your computer: failures, runs,
[pausing and stepping](/features/editor-run-control), a headless stop's image and Pick on it,
[code from a pause](/features/editor-stop-code). [Piwi Picker](/features/extension) is the part that needs a word: it
runs in the browser on your computer and reaches the editor through a pairing address on the loopback interface,
which in remote development is the local end of a forwarded port.

## VS Code

In a remote window (Remote SSH, WSL, Dev Containers, or a codespace opened in VS Code desktop):

1. Run **Piwi: Pair with Piwi Picker** in that window. VS Code forwards the window's Send to editor port to your
   computer, on the same number when it is free there, and copies the local end on `127.0.0.1`, whatever name VS
   Code gives it: `http://127.0.0.1:<port>/piwi/send#<token>`.
2. Paste it in Piwi Picker's settings under **Send to editor** and click **Pair**.

Piwi Picker then sends locators and recordings to the remote window, and its
[Runs window](/features/runs-window) lists the runs that window starts, and shows a headless test's page live: when
Piwi Picker asks for them, VS Code forwards the port of the window's run hub too, and the hub accepts a connection on that local port once
the window has named it, which Piwi Picker reaches on `127.0.0.1` too. Both forwarded ports show in the **Ports** view. The pairing's token, the proof that the
editor holds it, and the browser extension's origin are checked as on your own computer.

One pairing reaches the runs of one window when it is remote, and of every local window when it is local: pair from
the window whose runs you follow. After the window reloads, VS Code forwards the pairing's port again; when it lands
on another local port, pair again.

### Codespaces in the browser

A codespace opened in a browser tab forwards ports to an `https://…app.github.dev` address behind GitHub's sign-in,
not to your computer's loopback interface. Piwi Picker pairs with a loopback address only, so neither Send to editor
nor the Runs window reaches a codespace in the browser: open it in VS Code desktop instead.

## JetBrains Gateway

A JetBrains Gateway backend runs the IDE, its built-in server and the editor service on the remote machine. The
platform offers plugins no supported way to forward a port to your computer, so you forward the ports yourself:

1. Run **Tools → Piwi → Pair with Piwi Picker** in the remote IDE. Besides copying the pairing address, its
   notification names the IDE's port (63342 by default) and the ports of the open projects' runs.
2. In the JetBrains Client, forward each of them under **Ports**, with the local port the same as the host port.
3. Paste the pairing address in Piwi Picker's settings under **Send to editor**.

The numbers must match: Piwi Picker checks the IDE's proof for the port it asked on, and a run's hub accepts its own
port alone. A project's run port changes when its editor service starts again (the IDE restarted, the project was
reopened): pair again, and forward the port the notification names.

## Related

- [Pause and step from the editor](/features/editor-run-control): the runs Piwi Picker follows.
- [Piwi Picker](/features/extension): the Runs window and Send to editor.
- [Record tests from the editor](/features/editor-recording#send-from-piwi-picker): pairing Piwi Picker with the
  editor.
- [Editor connection](/features/editor-connection): the instance and the desktop app a remote window reads.
