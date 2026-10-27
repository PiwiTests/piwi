import type { Request, Response } from '@playwright/test';
import { MAX_KEPT_BODY, MAX_KEPT_RESPONSES, type KeptRequest, type KeptResponse } from '@piwitests/core/run-channel';
import { internalCall } from './quiet-capture.js';

/**
 * The responses an interactive run keeps for **Mock a request** at a stop: while the worker's run connection to the
 * editor is open, the text bodies of the fetch and XHR answers the running test's pages receive, from the test's start,
 * the latest `MAX_KEPT_RESPONSES` at most and `MAX_KEPT_BODY` bytes each, in this worker's memory alone. They never go
 * into an attachment or an upload, and they are dropped as the test ends. A stop lists them without their bodies
 * (`keptRequests`); the editor asks for the one chosen (`keptResponse`). The body is read as an internal call, once the
 * request finished.
 */

/** A kept response, with its body. */
interface Kept extends KeptRequest {
  body: string;
}

/** The test whose responses are kept: when it began, the responses, the last number given. */
interface Keeping {
  startedAt: number;
  kept: Kept[];
  last: number;
}

let keeping: Keeping | null = null;

/** The MIME types whose body is text. */
const TEXT_TYPE =
  /^(?:text\/[\w.+-]+|application\/(?:[\w.+-]+\+)?(?:json|xml)|application\/(?:javascript|x-www-form-urlencoded|graphql))$/i;

/** The MIME type of a `content-type` header without its parameters, lower case; empty for none. */
function mimeOf(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

/** Text a body decodes to, or null when it is not text: not UTF-8, or holding a NUL. */
function textOf(body: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

/** Keep the responses of the test that begins now, in place of any kept before. */
export function startKeeping(now: number = Date.now()): void {
  keeping = { startedAt: now, kept: [], last: 0 };
}

/** The test ended: every kept response is dropped. */
export function stopKeeping(): void {
  keeping = null;
}

/**
 * Keep a finished request's response when the running test keeps responses and it is a fetch or an XHR answer whose
 * body is text of `MAX_KEPT_BODY` bytes at most. A body larger than that is not read when the response says its size.
 * Never throws.
 */
export async function keepResponse(request: Request, response: Response | null): Promise<void> {
  const into = keeping;
  if (!into || !response) return;
  try {
    const kind = request.resourceType();
    if (kind !== 'fetch' && kind !== 'xhr') return;
    const url = request.url();
    const method = request.method().toUpperCase();
    if (url.length > 8192 || !/^[A-Z]{1,16}$/.test(method)) return;
    const headers = response.headers();
    const type = mimeOf(headers['content-type']);
    if (type && !TEXT_TYPE.test(type)) return;
    const declared = Number(headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_KEPT_BODY) return;
    const status = response.status();
    if (status < 100 || status > 599) return;
    const body = await internalCall(response, () => response.body());
    if (body.length > MAX_KEPT_BODY || keeping !== into) return;
    const text = textOf(body);
    if (text === null) return;
    into.kept.push({
      id: ++into.last,
      method,
      url,
      status,
      type,
      size: body.length,
      time: Math.max(0, Math.round(Date.now() - into.startedAt)),
      body: text,
    });
    if (into.kept.length > MAX_KEPT_RESPONSES) into.kept.splice(0, into.kept.length - MAX_KEPT_RESPONSES);
  } catch {
    // A body the browser no longer holds (a redirect, a page that closed) is not kept.
  }
}

/** The responses the running test kept, oldest first, without their bodies. */
export function keptRequests(): KeptRequest[] {
  return (keeping?.kept ?? []).map(({ body: _body, ...request }) => request);
}

/** The kept response `id`, with its body; null when the test kept none by that number. */
export function keptResponse(id: number): KeptResponse | null {
  const found = keeping?.kept.find((kept) => kept.id === id);
  return found
    ? { method: found.method, url: found.url, status: found.status, type: found.type, body: found.body }
    : null;
}
