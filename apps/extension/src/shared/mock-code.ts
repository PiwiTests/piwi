/**
 * `page.route(...)` code from a response seen in DevTools' network log, for
 * Mock this response in the Piwi panel. Pure: the panel hands it the request's
 * method, URL, status, type and body.
 *
 * Credentials are hidden unless the caller asks otherwise: a JSON or form
 * field named like a password, a token, a secret, a key or a session gets
 * {@link HIDDEN_VALUE}. Headers never reach the code.
 */

import { quoteJsString } from '@piwitests/core/locator-chain';

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
}

export interface MockCode {
  code: string;
  /** Set when the body goes to a file beside the test: its path in the code, and its content. */
  file: { path: string; content: string; base64: boolean } | null;
  /** How many values were hidden. */
  hidden: number;
}

export const HIDDEN_VALUE = '<hidden>';

/** 100 kB: above it, a body goes to a file. */
const MAX_INLINE_BODY = 100_000;

/** Field names that hold a credential. */
const SECRET_FIELD =
  /pass(word|wd|phrase)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|auth(orization)?|session|cookie|credential|otp|pin$/i;

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
 * The glob a test routes: `**` then the path, without the origin, and the
 * query with its volatile values as `*`, so `https://shop.test/api/cart?_=1695820800000`
 * becomes `**` + `/api/cart?_=*`. `?` is literal in Playwright's globs.
 */
export function mockUrlPattern(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const path = globSafe(parsed.pathname);
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
      const volatile = VOLATILE_PARAMS.has(decodedName.toLowerCase()) || looksVolatile(decodedValue);
      return rest.length === 0 ? globSafe(name) : `${globSafe(name)}=${volatile ? '*' : globSafe(value)}`;
    });
  return `**${path}?${params.join('&')}`;
}

/** Replaces the values of credential fields in a JSON value, counting them. Every key is kept, `__proto__` too. */
function hideInJson(value: unknown, count: { n: number }): unknown {
  if (Array.isArray(value)) return value.map((item) => hideInJson(item, count));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_FIELD.test(key) && (typeof item === 'string' || typeof item === 'number')) {
        count.n++;
        out[key] = HIDDEN_VALUE;
      } else out[key] = hideInJson(item, count);
    }
    return out;
  }
  return value;
}

/** Replaces the values of credential fields in `a=1&password=2`, counting them. */
function hideInForm(body: string, count: { n: number }): string {
  return body
    .split('&')
    .map((pair) => {
      const [name = '', ...rest] = pair.split('=');
      if (rest.length === 0 || !SECRET_FIELD.test(decodeURIComponentSafe(name))) return pair;
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

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
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
  const guard =
    method === 'GET' ? '' : `if (route.request().method() !== ${quoteJsString(method)}) return route.fallback();\n`;
  const wrap = (action: string) => {
    if (!guard) return `await page.route(${quoteJsString(pattern)}, (route) =>\n  ${indent(action, 2)},\n);`;
    return `await page.route(${quoteJsString(pattern)}, (route) => {\n  ${guard}  return ${indent(action, 2)};\n});`;
  };

  if (kind === 'abort') return { code: wrap('route.abort()'), file: null, hidden: 0 };
  if (kind === 'error') {
    return {
      code: wrap(`route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' })`),
      file: null,
      hidden: 0,
    };
  }

  const status = source.status && source.status !== 200 ? `status: ${source.status}, ` : '';
  const count = { n: 0 };
  const contentType = contentTypeOf(source.mimeType);
  let body = source.body ?? '';
  let json: { ok: true; value: unknown } | { ok: false } = { ok: false };
  if (!source.base64 && (isJsonType(contentType) || /^\s*[[{]/.test(body))) json = parseJson(body);
  if (json.ok && !options.reveal) json = { ok: true, value: hideInJson(json.value, count) };
  // With nothing hidden, a body that reading would change (an integer past 2^53, a `\u` escape) goes out as it came.
  const asIs = json.ok && count.n === 0 && JSON.stringify(json.value) !== compactJson(body);
  if (asIs) json = { ok: false };
  if (!json.ok && !source.base64 && !options.reveal && /x-www-form-urlencoded/i.test(contentType)) {
    body = hideInForm(body, count);
  }

  const text = json.ok ? JSON.stringify(json.value, null, 2) : body;
  if (text.length > maxInline) {
    const extension = json.ok || asIs ? 'json' : source.base64 ? 'bin' : 'txt';
    const path = `mocks/${mockFileName(source.url)}.${extension}`;
    const type = contentType ? `contentType: ${quoteJsString(contentType)}, ` : '';
    return {
      code: wrap(`route.fulfill({ ${status}${type}path: ${quoteJsString(path)} })`),
      file: { path, content: text, base64: !!source.base64 && !json.ok },
      hidden: count.n,
    };
  }
  if (json.ok) {
    return { code: wrap(`route.fulfill({\n  ${status}json: ${indent(text, 2)},\n})`), file: null, hidden: count.n };
  }
  const type = contentType ? `contentType: ${quoteJsString(contentType)}, ` : '';
  const bodyCode = source.base64 ? `Buffer.from(${quoteJsString(body)}, 'base64')` : quoteJsString(body);
  return { code: wrap(`route.fulfill({ ${status}${type}body: ${bodyCode} })`), file: null, hidden: count.n };
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
