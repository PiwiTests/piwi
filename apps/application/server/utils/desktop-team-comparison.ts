/**
 * Compare with team instance, on the desktop app's server: a local execution or a local test, compared with how the
 * same test does in the CI of the team project its folder is also linked to. The server names the test to the team
 * instance (its identity, Playwright project, environment, commit, branch and failure fingerprint) through the run
 * target's key (`compareWithTeam`), checks the answer (`testComparisonSchema`), then compares on this machine: the
 * environment diff against the closest CI pass and the conclusion. The local environment snapshot never leaves it.
 *
 * Answers are kept in memory for two minutes per instance, team project and question, never on disk.
 */
import { eq } from 'drizzle-orm';
import {
  compareWithTeam,
  runTargetConnection,
  teamProjectOfFolder,
  type TeamComparisonProblem,
} from '@piwitests/editor/run-target';
import { failureClusters, testCases, testRuns, testRunsCases } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { FINGERPRINT_VERSION } from '#shared/error-fingerprint';
import { computeEnvironmentDiff, type EnvironmentDiffEntry } from '#shared/environment-diff';
import { testComparisonSchema, type TestComparison } from '#shared/test-comparison';
import {
  teamConclusion,
  teamHistoryRows,
  type TeamConclusion,
  type TeamHistoryRow,
} from '#shared/test-comparison-conclusion';
import { desktopLinkedFolder } from './desktop-links';
import { executionEnvironmentSnapshot } from './environment-diff';
import { resolveRunBranch } from './run-branch';

/** How long an answer of the team instance is kept. */
const KEEP_MS = 2 * 60 * 1000;
/** How many answers are kept at most. */
const KEEP_MAX = 200;

/** Why there is no comparison: the run target's, or this server's. */
export type DesktopTeamComparisonProblem =
  | TeamComparisonProblem
  /** The local project has no folder linked on this machine. */
  | 'no-folder'
  /** The team instance answered something this version cannot read. */
  | 'unreadable';

export type DesktopTeamComparison =
  | {
      status: 'ok';
      /** The team instance's address: the pages the comparison names are its paths. */
      instance: string;
      teamProjectId: number;
      comparison: TestComparison;
      /** The team history in rows, the local run's environment first. */
      rows: TeamHistoryRow[];
      /** For a failing local execution; null otherwise, and for a test. */
      conclusion: TeamConclusion | null;
      /** What differs from the closest CI pass; null without one, and for a test. */
      environmentDiff: EnvironmentDiffEntry[] | null;
    }
  | { status: 'unavailable'; problem: DesktopTeamComparisonProblem; message: string };

const kept = new Map<
  string,
  { at: number; answer: { instance: string; projectId: number; comparison: TestComparison } }
>();

/** Forget every kept answer; for tests. */
export function forgetTeamComparisons(): void {
  kept.clear();
}

/** What the server asks the team instance about a test of `folder`, and what it read back, kept two minutes. */
async function askTeam(
  folder: string,
  query: Record<string, string>,
  now: number,
): Promise<
  | { ok: true; instance: string; projectId: number; comparison: TestComparison }
  | { ok: false; problem: DesktopTeamComparisonProblem; message: string }
> {
  const keyOf = (instance: string | null, projectId: number | null) => JSON.stringify([instance, projectId, query]);
  const connection = runTargetConnection();
  const connected = connection.state !== 'none' && connection.state !== 'revoked' && connection.state !== 'signing-in';
  const hit = connected ? kept.get(keyOf(connection.instance, await teamProjectOfFolder(folder))) : undefined;
  if (hit && now - hit.at < KEEP_MS) return { ok: true, ...hit.answer };
  const answered = await compareWithTeam(folder, query);
  if (!answered.ok) return answered;
  const cacheKey = keyOf(answered.instance, answered.projectId);
  const parsed = testComparisonSchema.safeParse(answered.answer);
  if (!parsed.success) {
    return { ok: false, problem: 'unreadable', message: 'The team instance answered something this app cannot read.' };
  }
  const answer = { instance: answered.instance, projectId: answered.projectId, comparison: parsed.data };
  kept.delete(cacheKey);
  kept.set(cacheKey, { at: now, answer });
  while (kept.size > KEEP_MAX) kept.delete(kept.keys().next().value!);
  return { ok: true, ...answer };
}

