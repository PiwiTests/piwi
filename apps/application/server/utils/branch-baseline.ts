import { and, desc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { testRuns } from '../database/schema';
import type { TestRun } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import type { RunBaselineMatch } from '#shared/run-baseline';
import { notLabRun } from '#shared/handlers/probes';

export interface BaselineQuery {
  projectId: number;
  /** The run whose baseline we want — only strictly-earlier runs qualify. */
  before: Date;
  /** The current run's branch, or null when it is unknown. */
  branch: string | null;
  /** The current run's deployment environment label, or null when it has none. */
  environment: string | null;
  /**
   * The branch the run's branch forked from — the pull request's target when
   * the reporter captured one, else the project's default branch. The rung the
   * automatic ladder falls back to when the run's own branch has no history.
   */
  fallbackBranch: string;
  /**
   * A base branch chosen explicitly. When set, the baseline must come from
   * this branch (same environment first) and nothing else is tried.
   */
  baseBranch?: string | null;
  /** Restrict the baseline to full-suite runs (partial/--grep runs skew a diff). */
  fullRunOnly?: boolean;
  /**
   * When no rung finds a passing run, walk the same rungs again for the last
   * failed run. Timed-out and interrupted runs stopped before the suite ended,
   * so they never qualify.
   */
  failedFallback?: boolean;
}

export interface BaselineSelection {
  run: TestRun;
  match: RunBaselineMatch;
}

interface Rung {
  conditions: SQL[];
  match: Omit<RunBaselineMatch, 'outcome'>;
}

/** The runs any baseline is taken from: earlier runs of the project, never a lab run. */
function eligibleRuns(q: Pick<BaselineQuery, 'projectId' | 'before' | 'fullRunOnly'>): SQL[] {
  const conditions: SQL[] = [
    eq(testRuns.projectId, q.projectId),
    lt(testRuns.startTime, q.before),
    notLabRun(testRuns.origin),
  ];
  if (q.fullRunOnly) conditions.push(eq(testRuns.isFullRun, 1));
  return conditions;
}

/** The run outcomes a baseline may have: passed, then failed when the caller accepts it. */
function baselineOutcomes(q: Pick<BaselineQuery, 'failedFallback'>): Array<RunBaselineMatch['outcome']> {
  return q.failedFallback ? ['passed', 'failed'] : ['passed'];
}

async function mostRecent(db: DrizzleDB, conditions: SQL[]): Promise<TestRun | null> {
  const [row] = await db
    .select()
    .from(testRuns)
    .where(and(...conditions))
    .orderBy(desc(testRuns.startTime))
    .limit(1);
  return (row as TestRun | undefined) ?? null;
}

/**
 * The rungs tried in order, most specific first. The branch ladder is the run's
 * own branch, then the fallback branch, then any branch; a run with no branch
 * only has the last rung. When the run carries an environment label the whole
 * ladder is first walked within that environment, then again without it — so a
 * same-environment run on the fallback branch beats a same-branch run from
 * another environment, the order the per-execution diffs use too.
 */
function automaticRungs(q: BaselineQuery): Rung[] {
  const branchRungs: Array<{ condition: SQL | null; branch: RunBaselineMatch['branch'] }> = [];
  if (q.branch) {
    branchRungs.push({ condition: eq(testRuns.branch, q.branch), branch: 'same' });
    if (q.fallbackBranch && q.fallbackBranch !== q.branch) {
      branchRungs.push({ condition: eq(testRuns.branch, q.fallbackBranch), branch: 'fallback' });
    }
    branchRungs.push({ condition: null, branch: 'any' });
  } else {
    branchRungs.push({ condition: null, branch: null });
  }

  const rungs: Rung[] = [];
  if (q.environment) {
    for (const r of branchRungs) {
      rungs.push({
        conditions: [eq(testRuns.environment, q.environment), ...(r.condition ? [r.condition] : [])],
        match: { branch: r.branch, environment: 'same' },
      });
    }
  }
  for (const r of branchRungs) {
    rungs.push({
      conditions: r.condition ? [r.condition] : [],
      match: { branch: r.branch, environment: q.environment ? 'other' : null },
    });
  }
  return rungs;
}

/** The chosen base branch only: within the run's environment first, then any. */
function chosenRungs(q: BaselineQuery, baseBranch: string): Rung[] {
  const onBranch = eq(testRuns.branch, baseBranch);
  const rungs: Rung[] = [];
  if (q.environment) {
    rungs.push({
      conditions: [eq(testRuns.environment, q.environment), onBranch],
      match: { branch: 'chosen', environment: 'same' },
    });
  }
  rungs.push({ conditions: [onBranch], match: { branch: 'chosen', environment: q.environment ? 'other' : null } });
  return rungs;
}

/**
 * The most relevant passing run to compare against, with how it was matched:
 *
 *   1. The most recent passing run **on the same branch** — the branch's own
 *      history, so "new failure" means new relative to this branch.
 *   2. Failing that (a fresh branch, the common case for a new pull request),
 *      the most recent passing run **on the fallback branch** — the branch it
 *      forked from.
 *   3. Failing that, the most recent passing run on **any** branch, so a
 *      baseline exists whenever one exists at all.
 *
 * Each rung is tried **within the run's environment** first, then without it.
 * A run whose branch is unknown only has rung 3. An explicit `baseBranch`
 * replaces the ladder with that branch alone (same environment first). With
 * `failedFallback`, a ladder that finds no passing run is walked again for the
 * last failed run.
 *
 * A lab run (probe or flake experiment) is never a baseline: it replays a few
 * tests under injected faults or conditions.
 */
export async function selectBaselineRun(db: DrizzleDB, q: BaselineQuery): Promise<BaselineSelection | null> {
  const base = eligibleRuns(q);
  const chosen = q.baseBranch?.trim() || null;
  const rungs = chosen ? chosenRungs(q, chosen) : automaticRungs(q);
  for (const outcome of baselineOutcomes(q)) {
    for (const rung of rungs) {
      const run = await mostRecent(db, [...base, eq(testRuns.status, outcome), ...rung.conditions]);
      if (run) return { run, match: { ...rung.match, outcome } };
    }
  }
  return null;
}

/**
 * The branches a baseline can be taken from, sorted: every branch with an
 * eligible earlier run whose outcome the query accepts — the base branches
 * the Changes tab offers.
 */
export async function listBaselineBranches(
  db: DrizzleDB,
  q: Pick<BaselineQuery, 'projectId' | 'before' | 'fullRunOnly' | 'failedFallback'>,
): Promise<string[]> {
  const rows: Array<{ branch: string | null }> = await db
    .selectDistinct({ branch: testRuns.branch })
    .from(testRuns)
    .where(and(...eligibleRuns(q), inArray(testRuns.status, baselineOutcomes(q)), isNotNull(testRuns.branch)));
  return rows
    .map((r) => r.branch)
    .filter((b): b is string => !!b)
    .sort();
}
