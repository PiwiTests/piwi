import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import * as sqliteSchema from '../../server/database/schema.sqlite';
// @ts-expect-error — plain ESM modules of the performance suite, without type declarations
import { datasetBatches } from '../../scripts/perf/lib/dataset.mjs';
// @ts-expect-error — see above
import { SQLITE_MS_TIMESTAMP_COLUMNS } from '../../scripts/perf/lib/seed-writer.mjs';
// @ts-expect-error — see above
import { mannWhitneyP, median, mode, quantile } from '../../scripts/perf/lib/stats.mjs';
// @ts-expect-error — see above
import { compareMetric, compareResults, sqlDiff } from '../../scripts/perf/lib/compare.mjs';
// @ts-expect-error — see above
import { COMMENT_MARKER, renderComparison } from '../../scripts/perf/lib/markdown.mjs';
// @ts-expect-error — see above
import { startOtlpReceiver, traceIdFromServerTiming } from '../../scripts/perf/lib/otlp-receiver.mjs';
// @ts-expect-error — see above
import { pageScenarios, shardPages } from '../../scripts/perf/lib/scenarios.mjs';
// @ts-expect-error — see above
import { mergeResults } from '../../scripts/perf/lib/merge.mjs';
// @ts-expect-error — see above
import { statementDelta } from '../../scripts/perf/lib/pg.mjs';

type Batch = { table: string; rows: Record<string, unknown>[] } | { manifest: { counts: Record<string, number> } };

const NOW = new Date('2026-10-06T12:00:00Z');
const collect = (): Batch[] => [...datasetBatches({ scale: 'small', now: NOW })];

describe('performance dataset', () => {
  it('is identical for the same scale and anchor', () => {
    expect(JSON.stringify(collect())).toBe(JSON.stringify(collect()));
  });

  it('yields every parent row before a child references it', () => {
    const seen = new Map<string, Set<number>>();
    const refs: Array<[string, string, string]> = [
      ['test_runs', 'project_id', 'projects'],
      ['test_cases', 'suite_id', 'test_suites'],
      ['test_runs_cases', 'test_run_id', 'test_runs'],
      ['test_runs_cases', 'test_case_id', 'test_cases'],
      ['test_runs_cases', 'failure_cluster_id', 'failure_clusters'],
      ['test_runs_cases', 'aria_snapshot_payload_id', 'case_payloads'],
      ['network_requests', 'test_runs_case_id', 'test_runs_cases'],
      ['files', 'test_run_id', 'test_runs'],
      ['markers', 'run_id', 'test_runs'],
      ['quarantined_tests', 'test_case_id', 'test_cases'],
    ];
    for (const batch of collect()) {
      if (!('table' in batch)) continue;
      for (const row of batch.rows) {
        for (const [table, column, parent] of refs) {
          if (table !== batch.table || row[column] == null) continue;
          expect(seen.get(parent)?.has(row[column] as number), `${table}.${column} → ${parent}`).toBe(true);
        }
        if (typeof row.id === 'number') {
          if (!seen.has(batch.table)) seen.set(batch.table, new Set());
          seen.get(batch.table)!.add(row.id);
        }
      }
    }
  });

  it('fills only columns the schema has, with the timestamp unit the schema declares', () => {
    const tables = new Map(
      Object.values(sqliteSchema)
        .filter((t) => typeof t === 'object' && t !== null && Symbol.for('drizzle:IsDrizzleTable') in t)
        .map((t) => {
          const config = getTableConfig(t as Parameters<typeof getTableConfig>[0]);
          return [config.name, new Map(config.columns.map((c) => [c.name, c]))] as const;
        }),
    );
    for (const batch of collect()) {
      if (!('table' in batch)) continue;
      const columns = tables.get(batch.table);
      expect(columns, batch.table).toBeDefined();
      for (const [name, value] of Object.entries(batch.rows[0]!)) {
        const column = columns!.get(name) as { mode?: string } | undefined;
        expect(column, `${batch.table}.${name}`).toBeDefined();
        if (value instanceof Date) {
          const expected = SQLITE_MS_TIMESTAMP_COLUMNS.has(`${batch.table}.${name}`) ? 'timestamp_ms' : 'timestamp';
          expect(column!.mode, `${batch.table}.${name}`).toBe(expected);
        }
      }
    }
  });

  it('counts what it yields and opens a run of the large project', () => {
    const batches = collect();
    const { manifest } = batches.at(-1) as {
      manifest: { counts: Record<string, number>; runId: number; projectId: number };
    };
    const runs = batches
      .filter((b) => 'table' in b && b.table === 'test_runs')
      .flatMap((b) => ('rows' in b ? b.rows : []));
    expect(manifest.counts.test_runs).toBe(runs.length);
    expect(runs.find((r) => r.id === manifest.runId)?.project_id).toBe(manifest.projectId);
  });
});

