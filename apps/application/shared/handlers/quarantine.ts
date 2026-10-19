/**
 * Quarantine — with an exit ramp.
 *
 * The usual quarantine is `--grep-invert @quarantine`: the test stops running,
 * so nothing ever proves it is fixed, and the list only ever grows. A year
 * later nobody remembers why half of it is there.
 *
 * Here a quarantined test keeps running and keeps reporting. It is excluded
 * from the [CI gate](./gate)'s verdict and nothing else. That one difference is
 * what makes the exit possible: consecutive passes accumulate, and once a test
 * has earned its way out the dashboard says so instead of waiting to be asked.
 * A Flake Lab verified fix made after the quarantine, still holding, earns it
 * at once. Release itself is always a person's action.
 *
 * Both proposals are hand-backs (`quarantine-proposal`): quarantining a
 * proposed test, or releasing a test whose release was proposed, records
 * `applied`; dismissing either proposal records `rejected`.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { quarantinedTests, testCases, testRuns, testRunsCases } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import { eligibleExecutionInProject } from '../run-eligibility';
import { getHoldingVerifiedFixes, type VerifiedFix } from './flake-verified';
import { listOutcomes, recordOutcome } from '../../server/utils/outcomes';
import { proposeQuarantineCandidates } from '../../server/utils/quarantine-candidates';
import type { HandbackActor } from '../handback-outcomes';
import { normalizeDismissReason, type QuarantineProposal } from '#shared/quarantine-proposals';

/** Consecutive passing runs after which release is proposed. */
export const RELEASE_AFTER_CONSECUTIVE_PASSES = 5;

/** Executions scanned per test when counting the current streak. */
const STREAK_SCAN_LIMIT = 30;

const FAIL_STATUSES = ['failed', 'timedOut', 'timedout'];

export interface QuarantineEntry {
  id: number;
  testCaseId: number;
  title: string;
  filePath: string;
  reason: string | null;
  source: string;
  owner: string | null;
  tags: string[] | null;
  createdAt: Date | string;
  /** How long this test has been quarantined, in ms. */
  ageMs: number;
  /** Passing runs since quarantine, counted back from the newest. */
  consecutivePasses: number;
  /** True once the streak clears the threshold, or a verified fix holds — time to let it out. */
  releaseProposed: boolean;
  /** Why release is proposed: the passing streak, or a verified fix; null when it is not. */
  releaseReason: 'streak' | 'verified-fix' | null;
  /** The Flake Lab verified fix made since the quarantine, while it holds. */
  verifiedFix: VerifiedFix | null;
  /** Runs seen since quarantine; zero means nothing has exercised it yet. */
  runsSinceQuarantine: number;
}

/** Aggregate cost of the quarantine list — the debt, so it cannot be ignored. */
export interface QuarantineDebt {
  active: number;
  /** Entries whose streak says they should be released. */
  readyToRelease: number;
  /** Age of the oldest active quarantine, in ms. */
  oldestAgeMs: number;
  /** Entries with no passing streak at all — still genuinely broken. */
  stillFailing: number;
}

/** Test-case ids currently quarantined in a project. Used by the CI gate. */
export async function getQuarantinedCaseIds(db: DrizzleDB, projectId: number): Promise<Set<number>> {
  const rows = await db
    .select({ testCaseId: quarantinedTests.testCaseId })
    .from(quarantinedTests)
    .where(and(eq(quarantinedTests.projectId, projectId), isNull(quarantinedTests.releasedAt)));
  return new Set(rows.map((row) => row.testCaseId));
}

/** How many distinct tests of a failure cluster are currently quarantined. */
export async function countQuarantinedClusterTests(
  db: DrizzleDB,
  projectId: number,
  clusterId: number,
): Promise<number> {
  const [row] = await db
    .select({ tests: sql<number>`count(distinct ${testRunsCases.testCaseId})` })
    .from(testRunsCases)
    .innerJoin(quarantinedTests, eq(quarantinedTests.testCaseId, testRunsCases.testCaseId))
    .where(
      and(
        eq(testRunsCases.failureClusterId, clusterId),
        eq(quarantinedTests.projectId, projectId),
        isNull(quarantinedTests.releasedAt),
      ),
    );
  return Number(row?.tests ?? 0);
}

/**
 * Trailing passing streak for each test, counted over executions recorded after
 * the run the test was quarantined at. Ordered newest first and stopped at the
 * first failure, so a single recent flake resets the count — which is the point.
 * Only runs the `flakiness` use reads count: lab runs (probes, flake
 * experiments) replay the test under injected faults or conditions, bisect and
 * reproduction runs replay an older commit, and an environment incident fails
 * every test at once, so none of them counts toward or breaks a streak.
 *
 * One query for the whole list: each test's executions since its own quarantine
 * run are ranked newest-first with a window function, and only the first
 * `STREAK_SCAN_LIMIT` of each are read back. The project's runs since the
 * earliest quarantine run that the use leaves out are listed once for it
 * (`eligibleExecutionInProject`).
 */
