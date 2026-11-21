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

The document is fetched from an address the client chooses, before anyone signed in, by an instance that may sit
inside a private network: the fetch is a server-side request forgery vector, and its DNS lookup holds a thread of the
pool the server shares with password hashing and the file system. Some instances have no internet access, or reach it
only through a proxy, and a client that sees documents advertised signs in through them alone: it cannot fall back to
registering once the fetch fails.

## Decision

- **Documents are accepted only once `PIWI_MCP_CLIENT_METADATA_DOCUMENTS=true`, next to dynamic registration, never
  instead of it.** Off, the default, the metadata advertises nothing new and the instance makes no such request. On,
  it advertises `client_id_metadata_document_supported: true`, and `registration_endpoint` stays.
- **A `client_id` names a document when it is an `https` URL on the default port with a path, no credentials, no query
  and no fragment, written as a URL parser writes it back**, so the document's own `client_id` is compared with one
  spelling (`isClientMetadataUrl`, `server/utils/mcp-oauth-client-metadata.ts`).
- **The document is fetched at the authorize endpoint only, once the rest of the request checked out** (the response
  type, PKCE, `state`, `resource` and a `redirect_uri` named), **through `safeFetch`**: a public address alone, checked
  again as the socket connects (DNS rebinding), no redirect followed, 5 KiB at most (the draft's recommendation), and
  one deadline of 5 seconds for the whole fetch, its DNS lookups included. At most two fetches run at once, a lookup
  the deadline gave up on counting until it ends; a third is refused. The endpoint's rate limit counts an IPv6 client by
  its /64. The token and revocation endpoints read the client row the authorization wrote.
- **The document must describe a public client fully**: its `client_id` is the URL it came from, it has a
  `client_name` with something left to show once cleaned and `redirect_uris` that registration would accept
  (`parseRedirectUris`), asks for the code flow alone, authenticates with `none` and holds no secret. Anything else
  lands on the consent page as `invalid_client_metadata`, never back at the client.
- **The client is kept as a row of `oauth_clients` whose `client_id` is the URL**, written from the document at each
  authorization: the consent page, the token endpoint and the nightly prune work as for a registered client, and no
  migration is needed. A new row prunes first, as a registration does.
- **Each sign-in of such a client is a connection of its own.** Every installation of the client shares its
  `client_id`, so signing in on a second machine never ends the first machine's grant, as it does for a registered
  client; a connection ends 30 days after its last use, or when the user revokes it.
- **A document is kept in memory as long as its `Cache-Control` allows**: five minutes without a `max-age`, between
  one minute and a day with one, not at all with `no-store`, `no-cache` or `max-age=0`, 200 documents at most.
- **The consent page names the host that published the document**, under the name the client gives itself, which stays
  marked as self-asserted, and warns that any program on the computer can name the document when the answer goes to
  a loopback address.
- **Turning documents off makes a URL `client_id` an unknown client again**: its authorization, refresh and
  revocation are refused, and its access tokens stop working at their next request. Its connections stay listed with
  the user's API keys until they expire or the user revokes them.

## Consequences

- An instance that turns documents on makes an outgoing request to an address an unauthenticated client names,
  bounded by the authorize endpoint's rate limit, the two fetches at once and the guard above. It must reach the
  internet directly: `safeFetch` follows no proxy.
- `private_key_jwt` client authentication, which the draft allows, is not supported: a document asking for it is
  refused.
- A user who signs in from many machines, or again on the same one, sees a connection for each sign-in until the
  unused ones expire.
- Dynamic registration is removed only once the specification removes it, in a change of its own.
