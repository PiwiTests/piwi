import { describe, test, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

delete process.env.PIWI_DATABASE_URL;
const { computeChangeCoverage, extractTicketIds, pickPrimaryTicket } =
  await import('../../shared/handlers/change-coverage');
const { routeNodeKey, pageNodeKey } = await import('../../shared/graph');
const { combineCoverage } = await import('../../shared/coverage-combine');

let db: ReturnType<typeof drizzle<typeof schema>>;
let caseSeq = 0;
let runSeq = 0;
let clock = 0;

async function seedCase(title: string, filePath: string): Promise<number> {
  const id = ++caseSeq;
  await db.insert(schema.testCases).values({ id, projectId: 1, filePath, title });
  return id;
}

/** A run in which a set of test cases executed. Returns the run id. */
async function seedRun(testCaseIds: number[]): Promise<number> {
  const runId = ++runSeq;
  await db.insert(schema.testRuns).values({ id: runId, projectId: 1, status: 'passed', startTime: new Date(++clock) });
  for (const testCaseId of testCaseIds) {
    await db
      .insert(schema.testRunsCases)
      .values({ testRunId: runId, testCaseId, status: 'passed', createdAt: new Date(++clock) });
  }
  return runId;
}

/** A `reaches` edge from a test case into a graph node. */
async function seedReachEdge(testCaseId: number, toKind: string, toKey: string): Promise<void> {
  await db.insert(schema.graphEdges).values({
    projectId: 1,
    fromKind: 'test',
    fromKey: String(testCaseId),
    toKind,
    toKey,
    kind: 'reaches',
    confidence: 1,
    lastSeenAt: new Date(++clock),
  });
}

/** A locator call site for a test case, pointing at a source file. */
async function seedLocator(testCaseId: number, location: string): Promise<void> {
  await db.insert(schema.locatorSnapshots).values({
    testCaseId,
    location,
    usedMethod: 'getByRole',
    usedArgs: '[]',
    usedArgsFp: 'fp',
    elementAttrs: '{}',
    alternatives: '[]',
    lastSeenAt: new Date(++clock),
  });
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values({ id: 1, name: 'change-coverage-project' });
  caseSeq = 0;
  runSeq = 0;
  clock = 0;
});

describe('extractTicketIds', () => {
  test('pulls Jira/Linear-style ids from free text, deduped', () => {
    expect(extractTicketIds(['fix: PROJ-418 stale version', 'chore(ABC-9): retry', null, 'PROJ-418 again'])).toEqual([
      'PROJ-418',
      'ABC-9',
    ]);
  });

  test('is empty when nothing matches', () => {
    expect(extractTicketIds(['no tickets here', undefined])).toEqual([]);
  });

  test('drops standards, hashes and acronyms that share the ticket shape', () => {
    expect(
      extractTicketIds(['bump to UTF-8, SHA-256 and ISO-8601', 'note COVID-19 and ES-2015', 'real PROJ-7']),
    ).toEqual(['PROJ-7']);
  });

  test('keeps an id matching the project key even if its prefix is denylisted', () => {
    expect(extractTicketIds(['ES-2015 spec work'], { ticketKey: 'ES' })).toEqual(['ES-2015']);
  });
});

describe('pickPrimaryTicket', () => {
  test('prefers an id matching the project tracker key', () => {
    expect(pickPrimaryTicket(['ABC-1', 'PROJ-9'], 'PROJ')).toBe('PROJ-9');
  });

  test('falls back to the first id when none matches the key', () => {
    expect(pickPrimaryTicket(['ABC-1', 'XYZ-2'], 'PROJ')).toBe('ABC-1');
    expect(pickPrimaryTicket([], 'PROJ')).toBeNull();
  });
});

