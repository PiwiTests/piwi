# Signing MCP clients in through OAuth

- Status: accepted
- Date: 2026-10-08

A design record for letting an MCP client (Claude Code, Cursor, VS Code, Gemini CLI, Claude Desktop through
`mcp-remote`, a claude.ai connector) connect to an instance with authentication on by signing in through the browser,
as remote MCP servers such as Atlassian's do, instead of pasting an API key into its configuration.

## Problem

Connecting an agent today takes an API key: create it in the dashboard, copy it, paste it into the client's
configuration file or command line. The key never expires, sits in plain text in a dotfile that is often committed by
mistake, and works on the whole REST API, not only on the MCP server. Clients already know a better way: the MCP
authorization specification (protocol version 2025-06-18) has a client discover the server's authorization server
from a 401, register itself, open a sign-in page in the browser, and receive short-lived tokens it renews on its own.
Piwi had no authorization server for them to find.

## The flow

The instance is both the MCP server (the protected resource) and its authorization server. OAuth 2.1, with:

1. The client calls `POST /mcp` without a token. The 401 carries
   `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource/mcp", scope="mcp"`.
2. The client reads the protected resource metadata (RFC 9728), which names this instance as the authorization
   server, then its authorization server metadata (RFC 8414) at `/.well-known/oauth-authorization-server`.
3. It registers through dynamic client registration (RFC 7591), `POST /oauth/register`, and receives a `client_id`.
4. It opens `GET /oauth/authorize` in the browser with a PKCE challenge (S256), its `state` and the `resource`
   (RFC 8707). The instance checks the request, stores it, and sends the browser to `/oauth/consent?request=<id>`;
   a request it refuses goes to `/oauth/consent?error=<code>` instead, never back to the client.
5. That page requires a session: signing in, with a password or through Google or GitHub, comes back to it. It shows
   the name the client registered, where the answer is sent and the account, with **Allow** and **Deny**.
6. The answer sends the browser back to the client's redirect URI with a code (or `access_denied`), its `state`, and
   `iss` (RFC 9207).
7. The client redeems the code at `POST /oauth/token` with the PKCE verifier and receives an access token (`pdo_`,
   one hour) and a refresh token (`pdr_`, 30 days from its last use, replaced on each use). A client that signs in
   again replaces its earlier connection for the same user.
