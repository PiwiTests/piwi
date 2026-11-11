---
title: Run on my machine
description: 'Ask the desktop app on your own machine to run Playwright tests from the dashboard: who may ask, how an administrator turns it on, Connected apps, and why a requested run is yours alone.'
lang: en-US
---

# Run on my machine

<Needs desktop admin />

Run on my machine lets a signed-in person ask the desktop app on their own machine to run tests they found on the
dashboard. The instance carries the request; the app asks them before every run, in its own window, and runs the tests
in their own folder. The run it starts reports back to the instance as a **requested run**: theirs alone, and kept
out of everything the team sees.

## Experimental

**Experimental.** Run on my machine is off by default, and the desktop app is the one app that takes requests in this
release. The design is in the
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

## Connect the desktop app

In Piwi Desktop, open **Settings → Desktop app → Run on my machine**, enter the instance's address and click
**Connect**. The app opens the instance's page, which asks you to allow **Piwi Desktop** with the code the app shows.
Once allowed, the app keeps its key in the operating system's keychain (Keychain on macOS, Credential Manager on
Windows, the Secret Service on Linux), never in a file, and holds its connection to the instance open while it runs.
An app connects to one instance at a time. **Disconnect** removes the key from the keychain; the app stays listed in
the instance's Connected apps until you revoke it there. A key the instance revoked leaves the keychain too.

The folder of each project is linked on this machine, per instance: the first request for a project asks for it, and
**Settings → Desktop app** lists the linked folders, with **Unlink**.

## Ask for a run

**Run on my machine** shows on a run's page (its failed tests, or all of them), on an execution's page and on a test's
page (that test) while the capability is on for the project and you may ask there. Its window picks what runs, which of
your apps runs it, and the run options of **Copy retry command**: headed, trace, repeat each, workers and, when the
tests ran in more than one, the Playwright project. A request holds at most 200 tests; a test with no recorded line is
left out, and the window says how many. Nobody else's app receives it.

## In the app

The request opens the desktop app's window, in front: the instance that asked, the tests, the checks of the linked
folder, and the exact command. Nothing runs until you click **Run**:

- **The folder**: linked, with a Playwright config and `@playwright/test` installed, and every spec of the request
  inside it.
- **The commit**: the run's branch and commit against the folder's. On another commit, or with uncommitted changes, the
  tests are picked by their titles (`--grep`) rather than by their lines, which may have moved.

**Not now** declines it, or refuses it with the checks that failed, and the page says which. A request nobody answers
in the app within 10 minutes ends.

The app takes the command and a key for this one run from its own server, never from the page or the window. The run
reports to the instance that asked with that key, which starts one run within 30 minutes and nothing else, whatever
server the Playwright config names. It shows in the app's Local runs while it goes on.

## Follow and stop

Once sent, the same window follows the request: waiting for your app, shown in the app, running, ended with its
outcome, and a link to its run. **Stop** ends it from the page: the app stops the run, or drops a request it has not
run. **Run again** sends the same tests with the same options. **Settings → Account → Your runs on my machine** lists
your last 20 requests, with **Stop** for one still going on. Quitting the app stops its requested runs.

## What leaves your machine

The run's results, as any run reports them: the tests, their steps, errors, attachments, traces and reports, sent to
the instance that asked and seen by you alone. For a requested run, the reporter sends no coverage, test manifest,
code reach or environment details, AI steps only replay, and the run stays out of the desktop app's own dashboard. The
instance never keeps it forever.

The app starts the run with `PIWI_REQUEST_INSTANCE`, the instance that asked, and `PIWI_REQUEST_TOKEN_FILE`, a file
only you can read that holds the key of that one run. The reporter and its workers send the run there with that key,
whatever server and credentials the config names. A file that is missing or holds no key turns the reporter off for
the run, and it says why; on macOS and Linux, so does a file others can read.

## Connected apps

**Settings → Account → Connected apps** lists the apps you connected from their own window: Piwi Picker, an editor,
the desktop app. Each shows when it connected and, for an app that runs tests, **Online now** while it
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

- [Desktop app](./desktop): the app that takes requests, and its Settings page
- [Desktop app runs](./desktop-runs): the runs the desktop app starts and how you follow them
- [Share links](./share-links): showing one execution to someone without an account
