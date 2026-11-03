import { beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';

/**
 * The share tokens stored before Piwi stopped keeping them, in the integration
 * actions' payloads and the issue links' metadata, redacted once per instance:
 * the link keeps the id of the share link its URL opens.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules that import it load.
delete process.env.PIWI_DATABASE_URL;
const { getAppSetting } = await import('../../server/utils/app-settings');
const { hashToken } = await import('../../server/utils/token-hash');
const { SHARE_TOKENS_REDACTED_SETTING, redactStoredShareTokens, redactStoredShareTokensOnce } =
  await import('../../server/utils/integrations/share-url');

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let shareLinkId = 0;

const PIWI = 'https://piwi.example.test';
/** A share token, built from parts so no scanner reads it as a live one. */
const TOKEN = ['psl', '_', '5e'.repeat(32)].join('');
const URL = `${PIWI}/share/${TOKEN}`;
const REDACTED = `${PIWI}/share/<redacted>`;

/** A filed issue's body as the action stored it, with its share link. */
function body(url: string) {
  return { nodes: [{ type: 'bullets', items: [[{ text: 'Share link', href: url }]] }] };
}

/** The legacy rows: a create action and a description update holding the token, and the issue's link keeping it. */
async function storeLegacyFiling(clusterId: number): Promise<void> {
  await db.insert(schema.integrationActions).values([
    {
      connectionId: 1,
      projectId: 1,
      kind: 'create-issue',
      entityType: 'failure_cluster',
      entityId: clusterId,
      dedupeKey: `create-issue:failure_cluster:${clusterId}:1`,
      status: 'done',
      payload: { title: 'Broken', document: body(URL), shareUrl: URL, linkEntityId: clusterId },
    },
    {
      connectionId: 1,
      projectId: 1,
      kind: 'update-issue',
      entityType: 'failure_cluster',
      entityId: clusterId,
      dedupeKey: `update-issue:failure_cluster:${clusterId}:day:2026-11-02`,
      status: 'pending',
      payload: { issueKey: `PROJ-${clusterId}`, linkId: 1, title: null, document: body(URL) },
    },
  ]);
  await db.insert(schema.entityLinks).values({
    failureClusterId: clusterId,
    url: `https://jira.example.test/browse/PROJ-${clusterId}`,
    provider: 'jira',
    key: `PROJ-${clusterId}`,
    connectionId: 1,
    origin: 'created',
    metadata: { locale: 'en', shareUrl: URL, written: { documentDigest: 'd', descriptionDigest: 'e' } },
  });
}

async function payloads(): Promise<unknown[]> {
  const rows = await db
    .select({ payload: schema.integrationActions.payload })
    .from(schema.integrationActions)
    .orderBy(asc(schema.integrationActions.id));
  return rows.map((r) => r.payload);
}

async function linkMetadata(clusterId: number): Promise<unknown> {
  const [row] = await db
    .select({ metadata: schema.entityLinks.metadata })
    .from(schema.entityLinks)
    .where(eq(schema.entityLinks.failureClusterId, clusterId));
  return row?.metadata;
}

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  for (const id of [1, 2, 3]) {
    await db.insert(schema.failureClusters).values({
      id,
      projectId: 1,
      fingerprint: `fp-${id}`,
      signature: `Error: broken ${id}`,
      errorType: 'unknown',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
    });
  }
  await db.insert(schema.integrationConnections).values({ id: 1, provider: 'jira', name: 'Jira', baseUrl: PIWI });
  const [link] = await db
    .insert(schema.shareLinks)
    .values({
      projectId: 1,
      entityKind: 'cluster',
      entityId: 1,
      tokenHash: hashToken(TOKEN),
      tokenPrefix: TOKEN.slice(4, 12),
    })
    .returning({ id: schema.shareLinks.id });
  shareLinkId = link!.id;
});

describe('redacting the stored share tokens', () => {
  test('redacts the bodies and links of the actions, and keeps the share link id on the issue link', async () => {
    await storeLegacyFiling(1);
    await db.insert(schema.integrationActions).values({
      connectionId: 1,
      projectId: 1,
      kind: 'comment',
      entityType: 'failure_cluster',
      entityId: 2,
      dedupeKey: 'comment:failure_cluster:2',
      status: 'done',
      payload: { issueKey: 'PROJ-2', document: body(`${PIWI}/failure-clusters/2`) },
    });

    expect(await redactStoredShareTokens(dbc)).toBe(3);

    expect(await payloads()).toEqual([
      { title: 'Broken', document: body(REDACTED), shareUrl: REDACTED, linkEntityId: 1 },
      { issueKey: 'PROJ-1', linkId: 1, title: null, document: body(REDACTED) },
      { issueKey: 'PROJ-2', document: body(`${PIWI}/failure-clusters/2`) },
    ]);
    expect(await linkMetadata(1)).toEqual({
      locale: 'en',
      shareUrl: REDACTED,
      shareLinkId,
      written: { documentDigest: 'd', descriptionDigest: 'e' },
    });
    expect(
      JSON.stringify([await db.select().from(schema.integrationActions), await db.select().from(schema.entityLinks)]),
    ).not.toContain(TOKEN);
  });

  test('keeps no id for a link it cannot find', async () => {
    await db.delete(schema.shareLinks);
    await storeLegacyFiling(1);

    await redactStoredShareTokens(dbc);

    expect(await linkMetadata(1)).toEqual({
      locale: 'en',
      shareUrl: REDACTED,
      written: { documentDigest: 'd', descriptionDigest: 'e' },
    });
  });

  test('runs once per instance', async () => {
    await storeLegacyFiling(1);
    expect(await redactStoredShareTokensOnce(dbc)).toBe(3);
    expect(await getAppSetting(db as never, SHARE_TOKENS_REDACTED_SETTING)).toEqual(expect.any(String));

    await storeLegacyFiling(3);
    expect(await redactStoredShareTokensOnce(dbc)).toBeNull();
    expect(await linkMetadata(3)).toMatchObject({ shareUrl: URL });
  });
});
