import { describe, test, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { computeDetectorPrecision, isDetectorMuted, MUTE_MIN_VERDICTS } from '../../shared/handlers/detector-precision';
import { detectMatrix, detectEscapedDefect } from '../../shared/handlers/scenario-gaps';
import { selectWeeklyDigest } from '../../shared/handlers/gap-digest';

describe('computeDetectorPrecision / isDetectorMuted', () => {
  test('folds for/against into precision and mutes below threshold with enough verdicts', () => {
    const verdicts = [
      ...Array.from({ length: 8 }, () => ({ detector: 'success-only', verdict: 'for' as const })),
      ...Array.from({ length: 14 }, () => ({ detector: 'success-only', verdict: 'against' as const })),
      { detector: 'surface-drift', verdict: 'for' as const },
    ];
    const result = computeDetectorPrecision(verdicts);
    const successOnly = result.find((r) => r.detector === 'success-only')!;
    expect(successOnly.verdicts).toBe(22);
    expect(successOnly.precision).toBeCloseTo(8 / 22, 5);
    expect(successOnly.muted).toBe(true); // below 60% over 20+ verdicts
    const drift = result.find((r) => r.detector === 'surface-drift')!;
    expect(drift.muted).toBe(false); // only one verdict
  });

  test('does not mute below the minimum verdict count', () => {
    expect(isDetectorMuted(0.1, MUTE_MIN_VERDICTS - 1)).toBe(false);
    expect(isDetectorMuted(0.1, MUTE_MIN_VERDICTS)).toBe(true);
    expect(isDetectorMuted(0.9, 100)).toBe(false);
    expect(isDetectorMuted(null, 100)).toBe(false);
  });
});

describe('detectMatrix', () => {
  const ctx = {
    browsers: ['chromium', 'firefox'],
    viewports: ['desktop', 'mobile'],
    environments: ['staging', 'prod'],
  };

  test('flags a critical feature thin on a covered dimension', () => {
    const gaps = detectMatrix(
      [
        {
          feature: 'Checkout',
          priority: 'critical',
          browsers: ['chromium'],
          viewports: ['desktop', 'mobile'],
          environments: ['staging', 'prod'],
          flags: { newCheckout: ['on'] },
        },
      ],
      ctx,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.detector).toBe('matrix');
    expect(gaps[0]!.evidence[0]).toContain('chromium only');
    expect(gaps[0]!.evidence[0]).toContain('flag newCheckout only on');
  });

  test('ignores low-priority features and fully-covered ones', () => {
    expect(
      detectMatrix(
        [
          {
            feature: 'Minor',
            priority: 'low',
            browsers: ['chromium'],
            viewports: ['desktop'],
            environments: ['staging'],
            flags: {},
          },
        ],
        ctx,
      ),
    ).toHaveLength(0);
    expect(
      detectMatrix(
        [
          {
            feature: 'Wide',
            priority: 'critical',
            browsers: ['chromium', 'firefox'],
            viewports: ['desktop', 'mobile'],
            environments: ['staging', 'prod'],
            flags: {},
          },
        ],
        ctx,
      ),
    ).toHaveLength(0);
  });
});

describe('detectEscapedDefect', () => {
  test('flags an unlinked tracker bug and skips linked ones', () => {
    const gaps = detectEscapedDefect([
      {
        key: 'PROJ-412',
        title: 'refund miscalculated',
        labels: ['bug'],
        hasLinkedCluster: false,
        matchedFeature: 'Refunds',
      },
      { key: 'PROJ-500', title: 'already caught', labels: [], hasLinkedCluster: true },
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.detector).toBe('escaped-defect');
    expect(gaps[0]!.key).toBe('ticket:PROJ-412');
    expect(gaps[0]!.evidence[0]).toContain('Refunds');
  });
});

describe('selectWeeklyDigest', () => {
  const gaps = [
    { projectId: 1, projectName: 'A', id: 1, title: 'g1', class: 'blind-spot', score: 0.9, createdAt: 100 },
    { projectId: 1, projectName: 'A', id: 2, title: 'g2', class: 'fragile', score: 0.5, createdAt: 100 },
    { projectId: 1, projectName: 'A', id: 3, title: 'old', class: 'blind-spot', score: 0.99, createdAt: 10 },
    { projectId: 2, projectName: 'B', id: 4, title: 'g3', class: 'false-comfort', score: 0.7, createdAt: 100 },
  ];

  test('takes new gaps per project, capped, ordered by top score', () => {
    const digest = selectWeeklyDigest(gaps, 50, 5);
    expect(digest.map((p) => p.projectName)).toEqual(['A', 'B']); // A's top 0.9 > B's 0.7
    expect(digest[0]!.gaps.map((g) => g.id)).toEqual([1, 2]); // the old one is excluded
  });

  test('caps per project', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      projectId: 1,
      projectName: 'A',
      id: i,
      title: `g${i}`,
      class: 'blind-spot',
      score: i,
      createdAt: 100,
    }));
    expect(selectWeeklyDigest(many, 50, 5)[0]!.gaps).toHaveLength(5);
  });

  test('leaves out the gaps of a detector muted on their project', () => {
    const detected = [
      { ...gaps[0]!, detector: 'success-only' },
      { ...gaps[1]!, detector: 'surface-drift' },
      { ...gaps[3]!, detector: 'surface-drift' },
    ];
    const digest = selectWeeklyDigest(detected, 50, 5, new Map([[1, new Set(['surface-drift'])]]));
    expect(digest.map((p) => [p.projectName, p.gaps.map((g) => g.id)])).toEqual([
      ['A', [1]],
      ['B', [4]],
    ]);
  });
});

describe('loadDetectorPrecision (DB)', () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  beforeEach(async () => {
    delete process.env.PIWI_DATABASE_URL;
    db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)),
    });
    await db.insert(schema.projects).values({ id: 1, name: 'p' });
  });

  test('counts accepted for, dismissed-as-wrong against', async () => {
    await db.insert(schema.scenarioGaps).values([
      { projectId: 1, detector: 'success-only', class: 'blind-spot', key: 'a', title: 't', status: 'accepted' },
      {
        projectId: 1,
        detector: 'success-only',
        class: 'blind-spot',
        key: 'b',
        title: 't',
        status: 'dismissed',
        dismissReason: 'wrong',
      },
      {
        projectId: 1,
        detector: 'success-only',
        class: 'blind-spot',
        key: 'c',
        title: 't',
        status: 'dismissed',
        dismissReason: 'not-worth-testing',
      },
    ]);
    const result = await loadDetectorPrecisionFor(db);
    const s = result.find((r) => r.detector === 'success-only')!;
    expect(s.for).toBe(1);
    expect(s.against).toBe(1);
    expect(s.verdicts).toBe(2); // not-worth-testing is neutral
  });
});

// Import lazily so the DB env delete above applies first.
async function loadDetectorPrecisionFor(db: ReturnType<typeof drizzle<typeof schema>>) {
  const { loadDetectorPrecision } = await import('../../shared/handlers/detector-precision');
  return loadDetectorPrecision(db, 1);
}