describe('performance statistics', () => {
  it('reads central values', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(mode([163, 163, 164, 163])).toBe(163);
  });

  it('tells two overlapping sets apart only when they really differ', () => {
    const a = [100, 102, 99, 101, 98, 103, 100, 101, 99, 102];
    expect(
      mannWhitneyP(
        a,
        a.map((v) => v + 1),
      ),
    ).toBeGreaterThan(0.05);
    expect(
      mannWhitneyP(
        a,
        a.map((v) => v + 40),
      ),
    ).toBeLessThan(0.001);
    expect(mannWhitneyP([1, 2], [3, 4])).toBe(1);
  });
});

describe('performance verdicts', () => {
  const slow = [130, 128, 135, 131, 129, 133, 132, 130, 134, 131];
  const fast = [100, 102, 99, 101, 98, 103, 100, 101, 99, 102];

  it('flags a slower median past both floors as a regression', () => {
    expect(compareMetric('ssrMs', fast, slow).verdict).toBe('regression');
    expect(compareMetric('ssrMs', slow, fast).verdict).toBe('improvement');
  });

  it('ignores a change under the absolute floor', () => {
    expect(
      compareMetric(
        'ssrMs',
        fast,
        fast.map((v) => v + 5),
      ).verdict,
    ).toBe('unchanged');
  });

  it('compares counts without a significance test', () => {
    expect(compareMetric('ssrStatements', [26, 26], [163, 163]).verdict).toBe('regression');
    expect(compareMetric('ssrStatements', [163], [164]).verdict).toBe('unchanged');
    expect(compareMetric('ssrStatements', [], [12]).verdict).toBe('missing');
  });

  it('lists the statements whose counts changed, largest change first', () => {
    const diff = sqlDiff(
      {
        queries: [
          { query: 'select a', calls: 12, ms: 1 },
          { query: 'select b', calls: 1, ms: 1 },
        ],
      },
      {
        queries: [
          { query: 'select b', calls: 1, ms: 1 },
          { query: 'select c', calls: 2, ms: 1 },
        ],
      },
    );
    expect(diff.map((d: { query: string }) => d.query)).toEqual(['select a', 'select c']);
  });

  it('counts a query read with lists of different lengths as one statement', () => {
    const diff = sqlDiff(
      { queries: [{ query: 'select x from t where id in ($1, $2)', calls: 3, ms: 1 }] },
      { queries: [{ query: 'select x from t where id in ($1, $2, $3)', calls: 1, ms: 1 }] },
    );
    expect(diff).toEqual([{ query: 'select x from t where id in (…)', base: 3, head: 1, baseMs: 1, headMs: 1 }]);
  });
});

