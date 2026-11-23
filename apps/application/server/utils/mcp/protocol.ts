import { setResponseHeaders, setResponseStatus, type H3Event } from 'h3';
import { RPC } from '@piwitests/editor/mcp-protocol';
// The JSON-RPC pieces of MCP, and how each request's era is decided, are shared with the editor service's MCP server
// for the runs it started.
export {
  MCP_META,
  MCP_PROTOCOL_VERSION,
  RPC,
  SUPPORTED_PROTOCOL_VERSIONS,
  checkMcpRequest,
  discoverResult,
  emptyBatchAnswer,
  honoredListenFilter,
  isListenRequest,
  isRefusal,
  negotiateProtocolVersion,
  ok,
  openListenStream,
  postAnswer,
  readMcpHeaders,
  rpcErr,
  servedResponse,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpAnswer,
  type McpEra,
  type McpHeaders,
  type McpListenFilter,
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

/** The answer of the MCP endpoint to a method other than POST: 405, naming POST. */
export function mcpMethodNotAllowed(event: H3Event) {
  setResponseStatus(event, 405);
  setResponseHeaders(event, { Allow: 'POST', 'Content-Type': 'application/json' });
  return {
    jsonrpc: '2.0',
    id: null,
    error: { code: RPC.INVALID_REQUEST, message: 'The MCP endpoint takes POST alone.' },
  };
}
