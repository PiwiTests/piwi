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

**One entry for every repository.** `npx @piwitests/reporter mcp` serves the runs of every editor with Piwi and of
the desktop app as one MCP server, over stdio: add it once, at user scope, for any agent that starts a command.

::: code-group

```bash [Linux / macOS]
claude mcp add --scope user piwi-runs -- npx -y @piwitests/reporter@latest mcp
```

```powershell [Windows (PowerShell)]
claude mcp add --scope user piwi-runs -- cmd /c npx -y @piwitests/reporter@latest mcp
```

:::

How it routes each call: [`mcp`](/reference/cli#mcp). VS Code's own agent (1.101 and later) needs nothing: the extension lists its window's server as **Piwi runs**,
beside **Piwi**, which then leaves the desktop app's run tools of the same names out.

Each editor's server listens on `127.0.0.1` once the extension starts, at a port and behind a token the extension
keeps for this workspace (in a JetBrains IDE, this project). If another program holds that port, the server moves,
with a new token, and says so. To give an agent one window's runs alone, copy its entry: **Piwi: Copy the runs' MCP
server configuration for agents** in VS Code, **Tools → Piwi → Copy the runs' MCP server configuration for Claude Code
or Cursor** (an `http` entry, the token as a bearer header) or **…for Agents** (one that runs
`npx -y mcp-remote@0.14.3 <url> --transport http-only`, for the JetBrains AI Assistant) in a JetBrains IDE.

**The configuration holds the token.** Keep it in your user settings, never in a file of the repository such as a
project's `.mcp.json`: whoever reads it can drive your runs while the editor is open. **Reset the token** (**Piwi:
Reset the runs' MCP server token**; **Tools → Piwi → Reset the runs' MCP server token**) gives the server a new one:
an agent with the old one is refused until you copy the configuration again. `piwi.serveRunsToAgents` in VS Code, and
**Settings → Tools → Piwi** in a JetBrains IDE, turn the server off.

## The tools

| Tool            | What it does                                                                                                                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_start`     | Start a run of a spec, or of the test holding a line, built and checked as yours are and run where you see it, labeled with the agent's name, three at once at most; a failed test waits at its line by default while the agent follows the run                                                                          |
| `run_list`      | The runs of the window, what started each (the editor, a terminal or a test runner), their page, progress, [Hold failures](./watch-a-run#hold-failures) and who has them open, their workers, the test each one runs and where it stands stopped                                                                                                           |
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

An agent follows a run until two minutes after its last call on it: the run's calls and page events are told until
then; an action the page answers late may still take effect, kept as a step, and `run_follow` says so.

**An assertion on an element's text** checks the whole text, as the page shows it now (`toHaveText`); for a text
longer than 1,000 characters, it checks that the element contains its first words (`toContainText`, up to 200
characters). Piwi refuses to write a secret field's value, and a text or a value that holds a credential.

## What keeps it safe

- **Only this machine, only this window.** The server answers a request to its own address on `127.0.0.1` with the
  token, and refuses any other name for the machine and any request a browser sends (it carries an `Origin`). It serves
  the runs this window started, and those [started outside Piwi](./terminal-runs) that follow it, and nothing of an
  instance.
- **Only a stopped page, only the actions named.** An action needs the stop it answers, and goes nowhere once the test
  went on. The tools take a closed set of arguments. `run_start` runs a spec of your workspace as you would, with the
  command Piwi builds; no other tool evaluates code, reads a file or runs a command. Code reaches your files only
  through the editor, as an edit you see.
- **The page is untrusted.** A page can hold text written to steer a model. Everything that comes from it (its
  snapshot, its address and title, an element's name, text and value, the locators built from them, its console, its
  errors, its requests, and what the test says when a read of it fails) comes back apart from Piwi's own answer,
  between two markers that share a random value the page cannot know, and every tool's description tells the agent to
  read it as data, never as instructions. An image comes after a line that says it is the page's too.
- **Secrets stay hidden.** The value of a password field, a one-time code and a card's number or security code is
  never sent: its line in the snapshot reads `<hidden>`, in every frame, the image paints over the field (a page zoomed
  in gets no image), and no assertion writes it. Tokens and credentials in the page's text, its addresses and the locators `page_locator` shows are
  hidden, as on Piwi's other surfaces.
- **You watch it happen.** The agent's stops show in the editor and the Runs window as yours do, the editor's as
  `Paused by the agent · …`; its first action at a stop says so in a notification; the code it has written names it
  (`Piwi wrote the steps the agent took above checkout.spec.ts:30.`). You can take over at any stop
  ([driving a stop](/guide/concepts#presence-driving-a-stop)): the agent is refused there and told so.

## In the desktop app

The [desktop app](./desktop-runs#for-agents)'s MCP server serves the same tools for the runs it starts; there,
`code_write` writes no file and a run nobody attends is not served. `run_start` takes a spec of a linked folder,
which the app's window starts as you would from its Local runs tray, titled `Started by <agent>`, while a window is
open. It runs each test once, outside UI mode, and counts among the three runs agents start at once until its process
ends; a line in no test, or a spec whose name starts with `-`, is refused. `npx @piwitests/reporter mcp` sends the
app a spec no editor's workspace holds.

## Limits

- **A remote window** (SSH, a dev container, Gateway) runs the server on the remote machine: an agent there reaches it.
- An action needs a `@piwitests/reporter` at least as recent as the editor extension; at an older one's stops, the
  tools say what it cannot do.

## Related

- [Pause and step from the editor](./editor-run-control)
- [Code from a pause](./editor-stop-code)
- [MCP server](./mcp)
- [Runs window](./runs-window)
- [Share a stop with Playwright tools](./editor-run-control#share-with-playwright-tools)
