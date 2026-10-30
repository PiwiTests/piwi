import { describe, test, expect, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
const {
  resolveSelectionDefinition,
  listSelections,
  listResolvedSelections,
  getSelection,
  createSelection,
  updateSelection,
  deleteSelection,
  SelectionError,
} = await import('../../shared/handlers/selections');
const { addQuarantine } = await import('../../shared/handlers/quarantine');

let db: ReturnType<typeof drizzle<typeof schema>>;
let caseSeq = 0;
let runSeq = 0;
let clock = 0;

interface CaseOpts {
  filePath?: string;
  suitePath?: string;
  tags?: string[];
  locks?: string[];
  owner?: string | null;
  priority?: string | null;
  feature?: string | null;
}

async function seedCase(title: string, opts: CaseOpts = {}): Promise<number> {
  const id = ++caseSeq;
  await db.insert(schema.testCases).values({
    id,
    projectId: 1,
    filePath: opts.filePath ?? 'tests/a.spec.ts',
    suitePath: opts.suitePath ?? '',
    title,
    tags: opts.tags ?? null,
    locks: opts.locks ?? null,
    owner: opts.owner ?? null,
    priority: opts.priority ?? null,
    feature: opts.feature ?? null,
  });
  return id;
}

async function seedExecution(
  testCaseId: number,
  status: string,
  opts: { duration?: number; line?: number; retries?: number } = {},
): Promise<void> {
  const runId = ++runSeq;
  await db.insert(schema.testRuns).values({ id: runId, projectId: 1, status: 'passed', startTime: new Date(++clock) });
  await db.insert(schema.testRunsCases).values({
    testRunId: runId,
    testCaseId,
    status,
    duration: opts.duration ?? null,
    line: opts.line ?? null,
    retries: opts.retries ?? 0,
    createdAt: new Date(++clock),
  });
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'selection-project' });
  caseSeq = 0;
  runSeq = 0;
  clock = 0;
});

describe('predicate matching', () => {
  test('include by tag, AND within a group, OR across groups', async () => {
    const a = await seedCase('a', { tags: ['smoke', 'auth'] });
    await seedCase('b', { tags: ['auth'] });
    const c = await seedCase('c', { tags: ['smoke'] });

    const byTag = await resolveSelectionDefinition(db, 1, { include: [{ tags: ['smoke'] }] });
    expect(byTag.tests.map((t) => t.testCaseId).sort()).toEqual([a, c]);

    const both = await resolveSelectionDefinition(db, 1, { include: [{ tags: ['smoke', 'auth'] }] });
    expect(both.tests.map((t) => t.testCaseId)).toEqual([a]);
  });

  test('priority and file-glob predicates', async () => {
    const crit = await seedCase('crit', { priority: 'critical', filePath: 'tests/checkout/pay.spec.ts' });
    await seedCase('low', { priority: 'low', filePath: 'tests/checkout/pay.spec.ts' });
    await seedCase('other', { priority: 'critical', filePath: 'tests/misc/thing.spec.ts' });

    const r = await resolveSelectionDefinition(db, 1, {
      include: [{ priority: ['critical'], files: ['tests/checkout/**'] }],
    });
    expect(r.tests.map((t) => t.testCaseId)).toEqual([crit]);
  });

  test('exclude removes matched tests', async () => {
    const keep = await seedCase('keep', { tags: ['smoke'] });
    await seedCase('drop', { tags: ['smoke'], filePath: 'tests/experimental/x.spec.ts' });
    const r = await resolveSelectionDefinition(db, 1, {
      include: [{ tags: ['smoke'] }],
      exclude: [{ files: ['tests/experimental/**'] }],
    });
    expect(r.tests.map((t) => t.testCaseId)).toEqual([keep]);
  });

  test('quarantined predicate and exclusion', async () => {
    const q = await seedCase('quar');
    const ok = await seedCase('ok');
    await seedExecution(q, 'passed');
    await seedExecution(ok, 'passed');
    await addQuarantine(db, 1, q);

    const only = await resolveSelectionDefinition(db, 1, { include: [{ quarantined: true }] });
    expect(only.tests.map((t) => t.testCaseId)).toEqual([q]);
    expect(only.warnings.some((w) => w.code === 'quarantined-included')).toBe(true);

    const free = await resolveSelectionDefinition(db, 1, { exclude: [{ quarantined: true }] });
    expect(free.tests.map((t) => t.testCaseId)).toEqual([ok]);
  });

  test('flaky, pass-rate and duration predicates', async () => {
    const flaky = await seedCase('flaky');
    await seedExecution(flaky, 'passed', { retries: 1, duration: 5000 });
    await seedExecution(flaky, 'failed', { duration: 5000 });

    const solid = await seedCase('solid');
    await seedExecution(solid, 'passed', { duration: 100 });
    await seedExecution(solid, 'passed', { duration: 100 });

    expect(
      (await resolveSelectionDefinition(db, 1, { include: [{ flaky: true }] })).tests.map((t) => t.testCaseId),
    ).toEqual([flaky]);
    expect(
      (await resolveSelectionDefinition(db, 1, { include: [{ minPassRate: 1 }] })).tests.map((t) => t.testCaseId),
    ).toEqual([solid]);
    expect(
      (await resolveSelectionDefinition(db, 1, { include: [{ maxAvgDurationMs: 1000 }] })).tests.map(
        (t) => t.testCaseId,
      ),
    ).toEqual([solid]);
  });

  test('lastStatus and failedInLastRuns window', async () => {
    const broken = await seedCase('broken');
    await seedExecution(broken, 'passed');
    await seedExecution(broken, 'passed');
    await seedExecution(broken, 'failed'); // most recent

    const oldFail = await seedCase('old-fail');
    await seedExecution(oldFail, 'failed');
    for (let i = 0; i < 5; i++) await seedExecution(oldFail, 'passed'); // failure is 6 back

    expect(
      (await resolveSelectionDefinition(db, 1, { include: [{ lastStatus: ['failed'] }] })).tests.map(
        (t) => t.testCaseId,
      ),
    ).toEqual([broken]);
    // Only `broken` failed within the last 3 executions.
    expect(
      (await resolveSelectionDefinition(db, 1, { include: [{ failedInLastRuns: 3 }] })).tests.map((t) => t.testCaseId),
    ).toEqual([broken]);
    // Widen the window and the older failure qualifies too.
    expect(
      (await resolveSelectionDefinition(db, 1, { include: [{ failedInLastRuns: 10 }] })).tests
        .map((t) => t.testCaseId)
        .sort(),
    ).toEqual([broken, oldFail]);
  });

  test('neverRun predicate', async () => {
    const fresh = await seedCase('fresh');
    const ran = await seedCase('ran');
    await seedExecution(ran, 'passed');
    expect(
      (await resolveSelectionDefinition(db, 1, { include: [{ neverRun: true }] })).tests.map((t) => t.testCaseId),
    ).toEqual([fresh]);
  });
});

