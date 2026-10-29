import { beforeEach, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { loadRunPayload } = await import('../../server/utils/notifications/run-notifications');

let db: ReturnType<typeof drizzle<typeof schema>>;

const SOURCE = ["  10 | test('pays', async () => {", '> 11 |   await pay();', '  12 | });'].join('\n');

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db
    .insert(schema.projects)
    .values({ id: 1, name: 'shop', defaultBranch: 'main', repositoryUrl: 'https://github.com/acme/shop' });
  await db.insert(schema.testCases).values([
    {
      id: 1,
      projectId: 1,
      filePath: 'tests/pay.spec.ts',
      suitePath: 'Checkout\x1fPayment',
      title: 'pays',
      owner: '@team/pay',
    },
    { id: 2, projectId: 1, filePath: 'tests/cart.spec.ts', title: 'flaky one' },
    { id: 3, projectId: 1, filePath: 'tests/login.spec.ts', title: 'logs in' },
  ]);
  const run = (id: number, values: Partial<typeof schema.testRuns.$inferInsert>) => ({
    id,
    projectId: 1,
    status: 'passed',
    branch: 'main',
    environment: 'staging',
    startTime: new Date(id * 1000_000),
    totalTests: 3,
    ...values,
  });
  await db.insert(schema.testRuns).values([
    run(1, {}),
    run(2, { status: 'failed', environment: 'production' }),
    run(3, { branch: 'feature/x' }),
    run(4, { origin: 'probe' }),
    run(5, {
      status: 'failed',
      failedTests: 2,
      passedTests: 1,
      flakyTests: 1,
      metadata: {
        scm: { commit: 'abcdef1234567', commitMessage: 'Check the card\n\nWith a body', author: 'Alex' },
        ci: { buildUrl: 'https://ci.example.com/build/9' },
      },
    }),
  ]);
  await db.insert(schema.testRunsCases).values([
    { testRunId: 1, testCaseId: 1, status: 'passed', browserName: 'chromium' },
    { testRunId: 1, testCaseId: 3, status: 'failed', browserName: 'chromium' },
    { testRunId: 2, testCaseId: 1, status: 'failed', browserName: 'chromium' },
    // Test 1 failed on its first attempt and its retry: one failure, the retry's.
    {
      id: 50,
      testRunId: 5,
      testCaseId: 1,
      status: 'failed',
      retries: 0,
      browserName: 'chromium',
      error: 'Error: first',
    },
    {
      id: 51,
      testRunId: 5,
      testCaseId: 1,
      status: 'failed',
      retries: 1,
      browserName: 'chromium',
      line: 10,
      error: 'Error: expect(received).toBe(expected)\n\nExpected: 1\nReceived: 2',
      testSource: SOURCE,
    },
    // Test 2 passed on its retry: flaky, not a failure.
    {
      id: 52,
      testRunId: 5,
      testCaseId: 2,
      status: 'failed',
      retries: 0,
      browserName: 'chromium',
      error: 'Error: once',
    },
    { id: 53, testRunId: 5, testCaseId: 2, status: 'passed', retries: 1, browserName: 'chromium' },
    {
      id: 54,
      testRunId: 5,
      testCaseId: 3,
      status: 'failed',
      browserName: 'chromium',
      error: 'Error: boom',
      testSourceFrames: [{ file: 'tests/helpers/login.ts', line: 8, snippet: '   7 | a();\n>  8 | boom();' }],
    },
  ]);
});

describe('the payload of a run notification', () => {
  test('names each failing test once, by its deciding attempt, and leaves a flaky test out', async () => {
    const loaded = await loadRunPayload(db as never, 5);
    const failures = loaded!.runPayload.topFailures;
    expect(failures.map((f) => [f.title, f.executionId])).toEqual([
      ['pays', 51],
      ['logs in', 54],
    ]);
    expect(loaded!.runPayload.owners).toEqual(['@team/pay']);
  });

  test("carries each failure's describe blocks, location, owner and source", async () => {
    const [pays, login] = (await loadRunPayload(db as never, 5))!.runPayload.topFailures;
    expect(pays).toMatchObject({
      suitePath: ['Checkout', 'Payment'],
      filePath: 'tests/pay.spec.ts',
      line: 10,
      browserName: 'chromium',
      owner: '@team/pay',
      source: { file: 'tests/pay.spec.ts', line: 11, snippet: SOURCE },
    });
    expect(login!.source).toEqual({ file: 'tests/helpers/login.ts', line: 8, snippet: '   7 | a();\n>  8 | boom();' });
  });

  test('keeps the history to the runs of the same branch and environment that send notifications', async () => {
    const payload = (await loadRunPayload(db as never, 5))!.runPayload;
    expect(payload.history).toEqual([
      { runId: 1, status: 'passed', failedTests: 0 },
      { runId: 5, status: 'failed', failedTests: 2 },
    ]);
    expect(payload.topFailures.map((f) => f.history)).toEqual([
      ['passed', 'failed'],
      ['failed', 'failed'],
    ]);
  });

  test('names the commit, linked on the project repository, and the CI build', async () => {
    const payload = (await loadRunPayload(db as never, 5))!.runPayload;
    expect(payload.commit).toEqual({
      sha: 'abcdef1234567',
      message: 'Check the card',
      author: 'Alex',
      url: 'https://github.com/acme/shop/commit/abcdef1234567',
    });
    expect(payload.ciUrl).toBe('https://ci.example.com/build/9');
  });

  test('names what launched the run', async () => {
    expect((await loadRunPayload(db as never, 5))!.runPayload.origin).toBe('local');
    expect((await loadRunPayload(db as never, 4))!.runPayload.origin).toBe('probe');
  });

  test('a run with no failure carries none, and its counts', async () => {
    const payload = (await loadRunPayload(db as never, 3))!.runPayload;
    expect(payload.topFailures).toEqual([]);
    expect(payload.history).toEqual([{ runId: 3, status: 'passed', failedTests: 0 }]);
    expect(payload).toMatchObject({ skippedTests: 0, didNotRunTests: 0 });
    expect(payload.commit).toBeUndefined();
  });
});

