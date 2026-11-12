---
title: Share a run live
description: "Let a teammate watch the tests of a Playwright run on your machine from its page on the team instance, as a CI run's live view: Share live from VS Code, a JetBrains IDE, Piwi Picker's Runs window or the desktop app."
lang: en-US
---

# Share a run live

<Needs reporter fixtures />

A run on your machine sends the team instance nothing of its pages until you share it. Shared, it gets the
[live view](./live-view) a CI run gets: a teammate opens its page and watches each worker, and its stops show on its
rows. Sharing changes nothing for the run itself, and stops as you choose, or as the tool that shared it closes.

## Share and stop

Choose **Share live** while a local run executes to let a teammate watch it. The run must report to a team instance
whose project enables live view, and connect to an editor or the desktop app for controls.

| Where | Share | Stop |
|---|---|---|
| VS Code | **Piwi: Share the run live on the team instance**, or the status bar's broadcast icon | **Piwi: Stop sharing the run live**, or the status bar's **Live** |
| JetBrains IDEs | **Tools → Piwi → Share the Run Live** | **Tools → Piwi → Stop Sharing the Run Live** |
| Piwi Picker's [Runs window](./runs-window) | **Share live** under the run's name | **Stop sharing** |
| The desktop app's [Local runs tray](./desktop-runs) | **Share live** above the run's workers | **Stop sharing** |

The first share asks for confirmation; in an editor, it also asks whether to share this run or
[the window's runs](#a-window-s-runs). The shared run shows its destination, viewer count and a link to copy.

Until then, its workers send nothing, and the run's **Tests** tab says **Not shared live** once, beside its search,
with [**Ask to watch**](#ask-to-watch) for a teammate who may ask; its running tests say where they
[stopped](#stops-shared-or-not). Once shared, images go only to those watching. **Stop sharing** closes the views
within seconds. Closing the editor or the desktop app stops it too.

A run that cannot be shared says why: it reports to no instance or to the desktop app, it does not stream its results,
its project has the live view off, the reporter's global setup did not register it, or the instance did not register the run
as it started. A sharing that stops on its own says why (the live view turned off, or the instance stopped answering), and **Share live** shows again: shared again, the run streams once the instance answers with its live view
on, a restarted instance taking the run's key back. A run the instance no longer holds live cannot be shared again.

### From a terminal

A run you start in a terminal that no editor or app follows has no **Share live** to choose: set `PIWI_SHARE_LIVE=1`
to share it from its start. The reporter prints what goes out and where before any image does, or why the run cannot
be shared. A tool that follows the run can still stop it.

::: code-group

```bash [Linux / macOS]
PIWI_SHARE_LIVE=1 npx playwright test
```

```powershell [Windows (PowerShell)]
$env:PIWI_SHARE_LIVE='1'; npx playwright test
```

:::

### A window's runs

**Piwi: Share this window's runs live until I stop** in VS Code, and **Tools → Piwi → Share This Project's Runs Live
Until I Stop** in a JetBrains IDE, share each run the window starts from then on, each one said as it is shared, until
you stop (**…Stop sharing this window's runs live**, or a click on the status bar's **Live · this window**) or close
the window. On the team instance, the page of the run before says **Continued in run #78**, linked, and a teammate who
has it open is taken to the new run, on the worker they were watching.

## Ask to watch

A teammate who opens a running run of yours that is not shared can ask you to share it: **Ask to watch**, beside
**Not shared live**. The tool you launched the run from asks you, naming the person who asks, and offers
**Share live** and **Not now**; a run that no tool follows prints the ask in its terminal. Their page shows your answer:
**Asked to watch** while it waits, **The developer answered Not now**, or the live view once you share.

- **Who** — anyone signed in who may open the run. With sign-in off on the instance, nobody is named, and asking is
  not offered.
- **How often** — one ask per person and run every 5 minutes; their page says when they may ask again.
- **Which runs** — a running run from a developer's machine that holds a live view key, never a CI run, whose
  workers stream as they start.
- **Turn it off** — a Project admin turns off **Let signed-in readers ask to watch a run nobody shares** in the
  project's **Live view** settings; it is on by default. Turning it off, or the live view, drops the asks that wait.

Asks are kept in the instance's memory, never stored, and end with the run.

## Stops, shared or not

A test of a run on your machine stops at a breakpoint, a `page.pause()`, a step or **Run to here**, and its row on the
run's page says why, at the stopped call: **Stopped at a breakpoint**, **Stopped at page.pause()**, **Paused**. The
call's place opens in your editor. A shared run's row tells it from its live view. A run nobody shares tells it as
text, with `@piwitests/reporter` 0.68.0 or later, and says for how long once the stop has stood a minute: its results
stream sends the call's title, its file and line, the test's title and since when, as each stop shows and ends. Never
an image. A test that stands stopped is never marked [**Stuck?**](./stuck-tests).

## From the desktop app

A **Re-run** in a folder whose `.env` or Playwright config names your team's instance reports to it, and can be
shared: **Share live**, above the run's workers, asks first the first time since the app started.

A run that reports to the [desktop app](./desktop-runs) itself (a reproduction, a bisect, a **Re-run** in a folder
that names no instance, a run your editor started) cannot be shared: the app hands out no live view key, since no
teammate reaches it. Its tray offers no **Share live** for it, the app's project settings have no **Live view**
section, and on the run's page its running tests offer [**Watch** and **Pause and watch**](./desktop-runs#watch-live),
shown in the app's tray from the app itself. A run your editor started says **See its page at a stop** there: its page
shows where the editor steers it.

## Related

- [Live view of a run](./live-view): what a teammate sees, what is sent and what is kept
- [Editor run control](./editor-run-control): the controls of a run your editor starts
- [Runs window](./runs-window): Piwi Picker's view of your runs
- [Desktop app runs](./desktop-runs): the desktop app's runs and its tray