describe('budget, limit and pins', () => {
  test('budget takes the ranked tests that fit the time cap', async () => {
    const fast = await seedCase('fast');
    await seedExecution(fast, 'passed', { duration: 1000 });
    const mid = await seedCase('mid');
    await seedExecution(mid, 'passed', { duration: 2000 });
    const slow = await seedCase('slow');
    await seedExecution(slow, 'passed', { duration: 5000 });

    const r = await resolveSelectionDefinition(db, 1, { budget: { maxTotalDurationMs: 3500, rankBy: 'fastest' } });
    expect(r.tests.map((t) => t.testCaseId)).toEqual([fast, mid]);
    expect(r.estimate.totalDurationMs).toBe(3000);
  });

  test('limit caps the count', async () => {
    for (let i = 0; i < 5; i++) await seedCase(`t${i}`);
    const r = await resolveSelectionDefinition(db, 1, { limit: 2 });
    expect(r.tests).toHaveLength(2);
  });

  test('pins add and remove, and warn on a missing pin', async () => {
    const a = await seedCase('a', { tags: ['smoke'] });
    const b = await seedCase('b');
    const r = await resolveSelectionDefinition(db, 1, {
      include: [{ tags: ['smoke'] }],
      pins: { add: [b, 9999], remove: [a] },
    });
    expect(r.tests.map((t) => t.testCaseId).sort()).toEqual([b]);
    expect(r.warnings.some((w) => w.code === 'pin-not-found')).toBe(true);
  });
});

