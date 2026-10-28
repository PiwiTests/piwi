/**
 * The service's MCP server for the agents of this machine (Claude Code, Copilot, Cursor): the runs this editor window
 * started, as tools (`run-agent.ts`), over MCP's streamable HTTP transport, each request a POST answered with JSON. It
 * listens on `127.0.0.1` alone, at the port the client keeps when it is free, else a free one; it answers only a
 * request whose `Host` is its own (`127.0.0.1` or `localhost` at its port: a page reached under another name, DNS
 * rebinding, is refused), that carries no `Origin` (a browser's request always does, and MCP clients are native), and
 * whose `Authorization` is the bearer token the client keeps, compared in constant time. The token reaches the agent
 * through the IDE's registration of the server, or a configuration the developer copies; this user's own processes
 * are not a boundary, other users and web pages are. A body is 256 KiB at most, a batch 8 requests, and 8 requests
 * run at once: a long poll holds one of them, `MAX_FOLLOW_WAIT_S` at most, and lets go of it as soon as its client
 * closes the connection or cancels the request (`notifications/cancelled`).
 */
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isHubHost } from '@piwitests/core/run-hub';
import {
  negotiateProtocolVersion,
  ok,
  rpcErr,
  RPC,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './mcp-protocol.js';
import { sameToken } from './recorder/handoff.js';
import { AGENT_INSTRUCTIONS, AGENT_TOOLS, type ToolResult } from './run-agent.js';

/** The endpoint's path. */
export const AGENT_PATH = '/mcp';
/** The longest body a request carries, in bytes. */
export const MAX_AGENT_BODY = 256 * 1024;
/** The most requests one batch holds. */
export const MAX_AGENT_BATCH = 8;
/** The most requests answered at once: one more is refused with a 503 until one is answered. */
export const MAX_AGENT_REQUESTS = 8;

/** Whether a token the client gives is one the server takes: 32 to 256 characters of base64url. */
export function isAgentToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(token);
}

/** What the server answers with: the tools' results; `signal` aborts once nobody waits for the answer. */
export interface AgentTools {
  call(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>;
}

export interface AgentServerOptions {
  tools: AgentTools;
  /** The port to listen on, else a free one when it is taken; a free one when null. */
  port?: number | null;
  /** The token, else a new random one. */
  token?: string | null;
  /** The service's version, as `initialize` names it. */
  version: string;
}

/** A plain refusal, before any JSON-RPC is read. */
function refuse(
  res: http.ServerResponse,
  status: number,
  message: string,
  headers: http.OutgoingHttpHeaders = {},
): void {
  const body = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: RPC.INVALID_REQUEST, message } });
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

/** The request's body, `MAX_AGENT_BODY` at most; null past it. */
function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_AGENT_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
    // A client that goes away before its body ends.
    req.on('close', () => resolve(null));
  });
}

export class AgentServer {
  private busy = 0;
  /** The tool calls being answered, by their JSON-RPC id, each with what aborts it: a cancel names them by id. */
  private readonly inflight = new Map<string | number, Set<AbortController>>();

  private constructor(
    private readonly server: http.Server,
    readonly port: number,
    readonly token: string,
    private readonly options: AgentServerOptions,
  ) {}

  /** The endpoint an agent is given: `http://127.0.0.1:<port>/mcp`. */
  get url(): string {
    return `http://127.0.0.1:${this.port}${AGENT_PATH}`;
  }

