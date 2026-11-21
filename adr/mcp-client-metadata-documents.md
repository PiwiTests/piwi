# MCP clients identified by a client ID metadata document

- Status: accepted
- Date: 2026-11-21

A design record for letting an MCP client sign in to an instance with a client ID metadata document, next to the
dynamic client registration of [mcp-oauth.md](mcp-oauth.md), which it extends and does not replace.

## Context

MCP clients sign in through the instance's own authorization server ([mcp-oauth.md](mcp-oauth.md)) after registering
through dynamic client registration (RFC 7591), which is open to anyone. The MCP authorization specification added
client ID metadata documents in `2025-11-25` (draft-ietf-oauth-client-id-metadata-document): the client's `client_id`
is an HTTPS URL, and the authorization server fetches the JSON document there to learn the client's name and redirect
URIs. Revision `2026-07-28` made them the recommended way and deprecated dynamic registration, which stays in the
specification for at least twelve months. A client uses a document when the authorization server metadata advertises
`client_id_metadata_document_supported`, and registers otherwise.

The document is fetched from an address the client chooses, by an instance that may sit inside a private network:
the fetch is a server-side request forgery vector, and some instances have no internet access at all.

## Decision

- **Documents are accepted next to dynamic registration, never instead of it.** The metadata advertises
  `client_id_metadata_document_supported: true`, and `registration_endpoint` stays.
- **A `client_id` names a document when it is an `https` URL with a path, no credentials and no fragment, written as
  a URL parser writes it back**, so the document's own `client_id` is compared with one spelling
  (`isClientMetadataUrl`, `server/utils/mcp-oauth-client-metadata.ts`).
- **The document is fetched at the authorize endpoint only, through `safeFetch`**: a public address alone, checked
  again as the socket connects (DNS rebinding), no redirect followed, 16 KiB at most, 5 seconds at most. The token and
  revocation endpoints read the client row the authorization wrote.
- **The document must describe a public client fully**: its `client_id` is the URL it came from, it has a
  `client_name` and `redirect_uris` that registration would accept (`parseRedirectUris`), asks for the code flow
  alone, authenticates with `none` and holds no secret. Anything else lands on the consent page as
  `invalid_client_metadata`, never back at the client.
- **The client is kept as a row of `oauth_clients` whose `client_id` is the URL**, written from the document at each
  authorization: grants, the consent page, the token endpoint and the nightly prune work as for a registered client,
  and no migration is needed. A new row prunes first, as a registration does.
- **A document is kept in memory as long as its `Cache-Control` allows**: five minutes without a `max-age`, between
  one minute and a day with one, not at all with `no-store` or `no-cache`, 200 documents at most.
- **The consent page names the host that published the document**, beside the name it gives itself and where the
  answer goes.
- **`PIWI_MCP_CLIENT_METADATA_DOCUMENTS=false` turns it off**, for an instance that cannot or should not reach the
  internet: the metadata no longer advertises it, a URL `client_id` is an unknown client, before and after it signed
  in, and clients register.

## Consequences

- An instance that allows them makes an outgoing request to an address an unauthenticated client names, bounded by
  the authorize endpoint's rate limit and the guard above. An administrator who wants none turns them off.
- `private_key_jwt` client authentication, which the draft allows, is not supported: a document asking for it is
  refused.
- Dynamic registration is removed only once the specification removes it, in a change of its own.
