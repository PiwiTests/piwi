---
title: Guides
description: "Step-by-step walkthroughs of common tasks on your own dashboard, from reporting a first run to the Flake Lab, opened from the command palette, with no AI model."
lang: en-US
---

# Guides

<Needs reporter />

A guide walks you through one task on your own dashboard: a popover on each part of the screens the task uses, in
order, each with a link to the docs page that explains it. The guides are written in advance, so they need no AI model
and work on every instance, the same way each time.

## Opening a guide

Open the command palette (`Ctrl` + `K`, `⌘` + `K` on macOS) and pick a guide under **Guides**, or type the task: a
guide is also found by words such as *ollama*, *slack* or *selector*. The [assistant](./assistant) panel lists them too
when its conversation is empty, and when no AI model is configured; starting one closes the panel.

**Next** and **Back** move between the stops, opening the page each one is on. **×** or `Esc` ends the guide, and so
does going to another page yourself. While a stop shows, the part it points at cannot be clicked: a guide shows the
dashboard and changes nothing.

## The guides

| Guide | What it shows | Listed for |
|---|---|---|
| **Report a first run** | Install the reporter, send a run, and find it in its project | Administrators |
| **Configure AI** | Choose the models behind diagnosis and the assistant | Administrators |
| **Add the SCM token** | Let Piwi read the commits behind a failure | Project admins |
| **Set up CI and sharding** | Report from CI, merge shards into one run, re-run from a cluster | Administrators |
| **Turn on pull-request feedback** | Post each run's result on its pull request | Administrators |
| **Connect Jira** | File issues from failures and keep them in sync | Administrators |
| **Set up notifications** | Send failures to email, Slack, Teams or a webhook | Everyone |
| **Grant roles and groups** | Add users, group them and give them project roles | Administrators |
| **Add the capture fixtures** | Record requests, console and Web Vitals from inside your tests | Everyone |
| **Connect an MCP client** | Let Claude Code, Cursor or VS Code read your results | Everyone |
| **Schedule a quality report** | Send a dashboard's report on a cadence, and keep each one | Contributors and up |
| **Run the Flake Lab** | Make a flaky test fail on demand, then prove the fix | Everyone |
| **Apply a locator fix** | Replace a broken locator with the one healing recommends | Everyone |
| **Build a dashboard** | Save the widgets and filters a team watches | Everyone |
| **Set retention** | See what runs take up, delete old ones, keep the ones that matter | Administrators |

A guide about a capability your instance declined on the Setup page ([Choose what you
use](/operate/capabilities#declining-a-capability)) is not listed. With authentication off, every guide is listed for
everyone, as every page is.

## On your own data

A stop on the page of a project, a run, an execution, a failure cluster or a test opens one of yours, which the guide
finds as it starts: the project updated last, the newest finished run, a failure of the newest failed run, the open
cluster seen last, the flakiest test, or the first saved dashboard you can edit. When your instance holds none yet,
such as no saved dashboard, the stop shows in the middle of the screen instead, with a line saying when that part of
the page appears.

The guides walk the dashboard's own screens. For the work done elsewhere, in your Playwright project or your CI, a
stop shows the screen with the command or the setting, and its docs link has the rest.

## Related

- [Assistant](./assistant): answers questions, and shows its answer on your screens with **Show me**
- [UI overview](./ui-overview): a map of every page a guide visits
- [Keyboard shortcuts](/reference/keyboard-shortcuts): the command palette and the go-to keys
