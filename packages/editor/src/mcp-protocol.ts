/**
 * The JSON-RPC pieces of the Model Context Protocol (MCP) that Piwi's MCP servers share: the instance's
 * (`apps/application/server/routes/mcp.post.ts`), the in-app assistant's (`server/utils/assistant/turn-mcp.ts`) and the
 * editor service's for the runs it started (`agent-server.ts`). Each serves both eras of clients on one endpoint, and
 * keeps no session:
 *
 * - a legacy client (`2025-11-25` and earlier) opens with `initialize`, which echoes its version when it is a legacy
 *   one Piwi supports, else answers the latest legacy one; its later requests name their version in the
 *   `MCP-Protocol-Version` header, and a request that names none is served as `2025-03-26`;
 * - a modern client (`2026-07-28`) names its version and capabilities in each request's `_meta`, mirrors the version,
 *   the method and the tool or prompt name in the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers, and asks
 *   `server/discover` what the server supports.
 *
 * `checkMcpRequest` decides each message's era, or refuses it with a 400 (an unsupported version, headers that do not
 * match the body, a modern request without its `_meta`); `servedResponse` shapes a served answer for its era, and
 * `openListenStream` answers a modern `subscriptions/listen` with the stream it opens.
 */
/** The revisions whose clients name their version, identity and capabilities on every request, with no `initialize`. */
export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const;
/** The revisions whose clients open with `initialize`, the newest first. */
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
/** Every revision Piwi's MCP servers serve, the newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  ...MODERN_PROTOCOL_VERSIONS,
  ...LEGACY_PROTOCOL_VERSIONS,
];
/** The version `initialize` answers a client that asks for one Piwi does not support: the latest legacy one. */
export const MCP_PROTOCOL_VERSION = LEGACY_PROTOCOL_VERSIONS[0];
/** The version of a request that names none, neither in `_meta` nor in the `MCP-Protocol-Version` header. */
export const UNNAMED_PROTOCOL_VERSION = '2025-03-26';

/** The reserved `_meta` keys Piwi reads and writes. */
export const MCP_META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  subscriptionId: 'io.modelcontextprotocol/subscriptionId',
} as const;

/** The request headers of the Streamable HTTP transport that mirror the body, by their lower-case names. */
export const MCP_HEADERS = {
  protocolVersion: 'mcp-protocol-version',
  method: 'mcp-method',
  name: 'mcp-name',
} as const;

/** Pick the protocol version `initialize` answers: the client's when it is a legacy one Piwi supports, else ours. */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
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
  /** The HTTP headers do not match the body, or a required one is missing or malformed. */
  HEADER_MISMATCH: -32020,
  /** The version a request names is none the server supports: `data.supported` lists those it does. */
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
} as const;

