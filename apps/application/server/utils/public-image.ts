/**
 * An image fetched by the server from a public host, so the browser never calls
 * a third party: a tracker's avatar service, a sign-in provider's picture host.
 */

/** An image as the server serves it back. */
export interface PublicImage {
  bytes: Uint8Array;
  mime: string;
}

/** Redirects followed while they stay on the allowed hosts. */
const MAX_REDIRECTS = 3;

/** Whether an answer to a credentialed request says the image is unavailable for now (rate limit, outage, credentials), not missing. */
export function isTransientImageStatus(status: number): boolean {
  return status === 401 || status === 403 || isBusyStatus(status);
}

/** Whether a host is busy or down: a request with no credentials gets a 401 or 403 only for an image it will never serve. */
function isBusyStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * The image at `url`, fetched with no credentials, following redirects only
 * while `allowed` accepts each address. Null when it is not an image, weighs
 * more than `maxBytes`, or leaves the allowed hosts; throws when the host
 * cannot answer for now, so a caller does not remember the miss.
 */
export async function fetchPublicImage(
  url: string,
  allowed: (url: string) => boolean,
  { maxBytes, timeoutMs = 10_000 }: { maxBytes: number; timeoutMs?: number },
): Promise<PublicImage | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowed(current)) return null;
    const response = await fetch(current, {
      redirect: 'manual',
      headers: { Accept: 'image/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      current = new URL(location, current).toString();
      continue;
    }
    if (isBusyStatus(response.status)) throw new Error(`image host answered ${response.status}`);
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!response.ok || !mime.startsWith('image/')) return null;
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > maxBytes ? null : { bytes, mime };
  }
  return null;
}

/** The response headers of a served image: no type sniffing, and an SVG opened on its own runs no script. */
export const PUBLIC_IMAGE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
} as const;
