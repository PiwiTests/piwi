import { describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const {
  RUN_ORIGIN_KINDS,
  RUN_USES,
  eligibleExecutionInProject,
  eligibleRunSql,
  isEligibleRun,
  isLabRun,
  notLabRun,
  runOrigin,
  runOriginIn,
  runOriginRef,
} = await import('#shared/run-eligibility');
type RunUse = keyof typeof RUN_USES;

/**
 * Every use and the origins it leaves out. A new origin or a new use fails this
 * test until it is placed here.
 */
const EXCLUDED: Record<RunUse, string[]> = {
  baseline: ['flake-lab', 'probe', 'bisect', 'reproduce'],
  'run-baseline': ['flake-lab', 'probe', 'bisect', 'reproduce'],
  'fix-verification': ['flake-lab', 'probe', 'bisect', 'reproduce'],
  flakiness: ['flake-lab', 'probe', 'bisect', 'reproduce'],
  'selection-catalog': ['flake-lab', 'probe', 'bisect', 'reproduce'],
  'branch-failures': ['flake-lab', 'probe', 'bisect', 'reproduce'],
  'editor-overlay': ['flake-lab', 'probe', 'bisect', 'reproduce'],
  'change-coverage': ['flake-lab', 'probe', 'bisect', 'reproduce'],
  'shared-state': ['flake-lab', 'probe', 'bisect', 'reproduce'],
  'auto-heal': ['flake-lab', 'probe', 'bisect', 'reproduce'],
  'bug-lifecycle': ['bug', 'flake-lab', 'probe', 'bisect', 'reproduce'],
  notifications: ['flake-lab', 'probe', 'editor'],
  tracker: ['flake-lab', 'probe', 'bisect', 'reproduce', 'editor'],
  'run-health': ['flake-lab', 'probe'],
};

/** The uses that leave out an environment incident. */
const EXCLUDES_INCIDENTS: RunUse[] = [
  'baseline',
  'run-baseline',
  'fix-verification',
  'flakiness',
  'selection-catalog',
  'branch-failures',
  'editor-overlay',
  'auto-heal',
  'notifications',
  'tracker',
];

/** The uses that read complete runs only. */
const COMPLETE_ONLY: RunUse[] = ['run-baseline', 'branch-failures', 'change-coverage'];

/** The uses that read the runs of some origins only when complete, and those origins. */
const COMPLETE_ONLY_FOR: Partial<Record<RunUse, string[]>> = {
  notifications: ['local', 'desktop'],
  tracker: ['local', 'desktop'],
};

const USES = Object.keys(RUN_USES) as RunUse[];

describe('the run eligibility table', () => {
  test('knows every origin', () => {
    expect([...RUN_ORIGIN_KINDS]).toEqual([
      'ci',
      'ci-rerun',
      'local',
      'desktop',
      'editor',
      'preflight',
      'bug',
      'flake-lab',
      'probe',
      'bisect',
      'reproduce',
      'import',
    ]);
  });

  test('lists every use', () => {
    expect(USES.sort()).toEqual((Object.keys(EXCLUDED) as RunUse[]).sort());
  });

  test.each(Object.entries(EXCLUDED))('%s leaves out %j', (use, excluded) => {
    const out = RUN_ORIGIN_KINDS.filter(
      (kind) => !isEligibleRun({ metadata: { piwiOrigin: { kind } } }, use as RunUse),
    );
    expect(out.sort()).toEqual([...excluded].sort());
  });

  test.each(USES)('%s and environment incidents', (use) => {
    const eligible = isEligibleRun({ metadata: { piwiOrigin: { kind: 'ci' }, incident: { reason: 'host' } } }, use);
    expect(eligible).toBe(!EXCLUDES_INCIDENTS.includes(use));
  });

  test.each(USES)('%s and partial or unfinished runs', (use) => {
    const metadata = { piwiOrigin: { kind: 'ci' } };
    expect(isEligibleRun({ metadata, isFullRun: 0, status: 'failed' }, use)).toBe(!COMPLETE_ONLY.includes(use));
    expect(isEligibleRun({ metadata, isFullRun: 1, status: 'running' }, use)).toBe(!COMPLETE_ONLY.includes(use));
    expect(isEligibleRun({ metadata, isFullRun: 1, status: 'passed' }, use)).toBe(true);
  });

  test('only shared state leaves out a historical import', () => {
    for (const use of USES) {
      const run = { metadata: { piwiOrigin: { kind: 'import' } }, historicalImport: true };
      expect(isEligibleRun(run, use), use).toBe(use !== 'shared-state');
    }
  });

  test.each(USES)('%s and partial runs of each origin it reads', (use) => {
    for (const kind of RUN_ORIGIN_KINDS) {
      const metadata = { piwiOrigin: { kind } };
      if (!isEligibleRun({ metadata }, use)) continue;
      const partial = isEligibleRun({ metadata, isFullRun: 0, status: 'failed' }, use);
      expect(partial, kind).toBe(!COMPLETE_ONLY.includes(use) && !COMPLETE_ONLY_FOR[use]?.includes(kind));
    }
  });

  test('a complete local run counts wherever a CI run does, but an editor run never notifies or writes to a tracker', () => {
    const outbound: RunUse[] = ['notifications', 'tracker'];
    for (const use of USES) {
      for (const kind of ['local', 'desktop', 'editor']) {
        const eligible = isEligibleRun({ metadata: { piwiOrigin: { kind } } }, use);
        expect(eligible, `${use} ${kind}`).toBe(!outbound.includes(use) || kind !== 'editor');
      }
    }
  });
});

describe('a developer’s runs and notifications', () => {
  const full = { isFullRun: 1, status: 'passed' };
  const partial = { isFullRun: 0, status: 'failed' };

  test('an editor run never feeds them', () => {
    const metadata = { piwiOrigin: { kind: 'editor' } };
    expect(isEligibleRun({ metadata, ...full }, 'notifications')).toBe(false);
    expect(isEligibleRun({ metadata, ...partial }, 'notifications')).toBe(false);
  });

  test.each(['local', 'desktop'])('a %s run feeds them only when it ran the whole suite and finished', (kind) => {
    const metadata = { piwiOrigin: { kind } };
    expect(isEligibleRun({ metadata, ...full }, 'notifications')).toBe(true);
    expect(isEligibleRun({ metadata, ...partial }, 'notifications')).toBe(false);
    expect(isEligibleRun({ metadata, isFullRun: 1, status: 'finalizing' }, 'notifications')).toBe(false);
  });

  test('a run with no origin stamp reads as local', () => {
    expect(isEligibleRun({ metadata: { scm: { branch: 'main' } }, ...partial }, 'notifications')).toBe(false);
    expect(isEligibleRun({ metadata: { scm: { branch: 'main' } }, ...full }, 'notifications')).toBe(true);
  });

  test('a partial CI run still feeds them', () => {
    for (const kind of ['ci', 'ci-rerun']) {
      expect(isEligibleRun({ metadata: { piwiOrigin: { kind } }, ...partial }, 'notifications'), kind).toBe(true);
    }
  });

  test('the editor overlays partial and full runs of every origin but lab and investigation runs', () => {
    for (const kind of ['ci', 'local', 'desktop', 'editor', 'preflight']) {
      const metadata = { piwiOrigin: { kind } };
      expect(isEligibleRun({ metadata, ...partial }, 'editor-overlay'), kind).toBe(true);
    }
    expect(isEligibleRun({ metadata: { piwiOrigin: { kind: 'flake-lab' } }, ...full }, 'editor-overlay')).toBe(false);
  });
});

describe('a run origin', () => {
  test('is read from the stamp first, then from what older runs recorded', () => {
    expect(runOrigin({ piwiOrigin: { kind: 'bisect', ref: '12' } })).toBe('bisect');
    expect(runOriginRef({ piwiOrigin: { kind: 'bisect', ref: '12' } })).toBe('12');
    expect(runOrigin({ piwiProbe: true, piwiOrigin: { kind: 'local' } })).toBe('probe');
    expect(runOrigin({ piwiFlakeLab: { experimentId: 'e', armId: 'a' } })).toBe('flake-lab');
    expect(runOrigin({ import: { source: 'upload' } })).toBe('import');
    expect(runOrigin({ ci: { provider: 'GitHub Actions' } })).toBe('ci');
    expect(runOrigin({ scm: { branch: 'main' } })).toBe('local');
    expect(runOrigin(null)).toBe('local');
    expect(runOrigin({ piwiOrigin: { kind: 'nightly' } })).toBe('other');
  });

  test('is a lab run for Flake Lab and probes only', () => {
    expect(isLabRun({ piwiOrigin: { kind: 'probe' } })).toBe(true);
    expect(isLabRun({ piwiFlakeLab: { experimentId: 'e', armId: 'a' } })).toBe(true);
    expect(isLabRun({ piwiOrigin: { kind: 'bisect' } })).toBe(false);
  });
});

/** The text PostgreSQL's `jsonb` writes: keys shortest first, a space after each colon and comma. */
function jsonbText(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(', ')}]`;
  const keys = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${jsonbText((value as Record<string, unknown>)[k])}`).join(', ')}}`;
}

describe('the SQL form of the rule', () => {
  const samples: Array<Record<string, unknown> | null> = [
    null,
    {},
    { scm: { branch: 'main' } },
    { ci: { provider: 'GitLab CI', pipelineId: '7' } },
    { import: { source: 'upload' }, scm: { branch: 'main' } },
    { piwiProbe: true },
    { piwiProbe: true, piwiOrigin: { kind: 'probe' } },
    { piwiFlakeLab: { experimentId: 'exp-1', armId: 'control' }, piwiOrigin: { kind: 'flake-lab', ref: 'exp-1' } },
    { piwiOrigin: { kind: 'other-kind' }, ci: { provider: 'Jenkins' } },
    { piwiOrigin: { kind: 'ci' }, ci: { provider: 'Jenkins' } },
    { piwiOrigin: { kind: 'ci-rerun', ref: 'a1b2c3' }, ci: { provider: 'GitHub Actions' } },
    { piwiOrigin: { kind: 'local' } },
    { piwiOrigin: { kind: 'import' }, import: { source: 'upload' } },
    { piwiOrigin: { kind: 'incident-free' }, incident: { reason: 'host down' } },
    { piwiOrigin: { kind: 'ci' }, incident: { reason: 'host down' } },
    ...RUN_ORIGIN_KINDS.flatMap((kind) => [{ piwiOrigin: { kind } }, { piwiOrigin: { kind, ref: '214' } }]),
  ];
  const shapes = [
    { isFullRun: 1, status: 'passed' },
    { isFullRun: 0, status: 'failed' },
    { isFullRun: 1, status: 'running' },
    { isFullRun: 0, status: 'running' },
  ];

  async function seed(spelling: (value: unknown) => string) {
    const db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    await db.insert(schema.projects).values({ id: 1, name: 'eligibility' });
    const runs: Array<{ id: number; metadata: Record<string, unknown> | null; isFullRun: number; status: string }> = [];
    let id = 0;
    for (const metadata of samples) {
      for (const shape of shapes) {
        id += 1;
        await db
          .insert(schema.testRuns)
          .values({ id, projectId: 1, startTime: new Date(), origin: runOrigin(metadata), ...shape });
        if (metadata !== null) {
          await db.run(sql`UPDATE test_runs SET metadata = ${spelling(metadata)} WHERE id = ${id}`);
        }
        runs.push({ id, metadata, ...shape });
      }
    }
    return { db, runs };
  }

  for (const [name, spelling] of [
    ['as SQLite stores it', (v: unknown) => JSON.stringify(v)],
    ['as PostgreSQL prints it', jsonbText],
  ] as const) {
    test(`agrees with isEligibleRun on metadata ${name}`, async () => {
      const { db, runs } = await seed(spelling);
      for (const use of USES) {
        const rows = await db
          .select({ id: schema.testRuns.id })
          .from(schema.testRuns)
          .where(and(eq(schema.testRuns.projectId, 1), eligibleRunSql(use)));
        const expected = runs.filter((r) => isEligibleRun(r, use)).map((r) => r.id);
        expect(
          rows.map((r) => r.id).sort((a, b) => a - b),
          use,
        ).toEqual(expected);
        const listed = await db
          .select({ id: schema.testRuns.id })
          .from(schema.testRuns)
          .where(eligibleExecutionInProject(use, 1, schema.testRuns.id, sql`${schema.testRuns.id} > 0`));
        expect(
          listed.map((r) => r.id).sort((a, b) => a - b),
          use,
        ).toEqual(expected);
      }
      for (const kind of RUN_ORIGIN_KINDS) {
        const rows = await db
          .select({ id: schema.testRuns.id })
          .from(schema.testRuns)
          .where(runOriginIn(schema.testRuns.origin, [kind]));
        const expected = runs.filter((r) => runOrigin(r.metadata) === kind).map((r) => r.id);
        expect(
          rows.map((r) => r.id).sort((a, b) => a - b),
          kind,
        ).toEqual(expected);
      }
      const notLab = await db
        .select({ id: schema.testRuns.id })
        .from(schema.testRuns)
        .where(notLabRun(schema.testRuns.origin));
      expect(notLab.map((r) => r.id).sort((a, b) => a - b)).toEqual(
        runs.filter((r) => !isLabRun(r.metadata)).map((r) => r.id),
      );
    });
  }
});
