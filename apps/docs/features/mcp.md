---
title: MCP server
description: "The MCP server built into the dashboard: what it gives an agent, how a client signs in through OAuth or an API key, and the setup for each coding agent."
lang: en-US
---

# MCP server

<Needs reporter />

The dashboard serves a **Model Context Protocol (MCP) server** at `/mcp` from its own process, with nothing to
install. Any MCP client (Claude Code, Cursor, VS Code Copilot, Claude Desktop, Gemini CLI) can query your test
results, failure clusters and AI diagnoses, and triage them. **Settings → MCP server** in the dashboard has a live setup
guide for this instance.

## What it provides

The server exposes tools, mostly read-only, from listing projects to one failure's full evidence and a cluster's
fix plan; [MCP tools](/reference/mcp-tools) lists every one, and the dashboard's **MCP server** page opens each
tool on its whole description and its parameters. Two answer questions about Piwi itself:
`describe_piwi` reads the documentation bundled with the server, and `get_release_notes` the changelog up to the
running version. Three read the [coverage](/features/coverage-insights) tests record: `get_coverage` (a file's lines
and the tests behind them, or which target lines a test ran), `compare_coverage` (a failure against its last pass, or a
test's runs against each other) and `get_coverage_loss` (what [quarantining](./flaky-tests#quarantine-with-a-way-out) or deleting tests leaves uncovered).
`get_impacted_tests` takes your working diff and returns the tests it impacts, narrowed to the tests that ran the
changed lines where coverage was recorded ([line level](/features/change-impact#line-level)), with a command to run
them. They return compact JSON, list tools page with `{ items, nextCursor }` (`get_project_test_catalog`
with `offset`/`nextOffset`), and a tool that fails returns a normal result with `isError: true` and a readable
message (one whose SCM or AI provider is not configured returns `{ error }`).

<figure>
  <img src="/screenshots/mcp-tool-details.png" alt="The MCP server page with the get_fix_plan tool opened: its description and its parameters">
  <figcaption>One tool on the MCP server page, opened: what it does and the parameters it takes.</figcaption>
</figure>

**Modules.** Every tool belongs to one module, `core`, `workflow`, `healing` or `agents`, the groups **Settings → Capabilities**
asks about. Declining a capability drops the tools that depend on it. Append `?modules=core` (comma-separated) to the
MCP URL to narrow the list further; narrowing never re-enables a declined tool.

**Access.** The server follows the REST API's [roles](/operate/project-access): with authentication on, a Member's key
reads only the projects its owner holds a role on, and cross-project tools (`list_recent_activity`,
`list_open_clusters`, `search`) are filtered to them. The write tools (triaging clusters and gaps, deciding a merge
suggestion, dismissing a quarantine proposal, setting a bug report's status or a run's incident flag, re-running a
cluster in CI, linking or filing an issue, setting a cluster's baseline commit, running, recording or rating a
diagnosis, reporting a fix attempt, registering a test function) need the same
[permission](/operate/project-access#what-each-role-can-do) as the same action in the dashboard and the REST API, on
the project they act on, and `get_instance_stats` needs an administrator.

**The write log.** Every call of a write tool is logged with the API key that made it, the tool, what it acted on and
the result; read tools never are. A cluster's **Activity** section shows the calls on it, the log is pruned after
`PIWI_RETENTION_NOTIFICATION_DAYS`, and declining the **Agent write log** capability in **Settings → Capabilities** keeps none.

**Transport.** Streamable HTTP: JSON-RPC 2.0 over `POST /mcp`, with no SSE or WebSocket. Protocol versions
`2025-06-18`, `2025-03-26` and `2024-11-05` are supported.


## Authentication

With authentication on, a client signs in through OAuth, as the
[MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
describes and as remote servers such as Atlassian's work: you give the client the MCP URL only, and the first time
it connects it opens this instance in your browser. Sign in if asked, check the client's name and where the answer
goes, and click **Allow**. The client then holds an access token that lasts an hour and that it renews on its own, for 30 days after
its last use. The tokens act with your role and project access, on the MCP server only: the REST API refuses them.
Each connection is listed with your API keys in **Settings → Account → API keys**, named after the client, and
revoking it there disconnects the client at its next request.

Claude Code (`/mcp`, then **Authenticate**), Cursor, VS Code, Gemini CLI, Opencode and Claude Desktop through
`mcp-remote` sign in this way. The instance is its own authorization server: clients register on their own (dynamic
client registration), PKCE is required, and the API reference (`/settings/api` in your instance) lists the endpoints under
**MCP OAuth**.

A client that cannot sign in sends an API key instead, the same `pd_` keys as the REST API, created in **Settings →
Account → API keys** (administrators manage anyone's keys from **Settings → Users**), as a Bearer token on every
request:

```
Authorization: Bearer pd_YOUR_API_KEY
```

When `PIWI_AUTH_ENABLED` is not set, every request is accepted without a key and there is nothing to sign in to,
except in the desktop app, which requires its local access token as the Bearer value.

## Client setup

Replace `<your-piwi-url>` with your dashboard base URL (for example `http://localhost:3000`). For a client that signs
in through OAuth, leave out the `headers` entry (`--header` on a command line); otherwise replace `pd_YOUR_API_KEY`
with a real API key. The **MCP server** page of the dashboard shows both forms. In the
[desktop app](#in-the-desktop-app), the MCP server page detects the installed clients and writes their entry in one
click instead.

<figure>
  <img src="/screenshots/mcp-client-setup.png" alt="The MCP server page's client setup card: the agents listed on the left, Claude Desktop picked, its config entry on the right">
  <figcaption>The <strong>MCP server</strong> page writes the setup for each client with this dashboard's URL already filled in.</figcaption>
</figure>

### In the desktop app

In the [desktop app](/features/desktop#connecting-ai-assistants), **Settings → MCP server** detects Claude Code, Claude Desktop, Cursor, Opencode, VS Code, Windsurf and Gemini CLI and
connects each in one click, writing a `piwi-desktop` entry that runs the app's built-in bridge
(`piwi-desktop mcp-stdio`). No address or token is copied; the bridge finds the app at start, so the app must run, and sends the token only
to a server that proves it holds it. The bridge handles one call at a time, for every client it serves: a `run_follow` or a
`run_control` that waits holds the next call, 40 seconds at most (a 30-second wait, then the stopped page's snapshot). It writes only its own entry and keeps the first backup beside
the config. A disk image (DMG), a translocated copy or a dev build writes nothing, for Connect, Disconnect and the
startup repair alike; each client shows **Manual setup** with the reason. After a move, startup points that entry at the app again,
as it does for an earlier version's address-and-token entry. One you edited shows **Needs update**; **Update** replaces it. Restart the client afterwards. The page also installs the [agent skills](/features/agent-skills) into a linked folder.

### Claude Desktop

Add to `claude_desktop_config.json`, then restart Claude Desktop. On macOS it is in
`~/Library/Application Support/Claude/`, on Linux (beta) in `~/.config/Claude/`. On Windows, recent versions keep it in
`%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\`. An older install keeps it in one of these folders; a
`.user-data-left.*` file there means it moved to `Claude-Data`:

- `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\`, an MSIX install (Microsoft Store, WinGet)
- `%APPDATA%\Claude\`, the classic installer

```json
{
  "mcpServers": {
    "piwi": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@0.14.3",
        "<your-piwi-url>/mcp",
        "--transport",
        "http-only",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer pd_YOUR_API_KEY"
      }
    }
  }
}
```

Claude Desktop only starts local commands from this file and ignores an entry with a `url`, so
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote), a small Node bridge, carries the HTTP connection; `npx`
needs Node on your PATH. Keep its version in the entry: `npx` without one runs whatever release npm serves that day,
with your key in its environment, and a release before 0.1.16 runs a command a hostile server hides in its sign-in
address ([CVE-2025-6514](https://nvd.nist.gov/vuln/detail/CVE-2025-6514)). The header goes through `env` because Claude Desktop mishandles arguments with spaces. Plans
that offer **Settings → Connectors → Add custom connector** take the `/mcp` URL directly.

### Claude Code (CLI)

```bash
claude mcp add --transport http --scope user piwi <your-piwi-url>/mcp --header "Authorization: Bearer pd_YOUR_API_KEY"
```

`--scope user` makes the server available in every folder; without it, Claude Code keeps it for the folder the command
ran in. Restart Claude Code, then check with `/mcp` that **piwi** is listed.

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "piwi": {
      "url": "<your-piwi-url>/mcp",
      "headers": {
        "Authorization": "Bearer pd_YOUR_API_KEY"
      }
    }
  }
}
```

### VS Code (GitHub Copilot, agent mode)

With the [Piwi extension](/features/editors) installed and connected, VS Code 1.101 and later list Piwi's server
without any configuration, with the extension's key, or signed in through OAuth when `piwi.mcpAuthorization` is
`sign-in`. Otherwise:

Add to `.vscode/mcp.json` in your workspace (VS Code 1.99+):

```json
{
  "servers": {
    "piwi": {
      "type": "http",
      "url": "<your-piwi-url>/mcp",
      "headers": {
        "Authorization": "Bearer pd_YOUR_API_KEY"
      }
    }
  }
}
```

### Gemini CLI

```bash
gemini mcp add --transport http piwi <your-piwi-url>/mcp --header "Authorization: Bearer pd_YOUR_API_KEY"
```

### Windsurf / Continue

```json
{
  "mcpServers": {
    "piwi": {
      "serverUrl": "<your-piwi-url>/mcp",
      "headers": {
        "Authorization": "Bearer pd_YOUR_API_KEY"
      }
    }
  }
}
```

Windsurf reads `~/.codeium/windsurf/mcp_config.json`; Continue reads `~/.continue/config.json`, under `mcpServers`.

## Prompts

The server also exposes MCP **prompts**, which a client offers as slash commands, with nothing to install.
`setup_piwi` sets up a Playwright project that does not report here yet, with this instance's URL, whether it
requires a key and its existing projects, then walks the agent through `npx @piwitests/reporter init`, the API key and
a first run; an optional `projectName` names the project. Each workflow [agent skill](/features/agent-skills) is a prompt too (`investigate_failure`,
`apply_locator_healing`, `stabilize_flaky_tests`, `run_the_right_tests`, `write_the_missing_test`,
`fix_a_reported_bug`), in the version this server ships, with an optional `focus` (a run, a cluster, a test, a gap or a
bug report, as an id or a URL). Prompts need the MCP connection; installed skills work
offline.

## Related

- [MCP tools](/reference/mcp-tools): every tool, by module and capability
- [Run control for agents](/features/agent-run-control): the runs an editor or the desktop app starts, as tools
- [Agent skills](/features/agent-skills): workflows that tell an agent what to do with these tools
- [Desktop app](/features/desktop#connecting-ai-assistants): the local tools its MCP server adds