export function ok<T>(id: string | number | null | undefined, result: T): JsonRpcResponse<T> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function rpcErr(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** The values of the headers that mirror the body; absent when the request has none (or outside HTTP). */
export interface McpHeaders {
  protocolVersion?: string;
  method?: string;
  name?: string;
}

/** Read the mirroring headers with `get`, which answers a header by its lower-case name. */
export function readMcpHeaders(get: (name: string) => string | string[] | null | undefined): McpHeaders {
  const one = (name: string): string | undefined => {
    const value = get(name);
    return Array.isArray(value) ? value.join(', ') : (value ?? undefined);
  };
  return {
    protocolVersion: one(MCP_HEADERS.protocolVersion),
    method: one(MCP_HEADERS.method),
    name: one(MCP_HEADERS.name),
  };
}

/** How one message is served: the protocol version it speaks, and whether that is a modern one. */
export interface McpEra {
  version: string;
  modern: boolean;
}

/** One message's answer, and the HTTP status of a POST that holds it alone. */
export interface McpAnswer {
  status: number;
  response: JsonRpcResponse;
}

/** The methods whose request names a tool, a prompt or a resource, mirrored in `Mcp-Name`, by the param that names it. */
const NAMED_METHODS: Record<string, string> = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' };

/** The methods whose modern result a client may cache: theirs carries `ttlMs` and `cacheScope`. */
const CACHEABLE_METHODS = new Set([
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A header's value as it may be quoted in an error: 100 characters at most. */
function quoted(value: string): string {
  return JSON.stringify(value.length > 100 ? `${value.slice(0, 100)}…` : value);
}

/**
 * An `Mcp-Name` value as the body spells it: decoded when it is the `=?base64?…?=` form; null when that form does not
 * decode to UTF-8, or the value holds a character a header cannot carry.
 */
export function decodeMcpHeaderValue(value: string): string | null {
  if (!/^[\t\x20-\x7e]*$/.test(value)) return null;
  const encoded = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!encoded) return value;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded[1]!)) return null;
  try {
    const bytes = Uint8Array.from(atob(encoded[1]!), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The era one JSON-RPC message is served in, or its refusal, a 400. `headers` is null outside HTTP, where no header
 * mirrors the body.
 *
 * A legacy `initialize` negotiates its version in its body. Any other message speaks the version its `_meta` names,
 * else the `MCP-Protocol-Version` header's, else `2025-03-26`; a version Piwi does not serve is refused with
 * `UnsupportedProtocolVersion`, listing those it does. A modern request names its version and the client's
 * capabilities in `_meta`, and over HTTP its headers name the same version, its method and, for a call, the tool,
 * prompt or resource it names; a mismatch, or a header missing, is a `HeaderMismatch`.
 */
export function checkMcpRequest(message: JsonRpcRequest, headers: McpHeaders | null): McpEra | McpAnswer {
  const id = message.id ?? null;
  const isRequest = message.id !== undefined && message.id !== null;
  const params = isObject(message.params) ? message.params : undefined;
  const meta = isObject(params?._meta) ? params._meta : undefined;
  const named = meta?.[MCP_META.protocolVersion];
  const header = headers?.protocolVersion;
  const refuse = (code: number, text: string, data?: unknown): McpAnswer => ({
    status: 400,
    response: rpcErr(id, code, text, data),
  });

  if (named !== undefined && typeof named !== 'string') {
    return refuse(RPC.INVALID_PARAMS, `Invalid params: _meta["${MCP_META.protocolVersion}"] is a string.`);
  }
  if (named === undefined && message.method === 'initialize') {
    return { version: negotiateProtocolVersion(params?.protocolVersion), modern: false };
  }
  if (named !== undefined && header !== undefined && header !== named) {
    return refuse(
      RPC.HEADER_MISMATCH,
      `Header mismatch: the MCP-Protocol-Version header ${quoted(header)} does not match the body's ${quoted(named)}.`,
    );
  }
  const version = named ?? header ?? UNNAMED_PROTOCOL_VERSION;
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return refuse(RPC.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
      requested: version,
    });
  }
  const modern = (MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version);
  if (!modern || !isRequest) return { version, modern };

  if (named === undefined) {
    return refuse(
      RPC.INVALID_PARAMS,
      `Invalid params: a ${version} request names its version in _meta["${MCP_META.protocolVersion}"].`,
    );
  }
  if (!isObject(meta?.[MCP_META.clientCapabilities])) {
    return refuse(
      RPC.INVALID_PARAMS,
      `Invalid params: a ${version} request names the client's capabilities in _meta["${MCP_META.clientCapabilities}"].`,
    );
  }
  if (headers) {
    if (header === undefined)
      return refuse(RPC.HEADER_MISMATCH, 'Header mismatch: the MCP-Protocol-Version header is missing.');
    if (headers.method !== message.method) {
      return refuse(
        RPC.HEADER_MISMATCH,
        headers.method === undefined
          ? 'Header mismatch: the Mcp-Method header is missing.'
          : `Header mismatch: the Mcp-Method header ${quoted(headers.method)} does not match the body's ${quoted(message.method)}.`,
      );
    }
    const field = NAMED_METHODS[message.method];
    const bodyName = field ? params?.[field] : undefined;
    if (typeof bodyName === 'string') {
      if (headers.name === undefined)
        return refuse(RPC.HEADER_MISMATCH, 'Header mismatch: the Mcp-Name header is missing.');
      if (decodeMcpHeaderValue(headers.name) !== bodyName) {
        return refuse(
          RPC.HEADER_MISMATCH,
          `Header mismatch: the Mcp-Name header ${quoted(headers.name)} does not match the body's ${quoted(bodyName)}.`,
        );
      }
    }
  }
  return { version, modern };
}

/** Whether `checkMcpRequest` refused the message. */
export function isRefusal(checked: McpEra | McpAnswer): checked is McpAnswer {
  return 'response' in checked;
}

/** A server's name and version, as `initialize` and a modern result's `_meta` give it. */
export interface McpServerInfo {
  name: string;
  version: string;
}

/**
 * A served request's answer as its era reads it. A modern result carries `resultType`, the server's identity in
 * `_meta` and, for a list or `server/discover`, caching hints: fresh for no time and private to the caller, since what
 * Piwi lists depends on the caller's access. A modern request for a method the server does not have is a 404.
 */
export function servedResponse(
  era: McpEra,
  method: string,
  response: JsonRpcResponse,
  server: McpServerInfo,
): McpAnswer {
  if (!era.modern) return { status: 200, response };
  if (response.error) return { status: response.error.code === RPC.METHOD_NOT_FOUND ? 404 : 200, response };
  const result = isObject(response.result) ? response.result : {};
  const meta = isObject(result._meta) ? result._meta : {};
  return {
    status: 200,
    response: {
      ...response,
      result: {
        resultType: 'complete',
        ...(CACHEABLE_METHODS.has(method) ? { ttlMs: 0, cacheScope: 'private' } : {}),
        ...result,
        _meta: { ...meta, [MCP_META.serverInfo]: server },
      },
    },
  };
}

/** The result of `server/discover`: the versions served, the server's capabilities and its instructions. */
export function discoverResult(capabilities: Record<string, unknown>, instructions?: string): Record<string, unknown> {
  return {
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities,
    ...(instructions ? { instructions } : {}),
  };
}

/**
 * What one POST answers, from the answers of its messages (null for an accepted notification): null when it held
 * notifications alone, which the server answers `202 Accepted` with no body; else the status of the first answer
 * that is not a 200 (or 200), and the answer, or the list of them for a batch.
 */
export function postAnswer(
  batch: boolean,
  answers: ReadonlyArray<McpAnswer | null>,
): { status: number; body: unknown } | null {
  const sent = answers.filter((answer): answer is McpAnswer => answer !== null);
  if (!sent.length) return null;
  const status = sent.find((answer) => answer.status !== 200)?.status ?? 200;
  return { status, body: batch ? sent.map((answer) => answer.response) : sent[0]!.response };
}

/** The change notifications a `subscriptions/listen` stream sends: those the client asked for that the server has. */
export interface McpListenFilter {
  toolsListChanged?: true;
}

/** Whether a message is a modern `subscriptions/listen` request, which the server answers with a stream of its own. */
export function isListenRequest(
  era: McpEra,
  message: JsonRpcRequest,
): message is JsonRpcRequest & { id: string | number } {
  return (
    era.modern &&
    message.method === 'subscriptions/listen' &&
    (typeof message.id === 'string' || typeof message.id === 'number')
  );
}

/** What a `subscriptions/listen` request asks for, narrowed to the notifications the server sends (`sends`). */
export function honoredListenFilter(params: unknown, sends: { toolsListChanged?: boolean }): McpListenFilter {
  const asked = isObject(params) && isObject(params.notifications) ? params.notifications : {};
  return asked.toolsListChanged === true && sends.toolsListChanged ? { toolsListChanged: true } : {};
}

/** The part of a Node HTTP response a listen stream writes to. */
export interface McpStreamResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(): unknown;
  on(event: 'close', listener: () => void): unknown;
  readonly destroyed: boolean;
}

