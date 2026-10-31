import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  scoreFixedBefore,
  rankFixedBefore,
  FIXED_BEFORE_THRESHOLD,
  type MemoryCluster,
  type MemoryCandidate,
} from '#shared/cluster-memory';
import { migrateToLatest } from './temp-db';

function cluster(over: Partial<MemoryCluster> = {}): MemoryCluster {
  return {
    id: 1,
    errorType: 'assertion',
    normalizedMessage: 'expect(received).toBeVisible()',
    maskedSelector: null,
    locator: null,
    specFiles: [],
    testTitles: [],
    ...over,
  };
}

describe('scoreFixedBefore', () => {
  it('matches on the same fingerprint family (error type + masked message)', () => {
    const open = cluster({ id: 1 });
    const cand = cluster({ id: 2 });
    const score = scoreFixedBefore(open, cand, null);
    expect(score).not.toBeNull();
    expect(score!.score).toBeGreaterThanOrEqual(FIXED_BEFORE_THRESHOLD);
    expect(score!.reason).toContain('same error');
  });

  it('names the locator when both share the same failing one', () => {
    const open = cluster({ id: 1, locator: "getByRole('button', { name: 'Pay' })" });
    const cand = cluster({ id: 2, locator: "getByRole('button', { name: 'Pay' })" });
    const score = scoreFixedBefore(open, cand, null);
    expect(score!.reason).toBe('same error and locator');
  });

  it('matches on the same spec file plus the same error', () => {
    const open = cluster({ id: 1, specFiles: ['tests/checkout.spec.ts'] });
    const cand = cluster({ id: 2, specFiles: ['tests/checkout.spec.ts'] });
    const score = scoreFixedBefore(open, cand, null);
    expect(score).not.toBeNull();
    expect(score!.reason).toContain('same spec');
  });

  it('does not match on error type alone when nothing else overlaps', () => {
    const open = cluster({ id: 1, errorType: 'timeout', normalizedMessage: 'Timeout <N>ms exceeded' });
    const cand = cluster({ id: 2, errorType: 'timeout', normalizedMessage: 'a completely different message' });
    expect(scoreFixedBefore(open, cand, null)).toBeNull();
  });

  it('lets a high embedding cosine qualify a semantically similar failure', () => {
    const open = cluster({ id: 1, errorType: 'timeout', normalizedMessage: 'Timeout <N>ms exceeded' });
    const cand = cluster({ id: 2, errorType: 'crash', normalizedMessage: 'Target page has been closed' });
    // No deterministic overlap → only the cosine can carry it.
    expect(scoreFixedBefore(open, cand, 0.95)).not.toBeNull();
    expect(scoreFixedBefore(open, cand, 0.95)!.cosine).toBe(0.95);
  });

  it('ignores a cosine that barely clears the embedding threshold', () => {
    const open = cluster({ id: 1, errorType: 'timeout', normalizedMessage: 'Timeout <N>ms exceeded' });
    const cand = cluster({ id: 2, errorType: 'crash', normalizedMessage: 'Target page has been closed' });
    expect(scoreFixedBefore(open, cand, 0.83)).toBeNull();
  });

  it('excludes the cluster itself', () => {
    const open = cluster({ id: 5 });
    expect(scoreFixedBefore(open, cluster({ id: 5 }), 0.99)).toBeNull();
  });
});

describe('rankFixedBefore', () => {
  it('orders by score descending and caps at the limit', () => {
    const open = cluster({
      id: 1,
      locator: "getByRole('button', { name: 'Pay' })",
      specFiles: ['tests/checkout.spec.ts'],
    });
    const candidates: MemoryCandidate[] = [
      // Weakest: only the same error message.
      { cluster: cluster({ id: 2 }), cosine: null },
      // Strongest: same error, same locator, same spec.
      {
        cluster: cluster({
          id: 3,
          locator: "getByRole('button', { name: 'Pay' })",
          specFiles: ['tests/checkout.spec.ts'],
        }),
        cosine: null,
      },
      // Middle: same error and spec.
      { cluster: cluster({ id: 4, specFiles: ['tests/checkout.spec.ts'] }), cosine: null },
    ];
    const ranked = rankFixedBefore(open, candidates, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.clusterId).toBe(3);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('drops the open cluster and anything below the threshold', () => {
    const open = cluster({ id: 1 });
    const candidates: MemoryCandidate[] = [
      { cluster: cluster({ id: 1 }), cosine: 0.99 }, // self
      { cluster: cluster({ id: 2, errorType: 'timeout', normalizedMessage: 'unrelated' }), cosine: 0.5 }, // too weak
    ];
    expect(rankFixedBefore(open, candidates)).toHaveLength(0);
  });
});

describe('findFixedBefore — the earlier diagnosis', () => {
  async function setup() {
    const { drizzle } = await import('drizzle-orm/libsql');
    const { createClient } = await import('@libsql/client');
    const schema = await import('../../server/database/schema.sqlite');
    delete process.env.PIWI_DATABASE_URL;
    const { findFixedBefore } = await import('../../server/utils/cluster-memory');

    const db = drizzle(createClient({ url: ':memory:' }), { schema });
    await migrateToLatest(db);
    await db.insert(schema.projects).values({ id: 1, name: 'shop' });
    const error = 'Error: expect(locator).toBeVisible() failed';
    const base = { projectId: 1, errorType: 'assertion', sampleError: error, firstSeenRunId: 1, lastSeenRunId: 1 };
    await db.insert(schema.failureClusters).values([
      { ...base, id: 1, fingerprint: 'fp-old', signature: error, status: 'resolved', fixCommit: 'abc1234def' },
      { ...base, id: 2, fingerprint: 'fp-new', signature: error, status: 'open' },
    ]);
    const [open] = await db.select().from(schema.failureClusters).where(eq(schema.failureClusters.id, 2));
    return { db, schema, open: open!, findFixedBefore };
  }

  it('offers the earlier diagnosis, unless it was rated unhelpful', async () => {
    const { db, schema, open, findFixedBefore } = await setup();
    await db.insert(schema.failureDiagnoses).values({
      clusterId: 1,
      scope: 'cluster',
      status: 'completed',
      summary: 'The cart API returns 500',
    });

    let [match] = await findFixedBefore(db, open);
    expect(match?.clusterId).toBe(1);
    expect(match?.diagnosisTitle).toBe('The cart API returns 500');

    await db.update(schema.failureDiagnoses).set({ feedback: 'down' });
    [match] = await findFixedBefore(db, open);
    expect(match?.clusterId).toBe(1);
    expect(match?.fixCommitShort).toBe('abc1234');
    expect(match?.diagnosisTitle).toBeNull();
    expect(match?.diagnosisFeedback).toBe('down');
  });
});
