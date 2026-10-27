import { requireRouteId } from '../../../../utils/project-access';
import { assistantTurnOfRequest } from '../../../../utils/assistant/turn-token';
import { answerTurnMcp } from '../../../../utils/assistant/turn-mcp';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: "An answer's MCP endpoint (Claude Code CLI)",
    description:
      "The MCP server (Streamable HTTP, JSON-RPC over POST) of one answer the Claude Code CLI writes, which the CLI this server starts calls its tools on: `initialize`, `ping`, `tools/list` (the answer's tools: the read tools offered, `find_tools`, `get_instance_config`, `find_anchors` and the block tools) and `tools/call` (run with the asking user's access; a block tool's block is sent to the question's event stream). A call that changes the tools offered answers as an event stream announcing `notifications/tools/list_changed` first. Authenticated only by the bearer token minted for that answer, which is never a session or an API key: 401 without it, after the answer ends, for another conversation, and for a request that does not come from this machine (a host, an origin or a peer address that is not loopback). The desktop app's guard lets this route through on that token.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    security: [],
  },
});

export default eventHandler(async (event) => {
  const id = requireRouteId(event, 'id', 'conversation ID');
  const turn = assistantTurnOfRequest(event, id);
  if (!turn) throw apiError({ statusCode: 401, message: 'This endpoint takes the token of a running answer' });

  const body = await readBody(event).catch(() => null);
  const reply = await answerTurnMcp(turn, body, {
    version: String(useRuntimeConfig(event).public.appVersion ?? ''),
    acceptsStream: (getRequestHeader(event, 'accept') ?? '').includes('text/event-stream'),
  });
  // Notifications have no answer: 204, as on /mcp, so the client opens no stream of its own.
  if (reply.kind === 'none') return null;
  if (reply.kind === 'stream') {
    setResponseHeader(event, 'Content-Type', 'text/event-stream');
    setResponseHeader(event, 'Cache-Control', 'no-cache');
    return reply.body;
  }
  setResponseHeader(event, 'Content-Type', 'application/json');
  return reply.body;
});
