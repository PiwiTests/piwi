/**
 * `page.route(...)` code from a response seen in DevTools' network log, for
 * Mock this response in the Piwi panel. Pure: the panel hands it the request's
 * method, URL, status, type and body.
 *
 * Credentials are hidden unless the caller asks otherwise, by name and by
 * shape (`isSecretName`, `isSecretValue` and `hideSecretsInText` of
 * `@piwitests/core/mask`): the whole value of a JSON or form field named like
 * a password, a token, a secret, a key, a signature or a session, whatever it
 * holds, and a token-shaped value anywhere in a body, get {@link HIDDEN_VALUE};
 * such a query parameter, or a path segment shaped like one, is matched by a
 * wildcard. A JSON body keeps each number as written. Headers never reach the
 * code. The editor service bundles it too, for Mock a request at a stopped
 * test.
 */

import { quoteJsString } from '@piwitests/core/locator-chain';
import { HIDDEN_VALUE, hideSecretsInText, holdsPersonalData, isSecretName, isSecretValue } from '@piwitests/core/mask';

export { HIDDEN_VALUE };

export interface MockSource {
  method: string;
  url: string;
  status: number;
  /** The response's MIME type, `application/json` for instance; empty when unknown. */
  mimeType: string;
  /** The body as text, or base64 when `base64`; null when DevTools did not keep it. */
  body: string | null;
  base64?: boolean;
}

export type MockKind = 'response' | 'error' | 'abort';

export interface MockOptions {
  kind?: MockKind;
  /** The URL pattern to route, as the user edited it; {@link mockUrlPattern} otherwise. */
  pattern?: string;
  /** Leave credentials as they are. */
  reveal?: boolean;
  /** A body longer than this, in characters, is written to a file the code reads. */
  maxInlineBody?: number;
  /** The expression the route is set on, `page` by default: `this.page` in a page object. Written as it is. */
  page?: string;
}

export interface MockCode {
  code: string;
  /** Set when the body goes to a file beside the test: its path in the code, and its content. */
  file: { path: string; content: string; base64: boolean } | null;
  /** How many values were hidden. */
  hidden: number;
  /** A text body that is neither JSON nor a form, written as it came but for its token-shaped values. */
  asReceived: boolean;
  /** The body looks like it holds an email address or a phone number. */
  personal: boolean;
}

/** 100 kB: above it, a body goes to a file. */
const MAX_INLINE_BODY = 100_000;

/** Query parameters that change on every request and say nothing about what is asked. */
const VOLATILE_PARAMS = new Set([
  '_',
  't',
  'ts',
  '_t',
  '_ts',
  'time',
  'timestamp',
  'cb',
  'cachebuster',
  'cache_buster',
  'cachebust',
  'nocache',
  'rand',
  'random',
  'nonce',
  '_dc',
]);

/** A value that looks generated: an epoch time in seconds or milliseconds, a UUID, a long hex string. */
function looksVolatile(value: string): boolean {
  return (
    /^\d{10}(\d{3})?$/.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    /^[0-9a-f]{16,}$/i.test(value)
  );
}

/** Characters with a meaning in a Playwright glob, which a URL keeps as `*`. */
function globSafe(text: string): string {
  return text.replace(/[*?{}[\]\\]/g, '*');
}

/**
 * The glob a test routes: `**` then the path, without the origin, a segment
 * shaped like a credential as `*`, and the query with its volatile values as
 * `*` and its credentials, named or shaped like one, as `**`, which matches a
 * `/` too, so `https://shop.test/api/cart?_=1695820800000&token=abc` becomes
 * `**` + `/api/cart?_=*&token=**`. `?` is literal in Playwright's globs.
 */
export function mockUrlPattern(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const path = parsed.pathname
    .split('/')
    .map((segment) => {
      const decoded = decodeURIComponentSafe(segment);
      return decoded === HIDDEN_VALUE || isSecretValue(decoded) ? '*' : globSafe(segment);
    })
    .join('/');
  if (!parsed.search) return `**${path}`;
  const params = parsed.search
    .slice(1)
    .split('&')
    .map((pair) => {
      const [name = '', ...rest] = pair.split('=');
      const value = rest.join('=');
      let decodedName = name;
      let decodedValue = value;
      try {
        decodedName = decodeURIComponent(name);
        decodedValue = decodeURIComponent(value);
      } catch {
        // Kept as written.
      }
      if (rest.length === 0) return globSafe(name);
      const secret = isSecretName(decodedName) || isSecretValue(decodedValue) || decodedValue === HIDDEN_VALUE;
      const volatile = VOLATILE_PARAMS.has(decodedName.toLowerCase()) || looksVolatile(decodedValue);
      return `${globSafe(name)}=${secret ? '**' : volatile ? '*' : globSafe(value)}`;
    });
  return `**${path}?${params.join('&')}`;
}

