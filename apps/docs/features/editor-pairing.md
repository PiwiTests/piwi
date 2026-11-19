---
title: Piwi Picker and your editor
description: 'How Piwi Picker pairs with the VS Code and JetBrains windows on your machine for Send to editor and the Runs window: Pair and a code to allow, the pairing panel, the proof asked before any token goes, and what it says when one does not answer.'
lang: en-US
---

# Piwi Picker and your editor

<Needs extension editor />

[Send to editor](./editor-recording#send-from-piwi-picker) and the [Runs window](./runs-window) reach your editor
through one pairing. The desktop app has a pairing of its own, which the Runs window follows beside it
([the desktop app's runs](./runs-window#the-desktop-app-s-runs)).

## Pair

1. In Piwi Picker's settings, under **Editor**, click Piwi Picker's **Pair**. It asks the ports the editors of this
   computer listen on which editor answers there, VS Code on 7247 to 7251 and a JetBrains IDE's built-in server on
   63342 to 63361, and lists them when it finds more than one. The browser asks once for access to `127.0.0.1`;
   Piwi Picker gives back the ports it did not pair with.
2. Piwi Picker shows a code, and the editor shows the request: Piwi Picker in your browser asks to pair. Click **Type
   the code…** in the editor's notification or in its pairing panel and type the code Piwi Picker shows; deny a
   request you did not make. The editor hands over the pairing's token with a proof of the code typed, and Piwi
   Picker keeps it only when the proof is of its own code: a program that answers on an editor's port never sees the
   code, so it cannot pair itself.

**Piwi: Pair with Piwi Picker** (**Tools → Piwi → Pair with Piwi Picker** in a JetBrains IDE, also in the status bar
item's menu) opens the pairing panel. A request nobody answers expires after five minutes; a new Pair takes the place
of the one before, an extension denied waits a minute before it asks again, and an editor holds three at once at
most. VS Code windows listen where Piwi Picker looks once Piwi starts; a second window of the same editor leaves the
port to the first.

Without a code, the editor's **Piwi: Copy the pairing address for Piwi Picker** copies `http://127.0.0.1:<port>/…#<token>`,
which Piwi Picker's **Pair with an address** takes. That is the way for a remote window, which Piwi Picker does not
find on its own: [Remote development](/guide/remote-development).

Every test run Piwi starts gets the pairing address and token as `PIWI_EDITOR_SEND`, so a locator picked at one of its
stops reaches the editor: such a run starts the listener and creates the token if there is none. The capture fixtures
hide it from the processes a test starts; the Playwright runner and its `webServer` still have it, and programs
running as your user are not kept out.

## The pairing panel

The editor shows the pairing in a panel of its own: the **Piwi Picker** view of the Piwi panel in VS Code, the
**Piwi Picker** tab of the Piwi tool window in a JetBrains IDE. It lists a request that waits, with **Type the
code…** and **Deny**; once paired, the browser it is paired with and since when, when Piwi Picker was last heard from (it asks for
the runs while its Runs window is open), and the port it reaches the editor on. Not paired, it says how to pair.

**Unpair** there (**Piwi: Unpair Piwi Picker**) gives the editor a new token, after asking: Piwi Picker, and any run
started before, reach it again only once paired again. The connections to the runs Piwi Picker holds already last
until the editor service restarts. In VS Code, a window that kept the port of an earlier pairing
outside 7247 to 7251 moves to one of them.

## What the pairing reaches

The editor listens on the loopback interface only, answers only a request addressed to `127.0.0.1` or `localhost` at
its port, and accepts one only with the token. Before Piwi Picker sends the token, the editor proves it holds it, so
another program that took the port is sent nothing; the settings ask for that proof as they open and after
**Pair**. With several VS Code windows open, the one holding the paired port receives; when it closes, another open
window takes the port within seconds, unless every other one already listens on a port of its own for a run it
started meanwhile.

Piwi Picker's background worker reaches the editor's services on `127.0.0.1` only once the paired port proves it holds
the pairing's token ([how the pieces connect](./editor-run-control#how-it-works)), as the desktop app proves it holds
its own. The Runs window talks to that worker alone, and makes no network call of its own. An older editor extension
gives the image and the controls alone.

## Windows that open and close

An editor window you open later shows in the Runs window within seconds: each window's service names the others,
without their tokens, and the worker asks the paired editor for them. While the Runs window is open, it also asks
every minute. A run whose window stops answering stays listed, grayed and as last heard, until that window answers
again, ten minutes at most, and a stop's **Watch** starts again then.

## When the editor does not answer

A line under the Runs window's title says how each paired tool stands, a broken pairing included, with **Look again**
or **Open the settings** where its sentence needs them. When the paired port answers without proving it holds the
token, the worker asks a few times more, then once a minute while the Runs window is open: click Piwi Picker's
**Pair** again if the editor moved to another port. One that answers with no proof and no such page is not
your editor's Piwi extension. While no window of a paired tool answers, the popup's **Runs** tile stays, muted, and
the Runs window says why.

## Related

- [Runs window](./runs-window): the runs it follows, and their controls.
- [Record tests from the editor](./editor-recording#send-from-piwi-picker): what Send to editor inserts.
- [Remote development](/guide/remote-development): the pairing address of a remote window.
- [Browser extension](./extension): Piwi Picker's other tools, and its permissions.
