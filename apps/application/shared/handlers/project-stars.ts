/**
 * The projects a signed-in user starred: list them, star one, unstar one.
 * Shared by the server routes and the demo.
 *
 * A star changes order only, never what the user may read: the list holds only
 * the projects the user can read now, so a star on a project they lost access
 * to is hidden, and shows again when the access comes back. With
 * authentication off there is no user to keep a star on: the browser keeps
 * the stars (`useStarredProjects`), and these handlers are not called.
 */
import { and, asc, eq } from 'drizzle-orm';
import { projects, projectStars } from '../../server/database/schema';
import type { DrizzleDB } from './db';

type ProjectScope = 'all' | Set<number>;

/** The ids of the projects the user starred and can read, in the order they were starred. */
export async function listProjectStars(
  db: DrizzleDB,
  userId: number,
  scope: ProjectScope = 'all',
): Promise<{ projectIds: number[] }> {
  if (scope !== 'all' && scope.size === 0) return { projectIds: [] };
  const rows = await db
    .select({ projectId: projectStars.projectId })
    .from(projectStars)
    .innerJoin(projects, eq(projects.id, projectStars.projectId))
    .where(eq(projectStars.userId, userId))
    .orderBy(asc(projectStars.createdAt), asc(projectStars.id));
  const projectIds = rows.map((row) => row.projectId);
  return { projectIds: scope === 'all' ? projectIds : projectIds.filter((id) => scope.has(id)) };
}

/** Star `projectId` for the user; starring it again changes nothing. */
export async function starProject(db: DrizzleDB, userId: number, projectId: number): Promise<void> {
  await db.insert(projectStars).values({ userId, projectId, createdAt: new Date() }).onConflictDoNothing();
}

/** Unstar `projectId` for the user; unstarring a project that has no star changes nothing. */
export async function unstarProject(db: DrizzleDB, userId: number, projectId: number): Promise<void> {
  await db.delete(projectStars).where(and(eq(projectStars.userId, userId), eq(projectStars.projectId, projectId)));
}

/** Delete every star a user owns (the user is being deleted). */
export async function deleteProjectStarsOf(db: DrizzleDB, userId: number): Promise<void> {
  await db.delete(projectStars).where(eq(projectStars.userId, userId));
}

/** Delete every star on a project (the project is being deleted). */
export async function deleteProjectStarsOn(db: DrizzleDB, projectId: number): Promise<void> {
  await db.delete(projectStars).where(eq(projectStars.projectId, projectId));
}
