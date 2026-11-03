import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';

/**
 * The startup pass that redacts the share tokens stored before Piwi stopped
 * keeping them, on PostgreSQL, whose actions' payloads and links' metadata are
 * `jsonb`. Runs against `PIWI_POSTGRES_TEST_URL`, in a database of its own.
 */

const postgresUrl = process.env.PIWI_POSTGRES_TEST_URL;
const databaseName = `piwi_share_token_redaction_${process.pid}`;
// The schema barrel picks the PostgreSQL schema at import time.
if (postgresUrl) {
  const url = new URL(postgresUrl);
  url.pathname = `/${databaseName}`;
  process.env.PIWI_DATABASE_URL = url.toString();
}

const MIGRATIONS = fileURLToPath(new URL('../../server/database/migrations-pg', import.meta.url));

describe.skipIf(!postgresUrl)('redacting the stored share tokens on PostgreSQL', async () => {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const schema = await import('../../server/database/schema.pg');
  const { hashToken } = await import('../../server/utils/token-hash');
  const { redactStoredShareTokensOnce } = await import('../../server/utils/integrations/share-url');

  const admin = postgres(postgresUrl!, { onnotice: () => {}, max: 1 });
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const PIWI = 'https://piwi.example.test';
  /** A share token, built from parts so no scanner reads it as a live one. */
  const TOKEN = ['psl', '_', '7c'.repeat(32)].join('');
  const REDACTED = `${PIWI}/share/<redacted>`;
  const body = (url: string) => ({ nodes: [{ type: 'bullets', items: [[{ text: 'Share link', href: url }]] }] });
  let shareLinkId = 0;

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    client = postgres(process.env.PIWI_DATABASE_URL!, { onnotice: () => {}, max: 4 });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const [project] = await db.insert(schema.projects).values({ name: 'share-token-redaction' }).returning();
    const [run] = await db
      .insert(schema.testRuns)
      .values({ projectId: project!.id, status: 'failed', startTime: new Date() })
      .returning();
    const [cluster] = await db
      .insert(schema.failureClusters)
      .values({
        projectId: project!.id,
        fingerprint: 'fp-1',
        signature: 'Error: broken',
        errorType: 'unknown',
        firstSeenRunId: run!.id,
        lastSeenRunId: run!.id,
      })
      .returning();
    const [connection] = await db
      .insert(schema.integrationConnections)
      .values({ provider: 'jira', name: 'Jira', baseUrl: 'https://jira.example.test' })
      .returning();
    const [link] = await db
      .insert(schema.shareLinks)
      .values({
        projectId: project!.id,
        entityKind: 'cluster',
        entityId: cluster!.id,
        tokenHash: hashToken(TOKEN),
        tokenPrefix: TOKEN.slice(4, 12),
      })
      .returning();
    shareLinkId = link!.id;
    const url = `${PIWI}/share/${TOKEN}`;
    await db.insert(schema.integrationActions).values({
      connectionId: connection!.id,
      projectId: project!.id,
      kind: 'create-issue',
      entityType: 'failure_cluster',
      entityId: cluster!.id,
      dedupeKey: `create-issue:failure_cluster:${cluster!.id}:${connection!.id}`,
      status: 'done',
      payload: { title: 'Broken', document: body(url), shareUrl: url },
    });
    await db.insert(schema.entityLinks).values({
      failureClusterId: cluster!.id,
      url: 'https://jira.example.test/browse/PROJ-1',
      provider: 'jira',
      key: 'PROJ-1',
      connectionId: connection!.id,
      origin: 'created',
      metadata: { locale: 'en', shareUrl: url },
    });
  });

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  test('redacts the payloads and the link metadata once, keeping the share link id', async () => {
    expect(await redactStoredShareTokensOnce(db as never)).toBe(2);
    expect(await redactStoredShareTokensOnce(db as never)).toBeNull();

    const [action] = await db.select().from(schema.integrationActions);
    expect(action?.payload).toEqual({ title: 'Broken', document: body(REDACTED), shareUrl: REDACTED });
    const [link] = await db.select().from(schema.entityLinks);
    expect(link?.metadata).toEqual({ locale: 'en', shareUrl: REDACTED, shareLinkId });
  });
});
