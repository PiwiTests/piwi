import { describe, test, expect, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { searchProjectsTestRunsCases } = await import('../../shared/handlers/search');

const client = createClient({ url: ':memory:' });
const db = drizzle(client, { schema });
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

/**
 * Six busy projects and, created last, the one a restricted user is assigned
 * to: its matches sort after the busy projects' in every query.
 */
const MINE = 7;

beforeAll(async () => {
  await migrateToLatest(db);
  // LIKE compares case-sensitively, as it does on PostgreSQL.
  await client.execute('PRAGMA case_sensitive_like=ON');

  for (let id = 1; id <= 6; id++) await db.insert(schema.projects).values({ id, name: `shop-${id}` });
  await db.insert(schema.projects).values({ id: MINE, name: 'shop-mine', label: 'My Shop' });

  for (let i = 1; i <= 6; i++) {
    await db.insert(schema.testCases).values({ projectId: 1, filePath: 'login.spec.ts', title: `login flow ${i}` });
    await db
      .insert(schema.testRuns)
      .values({ projectId: 1, status: 'passed', label: 'login nightly', startTime: new Date(NOW - i * HOUR) });
  }
  await db.insert(schema.testCases).values([
    { projectId: MINE, filePath: 'login.spec.ts', title: 'LOGIN page' },
    { projectId: MINE, filePath: 'report.spec.ts', title: 'shows 100% coverage' },
    { projectId: MINE, filePath: 'report.spec.ts', title: 'shows 1000 coverage' },
    { projectId: MINE, filePath: 'form.spec.ts', title: 'fills first_name' },
    { projectId: MINE, filePath: 'form.spec.ts', title: 'fills firstXname' },
    { projectId: MINE, filePath: 'login.spec.ts', title: 'Connexion RÉUSSIE' },
  ]);
  await db.insert(schema.testRuns).values([
    { id: 100, projectId: MINE, status: 'passed', label: 'Login smoke', startTime: new Date(NOW - 24 * HOUR) },
    { id: 101, projectId: MINE, status: 'failed', label: 'build 99999999999', startTime: new Date(NOW - 25 * HOUR) },
  ]);
});

const titles = (res: { cases: Array<{ title: string }> }) => res.cases.map((c) => c.title).sort();

describe('global search', () => {
  test("a restricted user finds their project's matches when other projects have more", async () => {
    const res = await searchProjectsTestRunsCases(db as never, 'login', new Set([MINE]));
    expect(titles(res)).toEqual(['LOGIN page']);
    expect(res.runs.map((r) => r.label)).toEqual(['Login smoke']);
    expect((await searchProjectsTestRunsCases(db as never, 'shop', new Set([MINE]))).projects).toEqual([
      { id: MINE, name: 'shop-mine', label: 'My Shop' },
    ]);
  });

  test('an unrestricted search is capped at five per category', async () => {
    const res = await searchProjectsTestRunsCases(db as never, 'login', 'all');
    expect(res.cases).toHaveLength(5);
    expect(res.runs).toHaveLength(5);
  });

  test('matching ignores case', async () => {
    const res = await searchProjectsTestRunsCases(db as never, 'Login', new Set([MINE]));
    expect(titles(res)).toEqual(['LOGIN page']);
    expect(res.runs.map((r) => r.label)).toEqual(['Login smoke']);
    expect((await searchProjectsTestRunsCases(db as never, 'MY SHOP', 'all')).projects.map((p) => p.id)).toEqual([
      MINE,
    ]);
  });

  test('matching ignores accents, in the query or in the stored text', async () => {
    expect(titles(await searchProjectsTestRunsCases(db as never, 'reussie', 'all'))).toEqual(['Connexion RÉUSSIE']);
    expect(titles(await searchProjectsTestRunsCases(db as never, 'Réussie', 'all'))).toEqual(['Connexion RÉUSSIE']);
    expect(titles(await searchProjectsTestRunsCases(db as never, 'lógin pàge', 'all'))).toEqual(['LOGIN page']);
  });

  test('% and _ in the query match themselves', async () => {
    expect(titles(await searchProjectsTestRunsCases(db as never, '0% cov', 'all'))).toEqual(['shows 100% coverage']);
    expect(titles(await searchProjectsTestRunsCases(db as never, 'first_', 'all'))).toEqual(['fills first_name']);
  });

  test('a number finds the run with that id', async () => {
    const res = await searchProjectsTestRunsCases(db as never, '100', 'all');
    expect(res.runs.map((r) => r.id)).toEqual([100]);
  });

  test('a number too large for a run id matches run labels', async () => {
    const res = await searchProjectsTestRunsCases(db as never, '99999999999', 'all');
    expect(res.runs.map((r) => r.id)).toEqual([101]);
  });

  test('a user with no project sees nothing', async () => {
    expect(await searchProjectsTestRunsCases(db as never, 'login', new Set())).toEqual({
      projects: [],
      runs: [],
      cases: [],
      clusters: [],
    });
  });
});

describe('failure clusters in the global search', () => {
  beforeAll(async () => {
    await db.insert(schema.failureClusters).values([
      {
        id: 40,
        projectId: MINE,
        fingerprint: 'fp-40',
        signature: 'TimeoutError: locator.click',
        title: 'Pay button click times out',
        errorType: 'timeout',
        firstSeenRunId: 100,
        lastSeenRunId: 100,
      },
      {
        id: 41,
        projectId: 1,
        fingerprint: 'fp-41',
        signature: 'Error: expect(received).toBe(expected)',
        errorType: 'assertion',
        firstSeenRunId: 100,
        lastSeenRunId: 100,
      },
    ]);
    await db.insert(schema.entityLinks).values([
      { failureClusterId: 40, url: 'https://acme.atlassian.net/browse/CHK-101', provider: 'jira', key: 'CHK-101' },
      { failureClusterId: 40, url: 'https://github.com/acme/shop/pull/7', provider: 'github-pr', key: '#7' },
    ]);
  });

  test('finds a cluster by the key of an issue linked to it, naming the key', async () => {
    const res = await searchProjectsTestRunsCases(db as never, 'chk-101', 'all');
    expect(res.clusters.map((c) => [c.id, c.issueKey])).toEqual([[40, 'CHK-101']]);
  });

  test('finds a cluster by its title or signature once, whatever links it has', async () => {
    const res = await searchProjectsTestRunsCases(db as never, 'pay button', 'all');
    expect(res.clusters.map((c) => [c.id, c.issueKey])).toEqual([[40, null]]);
    const bySignature = await searchProjectsTestRunsCases(db as never, 'toBe(expected)', 'all');
    expect(bySignature.clusters.map((c) => c.id)).toEqual([41]);
  });

  test('finds a cluster by its number, written with or without #', async () => {
    expect((await searchProjectsTestRunsCases(db as never, '#41', 'all')).clusters.map((c) => c.id)).toEqual([41]);
    expect((await searchProjectsTestRunsCases(db as never, '41', 'all')).clusters.map((c) => c.id)).toContain(41);
  });

  test("keeps clusters outside the caller's projects out", async () => {
    const res = await searchProjectsTestRunsCases(db as never, 'CHK-101', new Set([1]));
    expect(res.clusters).toEqual([]);
  });
});
