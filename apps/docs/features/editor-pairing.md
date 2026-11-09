---
title: Piwi Picker and your editor
description: 'How Piwi Picker reaches the VS Code and JetBrains windows on your machine for Send to editor and the Runs window: the pairing, the proof asked before any token goes, the windows found as they open, and what it says when one does not answer.'
lang: en-US
---

# Piwi Picker and your editor

<Needs extension />

[Send to editor](./editor-recording#send-from-piwi-picker) and the [Runs window](./runs-window) reach your editor
through one pairing: the address **Piwi: Pair with Piwi Picker** copies, pasted under **Send to editor** in Piwi
Picker's settings. The desktop app has a pairing of its own, which the Runs window follows beside it.

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
again, ten minutes at most, and a stop's **Watch live** starts again then.

## When the editor does not answer

A line under the Runs window's title says how each paired tool stands, a broken pairing included, with **Look again**
or **Open the settings** where its sentence needs them. When the paired port answers without proving it holds the
token, the worker asks a few times more, then once a minute while the Runs window is open: pair again from the settings
if the editor moved to another port. One that answers with no proof and no such page is not
your editor's Piwi extension. While no window of a paired tool answers, the popup's **Runs** tile stays, muted, and
the Runs window says why.

## Related

- [Runs window](./runs-window): the runs it follows, and their controls.
- [Record tests from the editor](./editor-recording#send-from-piwi-picker): pairing, and what Send to editor inserts.
- [Remote development](/guide/remote-development): the pairing address of a remote window.
- [Browser extension](./extension): Piwi Picker's other tools, and its permissions.