describe('computeChangeCoverage', () => {
  test('marks a file reached in the run when a reaching test ran there', async () => {
    const orders = await seedCase('places an order', 'tests/orders.spec.ts');
    await seedLocator(orders, 'src/api/orders.post.ts:12:4');
    const runId = await seedRun([orders]);

    const cc = await computeChangeCoverage(db, 1, {
      changedFiles: [{ filePath: 'src/api/orders.post.ts', additions: 41, deletions: 3 }],
      runId,
      tickets: ['PROJ-418'],
    });

    const file = cc.files[0]!;
    expect(file.reachedInRun).toBe(true);
    expect(file.reachedCountHistory).toBe(1);
    expect(file.reachingTestCount).toBe(1);
    expect(file.ticket).toBe('PROJ-418');
    expect(cc.reachedFiles).toBe(1);
    expect(cc.uncoveredFiles).toBe(0);
  });

  test('marks a changed file with no reaching test as uncovered', async () => {
    const orders = await seedCase('places an order', 'tests/orders.spec.ts');
    await seedLocator(orders, 'src/api/orders.post.ts:12:4');
    const runId = await seedRun([orders]);

    const cc = await computeChangeCoverage(db, 1, {
      changedFiles: [
        { filePath: 'src/api/orders.post.ts', additions: 41, deletions: 3 },
        { filePath: 'src/utils/rounding.ts', additions: 5, deletions: 1 },
      ],
      runId,
      tickets: ['PROJ-418'],
    });

    const rounding = cc.files.find((f) => f.filePath === 'src/utils/rounding.ts')!;
    expect(rounding.reachedInRun).toBe(false);
    expect(rounding.reachedCountHistory).toBe(0);
    expect(cc.reachedFiles).toBe(1);
    expect(cc.uncoveredFiles).toBe(1);
  });

  test('a skipped or did-not-run case does not count as reach', async () => {
    const orders = await seedCase('places an order', 'tests/orders.spec.ts');
    await seedLocator(orders, 'src/api/orders.post.ts:12:4');
    // The reaching test was skipped this run (and every recent run), so the file
    // is not covered even though a reaching test exists.
    const runId = ++runSeq;
    await db
      .insert(schema.testRuns)
      .values({ id: runId, projectId: 1, status: 'passed', startTime: new Date(++clock) });
    await db
      .insert(schema.testRunsCases)
      .values({ testRunId: runId, testCaseId: orders, status: 'skipped', createdAt: new Date(++clock) });

    const cc = await computeChangeCoverage(db, 1, {
      changedFiles: [{ filePath: 'src/api/orders.post.ts', additions: 41, deletions: 3 }],
      runId,
    });
    const file = cc.files[0]!;
    expect(file.reachedInRun).toBe(false);
    expect(file.reachedCountHistory).toBe(0);
    expect(cc.uncoveredFiles).toBe(1);
  });

  test('threads the filesTruncated flag from the diff into the coverage', async () => {
    const cc = await computeChangeCoverage(db, 1, {
      changedFiles: [{ filePath: 'src/a.ts', additions: 1, deletions: 0 }],
      filesTruncated: true,
      totalChangedFiles: 500,
    });
    expect(cc.filesTruncated).toBe(true);
    expect(cc.totalChangedFiles).toBe(500);
  });

  test('a changed spec file reaches the tests defined in it', async () => {
    const login = await seedCase('logs in', 'tests/login.spec.ts');
    const runId = await seedRun([login]);

    const cc = await computeChangeCoverage(db, 1, {
      changedFiles: [{ filePath: 'tests/login.spec.ts', additions: 2, deletions: 0 }],
      runId,
    });

    expect(cc.files[0]!.reachedInRun).toBe(true);
    expect(cc.files[0]!.ticket).toBeNull();
  });

  test('a changed route handler is reached through its route node', async () => {
    const orders = await seedCase('places an order', 'tests/orders.spec.ts');
    const runId = await seedRun([orders]);
    await seedReachEdge(orders, 'route', routeNodeKey('GET', '/api/orders/:id'));

    const cc = await computeChangeCoverage(db, 1, {
      changedFiles: [{ filePath: 'server/api/orders/[id].get.ts', additions: 4, deletions: 0 }],
      runId,
    });

    const file = cc.files[0]!;
    expect(file.reachedInRun).toBe(true);
    expect(file.reachBasis).toBe('reached');
    expect(cc.uncoveredFiles).toBe(0);
  });

  test('a changed page file is reached through its page node', async () => {
    const checkout = await seedCase('checks out', 'tests/checkout.spec.ts');
    const runId = await seedRun([checkout]);
    await seedReachEdge(checkout, 'page', pageNodeKey('/orders/123'));

    const cc = await computeChangeCoverage(db, 1, {
      changedFiles: [{ filePath: 'app/pages/orders/[id].vue', additions: 2, deletions: 1 }],
      runId,
    });

    expect(cc.files[0]!.reachedInRun).toBe(true);
    expect(cc.files[0]!.reachBasis).toBe('reached');
  });

  test('an unreached route handler is observable, a bare component is not', async () => {
    const orders = await seedCase('places an order', 'tests/orders.spec.ts');
    const runId = await seedRun([orders]);

    const cc = await computeChangeCoverage(db, 1, {
      changedFiles: [
        { filePath: 'server/api/refunds/[id].post.ts', additions: 10, deletions: 0 },
        { filePath: 'app/components/OrderRow.vue', additions: 8, deletions: 2 },
      ],
      runId,
    });

    const handler = cc.files.find((f) => f.filePath === 'server/api/refunds/[id].post.ts')!;
    const component = cc.files.find((f) => f.filePath === 'app/components/OrderRow.vue')!;
    expect(handler.reachedInRun).toBe(false);
    expect(handler.reachBasis).toBe('observable-unreached');
    expect(component.reachBasis).toBe('no-evidence');
  });

  test('groups files by their primary ticket', async () => {
    const orders = await seedCase('places an order', 'tests/orders.spec.ts');
    await seedRun([orders]);

    const cc = await computeChangeCoverage(db, 1, {
      changedFiles: [
        { filePath: 'src/a.ts', additions: 1, deletions: 0 },
        { filePath: 'src/b.ts', additions: 1, deletions: 0 },
      ],
      tickets: ['PROJ-1'],
    });

    expect(cc.tickets).toHaveLength(1);
    expect(cc.tickets[0]!.ticket).toBe('PROJ-1');
    expect(cc.tickets[0]!.files).toHaveLength(2);
  });

  test('counts a file a suite ran a changed line of as reached, and the change’s patch coverage', async () => {
    const orders = await seedCase('places an order', 'tests/orders.spec.ts');
    await seedRun([orders]);
    const blob = 'a'.repeat(40);
    const combined = combineCoverage({
      inventory: null,
      inScope: () => true,
      spanTable: new Map(),
      suites: [
        {
          name: 'unit-back',
          kind: 'unit',
          files: [
            {
              path: 'src/utils/rounding.ts',
              blob,
              executable: [[1, 6]],
              lines: [[1, 3]],
              functions: [],
              allFunctions: [],
              linesRecorded: true,
            },
          ],
        },
      ],
    });

    const cc = await computeChangeCoverage(db, 1, {
      changedFiles: [
        { filePath: 'src/utils/rounding.ts', additions: 3, deletions: 0, changedLines: [2, 5, 6] },
        { filePath: 'src/utils/tax.ts', additions: 1, deletions: 0, changedLines: [1] },
      ],
      commitCoverage: { commit: 'c0ffee', files: combined.files, suites: combined.suites },
    });

    const [rounding, tax] = cc.files;
    expect(rounding).toMatchObject({ suites: ['unit-back'], reachBasis: 'reached', reachedInRun: false });
    expect(tax!.suites).toEqual([]);
    expect(cc.reachedFiles).toBe(1);
    expect(cc.uncoveredFiles).toBe(1);
    expect(cc.patchCoverage).toMatchObject({ changedLines: 3, executedLines: 1, unitLines: 1, e2eLines: 0 });
  });
});
