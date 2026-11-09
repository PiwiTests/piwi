/**
 * The access check of the routes that read a tracker through the connection
 * their URL names (`/api/integrations/connections/:id/…`): the pickers of the
 * create-issue modal and of a project's Issue tracker settings.
 */
import type { H3Event } from 'h3';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../../database';
import type { DbClient } from '../../database';
import { projectIntegrations } from '../../database/schema';
import { apiError } from '../api-error';
import { getRequestAccess } from '../auth';
import { canReadThroughConnection, CONNECTION_NOT_FOUND } from '#shared/integrations/connection-access';

/**
 * Refuse a caller who may not read through the connection
 * (`canReadThroughConnection`, over the projects bound to it) with the 404 a
 * missing connection gets. Call it after `requireAuth`, before any cache or
 * tracker call. Returns the database.
 */
export async function requireConnectionAccess(event: H3Event, connectionId: number): Promise<DbClient> {
  const access = await getRequestAccess(event);
  const db = await getDatabase();
  const bindings = await db
    .select({ projectId: projectIntegrations.projectId })
    .from(projectIntegrations)
    .where(eq(projectIntegrations.connectionId, connectionId));
  const boundProjectIds = bindings.map((binding) => binding.projectId);
  if (!canReadThroughConnection(access, boundProjectIds)) {
    throw apiError({ statusCode: 404, message: CONNECTION_NOT_FOUND });
  }
  return db;
}
