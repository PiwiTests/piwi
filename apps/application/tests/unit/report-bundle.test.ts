import { beforeAll, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

delete process.env.PIWI_DATABASE_URL;
delete process.env.PIWI_CI_MINUTE_COST;
const { collectReportBundle } = await import('../../shared/reports/collect');
const { parseReportRequest, ReportRequestError } = await import('../../shared/reports/request');
const { backfillDailyRollups } = await import('../../shared/handlers/analytics/rollups');
const { parseAnalyticsScope } = await import('../../shared/analytics/scope');
const { saveCiCost } = await import('../../shared/handlers/ci-cost');
const { reportWidgets } = await import('../../shared/reports/types');

const DAY_MS = 24 * 60 * 60 * 1000;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values([
    { id: 1, name: 'checkout' },
    { id: 2, name: 'search' },
  ]);
  const run = (projectId: number, daysAgo: number, passed: number, status = 'passed') =>
    db.insert(schema.testRuns).values({
      projectId,
      status,
      startTime: new Date(Date.now() - daysAgo * DAY_MS),
      duration: 60_000,
      totalTests: 10,
      passedTests: passed,
      failedTests: 10 - passed,
      isFullRun: 1,
    });
  await run(1, 40, 10);
  await run(1, 5, 8, 'failed');
  await run(2, 3, 10);
  await backfillDailyRollups(db as any);
});

describe('collectReportBundle', () => {
  test('the executive report: a verdict, the tiles, the trend, and a footer', async () => {
    const bundle = await collectReportBundle(db as any, { dashboard: 'executive', scope: parseAnalyticsScope({}) });
    expect(bundle.dashboard).toEqual({ ref: 'executive', name: 'Executive' });
    expect(bundle.language).toBe('en');
    expect(bundle.title).toBe('All projects, Last 30 days');
    expect(bundle.verdict.sentence).toContain('90%');
    const types = reportWidgets(bundle).map((w) => w.type);
    expect(types).toEqual(['verdict', 'stats', 'metric', 'insights', 'progress', 'risks']);
    const tiles = reportWidgets(bundle)[1]!.blocks[0]!;
    expect(tiles.kind).toBe('stats');
    expect(bundle.definitions.map((d) => d.id)).toContain('test-pass-rate');
    expect(bundle.limits).toContain('Days are UTC.');
    expect(bundle.sourceUrl).toBeNull();
  });

  test('a project scope names the project and links back when a base URL is given', async () => {
    const bundle = await collectReportBundle(db as any, {
      dashboard: 'engineering',
      scope: parseAnalyticsScope({ projects: '1' }),
      baseUrl: 'https://piwi.example/',
    });
    expect(bundle.scopeText.projects).toBe('checkout');
    expect(bundle.title.startsWith('checkout, ')).toBe(true);
    expect(bundle.sourceUrl).toBe('https://piwi.example/analytics?period=last-30d&projects=1');
    expect(reportWidgets(bundle).map((w) => w.type)).toContain('flaky-leaderboard');
  });

  test('project access narrows the report', async () => {
    const bundle = await collectReportBundle(db as any, {
      dashboard: 'executive',
      scope: parseAnalyticsScope({}),
      access: new Set([2]),
    });
    expect(bundle.scopeText.projects).toBe('search');
  });

  test('a French report translates the labels and formats numbers the French way', async () => {
    const bundle = await collectReportBundle(db as any, { dashboard: 'executive', language: 'fr' });
    expect(bundle.language).toBe('fr');
    expect(bundle.bands[0]!.title).toBe('Où en sont les choses');
    expect(bundle.title.startsWith('Tous les projets, du ')).toBe(true);
    expect(bundle.verdict.sentence).toContain('90\u202f%');
    // A built-in dashboard is named in French, and a period by its dates.
    expect(bundle.dashboard.name).toBe('Direction');
    expect(bundle.period.label.startsWith('Du ')).toBe(true);
    expect(bundle.comparison?.label.startsWith('la période du ')).toBe(true);
  });

  test('a date range titles the report with its dates, as each language writes them', async () => {
    const scope = parseAnalyticsScope({ period: '2026-08-01..2026-08-31' });
    const en = await collectReportBundle(db as any, { dashboard: 'executive', scope });
    expect(en.title).toBe('All projects, Aug 1, 2026 to Aug 31, 2026');
    const fr = await collectReportBundle(db as any, { dashboard: 'executive', scope, language: 'fr' });
    expect(fr.title).toBe('Tous les projets, du 1er août 2026 au 31 août 2026');
  });

  test('a French report says which widgets ignore the test filter', async () => {
    const bundle = await collectReportBundle(db as any, {
      dashboard: 'executive',
      language: 'fr',
      scope: parseAnalyticsScope({ owner: '@checkout-team' }),
    });
    const notes = bundle.bands.flatMap((b) => b.widgets.flatMap((w) => w.notes));
    expect(notes).toContain('«\u202fRisques\u202f» ne tient pas compte du filtre de tests.');
  });

  test('with a cost of a CI minute, wasted minutes carry their cost', async () => {
    await saveCiCost(db as any, { cost: { amount: 0.5, currency: 'EUR' } });
    const bundle = await collectReportBundle(db as any, { dashboard: 'executive' });
    const stats = reportWidgets(bundle).find((w) => w.type === 'stats')!.blocks[0]!;
    if (stats.kind !== 'stats') throw new Error('stats block expected');
    expect(stats.tiles.find((t) => t.label === 'Wasted CI minutes')?.note).toMatch(/€/);
    await saveCiCost(db as any, { cost: null });
  });
});

describe('parseReportRequest', () => {
  test('defaults to the executive dashboard as JSON', () => {
    expect(parseReportRequest({})).toMatchObject({ dashboard: 'executive', format: 'json' });
    expect(
      parseReportRequest({ dashboard: 'engineering', format: 'PDF', lang: 'fr', period: 'last-7d' }),
    ).toMatchObject({
      dashboard: 'engineering',
      format: 'pdf',
      language: 'fr',
      scope: { period: { kind: 'rolling', days: 7 } },
    });
  });

  test('refuses an unknown dashboard, format or language', () => {
    expect(() => parseReportRequest({ dashboard: 'nope' })).toThrow(ReportRequestError);
    expect(() => parseReportRequest({ format: 'docx' })).toThrow(ReportRequestError);
    expect(() => parseReportRequest({ lang: 'de' })).toThrow(ReportRequestError);
  });
});
