---
title: Piwi Runner
description: 'Take Run on my machine requests on a machine that has no dashboard: the small Piwi Runner window that connects to a team instance, asks before every run and shows the runs it started.'
lang: en-US
---

# Piwi Runner

<Needs admin />

Piwi Runner is the small app for a machine that takes [Run on my machine](./run-on-my-machine) requests and nothing
else: no dashboard, no database and no account of its own. Its single window holds the connection to a team instance,
the confirmation of each request and the runs it started, each with its output and **Stop** while it goes on. The
confirmation, its checks and its words are the [desktop app](./desktop)'s, and so are the rules.

## Experimental

**Experimental.** It takes requests only while an administrator has turned **Run on my machine** on, which is off by
default. Piwi Runner is built from `apps/runner`. The design is in the
[Run on my machine design record](https://github.com/PiwiTests/piwi/blob/main/proposals/run-on-my-machine.md).

## Connect it

Enter the instance's address and click **Connect**. The instance's page asks you to allow the app with the code the
window shows. Once allowed, the app keeps its key in the operating system's keychain under its own entry, "Piwi Runner
run requests", never in a file. It connects to one instance at a time, and the desktop app, which keeps its own entry,
connects and disconnects on its own.

The instance asks you to allow **Piwi Desktop**, and lists the key under that name in **Connected apps**: Piwi Runner
connects as the same kind of run target as the desktop app.

A `piwi://connect` link brings the window to the front and connects nothing: the address is typed in the window. Any
other `piwi://` link is ignored.

## Run a request

A request opens the confirmation in the window: the instance that asked, the tests, the checks of the linked folder and
the exact command. The first request for a project asks for its folder, which is linked on this machine, per instance.
Nothing runs until you click **Run**, and a request nobody answers within 10 minutes ends.

The run reports to the instance as a requested run, which only you can see, as the
[requested-run rules](./run-on-my-machine#a-requested-run-is-yours-alone) say. The window lists it with its output until
you close it.

## What it leaves out

Piwi Runner has no tray, no updates, no MCP server, no Flake Lab, reproduce or bisect. It does not write the file the
reporter and the editors read to find a local dashboard (`~/.piwi/desktop.json`), so none of them takes it for one.

## Related

- [Run on my machine](./run-on-my-machine): who may ask, how an administrator turns it on, Connected apps
- [Desktop app](./desktop): the app with the dashboard, which takes the same requests
