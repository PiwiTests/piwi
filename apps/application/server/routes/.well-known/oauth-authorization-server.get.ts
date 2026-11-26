import { authorizationServerMetadata } from '../../utils/mcp-oauth-helpers';
import { requireMcpOAuthEnabled } from '../../utils/mcp-oauth';
import { clientMetadataDocumentsEnabled } from '../../utils/mcp-oauth-client-metadata';
import { publicBaseUrl } from '../../utils/public-base-url';

defineRouteMeta({
  openAPI: {
    tags: ['MCP OAuth'],
    summary: 'Authorization server metadata',
    description:
      'OAuth 2.0 Authorization Server Metadata (RFC 8414) of the server MCP clients sign in through: the authorization, token, registration and revocation endpoints, the authorization code and refresh token grants, PKCE with S256, public clients or `client_secret_post` / `client_secret_basic`, and `client_id_metadata_document_supported` when `PIWI_MCP_CLIENT_METADATA_DOCUMENTS` is `true` (a client may then name its metadata document’s HTTPS URL as its `client_id` instead of registering). 404 when authentication is off.',
    security: [],
  },
});

export default eventHandler((event) => {
  requireMcpOAuthEnabled();
  return authorizationServerMetadata(publicBaseUrl(event), {
    clientMetadataDocuments: clientMetadataDocumentsEnabled(),
  });
});