8. It calls `/mcp` with the access token. An expired one answers 401 with `error="invalid_token"`, and the client
   refreshes.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /.well-known/oauth-protected-resource[/mcp]` | public | RFC 9728 metadata of `/mcp` |
| `GET /.well-known/oauth-authorization-server` | public | RFC 8414 metadata |
| `POST /oauth/register` | public | RFC 7591 registration |
| `GET /oauth/authorize` | public (a browser navigation) | Checks and stores the request, redirects to the consent page, or there with the error |
| `POST /oauth/token` | the client (PKCE, or its secret) | `authorization_code` and `refresh_token` grants |
| `POST /oauth/revoke` | the client | RFC 7009 revocation: ends the connection |
| `GET /api/oauth/authorizations/:id` | any signed-in user | What the consent page shows |
| `POST /api/oauth/authorizations/:id/decision` | any signed-in user | `{ allow }` → `{ status, redirectTo }` |

The protocol endpoints answer the OAuth error shape, `{ error, error_description }` with 400 or 401, not Piwi's
`apiError` shape: clients branch on the OAuth codes. They live outside `/api/` because they are the standard addresses
clients derive, not Piwi's REST API. Every one of them answers 404 with authentication off: the MCP endpoint then
accepts every request, so there is nothing to sign in to.

## Tables

- **`oauth_clients`**: `client_id`, the secret's hash when the client asked for one, the self-asserted name and
  `client_uri`, the registered redirect URIs, `last_used_at`.
- **`oauth_authorization_requests`**: one row per authorization request, `pending` → `approved` or `denied` →
  `consumed`, with the request id's hash, the client, the redirect URI, `state`, the PKCE challenge, the resource,
  who decided, the code's hash and the grant the code created.
- **`oauth_grants`**: one connection of one client for one user: the hashes of the current access and refresh tokens
  and of the previous refresh token, their expiries, the response of the last refresh (sealed, see the grace period
  below), and the API key row that represents it.

`pruneMcpOAuth` runs in the nightly retention sweep and at each registration (which is open, so it is what keeps the
client table bounded): it deletes requests expired for more than a day, grants whose refresh token expired (with their
keys, so the connection leaves the user's list), and clients idle for 30 days with no connection.

## The connection is an API key

Each grant owns an `api_keys` row, named after the client, whose own value is never handed out. It is what carries the
user's role and project access, what the agents' write log names, what `last_used_at` records, and what the user sees
in their API keys, marked as an MCP client signed in through OAuth. Deleting it there deletes the grant through the
foreign key, which is how a user disconnects a client; the revocation endpoint, a replayed code and a replayed refresh
token delete it the same way. Nothing new in the write log, the cluster activity or the key list had to learn a second
kind of credential.

## Security choices

- **PKCE is required**, S256 only, for every client, public or not.
- **Audience.** Access tokens authenticate `/mcp` and nothing else: `requireMcpAuth` accepts them, `requireAuth`
  never does, so the REST API answers 401. A `resource` that is not this instance's `/mcp` is refused
  (`invalid_target`); its query, such as `?modules=core`, is ignored.
- **Hashes only.** The request id, the code, both tokens and a client secret are stored as SHA-256 hashes. The one
  exception is the grace period's copy of the last token response, sealed with AES-256-GCM under a key derived from
  the refresh token it replaced (an HMAC, not the stored SHA-256): the database holds nothing that opens it.
- **Lifetimes.** A request waits ten minutes for an answer; a code is redeemable for five minutes, once.
- **Replay.** A code presented twice is refused and ends the grant it created (RFC 6749 §4.1.2). The grant is created
  before the code is claimed, and the claim records it in the same conditional update, so a replay always finds the
  grant to end. A refresh token already exchanged ends the grant, for whoever holds the newer one (OAuth 2.1 refresh
  token rotation), once its **grace period** of one minute is over. Within that minute it answers with the tokens it
  was exchanged for: a client with several requests in flight when its access token expires refreshes them all with
  the same token, and ending the grant then would sign the user out every hour. A thief holding a copied token gains
  nothing in that minute that the client did not just receive.
- **Redirect URIs.** `https`, `http` on a loopback host, or an application's own scheme (`cursor://`, `vscode://`);
  never a fragment, never `javascript:`, `data:`, `file:` and the like, nor an operating system handler that opens
  files or runs programs (`search-ms:`, `intent:`, every `ms-` scheme). A loopback URI matches on any port
  (RFC 8252 §7.3), since a native client listens where it can.
- **No redirect before the user answers.** Anyone can register a redirect URI, so the authorize endpoint never sends
  an error there (RFC 9700 §4.11.2): it would turn the instance into an open redirector to any site or application.
  Every refusal (an unknown client, an unregistered redirect URI, no PKCE, another resource) lands on the consent page,
  which explains it; only the user's Allow or Deny sends the browser to the client.
- **Consent.** Every authorization asks; nothing is remembered per client. The page never answers on load: Allow is a
  POST from a signed-in page, with the session cookie's `SameSite=Lax` keeping another site from sending it. Since
  anyone can register a client under any name, the page labels the name as the client's own and says where the answer
  goes (a web site's host, an application on this computer, or the application of a scheme), and tells the user to
  deny a request they did not start.
- **No CORS.** The token and registration endpoints refuse a cross-site browser request, like every other write
  (`server/middleware/cross-site.ts`). Clients run outside a page (a CLI, a desktop app, a provider's server), so
  none is affected; an MCP inspector running in a browser tab is.
- **Rate limits**, per client address and ten minutes: 20 registrations, 60 authorizations, 120 token and revocation
  requests; 20 failed consent-page lookups per user.

## What freezes at 1.0

The endpoint addresses, the metadata fields, the token prefixes, the scope name `mcp` and the token response. They are
standards, so an older client keeps working; recorded as D53 in [`1.0-stabilization.md`](../proposals/1.0-stabilization.md).

## Not in this change

- **OpenID Connect** (ID tokens, `userinfo`, a JWKS): MCP clients need access tokens, not an identity; an instance is
  not an identity provider for other applications.
- **Client ID Metadata Documents** (MCP protocol version 2025-11-25): registration covers today's clients, and a
  metadata document means fetching a URL the client names.
- **Narrower scopes** (read-only, one project): keys have none either; adding them is its own decision for both.
- **A sub-path deployment** (`PIWI_SITE_URL` with a path): RFC 8414 puts that issuer's metadata at the host's root,
  outside the app.
