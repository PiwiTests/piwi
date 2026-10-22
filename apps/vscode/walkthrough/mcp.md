## Give your agent Piwi's MCP server

Piwi's MCP server lets a coding agent read your suite: the failures of a run, the flaky tests and the healed locators.

- **VS Code 1.101 and later**: the extension lists the server for the agent, with the connection you made. There is
  nothing to set.
- **Another editor**: **Piwi: Copy the MCP server configuration** puts an `mcp.json` entry on the clipboard. It holds
  your API key: paste it into your user settings, not into the repository.

In the Failures view, **Copy context for agent** copies one failure, with its healing and fix plan, for any agent.
