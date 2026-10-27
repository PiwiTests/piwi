/**
 * The MCP server of one assistant turn (Streamable HTTP, JSON-RPC over POST),
 * which the Claude Code CLI running the turn calls its tools on. It serves
 * that turn's toolbox and nothing else: `tools/list` is what the turn offers
 * now (its read tools, `find_tools`, `get_instance_config`, `find_anchors`
 * and the block tools), and `tools/call` runs through the turn's answer, so a
 * read is made with the asking user's context and counted against the turn's
 * limit, and a block tool's checked block is sent to the browser. When a call
 * changes what is offered (`find_tools` added tools), the answer comes as an
 * event stream that announces it first (`notifications/tools/list_changed`).
 */
import type { AiToolCall } from '../ai-tool-calls';
import { RPC, negotiateProtocolVersion, ok, rpcErr, type JsonRpcRequest } from '../mcp/protocol';
import type { AssistantTurnTools } from './turn-token';

/** The reply to one POST: nothing (notifications only), JSON, or an event stream. */
export type TurnMcpReply = { kind: 'none' } | { kind: 'json'; body: unknown } | { kind: 'stream'; body: string };

const MAX_BATCH_REQUESTS = 20;

const INSTRUCTIONS =
  "The tools of this answer: Piwi's read tools, run with the asking user's access, and the blocks the answer is made of besides text. find_tools adds read tools for the rest of the conversation.";

function sseFrame(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

const toolNames = (turn: AssistantTurnTools) => turn.definitions().map((d) => d.name);

export async function answerTurnMcp(
  turn: AssistantTurnTools,
  body: unknown,
  opts: { version: string; acceptsStream: boolean },
): Promise<TurnMcpReply> {
  const batch = Array.isArray(body);
  const requests = (batch ? body : [body]) as JsonRpcRequest[];
  if (requests.length > MAX_BATCH_REQUESTS) {
    return {
      kind: 'json',
      body: rpcErr(null, RPC.INVALID_REQUEST, `A batch holds at most ${MAX_BATCH_REQUESTS} requests`),
    };
  }

  const before = toolNames(turn).join(',');
  const responses = [];
  for (const req of requests) {
    const response = await dispatch(turn, req, opts.version);
    if (response) responses.push(response);
  }
  if (responses.length === 0) return { kind: 'none' };
  if (batch) return { kind: 'json', body: responses };

  if (opts.acceptsStream && toolNames(turn).join(',') !== before) {
    const changed = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };
    return { kind: 'stream', body: sseFrame(changed) + sseFrame(responses[0]) };
  }
  return { kind: 'json', body: responses[0] };
}

let callCount = 0;

async function dispatch(turn: AssistantTurnTools, req: JsonRpcRequest, version: string) {
  if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || !req.method) {
    return rpcErr(req?.id, RPC.INVALID_REQUEST, 'Invalid JSON-RPC request');
  }
  // Notifications have no response.
  if (req.id === undefined || req.id === null) return null;

  switch (req.method) {
    case 'initialize':
      return ok(req.id, {
        protocolVersion: negotiateProtocolVersion((req.params as { protocolVersion?: unknown })?.protocolVersion),
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'piwi-assistant', version },
        instructions: INSTRUCTIONS,
      });
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
    default:
      return rpcErr(req.id, RPC.METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}
