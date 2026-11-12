import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { MAX_VIDEO_ACTIONS, type RawAction } from '../../shared/video-actions';
import { openTempDb, type TempDb } from './temp-db';

/** `getVideoActions`: an execution's marks, from the trace when it has one, else from its steps. */

delete process.env.PIWI_DATABASE_URL;
const { getVideoActions } = await import('../../shared/handlers/video-actions');

let db: TempDb;
let close: () => Promise<void>;

const T0 = 1_700_000_000_000;

const STEPS = [
  { title: 'Create page', category: 'other', startTime: T0 + 100, duration: 45 },
  { title: 'Navigate to "https://shop.test/login?next=%2Fhome"', category: 'navigation', startTime: T0 + 400 },
  { title: `Fill "ada@example.com" getByLabel('Email')`, category: 'input', startTime: T0 + 700 },
  { title: `Click getByRole('button', { name: 'Sign in' })`, category: 'action', startTime: T0 + 1_100, failed: true },
  { title: `Expect "toBeVisible" getByText('Welcome')`, category: 'assertion', startTime: T0 + 1_300 },
];

const trace = (offsets: number[]): RawAction[] =>
  offsets.map((o) => ({ kind: 'click', epochMs: T0 + o, label: "Click getByText('x')", failed: false }));

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testCases).values([
    { id: 1, projectId: 1, filePath: 'tests/a.spec.ts', title: 'one' },
    { id: 2, projectId: 1, filePath: 'tests/a.spec.ts', title: 'two' },
    { id: 3, projectId: 1, filePath: 'tests/a.spec.ts', title: 'three' },
  ]);
  await db
    .insert(schema.testRuns)
    .values({ id: 1, projectId: 1, status: 'passed', startTime: new Date(T0), totalTests: 1 });
  await db.insert(schema.testRunsCases).values([
    { id: 10, testRunId: 1, testCaseId: 1, status: 'failed', startedAt: T0, duration: 2_000, steps: STEPS },
    { id: 11, testRunId: 1, testCaseId: 2, status: 'passed', startedAt: T0, duration: 2_000 },
    { id: 12, testRunId: 1, testCaseId: 3, status: 'passed', startedAt: null, duration: 2_000, steps: STEPS },
  ]);
});

afterEach(async () => {
  await close();
});

describe('getVideoActions', () => {
  test('reads the steps when there is no trace, placed from the end of Create page, with nothing typed in them', async () => {
    const out = await getVideoActions(db as any, 10);
    expect(out.source).toBe('steps');
    expect(out.timing).toBe('create-page');
    expect(out.total).toBe(3);
    expect(out.capped).toBe(false);
    expect(out.actions.map((a) => [a.kind, a.atMs, a.failed])).toEqual([
      ['goto', 400 - 90, false],
      ['fill', 700 - 90, false],
      ['click', 1_100 - 90, true],
    ]);
    expect(out.actions.map((a) => a.label)).toEqual([
      'Navigate to https://shop.test/login',
      "Fill getByLabel('Email'): typed 15 chars",
      "Click getByRole('button', { name: 'Sign in' })",
    ]);
    expect(JSON.stringify(out)).not.toContain('ada@example.com');
  });

  test('reads the trace when it has actions, and the steps when it has none, cannot be read or is absent', async () => {
    const fromTrace = await getVideoActions(db as any, 10, async () => trace([300, 900]));
    expect(fromTrace.source).toBe('trace');
    expect(fromTrace.actions.map((a) => a.atMs)).toEqual([210, 810]);

    for (const reader of [
      async () => [] as RawAction[],
      async () => null,
      async () => {
        throw new Error('corrupt zip');
      },
      undefined,
    ]) {
      expect((await getVideoActions(db as any, 10, reader)).source).toBe('steps');
    }
  });

  test('is empty with neither a trace nor steps, and for an execution that does not exist', async () => {
    const none = { source: 'none', timing: null, actions: [], total: 0, capped: false };
    expect(await getVideoActions(db as any, 11)).toEqual(none);
    expect(await getVideoActions(db as any, 999)).toEqual(none);
  });

  test('says the clock is unknown when the execution has actions but no start time to place them by', async () => {
    const out = await getVideoActions(db as any, 12);
    expect(out).toEqual({
      source: 'none',
      timing: null,
      actions: [],
      total: 0,
      capped: false,
      reason: 'clock-unknown',
    });
    const fromTrace = await getVideoActions(db as any, 12, async () => trace([300]));
    expect(fromTrace.reason).toBe('clock-unknown');
  });

  test('gives no reason when there are no actions at all', async () => {
    expect((await getVideoActions(db as any, 11)).reason).toBeUndefined();
  });

  test('caps the marks and says how many the test took', async () => {
    const out = await getVideoActions(db as any, 10, async () =>
      trace(Array.from({ length: MAX_VIDEO_ACTIONS + 7 }, (_, i) => i)),
    );
    expect(out.actions).toHaveLength(MAX_VIDEO_ACTIONS);
    expect(out.total).toBe(MAX_VIDEO_ACTIONS + 7);
    expect(out.capped).toBe(true);
  });
});
