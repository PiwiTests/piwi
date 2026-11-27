import { requireRouteId } from '../../../../utils/project-access';
import { assistantTurnOfRequest } from '../../../../utils/assistant/turn-token';
import { answerTurnMcp, serverInfo } from '../../../../utils/assistant/turn-mcp';
import { openListenStream, readMcpHeaders } from '../../../../utils/mcp/protocol';
import { streamHeaders } from '#shared/stream-headers';
import { dashboardVersion } from '../../../../utils/app-version';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: "An answer's MCP endpoint (Claude Code CLI)",
    description:
      "The MCP server (Streamable HTTP, JSON-RPC over POST) of one answer the Claude Code CLI writes, which the CLI this server starts calls its tools on, as a legacy client (`initialize`) or a modern one (`_meta` on each request, `server/discover`): `ping`, `tools/list` (the answer's tools: the read tools offered, `find_tools`, `get_instance_config`, `find_anchors` and the block tools) and `tools/call` (run with the asking user's access; a block tool's block is sent to the question's event stream). A call that changes the tools offered answers a legacy client as an event stream announcing `notifications/tools/list_changed` first; a modern client hears it on the stream it opened with `subscriptions/listen`, which ends with the answer. A body of notifications alone answers 202. Authenticated only by the bearer token minted for that answer, which is never a session or an API key: 401 without it, after the answer ends, for another conversation, and for a request that does not come from this machine (a host, an origin or a peer address that is not loopback). The desktop app's guard lets this route through on that token.",
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
    version: dashboardVersion(event),
    acceptsStream: (getRequestHeader(event, 'accept') ?? '').includes('text/event-stream'),
    headers: readMcpHeaders((name) => getRequestHeader(event, name)),
    toolsChanged: () => turn.listeners.toolsChanged(),
  });
  // Notifications have no answer: 202 with no body.
  if (reply.kind === 'none') {
    setResponseStatus(event, 202);
    return '';
  }
  if (reply.kind === 'listen') {
    const version = dashboardVersion(event);
    const stream = openListenStream(event.node.res, reply.id, reply.honored, serverInfo(version));
    stream.onClose(turn.listeners.add({ toolsChanged: () => stream.toolsChanged(), end: () => stream.end() }));
    return;
  }
  if (reply.kind === 'stream') {
    setResponseHeaders(event, streamHeaders('text/event-stream'));
    return reply.body;
  }
  setResponseStatus(event, reply.status);
  setResponseHeader(event, 'Content-Type', 'application/json');
  return reply.body;
});
