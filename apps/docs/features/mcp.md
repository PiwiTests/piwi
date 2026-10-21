---
title: MCP server
description: "The MCP server built into the dashboard: what it gives an agent, how a client signs in through OAuth or an API key, and the setup for each coding agent."
lang: en-US
---

# MCP server

<Needs reporter />

The dashboard serves a **Model Context Protocol (MCP) server** at `/mcp` from its own process, with nothing to
install. Any MCP client (Claude Code, Cursor, VS Code Copilot, Claude Desktop, Gemini CLI) can query your test
results, failure clusters and AI diagnoses, and triage them. The **MCP server** page in the dashboard has a live setup
guide for this instance.

## What it provides

The server exposes tools, mostly read-only, from listing projects to one failure's full evidence and a cluster's
fix plan; [MCP tools](/reference/mcp-tools) lists every one. Two answer questions about Piwi itself:
`describe_piwi` reads the documentation bundled with the server, and `get_release_notes` the changelog up to the
running version. Three read the [coverage](/features/coverage-insights) tests record: `get_coverage` (a file's lines
and the tests behind them, or which target lines a test ran), `compare_coverage` (a failure against its last pass, or a
test's runs against each other) and `get_coverage_loss` (what quarantining or deleting tests leaves uncovered). They return compact JSON, list tools page with `{ items, nextCursor }` (`get_project_test_catalog`
with `offset`/`nextOffset`), and a tool that fails returns a normal result with `isError: true` and a readable
message (one whose SCM or AI provider is not configured returns `{ error }`).

**Modules.** Every tool belongs to one module, `core`, `workflow`, `healing` or `agents`, the groups the Setup page
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
`PIWI_RETENTION_NOTIFICATION_DAYS`, and declining the **Agent write log** capability on the Setup page keeps none.

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
client registration), PKCE is required, and the API reference (`/docs` in your instance) lists the endpoints under
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
[desktop app](/features/desktop#connecting-ai-assistants), the MCP server page detects the installed clients and
writes their entry in one click instead.

<figure>
  <img src="/screenshots/mcp-client-setup.png" alt="The MCP server page's client setup card: the agents listed on the left, Claude Desktop picked, its config entry on the right">
  <figcaption>The <strong>MCP server</strong> page writes the setup for each client with this dashboard's URL already filled in.</figcaption>
</figure>

### Claude Desktop

Add to `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on
Windows), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "piwi": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
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
needs Node on your PATH. The header goes through `env` because Claude Desktop mishandles arguments with spaces. Plans
that offer **Settings → Connectors → Add custom connector** take the `/mcp` URL directly.

### Claude Code (CLI)

```bash
claude mcp add --transport http piwi <your-piwi-url>/mcp --header "Authorization: Bearer pd_YOUR_API_KEY"
```

Restart Claude Code, then check with `/mcp` that **piwi** is listed.

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
without any configuration. Otherwise:

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

The server also exposes MCP **prompts**, which a client offers as slash commands. `setup_piwi` generates the setup
for a Playwright project that does not report here yet. It fills in this instance's URL, whether it requires a key
and its existing projects, then walks the agent through `npx @piwitests/reporter init`, the API key and a first run.
The six workflow [agent skills](/features/agent-skills) are prompts too (`investigate_failure`,
`apply_locator_healing`, `stabilize_flaky_tests`, `run_the_right_tests`, `write_the_missing_test`,
`fix_a_reported_bug`), each with an optional `focus` argument, in the version this server ships.

## Related

- [MCP tools](/reference/mcp-tools): every tool, by module and capability
- [Agent skills](/features/agent-skills): workflows that tell an agent what to do with these tools
- [Desktop app](/features/desktop#connecting-ai-assistants): one-click client setup
