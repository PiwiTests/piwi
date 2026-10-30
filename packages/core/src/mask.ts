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
 *   `AIza`, Twilio's `SK` and 32 hex digits), and a random token (`looksRandom`): 40 characters or more of base64 or
 *   base64url, upper and lower case letters and digits mixed, 4 bits of entropy a character or more, at most a fifth
 *   of its letters in runs of six of one case (the words of an identifier), and not the base64 of text.
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

/** The shapes of a credential with a strong signal, found anywhere in a text: a JWT, a bearer token, a service's key. */
const SECRET_SHAPES: readonly RegExp[] = [
  /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g,
  /\bBearer(?:\s+|%20)[\w.~+/-]{8,}=*/gi,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bwhsec_[A-Za-z0-9]{20,}/g,
  /\bsk-(?=[\w-]{0,200}\d)(?=[\w-]{0,200}[A-Z])[\w-]{32,}/g,
  /\bglpat-[\w-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bSK[0-9a-f]{32}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[\w-]{30,}/g,
  /\bgh[opsu]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_\w{20,}/g,
  /\bxox[abprs]-[\w-]{8,}/g,
];

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
  out = out.replace(BASIC, (all, encoded: string) => (isBasicCredential(encoded) ? hide() : all));
  for (const shape of SECRET_SHAPES) out = out.replace(shape, () => hide());
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
 * may be a secret the test reads from its environment. The text runs to the title's last quote, or to the last quote
 * before the locator; the call's verb and its locator stay. Any other title is returned as it is. Pure.
 */
export function hideTypedText(title: string): string {
  const typing = TYPED_TITLE.exec(title);
  if (!typing) return title;
  const start = typing[0].length;
  const end = title.endsWith('"') ? title.length - 1 : title.lastIndexOf('" ');
  return end >= start ? `${title.slice(0, start)}${HIDDEN_VALUE}${title.slice(end)}` : `${typing[0]}${HIDDEN_VALUE}"`;
}

/**
 * The words naming a secret field in the other languages Piwi speaks, accents left out: French (`mot de passe`,
 * `mdp`), German (`Passwort`, `Kennwort`), Spanish (`contraseña`, `clave`) and Portuguese (`senha`); and a card's
 * security code (`CVV`, `CVC`, `CSC`).
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
]);

/**
 * Whether a locator, as Playwright renders it (`getByLabel('Password')`, `locator('#pwd')`), names a field that holds a
 * secret: it selects a password field (`type=password`), a string it quotes is named like a credential
 * (`isSecretName`: `getByLabel('PIN')`), or one of its words is a credential's in English or in Piwi's other languages
 * (`getByLabel('Mot de passe')`). A field it does not name so is not one, whatever it holds. Pure.
 */
export function isSecretLocator(locator: string): boolean {
  const plain = locator.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/type\s*=\s*["']?password\b/i.test(plain)) return true;
  for (const quoted of plain.matchAll(/(['"])((?:(?!\1)[^\\]|\\.)*)\1/g)) if (isSecretName(quoted[2]!)) return true;
  return nameWords(plain).some((word) => SECRET_WORDS.has(word) || SECRET_FIELD_WORDS.has(word));
}

/**
 * A line of Playwright's call log naming the text a call types: `fill("…")`, `elementHandle.type("…")`. Playwright
 * writes the text as it is, quotes and line breaks included, so it runs to the first `")` that ends a line, a color
 * code of the error's after it or not.
 */
const TYPED_LOG = /\b(fill|type|insertText)\("[\s\S]*?"\)(?=(?:\u001b\[[\d;]*m|[ \t])*$)/gm;

/**
 * `text` with the text each call of Playwright's call log types written as {@link HIDDEN_VALUE}: the log of a fill or
 * a typing quotes it (`- fill("…")`), in a call's log and in the "Call log" of its error. Pure.
 */
export function hideTypedTextInLog(text: string): string {
  return text.replace(TYPED_LOG, (_, call: string) => `${call}("${HIDDEN_VALUE}")`);
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
