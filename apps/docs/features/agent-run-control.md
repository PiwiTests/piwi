---
title: Run control for agents
description: "Give a coding agent on your machine the test runs your editor or the desktop app starts, as MCP tools: it follows a run, stops it, reads the stopped page as its ARIA snapshot, acts on it by ref and has Piwi write the code there, which you see and can undo."
lang: en-US
---

# Run control for agents

<Needs reporter fixtures />

A coding agent on your machine (Claude Code, Copilot, Cursor, the JetBrains AI Assistant) can work with a test run
the way you do with [Pause and step from the editor](./editor-run-control) and the [Runs window](./runs-window): follow
the run, stop it, look at the stopped page, act on it, and have the code written at the stopped line. The editor
service serves the runs of its window (in a JetBrains IDE, its project) as an MCP server of its own, apart from Piwi's
[MCP server](./mcp), which reads your suite's history on an instance; the [desktop app](#in-the-desktop-app) serves
its own.

## Connect your agent

The server listens on `127.0.0.1` once the editor extension starts, at a port and behind a token the extension keeps
for this workspace (in a JetBrains IDE, this project): a configuration you copy once keeps working after a restart. If
another program holds that port, the server moves, with a new token, and says so.

| Agent                                                                          | What it takes                                                                           |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| VS Code's own agent (1.101 and later)                                          | Nothing to set: the extension lists the server as **Piwi runs**, beside **Piwi**        |
| Claude Code, Cursor and other agents that connect over HTTP                    | The `mcpServers` entry of type `http` below, with the token as a bearer header          |
| The JetBrains AI Assistant, Claude Desktop and agents that only start commands | An `mcpServers` entry that runs `mcp-remote`, a small Node bridge, at one exact release |

- **From VS Code**: **Piwi: Copy the runs' MCP server configuration for agents** asks which, then copies the entry:

  ```json
  {
    "mcpServers": {
      "piwi-runs": { "type": "http", "url": "http://127.0.0.1:41234/mcp", "headers": { "Authorization": "Bearer …" } }
    }
  }
  ```

  Claude Code reads it in your user settings (`claude mcp add-json` with `--scope user`), Cursor in
  `~/.cursor/mcp.json`; the other choice is VS Code's own `mcp.json`.

- **From a JetBrains IDE**: **Tools → Piwi → Copy the Runs' MCP Server Configuration for Claude Code or Cursor**
  copies the same entry; **…for Agents** copies one that runs `npx -y mcp-remote@0.14.3 <url> --transport http-only`,
  the token in `env`, for the AI Assistant (**Settings → Tools → AI Assistant → Model Context Protocol**), which has no
  public way for a plugin to add a server.

**The configuration holds the token.** Keep it in your user settings, never in a file of the repository such as a
project's `.mcp.json`: whoever reads it can drive your runs while the editor is open. **Reset the token** (**Piwi:
Reset the runs' MCP server token**; **Tools → Piwi → Reset the Runs' MCP Server Token**) gives the server a new one:
an agent with the old one is refused until you copy the configuration again. `piwi.serveRunsToAgents` in VS Code, and
**Settings → Tools → Piwi** in a JetBrains IDE, turn the server off.

## The tools

