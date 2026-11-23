---
title: Piwi Runner
description: "Piwi Runner takes Run on my machine requests from a team instance without the dashboard: where to get it, how it installs beside the desktop app, and how it stays in the tray."
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
the new version, after asking to stop the runs still going. Your connection and linked folders stay. **Settings → About**
in its window shows the version installed and where the tray's update and log items are, with links to this page, the
release notes and the page to report a problem. A new release's Piwi Runner files can reach the release a few minutes after the desktop app's; until then the check finds nothing new
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

Until it is connected, its window opens on the instance's address, with the three steps from a test there to its run
here. It connects the way the desktop app does: enter the instance's address and click **Connect**, then allow **Piwi
Runner** on the instance's page with the code the window shows. Its key stays in the operating system's keychain.
Each project's folder is linked on the first request for it. The rest, from the confirmation to **Stop**, is described
in [Run on my machine](./run-on-my-machine#in-the-app).

Once connected, the top of the window says which instance it takes requests from, with a dot of its state: green while
connected, amber while it connects or the instance does not answer, when a line above the runs also says that its
requests reach the machine again once it answers. A click on it opens the connection's settings.

**Settings** shows a section at a time: **Connection** (the instance, a button that opens it in the browser, and
**Disconnect**, which asks first: connecting again means allowing Piwi Runner on the instance again), **Folders** (the
folder linked to each project, with **Unlink**: the next request for that project asks for its folder again),
**General** (the two background settings and the language) and **About**.

<figure>
  <img src="/screenshots/runner-settings.png" alt="Piwi Runner's Settings on its Connection section: the instance it is connected to, Open piwi.example.com, Disconnect, and the list of sections: Connection, Folders, General and About">
  <figcaption>Settings, on the Connection section; the header says which instance Piwi Runner takes requests from.</figcaption>
</figure>

## Pause and watch a run

Each run Piwi Runner starts shows in its window live, as the desktop app's runs show in its
[Local runs tray](./desktop-runs): each worker's test and where it stands, **Pause**, **Step**, **Resume** and
**Finish**, **Pause all** and **Resume all**, and the stopped test's page, live with **Watch**. A `page.pause()`,
a step or a breakpoint waits in the window until you answer it, and the window comes to the front, on its runs. [**Hold failures**](./watch-a-run#hold-failures),
a switch on each running run you attend, off until you turn it on, keeps a failing test at its line too, until you
resume it. Once the run reported to the instance, it shows **Run #78 · Open**, which opens its page there, and keeps
it after the run ended. A run that goes on while the window reloads shows again, with **Stop**.
**Assert a region** and **Mock a request** make their code in the window, to copy: Piwi Runner has no editor and
writes no file. A requested run cannot be [shared live](./share-live): the instance gives it no [live view](./live-view) key, since it
[shows to you alone](./run-on-my-machine#a-requested-run-is-yours-alone). **Inspect** of a watched worker, which reads the test's pages from its trace, is the desktop app's alone.

The runs show as the desktop app's [Local runs](./local-runs-tray) do: the list on the left, the run you pick on the
right, and a select that names it in a narrow window. **Running now** lists the runs going on and **Finished** those
that ended, the last to end first, each line saying how its run stands, whether a test of it waits at a stop, and how
long it ran. A run you confirm shows at once, and a test that stops shows its run, unless you are working in the run
shown. The run shown has its project, when it started and how long it has run, **Stop**, which gives way to
**Force stop** while the run winds down, as in the [desktop app](./local-runs-tray#each-run), its workers live, the
tests the request asked for and its output.

<figure>
  <img src="/screenshots/runner-runs.png" alt="Piwi Runner's runs: on the left, one run under Running now and two under Finished, one failed and one passed; on the right, the run going on, its worker running, with Pause, Watch, Hold failures and Stop">
  <figcaption>The run going on, shown beside the list, its worker live.</figcaption>
</figure>

Once a run ended, its tests say how each came out, as its output tells it, a failed one with the first lines of its
error, and it shows **Run #78 · Open** once it reported to the instance. The output keeps Playwright's colors and its
last 2,000 lines, with a filter, **Go to the first error** and **Copy output**, as the
[desktop app's](./local-runs-tray#its-output) does. **Clear finished** empties the Finished list; the window keeps the
last 15 runs that ended in any case, never dropping one the moment it ends.

<figure>
  <img src="/screenshots/runner-run-results.png" alt="Piwi Runner's runs with the run that failed shown: its two tests, one passed and one failed with its error, and its output in Playwright's colors">
  <figcaption>The run that failed: how each test came out, and its output.</figcaption>
</figure>

Piwi Runner is the hub of its own runs only: Piwi Picker, the editors and an agent reach the runs the desktop app or an
editor starts, not Piwi Runner's.

## In the tray

Closing the window leaves Piwi Runner in the system tray, still connected, so the instance can reach it; a request brings the
window forward. The tray menu has, with the [desktop app](./desktop)'s glyphs and in its order:

- **Open Piwi Runner** (on Windows and macOS, a click on the icon does the same);
- **Run in background**, on by default: turned off, closing the window quits the app, once you agree to stop the runs
  still going;
- **Start on login**, which launches it in the tray when you sign in;
- **Check for updates…** and **Show logs**;
- **Quit Piwi Runner**, which stops its runs, after asking.

The **General** section of the window's **Settings** has the same two settings, for a desktop that shows no tray icon (GNOME without an
AppIndicator extension): turn **Run in background** off there, and closing the window quits.

Its icon is the Piwi mark on a teal tile with a play sign, so it reads apart from the desktop app's in the tray and the
taskbar.

## Languages

Piwi Runner speaks English, French, German, Spanish and Brazilian Portuguese, in its window, its tray menu and its
questions: your system's language, or the one you choose in the **General** section of its window's **Settings**. German, Spanish and
Portuguese are drafts no native reader has reviewed yet: while one is on screen, a line says so and links to a form for
a correction. Test titles, files, commands and a run's output stay as they are, the reason a run could not start
included, and so do two answers of the runs' hub, where a locator picked on the image and a code made at a stop wait
to be copied. The start screen keeps the
language Runner started in until it starts again. The [desktop app](./desktop) stays in English.

## Related

- [Run on my machine](./run-on-my-machine): who may ask, how an administrator turns it on, and what a request holds
- [Desktop app](./desktop): the other app that takes requests, with a local dashboard
