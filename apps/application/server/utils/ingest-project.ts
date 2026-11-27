import { eq } from 'drizzle-orm';
import { projects } from '../database/schema';
import type { Project } from '../database/schema';
import type { DbClient } from '../database';
import { apiError } from './api-error';
import { scopeAllows, type ProjectScope } from './project-access';

/**
 * The project an ingest request reports into, looked up by name and created on
 * first use. Only a caller whose scope covers every project may create one.
 * When two requests create the same project at once, the insert that loses the
 * race on the unique name does nothing and both get the row the winner wrote.
 * `beforeCreate` runs before a project is created, and refuses the request by
 * throwing: a request whose run is always a new one in a new project (past the
 * storage quota's ceiling) leaves no project behind.
 */
export async function resolveIngestProject(
  db: DbClient,
  scope: ProjectScope,
  name: string,
  description?: string | null,
  { beforeCreate }: { beforeCreate?: () => Promise<void> } = {},
): Promise<Project> {
  const findByName = async () => (await db.select().from(projects).where(eq(projects.name, name)))[0];

  const existing = await findByName();
  if (existing) {
    if (!scopeAllows(scope, existing.id)) {
      throw apiError({ statusCode: 403, message: 'No access to this project' });
    }
    return existing;
  }

  if (scope !== 'all') {
    throw apiError({ statusCode: 403, message: 'Cannot create a new project — no global access' });
  }
  await beforeCreate?.();
  const [created] = await db
    .insert(projects)
    .values({ name, description: description || null })
    .onConflictDoNothing({ target: projects.name })
    .returning();
  const project = created ?? (await findByName());
  if (!project) {
    throw apiError({ statusCode: 500, message: 'Failed to create or retrieve project' });
  }
  return project;
}