describe('performance report', () => {
  const results = (base: number[], head: number[]) => ({
    pages: [
      {
        id: 'project-runs',
        label: 'Project › Runs',
        path: '/projects/1',
        targets: {
          base: {
            ssr: {
              ms: base,
              statements: [163],
              bytes: [1_800_000],
              status: 200,
              sql: { statements: 163, queries: [{ query: 'select "id" from "projects"', calls: 163, ms: 4 }] },
            },
            load: {},
          },
          head: {
            ssr: {
              ms: head,
              statements: [24],
              bytes: [400_000],
              status: 200,
              sql: { statements: 24, queries: [{ query: 'select "id" from "projects"', calls: 24, ms: 1 }] },
            },
            load: {},
          },
        },
      },
    ],
    apis: [
      {
        path: '/api/capabilities',
        targets: { base: { ms: [10, 11, 10], statements: [27] }, head: { ms: [2, 2, 3], statements: [0] } },
      },
    ],
  });
  const meta = {
    database: 'postgres',
    databaseVersion: '16.4',
    scale: 'large',
    dataset: { test_runs: 2160, test_runs_cases: 474922 },
    samples: { warmup: 2, ssr: 12, load: 4, api: 8 },
  };

  it('leads with the verdict and spells out each regression', () => {
    const md = renderComparison(
      meta,
      compareResults(
        results([100, 101, 99, 100, 102, 98, 101, 100], [200, 198, 205, 201, 199, 202, 197, 203]),
        'base',
        'head',
      ),
    );
    expect(md.startsWith(COMMENT_MARKER)).toBe(true);
    expect(md).toContain('**1 regression**');
    expect(md).toContain('### Regressions');
    expect(md).toContain('Project › Runs');
    expect(md).toContain('163 → 24');
  });

  it('stays under the size GitHub accepts for a comment', () => {
    const big = results([100, 101, 99], [100, 101, 99]);
    const queries = Array.from({ length: 400 }, (_, i) => ({
      query: `select ${'x'.repeat(300)} ${i}`,
      calls: i + 1,
      ms: 1,
    }));
    big.pages = Array.from({ length: 60 }, (_, i) => ({
      ...big.pages[0]!,
      id: `p${i}`,
      targets: {
        base: {
          ...big.pages[0]!.targets.base,
          ssr: { ...big.pages[0]!.targets.base.ssr, sql: { statements: 400, queries } },
        },
        head: {
          ...big.pages[0]!.targets.head,
          ssr: { ...big.pages[0]!.targets.head.ssr, sql: { statements: 1, queries: [] } },
        },
      },
    }));
    expect(renderComparison(meta, compareResults(big, 'base', 'head')).length).toBeLessThan(65_536);
  });
});

describe('performance trace receiver', () => {
  it('reads the trace a response names', () => {
    expect(traceIdFromServerTiming('traceparent;desc="00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"')).toBe(
      '0af7651916cd43dd8448eb211c80319c',
    );
    expect(traceIdFromServerTiming('db;dur=3')).toBeNull();
  });

  it('groups a request’s statements and the requests it made to itself', async () => {
    const receiver = await startOtlpReceiver();
    const span = (spanId: string, parentSpanId: string, name: string, kind: number, statement?: string) => ({
      traceId: 't1',
      spanId,
      parentSpanId,
      name,
      kind,
      startTimeUnixNano: '1000000',
      endTimeUnixNano: '3000000',
      attributes: statement ? [{ key: 'db.statement', value: { stringValue: statement } }] : [],
    });
    const res = await fetch(receiver.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  span('a', '', 'GET /projects/1', 2),
                  span('b', 'a', 'GET /api/capabilities', 1),
                  span('c', 'b', 'drizzle.select', 3, 'select 1'),
                  span('d', 'b', 'drizzle.select', 3, 'select 1'),
                  span('e', 'a', 'drizzle.select', 3, 'select 2'),
                ],
              },
            ],
          },
        ],
      }),
    });
    expect(res.ok).toBe(true);
    const sql = receiver.requestSql('t1');
    await receiver.close();
    expect(sql.statements).toBe(3);
    expect(sql.queries[0]).toMatchObject({ query: 'select 1', calls: 2 });
    expect(sql.nested).toEqual([{ request: 'GET /api/capabilities', statements: 2 }]);
  });
});

