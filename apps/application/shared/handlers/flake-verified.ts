/**
 * Verified fixes: a flaky test whose Flake Lab `verify` experiment held (the
 * reproducing arm ran clean for the runs that prove a fix) is marked
 * "verified fixed on <commit>". The mark holds until the test flakes again.
 *
 * - The mark comes from the test's latest decisive experiment: a `verified`
 *   verify marks it; a later `still-fails` verify, or a later reproduce that
 *   `reproduced` it again, clears it. An `inconclusive` verify decides nothing.
 * - "Flakes again" is a retry-pass (a failed and a passed attempt of the test
 *   in one run, on one browser) in a run that started after the verify
 *   experiment finished, among the runs the `flakiness` use reads: lab,
 *   bisect, reproduction and incident runs never count, and every branch and
 *   environment does: the mark is about the test, not about one view of it.
 *
 * Every comparison happens in JavaScript on the dates the ORM returns, so the
 * rule reads the same on SQLite and PostgreSQL.
 */
import { and, asc, eq, gt, inArray, isNotNull, or } from 'drizzle-orm';
import { flakeExperiments, testRuns, testRunsCases } from '../../server/database/schema';
import { isFailedStatus } from '../utils/test-counts';
import { eligibleRunSql } from '../run-eligibility';
import type { DrizzleDB } from './db';

/** A test's verified fix, and whether it still holds. */
export interface VerifiedFix {
  testCaseId: number;
  /** The `verify` experiment that held. */
  experimentId: number;
  /** The commit the fix was verified on, when the command line knew it. */
  commit: string | null;
  /** When the verify experiment finished, ISO. */
  verifiedAt: string;
  /** Start of the first run after `verifiedAt` in which the test retry-passed, ISO; null while the fix holds. */
  flakedAgainAt: string | null;
}

/** An experiment as far as the mark is concerned. */
export interface DecisiveExperiment {
  id: number;
  testCaseId: number;
  kind: string;
  verdict: string | null;
  commit: string | null;
  finishedAt: Date;
}

