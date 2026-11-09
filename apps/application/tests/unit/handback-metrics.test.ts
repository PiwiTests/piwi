import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { HandbackKind, HandbackOutcome, HandbackSubjectType } from '#shared/handback-outcomes';
import type { AnalyticsHandbacks } from '#shared/analytics/types';
import { migrateToLatest } from './temp-db';

/**
 * The hand-back metrics against a SQLite database: each value from the
 * outcome rows, the same values once retention moved the rows into the daily
 * counters, the sample floor of the rates, the capabilities that hide them,
 * and the lines the Analytics section and the quality reports write.
 */

// The schema barrel picks the PostgreSQL schema at import time when
// PIWI_DATABASE_URL is set, so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;
const { recordOutcome, pruneOutcomesOlderThan } = await import('../../server/utils/outcomes');
const { getAnalyticsContext } = await import('#shared/handlers/analytics/common');
const { computeMetricValues, metricValue, EVALUATED_METRIC_IDS } =
  await import('#shared/handlers/analytics/metric-values');
const { HANDBACK_METRIC_IDS, getAnalyticsHandbacks } = await import('#shared/handlers/analytics/handbacks');
const { collectProjectMetrics } = await import('#shared/handlers/analytics/open-metrics');
const { setInstanceDecisions, setProjectDecisions } = await import('#shared/handlers/capabilities');
const { parseAnalyticsScope } = await import('#shared/analytics/scope');
const { WIDGET_METRIC_IDS } = await import('#shared/analytics/registry');
const { sentencesFor } = await import('#shared/reports/sentences');
const { makeFormatter } = await import('#shared/reports/format');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let tmpDir: string;
let client: ReturnType<typeof createClient>;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const daysAgo = (days: number) => new Date(NOW - days * DAY);
let subjectSeq = 0;

/** Record `n` outcomes of one kind, each on its own subject, `days` ago. */
async function outcomes(
  kind: HandbackKind,
  outcome: HandbackOutcome,
  n: number,
  opts: { days?: number; projectId?: number; subjectType?: HandbackSubjectType } = {},
) {
  for (let i = 0; i < n; i++) {
    await recordOutcome(db as never, {
      projectId: opts.projectId ?? 1,
      kind,
      subjectType: opts.subjectType ?? 'test-case',
      subjectId: ++subjectSeq,
      outcome,
      at: daysAgo(opts.days ?? 3),
    });
  }
}

let clusterSeq = 0;

/** A cluster, optionally fixed `fixedDaysAgo`, with a completed diagnosis rated `feedback`. */
async function diagnosedCluster(opts: { fixedDaysAgo?: number; feedback?: 'up' | 'down' | null; projectId?: number }) {
  const id = ++clusterSeq;
  await db.insert(schema.failureClusters).values({
    id,
    projectId: opts.projectId ?? 1,
    fingerprint: `fp-${id}`,
    signature: `sig-${id}`,
    errorType: 'assertion',
    firstSeenRunId: 1,
    lastSeenRunId: 1,
    fixLandedAt: opts.fixedDaysAgo === undefined ? null : daysAgo(opts.fixedDaysAgo),
  });
  await db.insert(schema.failureDiagnoses).values({
    clusterId: id,
    scope: 'cluster',
    status: 'completed',
    provider: 'openai',
    model: 'm',
    feedback: opts.feedback ?? null,
    createdAt: daysAgo(5),
    updatedAt: daysAgo(5),
  });
}

async function valuesOver(days: number, projectIds?: number[]) {
  const scope = parseAnalyticsScope({ days: String(days), ...(projectIds ? { projects: projectIds.join(',') } : {}) });
  const ctx = await getAnalyticsContext(db as never, scope, 'all');
  const samples = new Map();
  const values = await computeMetricValues(
    db as never,
    ctx,
    [...HANDBACK_METRIC_IDS],
    ctx.period.from.getTime(),
    ctx.period.to.getTime(),
    { cost: null, samples },
  );
  return { values: Object.fromEntries(values), samples: Object.fromEntries(samples) };
}

/** The outcomes behind every metric: rates over enough items to be given. */
async function seedEveryKind() {
  await outcomes('locator-heal', 'suggested', 5);
  await outcomes('locator-heal', 'applied', 3);
  await outcomes('auto-heal-pr', 'applied', 9, { subjectType: 'heal-action' });
  await outcomes('auto-heal-pr', 'rejected', 3, { subjectType: 'heal-action' });
  await outcomes('gate', 'suggested', 4, { subjectType: 'gate-evaluation' });
  await outcomes('gate', 'rejected', 1, { subjectType: 'gate-evaluation' });
  await outcomes('flake-verify', 'verified', 2);
  await outcomes('diagnosis', 'verified', 4, { subjectType: 'cluster' });
  // Ten diagnosed causes fixed in the period, twelve ratings: nine helpful.
  for (let i = 0; i < 12; i++) {
    await diagnosedCluster({ fixedDaysAgo: i < 10 ? 2 : undefined, feedback: i < 9 ? 'up' : 'down' });
  }
}

