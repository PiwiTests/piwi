import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { resolveImpact } = await import('../../server/utils/selection-impact');

let db: ReturnType<typeof drizzle<typeof schema>>;
let caseSeq = 0;
let runSeq = 0;
let clock = 0;

async function seedCase(title: string, filePath: string): Promise<number> {
  const id = ++caseSeq;
  await db.insert(schema.testCases).values({ id, projectId: 1, filePath, title });
  return id;
}

/** One execution: failed with the given source frames, or passed with none when `frames` is empty. */
async function seedExec(testCaseId: number, frames: string[], line = 1): Promise<void> {
  const runId = ++runSeq;
  const status = frames.length > 0 ? 'failed' : 'passed';
  await db.insert(schema.testRuns).values({ id: runId, projectId: 1, status, startTime: new Date(++clock) });
  await db.insert(schema.testRunsCases).values({
    testRunId: runId,
    testCaseId,
    status,
    line,
    testSourceFrames: frames.length > 0 ? frames.map((file) => ({ file, line, snippet: '' })) : null,
    createdAt: new Date(++clock),
  });
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'impact-project' });
  caseSeq = 0;
  runSeq = 0;
  clock = 0;
});

describe('resolveImpact', () => {
  test('maps a changed test file directly to its tests', async () => {
    const login = await seedCase('logs in', 'tests/login.spec.ts');
    await seedExec(login, ['tests/login.spec.ts']);
    await seedCase('checks out', 'tests/checkout.spec.ts');

    const r = await resolveImpact(db, 1, ['tests/login.spec.ts']);
    expect(r.impact.widened).toBe(false);
    expect(r.tests.map((t) => t.testCaseId)).toEqual([login]);
    expect(r.impact.mappedFiles).toBe(1);
  });

  test("widens when a changed helper maps only through one test's failure frames", async () => {
    // Two passing tests use the helper; only the one that failed inside it recorded frames.
    const failedInHelper = await seedCase('pays', 'tests/checkout.spec.ts');
    await seedExec(failedInHelper, ['pages/CartPage.ts', 'tests/checkout.spec.ts']);
    const passingUser = await seedCase('empties the cart', 'tests/cart.spec.ts');
    await seedExec(passingUser, []);
    const other = await seedCase('logs in', 'tests/login.spec.ts');
    await seedExec(other, []);

    const r = await resolveImpact(db, 1, ['pages/CartPage.ts']);
    expect(r.impact.widened).toBe(true);
    expect(r.impact.mappedFiles).toBe(1);
    expect(r.impact.unmappedSourceFiles).toEqual(['pages/CartPage.ts']);
    expect(r.tests.map((t) => t.testCaseId).sort()).toEqual([failedInHelper, passingUser, other]);
    expect(r.warnings.find((w) => w.code === 'impact-widened')?.message).toContain('failure frames');
  });

  test('a changed test file stays narrow when its own failure frames also name it', async () => {
    const checkout = await seedCase('pays', 'tests/checkout.spec.ts');
    await seedExec(checkout, ['tests/checkout.spec.ts']);
    await seedCase('logs in', 'tests/login.spec.ts');

    const r = await resolveImpact(db, 1, ['tests/checkout.spec.ts']);
    expect(r.impact.widened).toBe(false);
    expect(r.tests.map((t) => t.testCaseId)).toEqual([checkout]);
  });

  test('widens to the full suite when a changed source file maps to no test', async () => {
    const a = await seedCase('a', 'tests/a.spec.ts');
    await seedExec(a, ['tests/a.spec.ts']);
    const b = await seedCase('b', 'tests/b.spec.ts');
    await seedExec(b, ['tests/b.spec.ts']);

    const r = await resolveImpact(db, 1, ['src/services/pricing.ts']);
    expect(r.impact.widened).toBe(true);
    expect(r.impact.unmappedSourceFiles).toEqual(['src/services/pricing.ts']);
    // The whole suite runs.
    expect(r.tests.map((t) => t.testCaseId).sort()).toEqual([a, b]);
    expect(r.warnings.some((w) => w.code === 'impact-widened')).toBe(true);
  });

  test('widens when a changed stylesheet, markup or config file maps to no test', async () => {
    const a = await seedCase('a', 'tests/a.spec.ts');
    const b = await seedCase('b', 'tests/b.spec.ts');

    for (const file of ['src/styles/app.css', 'public/index.html', 'config/flags.json', 'deploy/app.yaml']) {
      const r = await resolveImpact(db, 1, [file]);
      expect(r.impact.widened).toBe(true);
      expect(r.impact.unmappedSourceFiles).toEqual([file]);
      expect(r.tests.map((t) => t.testCaseId).sort()).toEqual([a, b]);
    }
  });

  test('a docs-only change impacts nothing and does not widen', async () => {
    const a = await seedCase('a', 'tests/a.spec.ts');
    await seedExec(a, ['tests/a.spec.ts']);

    const r = await resolveImpact(db, 1, ['README.md', 'docs/guide.md', 'docs/notes.txt']);
    expect(r.impact.widened).toBe(false);
    expect(r.tests).toHaveLength(0);
  });

  test('matches on a path suffix so prefix differences do not miss', async () => {
    const login = await seedCase('logs in', 'tests/login.spec.ts');
    await seedExec(login, ['tests/login.spec.ts']);

    // A changed path reported with a repo prefix still matches the project-relative one.
    const r = await resolveImpact(db, 1, ['apps/web/tests/login.spec.ts']);
    expect(r.tests.map((t) => t.testCaseId)).toEqual([login]);
  });
});
