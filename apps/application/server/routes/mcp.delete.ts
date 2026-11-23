import { mcpMethodNotAllowed } from '../utils/mcp/protocol';

// The MCP endpoint takes POST alone: the server keeps no session for a client to end with DELETE.
export default eventHandler((event) => mcpMethodNotAllowed(event));
