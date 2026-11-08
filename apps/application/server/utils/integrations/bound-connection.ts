/**
 * The one connection a project reads and writes each kind of integration
 * through: the one its binding for that kind names. Each kind keeps its binding
 * in a table of its own, so writing one never touches another. Links are
 * tracker issues, read through the tracker binding. A link belongs to the project of the entity it is
 * pinned to (a failure cluster, a bug report, a run, an execution or a test).
 * Creating a link matches its URL against that connection alone, so a link to
 * another site stays a plain link. A link that carries another connection keeps
 * its URL and the status last read, and the status sync, the webhook and the
 * policies pass it by until the project is bound to that connection again.
 */
import { eq, inArray } from 'drizzle-orm';
import { bugReports, failureClusters, testCases, testRuns, testRunsCases } from '../../database/schema';
import type { EntityLink } from '../../database/schema';
import type { DbClient } from '../../database';
import type { IntegrationKind } from '#shared/integrations/registry';
import { readProjectIntegration } from './binding';

/**
 * The connection a project's binding for `kind` names, or null for no project, a project bound to none, or a kind
 * with no binding yet.
 */
export async function boundConnectionId(
  db: DbClient,
  projectId: number | null,
  kind: IntegrationKind,
): Promise<number | null> {
  if (projectId == null) return null;
  switch (kind) {
    case 'tracker':
      return (await readProjectIntegration(db, projectId)).connectionId;
    case 'test-management':
    case 'wiki':
      return null;
  }
}

/** Each kind of entity a link can be pinned to: the link's column for it, and the project of each of its ids. */
const LINK_ENTITIES: Array<{
  id: (link: EntityLink) => number | null;
  projects: (db: DbClient, ids: number[]) => Promise<Array<{ id: number; projectId: number }>>;
}> = [
  {
    id: (link) => link.failureClusterId,
    projects: async (db, ids) =>
      db
        .select({ id: failureClusters.id, projectId: failureClusters.projectId })
        .from(failureClusters)
        .where(inArray(failureClusters.id, ids)),
  },
  {
    id: (link) => link.bugReportId,
    projects: async (db, ids) =>
      db
        .select({ id: bugReports.id, projectId: bugReports.projectId })
        .from(bugReports)
        .where(inArray(bugReports.id, ids)),
  },
  {
    id: (link) => link.testRunId,
    projects: async (db, ids) =>
      db.select({ id: testRuns.id, projectId: testRuns.projectId }).from(testRuns).where(inArray(testRuns.id, ids)),
  },
  {
    id: (link) => link.testRunsCaseId,
    projects: async (db, ids) =>
      db
        .select({ id: testRunsCases.id, projectId: testRuns.projectId })
        .from(testRunsCases)
        .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
        .where(inArray(testRunsCases.id, ids)),
  },
  {
    id: (link) => link.testCaseId,
    projects: async (db, ids) =>
      db.select({ id: testCases.id, projectId: testCases.projectId }).from(testCases).where(inArray(testCases.id, ids)),
  },
];

/** The project of the entity each link is pinned to, by link id: one query per kind of entity among the links. */
async function linkProjects(db: DbClient, links: EntityLink[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const entity of LINK_ENTITIES) {
    const ids = [...new Set(links.map(entity.id).filter((id): id is number => id != null))];
    if (ids.length === 0) continue;
    const projects = new Map((await entity.projects(db, ids)).map((row) => [row.id, row.projectId]));
    for (const link of links) {
      const id = entity.id(link);
      const projectId = id == null ? undefined : projects.get(id);
      if (projectId != null) out.set(link.id, projectId);
    }
  }
  return out;
}

/** The links that carry the connection their project is bound to, in their order. */
export async function linksOnBoundConnection(db: DbClient, links: EntityLink[]): Promise<EntityLink[]> {
  const projects = await linkProjects(
    db,
    links.filter((link) => link.connectionId != null),
  );
  const bound = new Map<number, number | null>();
  for (const projectId of new Set(projects.values()))
    bound.set(projectId, await boundConnectionId(db, projectId, 'tracker'));
  return links.filter((link) => {
    const projectId = projects.get(link.id);
    return link.connectionId != null && projectId != null && bound.get(projectId) === link.connectionId;
  });
}