/** A JSON number, as its body wrote it: read and written again, it keeps every digit (an integer past 2^53). */
class JsonNumber {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** Whether a JSON value holds something: not null, `false`, an empty string, array or object. */
function holdsValue(value: unknown): boolean {
  if (value === null || typeof value === 'boolean' || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object' && !(value instanceof JsonNumber)) return Object.keys(value).length > 0;
  return true;
}

/**
 * Replaces credentials in a JSON value, counting them: the whole value of a field named like a credential, whatever it
 * holds (a token, an object, a list of keys; `null` and booleans, which hold none, stay), and the token-shaped parts of
 * every other string. Every key is kept, `__proto__` too.
 */
function hideInJson(value: unknown, count: { n: number }): unknown {
  if (Array.isArray(value)) return value.map((item) => hideInJson(item, count));
  if (typeof value === 'string') return hideSecretsInText(value, count);
  if (value && typeof value === 'object' && !(value instanceof JsonNumber)) {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (isSecretName(key) && holdsValue(item)) {
        count.n++;
        out[key] = HIDDEN_VALUE;
      } else out[key] = hideInJson(item, count);
    }
    return out;
  }
  return value;
}

/** Replaces credentials in `a=1&password=2`, counting them: a field named like one, or a value shaped like one. */
function hideInForm(body: string, count: { n: number }): string {
  return body
    .split('&')
    .map((pair) => {
      const [name = '', ...rest] = pair.split('=');
      const value = rest.join('=');
      if (!value) return pair;
      const decoded = decodeURIComponentSafe(value.replace(/\+/g, ' '));
      if (!isSecretName(decodeURIComponentSafe(name)) && !isSecretValue(decoded)) return pair;
      count.n++;
      return `${name}=${encodeURIComponent(HIDDEN_VALUE)}`;
    })
    .join('&');
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function isJsonType(mimeType: string): boolean {
  return /[/+]json\b/i.test(mimeType);
}

/** The deepest nesting of a JSON body read as JSON; a deeper one is written as text. */
const MAX_JSON_DEPTH = 256;

/** A JSON number token, as the grammar writes one. */
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * `text` read as JSON, each number kept as written (`JsonNumber`): every number token outside a string is read as a
 * string naming it, which no string of the body names, then turned back. Not JSON past `MAX_JSON_DEPTH` levels.
 */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  let mark = 'piwi-number-';
  while (text.includes(mark)) mark += '-';
  const numbers: string[] = [];
  let marked = '';
  let inString = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!inString && (c === '[' || c === '{') && ++depth > MAX_JSON_DEPTH) return { ok: false };
    if (!inString && (c === ']' || c === '}')) depth--;
    if (inString) {
      marked += c;
      if (c === '\\') marked += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === '-' || (c >= '0' && c <= '9')) {
      JSON_NUMBER.lastIndex = i;
      const token = JSON_NUMBER.exec(text)?.[0];
      if (token) {
        marked += JSON.stringify(`${mark}${numbers.push(token) - 1}`);
        i += token.length - 1;
        continue;
      }
    }
    marked += c;
  }
  let value: unknown;
  try {
    value = JSON.parse(marked);
  } catch {
    return { ok: false };
  }
  const revive = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const index = node.startsWith(mark) ? Number(node.slice(mark.length)) : NaN;
      return Number.isInteger(index) && numbers[index] !== undefined ? new JsonNumber(numbers[index]) : node;
    }
    if (Array.isArray(node)) return node.map(revive);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(node)) out[key] = revive(item);
      return out;
    }
    return node;
  };
  return { ok: true, value: revive(value) };
}

/**
 * A JSON value written out, its numbers as their body wrote them: as JSON, or as a JavaScript literal, where a
 * `__proto__` key is written `["__proto__"]` so it stays the object's own field. Two spaces a level, as
 * `JSON.stringify(value, null, 2)` writes it; `compact` writes no white space.
 */
function writeJson(value: unknown, as: 'json' | 'js', compact = false, depth = 0): string {
  if (value instanceof JsonNumber) return value.text;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const pad = compact ? '' : '\n' + '  '.repeat(depth + 1);
  const close = compact ? '' : '\n' + '  '.repeat(depth);
  const items = Array.isArray(value)
    ? value.map((item) => writeJson(item, as, compact, depth + 1))
    : Object.entries(value).map(([key, item]) => {
        const name = as === 'js' && key === '__proto__' ? '["__proto__"]' : JSON.stringify(key);
        return `${name}:${compact ? '' : ' '}${writeJson(item, as, compact, depth + 1)}`;
      });
  const [open, end] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return items.length ? `${open}${pad}${items.join(`,${pad}`)}${close}${end}` : `${open}${end}`;
}

/** `text`, valid JSON, without the white space between its tokens. */
function compactJson(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') out += c;
  }
  return out;
}

/** `cart` for `/api/cart`, `orders-42` for `/api/orders/42/`, `response` when nothing is left. */
export function mockFileName(url: string): string {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // A bare path.
  }
  const parts = pathname.split('/').filter(Boolean);
  const last = parts.pop() ?? '';
  const base = /^\d+$/.test(last) && parts.length ? `${parts.pop()}-${last}` : last;
  const name = base
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name || 'response';
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : `${pad}${line}`))
    .join('\n');
}

function contentTypeOf(mimeType: string): string {
  return mimeType.split(';')[0]!.trim();
}

