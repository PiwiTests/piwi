/**
 * Masking for token-shaped strings (base64 data URIs, JWTs, long hex blobs) in
 * any user-derived text that reaches storage or the dashboard. Kept in core so
 * both producers agree: the reporter masks step params and subtitles as it
 * flattens them, and the server re-masks the same values on ingest.
 */

import { tryParseLocatorChain } from './locator-chain';

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

/**
 * What stands for a value Piwi hides as it writes a page's or a response's values out: a mock, the responses a stopped
 * test kept, a region's snapshot, a held failure's error. What it hides, and what it keeps:
 *
 * - **By name**: the whole value of a query parameter, a form field or a JSON field named like a credential
 *   (`isSecretName`: a password's, a token's, a secret's, a key's, a signature's, a session's, a cookie's, an
 *   authorization's word, OAuth's `code`, a `pin`), whatever it holds.
 * - **By shape, anywhere**: a value with a credential's strong signal (`SECRET_SHAPES`: a JWT, `Bearer …`, `Basic` with
 *   the base64 of `user:password`, a PEM private key, the value a `Set-Cookie:` or `Cookie:` line sets, a key with a
 *   service's prefix: `sk_live_`, `sk-proj-`, `glpat-`, `ghp_`, `github_pat_`, `xoxb-`, `npm_`, `whsec_`, `AKIA`,
 *   `AIza`, Twilio's `SK` and 32 hex digits, and a key or a token Piwi issues: `pd_`, `pdc_`, `pda_`, `pdo_`, `pdr_`,
 *   `mcps_`, `psl_` or `pwt_` and hex digits, `pdl_` and base64url), a color code before it or not, and a random token
 *   (`looksRandom`): 40 characters or more of base64 or base64url, upper and lower case letters and digits mixed, 4
 *   bits of entropy a character or more, at most a fifth of its letters in runs of six of one case (the words of an
 *   identifier), and not the base64 of text.
 * - **In a URL, part by part** (`hideSecretsInUrl`): never its scheme, host or port; its password; a query or fragment
 *   value named or shaped like a credential; a path segment only when it is itself shaped like one.
 *
 * Kept as they are: ids, hashes and slugs (a UUID, a number, a git SHA and any hex hash, an id of fewer than 40
 * characters such as a Drive file's), and base64 that encodes text (a pagination cursor).
 */
export const HIDDEN_VALUE = '<hidden>';

/**
 * The `autocomplete` tokens of a field whose value is never written down, beside a password field's: a password, a
 * one-time code, a card's number or security code. The recorder and Assert a region read them alike.
 */
export const SECRET_AUTOCOMPLETE: readonly string[] = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
];

/**
 * The CSS selector of the fields whose value is a secret: a password field, and one whose `autocomplete` asks for a
 * password, a one-time code or a card's number or security code (`SECRET_AUTOCOMPLETE`), in any case.
 */
export const SECRET_FIELD_SELECTOR = [
  'input[type="password" i]',
  ...SECRET_AUTOCOMPLETE.flatMap((token) => [
    `input[autocomplete~="${token}" i]`,
    `textarea[autocomplete~="${token}" i]`,
  ]),
].join(', ');

/** Whether an `autocomplete` attribute names a secret among its tokens (`SECRET_AUTOCOMPLETE`). Pure. */
export function isSecretAutocomplete(value: string | null | undefined): boolean {
  return (value ?? '')
    .toLowerCase()
    .split(/\s+/)
    .some((token) => SECRET_AUTOCOMPLETE.includes(token));
}

/** The words of a name that hold a credential, in any case and spelling: `accessToken`, `api_key`, `X-Amz-Signature`. */
const SECRET_WORDS = new Set([
  'pass',
  'password',
  'passwd',
  'passphrase',
  'passcode',
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
  'jsessionid',
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
    .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1 ')
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
  let secret = namesRead.get(name);
  if (secret === undefined) {
    secret = SECRET_NAMES.has(name.trim().toLowerCase()) || nameWords(name).some((word) => SECRET_WORDS.has(word));
    if (namesRead.size >= 1024) namesRead.clear();
    namesRead.set(name, secret);
  }
  return secret;
}

/** The names read last, and whether each is a credential's: a body or a query repeats its names. */
const namesRead = new Map<string, boolean>();

/**
 * The shapes of a credential with a strong signal, found anywhere in a text: a JWT, a bearer token, a service's key, a
 * key or a token Piwi issues. Each with what every match of it starts with, in the case its pattern reads it.
 */
const SHAPES: ReadonlyArray<{ re: RegExp; starts: readonly string[] }> = [
  { re: /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, starts: ['eyJ'] },
  { re: /\bBearer(?:\s+|%20)[\w.~+/-]{8,}=*/gi, starts: ['Bearer'] },
  {
    re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
    starts: ['sk_live_', 'sk_test_', 'rk_live_', 'rk_test_'],
  },
  { re: /\bwhsec_[A-Za-z0-9]{20,}/g, starts: ['whsec_'] },
  { re: /\bsk-(?=[\w-]{0,200}\d)(?=[\w-]{0,200}[A-Z])[\w-]{32,}/g, starts: ['sk-'] },
  { re: /\bglpat-[\w-]{20,}/g, starts: ['glpat-'] },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/g, starts: ['npm_'] },
  { re: /\bSK[0-9a-f]{32}\b/g, starts: ['SK'] },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, starts: ['AKIA'] },
  { re: /\bAIza[\w-]{30,}/g, starts: ['AIza'] },
  { re: /\bgh[opsu]_[A-Za-z0-9]{20,}/g, starts: ['gho_', 'ghp_', 'ghs_', 'ghu_'] },
  { re: /\bgithub_pat_\w{20,}/g, starts: ['github_pat_'] },
  { re: /\bxox[abprs]-[\w-]{8,}/g, starts: ['xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-'] },
  // Piwi's: an API key or the desktop app's token, an extension's device code, an MCP client's secret, authorization
  // code, access and refresh tokens, a share link's and an assistant turn's token; a live view's key.
  {
    re: /\b(?:pd[acor]?|mcps|psl|pwt)_[0-9a-f]{32,}/g,
    starts: ['pd_', 'pda_', 'pdc_', 'pdo_', 'pdr_', 'mcps_', 'psl_', 'pwt_'],
  },
  { re: /\bpdl_[\w-]{40,}/g, starts: ['pdl_'] },
];

const SECRET_SHAPES: readonly RegExp[] = SHAPES.map((shape) => shape.re);

/**
 * What a credential's shape (`hideSecretShapes`) starts with, and whether in any case: a text holding none of them
 * holds no shape of a credential. A store reads the texts that may hold one through them.
 */