describe('performance suite split across machines', () => {
  const pages = pageScenarios({ projectId: 1, runId: 2, executionId: 3 }) as Array<{ id: string }>;

  it('gives each shard a contiguous run of the pages, every page once', () => {
    for (const total of [1, 2, 3, 5]) {
      const shards = Array.from({ length: total }, (_, i) => shardPages(pages, { index: i + 1, total }));
      expect(shards.flat()).toEqual(pages);
      const sizes = shards.map((s: unknown[]) => s.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });

  const shard = (index: number, total: number, pageIds: string[], apis: Array<[string, string[]]>) => ({
    version: 1,
    meta: {
      startedAt: `2026-10-21T10:0${index}:00.000Z`,
      finishedAt: `2026-10-21T10:1${index}:00.000Z`,
      scale: 'large',
      shard: { index, total },
      machine: { cpus: 4, cpuModel: `CPU ${index}`, node: 'v24' },
      targets: [{ name: 'base' }, { name: 'head' }],
    },
    pages: pageIds.map((id) => ({ id, label: id, path: `/${id}`, targets: {} })),
    apis: apis.map(([path, calledBy]) => ({
      path,
      calledBy,
      targets: { base: { ms: [index], calledBy }, head: { ms: [index], calledBy } },
    })),
  });

  it('joins the shards in page order, keeping an API call from the first shard that measured it', () => {
    const merged = mergeResults([
      shard(
        2,
        2,
        ['c', 'd'],
        [
          ['/api/me', ['c']],
          ['/api/runs', ['d']],
        ],
      ),
      shard(
        1,
        2,
        ['a', 'b'],
        [
          ['/api/me', ['a', 'b']],
          ['/api/projects', ['a']],
        ],
      ),
    ]);
    expect(merged.pages.map((p: { id: string }) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(merged.apis.map((a: { path: string }) => a.path)).toEqual(['/api/me', '/api/projects', '/api/runs']);
    const me = merged.apis[0];
    expect(me.targets.base.ms).toEqual([1]);
    expect(me.calledBy).toEqual(['a', 'b', 'c']);
    expect(me.targets.head.calledBy).toEqual(['a', 'b', 'c']);
    expect(merged.meta.startedAt).toBe('2026-10-21T10:01:00.000Z');
    expect(merged.meta.finishedAt).toBe('2026-10-21T10:12:00.000Z');
    expect(merged.meta.shards.map((s: { pages: string[] }) => s.pages)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('refuses a run with a shard missing', () => {
    expect(() => mergeResults([shard(1, 3, ['a'], []), shard(3, 3, ['c'], [])])).toThrow(/shards 1 to 3/);
  });

  it('names the machine of each shard in the report', () => {
    const merged = mergeResults([shard(1, 2, ['a', 'b'], []), shard(2, 2, ['c'], [])]);
    const md = renderComparison(
      { ...merged.meta, samples: { warmup: 2, ssr: 12, load: 6, api: 8 }, database: 'postgres' },
      compareResults(merged, 'base', 'head'),
    );
    expect(md).toContain('split across 2 machines');
    expect(md).toContain('Machines: pages 1–2 on 4 × CPU 1, Node v24; page 3 on 4 × CPU 2, Node v24.');
  });
});

describe('performance SQL counts', () => {
  it('names each statement by its query id until its text is read', () => {
    const before = new Map([['7', { calls: 2, exec_ms: 1, rows: 2, blocks: 4 }]]);
    const after = new Map([
      ['7', { calls: 5, exec_ms: 4, rows: 5, blocks: 10 }],
      ['9', { calls: 1, exec_ms: 1, rows: 1, blocks: 1 }],
    ]);
    expect(statementDelta(before, after)).toEqual({
      statements: 4,
      ms: 4,
      rows: 4,
      blocks: 7,
      queries: [
        { id: '7', calls: 3, ms: 3, rows: 3, blocks: 6 },
        { id: '9', calls: 1, ms: 1, rows: 1, blocks: 1 },
      ],
    });
  });
});
