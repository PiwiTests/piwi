/**
 * What the project's test management endpoints share: loading the connection a request names and turning a provider's
 * refusal into the API's error shape. A provider's message never holds the token (the clients scrub it).
 */
import type { DbClient } from '../../../database';
import { apiError } from '../../api-error';
import { IntegrationHttpError } from '../http-error';
import { isProviderOfKind } from '#shared/integrations/registry';
import { getConnectionRow, markConnectionFailed, testManagementForRow } from '../connections';
import type { ZephyrClientOptions } from './zephyr-scale';
import type { TestManagementProvider } from './types';
import type { IntegrationConnection } from '../../../database/schema';

/** The connection a request names, which must be a test management connection with a usable token. */
export async function requireTestManagementClient(
  db: DbClient,
  connectionId: number,
  options: ZephyrClientOptions = {},
): Promise<{ row: IntegrationConnection; client: TestManagementProvider }> {
  const row = await getConnectionRow(db, connectionId);
  if (!row) throw apiError({ statusCode: 404, message: 'Connection not found' });
  if (!isProviderOfKind(row.provider, 'test-management')) {
    throw apiError({ statusCode: 400, message: 'A test management binding uses a test management connection only' });
  }
  const client = testManagementForRow(row, options);
  if (!client) throw apiError({ statusCode: 400, message: 'This connection has no usable credentials' });
  return { row, client };
}

/**
 * Turn a failed provider call into the API's error. A 401 also marks the connection failed, so it shows as needing
 * attention; a 429 is passed on as 429. The browser never sees the provider's status as its own 401 (that would sign
 * the person out), so any other failure is a 502.
 */
export async function failProviderCall(db: DbClient, connectionId: number, err: unknown): Promise<never> {
  if (err instanceof RangeError) throw apiError({ statusCode: 400, message: err.message });
  if (err instanceof IntegrationHttpError) {
    if (err.status === 401) await markConnectionFailed(db, connectionId, err.message);
    throw apiError({ statusCode: err.status === 429 ? 429 : 502, message: err.message });
  }
  throw apiError({ statusCode: 502, message: 'The test management tool could not be reached' });
}
