import { describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const {
  ENVIRONMENT_SNAPSHOTS_MAX,
  disagreeingFields,
  environmentDigest,
  environmentScope,
  sanitizeEnvironmentSnapshot,
  sanitizeEnvironmentSnapshots,
  serverWarnings,
  withoutPrivateFields,
  groupEnvironments,
} = await import('#shared/environment-snapshots');
const { loadRunEnvironments, saveEnvironmentSnapshots } = await import('#shared/handlers/environment-snapshots');
const { computeMetadataDiff, SHARDS_DIFFER } = await import('#shared/utils/run-metadata');

const runner = {
  kind: 'runner',
  v: 1,
  shardIndex: null,
  timeZone: 'UTC',
  locale: 'en-US',
  nodeVersion: 'v24.3.0',
  ciImage: 'ubuntu24 20261102.1',
  hostname: 'fv-az1',
};

describe('sanitizeEnvironmentSnapshot', () => {
  test('keeps the listed fields only and cuts long strings', () => {
    const clean = sanitizeEnvironmentSnapshot({ ...runner, PATH: '/usr/bin', timeZone: 'x'.repeat(500) });
    expect(clean).not.toHaveProperty('PATH');
    expect((clean as { timeZone: string }).timeZone).toHaveLength(200);
  });

  test('refuses an unknown kind or version, a browser without a project and a server without an origin', () => {
    expect(sanitizeEnvironmentSnapshot({ ...runner, kind: 'database' })).toBeNull();
    expect(sanitizeEnvironmentSnapshot({ ...runner, v: 2 })).toBeNull();
    expect(sanitizeEnvironmentSnapshot({ kind: 'browser', v: 1 })).toBeNull();
    expect(sanitizeEnvironmentSnapshot({ kind: 'server', v: 1 })).toBeNull();
    expect(sanitizeEnvironmentSnapshot('nope')).toBeNull();
  });

  test('caps the count', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ ...runner, shardIndex: i }));
    expect(sanitizeEnvironmentSnapshots(many)).toHaveLength(ENVIRONMENT_SNAPSHOTS_MAX);
    expect(sanitizeEnvironmentSnapshots('x')).toEqual([]);
  });
});

describe('scope and digest', () => {
  test('scopes a runner by shard, a browser by shard and project, a server by origin', () => {
    expect(environmentScope(sanitizeEnvironmentSnapshot(runner)!)).toBe('');
    expect(environmentScope(sanitizeEnvironmentSnapshot({ ...runner, shardIndex: 2 })!)).toBe('2');
    expect(
      environmentScope(sanitizeEnvironmentSnapshot({ kind: 'browser', v: 1, shardIndex: 1, project: 'webkit' })!),
    ).toBe('1|webkit');
    expect(environmentScope(sanitizeEnvironmentSnapshot({ kind: 'server', v: 1, origin: 'http://api' })!)).toBe(
      'http://api',
    );
  });

  test('is stable whatever the key order, and ignores informational fields', () => {
    const a = sanitizeEnvironmentSnapshot(runner)!;
    const reordered = sanitizeEnvironmentSnapshot(Object.fromEntries(Object.entries(runner).reverse()))!;
    expect(environmentDigest(a)).toBe(environmentDigest(reordered));
    expect(environmentDigest(sanitizeEnvironmentSnapshot({ ...runner, hostname: 'other' })!)).toBe(
      environmentDigest(a),
    );
    expect(environmentDigest(sanitizeEnvironmentSnapshot({ ...runner, timeZone: 'Europe/Paris' })!)).not.toBe(
      environmentDigest(a),
    );
  });
});