async function computeStreaks(
  db: DrizzleDB,
  projectId: number,
  entries: Array<{ testCaseId: number; quarantinedAtRunId: number | null }>,
): Promise<Map<number, { passes: number; runs: number }>> {
  const streaks = new Map<number, { passes: number; runs: number }>();
  if (entries.length === 0) return streaks;

  // Every execution read is of a run after the earliest quarantine run, unless an entry names none.
  const quarantineRuns = entries.map((entry) => entry.quarantinedAtRunId);
  const earliestRun = quarantineRuns.every((id) => id != null) ? Math.min(...(quarantineRuns as number[])) : null;

  const sinceQuarantine = or(
    ...entries.map((entry) =>
      and(
        eq(testRunsCases.testCaseId, entry.testCaseId),
        entry.quarantinedAtRunId != null ? gt(testRunsCases.testRunId, entry.quarantinedAtRunId) : sql`1 = 1`,
      ),
    ),
  );

  const ranked = db
    .select({
      testCaseId: testRunsCases.testCaseId,
      status: testRunsCases.status,
      id: testRunsCases.id,
      newestRank:
        sql<number>`row_number() over (partition by ${testRunsCases.testCaseId} order by ${testRunsCases.id} desc)`.as(
          'newest_rank',
        ),
    })
    .from(testRunsCases)
    .where(
      and(
        sinceQuarantine,
        eligibleExecutionInProject(
          'flakiness',
          projectId,
          testRunsCases.testRunId,
          earliestRun != null ? gt(testRuns.id, earliestRun) : undefined,
        ),
      ),
    )
    .as('ranked');

  const rows = await db
    .select({ testCaseId: ranked.testCaseId, status: ranked.status, id: ranked.id })
    .from(ranked)
    .where(lte(ranked.newestRank, STREAK_SCAN_LIMIT))
    .orderBy(desc(ranked.id));

  const byCase = new Map<number, Array<{ status: string }>>();
  for (const row of rows) {
    const list = byCase.get(row.testCaseId);
    if (list) list.push(row);
    else byCase.set(row.testCaseId, [row]);
  }

  for (const entry of entries) {
    const executions = byCase.get(entry.testCaseId) ?? [];
    let passes = 0;
    for (const row of executions) {
      if (row.status === 'passed') passes++;
      else if (FAIL_STATUSES.includes(row.status)) break;
      // Skipped / didnotrun executions prove nothing either way; ignore them
      // rather than counting or breaking the streak.
    }
    streaks.set(entry.testCaseId, { passes, runs: executions.length });
  }

  return streaks;
}

function toMs(value: Date | string | number): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/** An active entry's exit progress: its passing streak, and a verified fix made since the quarantine. */
interface ReleaseProgress {
  streak: { passes: number; runs: number };
  verifiedFix: VerifiedFix | null;
  /** The streak cleared the threshold. */
  earned: boolean;
}

async function releaseProposals(
  db: DrizzleDB,
  projectId: number,
  entries: Array<{ testCaseId: number; quarantinedAtRunId: number | null; createdAt: Date | string | number }>,
): Promise<Map<number, ReleaseProgress>> {
  const streaks = await computeStreaks(db, projectId, entries);
  const fixes = await getHoldingVerifiedFixes(
    db,
    entries.map((entry) => entry.testCaseId),
  );
  const out = new Map<number, ReleaseProgress>();
  for (const entry of entries) {
    const streak = streaks.get(entry.testCaseId) ?? { passes: 0, runs: 0 };
    const fix = fixes.get(entry.testCaseId);
    // Only a fix verified after the test was quarantined says it earned its way out.
    const verifiedFix = fix && new Date(fix.verifiedAt).getTime() >= toMs(entry.createdAt) ? fix : null;
    out.set(entry.testCaseId, { streak, verifiedFix, earned: streak.passes >= RELEASE_AFTER_CONSECUTIVE_PASSES });
  }
  return out;
}

