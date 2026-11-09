/**
 * Where a gap meets the code: the files behind a gap (its own file or handler,
 * or the handlers serving its route), their coverage at a commit, and the open
 * gaps each entry of the coverage tree counts.
 */
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { configureSqliteConnections, sqliteClientConfig } from '../../server/database/sqlite-connections';
import { migrateToLatest } from './temp-db';

vi.mock('../../server/storage', () => ({
  getStorage: () => ({
    async deleteFile() {},
    async deleteDirectory() {},
  }),
}));

delete process.env.PIWI_DATABASE_URL;
const { parseCoverageReportUpload, storeCoverageReport } = await import('../../server/utils/coverage-reports');
const { getCoverageTree, getGapCode, invalidateCommitCoverage } = await import('../../server/utils/coverage-summary');
const { coveragePathOf } = await import('../../server/utils/gap-code');
const { parseGapIds } = await import('../../shared/gap-ids');

const COMMIT = '1'.repeat(40);
const tmpDir = mkdtempSync(join(tmpdir(), 'piwi-gap-code-'));
let dbCount = 0;
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

let db: ReturnType<typeof drizzle<typeof schema>>;
let ids: Record<string, number>;
beforeEach(async () => {
  const client = createClient(sqliteClientConfig(`file:${join(tmpDir, `test-${++dbCount}.db`)}`));
  await configureSqliteConnections(client);
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  await db.insert(schema.projects).values({ id: 1, name: 'shop', defaultBranch: 'main' });

  const parsed = parseCoverageReportUpload({
    v: 1,
    commit: COMMIT,
    suite: 'unit-back',
    branch: 'main',
    files: [
      { path: 'apps/web/server/api/orders.post.ts', blob: 'a'.repeat(40), executable: [[1, 10]], lines: [[1, 4]] },
      { path: 'src/cart.ts', blob: 'b'.repeat(40), executable: [[1, 4]], lines: [[1, 4]] },
    ],
  });
  if (typeof parsed === 'string') throw new Error(parsed);
  await storeCoverageReport(db as never, 1, parsed);
  invalidateCommitCoverage(1, COMMIT);

  // The route's handler is recorded relative to the server's folder.
  await db.insert(schema.graphEdges).values({
    projectId: 1,
    fromKind: 'route',
    fromKey: 'POST /api/orders',
    toKind: 'handler',
    toKey: 'server/api/orders.post.ts',
    kind: 'handled-by',
    lastSeenAt: new Date(),
  });
  const gap = (detector: string, key: string, status = 'open') => ({
    projectId: 1,
    detector,
    class: 'blind-spot',
    key,
    title: key,
    status,
  });
  const rows = await db
    .insert(schema.scenarioGaps)
    .values([
      gap('success-only', 'POST /api/orders'),
      gap('changed-unreached', 'src/cart.ts'),
      gap('reachable-unvisited', 'page:/checkout'),
      gap('declared-never-hit', 'route:POST /api/orders', 'dismissed'),
    ])
    .returning({ id: schema.scenarioGaps.id, key: schema.scenarioGaps.key });
  ids = Object.fromEntries(rows.map((r) => [r.key, r.id]));
});

describe('getGapCode', () => {
  test('names the files behind each gap, with their lines at the commit', async () => {
    const code = await getGapCode(
      db as never,
      1,
      [ids['POST /api/orders']!, ids['src/cart.ts']!, ids['page:/checkout']!],
      { commit: null, branch: null },
    );
    expect(code?.commit).toBe(COMMIT);
    expect(code?.gaps).toEqual([
      {
        id: ids['POST /api/orders'],
        files: [{ path: 'apps/web/server/api/orders.post.ts', executableLines: 10, executedLines: 4, unrunLines: 6 }],
      },
      { id: ids['src/cart.ts'], files: [{ path: 'src/cart.ts', executableLines: 4, executedLines: 4, unrunLines: 0 }] },
    ]);
  });
});

describe('getCoverageTree', () => {
  test('counts the open gaps on each entry’s files', async () => {
    const root = await getCoverageTree(db as never, 1, { commit: null, branch: null, folder: '' });
    if (!root || 'gone' in root) throw new Error('no tree');
    expect(root.entries.map((e) => [e.path, e.openGaps])).toEqual([
      ['apps', 1],
      ['src', 1],
    ]);
    const src = await getCoverageTree(db as never, 1, { commit: null, branch: null, folder: 'src' });
    if (!src || 'gone' in src) throw new Error('no tree');
    expect(src.entries.map((e) => [e.path, e.openGaps])).toEqual([['src/cart.ts', 1]]);
  });
});

describe('coveragePathOf and parseGapIds', () => {
  test('a gap file matches one path by suffix, and none when two do', () => {
    expect(coveragePathOf('server/api/a.ts', ['apps/web/server/api/a.ts', 'src/b.ts'])).toBe(
      'apps/web/server/api/a.ts',
    );
    expect(coveragePathOf('a.ts', ['x/a.ts', 'y/a.ts'])).toBeNull();
  });

  test('ids are positive integers, each once, at most 200', () => {
    expect(parseGapIds('3, 1,3')).toEqual([3, 1]);
    expect(parseGapIds('1,x')).toEqual({ error: 'ids must be positive integers' });
    expect(parseGapIds(Array.from({ length: 201 }, (_, i) => i + 1).join(','))).toEqual({
      error: 'ids names at most 200 gaps',
    });
  });
});
