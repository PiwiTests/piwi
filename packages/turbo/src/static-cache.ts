// What a response leaves in the browser's HTTP cache, as keepStaticCache judges it.

/** An explicit lifetime this long makes an asset static, and any response requested without credentials. */
export const STATIC_MAX_AGE = 7 * 24 * 60 * 60;

/** The content types of static assets: images, fonts, stylesheets, scripts, WebAssembly and media. */
const ASSET_TYPE =
  /^\s*(image\/|font\/|audio\/|video\/|text\/css|(text|application)\/(x-)?javascript|application\/wasm|application\/(x-)?font)/i;

/** The status codes Chromium keeps fresh with no lifetime given: redirects and a gone resource. */
const KEPT_STATUSES = new Set([300, 301, 308, 410]);

/** The status codes Chromium gives a heuristic lifetime from `Last-Modified`. */
const HEURISTIC_STATUSES = new Set([200, 203, 206]);

/**
 * - `static`: a static asset the browser may keep: a response marked `immutable`; an image, font, stylesheet, script,
 *   WebAssembly module or media file with no lifetime of its own or one of a week or more; any other response fresh for
 *   a week whose request carried no cookie or credentials. Never one that is private, sets a cookie or varies with
 *   one.
 * - `reusable`: anything else the browser may serve again without asking the server.
 * - `revalidated`: kept only to ask the server again (`no-cache`, `max-age=0`, a validator alone), or not kept at all.
 */
export type CacheVerdict = 'static' | 'reusable' | 'revalidated';

type Headers = Record<string, string | undefined>;

/**
 * What the browser's HTTP cache may keep of a response. Header names are lower-case, as Playwright gives them;
 * `requestHeaders` are the request's as sent, with its cookie, and a response is judged as uncredentialed without
 * them.
 */
export function cacheVerdict(
  method: string,
  status: number,
  headers: Headers,
  requestHeaders: Headers = {},
  now = Date.now(),
): CacheVerdict {
  if (method !== 'GET' && method !== 'HEAD') return 'revalidated';
  const directives = new Map<string, string>();
  for (const part of (headers['cache-control'] ?? '').split(',')) {
    const [name, value = ''] = part.trim().toLowerCase().split('=');
    if (name) directives.set(name, value.replace(/"/g, ''));
  }
  if (directives.has('no-store')) return 'revalidated';
  const maxAge = directives.has('max-age') ? Number(directives.get('max-age')) : undefined;
  const stale = directives.has('stale-while-revalidate') || directives.has('stale-if-error');
  const askFirst = directives.has('no-cache') || maxAge === 0;
  if (KEPT_STATUSES.has(status)) return askFirst && !stale ? 'revalidated' : 'reusable';
  const personal =
    directives.has('private') ||
    headers['set-cookie'] !== undefined ||
    /(^|,)\s*(cookie|authorization|\*)\s*(,|$)/i.test(headers.vary ?? '');
  const credentialed = requestHeaders.cookie !== undefined || requestHeaders.authorization !== undefined;
  const explicit = maxAge !== undefined || headers.expires !== undefined;
  const longLived = maxAge !== undefined && maxAge >= STATIC_MAX_AGE;
  if (!personal) {
    if (directives.has('immutable')) return 'static';
    if (ASSET_TYPE.test(headers['content-type'] ?? '') && !askFirst && (!explicit || longLived)) return 'static';
    if (longLived && !credentialed) return 'static';
  }
  if (stale) return 'reusable';
  if (askFirst) return 'revalidated';
  if (maxAge !== undefined) return maxAge > 0 ? 'reusable' : 'revalidated';
  if (headers.expires !== undefined) {
    const expires = Date.parse(headers.expires);
    return Number.isFinite(expires) && expires > now ? 'reusable' : 'revalidated';
  }
  if (headers['last-modified'] !== undefined && HEURISTIC_STATUSES.has(status)) return 'reusable';
  return 'revalidated';
}
