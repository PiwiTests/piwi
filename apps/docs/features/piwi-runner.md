---
title: Piwi Runner
description: 'Piwi Runner takes Run on my machine requests from a team instance without the dashboard: where to get it, how it installs beside the desktop app, and how it stays in the tray.'
lang: en-US
---

# Piwi Runner

<Needs admin />

Piwi Runner takes [Run on my machine](./run-on-my-machine) requests from one team instance, without the dashboard:
one window for the connection, the confirmation of each request and the runs it started. It is for a machine that only
runs what the instance asks, where the [desktop app](./desktop) and its local dashboard are more than needed. It
keeps no database and serves no dashboard.

## Where it is

<DownloadApps app="runner" />

Its installers are of the same kinds as the desktop app's, for the same systems, with the same needs and the same
unsigned first start: [the desktop app's installers](./desktop#where-it-is).

## Updates

Piwi Runner checks the latest release when it starts, and a notification says when a newer version is out. **Check for
updates…** in the system tray menu checks again; when one is found, **Install and restart** downloads it, checks its
signature, installs it the way it was installed (`.exe`, `.msi`, `.dmg`, `.AppImage`, `.deb` or `.rpm`) and starts
the new version, after asking to stop the runs still going. Your connection and linked folders stay. A new release's
Piwi Runner files can reach the release a few minutes after the desktop app's; until then the check finds nothing new
or fails, and the next one finds them. On a desktop that shows no tray icon, install a new version from the latest release over
the old one.

## Piwi Runner or the desktop app

You need one of the two, not both. The desktop app takes the same requests, with the same confirmation and checks,
and adds the dashboard on your machine; a requested run can be paused, stepped and watched from either window.
Piwi Runner is for a machine that only runs what the instance asks.

Installed together, they live side by side, and neither installer replaces the other: each has its own name, install
folder, Linux package, settings, linked folders and keychain entry. Connected to the same instance, both are listed in
**Connected apps**, and a request goes to the one you pick on the page.

## Connect it

Its window connects to an instance the way the desktop app does: enter the instance's address and click **Connect**,
then allow **Piwi Runner** on the instance's page with the code the window shows. Its key stays in the operating
system's keychain. Each project's folder is linked on the first request for it. The rest, from the confirmation to
**Stop**, is described in [Run on my machine](./run-on-my-machine#in-the-app).

## Pause and watch a run

Each run Piwi Runner starts shows in its window live, as the desktop app's runs show in its
[Local runs tray](./desktop-runs): each worker's test and where it stands, **Pause**, **Step**, **Resume** and
**Finish**, **Pause all** and **Resume all**, and the stopped test's page, live with **Watch**. A `page.pause()`,
a step or a breakpoint waits in the window until you answer it, and the window comes to the front. [**Hold failures**](./watch-a-run#hold-failures),
a switch on each running run you attend, off until you turn it on, keeps a failing test at its line too, until you
resume it. Once the run reported to the
instance, its card names it, **Run #78 · Open**, which opens its page there, and keeps it after the run ended. A run
that goes on while the window reloads shows again, with **Stop**.
**Assert a region** and **Mock a request** make their code in the window, to copy: Piwi Runner has no editor and
writes no file. A requested run cannot be [shared live](./share-live): the instance gives it no live view key, since it
[shows to you alone](./run-on-my-machine#a-requested-run-is-yours-alone). **Inspect** of a watched worker, which reads the test's pages from its trace, is the desktop app's alone.

Piwi Runner is the hub of its own runs only: Piwi Picker, the editors and an agent reach the runs the desktop app or an
editor starts, not Piwi Runner's.

## In the tray

Closing the window leaves Piwi Runner in the system tray, still connected, so the instance can reach it; a request brings the
window forward. The tray menu has:

- **Open Piwi Runner** (on Windows and macOS, a click on the icon does the same) and **Show logs**;
- **Run in background**, on by default: turned off, closing the window quits the app, once you agree to stop the runs
  still going;
- **Start on login**, which launches it in the tray when you sign in;
- **Check for updates…**;
- **Quit Piwi Runner**, which stops its runs, after asking.

The window has the same two settings, for a desktop that shows no tray icon (GNOME without an AppIndicator
extension): turn **Keep running in the tray when the window closes** off there, and closing the window quits.

Its icon is the Piwi mark on a teal tile with a play sign, so it reads apart from the desktop app's in the tray and the
taskbar.

## Related

- [Run on my machine](./run-on-my-machine): who may ask, how an administrator turns it on, and what a request holds
- [Desktop app](./desktop): the other app that takes requests, with a local dashboard
