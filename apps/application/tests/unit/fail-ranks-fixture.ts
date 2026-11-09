import { MAX_FAILED_IN_LAST_RUNS } from '#shared/selection/validate';

/**
 * A project whose tests each hold a different history, for the recency rank of
 * a test's newest failure (`firstFailRank` of `loadSelectionCatalog`): runs of
 * every origin, retries whose earlier attempts failed, results sharing a
 * timestamp, histories shorter and longer than `MAX_FAILED_IN_LAST_RUNS`, and a
 * second project whose executions must not count. Written with the Drizzle
 * insert API, so one fixture seeds SQLite and PostgreSQL alike.
 */

const STATUSES = ['passed', 'passed', 'passed', 'failed', 'timedOut', 'timedout', 'skipped', 'interrupted'];
const ORIGINS = ['local', 'local', 'local', 'ci', 'probe', 'flake-lab', 'bisect', 'reproduce'];
const ELIGIBLE_ORIGINS = new Set(['local', 'ci']);
const FAILING = new Set(['failed', 'timedOut', 'timedout']);

/** A small deterministic generator, so a failure names the same dataset every run. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

interface Execution {
  id: number;
  testCaseId: number;
  status: string;
  createdAt: number;
  eligible: boolean;
  final: boolean;
}

export interface FailRanksFixture {
  projectId: number;
  /** The rank each test of the project must read, from the rule applied in memory; tests without one are absent. */
  expected: Map<number, number>;
  testCaseIds: number[];
}

/** The rule in memory: the latest results (eligible run, final attempt), newest first, ties by id, and the first failing one. */
function expectedRanks(executions: Execution[]): Map<number, number> {
  const byTest = new Map<number, Execution[]>();
  for (const e of executions) {
    if (!e.eligible || !e.final) continue;
    const list = byTest.get(e.testCaseId) ?? [];
    list.push(e);
    byTest.set(e.testCaseId, list);
  }
  const ranks = new Map<number, number>();
  for (const [testCaseId, list] of byTest) {
    list.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    const index = list.slice(0, MAX_FAILED_IN_LAST_RUNS).findIndex((e) => FAILING.has(e.status));
    if (index >= 0) ranks.set(testCaseId, index + 1);
  }
  return ranks;
}

export async function seedFailRanksFixture(db: any, schema: any): Promise<FailRanksFixture> {
  const next = random(1074);
  const [project, other] = await db
    .insert(schema.projects)
    .values([{ name: 'fail-ranks' }, { name: 'fail-ranks-other' }])
    .returning();

  const runOrigins: string[] = Array.from({ length: 60 }, (_, i) =>
    i < 2 ? 'local' : ORIGINS[Math.floor(next() * 8)]!,
  );
  const runs = await db
    .insert(schema.testRuns)
    .values(
      runOrigins.map((origin, i) => ({
        projectId: project.id,
        status: 'failed',
        origin,
        startTime: new Date(1_700_000_000_000 + i * 60_000),
      })),
    )
    .returning();
  const [otherRun] = await db
    .insert(schema.testRuns)
    .values({ projectId: other.id, status: 'failed', startTime: new Date(1_700_000_000_000) })
    .returning();

  const shapes: Array<{ title: string; length: number; failAt?: number[] }> = [
    { title: 'never ran', length: 0 },
    { title: 'always passes', length: 40 },
    { title: 'failed in the latest result', length: 30, failAt: [1] },
    { title: 'failed 25 results back', length: 40, failAt: [25] },
    { title: 'failed 26 results back', length: 40, failAt: [26, 30] },
    { title: 'short history', length: 5, failAt: [4] },
  ];
  for (let i = 0; i < 24; i++) shapes.push({ title: `random ${i}`, length: Math.floor(next() * 60) });

  const cases = await db
    .insert(schema.testCases)
    .values(shapes.map((s) => ({ projectId: project.id, filePath: 'tests/ranks.spec.ts', title: s.title })))
    .returning();
  const [otherCase] = await db
    .insert(schema.testCases)
    .values({ projectId: other.id, filePath: 'tests/ranks.spec.ts', title: 'other project' })
    .returning();

  const rows: any[] = [];
  const meta: Array<Omit<Execution, 'id'>> = [];
  shapes.forEach((shape, index) => {
    const testCaseId = cases[index].id;
    for (let k = 0; k < shape.length; k++) {
      // `k` 0 is the newest result. The shaped tests run only on eligible runs, one result each.
      const shaped = !shape.title.startsWith('random');
      const run = shaped ? runs[k % 2] : runs[Math.floor(next() * runs.length)];
      const eligible = ELIGIBLE_ORIGINS.has(runOrigins[runs.indexOf(run)]!);
      const status = shaped
        ? shape.failAt?.includes(k + 1)
          ? 'failed'
          : 'passed'
        : STATUSES[Math.floor(next() * STATUSES.length)]!;
      // Every fourth random result shares its timestamp with the one before it: the id decides.
      const createdAt = 1_800_000_000_000 - k * 1000 + (!shaped && k % 4 === 1 ? 1000 : 0);
      const retried = !shaped && next() < 0.2;
      const repeatEachIndex = k;
      if (retried) {
        rows.push({
          testRunId: run.id,
          testCaseId,
          status: 'failed',
          retries: 0,
          repeatEachIndex,
          finalAttempt: false,
          passedAfterFailure: false,
          createdAt: new Date(createdAt + 500),
        });
        meta.push({ testCaseId, status: 'failed', createdAt: createdAt + 500, eligible, final: false });
      }
      rows.push({
        testRunId: run.id,
        testCaseId,
        status,
        retries: retried ? 1 : 0,
        repeatEachIndex,
        finalAttempt: true,
        passedAfterFailure: retried && status === 'passed',
        createdAt: new Date(createdAt),
      });
      meta.push({ testCaseId, status, createdAt, eligible, final: true });
    }
  });
  rows.push({
    testRunId: otherRun.id,
    testCaseId: otherCase.id,
    status: 'failed',
    createdAt: new Date(1_900_000_000_000),
  });

  const executions: Execution[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const inserted = await db
      .insert(schema.testRunsCases)
      .values(rows.slice(i, i + 200))
      .returning({ id: schema.testRunsCases.id });
    inserted.forEach((row: { id: number }, j: number) => {
      const m = meta[i + j];
      if (m) executions.push({ ...m, id: row.id });
    });
  }

  return {
    projectId: project.id,
    expected: expectedRanks(executions),
    testCaseIds: cases.map((c: { id: number }) => c.id),
  };
}