export const SECRET_SHAPE_STARTS: ReadonlyArray<{ start: string; anyCase: boolean }> = SHAPES.flatMap(
  ({ re, starts }) => starts.map((start) => ({ start, anyCase: re.flags.includes('i') })),
);

/**
 * The same shapes right after a color code (`\u001b[32msk_live_…`), whose `m` would join the shape's first word, the
 * code kept apart.
 */
const COLORED_SHAPES: readonly RegExp[] = SECRET_SHAPES.map(
  (re) => new RegExp(`(\\u001b\\[[\\d;]*m)${re.source.replace(/^\\b/, '')}`, re.flags),
);

/** The same shapes, each matching a whole value. */
const WHOLE_SHAPES: readonly RegExp[] = SECRET_SHAPES.map(
  (re) => new RegExp(`^(?:${re.source})$`, re.flags.replace('g', '')),
);

/** `Basic` and the base64 of `user:password`, as an `Authorization` header sends them. */
const BASIC = /\bBasic\s+([A-Za-z0-9+/]{4,}={0,2})(?![\w+/=])/g;

/** A PEM block's first line, of a private key. */
const PEM_BEGIN = /-----BEGIN ([A-Z0-9 ]{0,40}PRIVATE KEY)-----/g;

/** A cookie a `Set-Cookie:` line sets, and every value of a `Cookie:` line. */
const SET_COOKIE = /(\bSet-Cookie:[ \t]*[^=;\s]{1,256}=)([^;\r\n]{1,4096})/gi;
const COOKIE_LINE = /((?<![\w-])Cookie:[ \t]*)([^\r\n]{1,16384})/gi;

