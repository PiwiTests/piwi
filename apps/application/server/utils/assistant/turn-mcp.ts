/**
 * The MCP server of one assistant turn (Streamable HTTP, JSON-RPC over POST),
 * which the Claude Code CLI running the turn calls its tools on, as a legacy or
 * a modern client (`../mcp/protocol.ts`). It serves that turn's toolbox and
 * nothing else: `tools/list` is what the turn offers now (its read tools,
 * `find_tools`, `get_instance_config`, `find_anchors` and the block tools), and
 * `tools/call` runs through the turn's answer, so a read is made with the asking
 * user's context and counted against the turn's limit, and a block tool's
 * checked block is sent to the browser. When a call changes what is offered
 * (`find_tools` added tools), a legacy client hears it on that call's answer,
 * which comes as an event stream that announces it first
 * (`notifications/tools/list_changed`); a modern client hears it on the stream
 * it opened with `subscriptions/listen`, which ends with the turn.
 */
import type { AiToolCall } from '../ai-tool-calls';
import {
  MCP_META,
  RPC,
  checkMcpRequest,
  discoverResult,
  isRefusal,
  negotiateProtocolVersion,
  ok,
  postAnswer,
  rpcErr,
  servedResponse,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpAnswer,
  type McpEra,
  type McpHeaders,
} from '../mcp/protocol';
import type { AssistantTurnTools } from './turn-token';

/**
 * The reply to one POST: nothing (notifications only, a 202), JSON with its
 * HTTP status, an event stream, or a `subscriptions/listen` stream to open for
 * the request `id`, telling of tool changes when `toolsListChanged`.
 */
export type TurnMcpReply =
  | { kind: 'none' }
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'stream'; body: string }
  | { kind: 'listen'; id: string | number; toolsListChanged: boolean };

const MAX_BATCH_REQUESTS = 20;

const INSTRUCTIONS =
  "The tools of this answer: Piwi's read tools, run with the asking user's access, and the blocks the answer is made of besides text. find_tools adds read tools for the rest of the conversation.";

const CAPABILITIES = { tools: { listChanged: true } };

function serverInfo(version: string) {
  return { name: 'piwi-assistant', version };
}

export function sseFrame(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

const toolNames = (turn: AssistantTurnTools) => turn.definitions().map((d) => d.name);

const TOOLS_CHANGED = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as const;

/** The messages of a `subscriptions/listen` stream opened by request `id`: its acknowledgment, a change, its end. */
export function listenMessages(id: string | number, toolsListChanged: boolean, version: string) {
  const meta = { [MCP_META.subscriptionId]: id };
  return {
    acknowledged: {
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: { _meta: meta, notifications: toolsListChanged ? { toolsListChanged: true } : {} },
    },
    toolsChanged: { ...TOOLS_CHANGED, params: { _meta: meta } },
    ended: {
      jsonrpc: '2.0',
      id,
      result: { resultType: 'complete', _meta: { [MCP_META.serverInfo]: serverInfo(version) } },
    },
  };
}

export async function answerTurnMcp(
  turn: AssistantTurnTools,
  body: unknown,
  opts: {
    version: string;
    acceptsStream: boolean;
    /** The request's mirroring headers; null outside HTTP. */
    headers?: McpHeaders | null;
    /** Tells the turn's `subscriptions/listen` streams that a call changed its tools. */
    toolsChanged?: () => void;
  },
): Promise<TurnMcpReply> {
  const batch = Array.isArray(body);
  const requests = (batch ? body : [body]) as JsonRpcRequest[];
  if (requests.length > MAX_BATCH_REQUESTS) {
    return {
      kind: 'json',
      status: 400,
      body: rpcErr(null, RPC.INVALID_REQUEST, `A batch holds at most ${MAX_BATCH_REQUESTS} requests`),
    };
  }

  const before = toolNames(turn).join(',');
  const answers: Array<McpAnswer | null> = [];
  let legacyAnswered = false;
  for (const req of requests) {
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || !req.method) {
      answers.push({ status: 200, response: rpcErr(req?.id, RPC.INVALID_REQUEST, 'Invalid JSON-RPC request') });
      continue;
    }
    const era = checkMcpRequest(req, opts.headers ?? null);
    if (isRefusal(era)) {
      answers.push(era);
      continue;
    }
    // Notifications have no response.
    if (req.id === undefined || req.id === null) {
      answers.push(null);
      continue;
    }
    if (req.method === 'subscriptions/listen' && era.modern && !batch) {
      const filter = (req.params as { notifications?: { toolsListChanged?: unknown } } | undefined)?.notifications;
      return { kind: 'listen', id: req.id, toolsListChanged: filter?.toolsListChanged === true };
    }
    if (!era.modern) legacyAnswered = true;
    const response = await dispatch(turn, { ...req, id: req.id }, era, opts.version);
    answers.push(servedResponse(era, req.method, response, serverInfo(opts.version)));
  }

  const changed = toolNames(turn).join(',') !== before;
  if (changed) opts.toolsChanged?.();
  const post = postAnswer(batch, answers);
  if (!post) return { kind: 'none' };
  if (!batch && changed && legacyAnswered && opts.acceptsStream) {
    return { kind: 'stream', body: sseFrame(TOOLS_CHANGED) + sseFrame(post.body) };
  }
  return { kind: 'json', status: post.status, body: post.body };
}

let callCount = 0;

async function dispatch(
  turn: AssistantTurnTools,
  req: JsonRpcRequest & { id: string | number },
  era: McpEra,
  version: string,
): Promise<JsonRpcResponse> {
  switch (req.method) {
    case 'initialize':
      return ok(req.id, {
        protocolVersion: negotiateProtocolVersion((req.params as { protocolVersion?: unknown })?.protocolVersion),
        capabilities: CAPABILITIES,
        serverInfo: serverInfo(version),
        instructions: INSTRUCTIONS,
      });
    case 'server/discover':
      return ok(req.id, discoverResult(CAPABILITIES, INSTRUCTIONS));
    case 'ping':
      return ok(req.id, {});
    case 'tools/list':
      return ok(req.id, {
        tools: turn
          .definitions()
          .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== 'string' || !params.name) {
        return rpcErr(req.id, RPC.INVALID_PARAMS, 'tools/call needs a tool name');
      }
      const args = params.arguments ?? {};
      const isObject = typeof args === 'object' && !Array.isArray(args) && args !== null;
      const call: AiToolCall = {
        id: `mcp_${++callCount}`,
        name: params.name,
        arguments: isObject ? (args as Record<string, unknown>) : {},
        ...(isObject ? {} : { invalidArguments: JSON.stringify(args).slice(0, 2000) }),
      };
      const result = await turn.call(call);
      return ok(req.id, { content: [{ type: 'text', text: result.content }], isError: result.isError });
    }
    case 'subscriptions/listen':
      // A modern request is answered with its stream before it gets here.
      return rpcErr(
        req.id,
        era.modern ? RPC.INVALID_REQUEST : RPC.METHOD_NOT_FOUND,
        era.modern ? 'subscriptions/listen is sent alone, not in a batch' : `Method not found: ${req.method}`,
      );
    default:
      return rpcErr(req.id, RPC.METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}