| Tool            | What it does                                                                                                                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_list`      | The runs of the window, their workers, the test each one runs and where it stands stopped                                                                                                                                                                                                                                     |
| `run_follow`    | The run's events since a cursor: each test's start and end, each call with its place in your code and its result, the stops, and the page's navigations, console errors, uncaught errors and failed requests. It waits up to 25 seconds, and answers at once while the run is stopped or ended                                |
| `run_control`   | Pause, Step, Run to a line, Resume, Finish or [End the test](./end-the-test), answered when the run stops again, with the page's snapshot, when the test it ended ends, or when the run ends                                                                                                                                  |
| `page_snapshot` | The stopped page's ARIA snapshot in AI mode, a ref per element (`[ref=e5]`), to a depth you choose, with an image of the page when asked                                                                                                                                                                                      |
| `page_act`      | Click, fill, press a key, check, uncheck or select an option on an element by its ref, answered with the page's change                                                                                                                                                                                                        |
| `page_locator`  | Piwi's locators for an element by its ref, ranked as [Pick a locator](./pick-an-element) ranks them, each checked to find it alone                                                                                                                                                                                            |
| `code_write`    | The steps `page_act` took, the element's locator in place of the stopped line's, or an assertion on it, written by the editor                                                                                                                                                                                                 |

An agent reads the page as text: the first snapshot whole (or to a depth), then what each stop and action changed. An
image costs more, and comes only when asked.

**The steps the agent takes** are kept as yours are when you record: each with the element's best locator, the
project's test id attribute first and the suite's own locators preferred. `code_write` renders them with Piwi's
generator, as [Code from a pause](./editor-stop-code) does, and the editor writes them above the stopped line as one
edit: one undo removes it. The test goes on with the code it started with: the new lines run next time.

A run's calls and page events are told until two minutes after the agent's last call on it; an action the page
answers late may still take effect, kept as a step, and `run_follow` says so.

**An assertion on an element's text** checks the whole text, as the page shows it now (`toHaveText`); for a text
longer than 1,000 characters, it checks that the element contains its first words (`toContainText`, up to 200
characters). Piwi refuses to write a secret field's value, and a text or a value that holds a credential.

## What keeps it safe

- **Only this machine, only this window.** The server answers a request to its own address on `127.0.0.1` with the
  token, and refuses any other name for the machine and any request a browser sends (it carries an `Origin`). It serves
  the runs this window started, and those [started outside Piwi](./terminal-runs) that follow it, and nothing of an
  instance.
- **Only a stopped page, only the actions named.** An action needs the stop it answers, and goes nowhere once the test
  went on. The tools take a closed set of arguments; none evaluates code, reads a file or runs a command. Code reaches
  your files only through the editor, as an edit you see.
- **The page is untrusted.** A page can hold text written to steer a model. Everything that comes from it (its
  snapshot, its address and title, an element's name, text and value, the locators built from them, its console, its
  errors, its requests, and what the test says when a read of it fails) comes back apart from Piwi's own answer,
  between two markers that share a random value the page cannot know, and every tool's description tells the agent to
  read it as data, never as instructions. An image comes after a line that says it is the page's too.
- **Secrets stay hidden.** The value of a password field, a one-time code and a card's number or security code is
  never sent: its line in the snapshot reads `<hidden>`, in every frame, the image masks the field, and no assertion
  writes it. Tokens and credentials in the page's text, its addresses and the locators `page_locator` shows are
  hidden, as on Piwi's other surfaces.
- **You watch it happen.** The agent's stops show in the editor and the Runs window as yours do, the editor's as
  `Paused by the agent · …`; its first action at a stop says so in a notification; the code it has written names it
  (`Piwi wrote the steps the agent took above checkout.spec.ts:30.`). You can take over at any stop.

## In the desktop app

The [desktop app](./desktop-runs#for-agents) serves the same tools for the runs it starts, from its own MCP server.
There, `code_write` writes no file: the code waits in the **Local runs** tray to copy, and comes back to the agent. A
run nobody attends, such as a Flake Lab run or a bisect, is not served.

## Share with Playwright tools

At a stop, **Share with Playwright tools** (the stop's hover and **Piwi: Share the stopped test's browser with
Playwright tools** in VS Code; the stop's menu and **Tools → Piwi** in a JetBrains IDE) binds the test's browser for
Playwright's own tools, so `npx playwright cli attach piwi-<run>-w<worker>` and Playwright's dashboard can join it.
It is off until you ask, every time, and asks first: a shared browser is open to any process of yours, which can read
its pages and run code in them. It is shared until the test ends, and no agent can share it.

## Limits

- **A remote window** (SSH, a dev container, Gateway) runs the server on the remote machine: an agent there reaches it.
- An action needs Playwright 1.64 or later and a `@piwitests/reporter` at least as recent as the editor extension; at
  an older one's stops, the tools say what it cannot do.

## Related

- [Pause and step from the editor](./editor-run-control)
- [Code from a pause](./editor-stop-code)
- [MCP server](./mcp)
- [Runs window](./runs-window)
