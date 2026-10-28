---
title: Run control for agents
description: "Give a coding agent on your machine the test runs your editor starts, as MCP tools: it follows a run, stops it, reads the stopped page as its ARIA snapshot, acts on it by ref and has Piwi write the code there, which you see and can undo."
lang: en-US
---

# Run control for agents

<Needs reporter fixtures />

A coding agent on your machine (Claude Code, Copilot, Cursor, the JetBrains AI Assistant) can work with a test run
the way you do with [Pause and step from the editor](./editor-run-control) and the [Runs window](./runs-window): follow
the run, stop it, look at the stopped page, act on it, and have the code written at the stopped line. The editor
service serves the runs of its window (in a JetBrains IDE, its project) as an MCP server of its own, apart from Piwi's
[MCP server](./mcp), which reads your suite's history on an instance.

## Connect your agent

The server listens on `127.0.0.1` once the editor extension starts, behind a token the extension keeps, at a port it
keeps when it is free, so a configuration you copy once keeps working after a restart.

- **VS Code 1.101 and later** lists it for its agent as **Piwi runs**, beside **Piwi**: there is nothing to set.
- **An agent in a terminal**, from VS Code: **Piwi: Copy the runs' MCP server configuration for agents** copies an
  `mcp.json` entry:

  ```json
  {
    "servers": {
      "piwi-runs": { "type": "http", "url": "http://127.0.0.1:41234/mcp", "headers": { "Authorization": "Bearer …" } }
    }
  }
  ```

  Claude Code takes the same entry under `mcpServers` in its own settings.

- **A JetBrains IDE**: **Tools → Piwi → Copy the Runs' MCP Server Configuration for Agents** copies an `mcpServers`
  entry, bridged through `mcp-remote` as Piwi's own is, for **Settings → Tools → AI Assistant → Model Context
  Protocol** or another agent's settings. The platform has no public way for a plugin to add a server to the AI
  Assistant, so you paste it once.

The configuration holds the token: keep it in your user settings, out of the repository. **Serve the runs to agents**
turns the server off at once: `piwi.serveRunsToAgents` in VS Code, **Settings → Tools → Piwi** in a JetBrains IDE.

## The tools

| Tool            | What it does                                                                                                                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_list`      | The runs of the window, their workers, the test each one runs and where it stands stopped                                                                                                                                                                                                                                     |
| `run_follow`    | The run's events since a cursor: each test's start and end, each call as it ends with its place in your code and whether it passed, the stops, and the page's navigations, console errors and warnings, uncaught errors and failed requests. It waits up to 25 seconds, and answers at once while the run is stopped or ended |
| `run_control`   | Pause, Step, Run to a line, Resume or Finish, answered when the run stops again, with the page's snapshot, or when it ends                                                                                                                                                                                                    |
| `page_snapshot` | The stopped page's ARIA snapshot in AI mode, a ref per element (`[ref=e5]`), to a depth you choose, with an image of the page when asked                                                                                                                                                                                      |
| `page_act`      | Click, fill, press a key, check, uncheck or select an option on an element by its ref, answered with the page's change                                                                                                                                                                                                        |
| `page_locator`  | Piwi's locators for an element by its ref, ranked as [Pick a locator](./pick-an-element) ranks them, each checked to find it alone                                                                                                                                                                                            |
| `code_write`    | The steps `page_act` took, the element's locator in place of the stopped line's, or an assertion on it, written by the editor                                                                                                                                                                                                 |

An agent reads the page as text: the first snapshot whole (or a region of it, to a depth), then each stop and each
action answered with what changed since. An image costs more, and comes only when asked.

**The steps the agent takes** are kept as yours are when you record: each with the element's best locator, the
project's test id attribute first and the suite's own locators preferred. `code_write` renders them with Piwi's
generator, as [Code from a pause](./editor-stop-code) does, and the editor writes them above the stopped line as one
edit: one undo removes it. The test goes on with the code it started with: the new lines run next time.

A run's calls and page events are told while the agent calls a tool on that run, and stop two minutes after its last
call or as you turn the server off; what the page said in them is then dropped.

An action the page does not answer within 10 seconds is answered as such: it may still take effect, and if it does,
it is kept as a step and `run_follow` tells it (`act-played`).

**An assertion on an element's text** checks the whole text, as the page shows it now (`toHaveText`); for a text
longer than 1,000 characters, it checks that the element contains its first words (`toContainText`, up to 200
characters). Piwi refuses to write a secret field's value, and a text or a value that holds a credential.

## What keeps it safe

- **Only this machine, only this window.** The server answers a request to its own address on `127.0.0.1` with the
  token, and refuses any other name for the machine and any request a browser sends (it carries an `Origin`). It
  serves the runs this window started, and nothing of an instance.
- **Only a stopped page, only the actions named.** An action needs the stop it answers, and goes nowhere once the test
  went on. The tools take a closed set of arguments; none evaluates code, reads a file or runs a command. Code reaches
  your files only through the editor, as an edit you see.
- **The page is untrusted.** A page can hold text written to steer a model. Everything that comes from it (its
  snapshot, its address and title, an element's name, text and value, the locators built from them, its console, its
  errors, its requests, and what the test says when a read of the page fails, which a script of the page can word)
  comes back apart from Piwi's own answer, between two markers that share a random value the page cannot know, and
  every tool's description tells the agent to read it as data, never as instructions. An image comes after a line
  that says it is the page's too.
- **Secrets stay hidden.** The value of a password field, a one-time code and a card's number or security code is
  never sent: its line in the snapshot reads `<hidden>`, in every frame, the image masks the field, and no assertion
  writes it. Tokens and credentials in the page's text, its addresses and the locators `page_locator` shows are
  hidden by the rule Piwi's other surfaces use.
- **You watch it happen.** The agent's stops show in the editor and the Runs window as yours do, the editor's as
  `Paused by the agent · …`; its first action at a stop says so in a notification; the code it has written names it
  (`Piwi wrote the steps the agent took above checkout.spec.ts:30.`). You can take over at any stop.

## Share with Playwright tools

At a stop, **Share with Playwright tools** (the stop's hover and **Piwi: Share the stopped test's browser with
Playwright tools** in VS Code; the stop's menu and **Tools → Piwi** in a JetBrains IDE) binds the test's browser for
Playwright's own tools, so `npx playwright cli attach piwi-<run>-w<worker>` and Playwright's dashboard can join it.
It is off until you ask, every time, and asks first: a shared browser is open to any process of yours, which can read
its pages and run code in them. It is shared until the test ends, and no agent can share it.

## Limits

- **Ending a test from a stop** is not one of the actions: resume, finish, or stop the run from the editor.
- **The desktop app's runs** are its own, and its window steers them: this server serves the editor's runs alone.
- **A remote window** (SSH, a dev container, Gateway) runs the server on the remote machine: an agent there reaches it.
- An action needs Playwright 1.64 or later and a `@piwitests/reporter` at least as recent as the editor extension; at
  an older one's stops, the tools say what it cannot do.

## Related

- [Pause and step from the editor](./editor-run-control)
- [Code from a pause](./editor-stop-code)
- [MCP server](./mcp)
- [Runs window](./runs-window)
