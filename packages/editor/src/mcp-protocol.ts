/**
 * The JSON-RPC pieces of the Model Context Protocol (MCP) that Piwi's MCP servers share: the instance's
 * (`apps/application/server/routes/mcp.post.ts`) and the editor service's for the runs it started (`agent-server.ts`).
 * On `initialize`, a server echoes the client's requested version when it is one it supports, otherwise it replies
 * with the latest it implements. Clients down to 2024-11-05 are supported.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** Pick the protocol version to advertise: the client's if supported, else ours. */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export function ok<T>(id: string | number | null | undefined, result: T): JsonRpcResponse<T> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function rpcErr(id: string | number | null | undefined, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