describe('duration-balanced sharding', () => {
  test('splits the resolved set into balanced, disjoint, complete shards', async () => {
    // Durations chosen so a file-count split would be lopsided but a
    // duration-balanced one is even: 8,7,6,5,4,3,2,1 → two shards of 18 each.
    const durations = [8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000];
    for (let i = 0; i < durations.length; i++) {
      const id = await seedCase(`t${i}`, { filePath: `tests/f${i}.spec.ts` });
      await seedExecution(id, 'passed', { duration: durations[i] });
    }

    const shard1 = await resolveSelectionDefinition(db, 1, {}, { shard: { index: 1, total: 2 } });
    const shard2 = await resolveSelectionDefinition(db, 1, {}, { shard: { index: 2, total: 2 } });

    // Disjoint and together cover the whole set.
    const ids1 = shard1.tests.map((t) => t.testCaseId);
    const ids2 = shard2.tests.map((t) => t.testCaseId);
    expect([...ids1, ...ids2].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);

    // Balanced by duration, not by count.
    expect(shard1.estimate.totalDurationMs).toBe(18000);
    expect(shard2.estimate.totalDurationMs).toBe(18000);
  });

  test('is deterministic — the same shard resolves the same tests', async () => {
    for (let i = 0; i < 6; i++) {
      const id = await seedCase(`t${i}`, { filePath: `tests/f${i}.spec.ts` });
      await seedExecution(id, 'passed', { duration: (i + 1) * 1000 });
    }
    const a = await resolveSelectionDefinition(db, 1, {}, { shard: { index: 2, total: 3 } });
    const b = await resolveSelectionDefinition(db, 1, {}, { shard: { index: 2, total: 3 } });
    expect(a.tests.map((t) => t.testCaseId)).toEqual(b.tests.map((t) => t.testCaseId));
  });

  test('keeps every holder of a lock in the same shard', async () => {
    // Two holders of `db` plus six singletons; a plain duration split would
    // scatter the holders, but lock-aware sharding keeps them together.
    const held1 = await seedCase('held-a', { filePath: 'tests/f0.spec.ts', locks: ['db'] });
    const held2 = await seedCase('held-b', { filePath: 'tests/f7.spec.ts', locks: ['db'] });
    await seedExecution(held1, 'passed', { duration: 1000 });
    await seedExecution(held2, 'passed', { duration: 8000 });
    for (let i = 1; i < 7; i++) {
      const id = await seedCase(`t${i}`, { filePath: `tests/f${i}.spec.ts` });
      await seedExecution(id, 'passed', { duration: (i + 1) * 1000 });
    }

    const shards = await Promise.all(
      [1, 2, 3, 4].map((index) => resolveSelectionDefinition(db, 1, {}, { shard: { index, total: 4 } })),
    );
    const homeOf = (id: number) => shards.findIndex((s) => s.tests.some((t) => t.testCaseId === id));
    expect(homeOf(held1)).toBe(homeOf(held2));
    expect(homeOf(held1)).toBeGreaterThanOrEqual(0);
  });
});

describe('split-lock warning', () => {
  test('warns when a lock is shared by more than one test', async () => {
    const a = await seedCase('a', { locks: ['db'] });
    const b = await seedCase('b', { locks: ['db'] });
    await seedExecution(a, 'passed');
    await seedExecution(b, 'passed');

    const r = await resolveSelectionDefinition(db, 1, {});
    const warning = r.warnings.find((w) => w.code === 'split-lock');
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('db');
  });

  test('does not warn when each lock is held by a single test', async () => {
    const a = await seedCase('a', { locks: ['db'] });
    const b = await seedCase('b', { locks: ['cache'] });
    await seedExecution(a, 'passed');
    await seedExecution(b, 'passed');

    const r = await resolveSelectionDefinition(db, 1, {});
    expect(r.warnings.some((w) => w.code === 'split-lock')).toBe(false);
  });

  test('surfaces locks on each resolved test', async () => {
    const a = await seedCase('a', { locks: ['db', 'cache'] });
    await seedExecution(a, 'passed');
    const r = await resolveSelectionDefinition(db, 1, {});
    expect(r.tests[0]!.locks).toEqual(['db', 'cache']);
  });
});

describe('fail-fast order', () => {
  test('emits the least-reliable tests first without changing the set or hash', async () => {
    // Titles ordered so the default (alphabetical) order is the reverse of fail-fast.
    const reliable = await seedCase('aaa-reliable');
    await seedExecution(reliable, 'passed');
    await seedExecution(reliable, 'passed');
    const flaky = await seedCase('mmm-flaky');
    await seedExecution(flaky, 'passed');
    await seedExecution(flaky, 'failed');
    const broken = await seedCase('zzz-broken');
    await seedExecution(broken, 'failed');
    await seedExecution(broken, 'failed');

    const plain = await resolveSelectionDefinition(db, 1, {});
    const failFast = await resolveSelectionDefinition(db, 1, {}, { order: 'failureLikelihood' });

    expect(plain.tests.map((t) => t.testCaseId)).toEqual([reliable, flaky, broken]);
    expect(failFast.tests.map((t) => t.testCaseId)).toEqual([broken, flaky, reliable]);
    // Same tests, different order → identical hash.
    expect(failFast.resolvedHash).toBe(plain.resolvedHash);
  });
});

