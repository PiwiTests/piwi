import { mcpMethodNotAllowed } from '../../../../utils/mcp/protocol';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: "An answer's MCP endpoint, for a DELETE (405)",
    description:
      "The MCP endpoint of an answer takes POST alone: a DELETE, which an MCP client sends to end a session, answers 405 with `Allow: POST`, since the server keeps no session. The desktop app's guard lets it through on the answer's token, as it does the POST.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    security: [],
  },
});

export default eventHandler((event) => mcpMethodNotAllowed(event));
