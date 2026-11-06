/**
 * The projects a demo visitor starred (`server/api/projects/stars`, `server/api/projects/:id/star`),
 * kept in the in-browser database through the server's shared handler, per acting persona as the
 * server keeps them per user.
 */
import { eq } from 'drizzle-orm';
import { projects } from '../../../server/database/schema';
import { listProjectStars, starProject, unstarProject } from '#shared/handlers/project-stars';
import { getDemoDb } from '../db.client';
import { demoHttpError } from './http-error';

type ProjectScope = 'all' | Set<number>;

/** GET /api/projects/stars */
export async function apiListProjectStars(userId: number | null, scope: ProjectScope) {
  if (userId === null) return { projectIds: [] as number[] };
  return listProjectStars(await getDemoDb(), userId, scope);
}

/** The checks of the server's `requireStarrableProject`, once the caller's access is checked. */
async function starrableProject(userId: number | null, projectId: number): Promise<number> {
  if (userId === null) throw demoHttpError(409, 'Sign-in is off: stars are kept in this browser');
  const [project] = await (
    await getDemoDb()
  )
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw demoHttpError(404, 'Project not found');
  return userId;
}

/** PUT /api/projects/:id/star */
export async function apiStarProject(userId: number | null, projectId: number) {
  await starProject(await getDemoDb(), await starrableProject(userId, projectId), projectId);
  return { starred: true };
}

/** DELETE /api/projects/:id/star */
export async function apiUnstarProject(userId: number | null, projectId: number) {
  await unstarProject(await getDemoDb(), await starrableProject(userId, projectId), projectId);
  return { starred: false };
}
