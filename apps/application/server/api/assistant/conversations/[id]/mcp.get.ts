import { mcpMethodNotAllowed } from '../../../../utils/mcp/protocol';

defineRouteMeta({
  openAPI: {
    tags: ['Assistant'],
    summary: "An answer's MCP endpoint, for a GET (405)",
    description:
      "The MCP endpoint of an answer takes POST alone: a GET, which an MCP client sends after its notifications to open a stream of server messages, answers 405 with `Allow: POST`, since the server sends no message unasked. The desktop app's guard lets it through on the answer's token, as it does the POST.",
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    security: [],
  },
});

export default eventHandler((event) => mcpMethodNotAllowed(event));
