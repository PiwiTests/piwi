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

/** What stands for a value Piwi hides as it writes a page's or a response's values out: a mock, a list, a snapshot. */
export const HIDDEN_VALUE = '<hidden>';

/** The words of a name that hold a credential, in any case and spelling: `accessToken`, `api_key`, `X-Amz-Signature`. */
const SECRET_WORDS = new Set([
  'pass',
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'secret',
  'secrets',
  'token',
  'tokens',
  'jwt',
  'bearer',
  'sig',
  'signature',
  'key',
  'keys',
  'apikey',
  'auth',
  'oauth',
  'authorization',
  'session',
  'sessionid',
  'sid',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'otp',
  'refresh',
  'csrf',
  'xsrf',
]);

/** The names that hold one as a whole: OAuth's `code`, a `pin`. */
const SECRET_NAMES = new Set(['code', 'pin']);

/** A name's words, lower case: `accessToken`, `access_token` and `Access-Token` are `access` and `token`. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Whether a field or a query parameter is named like a credential: one of its words is a password's, a token's, a
 * secret's, a key's, a signature's, a session's, a cookie's or an authorization's (`password`, `refreshToken`,
 * `apiKeys`, `X-Amz-Signature`), or it is OAuth's `code` or a `pin`. Pure.
 */
export function isSecretName(name: string): boolean {
  return SECRET_NAMES.has(name.trim().toLowerCase()) || nameWords(name).some((word) => SECRET_WORDS.has(word));
}

/** The shapes of a credential, found anywhere in a text: a JWT, a bearer token, a known service's key. */
const SECRET_SHAPES: readonly RegExp[] = [
  /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g,
  /\bBearer\s+[\w.~+/-]{8,}=*/gi,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[\w-]{30,}/g,
  /\bgh[opsu]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_\w{20,}/g,
  /\bxox[abprs]-[\w-]{8,}/g,
];

/** A run of 32 or more characters a key or a token is written in, to test as a random one. */
const TOKEN_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

/**
 * Whether a run of characters reads as a random token: upper and lower case letters and digits mixed, no run of six
 * letters of one case (a long identifier has them), and at least 4 bits of entropy a character. A UUID, a hex hash
 * and a camel-case name do not.
 */
function looksRandom(text: string): boolean {
  if (!/[A-Z]/.test(text) || !/[a-z]/.test(text) || !/\d/.test(text)) return false;
  if (/[a-z]{6}|[A-Z]{6}/.test(text)) return false;
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits >= 4;
}

/** Whether a value, as a whole, is shaped like a credential: a JWT, a bearer token, a known key, a random token. */
export function isSecretValue(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 4096) return false;
  const whole = (re: RegExp) => {
    const found = text.match(new RegExp(`^(?:${re.source})$`, re.flags.replace('g', '')));
    return !!found;
  };
  return SECRET_SHAPES.some(whole) || (/^[A-Za-z0-9+/_-]{32,}={0,2}$/.test(text) && looksRandom(text));
}

/** A query parameter in a text (`?token=…`, `&code=…`), and the password of a URL (`//user:secret@`). */
const QUERY_PAIR = /([?&;])([^=&#?;\s"'<>]{1,256})=([^&#\s"'<>]*)/g;
const URL_PASSWORD = /(\/\/[^/:@\s"'<>]{1,256}:)([^@/\s"'<>]{1,256})(@)/g;

/**
 * `text` with each credential in it written as {@link HIDDEN_VALUE}: a credential's shape anywhere (`isSecretValue`),
 * the value of a query parameter named or shaped like one, and the password of a URL. `count.n` counts what was
 * hidden. Pure.
 */
export function hideSecretsInText(text: string, count: { n: number } = { n: 0 }): string {
  const hide = () => {
    count.n++;
    return HIDDEN_VALUE;
  };
  let out = text.replace(QUERY_PAIR, (all, sep: string, name: string, value: string) => {
    if (!value || value === HIDDEN_VALUE) return all;
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // Read as written.
    }
    return isSecretName(name) || isSecretValue(decoded) ? `${sep}${name}=${hide()}` : all;
  });
  out = out.replace(URL_PASSWORD, (_all, before: string, _password: string, at: string) => `${before}${hide()}${at}`);
  for (const shape of SECRET_SHAPES) out = out.replace(shape, () => hide());
  return out.replace(TOKEN_RUN, (run) => (looksRandom(run) ? hide() : run));
}

/**
 * Whether a text holds what looks like an email address or a phone number: an address, an international number
 * (`+33 6 12 34 56 78`), a North American one (`(555) 123-4567`), or a field named for one (`"phone":`, `email=`).
 */
export function holdsPersonalData(text: string): boolean {
  return (
    /(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){0,8}\.[a-z]{2,24}\b/i.test(text) ||
    /(?<![\w+])\+\d[\d ().-]{7,18}\d(?!\d)/.test(text) ||
    /\(\d{3}\)\s?\d{3}[ .-]\d{4}\b/.test(text) ||
    /["'&?]?\b(?:e-?mail|phone|phone_?number|mobile|tel|telephone)["']?\s*[:=]/i.test(text)
  );
}
