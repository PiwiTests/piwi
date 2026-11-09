import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { SelectionStamp } from '@piwitests/core/wire';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const { getSelectionAnalytics } = await import('../../shared/handlers/selection-analytics');
const { createSelection, resolveSelectionDefinition } = await import('../../shared/handlers/selections');

let db: ReturnType<typeof drizzle<typeof schema>>;
let caseSeq = 0;
let runSeq = 0;
let clock = 0;

async function seedCase(title: string, filePath: string): Promise<number> {
  const id = ++caseSeq;
  await db.insert(schema.testCases).values({ id, projectId: 1, filePath, title });
  return id;
}

/** A run stamped with a selection, as `piwi run <key>` records it. */
async function seedStampedRun(stamp: SelectionStamp): Promise<void> {
  const runId = ++runSeq;
  await db.insert(schema.testRuns).values({
    id: runId,
    projectId: 1,
    status: 'passed',
    startTime: new Date(++clock),
    filterDetails: { selection: stamp },
  });
}

async function quarantine(testCaseId: number): Promise<void> {
  await db.insert(schema.quarantinedTests).values({ projectId: 1, testCaseId, createdAt: new Date(++clock) });
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'analytics-project' });
  caseSeq = 0;
  runSeq = 0;
  clock = 0;
});

describe('getSelectionAnalytics', () => {
  test('coverage counts tests matched by no stored selection', async () => {
    await seedCase('logs in', 'tests/login.spec.ts');
    await seedCase('checks out', 'tests/checkout.spec.ts');
    await seedCase('admin', 'tests/admin.spec.ts');
    await createSelection(db, 1, {
      key: 'smoke',
      name: 'Smoke',
      definition: { include: [{ files: ['tests/login.spec.ts'] }] },
    });

    const { coverage } = await getSelectionAnalytics(db, 1);
    expect(coverage.total).toBe(3);
    expect(coverage.selected).toBe(1);
    expect(coverage.unselected).toBe(2);
    expect(coverage.unselectedSample.map((t) => t.filePath)).toEqual(['tests/admin.spec.ts', 'tests/checkout.spec.ts']);
  });

  test('built-ins do not count toward coverage', async () => {
    await seedCase('a', 'tests/a.spec.ts');
    await seedCase('b', 'tests/b.spec.ts');

    // No stored selection — only the built-ins (failed, quarantine-free) exist.
    const { coverage, selections } = await getSelectionAnalytics(db, 1);
    expect(coverage.selected).toBe(0);
    expect(coverage.unselected).toBe(2);
    expect(selections.every((s) => s.builtin)).toBe(true);
  });

  test('flags drift when the definition resolves differently than its last run', async () => {
    await seedCase('logs in', 'tests/login.spec.ts');
    await seedCase('checks out', 'tests/checkout.spec.ts');
    await createSelection(db, 1, {
      key: 'smoke',
      name: 'Smoke',
      definition: { include: [{ files: ['tests/login.spec.ts'] }] },
    });
    // The selection resolves to 1 test now, but its last run recorded 3 under a stale hash.
    await seedStampedRun({ key: 'smoke', version: 1, resolvedHash: 'stale-hash', resolvedCount: 3 });

    const { selections } = await getSelectionAnalytics(db, 1);
    const smoke = selections.find((s) => s.key === 'smoke')!;
    expect(smoke.resolvedCount).toBe(1);
    expect(smoke.lastRun).toEqual({ runId: 1, at: expect.any(Number), recordedCount: 3 });
    expect(smoke.drift).toEqual({ changed: true, countDelta: -2 });
  });

  test('reports no drift when the last run matches the current resolution', async () => {
    await seedCase('logs in', 'tests/login.spec.ts');
    await createSelection(db, 1, {
      key: 'smoke',
      name: 'Smoke',
      definition: { include: [{ files: ['tests/login.spec.ts'] }] },
    });
    const current = await resolveSelectionDefinition(db, 1, { include: [{ files: ['tests/login.spec.ts'] }] });
    await seedStampedRun({ key: 'smoke', version: 1, resolvedHash: current.resolvedHash, resolvedCount: 1 });

    const { selections } = await getSelectionAnalytics(db, 1);
    const smoke = selections.find((s) => s.key === 'smoke')!;
    expect(smoke.drift).toEqual({ changed: false, countDelta: 0 });
  });

  test('leaves drift null for a selection that has never run', async () => {
    await seedCase('logs in', 'tests/login.spec.ts');
    await createSelection(db, 1, {
      key: 'smoke',
      name: 'Smoke',
      definition: { include: [{ files: ['tests/login.spec.ts'] }] },
    });

    const { selections } = await getSelectionAnalytics(db, 1);
    const smoke = selections.find((s) => s.key === 'smoke')!;
    expect(smoke.lastRun).toBeNull();
    expect(smoke.drift).toBeNull();
  });

  test('counts quarantined members inside a resolution', async () => {
    const login = await seedCase('logs in', 'tests/login.spec.ts');
    await seedCase('checks out', 'tests/checkout.spec.ts');
    await quarantine(login);
    await createSelection(db, 1, {
      key: 'all-login',
      name: 'Login',
      definition: { include: [{ files: ['tests/**'] }] },
    });

    const { selections } = await getSelectionAnalytics(db, 1);
    const sel = selections.find((s) => s.key === 'all-login')!;
    expect(sel.resolvedCount).toBe(2);
    expect(sel.quarantinedCount).toBe(1);
    expect(sel.warnings.some((w) => w.code === 'quarantined-included')).toBe(true);
  });
});
