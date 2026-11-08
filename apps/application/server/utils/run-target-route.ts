import type { H3Event } from 'h3';
import { cookiesOf, headersOf } from '@piwitests/editor/host-guard';
import { readJsonBody } from '@piwitests/editor/run-target-http';
import {
  answerRunTargetRoute,
  refuseRunTargetRequest,
  RUN_TARGET_ROUTES,
  sendsBody,
  type RunTargetRouteName,
} from '@piwitests/editor/run-target-routes';
import { apiError } from './api-error';
import { requireAuth } from './auth';

/**
 * A run-target route of the desktop build (`@piwitests/editor/run-target-routes`) on Nitro: 404 on the server build,
 * then the route answers once the request is authenticated (the desktop guard took the access token). Each route file
 * calls it with its route's name.
 */
export async function runTargetRoute(event: H3Event, name: RunTargetRouteName): Promise<unknown> {
  if (!process.env.PIWI_DESKTOP_TOKEN) throw apiError({ statusCode: 404, message: 'Desktop build only' });
  await requireAuth(event);
  const headers = headersOf(event.node.req.headers);
  const request = { headers, cookies: cookiesOf(headers.cookie), id: getRouterParam(event, 'id') };
  const answer =
    refuseRunTargetRequest(name, request) ??
    (await answerRunTargetRoute(name, {
      ...request,
      body: sendsBody(RUN_TARGET_ROUTES[name].method) ? await readJsonBody(event.node.req, Infinity) : null,
    }));
  if (answer.noStore) setResponseHeader(event, 'cache-control', 'no-store');
  if (answer.status >= 400) {
    throw apiError({ statusCode: answer.status, message: (answer.body as { message: string }).message });
  }
  return answer.body;
}