describe('shards and warnings', () => {
  test('lists the compared fields the shards disagree on', () => {
    const shards = [
      sanitizeEnvironmentSnapshot({ ...runner, shardIndex: 1 })!,
      sanitizeEnvironmentSnapshot({ ...runner, shardIndex: 2, timeZone: 'America/New_York', hostname: 'b' })!,
    ];
    expect(disagreeingFields(shards).map((f) => f.key)).toEqual(['timeZone']);
    expect(disagreeingFields(shards.slice(0, 1))).toEqual([]);
  });

  test('warns on a restart and on a clock off by more than 2 s', () => {
    const server = { kind: 'server' as const, v: 1 as const, origin: 'http://api' };
    expect(serverWarnings({ ...server, clockOffsetMs: 1500 })).toEqual([]);
    expect(serverWarnings({ ...server, clockOffsetMs: -3000, restarted: true })).toEqual(['restarted', 'clock']);
  });

  test('a public share leaves out host names', () => {
    const groups = groupEnvironments([sanitizeEnvironmentSnapshot(runner)!]);
    expect(withoutPrivateFields(groups).runner[0]?.hostname).toBeNull();
  });
});

describe('run-level diff', () => {
  const before = [sanitizeEnvironmentSnapshot(runner)!];

  test('adds the Playwright version and the runner fields that changed', () => {
    const after = [sanitizeEnvironmentSnapshot({ ...runner, ciImage: 'ubuntu24 20261109.1', hostname: 'x' })!];
    const diff = computeMetadataDiff(null, null, null, null, {
      before: { playwrightVersion: '1.56.0', snapshots: before },
      after: { playwrightVersion: '1.57.0', snapshots: after },
    });
    expect(diff.map((d) => d.key)).toEqual(['playwright_version', 'runner.ciImage']);
    expect(diff[1]).toMatchObject({ group: 'runner', before: 'ubuntu24 20261102.1', after: 'ubuntu24 20261109.1' });
  });

  test('shows every value of a field the shards disagree on', () => {
    const after = [
      sanitizeEnvironmentSnapshot({ ...runner, shardIndex: 1 })!,
      sanitizeEnvironmentSnapshot({ ...runner, shardIndex: 2, timeZone: 'Europe/Paris' })!,
    ];
    const diff = computeMetadataDiff(null, null, null, null, {
      before: { snapshots: before },
      after: { snapshots: after },
    });
    expect(diff).toEqual([
      {
        key: 'runner.timeZone',
        label: 'Time zone',
        group: 'runner',
        before: 'UTC',
        after: `UTC, Europe/Paris ${SHARDS_DIFFER}`,
      },
    ]);
  });

  test('a run that recorded no environment shows no change', () => {
    expect(
      computeMetadataDiff(null, null, null, null, { before: { snapshots: [] }, after: { snapshots: before } }),
    ).toEqual([]);
  });
});

describe('storage', () => {
  async function freshDb() {
    const db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(db);
    await db.insert(schema.projects).values({ id: 1, name: 'environments' });
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date(1000) });
    return db;
  }

  test('replaces a row of the same kind and scope whole, and keeps the other scopes', async () => {
    const db = await freshDb();
    await saveEnvironmentSnapshots(db as never, 1, [
      { ...runner, shardIndex: 1 },
      { ...runner, shardIndex: 2 },
    ]);
    await saveEnvironmentSnapshots(db as never, 1, [
      { ...runner, shardIndex: 1, timeZone: 'Asia/Tokyo', locale: null },
    ]);
    const env = await loadRunEnvironments(db as never, 1);
    expect(env.runner.map((r) => [r.shardIndex, r.timeZone, r.locale])).toEqual([
      [1, 'Asia/Tokyo', null],
      [2, 'UTC', 'en-US'],
    ]);
    const rows = await db.select().from(schema.testRunEnvironmentSnapshots);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => /^[0-9a-f]{8}$/.test(r.digest))).toBe(true);
  });

  test('ignores a malformed body', async () => {
    const db = await freshDb();
    await saveEnvironmentSnapshots(db as never, 1, { not: 'an array' });
    await saveEnvironmentSnapshots(db as never, 1, undefined);
    expect(await db.select().from(schema.testRunEnvironmentSnapshots)).toEqual([]);
  });
});

