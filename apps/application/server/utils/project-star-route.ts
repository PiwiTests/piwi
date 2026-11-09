import type { H3Event } from 'h3';
import { eq } from 'drizzle-orm';
import { getDatabase } from '../database';
import { projects } from '../database/schema';
import { apiError } from './api-error';
import { isAuthEnabled } from './auth';
import type { DrizzleDB } from '#shared/handlers/db';

/**
 * The checks the routes that star and unstar a project make once the caller's
 * access to it is checked: sign-in is on, since with authentication off the
 * browser keeps the stars, and the project exists. Returns the database.
 */
export async function requireStarrableProject(event: H3Event, projectId: number): Promise<DrizzleDB> {
  if (!isAuthEnabled(event)) {
    throw apiError({ statusCode: 409, message: 'Sign-in is off: stars are kept in this browser' });
  }
  const db = await getDatabase();
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw apiError({ statusCode: 404, message: 'Project not found' });
  return db;
}