/** The active quarantine list for a project, with each test's exit progress. */
export async function listQuarantine(
  db: DrizzleDB,
  projectId: number,
): Promise<{ entries: QuarantineEntry[]; debt: QuarantineDebt }> {
  const rows: any[] = await db
    .select({
      id: quarantinedTests.id,
      testCaseId: quarantinedTests.testCaseId,
      reason: quarantinedTests.reason,
      source: quarantinedTests.source,
      quarantinedAtRunId: quarantinedTests.quarantinedAtRunId,
      createdAt: quarantinedTests.createdAt,
      title: testCases.title,
      filePath: testCases.filePath,
      owner: testCases.owner,
      tags: testCases.tags,
    })
    .from(quarantinedTests)
    .innerJoin(testCases, eq(quarantinedTests.testCaseId, testCases.id))
    .where(and(eq(quarantinedTests.projectId, projectId), isNull(quarantinedTests.releasedAt)))
    .orderBy(asc(quarantinedTests.createdAt));

  const proposals = await releaseProposals(db, projectId, rows);
  const now = Date.now();

  const entries: QuarantineEntry[] = rows.map((row) => {
    const { streak, verifiedFix, earned } = proposals.get(row.testCaseId)!;
    const createdMs = toMs(row.createdAt);
    return {
      id: row.id,
      testCaseId: row.testCaseId,
      title: row.title,
      filePath: row.filePath,
      reason: row.reason,
      source: row.source,
      owner: row.owner ?? null,
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : null,
      createdAt: row.createdAt,
      ageMs: Math.max(0, now - createdMs),
      consecutivePasses: streak.passes,
      releaseProposed: earned || verifiedFix != null,
      releaseReason: verifiedFix ? 'verified-fix' : earned ? 'streak' : null,
      verifiedFix,
      runsSinceQuarantine: streak.runs,
    };
  });

  const debt: QuarantineDebt = {
    active: entries.length,
    readyToRelease: entries.filter((entry) => entry.releaseProposed).length,
    oldestAgeMs: entries.reduce((max, entry) => Math.max(max, entry.ageMs), 0),
    stillFailing: entries.filter((entry) => entry.runsSinceQuarantine > 0 && entry.consecutivePasses === 0).length,
  };

  return { entries, debt };
}

/**
 * Quarantine a test. Idempotent: quarantining an already-quarantined test
 * leaves the original entry (and its streak) alone rather than resetting it.
 */
export async function addQuarantine(
  db: DrizzleDB,
  projectId: number,
  testCaseId: number,
  options: { reason?: string | null; source?: string; createdBy?: number | null; actor?: HandbackActor } = {},
): Promise<{ created: boolean }> {
  const [testCase] = await db
    .select({ id: testCases.id, projectId: testCases.projectId })
    .from(testCases)
    .where(eq(testCases.id, testCaseId));
  if (!testCase || testCase.projectId !== projectId) throw new Error('Test case not found in this project');

  const existing = await db
    .select({ id: quarantinedTests.id })
    .from(quarantinedTests)
    .where(and(eq(quarantinedTests.testCaseId, testCaseId), isNull(quarantinedTests.releasedAt)));
  if (existing.length > 0) return { created: false };

  // Anchor the streak to the newest run so executions already recorded cannot
  // count toward release — the point of quarantining is that history is bad.
  const [latestRun] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId))
    .orderBy(desc(testRuns.id))
    .limit(1);

  const source = options.source === 'proposed' ? 'proposed' : 'manual';
  await db.insert(quarantinedTests).values({
    projectId,
    testCaseId,
    reason: options.reason ?? null,
    source,
    quarantinedAtRunId: latestRun?.id ?? null,
    // With authentication disabled the request carries a synthetic user whose
    // id is 0, which no `users` row has — store null rather than tripping the
    // foreign key on an instance that has no accounts at all.
    createdBy: typeof options.createdBy === 'number' && options.createdBy > 0 ? options.createdBy : null,
  });

  if (source === 'proposed') {
    await recordOutcome(db, {
      projectId,
      kind: 'quarantine-proposal',
      subjectType: 'test-case',
      subjectId: testCaseId,
      suggestionKey: 'quarantine',
      outcome: 'applied',
      actor: options.actor ?? { channel: 'ui', userId: options.createdBy ?? null },
      runId: latestRun?.id ?? null,
    });
  }
  return { created: true };
}

/**
 * Let a test back out. Keeps the row as history rather than deleting it. A
 * release that was proposed records the proposal's `applied` outcome.
 */
export async function releaseQuarantine(
  db: DrizzleDB,
  projectId: number,
  testCaseId: number,
  reason?: string | null,
  actor: HandbackActor = { channel: 'ui' },
): Promise<{ released: boolean }> {
  const active = await db
    .select({
      id: quarantinedTests.id,
      testCaseId: quarantinedTests.testCaseId,
      quarantinedAtRunId: quarantinedTests.quarantinedAtRunId,
      createdAt: quarantinedTests.createdAt,
    })
    .from(quarantinedTests)
    .where(
      and(
        eq(quarantinedTests.projectId, projectId),
        eq(quarantinedTests.testCaseId, testCaseId),
        isNull(quarantinedTests.releasedAt),
      ),
    );
  if (active.length === 0) return { released: false };

  const proposal = (await releaseProposals(db, projectId, active)).get(testCaseId);
  const releasedAt = new Date();
  await db
    .update(quarantinedTests)
    .set({ releasedAt, releasedReason: reason ?? null })
    .where(
      inArray(
        quarantinedTests.id,
        active.map((row) => row.id),
      ),
    );
  if (proposal && (proposal.earned || proposal.verifiedFix)) {
    await recordOutcome(db, {
      projectId,
      kind: 'quarantine-proposal',
      subjectType: 'test-case',
      subjectId: testCaseId,
      suggestionKey: `release:${active[0]!.id}`,
      outcome: 'applied',
      actor,
      details: { reason: proposal.verifiedFix ? 'verified-fix' : 'streak', consecutivePasses: proposal.streak.passes },
      at: releasedAt,
    });
  }
  return { released: true };
}

