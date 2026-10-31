import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the handler module (which imports the barrel) loads.
delete process.env.PIWI_DATABASE_URL;
const { getProjectAiStepCoverage } = await import('../../shared/handlers/projects');

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

let db: ReturnType<typeof drizzle<typeof schema>>;

async function seedCase(projectId: number, filePath: string, title: string): Promise<number> {
  const inserted = await db
    .insert(schema.testCases)
    .values({ projectId, filePath, suitePath: '', title })
    .returning({ id: schema.testCases.id });
  return inserted[0]!.id;
}

async function seedRun(id: number, projectId: number, startTime: Date): Promise<void> {
  await db.insert(schema.testRuns).values({ id, projectId, status: 'passed', startTime });
}

async function seedRunCase(runId: number, caseId: number, aiUsage: unknown): Promise<void> {
  await db
    .insert(schema.testRunsCases)
    .values({ testRunId: runId, testCaseId: caseId, status: 'passed', duration: 1000, aiUsage: aiUsage as any });
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);

  await db.insert(schema.projects).values({ id: 1, name: 'ai-project' });
  await db.insert(schema.projects).values({ id: 2, name: 'other-project' });
  await db.insert(schema.projects).values({ id: 3, name: 'empty-project' });

  // Two in-window runs and one stale (40 days) run for project 1.
  await seedRun(1, 1, new Date(now - 60 * 1000)); // newest
  await seedRun(2, 1, new Date(now - 2 * DAY_MS));
  await seedRun(3, 1, new Date(now - 40 * DAY_MS)); // outside the 30-day window
  await seedRun(4, 2, new Date(now - 60 * 1000)); // other project

  const caseA = await seedCase(1, 'auth/login.spec.ts', 'sign in');
  const caseB = await seedCase(1, 'auth/reset.spec.ts', 'reset password');
  const caseC = await seedCase(1, 'shop/cart.spec.ts', 'cart badge'); // no AI steps
  const caseD = await seedCase(2, 'auth/login.spec.ts', 'sign in'); // other project

  // login.json is shared by caseA and caseB; flow.json is only caseA. Both are
  // replayed again in run 2 (older) — replays aggregate, last-seen stays run 1.
  await seedRunCase(1, caseA, { entries: ['e/flow.json', 'e/login.json'] });
  await seedRunCase(1, caseB, { entries: ['e/login.json'] });
  await seedRunCase(2, caseA, { entries: ['e/flow.json', 'e/login.json'] });
  // A stale run outside the window must not contribute.
  await seedRunCase(3, caseA, { entries: ['e/stale.json'] });
  // No AI steps for caseC, and an empty manifest must be ignored.
  await seedRunCase(1, caseC, null);
  await seedRunCase(2, caseC, { entries: [] });
  // Other project must never leak into project 1.
  await seedRunCase(4, caseD, { entries: ['e/other.json'] });
});

describe('getProjectAiStepCoverage', () => {
  test('aggregates replays and liveness per artifact within the window', async () => {
    const cov = await getProjectAiStepCoverage(db, 1, 30);

    expect(cov.summary).toEqual({ artifactCount: 2, testCount: 2, runCount: 2, replayCount: 5 });

    const byEntry = new Map(cov.artifacts.map((a) => [a.entry, a]));
    expect([...byEntry.keys()]).toEqual(['e/flow.json', 'e/login.json']); // sorted, stale excluded

    expect(byEntry.get('e/login.json')).toMatchObject({ testCount: 2, replayCount: 3 });
    expect(byEntry.get('e/flow.json')).toMatchObject({ testCount: 1, replayCount: 2 });

    // Last-seen is the newest run that replayed the artifact (run 1).
    const lastSeen = new Date(byEntry.get('e/login.json')!.lastSeen!).getTime();
    expect(Math.abs(lastSeen - (now - 60 * 1000))).toBeLessThan(2000);
  });

  test('excludes stale artifacts and other projects', async () => {
    const cov = await getProjectAiStepCoverage(db, 1, 30);
    const entries = cov.artifacts.map((a) => a.entry);
    expect(entries).not.toContain('e/stale.json'); // outside the window
    expect(entries).not.toContain('e/other.json'); // different project
  });

  test('a widened window brings the stale artifact back', async () => {
    const cov = await getProjectAiStepCoverage(db, 1, 90);
    expect(cov.artifacts.map((a) => a.entry)).toContain('e/stale.json');
    expect(cov.summary.runCount).toBe(3);
  });

  test('returns an empty envelope for a project with no AI steps', async () => {
    const cov = await getProjectAiStepCoverage(db, 3, 30);
    expect(cov).toEqual({ summary: { artifactCount: 0, testCount: 0, runCount: 0, replayCount: 0 }, artifacts: [] });
  });

  test('throws for an unknown project', async () => {
    await expect(getProjectAiStepCoverage(db, 9999, 30)).rejects.toThrow('Project not found');
  });
});
