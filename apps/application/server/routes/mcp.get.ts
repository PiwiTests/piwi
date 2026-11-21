import { mcpMethodNotAllowed } from '../utils/mcp/protocol';

// The MCP endpoint takes POST alone: no client opens a stream with GET, since no server message comes unasked.
export default eventHandler((event) => mcpMethodNotAllowed(event));