beforeEach(async () => {
  // A file database: libSQL runs a transaction on its own connection, which an
  // in-memory database does not share.
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-handback-metrics-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  subjectSeq = 0;
  clusterSeq = 0;
  await db.insert(schema.projects).values([
    { id: 1, name: 'shop' },
    { id: 2, name: 'api' },
  ]);
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: daysAgo(40) });
});

afterEach(() => {
  client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('the hand-back metrics', () => {
  test('each metric reads its outcomes, ratings and diagnosed fixes over the period', async () => {
    await seedEveryKind();
    const { values, samples } = await valuesOver(30);
    expect(values).toEqual({
      'heal-adoption': 3,
      'heal-pr-merge-rate': 75,
      'diagnosis-helpful-rate': 75,
      'diagnosis-verified-rate': 40,
      'gate-blocked-merges': 4,
      'gate-overrides': 1,
      'flakes-verified-fixed': 2,
    });
    expect(samples).toEqual({ 'heal-pr-merge-rate': 12, 'diagnosis-helpful-rate': 12, 'diagnosis-verified-rate': 10 });
  });

  test('outcomes outside the period do not count', async () => {
    await outcomes('gate', 'suggested', 2, { days: 3, subjectType: 'gate-evaluation' });
    await outcomes('gate', 'suggested', 5, { days: 45, subjectType: 'gate-evaluation' });
    expect((await valuesOver(30)).values['gate-blocked-merges']).toBe(2);
    expect((await valuesOver(90)).values['gate-blocked-merges']).toBe(7);
  });

  test('the values hold once retention moved the rows into the daily counters', async () => {
    for (const kind of ['locator-heal', 'flake-verify'] as const) {
      await outcomes(kind, kind === 'locator-heal' ? 'applied' : 'verified', 4, { days: 100 });
    }
    await outcomes('auto-heal-pr', 'applied', 8, { days: 100, subjectType: 'heal-action' });
    await outcomes('auto-heal-pr', 'rejected', 2, { days: 100, subjectType: 'heal-action' });
    await outcomes('gate', 'rejected', 3, { days: 100, subjectType: 'gate-evaluation' });
    const before = await valuesOver(365);

    expect(await pruneOutcomesOlderThan(db as never, 30, NOW)).toBe(21);
    expect(await db.select().from(schema.handbackOutcomes)).toHaveLength(0);
    expect((await db.select().from(schema.handbackOutcomeRollups)).length).toBeGreaterThan(0);

    const after = await valuesOver(365);
    expect(after).toEqual(before);
    expect(after.values).toMatchObject({
      'heal-adoption': 4,
      'heal-pr-merge-rate': 80,
      'gate-overrides': 3,
      'flakes-verified-fixed': 4,
    });
  });

  test('a rate under its sample floor is null and carries the size of its sample', async () => {
    await outcomes('auto-heal-pr', 'applied', 2, { subjectType: 'heal-action' });
    await outcomes('auto-heal-pr', 'rejected', 1, { subjectType: 'heal-action' });
    for (let i = 0; i < 3; i++) await diagnosedCluster({ fixedDaysAgo: 2, feedback: 'up' });

    const { values, samples } = await valuesOver(30);
    expect(values['heal-pr-merge-rate']).toBeNull();
    expect(values['diagnosis-helpful-rate']).toBeNull();
    expect(values['diagnosis-verified-rate']).toBeNull();
    expect(samples['heal-pr-merge-rate']).toBe(3);
    expect(metricValue('heal-pr-merge-rate', null, null, null, 3).sample).toEqual({ size: 3, min: 10 });
    // A count has no floor.
    expect(metricValue('heal-adoption', 0, null, null).sample).toBeUndefined();
  });

  test('a project that declined a capability adds nothing to its metrics', async () => {
    await outcomes('flake-verify', 'verified', 2, { projectId: 1 });
    await outcomes('flake-verify', 'verified', 3, { projectId: 2 });
    await outcomes('gate', 'suggested', 1, { projectId: 2, subjectType: 'gate-evaluation' });
    expect((await valuesOver(30)).values['flakes-verified-fixed']).toBe(5);

    await setProjectDecisions(db as never, 2, { 'flake-lab': 'declined' });
    expect((await valuesOver(30)).values['flakes-verified-fixed']).toBe(2);
    expect((await valuesOver(30, [2])).values['flakes-verified-fixed']).toBeNull();
    // The gate follows no capability.
    expect((await valuesOver(30, [2])).values['gate-blocked-merges']).toBe(1);
  });

  test('an instance that declined a capability drops its metrics from the export', async () => {
    await outcomes('auto-heal-pr', 'applied', 10, { subjectType: 'heal-action' });
    const scope = parseAnalyticsScope({ period: 'last-30d' });
    expect((await collectProjectMetrics(db as never, scope, 'all', null)).ids).toContain('heal-pr-merge-rate');

    await setInstanceDecisions(db as never, { 'auto-heal': 'declined' });
    const { ids, samples } = await collectProjectMetrics(db as never, scope, 'all', null);
    expect(ids).not.toContain('heal-pr-merge-rate');
    expect(ids).toContain('gate-blocked-merges');
    expect(samples.every((s) => s.values.get('heal-pr-merge-rate') === undefined)).toBe(true);
    expect((await valuesOver(30)).values['heal-pr-merge-rate']).toBeNull();
  });

  test('every hand-back metric is evaluated and offered to the metric widgets', () => {
    for (const id of HANDBACK_METRIC_IDS) {
      expect(EVALUATED_METRIC_IDS).toContain(id);
      expect(WIDGET_METRIC_IDS).toContain(id);
    }
  });
});

describe('the Hand-back outcomes section', () => {
  test('one count per kind, with the metrics and their change', async () => {
    await seedEveryKind();
    await outcomes('gate', 'regressed', 1, { subjectType: 'gate-evaluation' });
    await outcomes('fix-attempt', 'applied', 2, { subjectType: 'cluster' });
    await outcomes('gate', 'suggested', 2, { days: 45, subjectType: 'gate-evaluation' });

    const data = await getAnalyticsHandbacks(db as never, parseAnalyticsScope({ days: '30' }), 'all');
    expect(data.heals).toEqual({ suggested: 5, adopted: 3, verified: 0 });
    expect(data.healPullRequests).toEqual({ opened: 0, merged: 9, closed: 3, verified: 0 });
    expect(data.diagnoses).toEqual({
      written: 12,
      rated: 12,
      helpful: 9,
      diagnosedFixes: 10,
      verified: 4,
      regressed: 0,
    });
    expect(data.gate).toEqual({ blocked: 4, overrides: 1, escapes: 1 });
    expect(data.flakes).toEqual({ verified: 2, regressed: 0 });
    expect(data.fixAttempts).toEqual({ reported: 2, verified: 0, regressed: 0 });
    expect(data.metrics.find((m) => m.metric === 'gate-blocked-merges')).toMatchObject({ value: 4, previous: 2 });
  });

  test('a kind whose capability every project declined is left out', async () => {
    await outcomes('flake-verify', 'verified', 2);
    await setInstanceDecisions(db as never, { 'flake-lab': 'declined' });
    const data = await getAnalyticsHandbacks(db as never, parseAnalyticsScope({ days: '30' }), 'all');
    expect(data.flakes).toBeNull();
    expect(data.metrics.map((m) => m.metric)).not.toContain('flakes-verified-fixed');
    expect(data.gate).not.toBeNull();
  });
});

describe('the hand-back lines', () => {
  const base: AnalyticsHandbacks = {
    minSample: 10,
    heals: { suggested: 40, adopted: 31, verified: 20 },
    healPullRequests: { opened: 12, merged: 9, closed: 2, verified: 4 },
    diagnoses: { written: 44, rated: 17, helpful: 12, diagnosedFixes: 25, verified: 19, regressed: 1 },
    gate: { blocked: 6, overrides: 1, escapes: 1 },
    flakes: { verified: 5, regressed: 2 },
    fixAttempts: null,
    metrics: [],
  };
  const en = (data: AnalyticsHandbacks) => sentencesFor('en').handbacks(data, makeFormatter('en'));

  test('one labeled line per kind, rates given over enough items', () => {
    expect(en(base)).toEqual([
      {
        label: 'Locator heals',
        text: '31 call sites now use the recommended locator, of 40 suggested · 9 auto-heal pull requests merged, 2 closed (82%).',
      },
      {
        label: 'AI diagnoses',
        text: '44 written · rated helpful 12 of 17 (71%) · the fix touched the diagnosed files in 19 of 25 fixed causes (76%) · 1 failed again after the fix.',
      },
      { label: 'CI gate', text: 'blocked 6 merges · 1 merged anyway, 1 then failed again on the default branch.' },
      { label: 'Flaky tests', text: '5 verified fixed with Flake Lab · 2 flaked again.' },
    ]);
  });

  test('a rate under the floor names the sample as too small', () => {
    const lines = en({ ...base, diagnoses: { ...base.diagnoses!, rated: 4, helpful: 3, diagnosedFixes: 0 } });
    expect(lines.find((l) => l.label === 'AI diagnoses')!.text).toBe(
      '44 written · rated helpful 3 of 4 (too few ratings for a rate, 4 of the 10 needed) · 1 failed again after the fix.',
    );
  });

  test('nothing to say writes no line, and a declined kind none either', () => {
    const quiet: AnalyticsHandbacks = {
      ...base,
      heals: { suggested: 0, adopted: 0, verified: 0 },
      healPullRequests: null,
      diagnoses: null,
      gate: { blocked: 0, overrides: 0, escapes: 0 },
      flakes: null,
    };
    expect(en(quiet)).toEqual([]);
  });

  test('French writes the same lines in French', () => {
    const lines = sentencesFor('fr').handbacks(base, makeFormatter('fr'));
    expect(lines.map((l) => l.label)).toEqual([
      'Réparations de localisateurs',
      'Diagnostics IA',
      'Barrière de CI',
      'Tests instables',
    ]);
    expect(lines[2]!.text).toBe(
      '6 fusions bloquées · 1 fusionnée malgré tout, 1 a ensuite échoué sur la branche par défaut.',
    );
  });
});
