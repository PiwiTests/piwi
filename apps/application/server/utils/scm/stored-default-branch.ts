/**
 * The default branch of a project resolved from stored data only, with no SCM
 * call and no provider import, so the demo mirror can share it with the server.
 */
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { projects, testRuns } from '../../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { FALLBACK_DEFAULT_BRANCH } from './git-url';

/** The project fields the resolver needs — a partial row is enough. */
export interface DefaultBranchProject {
  id: number;
  defaultBranch?: string | null;
}

/**
 * The branch the most of each project's runs are on — the best local guess at
 * the default branch when nothing has recorded one — for the projects that have
 * runs on a branch. Empty and whitespace branches are ignored; ties break on the
 * most recently seen run. One query per 500 projects, no network call.
 */
export async function mostCommonRunBranches(db: DrizzleDB, projectIds: number[]): Promise<Map<number, string>> {
  const common = new Map<number, string>();
  for (let i = 0; i < projectIds.length; i += 500) {
    const chunk = projectIds.slice(i, i + 500);
    const query = db
      .select({ projectId: testRuns.projectId, branch: testRuns.branch })
      .from(testRuns)
      .where(and(inArray(testRuns.projectId, chunk), isNotNull(testRuns.branch), ne(testRuns.branch, '')))
      .groupBy(testRuns.projectId, testRuns.branch)
      .orderBy(sql`count(*) desc`, sql`max(${testRuns.id}) desc`)
      .$dynamic();
    const rows: { projectId: number; branch: string | null }[] = await (chunk.length === 1 ? query.limit(1) : query);
    const seen = new Set<number>();
    for (const row of rows) {
      if (seen.has(row.projectId)) continue;
      seen.add(row.projectId);
      const branch = row.branch?.trim();
      if (branch) common.set(row.projectId, branch);
    }
  }
  return common;
}

/** `mostCommonRunBranches` for one project; null when none of its runs names a branch. */
export async function mostCommonRunBranch(db: DrizzleDB, projectId: number): Promise<string | null> {
  return (await mostCommonRunBranches(db, [projectId])).get(projectId) ?? null;
}

/**
 * The default branch resolved without any network call — the fallback tail every
 * canonical-graph path shares, so the ingest hot path, the nightly rebuild, the
 * project tabs and Analytics agree on which runs are on the default branch:
 *
 *   1. The project's stored default branch (`projects.default_branch`, filled by
 *      the SCM provider on an earlier run or set by an admin).
 *   2. The most common branch among the project's runs.
 *   3. `'main'`, the documented last resort.
 *
 * Always returns a branch, so a project whose SCM default is unknown still writes
 * canonical rows for its dominant branch instead of tagging every run.
 */
export async function resolveStoredDefaultBranches(
  db: DrizzleDB,
  projects: readonly DefaultBranchProject[],
): Promise<Map<number, string>> {
  const unset = projects.filter((project) => !project.defaultBranch?.trim()).map((project) => project.id);
  const common = await mostCommonRunBranches(db, unset);
  return new Map(
    projects.map((project) => [
      project.id,
      project.defaultBranch?.trim() || common.get(project.id) || FALLBACK_DEFAULT_BRANCH,
    ]),
  );
}

/** `resolveStoredDefaultBranches` for one project. */
export async function resolveStoredDefaultBranch(db: DrizzleDB, project: DefaultBranchProject): Promise<string> {
  return (await resolveStoredDefaultBranches(db, [project])).get(project.id)!;
}

/** `resolveStoredDefaultBranch` for a project known by its id. */
export async function projectDefaultBranch(db: DrizzleDB, projectId: number): Promise<string> {
  const [project] = await db
    .select({ id: projects.id, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, projectId));
  return resolveStoredDefaultBranch(db, project ?? { id: projectId });
}
