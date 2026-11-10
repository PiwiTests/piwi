/**
 * What the project's test management endpoints share: loading the connection a request names and turning a provider's
 * refusal into the API's error shape. A provider's message never holds the token (the clients scrub it).
 */
import type { H3Event } from 'h3';
import type { DbClient } from '../../../database';
import { apiError } from '../../api-error';
import { IntegrationHttpError } from '../http-error';
import { connectionPausedUntil, pauseConnectionById, RATE_LIMIT_PAUSE_MS } from '../actions';
import { isProviderOfKind } from '#shared/integrations/registry';
import {
  getConnectionRow,
  markConnectionFailed,
  testManagementForRow,
  type TestManagementClientOptions,
} from '../connections';
import { RequestLimiterBusyError } from './limiter';
import type { TestManagementProvider } from './types';
import type { IntegrationConnection } from '../../../database/schema';

/** Answer 429 with a `Retry-After` of `waitMs`, in whole seconds. */
export function refuseRateLimited(event: H3Event, waitMs: number, message: string): never {
  setResponseHeader(event, 'Retry-After', Math.max(1, Math.ceil(waitMs / 1000)));
  throw apiError({ statusCode: 429, message });
}

/**
 * The connection a request names, which must be a test management connection with a usable token. A connection the
 * tool rate limited is refused with 429 until its pause ends, without a call.
 */
export async function requireTestManagementClient(
  event: H3Event,
  db: DbClient,
  connectionId: number,
  options: TestManagementClientOptions = {},
): Promise<{ row: IntegrationConnection; client: TestManagementProvider }> {
  const row = await getConnectionRow(db, connectionId);
  if (!row) throw apiError({ statusCode: 404, message: 'Connection not found' });
  if (!isProviderOfKind(row.provider, 'test-management')) {
    throw apiError({ statusCode: 400, message: 'A test management binding uses a test management connection only' });
  }
  const client = testManagementForRow(row, options);
  if (!client) throw apiError({ statusCode: 400, message: 'This connection has no usable credentials' });
  const now = new Date();
  const paused = connectionPausedUntil(connectionId, now);
  if (paused)
    refuseRateLimited(event, paused.getTime() - now.getTime(), `Paused until ${paused.toISOString()}: rate limited`);
  return { row, client };
}

/**
 * Turn a failed provider call into the API's error. A 401 also marks the connection failed, so it shows as needing
 * attention; a 429 pauses the connection for as long as the tool asked and is passed on as 429 with that wait; a
 * request that would queue longer than its caller waits is a 429 with the wait, and pauses nothing. The browser never
 * sees the provider's status as its own 401 (that would sign the person out), so any other failure is a 502.
 */
export async function failProviderCall(
  event: H3Event,
  db: DbClient,
  connectionId: number,
  err: unknown,
): Promise<never> {
  if (err instanceof RangeError) throw apiError({ statusCode: 400, message: err.message });
  if (err instanceof RequestLimiterBusyError) refuseRateLimited(event, err.retryAfterMs ?? 0, err.message);
  if (err instanceof IntegrationHttpError) {
    if (err.status === 401) await markConnectionFailed(db, connectionId, err.message);
    if (err.status === 429) {
      const waitMs = err.retryAfterMs || RATE_LIMIT_PAUSE_MS;
      await pauseConnectionById(db, connectionId, waitMs, new Date());
      refuseRateLimited(event, waitMs, err.message);
    }
    throw apiError({ statusCode: 502, message: err.message });
  }
  throw apiError({ statusCode: 502, message: 'The test management tool could not be reached' });
}
