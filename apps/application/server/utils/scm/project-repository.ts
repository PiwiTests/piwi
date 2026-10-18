import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { projects } from '../../database/schema';
import type { DbClient } from '../../database';
import { isEligibleRun } from '#shared/run-eligibility';
import { repositoryUrlFromRemote, sameRepository } from './git-url';

/** The projects a caller can read: every one, or these ids. */
type ProjectScope = 'all' | Set<number>;

/**
 * The repository a project's SCM calls read, with the project's or the
 * instance's SCM token: one URL per project, pinned by the first run that
 * names a remote and changed by a project admin. A run that names another
 * repository is ignored for SCM calls, so run metadata never chooses which
 * repository a token reads.
 */
export async function readProjectRepositoryUrl(db: DbClient, projectId: number): Promise<string | null> {
  const [project] = await db
    .select({ repositoryUrl: projects.repositoryUrl })
    .from(projects)
    .where(eq(projects.id, projectId));
  return repositoryUrlFromRemote(project?.repositoryUrl);
}

/**
 * The project's pinned repository when `candidateUrl` names it (in any form),
 * else null: the URL every SCM call of the project goes through.
 */
export async function projectRepositoryFor(
  db: DbClient,
  projectId: number,
  candidateUrl: string | null | undefined,
): Promise<string | null> {
  const pinned = await readProjectRepositoryUrl(db, projectId);
  return pinned && sameRepository(pinned, candidateUrl) ? pinned : null;
}

/**
 * Pin a project that has no repository yet to the one a run's metadata names
 * (`scm.remoteUrl`). A project that has one keeps it; a probe or lab run pins
 * nothing.
 */
export async function pinProjectRepository(db: DbClient, projectId: number, metadata: unknown): Promise<void> {
  if (!isEligibleRun({ metadata }, 'run-health')) return;
  const scm = (metadata as { scm?: { remoteUrl?: unknown } } | null)?.scm;
  const repositoryUrl = typeof scm?.remoteUrl === 'string' ? repositoryUrlFromRemote(scm.remoteUrl) : null;
  if (!repositoryUrl) return;
  await db
    .update(projects)
    .set({ repositoryUrl })
    .where(and(eq(projects.id, projectId), isNull(projects.repositoryUrl)));
}

/** Whether `repositoryUrl` is pinned by one of the projects of `scope`. */
export async function isRepositoryPinnedInScope(
  db: DbClient,
  scope: ProjectScope,
  repositoryUrl: string,
): Promise<boolean> {
  if (scope !== 'all' && scope.size === 0) return false;
  const rows = await db
    .select({ repositoryUrl: projects.repositoryUrl })
    .from(projects)
    .where(
      scope === 'all'
        ? isNotNull(projects.repositoryUrl)
        : and(isNotNull(projects.repositoryUrl), inArray(projects.id, [...scope])),
    );
  return rows.some((row) => sameRepository(row.repositoryUrl, repositoryUrl));
}
