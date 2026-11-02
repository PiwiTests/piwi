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
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { quarantinedTests, testCases, testRuns, testRunsCases } from '../../server/database/schema';
import type { DrizzleDB } from './db';
import { eligibleExecutionInProject } from '../run-eligibility';
import { getHoldingVerifiedFixes, type VerifiedFix } from './flake-verified';
import { finalAttempts, flakyFinalAttempts, isFailedStatus } from '../utils/test-counts';
import { listOutcomes, recordOutcome } from '../../server/utils/outcomes';
import { proposeQuarantineCandidates } from '../../server/utils/quarantine-candidates';
import type { HandbackActor } from '../handback-outcomes';
import { normalizeDismissReason, type QuarantineProposal } from '#shared/quarantine-proposals';

/** Consecutive passing runs after which release is proposed. */
export const RELEASE_AFTER_CONSECUTIVE_PASSES = 5;

/** Runs scanned per test when counting the current streak. */
const STREAK_SCAN_LIMIT = 30;

export interface QuarantineEntry {
  id: number;
  testCaseId: number;
  title: string;
  /** The ID the test has in the team's test management tool. */
  externalId: string | null;
  /** The title without its external ID, when the reporter removed it. */
  displayTitle: string | null;
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
  /** Runs since quarantine that recorded the test, the newest 30 at most; zero means nothing has exercised it yet. */
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

/** An attempt row of a quarantined test, as the streak reads it. */
interface StreakRow {
  testCaseId: number;
  status: string;
  retries: number | null;
  repeatEachIndex: number;
  browserName: string | null;
}

/**
 * The outcome of a test in one run, from the final attempt of each of its
 * projects and repetitions there: failed when one failed, flaky when one passed
 * after a failed attempt, passed when every one that ran passed, and null when
 * none ran (skipped, did not run).
 */
function runOutcome(rows: StreakRow[]): 'passed' | 'flaky' | 'failed' | null {
  const final = finalAttempts(rows);
  if (final.some((row) => isFailedStatus(row.status))) return 'failed';
  if (flakyFinalAttempts(rows).size > 0) return 'flaky';
  return final.some((row) => row.status === 'passed') ? 'passed' : null;
}

/**
 * Trailing passing streak for each test, counted over the runs that started
 * after it was quarantined, newest first and once per run whatever its
 * projects and repetitions: a run counts as a pass when the test passed in it,
 * and a run where it failed, or passed only on a retry, resets the count, so a
 * single recent flake resets it — which is the point. A run that only skipped
 * the test proves nothing either way. Only runs the `flakiness` use reads
 * count: lab runs (probes, flake experiments) replay the test under injected
 * faults or conditions, bisect and reproduction runs replay an older commit,
 * and an environment incident fails every test at once, so none of them counts
 * toward or breaks a streak.
 *
 * One query for the whole list, whatever its length: the executions are joined
 * to the project's active quarantines (one test's alone when `testCaseId` is
 * given), each test's runs are ranked newest-first with a window function, and
 * the executions of the first `STREAK_SCAN_LIMIT` of each are read back. The
 * project's runs the use leaves out are listed once for it
 * (`eligibleExecutionInProject`).
 */
async function computeStreaks(
  db: DrizzleDB,
  projectId: number,
  testCaseId?: number,
): Promise<Map<number, { passes: number; runs: number }>> {
  const ranked = db
    .select({
      testCaseId: testRunsCases.testCaseId,
      status: testRunsCases.status,
      retries: testRunsCases.retries,
      repeatEachIndex: testRunsCases.repeatEachIndex,
      browserName: testRunsCases.browserName,
      runRank:
        sql<number>`dense_rank() over (partition by ${testRunsCases.testCaseId} order by ${testRuns.startTime} desc, ${testRuns.id} desc)`.as(
          'run_rank',
        ),
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRuns.id, testRunsCases.testRunId))
    .innerJoin(quarantinedTests, eq(quarantinedTests.testCaseId, testRunsCases.testCaseId))
    .where(
      and(
        eq(quarantinedTests.projectId, projectId),
        isNull(quarantinedTests.releasedAt),
        testCaseId != null ? eq(quarantinedTests.testCaseId, testCaseId) : undefined,
        gt(testRuns.startTime, quarantinedTests.createdAt),
        eligibleExecutionInProject('flakiness', projectId, testRunsCases.testRunId),
      ),
    )
    .as('ranked');

  const rows = await db
    .select({
      testCaseId: ranked.testCaseId,
      status: ranked.status,
      retries: ranked.retries,
      repeatEachIndex: ranked.repeatEachIndex,
      browserName: ranked.browserName,
      runRank: ranked.runRank,
    })
    .from(ranked)
    .where(lte(ranked.runRank, STREAK_SCAN_LIMIT));

  // Each test's runs, newest first, with their rows: the ranks of a test's runs are 1, 2, 3…
  const byCase = new Map<number, StreakRow[][]>();
  for (const row of rows) {
    const runs = byCase.get(row.testCaseId) ?? [];
    byCase.set(row.testCaseId, runs);
    (runs[Number(row.runRank) - 1] ??= []).push(row);
  }

  const streaks = new Map<number, { passes: number; runs: number }>();
  for (const [caseId, runs] of byCase) {
    const outcomes = runs.map(runOutcome);
    let passes = 0;
    for (const outcome of outcomes) {
      if (outcome === null) continue;
      if (outcome !== 'passed') break;
      passes++;
    }
    streaks.set(caseId, { passes, runs: outcomes.length });
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

/** Each listed entry's release progress; `testCaseId` narrows the streak query to that one test. */
async function releaseProposals(
  db: DrizzleDB,
  projectId: number,
  entries: Array<{ testCaseId: number; createdAt: Date | string | number }>,
  testCaseId?: number,
): Promise<Map<number, ReleaseProgress>> {
  const streaks = await computeStreaks(db, projectId, testCaseId);
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
      createdAt: quarantinedTests.createdAt,
      title: testCases.title,
      externalId: testCases.externalId,
      displayTitle: testCases.displayTitle,
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
      externalId: row.externalId ?? null,
      displayTitle: row.displayTitle ?? null,
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

  // The project's newest run, kept with the entry. The streak reads only the runs that start after the quarantine, so
  // history already recorded cannot count toward release — the point of quarantining is that history is bad.
  const [latestRun] = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId))
    .orderBy(desc(testRuns.id))
    .limit(1);

  const source = options.source === 'proposed' ? 'proposed' : 'manual';
  // A request running at the same time (a bulk quarantine of two clusters that share a test) may insert first: the
  // index of active quarantines keeps its row, and this call creates none.
  const inserted = await db
    .insert(quarantinedTests)
    .values({
      projectId,
      testCaseId,
      reason: options.reason ?? null,
      source,
      quarantinedAtRunId: latestRun?.id ?? null,
      // With authentication disabled the request carries a synthetic user whose
      // id is 0, which no `users` row has — store null rather than tripping the
      // foreign key on an instance that has no accounts at all.
      createdBy: typeof options.createdBy === 'number' && options.createdBy > 0 ? options.createdBy : null,
    })
    .onConflictDoNothing()
    .returning({ id: quarantinedTests.id });
  if (inserted.length === 0) return { created: false };

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

  const proposal = (await releaseProposals(db, projectId, active, testCaseId)).get(testCaseId);
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
    const progress = (await releaseProposals(db, projectId, [active], testCaseId)).get(testCaseId);
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
