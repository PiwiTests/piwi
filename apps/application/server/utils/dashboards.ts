/**
 * What the server supplies to the shared dashboard handlers: who is asking,
 * and the translation of their refusals into API errors.
 */
import type { H3Event } from 'nitro/h3';
import type { User } from '../database/schema';
import { getRequestAccess, isAuthEnabled } from './auth';
import { apiError } from './api-error';
import { DashboardError, dashboardActorFor, type DashboardActor } from '#shared/handlers/dashboards';

export async function dashboardActor(event: H3Event, user: User): Promise<DashboardActor> {
  if (!isAuthEnabled()) return dashboardActorFor(null, null);
  return dashboardActorFor(user.id, await getRequestAccess(event));
}

/** Run a dashboard handler, turning its refusals into API errors. */
export async function dashboardRoute<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DashboardError) throw apiError({ statusCode: error.statusCode, message: error.message });
    throw error;
  }
}
