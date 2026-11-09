import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient, type Client } from '@libsql/client';
import { and, eq, isNotNull } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import {
  WEB_DASHBOARD_PROJECT_ID,
  WEB_DASHBOARD_UNTRUSTED_TESTS,
  expectedWebDashboardGaps,
} from '#shared/demo/demo-test-map.mjs';

const { computeScenarioGaps } = await import('../../shared/handlers/scenario-gaps');
const { getDemoSourceAtBlob } = await import('../../app/demo/demo-scm');
/** The demo's sources, as its recompute reads them for *error path never executed*. */
const readSource = async (path: string, blob: string) =>
  (await getDemoSourceAtBlob(WEB_DASHBOARD_PROJECT_ID, path, blob))?.content ?? null;
const { backfillUnindexedProjects } = await import('../../server/utils/locator-usages');
const { getMapHealth } = await import('../../shared/handlers/map-health');

/**
 * The web-dashboard Test Map in the demo seed is what the live detectors find in
 * its graph: recomputing the project's gaps on the seeded database, as the demo's
 * Recompute button does, adds no gap, closes none and rewrites none. The
 * locator index is built from the seeded runs first, as the server and the demo
 * build it when their database opens, so control reach is part of the recompute,
 * and the control reach and feature groups it writes are the seeded ones.
 *
 * The model also labels its ground truth (`expectedWebDashboardGaps`), and the
 * benchmark scores each detector's precision and recall against it, on a copy of
 * the seed whose gap ledger is emptied first, so a verdict that keeps a row open
 * scores nothing. A score that changes fails until
 * `shared/demo/demo-test-map-benchmark.json` records it, and a lower one is
 * named.
 *
 * After a change to the model or to a detector, `PIWI_UPDATE_DEMO_TEST_MAP=1`
 * rewrites `shared/demo/demo-test-map-gaps.json` and the benchmark from the
 * recompute; regenerate the seed (`npm run app:seed:demo`) and run the test again.
 */

const rootDir = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
let outDir: string;
let client: Client;
let db: ReturnType<typeof drizzle<typeof schema>>;

type GapRow = typeof schema.scenarioGaps.$inferSelect;
let seededEdges: Awaited<ReturnType<typeof derivedEdges>>;

function shape(rows: GapRow[]) {
  return rows
    .map((r) => ({
      detector: r.detector,
      key: r.key,
      class: r.class,
      title: r.title,
      evidence: r.evidence,
      score: r.score,
      status: r.status,
    }))
    .sort((a, b) => `${a.detector} ${a.key}`.localeCompare(`${b.detector} ${b.key}`));
}

/** One detector's score on the benchmark: what it raised against what the ground truth expects. */
interface Score {
  precision: number;
  recall: number;
  raised: number;
  expected: number;
  found: number;
  /** Expected gaps it did not raise. */
  missed: string[];
  /** Gaps it raised that the truth does not hold. */
  wrong: string[];
}

const BENCHMARK_FILE = join(rootDir, 'shared/demo/demo-test-map-benchmark.json');
const ratio = (n: number, d: number) => (d === 0 ? 1 : Math.round((n / d) * 1000) / 1000);

/**
 * Precision and recall per benchmarked detector, from the gaps a recompute raised
 * on an empty ledger. The ground truth names a test by its title, so a gap keyed
 * by test id is read by its title.
 */
function benchmark(rows: GapRow[], titles: Map<number, string>): Record<string, Score> {
  const out: Record<string, Score> = {};
  const byTitle = (key: string) =>
    key.replace(/^test:(\d+)$/, (_, id: string) => `test:${titles.get(Number(id)) ?? id}`);
  for (const [detector, keys] of Object.entries(expectedWebDashboardGaps()).sort(([a], [b]) => a.localeCompare(b))) {
    const want = new Set(keys);
    const raised = new Set(
      rows.filter((r) => r.detector === detector && r.status !== 'closed').map((r) => byTitle(r.key)),
    );
    const found = [...raised].filter((k) => want.has(k)).length;
    out[detector] = {
      precision: ratio(found, raised.size),
      recall: ratio(found, want.size),
      raised: raised.size,
      expected: want.size,
      found,
      missed: [...want].filter((k) => !raised.has(k)).sort(),
      wrong: [...raised].filter((k) => !want.has(k)).sort(),
    };
  }
  return out;
}

/** The edges the recompute writes besides gaps: locator reach to controls and links, and feature groups. */
async function derivedEdges(on = db) {
  const rows = await on
    .select()
    .from(schema.graphEdges)
    .where(eq(schema.graphEdges.projectId, WEB_DASHBOARD_PROJECT_ID));
  return rows
    .filter(
      (r) =>
        (r.kind === 'reaches' && (r.toKind === 'control' || r.toKind === 'link')) ||
        (r.kind === 'groups' && r.fromKind === 'feature'),
    )
    .map((r) => ({
      edge: `${r.fromKind}:${r.fromKey} ${r.kind} ${r.toKind}:${r.toKey}`,
      origin: r.origin,
      confidence: r.confidence,
      evidence: r.evidence,
    }))
    .sort((a, b) => a.edge.localeCompare(b.edge));
}

async function projectGaps(): Promise<GapRow[]> {
  return db
    .select()
    .from(schema.scenarioGaps)
    .where(and(eq(schema.scenarioGaps.projectId, WEB_DASHBOARD_PROJECT_ID), eq(schema.scenarioGaps.kind, 'gap')));
}

