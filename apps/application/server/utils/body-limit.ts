import { getRequestWebStream, type H3Event } from 'h3';
import { apiError } from './api-error';
import { resolveMaxSubmitBytes } from './upload-limits';

/** Largest non-multipart request body the server reads. Uploads are multipart and carry their own limits. */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/** Largest body read by a route that takes requests from anyone, signed in or not. */
export const MAX_SIGN_IN_BODY_BYTES = 64 * 1024;

// The reporter's batch submit, and the results of a run it uploads in parts, carry a whole run as one JSON document:
// up to `PIWI_SUBMIT_MAX_BYTES` (`resolveMaxSubmitBytes`).
const SUBMIT_PATHS = ['/api/test-runs/submit', '/api/test-runs/upload/results'];

// The routes that read a body from anyone, signed in or not: sign-in, the first administrator, the password reset, and
// the OAuth registration, token and revocation endpoints of MCP clients.
const SIGN_IN_PATHS = [
  '/api/auth/login',
  '/api/auth/setup',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/oauth/register',
  '/oauth/token',
  '/oauth/revoke',
];

// Routes that parse a multipart body as a stream (`streamMultipart`), with caps
// counted on the bytes read. Any other route buffers what it reads.
const STREAMED_MULTIPART_PATHS = [
  /^\/api\/test-runs\/upload$/,
  /^\/api\/test-runs\/import$/,
  /^\/api\/test-runs\/[^/]+\/case-files$/,
  /^\/api\/projects\/[^/]+\/bug-reports$/,
];

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The path Nitro's router dispatches a request on: its query left out, and one trailing `/`. */
function routePath(path: string): string {
  return path.split('?')[0]!.replace(/(.)\/$/, '$1');
}

/** The largest body a route reads, and what a larger one answers. */
function bodyLimitFor(path: string): { maxBytes: number; message: string } {
  if (SUBMIT_PATHS.includes(path)) {
    const maxBytes = resolveMaxSubmitBytes();
    return {
      maxBytes,
      message: `Request body over ${Math.floor(maxBytes / 1024 / 1024)} MB: PIWI_SUBMIT_MAX_BYTES sets the limit on a run's results`,
    };
  }
  if (SIGN_IN_PATHS.includes(path)) {
    return { maxBytes: MAX_SIGN_IN_BODY_BYTES, message: `Request body over ${MAX_SIGN_IN_BODY_BYTES / 1024} KB` };
  }
  return { maxBytes: MAX_REQUEST_BODY_BYTES, message: `Request body over ${MAX_REQUEST_BODY_BYTES / 1024 / 1024} MB` };
}

/**
 * Why a request body must be refused before any route reads it, or null. A
 * body has to declare its size, since h3 buffers it whole: a chunked one (no
 * `Content-Length`) gets 411, one over its route's limit gets 413: a run's
 * results sent as JSON take up to `PIWI_SUBMIT_MAX_BYTES`, a route that takes
 * a body from anyone {@link MAX_SIGN_IN_BODY_BYTES}, any other body
 * {@link MAX_REQUEST_BODY_BYTES}. Routes that check `Content-Length` against a
 * smaller limit can then rely on it. A multipart body sent to a route that
 * streams it is left to that route.
 */
export function bodyLimitError(request: {
  method: string;
  path: string;
  contentType?: string | null;
  contentLength?: string | null;
  transferEncoding?: string | null;
}): { statusCode: 411 | 413; message: string } | null {
  if (!BODY_METHODS.has(request.method.toUpperCase())) return null;
  const path = routePath(request.path);
  const multipart = (request.contentType ?? '').toLowerCase().startsWith('multipart/form-data');
  if (multipart && STREAMED_MULTIPART_PATHS.some((route) => route.test(path))) return null;
  if (request.contentLength == null || request.contentLength === '') {
    return request.transferEncoding
      ? { statusCode: 411, message: 'Send the request body with a Content-Length header' }
      : null;
  }
  const length = Number(request.contentLength);
  const limit = bodyLimitFor(path);
  if (Number.isFinite(length) && length > limit.maxBytes) return { statusCode: 413, message: limit.message };
  return null;
}

/**
 * The bytes of a request body read from its stream, or null once they pass
 * `maxBytes`: the stream is cancelled there, whatever the headers said.
 */
export async function readStreamWithin(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * A request's JSON body, read within `maxBytes` (413 past them, with
 * `tooLarge` as the message); undefined when the body is empty or not JSON,
 * for the route's own check to refuse.
 */
export async function readJsonBodyWithin(event: H3Event, maxBytes: number, tooLarge: string): Promise<unknown> {
  const bytes = await readStreamWithin(getRequestWebStream(event), maxBytes);
  if (!bytes) throw apiError({ statusCode: 413, message: tooLarge });
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}