describe('blob report user agent', async () => {
  const { runnerFromUserAgent } = await import('../../server/utils/blob-report');

  test('reads the OS, architecture and Node.js version, marked imported', () => {
    expect(runnerFromUserAgent('Playwright/1.56.0 (x64; ubuntu 24.04) node/24.3 CI/1', { current: 2 })).toEqual({
      kind: 'runner',
      v: 1,
      shardIndex: 2,
      arch: 'x64',
      os: 'ubuntu 24.04',
      nodeVersion: 'v24.3',
      imported: true,
    });
  });

  test('reads nothing from another shape', () => {
    expect(runnerFromUserAgent('Mozilla/5.0')).toBeNull();
    expect(runnerFromUserAgent(undefined)).toBeNull();
  });
});

describe('unset variables', () => {
  test('a TZ the runner did not set reads unset, so setting it is a change; an imported runner reads nothing', () => {
    const diff = computeMetadataDiff(null, null, null, null, {
      before: { snapshots: [sanitizeEnvironmentSnapshot(runner)!] },
      after: { snapshots: [sanitizeEnvironmentSnapshot({ ...runner, tzVariable: 'Europe/Paris' })!] },
    });
    expect(diff).toEqual([
      { key: 'runner.tzVariable', label: 'TZ variable', group: 'runner', before: 'unset', after: 'Europe/Paris' },
    ]);
    const imported = computeMetadataDiff(null, null, null, null, {
      before: { snapshots: [sanitizeEnvironmentSnapshot({ ...runner, imported: true })!] },
      after: { snapshots: [sanitizeEnvironmentSnapshot({ ...runner, tzVariable: 'Europe/Paris' })!] },
    });
    expect(imported.some((d) => d.key === 'runner.tzVariable')).toBe(false);
  });
});

describe('shards and servers', async () => {
  const { mergeServerSnapshots, runnerOfShard } = await import('#shared/environment-snapshots');
  const { loadRunEnvironments: load, saveEnvironmentSnapshots: save } =
    await import('#shared/handlers/environment-snapshots');

  test("a shard never borrows another shard's runner", () => {
    const one = sanitizeEnvironmentSnapshot({ ...runner, shardIndex: 1 })!;
    expect(runnerOfShard([one], 2)).toBeNull();
    expect(runnerOfShard([one], 1)).toBe(one);
    const unsharded = sanitizeEnvironmentSnapshot(runner)!;
    expect(runnerOfShard([unsharded], null)).toBe(unsharded);
  });

  test("one shard's server report never hides another's restart or clock offset", async () => {
    const server = { kind: 'server', v: 1, origin: 'http://app' };
    expect(
      mergeServerSnapshots(
        sanitizeEnvironmentSnapshot({ ...server, restarted: true, clockOffsetMs: 5000 }) as never,
        sanitizeEnvironmentSnapshot({ ...server, restarted: false, clockOffsetMs: 10 }) as never,
      ),
    ).toMatchObject({ restarted: true, clockOffsetMs: 5000 });

    const db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(db);
    await db.insert(schema.projects).values({ id: 1, name: 'environments' });
    await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'passed', startTime: new Date(1000) });
    await save(db as never, 1, [{ ...server, restarted: true, clockOffsetMs: 5000 }]);
    await save(db as never, 1, [{ ...server, restarted: false, clockOffsetMs: 10 }]);
    expect((await load(db as never, 1)).server[0]).toMatchObject({ restarted: true, clockOffsetMs: 5000 });
  });

  test('an imported runner is no change against a recorded one', () => {
    const imported = sanitizeEnvironmentSnapshot({
      kind: 'runner',
      v: 1,
      os: 'ubuntu 24.04',
      nodeVersion: 'v24.3',
      imported: true,
    })!;
    const recorded = sanitizeEnvironmentSnapshot({
      ...runner,
      os: 'linux 6.8 · Ubuntu 24.04.1 LTS',
      nodeVersion: 'v24.3.0',
    })!;
    expect(
      computeMetadataDiff(null, null, null, null, {
        before: { snapshots: [imported] },
        after: { snapshots: [recorded] },
      }),
    ).toEqual([]);
  });
});