/** The code for one mock, and the file its body goes to when it is too long to inline. */
export function mockCode(source: MockSource, options: MockOptions = {}): MockCode {
  const kind = options.kind ?? 'response';
  const pattern = options.pattern ?? mockUrlPattern(source.url);
  const maxInline = options.maxInlineBody ?? MAX_INLINE_BODY;
  const method = source.method.toUpperCase();
  const page = options.page ?? 'page';
  const guard =
    method === 'GET' ? '' : `if (route.request().method() !== ${quoteJsString(method)}) return route.fallback();\n`;
  const wrap = (action: string) => {
    if (!guard) return `await ${page}.route(${quoteJsString(pattern)}, (route) =>\n  ${indent(action, 2)},\n);`;
    return `await ${page}.route(${quoteJsString(pattern)}, (route) => {\n  ${guard}  return ${indent(action, 2)};\n});`;
  };

  const plain = { hidden: 0, asReceived: false, personal: false };
  if (kind === 'abort') return { code: wrap('route.abort()'), file: null, ...plain };
  if (kind === 'error') {
    return {
      code: wrap(`route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' })`),
      file: null,
      ...plain,
    };
  }

  const status = source.status && source.status !== 200 ? `status: ${source.status}, ` : '';
  const count = { n: 0 };
  const contentType = contentTypeOf(source.mimeType);
  let body = source.body ?? '';
  let json: { ok: true; value: unknown } | { ok: false } = { ok: false };
  if (!source.base64 && (isJsonType(contentType) || /^\s*[[{]/.test(body))) json = parseJson(body);
  if (json.ok && !options.reveal) json = { ok: true, value: hideInJson(json.value, count) };
  // With nothing hidden, a body that writing again would change (a `\u` escape) goes out as it came.
  const asIs = json.ok && count.n === 0 && writeJson(json.value, 'json', true) !== compactJson(body);
  if (asIs) json = { ok: false };
  const form = !json.ok && !asIs && /x-www-form-urlencoded/i.test(contentType);
  if (form && !source.base64 && !options.reveal) body = hideInForm(body, count);
  // Neither JSON nor a form (text, HTML, XML): written as it came, but for its token-shaped values.
  const asReceived = !json.ok && !asIs && !form && !source.base64 && body.length > 0;
  if (asReceived && !options.reveal) body = hideSecretsInText(body, count);
  const written = { hidden: count.n, asReceived, personal: !source.base64 && holdsPersonalData(body) };

  const text = json.ok ? writeJson(json.value, 'json') : body;
  if (text.length > maxInline) {
    const extension = json.ok || asIs ? 'json' : source.base64 ? 'bin' : 'txt';
    const path = `mocks/${mockFileName(source.url)}.${extension}`;
    const type = contentType ? `contentType: ${quoteJsString(contentType)}, ` : '';
    return {
      code: wrap(`route.fulfill({ ${status}${type}path: ${quoteJsString(path)} })`),
      file: { path, content: text, base64: !!source.base64 && !json.ok },
      ...written,
    };
  }
  if (json.ok) {
    const literal = writeJson(json.value, 'js');
    return { code: wrap(`route.fulfill({\n  ${status}json: ${indent(literal, 2)},\n})`), file: null, ...written };
  }
  const type = contentType ? `contentType: ${quoteJsString(contentType)}, ` : '';
  const bodyCode = source.base64 ? `Buffer.from(${quoteJsString(body)}, 'base64')` : quoteJsString(body);
  return { code: wrap(`route.fulfill({ ${status}${type}body: ${bodyCode} })`), file: null, ...written };
}

/** A response body as DevTools keeps it: text, or base64 when `base64`; null when it kept none. */
export interface ResponseBody {
  text: string | null;
  base64: boolean;
}

/** An entry of DevTools' network log, as far as its body goes. */
export interface LoggedRequest {
  getContent?: unknown;
  response?: { content?: { text?: string; encoding?: string } };
}

/**
 * The body of a request DevTools logged, through its `getContent`: Chrome calls
 * back with the content and its encoding; Firefox returns a promise of the
 * content and its MIME type, and the entry's own `encoding` says whether it is
 * base64. The entry's `content` is the fallback when DevTools gives none.
 */
export function responseBody(request: LoggedRequest): Promise<ResponseBody> {
  const content = request.response?.content;
  const kept = (text: unknown, encoding: unknown): ResponseBody => ({
    text: typeof text === 'string' ? text : (content?.text ?? null),
    base64: (typeof encoding === 'string' ? encoding : content?.encoding) === 'base64',
  });
  const getContent = request.getContent;
  if (typeof getContent !== 'function') return Promise.resolve(kept(null, undefined));
  return new Promise((resolve) => {
    try {
      const returned: unknown = getContent.call(request, (text: unknown, encoding: unknown) =>
        resolve(kept(text, encoding)),
      );
      if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
        (returned as PromiseLike<unknown>).then(
          (value) => resolve(kept(Array.isArray(value) ? value[0] : value, undefined)),
          () => resolve(kept(null, undefined)),
        );
      }
    } catch {
      resolve(kept(null, undefined));
    }
  });
}