/** How often an open listen stream gets a comment, so a proxy keeps it and a client that left is noticed. */
export const LISTEN_HEARTBEAT_MS = 15_000;

/** A `subscriptions/listen` stream, open until the client closes it or the server ends it. */
export interface McpListenStream {
  /** The server's tools changed: told when the stream acknowledged `toolsListChanged`. */
  toolsChanged(): void;
  /** End the subscription: the request's result, then the end of the stream. */
  end(): void;
  /** Called once, as the stream closes from either side. */
  onClose(listener: () => void): void;
  readonly closed: boolean;
}

function sseFrame(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

/**
 * Answer the modern `subscriptions/listen` request `id` with its stream on `res`: the acknowledgment of `honored`
 * first, each change it names after, a comment every `LISTEN_HEARTBEAT_MS`, and the request's result when the server
 * ends it. Every message carries the subscription's id (the request's) in `_meta`.
 */
export function openListenStream(
  res: McpStreamResponse,
  id: string | number,
  honored: McpListenFilter,
  server: McpServerInfo,
): McpListenStream {
  const meta = { [MCP_META.subscriptionId]: id };
  const closers: Array<() => void> = [];
  let closed = false;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(
    sseFrame({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { _meta: meta, notifications: honored },
    }),
  );
  const heartbeat = setInterval(() => {
    if (!closed) res.write(':\n\n');
  }, LISTEN_HEARTBEAT_MS);
  heartbeat.unref?.();
  const gone = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const close of closers.splice(0)) close();
  };
  res.on('close', gone);
  if (res.destroyed) gone();
  return {
    toolsChanged() {
      if (!closed && honored.toolsListChanged) {
        res.write(sseFrame({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: meta } }));
      }
    },
    end() {
      if (closed) return;
      res.write(
        sseFrame({
          jsonrpc: '2.0',
          id,
          result: { resultType: 'complete', _meta: { ...meta, [MCP_META.serverInfo]: server } },
        }),
      );
      res.end();
      gone();
    },
    onClose(listener) {
      if (closed) listener();
      else closers.push(listener);
    },
    get closed() {
      return closed;
    },
  };
}

/** The refusal of an empty batch, which JSON-RPC answers with one Invalid Request error. */
export function emptyBatchAnswer(): McpAnswer {
  return { status: 400, response: rpcErr(null, RPC.INVALID_REQUEST, 'Invalid Request: an empty batch.') };
}
