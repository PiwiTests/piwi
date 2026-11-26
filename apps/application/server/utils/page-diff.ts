/**
 * Page diff — compare a failing execution's ARIA snapshot against the same
 * test's most recent passing execution that carries one (a green sample). The
 * baseline follows the same rule as the environment and visual diffs (same
 * browser, preferring the same environment, then the same branch, then the most
 * recent), with one more preference after the environment: a run on the same
 * Playwright version, whose ARIA snapshots follow the same rules. Used by the
 * REST endpoint, the MCP evidence tool and the demo router (browser-safe:
 * drizzle queries plus the pure diff).
 */
import { and, eq, desc, isNotNull, or } from 'drizzle-orm';
import { testRuns, testRunsCases } from '../database/schema';
import { rankBaselineCandidates, baselineEnvironmentNote } from '#shared/baseline-order';
import { diffAriaSnapshots, type PageDiffHunk, type PageDiffSummary } from '#shared/page-diff';
import { ariaTextPreferJson } from '#shared/aria-json';
import { parsePlaywrightError } from '#shared/error-parse';
import { resolveCasePayloadContents } from './case-payloads';
import { resolveRunBranch } from './run-branch';
import type { DrizzleDB } from '#shared/handlers/db';
import { eligibleRunSql } from '#shared/run-eligibility';

/** Passing executions inspected when choosing the baseline. */
const BASELINE_CANDIDATES = 20;

export type PageDiffStatus = 'ok' | 'no-failure-snapshot' | 'no-green-sample' | 'not-applicable' | 'not-found';

export interface PageDiffResponse {
  status: PageDiffStatus;
  /** The passing execution the failing snapshot was compared against. */
  baseline?: {
    executionId: number;
    runId: number;
    /** Run start time (epoch ms), or null when the run has no start time. */
    at: number | null;
    /** Baseline run commit SHA, from its SCM metadata. */
    commit: string | null;
    /** Baseline run branch. */
    branch: string | null;
    /** Baseline run environment label. */
    environment: string | null;
  };
  /** Set when the baseline had to come from another environment. */
  baselineNote?: string | null;
  summary?: PageDiffSummary;
  hunks?: PageDiffHunk[];
}

interface RunScmLens {
  scm?: { commit?: string | null; branch?: string | null } | null;
}

