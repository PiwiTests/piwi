import type { Request, Response } from '@playwright/test';
import { hideSecretsInText } from '@piwitests/core/mask';
import { MAX_KEPT_BODY, MAX_KEPT_RESPONSES, type KeptRequest, type KeptResponse } from '@piwitests/core/run-channel';
import { internalCall } from './quiet-capture.js';

/**
 * The responses an interactive run keeps for **Mock a request** at a stop: while the worker's run connection to the
 * editor is open, the fetch and XHR answers the running test's pages receive whose type is text (or unnamed), from the
 * test's start, the latest `MAX_KEPT_RESPONSES` at most and `MAX_KEPT_BODY` bytes each, in this worker's memory alone:
 * each one's place in the list and its `Response`, whose body the browser holds, its size as the response says it. They never go into an attachment or
 * an upload, and they are dropped as the test ends. A stop lists them without their bodies, a credential in a URL
 * hidden (`keptRequests`); the editor asks for the one chosen (`keptResponse`), whose body is read then, as an
 * internal call, and handed over when it is text.
 */

/** A kept response, with the `Response` its body is read from. */
interface Kept extends KeptRequest {
  response: Response;
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
 * type is text, or unnamed, and whose body is `MAX_KEPT_BODY` bytes at most as its `content-length` says, or that
 * says no size. Neither its body nor its size is read from the browser. Never throws.
 */
export async function keepResponse(request: Request, response: Response | null): Promise<void> {
  const into = keeping;
  if (!into || !response) return;
  try {
    const kind = request.resourceType();
    if (kind !== 'fetch' && kind !== 'xhr') return;
    const url = hideSecretsInText(request.url());
    const method = request.method().toUpperCase();
    if (url.length > 8192 || !/^[A-Z]{1,16}$/.test(method)) return;
    const headers = response.headers();
    const type = mimeOf(headers['content-type']);
    if (type && !TEXT_TYPE.test(type)) return;
    const status = response.status();
    if (status < 100 || status > 599) return;
    const time = Math.max(0, Math.round(Date.now() - into.startedAt));
    const size = /^\d+$/.test(headers['content-length'] ?? '') ? Number(headers['content-length']) : null;
    if (size !== null && size > MAX_KEPT_BODY) return;
    into.kept.push({ id: ++into.last, method, url, status, type, size, time, response });
    if (into.kept.length > MAX_KEPT_RESPONSES) into.kept.splice(0, into.kept.length - MAX_KEPT_RESPONSES);
  } catch {
    // A request the browser no longer describes (a page that closed) is not kept.
  }
}

/** The responses the running test kept, oldest first, without their bodies, a credential in a URL hidden. */
export function keptRequests(): KeptRequest[] {
  return (keeping?.kept ?? []).map(({ id, method, url, status, type, size, time }) => ({
    id,
    method,
    url,
    status,
    type,
    size,
    time,
  }));
}

/**
 * The kept response `id`, with its body as the browser still holds it, read now; why not otherwise: no response kept
 * by that number, a body the browser no longer holds (a page that navigated or closed), one larger than
 * `MAX_KEPT_BODY` or not text. Its URL hides its credentials, as the list's does.
 */
export async function keptResponse(id: number): Promise<KeptResponse | { refusal: string }> {
  const found = keeping?.kept.find((kept) => kept.id === id);
  if (!found) return { refusal: 'The test kept no such response: it keeps the latest 50.' };
  let body: Buffer;
  try {
    body = await internalCall(found.response, () => found.response.body());
  } catch {
    return {
      refusal: "The browser no longer holds this answer's body: mock one the page received since it last loaded.",
    };
  }
  if (body.length > MAX_KEPT_BODY) return { refusal: 'This answer is larger than 256 KB: Piwi mocks a smaller one.' };
  const text = textOf(body);
  if (text === null) return { refusal: 'This answer is not text: Piwi mocks a text answer.' };
  return { method: found.method, url: found.url, status: found.status, type: found.type, body: text };
}
