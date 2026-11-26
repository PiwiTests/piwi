import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { H3Event } from 'nitro/h3';
import { apiError } from './api-error';

/**
 * The Node request and response of `event`, for a route that writes its answer to the response itself: a stream that
 * counts what its reader has not read yet. Such a route returns `responseClosed(res)`. A request made in process
 * (a `$fetch` while a page renders) has none, and is refused.
 */
export function nodeHttp(event: H3Event): { req: IncomingMessage; res: ServerResponse } {
  const node = event.runtime?.node;
  if (!node?.res) throw apiError({ statusCode: 400, message: 'This route answers over an HTTP connection only' });
  return { req: node.req as IncomingMessage, res: node.res as ServerResponse };
}

/**
 * Settles once `res` closes, so the server, which ends the response when the route settles, leaves the response the
 * route writes itself open until then. Settles at once when the route wrote nothing to it.
 */
export function responseClosed(res: ServerResponse): Promise<void> {
  if (!res.headersSent || res.closed) return Promise.resolve();
  return new Promise((resolve) => res.once('close', () => resolve()));
}

/** The socket the request arrived on; none for a request made in process. */
export function requestSocket(event: H3Event): Socket | undefined {
  const node = event.runtime?.node;
  return (node?.req as IncomingMessage | undefined)?.socket;
}
