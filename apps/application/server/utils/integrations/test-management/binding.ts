/**
 * Read and write a project's test management binding as a resolved settings object. The table keeps the binding in
 * typed columns plus JSON blobs (key sources, run scope, run policy, status names, options); this maps between them and
 * the flat {@link ResolvedTestManagementBinding} the settings endpoint and the catalog read.
 *
 * A project has at most one binding here, kept apart from the tracker binding: saving one never touches the other.
 */
import { eq } from 'drizzle-orm';
import { projectTestManagement } from '../../../database/schema';
import type { DbClient } from '../../../database';
import type { ProjectTestManagement } from '../../../database/schema';
import {
  resolveTestManagementBinding,
  type ResolvedTestManagementBinding,
} from '#shared/integrations/test-management-binding';

/** Map a stored binding row onto the resolved shape; the defaults for a project with none. */
export function testManagementRowToResolved(row: ProjectTestManagement | null): ResolvedTestManagementBinding {
  if (!row) return resolveTestManagementBinding({});
  return resolveTestManagementBinding({
    connectionId: row.connectionId,
    providerProjectKey: row.providerProjectKey,
    enabled: row.enabled,
    dryRun: row.dryRun,
    keySources: row.keySources,
    runScope: row.runScope,
    runPolicy: row.runPolicy,
    statuses: row.statuses,
    options: row.options,
  });
}

/** The project's resolved binding, or the defaults (no connection) when none is stored. */
export async function readTestManagementBinding(
  db: DbClient,
  projectId: number,
): Promise<ResolvedTestManagementBinding> {
  const [row] = await db
    .select()
    .from(projectTestManagement)
    .where(eq(projectTestManagement.projectId, projectId))
    .limit(1);
  return testManagementRowToResolved(row ?? null);
}

/**
 * Replace the project's binding with the normalized input and return what was stored. A null connection (or no
 * provider project) clears the binding; otherwise one row is kept for the project.
 */
export async function writeTestManagementBinding(
  db: DbClient,
  projectId: number,
  input: unknown,
): Promise<ResolvedTestManagementBinding> {
  const resolved = resolveTestManagementBinding(input);

  await db.transaction(async (tx) => {
    await tx.delete(projectTestManagement).where(eq(projectTestManagement.projectId, projectId));
    if (resolved.connectionId != null && resolved.providerProjectKey != null) {
      await tx.insert(projectTestManagement).values({
        projectId,
        connectionId: resolved.connectionId,
        providerProjectKey: resolved.providerProjectKey,
        enabled: resolved.enabled,
        dryRun: resolved.dryRun,
        keySources: resolved.keySources as never,
        runScope: resolved.runScope as never,
        runPolicy: resolved.runPolicy as never,
        statuses: resolved.statuses as never,
        options: resolved.options as never,
        updatedAt: new Date(),
      });
    }
  });

  return resolved.connectionId != null && resolved.providerProjectKey != null
    ? resolved
    : resolveTestManagementBinding({});
}
