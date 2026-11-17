import { eq } from 'drizzle-orm';
import { projects } from '../../server/database/schema';
import { storedRunVariables, type RunVariable } from '#shared/run-variables';
import type { DrizzleDB } from './db';

/** A project's run variables, in their order: `[]` for none, or for a project that does not exist. */
export async function readProjectRunVariables(db: DrizzleDB, projectId: number): Promise<RunVariable[]> {
  const [row] = await db
    .select({ runVariables: projects.runVariables })
    .from(projects)
    .where(eq(projects.id, projectId));
  return storedRunVariables(row?.runVariables);
}
