// OAuth Client ID Metadata Documents for MCP clients
// (draft-ietf-oauth-client-id-metadata-document, the MCP authorization
// specification from 2025-11-25): a client whose `client_id` is an HTTPS URL
// names the JSON document that describes it, which this server fetches at the
// authorize endpoint instead of the client registering first. The document is
// fetched through the SSRF guard of `safe-fetch.ts` (a public address only,
// checked again as the socket connects), with no redirect, a size cap and a
// timeout, and kept in memory for as long as its `Cache-Control` allows,
// within bounds. `PIWI_MCP_CLIENT_METADATA_DOCUMENTS=false` turns it off for an
// instance that cannot or should not reach the internet; dynamic registration
// stays either way.

import { safeFetch } from './safe-fetch';
import { cleanClientName, cleanClientUri, clientTypesProblem, parseRedirectUris } from './mcp-oauth-helpers';

/** The longest document read, in bytes. */
export const CLIENT_METADATA_MAX_BYTES = 16 * 1024;
/** How long a fetch may take. */
export const CLIENT_METADATA_TIMEOUT_MS = 5000;
/** How long a document is kept without a `max-age`, and the bounds a `max-age` is held to. */
export const CLIENT_METADATA_CACHE_MS = { default: 5 * 60_000, min: 60_000, max: 24 * 60 * 60_000 } as const;
/** The most documents kept at once: the oldest goes first. */
const MAX_CACHED = 200;
const MAX_URL_LENGTH = 2000;

/** Whether this instance accepts clients identified by a metadata document. */
export function clientMetadataDocumentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PIWI_MCP_CLIENT_METADATA_DOCUMENTS !== 'false';
}

/**
 * Whether a `client_id` names a metadata document: an `https` URL with a path,
 * no credentials, no fragment, in the form a URL parser writes it back (so the
 * document's own `client_id` is compared with one spelling).
 */
export function isClientMetadataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || !value.startsWith('https://')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.href === value &&
    url.protocol === 'https:' &&
    url.pathname !== '/' &&
    !url.username &&
    !url.password &&
    !url.hash
  );
}

/** What this server keeps of a client's metadata document. */
export interface ClientMetadata {
  clientName: string;
  clientUri: string | null;
  redirectUris: string[];
}

/**
 * A fetched document read as a public client's metadata, or why it is refused:
 * its `client_id` must be the URL it came from, it names the client and its
 * redirect URIs, asks for the code flow alone and holds no secret.
 */
export function parseClientMetadata(url: string, document: unknown): ClientMetadata | { problem: string } {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { problem: 'the document is not a JSON object' };
  }
  const metadata = document as Record<string, unknown>;
  if (metadata.client_id !== url) return { problem: 'the document’s client_id is not the URL it was fetched from' };
  if (typeof metadata.client_name !== 'string' || !metadata.client_name.trim()) {
    return { problem: 'the document has no client_name' };
  }
  const redirect = parseRedirectUris(metadata.redirect_uris);
  if ('problem' in redirect) return { problem: redirect.problem };
  const types = clientTypesProblem(metadata);
  if (types) return { problem: types };
  const method = metadata.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') {
    return { problem: 'a client identified by its metadata document authenticates with PKCE alone (none)' };
  }
  if (metadata.client_secret !== undefined || metadata.client_secret_expires_at !== undefined) {
    return { problem: 'a metadata document holds no client secret' };
  }
  return {
    clientName: cleanClientName(metadata.client_name),
    clientUri: cleanClientUri(metadata.client_uri),
    redirectUris: redirect.uris,
  };
}

/** How long a response may be kept, from its `Cache-Control`: 0 for `no-store` or `no-cache`. */
export function cacheLifetimeMs(cacheControl: string | null): number {
  const value = (cacheControl ?? '').toLowerCase();
  if (/(?:^|,)\s*(?:no-store|no-cache)\s*(?:,|$)/.test(value)) return 0;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/.exec(value);
  if (!maxAge) return CLIENT_METADATA_CACHE_MS.default;
  const ms = Number(maxAge[1]) * 1000;
  return Math.min(CLIENT_METADATA_CACHE_MS.max, Math.max(CLIENT_METADATA_CACHE_MS.min, ms));
}

/** A response's body as text, refused past `max` bytes without reading further. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) return null;
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The fetch a document goes through: `safeFetch` with no redirect followed. */
export type MetadataFetch = (
  url: string,
  init: RequestInit,
  maxRedirects: number,
  timeoutMs: number,
) => Promise<Response>;

const cache = new Map<string, { metadata: ClientMetadata; expiresAt: number }>();

/** Forget every document kept: for tests. */
export function clearClientMetadataCache(): void {
  cache.clear();
}

/**
 * The metadata of the client a document URL names: kept from an earlier fetch
 * while fresh, else fetched and checked. Never throws: an address the guard
 * refuses, a redirect, a status other than 200, a body too long or not JSON,
 * a timeout and a document that does not check out are each a `problem`.
 */
export async function resolveClientMetadata(
  url: string,
  now = Date.now(),
  fetcher: MetadataFetch = safeFetch,
): Promise<ClientMetadata | { problem: string }> {
  const kept = cache.get(url);
  if (kept && kept.expiresAt > now) return kept.metadata;
  cache.delete(url);
  let res: Response;
  try {
    res = await fetcher(url, { headers: { accept: 'application/json' } }, 0, CLIENT_METADATA_TIMEOUT_MS);
  } catch (err) {
    return { problem: `the document could not be fetched: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return { problem: `the document’s address answered ${res.status}` };
  }
  let text: string | null;
  try {
    text = await readCapped(res, CLIENT_METADATA_MAX_BYTES);
  } catch {
    return { problem: 'the document could not be read' };
  }
  if (text === null) return { problem: `the document is longer than ${CLIENT_METADATA_MAX_BYTES / 1024} KiB` };
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { problem: 'the document is not JSON' };
  }
  const metadata = parseClientMetadata(url, document);
  if ('problem' in metadata) return metadata;
  const lifetime = cacheLifetimeMs(res.headers.get('cache-control'));
  if (lifetime > 0) {
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    cache.set(url, { metadata, expiresAt: now + lifetime });
  }
  return metadata;
}
