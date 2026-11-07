---
title: Run on my machine
description: "Ask the desktop app on your own machine to run Playwright tests from the dashboard: who may ask, how an administrator turns it on, Connected apps, and why a requested run is yours alone."
lang: en-US
---

# Run on my machine

<Needs desktop admin />

Run on my machine lets a signed-in person ask the desktop app on their own machine to run tests they found on the
dashboard. The instance carries the request; the app asks them before every run, in its own window, and runs the tests
in their own folder. The run it starts reports back to the instance as a **requested run**: theirs alone, and kept
out of everything the team sees.

## Experimental

**Experimental.** Run on my machine is off by default. The instance's side ships: turning it on, the requests and their
rules, the connection a desktop app holds, Connected apps, and the privacy of a requested run. The desktop app does not
take requests in this release, so nothing asks for a run from a page yet. The design is in the
[Run on my machine design record](https://github.com/PiwiTests/piwi/blob/main/proposals/run-on-my-machine.md).

## Turn it on

An administrator turns it on in **Settings → Capabilities → Off until turned on → Run on my machine → Turn on**, and
off the same way. It needs [sign-in](/operate/authentication) turned on: a request belongs to the person who made it,
so an instance without accounts refuses it. A project admin declines it for one project in **Project → Settings →
Capabilities**, which lists it while the instance has it on.

Turned off or declined, the instance refuses every request for that project, and a connected app receives none.

## Who may ask

- **Contributors and up** may ask (`run:request`), on the projects where they hold the role. A Contributor cannot
  submit a run with an API key; a requested run does not need to, since its app reports it with a credential that
  starts that one run.
- **Only a signed-in session** creates a request: never an API key, a CI job or an MCP client.
- **A request goes only to the person's own apps**, which take it only on projects where they may run tests.

## Connected apps

**Settings → Account → Connected apps** lists the apps you connected from their own window: Piwi Picker, an editor,
the desktop app, Piwi Runner. Each shows when it connected and, for an app that runs tests, **Online now** while it
holds its connection to the instance open and has called the instance within the last two minutes, or else when it
was last seen. **Revoke** disconnects one: the instance closes the connection of an app that runs tests at once, and
refuses its next call. An administrator sees the same list for any user in **Settings → Users → API keys**. The keys
these apps hold are not listed under API keys.

The instance sends a connected app each request as it is made, on that connection, with the time it stops waiting,
and the requests still waiting each time the app connects again. When a waiting request is stopped, or another of
your apps takes it, the instance tells the others to drop it. An app can also ask for its requests instead, where a
proxy cuts long connections.

## A requested run is yours alone

A requested run shows to the person who asked for it, and to nobody else:

- **Its own page** opens for you, and reads as not found for anyone else, as its executions, its attachments, its
  traces and its reports do.
- **The test's recent executions** list it for you, marked **On your machine**. The test's pass rate, flaky score and
  history leave it out.
- **No list a project's members read** shows it: the project's runs, search, analytics, the MCP tools.
- **With sign-in turned off, or once its requester is deleted**, nobody sees it.

It was run to look, on a branch and a machine the team did not choose, so it stays out of everything the team sees: no
failure clusters, flakiness, analytics or baselines; no notifications, pull-request comments or tracker writes; no
coverage, and it never sets the project's default branch. It is never kept forever: retention removes it, and you can
delete it yourself from its page.
Someone who holds `run:delete` on the project can delete it through the API without seeing it.

A [share link](./share-links) you make for one of its executions opens for whoever has the link, as any share link
does, so you can show a teammate what happened on your machine. It appears in the project's list of share links.

## One instance, one replica

Whether an app is online is held in the server's memory, as live run updates are. The instance runs as one replica, as
the [deployment page](/operate/deployment) requires.

## Related

- [Desktop app](./desktop): the app that takes requests
- [Desktop app runs](./desktop-runs): the runs the desktop app starts and how you follow them
- [Share links](./share-links): showing one execution to someone without an account
