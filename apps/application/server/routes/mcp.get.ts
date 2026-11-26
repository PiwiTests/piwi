import { getRequestHeader, sendRedirect } from 'nitro/h3';
import { mcpMethodNotAllowed } from '../utils/mcp/protocol';

// The MCP endpoint takes POST alone: an MCP client's GET, which asks for an event stream of server messages, answers
// 405, since no server message comes unasked. Any other GET, a browser's or a bookmark's, goes to the MCP settings
// page, as the `/mcp` page redirect of `nuxt.config.ts` would send it.
export default eventHandler((event) => {
  if ((getRequestHeader(event, 'accept') ?? '').includes('text/event-stream')) return mcpMethodNotAllowed(event);
  const base = (useRuntimeConfig().app?.baseURL || '/').replace(/\/+$/, '');
  return sendRedirect(event, `${base}/settings/mcp`, 302);
});
