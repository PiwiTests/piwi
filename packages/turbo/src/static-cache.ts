// What a response leaves in the browser's HTTP cache, as keepStaticCache judges it.

/** A response `immutable` or fresh this long is static whatever its type, when nothing ties it to the user. */
export const STATIC_MAX_AGE = 7 * 24 * 60 * 60;

/** The content types of static assets: images, fonts, stylesheets, scripts, WebAssembly and media. */
const ASSET_TYPE =
  /^\s*(image\/|font\/|audio\/|video\/|text\/css|(text|application)\/(x-)?javascript|application\/wasm|application\/(x-)?font)/i;

/** The status codes a browser may cache with heuristic freshness (RFC 9111 §4.2.2). */
const HEURISTIC_STATUSES = new Set([200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501]);

/**
 * - `static`: a static asset the browser may keep: an image, font, stylesheet, script, WebAssembly module or media file,
 *   or any response `immutable` or fresh for a week; neither private, varying with cookies or credentials, nor setting
 *   a cookie.
 * - `reusable`: anything else the browser may serve again without asking the server.
 * - `revalidated`: kept only to ask the server again (`no-cache`, `max-age=0`, a validator alone), or not kept at all.
 */
export type CacheVerdict = 'static' | 'reusable' | 'revalidated';

/** What the browser's HTTP cache may keep of a response. Header names are lower-case, as Playwright gives them. */
export function cacheVerdict(
  method: string,
  status: number,
  headers: Record<string, string | undefined>,
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
  const personal =
    directives.has('private') ||
    headers['set-cookie'] !== undefined ||
    /(^|,)\s*(cookie|authorization|\*)\s*(,|$)/i.test(headers.vary ?? '');
  const longLived = directives.has('immutable') || (maxAge !== undefined && maxAge >= STATIC_MAX_AGE);
  if (!personal && (longLived || ASSET_TYPE.test(headers['content-type'] ?? ''))) return 'static';
  if (directives.has('stale-while-revalidate') || directives.has('stale-if-error')) return 'reusable';
  if (directives.has('no-cache')) return 'revalidated';
  if (maxAge !== undefined) return maxAge > 0 ? 'reusable' : 'revalidated';
  if (headers.expires !== undefined) {
    const expires = Date.parse(headers.expires);
    return Number.isFinite(expires) && expires > now ? 'reusable' : 'revalidated';
  }
  if (headers['last-modified'] !== undefined && HEURISTIC_STATUSES.has(status)) return 'reusable';
  return 'revalidated';
}