/** An execution as far as a retry-pass is concerned. */
export interface ExecutionAfter {
  testCaseId: number;
  runId: number;
  runStartedAt: Date;
  browserKey: string;
  status: string;
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(typeof value === 'string' ? value : Number(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The verify experiment that marks each test, from its finished experiments.
 * Pure: the newest `verified` verify, unless a later `still-fails` verify or a
 * later `reproduced` reproduce undoes it.
 */
export function markingExperiments(experiments: DecisiveExperiment[]): Map<number, DecisiveExperiment> {
  const byTest = new Map<number, DecisiveExperiment[]>();
  for (const e of experiments) {
    const list = byTest.get(e.testCaseId);
    if (list) list.push(e);
    else byTest.set(e.testCaseId, [e]);
  }
  const marks = new Map<number, DecisiveExperiment>();
  for (const [testCaseId, list] of byTest) {
    const decisive = list
      .filter(
        (e) =>
          (e.kind === 'verify' && (e.verdict === 'verified' || e.verdict === 'still-fails')) ||
          (e.kind === 'reproduce' && e.verdict === 'reproduced'),
      )
      .sort((a, b) => a.finishedAt.getTime() - b.finishedAt.getTime() || a.id - b.id);
    const last = decisive.at(-1);
    if (last && last.kind === 'verify' && last.verdict === 'verified') marks.set(testCaseId, last);
  }
  return marks;
}

/**
 * The start of the first run after `after` in which the test retry-passed: a
 * failed and a passed attempt in the same run and browser. Pure.
 */
export function firstRetryPassAfter(executions: ExecutionAfter[], after: Date): Date | null {
  const groups = new Map<string, { startedAt: Date; failed: boolean; passed: boolean }>();
  for (const e of executions) {
    if (e.runStartedAt.getTime() <= after.getTime()) continue;
    const key = `${e.runId}\u0000${e.browserKey}`;
    const group = groups.get(key) ?? { startedAt: e.runStartedAt, failed: false, passed: false };
    if (isFailedStatus(e.status)) group.failed = true;
    if (e.status === 'passed') group.passed = true;
    groups.set(key, group);
  }
  let first: Date | null = null;
  for (const g of groups.values()) {
    if (g.failed && g.passed && (!first || g.startedAt < first)) first = g.startedAt;
  }
  return first;
}

/**
 * The verified fix of each listed test that has one, holding or not. Two
 * reads: the tests' finished experiments, then the executions of runs that
 * started after the earliest verification among them.
 */
export async function getVerifiedFixes(db: DrizzleDB, testCaseIds: number[]): Promise<Map<number, VerifiedFix>> {
  const result = new Map<number, VerifiedFix>();
  const ids = [...new Set(testCaseIds)];
  if (ids.length === 0) return result;

  const rows = await db
    .select({
      id: flakeExperiments.id,
      testCaseId: flakeExperiments.testCaseId,
      kind: flakeExperiments.kind,
      verdict: flakeExperiments.verdict,
      commit: flakeExperiments.commit,
      finishedAt: flakeExperiments.finishedAt,
    })
    .from(flakeExperiments)
    .where(
      and(
        inArray(flakeExperiments.testCaseId, ids),
        isNotNull(flakeExperiments.finishedAt),
        or(eq(flakeExperiments.kind, 'verify'), eq(flakeExperiments.verdict, 'reproduced')),
      ),
    );
  const experiments: DecisiveExperiment[] = [];
  for (const r of rows) {
    const finishedAt = toDate(r.finishedAt);
    if (finishedAt) experiments.push({ ...r, commit: r.commit ?? null, verdict: r.verdict ?? null, finishedAt });
  }
  const marks = markingExperiments(experiments);
  if (marks.size === 0) return result;

  const earliest = new Date(Math.min(...[...marks.values()].map((m) => m.finishedAt.getTime())));
  const executionRows = await db
    .select({
      testCaseId: testRunsCases.testCaseId,
      runId: testRunsCases.testRunId,
      status: testRunsCases.status,
      browser: testRunsCases.browser,
      runStartedAt: testRuns.startTime,
    })
    .from(testRunsCases)
    .innerJoin(testRuns, eq(testRunsCases.testRunId, testRuns.id))
    .where(
      and(
        inArray(testRunsCases.testCaseId, [...marks.keys()]),
        gt(testRuns.startTime, earliest),
        eligibleRunSql('flakiness'),
      ),
    )
    .orderBy(asc(testRuns.startTime));
  const executionsByTest = new Map<number, ExecutionAfter[]>();
  for (const r of executionRows) {
    const runStartedAt = toDate(r.runStartedAt);
    if (!runStartedAt) continue;
    const browser = r.browser as { projectName?: string; browserName?: string } | null;
    const execution: ExecutionAfter = {
      testCaseId: r.testCaseId,
      runId: r.runId,
      runStartedAt,
      browserKey: browser?.projectName ?? browser?.browserName ?? '',
      status: r.status,
    };
    const list = executionsByTest.get(r.testCaseId);
    if (list) list.push(execution);
    else executionsByTest.set(r.testCaseId, [execution]);
  }

  for (const [testCaseId, mark] of marks) {
    const again = firstRetryPassAfter(executionsByTest.get(testCaseId) ?? [], mark.finishedAt);
    result.set(testCaseId, {
      testCaseId,
      experimentId: mark.id,
      commit: mark.commit,
      verifiedAt: mark.finishedAt.toISOString(),
      flakedAgainAt: again ? again.toISOString() : null,
    });
  }
  return result;
}

/** The verified fixes that still hold, for the listed tests. */
export async function getHoldingVerifiedFixes(db: DrizzleDB, testCaseIds: number[]): Promise<Map<number, VerifiedFix>> {
  const all = await getVerifiedFixes(db, testCaseIds);
  return new Map([...all].filter(([, fix]) => fix.flakedAgainAt == null));
}