/** A JSON field in a text that is not read as JSON: its name, and its string value. */
const JSON_FIELD = /("((?:[^"\\\r\n]|\\.){1,256})"\s*:\s*")((?:[^"\\\r\n]|\\.){1,4096})"/g;

/** A run of characters a key or a token is written in, to test as a random one; `=` pads base64. */
const TOKEN_RUN = /[A-Za-z0-9+/_-]{40,}={0,2}/g;

/** The shortest token `looksRandom` takes: a shorter random string reads as an id. */
const MIN_RANDOM = 40;

const BASE64_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Whether a run decodes, as base64 or base64url, to text: nine bytes in ten printable, as a cursor encodes. */
function base64OfText(run: string): boolean {
  let bits = 0;
  let acc = 0;
  let bytes = 0;
  let printable = 0;
  for (const c of run.replace(/=+$/, '')) {
    const digit = BASE64_DIGITS.indexOf(c === '-' ? '+' : c === '_' ? '/' : c);
    if (digit < 0) return false;
    acc = ((acc << 6) | digit) & 0xffff;
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    const byte = (acc >> bits) & 0xff;
    bytes++;
    if ((byte >= 0x20 && byte < 0x7f) || byte === 0x09 || byte === 0x0a || byte === 0x0d) printable++;
  }
  return bytes > 0 && printable * 10 >= bytes * 9;
}

/** The entropy of a text's characters, in bits a character. */
function bitsPerChar(text: string): number {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
  return bits;
}

/**
 * Whether a run of characters reads as a random token: `MIN_RANDOM` characters or more, upper and lower case letters
 * and digits mixed, at most a fifth of its letters in runs of six of one case (an identifier's words: a random token
 * of that length has few), at least 4 bits of entropy a character, and not the base64 of text (a cursor). A UUID, a
 * hex hash, a camel-case name and an id shorter than `MIN_RANDOM` do not.
 */
function looksRandom(text: string): boolean {
  if (text.length < MIN_RANDOM || !/[A-Z]/.test(text) || !/[a-z]/.test(text) || !/\d/.test(text)) return false;
  let letters = 0;
  for (const c of text) if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) letters++;
  let wordy = 0;
  for (const run of text.matchAll(/[a-z]{6,}|[A-Z]{6,}/g)) wordy += run[0].length;
  return wordy * 5 <= letters && bitsPerChar(text) >= 4 && !base64OfText(text);
}

/** Whether `Basic` is followed by the base64 of `user:password`. */
function isBasicCredential(encoded: string): boolean {
  const text = encoded.replace(/=+$/, '');
  if (text.length % 4 === 1) return false;
  let decoded = '';
  let bits = 0;
  let acc = 0;
  for (const c of text) {
    const digit = BASE64_DIGITS.indexOf(c);
    if (digit < 0) return false;
    acc = ((acc << 6) | digit) & 0xffff;
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    decoded += String.fromCharCode((acc >> bits) & 0xff);
  }
  return /^[\x20-\x7e]+:[\x20-\x7e]*$/.test(decoded);
}

/** Whether a value, as a whole, is shaped like a credential: a strong signal's shape, or a random token. */
export function isSecretValue(value: string): boolean {
  const text = value.trim();
  // No shape of a credential is shorter.
  if (text.length < 10 || text.length > 4096) return false;
  if (WHOLE_SHAPES.some((re) => re.test(text))) return true;
  const basic = /^Basic\s+([A-Za-z0-9+/]{4,}={0,2})$/.exec(text);
  if (basic && isBasicCredential(basic[1]!)) return true;
  if (/^-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/.test(text)) return true;
  return /^[A-Za-z0-9+/_-]{40,}={0,2}$/.test(text) && looksRandom(text);
}

/** A URL in a text: a scheme, `//` and what follows up to a space or a quote. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>`]+/gi;

/** A URL's parts: its scheme and authority (`//user:password@host:port`), path, query and fragment. */
const URL_PARTS = /^(?:([a-z][a-z0-9+.-]*:)?\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#[\s\S]*)?$/i;

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A counter of what was hidden, and the marker that stands for one more. */
function hider(count: { n: number }): () => string {
  return () => {
    count.n++;
    return HIDDEN_VALUE;
  };
}

/**
 * `text` with each credential's shape in it written as {@link HIDDEN_VALUE}, anywhere, a color code before it or not
 * (`SECRET_SHAPES`: a JWT, `Bearer …`, a service's key, a key or a token Piwi issues). The rest stays as it is.
 * `count.n` counts what was hidden. Pure.
 */
export function hideSecretShapes(text: string, count: { n: number } = { n: 0 }): string {
  const hide = hider(count);
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, () => hide());
  if (out.includes('\u001b[')) {
    for (const shape of COLORED_SHAPES) out = out.replace(shape, (_all, color: string) => `${color}${hide()}`);
  }
  return out;
}

/** Query or fragment parameters (`a=1&token=x;b=2`), each value named or shaped like a credential hidden. */
function hideParams(params: string, count: { n: number }): string {
  const hide = hider(count);
  return params
    .split(/([&;])/)
    .map((part, i) => {
      const eq = part.indexOf('=');
      if (i % 2 === 1 || eq < 0) return part;
      const name = part.slice(0, eq);
      const value = part.slice(eq + 1);
      const decoded = decodeSafe(value);
      if (!value || decoded === HIDDEN_VALUE) return part;
      return isSecretName(decodeSafe(name)) || isSecretValue(decoded) ? `${name}=${hide()}` : part;
    })
    .join('');
}

/** A path, each segment hidden only when it is itself shaped like a credential, and each `;name=value` named like one. */
function hidePath(path: string, count: { n: number }): string {
  const hide = hider(count);
  return path
    .split('/')
    .map((segment) => {
      const [own = '', ...params] = segment.split(';');
      const decoded = decodeSafe(own);
      const kept = decoded !== HIDDEN_VALUE && isSecretValue(decoded) ? hide() : own;
      return params.length ? `${kept};${hideParams(params.join(';'), count)}` : kept;
    })
    .join('/');
}

/**
 * A URL with each credential in it written as {@link HIDDEN_VALUE}, part by part: never its scheme, host or port; its
 * password; a query or fragment value named or shaped like a credential (`?token=…`, `#access_token=…`); a path
 * segment only when it is itself shaped like one, so an id stays (`/files/1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2`). A
 * relative URL (`/reset?token=…`) is read the same way. `count.n` counts what was hidden. Pure.
 */
export function hideSecretsInUrl(url: string, count: { n: number } = { n: 0 }): string {
  const parts = URL_PARTS.exec(url);
  if (!parts) return url;
  const [, scheme = '', authority, path = '', query = '', fragment = ''] = parts;
  let out = '';
  if (authority !== undefined) {
    const at = authority.lastIndexOf('@');
    const colon = at >= 0 ? authority.slice(0, at).indexOf(':') : -1;
    out +=
      colon >= 0 && colon < at - 1
        ? `${scheme}//${authority.slice(0, colon + 1)}${hider(count)()}${authority.slice(at)}`
        : `${scheme}//${authority}`;
  }
  out += hidePath(path, count);
  if (query) out += `?${hideParams(query.slice(1), count)}`;
  if (fragment) {
    const body = fragment.slice(1);
    const ask = body.indexOf('?');
    out += `#${
      ask >= 0
        ? `${hidePath(body.slice(0, ask), count)}?${hideParams(body.slice(ask + 1), count)}`
        : body.includes('=')
          ? hideParams(body, count)
          : hidePath(body, count)
    }`;
  }
  return out;
}

/** A query parameter in a text (`?token=…`, `&code=…`, `#access_token=…`), and the password of a URL (`//user:secret@`). */
const QUERY_PAIR = /([?&;#])([^=&#?;\s"'<>]{1,256})=([^&;#\s"'<>]*)/g;
const URL_PASSWORD = /(\/\/[^/:@\s"'<>]{1,256}:)([^@/\s"'<>]{1,256})(@)/g;

/** Every PEM block of a private key in a text, hidden whole: a block whose end is missing, to the end of its lines. */
function hidePem(text: string, hide: () => string): string {
  let out = '';
  let last = 0;
  let nextEnd = -2;
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(text); begin; begin = PEM_BEGIN.exec(text)) {
    if (begin.index < last) continue;
    if (nextEnd !== -1 && nextEnd < begin.index) nextEnd = text.indexOf('-----END ', begin.index);
    const footer = nextEnd >= 0 ? /^-----END [A-Z0-9 ]{0,40}-----/.exec(text.slice(nextEnd, nextEnd + 60)) : null;
    const until = footer
      ? nextEnd + footer[0].length
      : begin.index +
        begin[0].length +
        (/^(?:\s*[A-Za-z0-9+/=]+)*/.exec(text.slice(begin.index + begin[0].length))?.[0].length ?? 0);
    out += `${text.slice(last, begin.index)}${hide()}`;
    last = until;
    PEM_BEGIN.lastIndex = until;
  }
  return out + text.slice(last);
}

/** The credentials of a text outside its URLs: by name after `?`, `&`, `;` or `#`, by name in a JSON field, by shape. */
function hideInText(text: string, count: { n: number }): string {
  // The space between two URLs, a comma: nothing to hide.
  if (text.length < 4 || !/[A-Za-z0-9]/.test(text)) return text;
  const hide = hider(count);
  let out = hidePem(text, hide);
  out = out.replace(QUERY_PAIR, (all, sep: string, name: string, value: string) => {
    const decoded = decodeSafe(value);
    if (!value || decoded === HIDDEN_VALUE) return all;
    return isSecretName(name) || isSecretValue(decoded) ? `${sep}${name}=${hide()}` : all;
  });
  out = out.replace(URL_PASSWORD, (_all, before: string, _password: string, at: string) => `${before}${hide()}${at}`);
  out = out.replace(SET_COOKIE, (_all, before: string) => `${before}${hide()}`);
  out = out.replace(COOKIE_LINE, (_all, before: string, pairs: string) => {
    const values = pairs.replace(/([^=;\s]{1,256}=)([^;]*)/g, (pair, name: string, value: string) =>
      value.trim() && value.trim() !== HIDDEN_VALUE ? `${name}${hide()}` : pair,
    );
    return `${before}${values}`;
  });
  out = out.replace(JSON_FIELD, (all, before: string, name: string, value: string) =>
    isSecretName(name) && value !== HIDDEN_VALUE ? `${before}${hide()}"` : all,
  );
  out = hideSecretShapes(
    out.replace(BASIC, (all, encoded: string) => (isBasicCredential(encoded) ? hide() : all)),
    count,
  );
  // A run with slashes, neither `+` nor padding in it, is a path: each part is read on its own.
  return out.replace(TOKEN_RUN, (run) =>
    run.includes('/') && !/[+=]/.test(run)
      ? run
          .split('/')
          .map((part) => (looksRandom(part) ? hide() : part))
          .join('/')
      : looksRandom(run)
        ? hide()
        : run,
  );
}

/**
 * `text` with each credential in it written as {@link HIDDEN_VALUE}: each URL in it part by part
 * (`hideSecretsInUrl`), and elsewhere a query parameter named or shaped like one, a URL's password, a cookie's value,
 * the string value of a JSON field named like one, and a credential's shape anywhere (`isSecretValue`). `count.n`
 * counts what was hidden. Pure.
 */
export function hideSecretsInText(text: string, count: { n: number } = { n: 0 }): string {
  let out = '';
  let last = 0;
  for (const url of text.matchAll(URL_IN_TEXT)) {
    out += hideInText(text.slice(last, url.index), count) + hideSecretsInUrl(url[0], count);
    last = url.index + url[0].length;
  }
  return out + hideInText(text.slice(last), count);
}

/** How Playwright titles a call that types text: a fill, a typing (`pressSequentially`, `keyboard.type`), an insert. */
const TYPED_TITLE = /^(?:Fill|Type|Insert) "/;

/**
 * A call's title with the text it types written as {@link HIDDEN_VALUE}: Playwright writes that text in the title of a
 * fill, a typing or an insert (`Fill "…"`, and `Fill "…" getByLabel('Password')` with the locator it appends), and it
 * may be a secret the test reads from its environment. The text runs to the title's last quote, or to the quote before
 * the locator (`typedTextEnd`); the call's verb and its locator stay. Any other title is returned as it is. Pure.
 */
export function hideTypedText(title: string): string {
  const typing = TYPED_TITLE.exec(title);
  if (!typing) return title;
  const start = typing[0].length;
  const end = title.endsWith('"') ? title.length - 1 : typedTextEnd(title, start);
  return end >= start ? `${title.slice(0, start)}${HIDDEN_VALUE}${title.slice(end)}` : `${typing[0]}${HIDDEN_VALUE}"`;
}

/** The longest locator a typed call's title is read for: Playwright cuts the one it appends at 200 characters. */
const MAX_TITLE_LOCATOR = 1000;

/**
 * Where the typed text ends in a title that goes on after it. Playwright writes the text unescaped, so its own quotes
 * cannot tell: the end is the last `" ` followed by a whole locator (`tryParseLocatorChain`) of at most
 * `MAX_TITLE_LOCATOR` characters, which keeps a locator that quotes a name
 * (`getByRole('textbox', { name: 'Card "main" number' })`) whole. When none is followed by one (a `describe()` label, a
 * locator cut short with `…`), it is the last `" `; -1 without one. Its time grows with the title's length, not its
 * square.
 */
function typedTextEnd(title: string, start: number): number {
  const from = Math.max(start, title.length - MAX_TITLE_LOCATOR - 2);
  for (let at = title.lastIndexOf('" '); at >= from; at = title.lastIndexOf('" ', at - 1)) {
    if (tryParseLocatorChain(title.slice(at + 2))) return at;
  }
  return title.lastIndexOf('" ');
}

/**
 * The words naming a secret field in the other languages Piwi speaks, accents left out: French (`mot de passe`,
 * `mdp`), German (`Passwort`, `Kennwort`), Spanish (`contraseña`, `clave`) and Portuguese (`senha`); a card's security
 * code (`CVV`, `CVC`, `CSC`); a PIN, a password's short names (`pw`) and a second factor's (`TOTP`, `MFA`, `2FA`).
 */
const SECRET_FIELD_WORDS = new Set([
  'passe',
  'mdp',
  'passwort',
  'kennwort',
  'contrasena',
  'clave',
  'senha',
  'cvv',
  'cvc',
  'csc',
  'pin',
  'pw',
  'totp',
  'mfa',
  '2fa',
]);

/** What names a password inside a longer word: `newpassword`, `password1`, `motdepasse`. */
const SECRET_STEMS = ['password', 'passwd', 'passwort', 'kennwort', 'contrasena', 'senha', 'motdepasse'];

/** The words that make a code a secret one: a verification, security, one-time or access code. */
const SECRET_CODE_KINDS = new Set([
  'verification',
  'security',
  'confirmation',
  'auth',
  'authentication',
  'access',
  'time',
  'otp',
  'sms',
  'login',
  'mfa',
  '2fa',
]);

/**
 * Whether a locator, as Playwright renders it (`getByLabel('Password')`, `locator('#pwd')`), names a field that holds a
 * secret: it selects a password field (`type=password`), a string it quotes is named like a credential
 * (`isSecretName`: `getByLabel('PIN')`), one of its words is a credential's in English or in Piwi's other languages
 * (`getByLabel('Mot de passe')`, `getByTestId('login-pw')`) or holds a password's (`locator('#newpassword')`), or it
 * names a code of a kind that is secret (`getByLabel('Verification code')`, not `Promo code`). A field it does not
 * name so is not one, whatever it holds. Pure.
 */
export function isSecretLocator(locator: string): boolean {
  const plain = locator.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/type\s*=\s*["']?password\b/i.test(plain)) return true;
  for (const quoted of plain.matchAll(/(['"])((?:(?!\1)[^\\]|\\.)*)\1/g)) if (isSecretName(quoted[2]!)) return true;
  const words = nameWords(plain);
  return (
    words.some(
      (word) =>
        SECRET_WORDS.has(word) || SECRET_FIELD_WORDS.has(word) || SECRET_STEMS.some((stem) => word.includes(stem)),
    ) ||
    (words.includes('code') && words.some((word) => SECRET_CODE_KINDS.has(word)))
  );
}

/**
 * A call of Playwright's call log that types text, an item of the log, up to the quote its text opens with:
 * `  - fill("`, `elementHandle.type("`. Never one a locator or a message names (`getByText('Choose type("A")')`).
 */
const TYPED_CALL =
  // eslint-disable-next-line no-control-regex -- matches the ESC byte of a color code
  /^((?:\u001b\[[\d;]*m)*[ \t]*(?:(?:-|\d+ ×)[ \t]+)?(?:\w+\.)?)(fill|type|insertText)\("/gm;

/**
 * The `")` that ends the text a call types. Playwright writes the text as it is, quotes and line breaks included, so it
 * is the first `")` that ends a line, a color code of the error's after it or not.
 */
// eslint-disable-next-line no-control-regex -- matches the ESC byte of a color code
const TYPED_END = /"\)(?=(?:\u001b\[[\d;]*m|[ \t])*(?:\r?\n|$))/g;

/** `text` with the text each call types written as {@link HIDDEN_VALUE}; a call cut before its end hides the rest. */
function hideTypedTextInLog(text: string): string {
  let out = '';
  let from = 0;
  TYPED_CALL.lastIndex = 0;
  for (let call = TYPED_CALL.exec(text); call; call = TYPED_CALL.exec(text)) {
    out += `${text.slice(from, call.index)}${call[1]}${call[2]}("${HIDDEN_VALUE}")`;
    TYPED_END.lastIndex = call.index + call[0].length;
    const end = TYPED_END.exec(text);
    if (!end) return out;
    from = end.index + 2;
    TYPED_CALL.lastIndex = from;
  }
  return out + text.slice(from);
}

/** A line naming the locator it reads: `waiting for getByLabel('Password')`, an assertion's `Locator: …`. */
const READ_LOCATOR = /(?:waiting for|Locator:)[ \t]+(.*)$/gm;
/** A line of a call's log naming the element its locator resolved to as a password field. */
const RESOLVED_PASSWORD = /resolved to <input\b[^>\n]*\btype="password"/i;
/**
 * A value an assertion quotes of its element: `unexpected value "…"`, `Expected: "…"`, `Received string: "…"`, to the
 * last quote of its line, or to the line's end when it was cut before its quote.
 */
const READ_VALUE =
  // eslint-disable-next-line no-control-regex -- matches the ESC byte of a color code
  /(unexpected value |(?:Expected|Received)(?: string)?:[ \t]*(?:\u001b\[[\d;]*m)*(?:not[ \t]+)?)"(?:.*"|.*)/g;
/** An element of the page a call's log shows, a password field or not: `resolved to <input type="password" …>`. */
const RESOLVED_ELEMENT = /resolved to <[^>\n]*/g;
/** The value attribute of an element Playwright shows. */
const VALUE_ATTRIBUTE = /\bvalue="[^"\n]*"/g;
// eslint-disable-next-line no-control-regex -- matches the ESC byte of a color code
const COLOR = /\u001b\[[\d;]*m/g;

/**
 * Whether `text` reads a field that holds a secret: a locator it names as the one it reads (`waiting for …`,
 * `Locator: …`) names one (`isSecretLocator`), or the element it resolved to is a password field.
 */
export function namesSecretField(text: string): boolean {
  if (RESOLVED_PASSWORD.test(text)) return true;
  for (const named of text.matchAll(READ_LOCATOR))
    if (isSecretLocator(named[1]!.replace(COLOR, '').trim())) return true;
  return false;
}

/** `text` with each value its assertions quote written as {@link HIDDEN_VALUE}. */
function hideReadValues(text: string): string {
  return text.replace(READ_VALUE, (_, before: string) => `${before}"${HIDDEN_VALUE}"`);
}

/**
 * `text` with the value attribute of each element its log shows hidden, when that element is a password field or
 * `secretField` says the call's locator names one: a field's attribute may hold what was typed into it.
 */
function hideResolvedValues(text: string, secretField: boolean): string {
  if (!text.includes('resolved to <')) return text;
  return text.replace(RESOLVED_ELEMENT, (element) =>
    secretField || /\btype="password"/i.test(element)
      ? element.replace(VALUE_ATTRIBUTE, `value="${HIDDEN_VALUE}"`)
      : element,
  );
}

/**
 * A header a request's log writes, up to its value: an indented line or an item of the log (`  authorization: `,
 * `    - x-api-key: `), never the first line of an error (`TokenExpiredError: …`).
 */
const LOGGED_HEADER =
  // eslint-disable-next-line no-control-regex -- matches the ESC byte of a color code
  /^(?:\u001b\[[\d;]*m)*(?:[ \t]+(?:(?:-|\d+ ×)[ \t]+)?|(?:-|\d+ ×)[ \t]+)([A-Za-z][\w-]*): /;

/** Where the color codes that end `line` begin: its length when none does. */
function colorsAtEnd(line: string): number {
  let end = line.length;
  while (end > 0 && line[end - 1] === 'm') {
    const start = line.lastIndexOf('\u001b[', end - 1);
    if (start < 0 || !/^[\d;]*$/.test(line.slice(start + 2, end - 1))) break;
    end = start;
  }
  return end;
}

/** `text` with the value of each header named like a credential hidden (`isSecretName`: `authorization`, `x-api-key`). */
function hideSecretHeaders(text: string): string {
  if (!text.includes(': ')) return text;
  return text
    .split('\n')
    .map((line) => {
      const header = LOGGED_HEADER.exec(line);
      if (!header || !isSecretName(header[1]!)) return line;
      const rest = line.slice(header[0].length);
      const end = colorsAtEnd(rest);
      return end === 0 ? line : `${header[0]}${HIDDEN_VALUE}${rest.slice(end)}`;
    })
    .join('\n');
}

/**
 * `text`, a call's log, with what may be a secret written as {@link HIDDEN_VALUE}: the text each call types
 * (`- fill("…")`, `elementHandle.type("…")`), the values an assertion quotes (`unexpected value "…"`) and the value
 * attribute of the element it resolved to when it reads a field that holds a secret (`namesSecretField`) or when
 * `secretField` says the call's locator names one, and the value of each header named like a credential a request's
 * log writes (`authorization: …`). A text cut short has the rest of
 * a typed text or a quoted value hidden. Linear in the length of `text`. Pure.
 */
export function hideSecretsInLog(text: string, secretField = false): string {
  const secret = secretField || namesSecretField(text);
  let hidden = hideResolvedValues(hideTypedTextInLog(text), secret);
  if (secret) hidden = hideReadValues(hidden);
  return hideSecretHeaders(hidden);
}

/** The line that opens an error's call log, as Playwright writes it. */
const CALL_LOG = '\nCall log:';
/** Where an error's call log ends: at the stack (`\n    at …`), at the next of several errors joined, or at the end. */
const CALL_LOG_END = /\n(?:---\n|[ \t]+at )/g;

/**
 * `text`, an error as Playwright writes it, or several joined (`joinErrorMessages`), with what may be a secret written
 * as {@link HIDDEN_VALUE}: in each of its call logs, what {@link hideSecretsInLog} hides; in its message, the values an
 * assertion quotes when it reads a field that holds a secret (`Received: "…"`); anywhere in it, a credential's shape
 * ({@link hideSecretShapes}). The rest stays as it is, so an error that holds no credential fingerprints as it did
 * (`extractErrorSignature` reads values as values, and its selector from the message or the call log's locators).
 * Linear in the length of `text`. Pure.
 */
export function hideSecretsInError(text: string): string {
  const secretField = namesSecretField(text);
  let out = '';
  let from = 0;
  for (;;) {
    const log = text.indexOf(CALL_LOG, from);
    const message = text.slice(from, log === -1 ? text.length : log);
    out += secretField ? hideReadValues(message) : message;
    if (log === -1) return hideSecretShapes(out);
    const start = log + CALL_LOG.length;
    CALL_LOG_END.lastIndex = start;
    const end = CALL_LOG_END.exec(text)?.index ?? text.length;
    out += CALL_LOG + hideSecretsInLog(text.slice(start, end), secretField);
    from = end;
  }
}

/**
 * A value a program's output gives a name: quoted after a colon or `=` (`password: 'hunter2'`, as Node prints an
 * object, `"apiKey": "…"`, `PASSWORD="…"`), a color code before it or not.
 */
const NAMED_QUOTED =
  // eslint-disable-next-line no-control-regex -- matches the ESC byte of a color code
  /(?<![\w$])(['"]?)([A-Za-z_$][\w$.-]{0,127})\1([ \t]*[:=][ \t]*(?:\u001b\[[\d;]*m)*)(['"`])((?:(?!\4)[^\\\r\n]|\\.){1,4096})\4/g;

/** A value a program's output gives a name after `=`, up to a space or a quote: `PASSWORD=hunter2`, `--api-key=…`. */
const NAMED_BARE =
  // eslint-disable-next-line no-control-regex -- matches the ESC byte of a color code
  /(?<![\w$.])([A-Za-z_][\w.-]{0,127})(=(?:\u001b\[[\d;]*m)*)([^\s'"`<>\u001b]{1,4096})/g;

/**
 * Whether one of a name's words is a credential's (`PIWI_API_KEY`, `dbPassword`, `--auth-token`): `isSecretName`
 * without OAuth's `code` and a `pin`, which in a program's output name an error's code (`code: 'ECONNREFUSED'`) and a
 * test's data more often than a secret.
 */
function hasSecretWord(name: string): boolean {
  return nameWords(name).some((word) => SECRET_WORDS.has(word));
}

/**
 * `text`, what a program wrote (a test's stdout or stderr), with what may be a secret written as {@link HIDDEN_VALUE}:
 * what {@link hideSecretsInError} and {@link hideSecretsInText} hide, and a value given a name one of whose words is a
 * credential's, quoted after a colon or `=` (`password: 'hunter2'`, `token: "…"`), or after `=` up to a space
 * (`PIWI_API_KEY=…`, `--password=…`). An unquoted value after a colon (`Session: started`) stays. Pure.
 */
export function hideSecretsInOutput(text: string): string {
  return hideSecretsInText(hideSecretsInError(text))
    .replace(NAMED_QUOTED, (all, quote: string, name: string, between: string, mark: string, value: string) =>
      value !== HIDDEN_VALUE && hasSecretWord(name)
        ? `${quote}${name}${quote}${between}${mark}${HIDDEN_VALUE}${mark}`
        : all,
    )
    .replace(NAMED_BARE, (all, name: string, equals: string) =>
      hasSecretWord(name) ? `${name}${equals}${HIDDEN_VALUE}` : all,
    );
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

/** The characters a value quoted in an ARIA snapshot escapes, as Playwright writes them. */
const ARIA_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/** A value as a quoted value of an ARIA snapshot escapes it, quotes aside, as Playwright writes it. */
function escapedInQuotes(value: string): string {
  let out = '';
  for (const c of value) {
    const code = c.charCodeAt(0);
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    out += ARIA_ESCAPES[c] ?? (control ? `\\x${code.toString(16).padStart(2, '0')}` : c);
  }
  return out;
}

/**
 * An ARIA snapshot with the values of the page's secret fields (`secrets`, as the page holds them now) written as
 * {@link HIDDEN_VALUE}: where a line shows one as its value, plain or quoted, its key plain or quoted (`- textbox "PIN"
 * [ref=e8]: "123456"`, `- 'textbox "PIN #" [ref=e8]': "1234"`), and anywhere else for a value of 8 characters or more,
 * as written and as a quoted value escapes it (`\"`, `\\`). A line that does not read as Playwright writes one has
 * what it shows hidden. Pure.
 */
export function withoutFieldSecrets(snapshot: string, secrets: readonly string[]): string {
  const values = [...new Set(secrets.filter(Boolean))];
  if (!values.length) return snapshot;
  const shown = new Set(values);
  const out = snapshot
    .split('\n')
    .map((line) => {
      const read = readAriaLine(line);
      if (read.kind === 'unread') return read.blank ? line : hiddenLine(read);
      const hide = read.tail !== null && (read.value === null || shown.has(read.value));
      return hide ? writeAriaLine(read, false, true) : line;
    })
    .join('\n');
  return hiddenAnywhere(out, values);
}

/** `text` with each value of 8 characters or more written as {@link HIDDEN_VALUE}, as written and escaped. */
function hiddenAnywhere(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (value.length < 8) continue;
    for (const written of new Set([value, escapedInQuotes(value)])) out = out.split(written).join(HIDDEN_VALUE);
  }
  return out;
}

/** The roles of an ARIA snapshot's nodes whose value is what a person typed or chose: a field's. */
const FIELD_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/** The words that name a payment card, and those that name its number. */
const CARD_WORDS: ReadonlySet<string> = new Set(['card', 'cc', 'credit', 'debit', 'kreditkarte', 'carte', 'tarjeta']);
const NUMBER_WORDS: ReadonlySet<string> = new Set(['number', 'no', 'num', 'nr', 'numero', 'nummer']);

/**
 * Whether a field's accessible name, as an ARIA snapshot writes it, names one that holds a secret: what
 * {@link isSecretLocator} reads as one (`Password`, `PIN`, `Code`, `Verification code`, `Mot de passe`, `CVC`), or a
 * card's number (`Card number`, `Credit card no`). Pure.
 */
export function isSecretFieldName(name: string): boolean {
  if (!name.trim()) return false;
  if (isSecretLocator(JSON.stringify(name))) return true;
  const words = nameWords(name.normalize('NFD').replace(/[̀-ͯ]/g, ''));
  return words.some((word) => CARD_WORDS.has(word)) && words.some((word) => NUMBER_WORDS.has(word));
}

/** Whether `value` reads as a payment card's number: 13 to 19 digits, spaces or dashes between them, Luhn's check true. */
export function looksLikeCardNumber(value: string): boolean {
  if (!/^\d[\d -]{11,30}\d$/.test(value)) return false;
  const digits = value.replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * A project's masked element as an ARIA snapshot can find it: a role (any for null), and its accessible name, or for
 * a placeholder its `/placeholder` or the name it gives a field with no other.
 */
interface AriaMask {
  role: string | null;
  name: string | RegExp;
  exact: boolean;
  placeholder: boolean;
}

/** The methods whose argument is the accessible name an ARIA snapshot writes, or its `/placeholder`. */
const NAMING_METHODS: ReadonlySet<string> = new Set(['getByLabel', 'getByPlaceholder', 'getByAltText']);

/** A masked element's locator as an ARIA snapshot can find it, or why not, as a sentence. */
function ariaMaskOf(locator: string): AriaMask | string {
  const cannot = `\`${locator.trim()}\` names no element by its accessible name or its placeholder, which is all the page's text shows: mask it by its label, its placeholder or its role and name, such as getByLabel('IBAN').`;
  const chain = tryParseLocatorChain(locator.trim());
  const call = chain?.calls.length === 1 ? chain.calls[0]! : null;
  if (!call) return cannot;
  const optionsOf = (arg: (typeof call.args)[number] | undefined): Map<string, (typeof call.args)[number]> =>
    new Map(arg?.type === 'object' ? arg.entries : []);
  const nameOf = (arg: (typeof call.args)[number] | undefined): string | RegExp | null => {
    if (arg?.type === 'string') return arg.value;
    if (arg?.type !== 'regex') return null;
    try {
      return new RegExp(arg.source, arg.flags.replace(/[gy]/g, ''));
    } catch {
      return null;
    }
  };
  const exactOf = (options: Map<string, (typeof call.args)[number]>): boolean => {
    const exact = options.get('exact');
    return exact?.type === 'boolean' && exact.value;
  };
  if (NAMING_METHODS.has(call.method)) {
    const name = nameOf(call.args[0]);
    const placeholder = call.method === 'getByPlaceholder';
    return name === null ? cannot : { role: null, name, exact: exactOf(optionsOf(call.args[1])), placeholder };
  }
  if (call.method === 'getByRole' && call.args[0]?.type === 'string') {
    const options = optionsOf(call.args[1]);
    const name = nameOf(options.get('name'));
    return name === null ? cannot : { role: call.args[0].value, name, exact: exactOf(options), placeholder: false };
  }
  return cannot;
}

/**
 * Why the page's text (an ARIA snapshot) cannot hide a project's masked element `locator`, as a person reads it; null
 * when it can: a locator that names the element by the accessible name the snapshot writes (`getByLabel`,
 * `getByAltText`, or `getByRole` with a `name`) or by its placeholder (`getByPlaceholder`). A title
 * (`getByTitle`) is one the text does not show beside a label. Pure.
 */
export function ariaMaskProblem(locator: string): string | null {
  const mask = ariaMaskOf(locator);
  return typeof mask === 'string' ? mask : null;
}

/** Whether a text matches a mask's name, as Playwright matches a name: whole and in case with `exact`. */
function matchesMaskName(mask: AriaMask, text: string): boolean {
  if (mask.name instanceof RegExp) return mask.name.test(text);
  if (mask.exact) return collapsed(text) === collapsed(mask.name);
  return collapsed(text).toLowerCase().includes(collapsed(mask.name).toLowerCase());
}

/** A text with its runs of white space written as one space, trimmed. */
function collapsed(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Whether a node matches a mask: its role, then its name, or for a placeholder the `/placeholder` it shows or, as
 * Playwright leaves one out that names the field, its name.
 */
function matchesMask(mask: AriaMask, role: string, name: string, placeholder: string | null): boolean {
  if (mask.role !== null && mask.role !== role) return false;
  if (mask.placeholder && placeholder !== null && matchesMaskName(mask, placeholder)) return true;
  return matchesMaskName(mask, name);
}

/**
 * A line of an ARIA snapshot as Playwright 1.59 to 1.64 writes one (`- role "name" [flag]: value`, its key between
 * single quotes where YAML needs them, a value between double quotes), read:
 *
 * - `node`: its role (`text` for a text), its name (`name`, null for none, `badName` for one that does not read), its
 *   flags as written, and after the key either nothing, a colon its children follow (`opens`), or a value (`tail` as
 *   written, `value` as read, null for one that does not read);
 * - `prop`: a property of the node above (`- /url: …`, `- /placeholder: …`), its name in `role`, its value as a node's;
 * - `unread`: anything else, a blank line (`blank`) included.
 */
interface AriaLine {
  kind: 'node' | 'prop' | 'unread';
  lead: string;
  blank: boolean;
  /** The key as written, its quotes included: what goes before the colon. */
  key: string;
  role: string;
  name: string | null;
  badName: boolean;
  flags: string;
  opens: boolean;
  tail: string | null;
  value: string | null;
}

/** A key's body: its role, its name in JSON's quotes, and its flags. */
const ARIA_KEY = /^([\w-]+)(?: ("(?:[^"\\]|\\.)*"))?((?: \[[^\]]*\])*)$/;
/** A plain key at the start of a line's body, and what follows it. */
const ARIA_PLAIN_KEY = /^([\w-]+(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*)(.*)$/;
/** A property's line body: its name and its value. */
const ARIA_PROP = /^\/([\w-]+): (.*)$/;

/** The escapes a double-quoted value of Playwright's YAML and a JSON string hold, read. */
const QUOTED_ESCAPES: Record<string, string> = {
  '\\': '\\',
  '"': '"',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** A double-quoted value (`"a: b"`, `"\x01"`), read; null for anything else, or one that does not read whole. */
function readDoubleQuoted(written: string): string | null {
  if (written.length < 2 || !written.startsWith('"') || !written.endsWith('"')) return null;
  let out = '';
  for (let i = 1; i < written.length - 1; i++) {
    const c = written[i]!;
    if (c === '"') return null;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = written[++i];
    if (next === undefined || i >= written.length - 1) return null;
    const plain = QUOTED_ESCAPES[next];
    if (plain !== undefined) {
      out += plain;
      continue;
    }
    const digits = next === 'x' ? 2 : next === 'u' ? 4 : 0;
    const hex = written.slice(i + 1, i + 1 + digits);
    if (!digits || !new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(hex) || i + digits >= written.length - 1) return null;
    out += String.fromCharCode(parseInt(hex, 16));
    i += digits;
  }
  return out;
}

/** A single-quoted value (`'it''s'`), read; null for anything else. */
function readSingleQuoted(written: string): string | null {
  if (written.length < 2 || !written.startsWith("'") || !written.endsWith("'")) return null;
  const inside = written.slice(1, -1);
  return /'(?!')/.test(inside.replace(/''/g, '')) ? null : inside.replace(/''/g, "'");
}

/** A value after a key's colon, read: quoted or plain; null for a quoted one that does not read. */
function readAriaValue(written: string): string | null {
  if (written.startsWith('"')) return readDoubleQuoted(written);
  if (written.startsWith("'")) return readSingleQuoted(written);
  return written;
}

/** A line of an ARIA snapshot, read (`AriaLine`). Linear in its length. Pure. */
function readAriaLine(line: string): AriaLine {
  const lead = /^\s*/.exec(line)![0];
  const unread: AriaLine = {
    kind: 'unread',
    lead,
    blank: lead.length === line.length,
    key: '',
    role: '',
    name: null,
    badName: false,
    flags: '',
    opens: false,
    tail: null,
    value: null,
  };
  if (!line.startsWith('- ', lead.length)) return unread;
  const body = line.slice(lead.length + 2);
  const prop = ARIA_PROP.exec(body);
  if (prop) {
    return {
      ...unread,
      kind: 'prop',
      key: `/${prop[1]}`,
      role: prop[1]!,
      tail: prop[2]!,
      value: readAriaValue(prop[2]!),
    };
  }
  let key: string;
  let keyBody: string;
  let rest: string;
  if (body.startsWith("'")) {
    let end = 1;
    for (;;) {
      end = body.indexOf("'", end);
      if (end < 0) return unread;
      if (body[end + 1] !== "'") break;
      end += 2;
    }
    key = body.slice(0, end + 1);
    keyBody = body.slice(1, end).replace(/''/g, "'");
    rest = body.slice(end + 1);
  } else {
    const plain = ARIA_PLAIN_KEY.exec(body);
    if (!plain) return unread;
    key = plain[1]!;
    keyBody = key;
    rest = plain[2]!;
  }
  const parts = ARIA_KEY.exec(keyBody);
  if (!parts) return unread;
  let tail: string | null = null;
  if (rest.startsWith(': ')) tail = rest.slice(2);
  else if (rest !== '' && rest !== ':') return unread;
  let name: string | null = null;
  let badName = false;
  if (parts[2] !== undefined) {
    name = readDoubleQuoted(parts[2]);
    badName = name === null;
  }
  return {
    ...unread,
    kind: 'node',
    key,
    role: parts[1]!,
    name,
    badName,
    flags: parts[3] ?? '',
    opens: rest === ':',
    tail,
    value: tail === null ? null : readAriaValue(tail),
  };
}

/** A line that does not read, all it shows hidden. */
function hiddenLine(line: AriaLine): string {
  return `${line.lead}- ${HIDDEN_VALUE}`;
}

/** A line as read, its name and its value written as {@link HIDDEN_VALUE} as asked; the rest as written. */
function writeAriaLine(line: AriaLine, hideName: boolean, hideValue: boolean): string {
  const named = line.name !== null || line.badName;
  const key = hideName && named ? `${line.role} "${HIDDEN_VALUE}"${line.flags}` : line.key;
  const after = line.tail !== null ? `: ${hideValue ? HIDDEN_VALUE : line.tail}` : line.opens ? ':' : '';
  return `${line.lead}- ${line.kind === 'prop' ? `/${line.role}` : key}${after}`;
}

/** What {@link maskAriaSnapshot} knows of the page beside the snapshot. */
export interface AriaMaskOptions {
  /** The values the page's secret fields hold now, read from the page (`SECRET_FIELD_SELECTOR`). */
  secrets?: readonly string[];
  /**
   * The project's masked elements, as locators: a node one finds (`ariaMaskProblem`) has its name and value hidden, and
   * the names and values of the nodes inside it, and a name that shows its name (a row's) is hidden too.
   */
  masks?: readonly string[];
}

/** A node whose children are read: its indent, whether what it holds is hidden, and whether it is a secret field. */
interface OpenNode {
  indent: number;
  hides: boolean;
  secret: boolean;
}

/**
 * An ARIA snapshot (Playwright's text form, AI mode or not, or the trace's rendered by `ariaTreeText`) with what a
 * field that holds a secret shows written as {@link HIDDEN_VALUE}. Playwright 1.64 writes a field's value after its
 * node (`- textbox "Password" [ref=e4]: S3cr3t`, its key between single quotes where YAML needs them), or on a
 * `- text:` line under it beside its `/placeholder`, and a snapshot says nothing of a field's type or `autocomplete`, so
 * a value is hidden when:
 *
 * - its node is a field (`textbox`, `searchbox`, `combobox`, `spinbutton`) whose name names a secret
 *   (`isSecretFieldName`: a password, a PIN, a code, a card's number or security code), and then so is every name
 *   and value under it but its `/placeholder`;
 * - it reads as a card's number (`looksLikeCardNumber`), whatever its node, as does a name;
 * - it is one the page's secret fields hold now (`secrets`, as `withoutFieldSecrets` hides them);
 * - its node is one of the project's masked elements (`masks`), and then so is its name, every name and value inside
 *   it, and any other name that holds its name (a row's, made of its cells');
 * - it, or its node's name, does not read as Playwright writes it (`- <hidden>` for a line that does not).
 *
 * A mask the snapshot cannot find (`ariaMaskProblem`) hides nothing here: the caller does not send the text. Credentials
 * in the rest (an address's token) are `hideSecretsInText`'s to hide. Pure.
 */
export function maskAriaSnapshot(snapshot: string, options: AriaMaskOptions = {}): string {
  const masks = (options.masks ?? []).map(ariaMaskOf).filter((mask): mask is AriaMask => typeof mask !== 'string');
  const secrets = new Set((options.secrets ?? []).filter(Boolean));
  const written = snapshot.split('\n');
  const lines = written.map(readAriaLine);
  const hidden = lines.map(() => ({ name: false, value: false }));
  /** The names of the masked nodes, white space collapsed. */
  const maskedNames = new Set<string>();
  const open: OpenNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const indent = line.lead.length;
    while (open.length && open[open.length - 1]!.indent >= indent) open.pop();
    const parent = open[open.length - 1];
    const inside = parent?.hides ?? false;
    const verdict = hidden[i]!;
    if (line.kind === 'unread') {
      if (!line.blank) open.push({ indent, hides: true, secret: false });
      continue;
    }
    const valueSecret =
      line.tail !== null && (line.value === null || looksLikeCardNumber(line.value) || secrets.has(line.value));
    if (line.kind === 'prop') {
      verdict.value = inside || (parent?.secret === true && line.role !== 'placeholder') || valueSecret;
      continue;
    }
    const name = line.name ?? '';
    const masked =
      !inside && !line.badName && masks.some((mask) => matchesMask(mask, line.role, name, placeholderOf(lines, i)));
    if (masked && collapsed(name)) maskedNames.add(collapsed(name));
    const fromField = parent?.secret === true;
    const hides = inside || masked || line.badName || fromField;
    const secret = !hides && FIELD_ROLES.has(line.role) && isSecretFieldName(name);
    verdict.name = hides || looksLikeCardNumber(name);
    verdict.value = hides || secret || valueSecret;
    open.push({ indent, hides, secret });
  }
  const out = lines.map((line, i) => {
    if (line.kind === 'unread') return line.blank ? written[i]! : hiddenLine(line);
    const verdict = hidden[i]!;
    const name = collapsed(line.name ?? '');
    if (name && [...maskedNames].some((masked) => name.includes(masked))) verdict.name = true;
    return verdict.name || verdict.value ? writeAriaLine(line, verdict.name, verdict.value) : written[i]!;
  });
  return hiddenAnywhere(out.join('\n'), [...secrets]);
}

/** The `/placeholder` a node's line at `index` shows, among the properties that follow it; null for none. */
function placeholderOf(lines: readonly AriaLine[], index: number): string | null {
  const indent = lines[index]!.lead.length;
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.kind !== 'prop' || line.lead.length <= indent) return null;
    if (line.role === 'placeholder') return line.value;
  }
  return null;
}