describe('hash and materialization', () => {
  test('the resolved hash is stable and order-independent', async () => {
    await seedCase('a', { filePath: 'tests/a.spec.ts' });
    await seedCase('b', { filePath: 'tests/b.spec.ts' });
    const one = await resolveSelectionDefinition(db, 1, {});
    const two = await resolveSelectionDefinition(db, 1, { budget: { rankBy: 'slowest' } });
    expect(one.resolvedHash).toBe(two.resolvedHash);
    expect(one.resolvedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('materialization uses the latest known line', async () => {
    const a = await seedCase('a', { filePath: 'tests/a.spec.ts' });
    await seedExecution(a, 'passed', { line: 12 });
    await seedExecution(a, 'passed', { line: 20 }); // most recent
    const r = await resolveSelectionDefinition(db, 1, {}, { format: 'args' });
    expect(r.materialization.args).toEqual(['tests/a.spec.ts:20']);
  });
});

describe('built-ins and CRUD', () => {
  test('built-ins are listed and resolvable without setup', async () => {
    const list = await listSelections(db, 1);
    expect(list.map((s) => s.key)).toContain('failed');
    expect(list.map((s) => s.key)).toContain('quarantine-free');
    expect(list.find((s) => s.key === 'failed')?.builtin).toBe(true);

    const failing = await seedCase('failing');
    await seedExecution(failing, 'failed');
    const passing = await seedCase('passing');
    await seedExecution(passing, 'passed');

    const failed = await getSelection(db, 1, 'failed');
    const r = await resolveSelectionDefinition(db, 1, failed!.definition, { key: 'failed', version: 0 });
    expect(r.tests.map((t) => t.testCaseId)).toEqual([failing]);
  });

  test('the list resolves every selection as the resolve endpoint does', async () => {
    const failing = await seedCase('failing', { tags: ['smoke'] });
    await seedExecution(failing, 'failed', { line: 7 });
    const passing = await seedCase('passing', { tags: ['smoke'] });
    await seedExecution(passing, 'passed', { line: 12 });
    await createSelection(db, 1, { key: 'smoke', name: 'Smoke', definition: { include: [{ tags: ['smoke'] }] } });

    const listed = await listResolvedSelections(db, 1);
    expect(listed.map((s) => s.key)).toEqual((await listSelections(db, 1)).map((s) => s.key));
    for (const selection of listed) {
      const one = await resolveSelectionDefinition(db, 1, selection.definition, {
        key: selection.key,
        version: selection.version,
      });
      expect(selection.resolved).toEqual({
        testCaseIds: one.tests.map((t) => t.testCaseId),
        resolvedHash: one.resolvedHash,
        estimate: one.estimate,
        warnings: one.warnings,
        command: one.materialization.command,
      });
    }
    expect(listed.find((s) => s.key === 'failed')!.resolved.testCaseIds).toEqual([failing]);
    expect(listed.find((s) => s.key === 'smoke')!.resolved.testCaseIds.sort()).toEqual([failing, passing].sort());
  });

  test('create, get, update (version bump) and delete', async () => {
    const created = await createSelection(db, 1, {
      key: 'smoke',
      name: 'Smoke',
      definition: { include: [{ tags: ['smoke'] }] },
    });
    expect(created.version).toBe(1);

    // A no-op definition update does not bump the version.
    const renamed = await updateSelection(db, 1, 'smoke', { name: 'Smoke tests' });
    expect(renamed.version).toBe(1);
    expect(renamed.name).toBe('Smoke tests');

    // A real definition change does.
    const changed = await updateSelection(db, 1, 'smoke', { definition: { include: [{ tags: ['smoke', 'core'] }] } });
    expect(changed.version).toBe(2);

    expect((await deleteSelection(db, 1, 'smoke')).deleted).toBe(true);
    expect(await getSelection(db, 1, 'smoke')).toBeNull();
  });

  test('rejects a reserved key, an invalid definition and a duplicate', async () => {
    await expect(createSelection(db, 1, { key: 'failed', name: 'x', definition: {} })).rejects.toBeInstanceOf(
      SelectionError,
    );
    await expect(
      createSelection(db, 1, { key: 'bad', name: 'x', definition: { include: [{ nope: 1 }] } as never }),
    ).rejects.toThrow(/Invalid definition/);

    await createSelection(db, 1, { key: 'dup', name: 'x', definition: {} });
    await expect(createSelection(db, 1, { key: 'dup', name: 'y', definition: {} })).rejects.toThrow(/already exists/);
  });

  test('updating a missing selection throws not-found', async () => {
    await expect(updateSelection(db, 1, 'ghost', { name: 'x' })).rejects.toThrow(/not found/);
  });
});
