import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set.
delete process.env.PIWI_DATABASE_URL;

// The feature-graph write runs after persistRunCases returns; its last step
// settles the promise a test waits on, so every query of the batch is counted.
const graph = vi.hoisted(() => ({ settled: null as null | (() => void) }));
vi.mock('../../server/utils/graph-ingest', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/utils/graph-ingest')>();
  return {
    ...mod,
    ingestPageInventoryGraph: async (...args: Parameters<typeof mod.ingestPageInventoryGraph>) => {
      try {
        return await mod.ingestPageInventoryGraph(...args);
      } finally {
        graph.settled?.();
      }
    },
  };
});

const { persistRunCases } = await import('../../server/utils/persist-run-cases');
const { testCaseCache } = await import('../../server/utils/test-case-cache');
const { testSuiteCache } = await import('../../server/utils/test-suite-cache');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let queries: string[];
let projectId: number;

beforeEach(async () => {
  queries = [];
  db = drizzle(createClient({ url: ':memory:' }), { schema, logger: { logQuery: (query) => queries.push(query) } });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  const [project] = await db.insert(schema.projects).values({ name: 'lookups' }).returning();
  projectId = project!.id;
  testCaseCache.invalidate(projectId);
  testSuiteCache.invalidate(projectId);
});

const STEPS = [
  {
    title: "Click getByRole('button', { name: 'Pay' })",
    category: 'pw:api',
    location: { file: '/ci/tests/pay.spec.ts', line: 8, column: 3 },
  },
];

function execution(title: string) {
  return {
    title,
    filePath: 'tests/pay.spec.ts',
    status: 'passed',
    line: 4,
    column: 1,
    steps: STEPS,
    locatorPages: [
      {
        location: 'tests/pay.spec.ts:8:3',
        locator: "getByRole('button', { name: 'Pay' })",
        origin: 'https://app.test',
        page: '/cart',
      },
    ],
    codeReach: ['src/pay.ts'],
    networkRequests: [{ method: 'GET', url: 'https://app.test/cart', status: 200, resourceType: 'document' }],
  };
}

/**
 * Persist one batch of a new run and return the statements it ran, the graph
 * write included (a lab run writes no graph, so there is nothing to wait for).
 */
async function persistBatch(run: { branch: string | null; metadata?: Record<string, unknown>; origin?: string }) {
  const [row] = await db
    .insert(schema.testRuns)
    .values({
      projectId,
      status: 'running',
      startTime: new Date(),
      branch: run.branch,
      metadata: run.metadata ?? (run.branch ? { scm: { branch: run.branch } } : {}),
      origin: run.origin ?? 'local',
    })
    .returning();
  queries = [];
  const graphWritten = new Promise<void>((resolve) => (graph.settled = resolve));
  await persistRunCases(db as never, projectId, row!.id, [execution('pays'), execution('pays twice')]);
  if (run.origin !== 'probe') await graphWritten;
  return { runId: row!.id, statements: queries };
}

const count = (statements: string[], pattern: RegExp) => statements.filter((q) => pattern.test(q)).length;
const RUN_READ = /^select .* from "test_runs" where "test_runs"."id" (= \?|in \()/;
const PROJECT_READ = /^select .* from "projects" where "projects"."id" = \?/;
const MOST_COMMON_BRANCH = /^select "project_id", "branch" from "test_runs" .*group by/;

async function seedRunsOn(branch: string, runs: number) {
  for (let i = 0; i < runs; i++) {
    await db.insert(schema.testRuns).values({ projectId, status: 'passed', startTime: new Date(), branch });
  }
}

describe('persistRunCases lookups', () => {
  test('reads the run and the project once, and the most common branch once, for every helper of a batch', async () => {
    await seedRunsOn('main', 3);
    const { runId, statements } = await persistBatch({ branch: 'feature/pay' });

    expect(count(statements, RUN_READ)).toBe(1);
    expect(count(statements, PROJECT_READ)).toBe(1);
    expect(count(statements, MOST_COMMON_BRANCH)).toBe(1);

    // Each helper still ran, on the branch tag the shared default branch gives.
    const usages = await db.select().from(schema.locatorUsages);
    expect(usages.length).toBeGreaterThan(0);
    expect(new Set(usages.map((u) => u.branch))).toEqual(new Set(['feature/pay']));
    const reach = await db.select().from(schema.codeReach);
    expect(reach.map((r) => [r.branch, r.lastSeenRunId])).toContainEqual(['feature/pay', runId]);
    const edges = await db.select().from(schema.graphEdges);
    expect(edges.length).toBeGreaterThan(0);
    expect(new Set(edges.map((e) => e.branch))).toEqual(new Set(['feature/pay']));
  });

  test('tags a run on the most common branch as the default branch', async () => {
    await seedRunsOn('main', 3);
    await persistBatch({ branch: 'main' });

    const usages = await db.select().from(schema.locatorUsages);
    expect(new Set(usages.map((u) => u.branch))).toEqual(new Set(['']));
    const edges = await db.select().from(schema.graphEdges);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.branch === null)).toBe(true);
  });

  test('looks no branch up for a run without one, nor for a project that stores its default', async () => {
    expect(count((await persistBatch({ branch: null })).statements, MOST_COMMON_BRANCH)).toBe(0);

    await db.update(schema.projects).set({ defaultBranch: 'main' });
    const { statements } = await persistBatch({ branch: 'feature/pay' });
    expect(count(statements, MOST_COMMON_BRANCH)).toBe(0);
    expect(count(statements, PROJECT_READ)).toBe(1);
  });

  test('reads no project for a lab run', async () => {
    const { statements } = await persistBatch({
      branch: 'feature/pay',
      metadata: { scm: { branch: 'feature/pay' }, piwiProbe: true },
      origin: 'probe',
    });
    // The graph write of a lab run returns before it reads anything.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(count(statements, RUN_READ)).toBe(1);
    expect(count(statements, PROJECT_READ)).toBe(0);
    expect(count(statements, MOST_COMMON_BRANCH)).toBe(0);
  });
});