function selectExecution(db: DrizzleDB, where: ReturnType<typeof and>) {
  return db
    .select({
      id: testRunsCases.id,
      testCaseId: testRunsCases.testCaseId,
      status: testRunsCases.status,
      browserName: testRunsCases.browserName,
      error: testRunsCases.error,
      ariaSnapshot: testRunsCases.ariaSnapshot,
      ariaSnapshotJson: testRunsCases.ariaSnapshotJson,
      ariaSnapshotPayloadId: testRunsCases.ariaSnapshotPayloadId,
      ariaSnapshotJsonPayloadId: testRunsCases.ariaSnapshotJsonPayloadId,
      runId: testRuns.id,
      runEnvironment: testRuns.environment,
      runBranch: testRuns.branch,
      runPlaywrightVersion: testRuns.playwrightVersion,
      runMetadata: testRuns.metadata,
      startTime: testRuns.startTime,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(where)
    .orderBy(desc(testRuns.startTime), desc(testRunsCases.id));
}

type ExecutionRow = Awaited<ReturnType<typeof selectExecution>>[number];

function scopeOf(row: ExecutionRow) {
  return {
    environment: row.runEnvironment ?? null,
    branch: row.runBranch ?? resolveRunBranch(row.runMetadata),
    playwrightVersion: row.runPlaywrightVersion ?? null,
  };
}

function commitOf(row: ExecutionRow): string | null {
  return ((row.runMetadata as RunScmLens | null)?.scm?.commit ?? null) || null;
}

/** Role + name the failing locator names, parsed from the stored error text. */
function failingLocatorTarget(error: string | null): { role?: string | null; name?: string | null } | undefined {
  const parsed = parsePlaywrightError(error);
  const locator = parsed.leafLocator ?? parsed.locator;
  if (!locator) return undefined;
  const role = /getByRole\(\s*['"`]([^'"`]+)['"`]/.exec(locator)?.[1] ?? null;
  const name =
    /\bname:\s*['"`]([^'"`]+)['"`]/.exec(locator)?.[1] ??
    /getBy(?:Text|Label|Placeholder|AltText|Title)\(\s*['"`]([^'"`]+)['"`]/.exec(locator)?.[1] ??
    null;
  if (!role && !name) return undefined;
  return { role, name };
}

/**
 * Compute the structural page diff for one execution. Returns a typed reason
 * rather than throwing when a diff cannot be produced: `not-applicable` when the
 * execution did not fail, `no-failure-snapshot` when the failing page was never
 * captured, `no-green-sample` when no passing execution carries a baseline
 * snapshot yet.
 */
export async function getPageDiff(db: DrizzleDB, testRunsCaseId: number): Promise<PageDiffResponse> {
  const [failing] = await selectExecution(db, and(eq(testRunsCases.id, testRunsCaseId))).limit(1);
  if (!failing || failing.testCaseId == null) return { status: 'not-found' };

  // A page diff explains a failing page; a passing or skipped execution has no
  // failure to line up against a baseline.
  if (failing.status !== 'failed' && failing.status !== 'timedout') return { status: 'not-applicable' };
  if (!failing.ariaSnapshot && failing.ariaSnapshotPayloadId == null) return { status: 'no-failure-snapshot' };

  const baselineConds = [
    eq(testRunsCases.testCaseId, failing.testCaseId),
    eq(testRunsCases.status, 'passed'),
    or(isNotNull(testRunsCases.ariaSnapshotPayloadId), isNotNull(testRunsCases.ariaSnapshot)),
    eligibleRunSql('baseline'),
  ];
  if (failing.browserName) baselineConds.push(eq(testRunsCases.browserName, failing.browserName));

  const candidates = await selectExecution(db, and(...baselineConds)).limit(BASELINE_CANDIDATES);
  const failingScope = scopeOf(failing);
  const baseline = rankBaselineCandidates(
    failingScope,
    candidates.map((row) => ({ ...scopeOf(row), row })),
  )[0]?.row;
  if (!baseline) return { status: 'no-green-sample' };

  const contents = await resolveCasePayloadContents(db, [
    failing.ariaSnapshotPayloadId,
    failing.ariaSnapshotJsonPayloadId,
    baseline.ariaSnapshotPayloadId,
    baseline.ariaSnapshotJsonPayloadId,
  ]);
  const resolve = (id: number | null, inline: string | null) => (id != null ? contents.get(id) : undefined) ?? inline;
  const failingAria = ariaTextPreferJson(
    resolve(failing.ariaSnapshotJsonPayloadId, failing.ariaSnapshotJson),
    resolve(failing.ariaSnapshotPayloadId, failing.ariaSnapshot),
  );
  const baselineAria = ariaTextPreferJson(
    resolve(baseline.ariaSnapshotJsonPayloadId, baseline.ariaSnapshotJson),
    resolve(baseline.ariaSnapshotPayloadId, baseline.ariaSnapshot),
  );

  if (!failingAria) return { status: 'no-failure-snapshot' };
  if (!baselineAria) return { status: 'no-green-sample' };

  const { summary, hunks } = diffAriaSnapshots(baselineAria, failingAria, failingLocatorTarget(failing.error));

  return {
    status: 'ok',
    baseline: {
      executionId: baseline.id,
      runId: baseline.runId,
      at: baseline.startTime instanceof Date ? baseline.startTime.getTime() : (baseline.startTime ?? null),
      commit: commitOf(baseline),
      branch: baseline.runBranch ?? resolveRunBranch(baseline.runMetadata),
      environment: baseline.runEnvironment ?? null,
    },
    baselineNote: baselineEnvironmentNote(failingScope, scopeOf(baseline)),
    summary,
    hunks,
  };
}