/**
 * A person or an agent dismissing a proposal: to quarantine a test
 * (`quarantine`, while the test is a candidate), or to release a quarantined
 * one (`release`, while its release is proposed). Records the proposal's
 * `rejected` outcome with the optional reason, once per proposal; the proposal
 * itself is derived and stays listed. Returns false when there is no such
 * proposal to dismiss, and throws when the test is not in the project.
 */
export async function dismissQuarantineProposal(
  db: DrizzleDB,
  projectId: number,
  testCaseId: number,
  proposal: QuarantineProposal,
  actor: HandbackActor,
  reason?: string | null,
): Promise<boolean> {
  const [testCase] = await db
    .select({ projectId: testCases.projectId })
    .from(testCases)
    .where(eq(testCases.id, testCaseId));
  if (!testCase || testCase.projectId !== projectId) throw new Error('Test case not found in this project');

  const [active] = await db
    .select({
      id: quarantinedTests.id,
      testCaseId: quarantinedTests.testCaseId,
      quarantinedAtRunId: quarantinedTests.quarantinedAtRunId,
      createdAt: quarantinedTests.createdAt,
    })
    .from(quarantinedTests)
    .where(
      and(
        eq(quarantinedTests.projectId, projectId),
        eq(quarantinedTests.testCaseId, testCaseId),
        isNull(quarantinedTests.releasedAt),
      ),
    );
  if (proposal === 'release') {
    if (!active) return false;
    const progress = (await releaseProposals(db, projectId, [active])).get(testCaseId);
    if (!progress?.earned && !progress?.verifiedFix) return false;
  } else {
    if (active) return false;
    const candidates = await proposeQuarantineCandidates(db, projectId, await getQuarantinedCaseIds(db, projectId));
    if (!candidates.some((candidate) => candidate.testCaseId === testCaseId)) return false;
  }
  // A quarantine proposal is scoped to the newest run, so one dismissed again after new runs counts again.
  const [latestRun] =
    proposal === 'quarantine'
      ? await db
          .select({ id: testRuns.id })
          .from(testRuns)
          .where(eq(testRuns.projectId, projectId))
          .orderBy(desc(testRuns.id))
          .limit(1)
      : [];
  const note = normalizeDismissReason(reason);
  await recordOutcome(db, {
    projectId,
    kind: 'quarantine-proposal',
    subjectType: 'test-case',
    subjectId: testCaseId,
    suggestionKey: proposal === 'release' ? `release:${active!.id}` : 'quarantine',
    outcome: 'rejected',
    actor,
    runId: latestRun?.id ?? null,
    details: note ? { reason: note } : null,
  });
  return true;
}

/**
 * Marks the dismissed proposals of a project's quarantine list: `releaseDismissed`
 * on each entry whose proposed release was dismissed, and `dismissed` on each
 * candidate dismissed since the newest run.
 */
export async function markDismissedProposals<C extends { testCaseId: number }>(
  db: DrizzleDB,
  projectId: number,
  entries: QuarantineEntry[],
  candidates: C[],
): Promise<{
  entries: Array<QuarantineEntry & { releaseDismissed: boolean }>;
  candidates: Array<C & { dismissed: boolean }>;
}> {
  const dismissedCandidates = new Set<number>();
  const dismissedReleases = new Set<number>();
  const rows = await listOutcomes(db, { projectId, kind: 'quarantine-proposal', outcomes: ['rejected'] });
  if (rows.length > 0) {
    const [latestRun] = await db
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(eq(testRuns.projectId, projectId))
      .orderBy(desc(testRuns.id))
      .limit(1);
    for (const row of rows) {
      if (row.suggestionKey === 'quarantine') {
        if (row.runId != null && row.runId === latestRun?.id) dismissedCandidates.add(row.subjectId);
      } else if (row.suggestionKey.startsWith('release:')) {
        dismissedReleases.add(Number(row.suggestionKey.slice('release:'.length)));
      }
    }
  }
  return {
    entries: entries.map((entry) => ({ ...entry, releaseDismissed: dismissedReleases.has(entry.id) })),
    candidates: candidates.map((candidate) => ({
      ...candidate,
      dismissed: dismissedCandidates.has(candidate.testCaseId),
    })),
  };
}