/** The question's values, the empty ones left out. */
function queryOf(values: Record<string, string | number | null | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) =>
      value === null || value === undefined || value === '' ? [] : [[key, String(value)]],
    ),
  );
}

const noFolder: DesktopTeamComparison = {
  status: 'unavailable',
  problem: 'no-folder',
  message: 'This project has no folder linked on this machine.',
};

/**
 * The comparison of local execution `executionId` of project `projectId`, a failing one with its conclusion and the
 * environment diff against the closest CI pass. Null for an execution that does not exist.
 */
export async function compareExecutionWithTeam(
  db: DrizzleDB,
  projectId: number,
  executionId: number,
  now = Date.now(),
): Promise<DesktopTeamComparison | null> {
  const [row] = await db
    .select({
      status: testRunsCases.status,
      playwrightProject: testRunsCases.browserName,
      clusterId: testRunsCases.failureClusterId,
      filePath: testCases.filePath,
      suitePath: testCases.suitePath,
      title: testCases.title,
      externalId: testCases.externalId,
      environment: testRuns.environment,
      branch: testRuns.branch,
      metadata: testRuns.metadata,
      commit: testRuns.commit,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .innerJoin(testCases, eq(testRunsCases.testCaseId, testCases.id))
    .where(eq(testRunsCases.id, executionId));
  if (!row) return null;
  const folder = desktopLinkedFolder(projectId);
  if (!folder) return noFolder;

  const [cluster] =
    row.clusterId != null
      ? await db
          .select({ fingerprint: failureClusters.fingerprint })
          .from(failureClusters)
          .where(eq(failureClusters.id, row.clusterId))
      : [];
  const fingerprint = cluster?.fingerprint ?? null;
  const branch = row.branch ?? resolveRunBranch(row.metadata);
  const worktree = (row.metadata as { scm?: { worktree?: unknown } } | null)?.scm?.worktree;
  const asked = await askTeam(
    folder,
    queryOf({
      externalId: row.externalId,
      filePath: row.filePath,
      suitePath: row.suitePath,
      title: row.title,
      playwrightProject: row.playwrightProject,
      environment: row.environment,
      branch,
      commit: row.commit,
      fingerprint,
      fingerprintVersion: fingerprint ? FINGERPRINT_VERSION : null,
    }),
    now,
  );
  if (!asked.ok) return { status: 'unavailable', problem: asked.problem, message: asked.message };

  const { comparison } = asked;
  const local = await executionEnvironmentSnapshot(db, executionId);
  const closest = comparison.closestPass;
  return {
    status: 'ok',
    instance: asked.instance,
    teamProjectId: asked.projectId,
    comparison,
    rows: teamHistoryRows(comparison.history, row.environment),
    conclusion: teamConclusion(comparison, {
      status: row.status,
      environment: row.environment,
      commit: row.commit,
      worktree: worktree === 'clean' || worktree === 'dirty' ? worktree : null,
      fingerprinted: fingerprint !== null,
    }),
    environmentDiff:
      local && closest
        ? computeEnvironmentDiff(local, {
            values: closest.snapshot.values,
            inferred: new Set(closest.snapshot.inferred),
          })
        : null,
  };
}

/** The comparison of local test `testCaseId` of project `projectId`: its team history alone. Null for no such test. */
export async function compareTestCaseWithTeam(
  db: DrizzleDB,
  projectId: number,
  testCaseId: number,
  now = Date.now(),
): Promise<DesktopTeamComparison | null> {
  const [row] = await db
    .select({
      filePath: testCases.filePath,
      suitePath: testCases.suitePath,
      title: testCases.title,
      externalId: testCases.externalId,
    })
    .from(testCases)
    .where(eq(testCases.id, testCaseId));
  if (!row) return null;
  const folder = desktopLinkedFolder(projectId);
  if (!folder) return noFolder;
  const asked = await askTeam(folder, queryOf(row), now);
  if (!asked.ok) return { status: 'unavailable', problem: asked.problem, message: asked.message };
  return {
    status: 'ok',
    instance: asked.instance,
    teamProjectId: asked.projectId,
    comparison: asked.comparison,
    rows: teamHistoryRows(asked.comparison.history, null),
    conclusion: null,
    environmentDiff: null,
  };
}