  /** Listen on `127.0.0.1`, at the port asked when it is free, else a free one; null when the machine refuses one. */
  static async open(options: AgentServerOptions): Promise<AgentServer | null> {
    const token = isAgentToken(options.token) ? options.token : randomBytes(32).toString('base64url');
    let ref: AgentServer | null = null;
    const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
      if (ref) ref.handle(req, res);
      else refuse(res, 503, 'Not ready.');
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 120_000;
    server.keepAliveTimeout = 5000;
    server.maxConnections = 32;
    server.on('clientError', (_error, socket) => socket.destroy());
    const listen = (port: number) =>
      new Promise<boolean>((resolve) => {
        const failed = () => resolve(false);
        server.once('error', failed);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', failed);
          resolve(true);
        });
      });
    const wanted = Number.isInteger(options.port) && options.port! > 1023 && options.port! < 65536 ? options.port! : 0;
    if (!(await listen(wanted)) && (wanted === 0 || !(await listen(0)))) {
      server.close();
      return null;
    }
    server.on('error', () => {});
    server.unref();
    ref = new AgentServer(server, (server.address() as AddressInfo).port, token, options);
    return ref;
  }

  close(): void {
    this.server.close();
    this.server.closeAllConnections();
  }

  /** `notifications/cancelled`: the tool calls its `requestId` names stop waiting. */
  private cancel(params: unknown): void {
    const requestId = (params as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return;
    for (const call of this.inflight.get(requestId) ?? []) call.abort();
  }

  /** Each request: refused before it is read unless it is an agent's of this machine, then answered as JSON-RPC. */
  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = (req.url ?? '').split('?')[0];
    if (url !== AGENT_PATH) return refuse(res, 404, 'Not found.');
    // Another name for this machine (a page's DNS rebinding), or a browser's request, never reaches the tools.
    if (!isHubHost(req.headers.host, this.port, [])) return refuse(res, 403, 'Forbidden.');
    if (req.headers.origin !== undefined) return refuse(res, 403, 'Forbidden: a browser does not reach this server.');
    if (req.method !== 'POST') return refuse(res, 405, 'POST only.', { Allow: 'POST' });
    const authorization = req.headers.authorization ?? '';
    const token = /^Bearer (\S+)$/i.exec(authorization)?.[1] ?? '';
    if (!sameToken(token, this.token)) return refuse(res, 401, 'Not authorized: the bearer token is missing or wrong.');
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return refuse(res, 415, 'The body is JSON (Content-Type: application/json).');
    }
    if (Number(req.headers['content-length'] ?? 0) > MAX_AGENT_BODY) {
      return refuse(res, 413, `The body is ${MAX_AGENT_BODY / 1024} KiB at most.`);
    }
    if (this.busy >= MAX_AGENT_REQUESTS) {
      return refuse(res, 503, `${MAX_AGENT_REQUESTS} requests run at once at most: wait for an answer.`, {
        'Retry-After': '1',
      });
    }
    this.busy++;
    void this.answer(req, res).finally(() => this.busy--);
  }

  private async answer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // The client closed the connection before its answer: nothing waits for it any more.
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) gone.abort();
    });
    const body = await readBody(req);
    if (body === null) return refuse(res, 413, `The body is ${MAX_AGENT_BODY / 1024} KiB at most.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return this.send(res, 400, rpcErr(null, RPC.PARSE_ERROR, 'The body is not JSON.'));
    }
    const batch = Array.isArray(parsed);
    const requests = (batch ? parsed : [parsed]) as unknown[];
    if (!requests.length || requests.length > MAX_AGENT_BATCH) {
      return this.send(res, 400, rpcErr(null, RPC.INVALID_REQUEST, `A batch holds 1 to ${MAX_AGENT_BATCH} requests.`));
    }
    const answers = (await Promise.all(requests.map((request) => this.dispatch(request, gone.signal)))).filter(
      (a): a is JsonRpcResponse => a !== null,
    );
    // Notifications alone are accepted, with no body.
    if (!answers.length) {
      res.writeHead(202, { 'Content-Length': '0' });
      res.end();
      return;
    }
    this.send(res, 200, batch ? answers : answers[0]!);
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    if (res.destroyed) return;
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  /** One JSON-RPC request answered, `signal` aborting once nobody waits for it; null for a notification. */
  async dispatch(value: unknown, signal: AbortSignal = new AbortController().signal): Promise<JsonRpcResponse | null> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return rpcErr(null, RPC.INVALID_REQUEST, 'Invalid JSON-RPC request.');
    }
    const request = value as Partial<JsonRpcRequest>;
    const id = request.id;
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return rpcErr(
        typeof id === 'string' || typeof id === 'number' ? id : null,
        RPC.INVALID_REQUEST,
        'Invalid JSON-RPC request.',
      );
    }
    if (id === undefined || id === null) {
      // A cancel ends the wait of the request it names, which answers at once.
      if (request.method === 'notifications/cancelled') this.cancel(request.params);
      return null;
    }
    if (typeof id !== 'string' && typeof id !== 'number') return rpcErr(null, RPC.INVALID_REQUEST, 'Invalid id.');
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: negotiateProtocolVersion(params.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: 'piwi-runs', version: this.options.version },
          instructions: AGENT_INSTRUCTIONS,
        });
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: AGENT_TOOLS });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const own = new AbortController();
        const abort = () => own.abort();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) own.abort();
        const calls = this.inflight.get(id) ?? new Set();
        this.inflight.set(id, calls.add(own));
        try {
          return ok(id, await this.options.tools.call(name, params.arguments, own.signal));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return ok(id, { content: [{ type: 'text', text: `Error: ${message.slice(0, 400)}` }], isError: true });
        } finally {
          signal.removeEventListener('abort', abort);
          calls.delete(own);
          if (!calls.size && this.inflight.get(id) === calls) this.inflight.delete(id);
        }
      }
      case 'resources/list':
        return ok(id, { resources: [] });
      case 'prompts/list':
        return ok(id, { prompts: [] });
      default:
        return rpcErr(id, RPC.METHOD_NOT_FOUND, `Method not found: ${request.method.slice(0, 100)}`);
    }
  }
}
