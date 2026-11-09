import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

// The schema barrel (server/database/schema.ts) picks the PostgreSQL schema at
// import time when PIWI_DATABASE_URL is set, so clear it before share-links.ts
// (which imports the barrel) is loaded.
delete process.env.PIWI_DATABASE_URL;
const {
  mintShareLink,
  resolveShareToken,
  resolveShareLinkExpiry,
  recordShareLinkView,
  listEntityShareLinks,
  listProjectShareLinks,
  revokeShareLink,
  getShareLink,
  shareLinksEnabled,
} = await import('../../server/utils/share-links');

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let projectId: number;

async function freshDb(): Promise<Db> {
  const next = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(next);
  return next;
}

beforeEach(async () => {
  db = await freshDb();
  const inserted = await db.insert(schema.projects).values({ name: 'share-links-test' }).returning();
  projectId = inserted[0]!.id;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function mint(ttlDays?: number | null) {
  return mintShareLink(db, { projectId, entityKind: 'execution', entityId: 42, createdBy: null, ttlDays });
}

describe('mintShareLink', () => {
  test('returns a psl_ token once and stores only its hash and prefix', async () => {
    const minted = await mint();
    expect(minted.token).toMatch(/^psl_[0-9a-f]{64}$/);
    expect(minted.link.tokenPrefix).toBe(minted.token.slice(4, 12));
    const row = await getShareLink(db, minted.link.id);
    expect(row!.tokenHash).toHaveLength(64);
    expect(row!.tokenHash).not.toContain(minted.token.slice(4));
  });

  test('applies the default 30-day cap when no expiry is requested', async () => {
    const minted = await mint();
    const days = (minted.link.expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });
});

describe('resolveShareLinkExpiry', () => {
  test('clamps a request above the cap down to the cap', () => {
    const expiry = resolveShareLinkExpiry(365, new Date(0));
    expect(expiry!.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test('honors a request under the cap', () => {
    const expiry = resolveShareLinkExpiry(7, new Date(0));
    expect(expiry!.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test('with the cap lifted (0), no request means no expiry', () => {
    vi.stubEnv('PIWI_SHARE_LINK_MAX_TTL_DAYS', '0');
    expect(resolveShareLinkExpiry(undefined, new Date(0))).toBeNull();
    expect(resolveShareLinkExpiry(5, new Date(0))!.getTime()).toBe(5 * 24 * 60 * 60 * 1000);
  });
});

describe('resolveShareToken', () => {
  test('resolves a live token', async () => {
    const minted = await mint();
    const resolved = await resolveShareToken(db, minted.token);
    expect(resolved.state).toBe('live');
    if (resolved.state === 'live') expect(resolved.link.id).toBe(minted.link.id);
  });

  test('rejects garbage and unknown tokens as missing', async () => {
    await mint();
    expect((await resolveShareToken(db, 'not-a-token')).state).toBe('missing');
    expect((await resolveShareToken(db, `psl_${'0'.repeat(64)}`)).state).toBe('missing');
  });

  test('a revoked token is gone, not missing', async () => {
    const minted = await mint();
    await revokeShareLink(db, minted.link.id);
    expect((await resolveShareToken(db, minted.token)).state).toBe('gone');
  });

  test('an expired token is gone', async () => {
    vi.useFakeTimers();
    const minted = await mint(1);
    vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000);
    expect((await resolveShareToken(db, minted.token)).state).toBe('gone');
  });
});

describe('view counting and listings', () => {
  test('recordShareLinkView increments the counter and stamps the view', async () => {
    const minted = await mint();
    await recordShareLinkView(db, minted.link.id);
    await recordShareLinkView(db, minted.link.id);
    const row = await getShareLink(db, minted.link.id);
    expect(row!.viewCount).toBe(2);
    expect(row!.lastViewedAt).not.toBeNull();
  });

  test('listings carry the prefix but never the hash', async () => {
    await mint();
    const forEntity = await listEntityShareLinks(db, 'execution', 42);
    const forProject = await listProjectShareLinks(db, projectId);
    expect(forEntity).toHaveLength(1);
    expect(forProject).toHaveLength(1);
    expect(forEntity[0]!.tokenPrefix).toHaveLength(8);
    expect(forEntity[0]).not.toHaveProperty('tokenHash');
    expect(forProject[0]).not.toHaveProperty('tokenHash');
  });
});

describe('shareLinksEnabled', () => {
  test('is off unless the env opts in', () => {
    expect(shareLinksEnabled()).toBe(false);
    vi.stubEnv('PIWI_SHARE_LINKS_ENABLED', 'true');
    expect(shareLinksEnabled()).toBe(true);
  });
});
