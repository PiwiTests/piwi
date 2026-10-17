import { describe, test, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';

delete process.env.PIWI_DATABASE_URL;
const { runAnalyticsWidget } = await import('../../shared/handlers/analytics');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');
const { WIDGET_DOCUMENTS } = await import('../../shared/reports/widget-documents');
const { makeFormatter } = await import('../../shared/reports/format');
const { sentencesFor } = await import('../../shared/reports/sentences');

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctxFor = (lang: 'en' | 'fr') => ({
  f: makeFormatter(lang),
  s: sentencesFor(lang),
  baseUrl: null,
  markers: [],
  drawMarkers: true,
});
const scope = (query: Record<string, string> = {}) => parseAnalyticsScope({ days: '14', ...query });

async function daily(
  projectId: number,
  daysAgo: number,
  executed: number,
  executable: number,
  branch = '',
  suite = 'combined',
  area = '',
) {
  await db.insert(schema.coverageDaily).values({
    projectId,
    day: day(daysAgo),
    branch,
    suite,
    area,
    commit: 'c0ffee',
    executableLines: executable,
    executedLines: executed,
    undeterminedLines: 0,
    knownFunctions: 0,
    runFunctions: 0,
    files: 1,
    unitOnlyLines: 0,
    e2eOnlyLines: 0,
    bothLines: 0,
    computedAt: new Date(),
  });
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop', defaultBranch: 'main' },
    { id: 2, name: 'admin', defaultBranch: 'main' },
    { id: 3, name: 'docs', defaultBranch: 'main' },
  ]);
  // Shop: 60% three weeks ago (the comparison period), 70% then 75% in the period.
  await daily(1, 20, 60, 100);
  await daily(1, 10, 70, 100);
  await daily(1, 2, 75, 100);
  // A feature branch's coverage counts only when the scope asks for it.
  await daily(1, 2, 10, 100, 'feat');
  // Admin: one day, carried forward to the period's end.
  await daily(2, 8, 25, 100);
  // Admin's unit suite, on the same lines.
  await daily(2, 8, 20, 100, '', 'unit-back');
  // Admin's front end, an area of half its lines.
  await daily(2, 8, 20, 50, '', 'combined', 'front');
});

describe('coverage trend', () => {
  test('sums the projects’ newest coverage at each bucket’s end, against the comparison period', async () => {
    const data = (await runAnalyticsWidget(db as any, 'coverage-trend', scope({ projects: '1,2' }))) as any;
    expect(data).toMatchObject({
      linePercent: 50,
      previousLinePercent: 60,
      delta: -10,
      executedLines: 100,
      executableLines: 200,
      projects: 2,
      declined: 0,
    });
    expect(data.series).toMatchObject([{ name: 'unit-back', linePercent: 20 }]);
    expect(data.series[0].points).toHaveLength(data.points.length);
    const known = data.points.filter((p: any) => p.linePercent !== null);
    expect(known[0].linePercent).toBe(60);
    expect(known.at(-1).linePercent).toBe(50);
  });

  test('reads a listed branch, and leaves a project with no coverage out of the report', async () => {
    const feat = (await runAnalyticsWidget(
      db as any,
      'coverage-trend',
      scope({ projects: '1', branch: 'feat' }),
    )) as any;
    expect(feat.linePercent).toBe(10);
    const none = await runAnalyticsWidget(db as any, 'coverage-trend', scope({ projects: '3' }));
    expect(WIDGET_DOCUMENTS['coverage-trend'](none, ctxFor('en'), {})).toEqual([]);
  });

  test('maps to a series whose summary gives the share and its change', async () => {
    const data = await runAnalyticsWidget(db as any, 'coverage-trend', scope({ projects: '1' }));
    const [en] = WIDGET_DOCUMENTS['coverage-trend'](data, ctxFor('en'), {});
    expect((en as any).summary).toBe('Line coverage: 75% (+15 pts)');
    const [fr] = WIDGET_DOCUMENTS['coverage-trend'](data, ctxFor('fr'), {});
    expect((fr as any).summary).toMatch(/^Couverture des lignes/);
  });

  test('names each suite’s share in the report line', async () => {
    const data = await runAnalyticsWidget(db as any, 'coverage-trend', scope({ projects: '2' }));
    const [block] = WIDGET_DOCUMENTS['coverage-trend'](data, ctxFor('en'), {});
    expect((block as any).summary).toBe('Line coverage: 25% · unit-back 20%');
    expect((block as any).series.map((s: any) => s.label)).toEqual(['Line coverage', 'unit-back']);
  });

  test('draws one line per area with split: areas, and leaves the areas out of the suites', async () => {
    const bySuite = (await runAnalyticsWidget(db as any, 'coverage-trend', scope({ projects: '2' }))) as any;
    expect(bySuite.series.map((s: any) => s.name)).toEqual(['unit-back']);
    const byArea = (await runAnalyticsWidget(db as any, 'coverage-trend', scope({ projects: '2' }), 'all', {
      split: 'areas',
    })) as any;
    expect(byArea.split).toBe('areas');
    expect(byArea.series).toMatchObject([{ name: 'front', linePercent: 40 }]);
    expect(byArea.linePercent).toBe(25);
  });
});
