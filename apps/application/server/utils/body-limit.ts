import { getRequestWebStream, type H3Event } from 'h3';
import { apiError } from './api-error';

/** Largest non-multipart request body the server reads. Uploads are multipart and carry their own limits. */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

// The reporter's batch submit carries a whole run as one JSON document.
const UNCAPPED_PATHS = ['/api/test-runs/submit'];

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Why a request body must be refused before any route reads it, or null. A
 * non-multipart body has to declare its size, since h3 buffers it whole: a
 * chunked one (no `Content-Length`) gets 411, one over
 * {@link MAX_REQUEST_BODY_BYTES} gets 413. Routes that check `Content-Length`
 * against a smaller limit can then rely on it.
 */
export function bodyLimitError(request: {
  method: string;
  path: string;
  contentType?: string | null;
  contentLength?: string | null;
  transferEncoding?: string | null;
}): { statusCode: 411 | 413; message: string } | null {
  if (!BODY_METHODS.has(request.method.toUpperCase())) return null;
  if ((request.contentType ?? '').toLowerCase().startsWith('multipart/form-data')) return null;
  if (request.contentLength == null || request.contentLength === '') {
    return request.transferEncoding
      ? { statusCode: 411, message: 'Send the request body with a Content-Length header' }
      : null;
  }
  const length = Number(request.contentLength);
  const path = request.path.split('?')[0]!;
  if (Number.isFinite(length) && length > MAX_REQUEST_BODY_BYTES && !UNCAPPED_PATHS.includes(path)) {
    return { statusCode: 413, message: `Request body over ${MAX_REQUEST_BODY_BYTES / 1024 / 1024} MB` };
  }
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
