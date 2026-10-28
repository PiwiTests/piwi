// The JSON-RPC pieces of MCP are shared with the editor service's MCP server for the runs it started.
export {
  MCP_PROTOCOL_VERSION,
  RPC,
  SUPPORTED_PROTOCOL_VERSIONS,
  negotiateProtocolVersion,
  ok,
  rpcErr,
  type JsonRpcRequest,
} from '@piwitests/editor/mcp-protocol';

/**
 * `serverInfo` for the `initialize` response — the version is the running app's
 * version. The desktop app registers under a distinct name (`piwi-desktop`) so a
 * client configured with both a hosted Piwi and the local desktop app tells them
 * apart and namespaces their tools separately.
 */
export function mcpServerInfo(appVersion: string, opts?: { desktop?: boolean }) {
  return { name: opts?.desktop ? 'piwi-desktop' : 'piwi-dashboard', version: appVersion };
}