describe('the payload of a run notification, in edge cases', () => {
  test('routes a flaky-only run to the owner of the flaky test', async () => {
    await db.insert(schema.testRuns).values({
      id: 20,
      projectId: 1,
      status: 'passed',
      branch: 'main',
      environment: 'staging',
      startTime: new Date(20_000_000),
      totalTests: 1,
      passedTests: 1,
      flakyTests: 1,
    });
    await db.insert(schema.testRunsCases).values([
      { testRunId: 20, testCaseId: 1, status: 'failed', retries: 0, browserName: 'chromium' },
      { testRunId: 20, testCaseId: 1, status: 'passed', retries: 1, browserName: 'chromium' },
    ]);
    const payload = (await loadRunPayload(db as never, 20))!.runPayload;
    expect(payload.topFailures).toEqual([]);
    expect(payload.owners).toEqual(['@team/pay']);
  });

  test('counts a test whose repetitions failed once among the failing tests', async () => {
    await db.insert(schema.testRuns).values({
      id: 21,
      projectId: 1,
      status: 'failed',
      branch: 'main',
      environment: 'staging',
      startTime: new Date(21_000_000),
      totalTests: 3,
      failedTests: 3,
    });
    await db.insert(schema.testRunsCases).values(
      [0, 1, 2].map((repeatEachIndex) => ({
        testRunId: 21,
        testCaseId: 1,
        status: 'failed',
        repeatEachIndex,
        browserName: 'chromium',
      })),
    );
    const payload = (await loadRunPayload(db as never, 21))!.runPayload;
    expect(payload.topFailures).toHaveLength(1);
    expect(payload.failingTestCount).toBe(1);
  });

  test('finds the runs of its branch behind many runs of other branches', async () => {
    const others = Array.from({ length: 30 }, (_, i) => ({
      id: 100 + i,
      projectId: 1,
      status: 'passed',
      branch: `feature/${i}`,
      environment: 'staging',
      startTime: new Date((100 + i) * 1000_000),
      totalTests: 1,
    }));
    await db.insert(schema.testRuns).values([
      ...others,
      {
        id: 200,
        projectId: 1,
        status: 'failed',
        branch: 'main',
        environment: 'staging',
        startTime: new Date(200_000_000),
        totalTests: 1,
        failedTests: 1,
      },
    ]);
    const payload = (await loadRunPayload(db as never, 200))!.runPayload;
    expect(payload.history!.map((h) => h.runId)).toEqual([1, 5, 200]);
  });

  test('draws an interrupted test as one that did not run, not as a missing result', async () => {
    await db.insert(schema.testRuns).values({
      id: 30,
      projectId: 1,
      status: 'failed',
      branch: 'main',
      environment: 'staging',
      startTime: new Date(30_000_000),
      totalTests: 1,
      failedTests: 1,
    });
    await db.insert(schema.testRunsCases).values([
      { testRunId: 5, testCaseId: 3, status: 'interrupted', browserName: 'webkit' },
      { testRunId: 30, testCaseId: 3, status: 'failed', browserName: 'webkit' },
    ]);
    const [failure] = (await loadRunPayload(db as never, 30))!.runPayload.topFailures;
    expect(failure!.history).toEqual([null, 'didnotrun', 'failed']);
  });

  test("falls back to the test's snippet when the captured frame marks no failing line", async () => {
    await db.insert(schema.testRuns).values({
      id: 31,
      projectId: 1,
      status: 'failed',
      branch: 'main',
      environment: 'staging',
      startTime: new Date(31_000_000),
      totalTests: 1,
      failedTests: 1,
      metadata: {
        ci: {
          pipelineUrl: 'https://gitlab.example.com/acme/shop/-/pipelines/7',
          jobUrl: 'https://gitlab.example.com/acme/shop/-/jobs/9',
        },
      },
    });
    await db.insert(schema.testRunsCases).values({
      testRunId: 31,
      testCaseId: 1,
      status: 'failed',
      browserName: 'chromium',
      testSource: SOURCE,
      testSourceFrames: [{ file: 'tests/helpers/pay.ts', line: 99, snippet: '  98 | a();' }],
    });
    const payload = (await loadRunPayload(db as never, 31))!.runPayload;
    expect(payload.topFailures[0]!.source).toEqual({ file: 'tests/pay.spec.ts', line: 11, snippet: SOURCE });
    expect(payload.ciUrl).toBe('https://gitlab.example.com/acme/shop/-/pipelines/7');
  });
});