/** Rewrite the detected-gaps fixture from the gaps the recompute left in the ledger. */
async function writeLedger(rows: GapRow[]): Promise<void> {
  const titles = new Map(
    (
      await db
        .select({ id: schema.testCases.id, title: schema.testCases.title })
        .from(schema.testCases)
        .where(eq(schema.testCases.projectId, WEB_DASHBOARD_PROJECT_ID))
    ).map((t) => [t.id, t.title]),
  );
  const detected = rows
    .filter((r) => r.status !== 'closed')
    .map((r) => ({
      detector: r.detector,
      class: r.class,
      key: r.key,
      title: r.title,
      evidence: r.evidence,
      factors: r.factors,
      score: r.score,
      test: r.testCaseId != null ? (titles.get(r.testCaseId) ?? null) : null,
    }))
    .sort((a, b) => `${a.detector} ${a.key}`.localeCompare(`${b.detector} ${b.key}`));
  writeFileSync(join(rootDir, 'shared/demo/demo-test-map-gaps.json'), `${JSON.stringify(detected, null, 2)}\n`);
}

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'piwi-demo-test-map-'));
  execFileSync('node', ['scripts/generate-demo-seed.mjs'], {
    cwd: rootDir,
    stdio: 'ignore',
    env: { ...process.env, PIWI_DEMO_SEED_OUTPUT_DIR: outDir },
  });
  client = createClient({ url: ':memory:' });
  await client.executeMultiple(readFileSync(join(outDir, 'seed.sql'), 'utf-8'));
  db = drizzle(client, { schema });
  await backfillUnindexedProjects(db as never);
  seededEdges = await derivedEdges();
}, 120_000);

afterAll(() => {
  client?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe('the web-dashboard Test Map', () => {
  test('recomputing its gaps leaves the seeded ledger as it is', async () => {
    const seeded = shape(await projectGaps());
    await computeScenarioGaps(db as never, WEB_DASHBOARD_PROJECT_ID, { readSource });
    const after = await projectGaps();
    if (process.env.PIWI_UPDATE_DEMO_TEST_MAP) await writeLedger(after);
    expect(shape(after)).toEqual(seeded);
  });

  test('no detector scores below the benchmark on the ground truth', async () => {
    // A copy of the seed with no gap ledger, so only what the detectors raise is scored.
    const benchClient = createClient({ url: ':memory:' });
    await benchClient.executeMultiple(readFileSync(join(outDir, 'seed.sql'), 'utf-8'));
    const benchDb = drizzle(benchClient, { schema });
    await backfillUnindexedProjects(benchDb as never);
    await benchDb.delete(schema.scenarioGaps).where(eq(schema.scenarioGaps.projectId, WEB_DASHBOARD_PROJECT_ID));
    await computeScenarioGaps(benchDb as never, WEB_DASHBOARD_PROJECT_ID);
    const tests = await benchDb
      .select({ id: schema.testCases.id, title: schema.testCases.title })
      .from(schema.testCases)
      .where(eq(schema.testCases.projectId, WEB_DASHBOARD_PROJECT_ID));
    const scores = benchmark(
      await benchDb
        .select()
        .from(schema.scenarioGaps)
        .where(and(eq(schema.scenarioGaps.projectId, WEB_DASHBOARD_PROJECT_ID), eq(schema.scenarioGaps.kind, 'gap'))),
      new Map(tests.map((t) => [t.id, t.title])),
    );
    benchClient.close();
    if (process.env.PIWI_UPDATE_DEMO_TEST_MAP) writeFileSync(BENCHMARK_FILE, `${JSON.stringify(scores, null, 2)}\n`);
    const baseline = JSON.parse(readFileSync(BENCHMARK_FILE, 'utf-8')) as Record<string, Score>;
    const drops = Object.entries(baseline).flatMap(([detector, was]) => {
      const now = scores[detector];
      return (['precision', 'recall'] as const)
        .filter((measure) => (now?.[measure] ?? 0) < was[measure])
        .map((measure) => `${detector} ${measure}: ${was[measure]} → ${now?.[measure] ?? 'none'}`);
    });
    expect(drops).toEqual([]);
    expect(scores).toEqual(baseline);
  }, 60_000);

  test('the ground truth calls untrusted exactly the tests the seed makes flaky', async () => {
    const flaky = await db
      .select({ title: schema.testCases.title })
      .from(schema.testCases)
      .where(and(eq(schema.testCases.projectId, WEB_DASHBOARD_PROJECT_ID), isNotNull(schema.testCases.flakyRootCause)));
    expect(flaky.map((t) => t.title).sort()).toEqual([...WEB_DASHBOARD_UNTRUSTED_TESTS].sort());
  });

  test('recomputing writes the control reach and the feature groups the seed already holds', async () => {
    expect(seededEdges.some((e) => e.edge.includes(' reaches control:'))).toBe(true);
    await computeScenarioGaps(db as never, WEB_DASHBOARD_PROJECT_ID);
    expect(await derivedEdges()).toEqual(seededEdges);
  });

  test('map health counts every input the demo sends, probes the one short', async () => {
    const rows = await getMapHealth(db as never, WEB_DASHBOARD_PROJECT_ID);
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.have, r.of]]))).toEqual({
      inventory: [7, 7],
      'locator-pages': [10, 10],
      handlers: [16, 16],
      probes: [7, 16],
      declared: [10, null],
      changes: [7, null],
      catalog: [8, null],
    });
  });
});
