import { protectedResourceMetadata } from '../../utils/mcp-oauth-helpers';
import { requireMcpOAuthEnabled } from '../../utils/mcp-oauth';
import { publicBaseUrl } from '../../utils/public-base-url';

defineRouteMeta({
  openAPI: {
    tags: ['MCP OAuth'],
    summary: 'Protected resource metadata of the MCP server',
    description:
      'OAuth 2.0 Protected Resource Metadata (RFC 9728) for `/mcp`: the resource URL, the authorization server (this instance) and the `mcp` scope. Also served at `/.well-known/oauth-protected-resource/mcp`, the address the MCP endpoint names in its `WWW-Authenticate` challenge. 404 when authentication is off.',
    security: [],
  },
});

export default eventHandler((event) => {
  requireMcpOAuthEnabled();
  return protectedResourceMetadata(publicBaseUrl(event));
});
