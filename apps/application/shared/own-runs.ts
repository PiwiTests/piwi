/**
 * A person's own runs: the runs a runs list shows them whatever its partial-run and branch filters say. A run is its
 * reporter's (`test_runs.reporter_id`, the person whose credentials started it) or its requester's (`requester_id`, a
 * run asked for with a request token); with authentication off, one person uses the instance and every run is theirs.
 * A CI run is never anyone's own, whoever's key reported it, and neither is a lab run or an import.
 *
 * Only the lists of runs read it: a chart, a pass rate or any other reading of run history keeps the run scope. A list
 * answers `mine: true` for the viewer's own runs and nothing for the others, never a run's reporter.
 */
import { and, eq, isNotNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { testRuns } from '../server/database/schema';
import { CI_RUN_ORIGINS, LAB_RUN_ORIGINS } from './run-eligibility';

/** Who reads a runs list: with authentication on, the signed-in person (`userId`); with it off, the one person. */
export interface RunViewer {
  authEnabled: boolean;
  userId: number | null;
}

/** The viewer with authentication off: the one person using the instance, every run outside CI theirs. */
export const SOLE_USER: RunViewer = { authEnabled: false, userId: null };

/** The origins no run of which is anyone's own: CI, lab runs and imports. */
const NOT_OWN_ORIGINS: readonly string[] = [...CI_RUN_ORIGINS, ...LAB_RUN_ORIGINS, 'import'];

/** The run fields the rule reads. */
export interface OwnRunFields {
  origin: string | null;
  reporterId: number | null;
  requesterId: number | null;
}

/** Whether `run` is the viewer's own. A run of no known origin is nobody's. */
export function isOwnRun(run: OwnRunFields, viewer: RunViewer | null): boolean {
  if (!viewer || run.origin == null || NOT_OWN_ORIGINS.includes(run.origin)) return false;
  if (!viewer.authEnabled) return true;
  return viewer.userId != null && (run.reporterId === viewer.userId || run.requesterId === viewer.userId);
}

/** `isOwnRun` as a SQL predicate over `test_runs`. */
export function ownRunSql(viewer: RunViewer | null): SQL {
  if (!viewer || (viewer.authEnabled && viewer.userId == null)) return sql`1 = 0`;
  const origin = and(isNotNull(testRuns.origin), notInArray(testRuns.origin, [...NOT_OWN_ORIGINS]))!;
  if (!viewer.authEnabled) return origin;
  return and(origin, or(eq(testRuns.reporterId, viewer.userId!), eq(testRuns.requesterId, viewer.userId!)))!;
}

/** The `mine` flag a list row carries: `{ mine: true }` for an own run, nothing for any other. */
export function mineFlag(own: unknown): { mine?: true } {
  return own === true || own === 1 || own === '1' ? { mine: true } : {};
}

/** `ownRunSql` as a column a list selects, read back through `mineFlag`. */
export function ownRunColumn(viewer: RunViewer | null): SQL<number> {
  return sql<number>`case when ${ownRunSql(viewer)} then 1 else 0 end`;
}
