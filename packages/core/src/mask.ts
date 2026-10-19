/**
 * Masking for token-shaped strings (base64 data URIs, JWTs, long hex blobs) in
 * any user-derived text that reaches storage or the dashboard. Kept in core so
 * both producers agree: the reporter masks step params and subtitles as it
 * flattens them, and the server re-masks the same values on ingest.
 */

const DATA_URI_RE = /\bdata:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const JWT_RE = /\beyJ[\w-]{10,}\.[\w-]{5,}\.[\w-]{5,}\b/g;
const LONG_HEX_RE = /\b[0-9a-f]{32,}\b/gi;

/** Replace base64 data URIs, JWTs and long hex blobs with fixed markers. Pure. */
export function maskTokenLike(text: string): string {
  return text
    .replace(DATA_URI_RE, 'data:[masked]')
    .replace(JWT_RE, '[masked-token]')
    .replace(LONG_HEX_RE, '[masked-hex]');
}

/** Parameter names that carry a credential: OAuth's implicit flow, magic links, signed links. */
const CREDENTIAL_PARAM_RE =
  /token|code|secret|password|passwd|pwd|key|session|auth|sig|credential|assertion|nonce|otp|jwt/i;

/**
 * A URL fragment (`#…`) with every credential masked: the value of each `key=value` parameter whose name or value
 * looks like one (`#access_token=…`, `#/callback?code=…`), and a token-shaped part of the route. A route-like fragment
 * (`#/cart/12`) stays as it is. Pure.
 */
export function maskUrlFragment(hash: string): string {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const query = body.indexOf('?');
  const route = query >= 0 ? body.slice(0, query) : body.includes('=') ? '' : body;
  const params = query >= 0 ? body.slice(query + 1) : body.includes('=') ? body : null;
  const masked =
    params === null
      ? null
      : params
          .split('&')
          .map((param) => {
            const eq = param.indexOf('=');
            if (eq < 0) return maskTokenLike(param);
            const name = param.slice(0, eq);
            const value = param.slice(eq + 1);
            return `${name}=${value && CREDENTIAL_PARAM_RE.test(name) ? '[masked]' : maskTokenLike(value)}`;
          })
          .join('&');
  const out = maskTokenLike(route) + (masked === null ? '' : query >= 0 ? `?${masked}` : masked);
  return hash.startsWith('#') ? `#${out}` : out;
}
