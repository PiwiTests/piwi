/**
 * Read and write a project's tracker binding as a resolved settings object. The
 * table keeps the binding in typed columns (project key, issue type, labels …)
 * plus JSON blobs (field defaults, include toggles, policies, owner routes,
 * auto-create); this maps between those columns and the flat
 * {@link ResolvedProjectIntegration} the settings endpoint and the create-issue
 * draft both read.
 *
 * A project has at most one binding here — the endpoint replaces it whole, so a
 * connection change never leaves a second, stale row behind.
 */
import { eq } from 'drizzle-orm';
import { projectIntegrations } from '../../database/schema';
import type { DbClient } from '../../database';
import type { ProjectIntegration } from '../../database/schema';
import { resolveProjectIntegration, type ResolvedProjectIntegration } from '#shared/integrations/binding';
import { DEFAULT_LOCALE, toIssueLocale, type IssueLocale } from '#shared/integrations/messages';

/** The language of the project's tickets: the binding's, else the connection's default, else English. */
export function bindingLocale(binding: ResolvedProjectIntegration, connectionConfig: unknown): IssueLocale {
  if (binding.locale) return binding.locale;
  const config = (connectionConfig ?? null) as { locale?: string } | null;
  return toIssueLocale(config?.locale) ?? DEFAULT_LOCALE;
}

/** Map a stored binding row onto the flat resolved shape. */
export function bindingRowToResolved(row: ProjectIntegration | null): ResolvedProjectIntegration {
  return resolveProjectIntegration({
    connectionId: row?.connectionId ?? null,
    projectKey: row?.projectKey ?? null,
    issueType: row?.issueType ?? null,
    declaredIssueTypes: (row?.declaredIssueTypes as string[] | null) ?? null,
    labels: (row?.labels as string[] | null) ?? [],
    defaultAssignee: row?.defaultAssignee ?? null,
    fieldDefaults: (row?.fieldDefaults as ResolvedProjectIntegration['fieldDefaults']) ?? {},
    locale: (row?.locale as ResolvedProjectIntegration['locale']) ?? null,
    include: (row?.include as ResolvedProjectIntegration['include']) ?? undefined,
    policies: (row?.policies as ResolvedProjectIntegration['policies']) ?? undefined,
    ownerRoutes: (row?.ownerRoutes as ResolvedProjectIntegration['ownerRoutes']) ?? [],
    autoCreate: (row?.autoCreate as ResolvedProjectIntegration['autoCreate']) ?? undefined,
  });
}

/** The project's resolved binding, or the defaults when none is stored. */
export async function readProjectIntegration(db: DbClient, projectId: number): Promise<ResolvedProjectIntegration> {
  const [row] = await db
    .select()
    .from(projectIntegrations)
    .where(eq(projectIntegrations.projectId, projectId))
    .limit(1);
  return bindingRowToResolved(row ?? null);
}

/**
 * Replace the project's binding with the normalized input and return what was
 * stored. A null connection clears the binding; otherwise one row is kept for
 * the project, keyed by its connection.
 */
export async function writeProjectIntegration(
  db: DbClient,
  projectId: number,
  input: Partial<ResolvedProjectIntegration>,
): Promise<ResolvedProjectIntegration> {
  const resolved = resolveProjectIntegration(input);

  await db.transaction(async (tx) => {
    await tx.delete(projectIntegrations).where(eq(projectIntegrations.projectId, projectId));
    if (resolved.connectionId != null) {
      await tx.insert(projectIntegrations).values({
        projectId,
        connectionId: resolved.connectionId,
        projectKey: resolved.projectKey,
        issueType: resolved.issueType,
        declaredIssueTypes: resolved.declaredIssueTypes as never,
        labels: resolved.labels as never,
        defaultAssignee: resolved.defaultAssignee,
        fieldDefaults: resolved.fieldDefaults as never,
        locale: resolved.locale,
        include: resolved.include as never,
        policies: resolved.policies as never,
        ownerRoutes: resolved.ownerRoutes as never,
        autoCreate: resolved.autoCreate as never,
        updatedAt: new Date(),
      });
    }
  });

  return resolved;
}
