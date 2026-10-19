import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';

/**
 * The share link a ticket carries, against a SQLite database and a stubbed
 * Jira: the draft only shows where it goes, filing the issue creates it once in
 * the name of the person who filed, and a filing asked again before it was
 * done keeps the link of its first attempt.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';
process.env.PIWI_SHARE_LINKS_ENABLED = 'true';

const { createConnection } = await import('../../server/utils/integrations/connections');
const { createIssue } = await import('../../server/utils/integrations/create');
const { buildIssueDraft } = await import('../../server/utils/integrations/draft');

const SITE = 'https://share.atlassian.net';
const PIWI = 'https://piwi.example.test';

/** Whether the stub Jira answers a create, or fails like a site that is down. */
let jiraUp = true;
let issueSeq = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function jira(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (/\/rest\/api\/3\/issue\/createmeta\//.test(url.pathname)) return json({ total: 0, fields: [] });
  if (url.pathname === '/rest/api/3/search/jql') return json({ issues: [] });
  if (url.pathname === '/rest/api/3/issue' && init?.method === 'POST') {
    if (!jiraUp) return json({ errorMessages: ['Service unavailable'] }, 503);
    issueSeq += 1;
    return json({ id: String(10000 + issueSeq), key: `PROJ-${issueSeq}` }, 201);
  }
  const read = /\/rest\/api\/3\/issue\/([A-Z]+-\d+|\d+)$/.exec(url.pathname);
  if (read) {
    return json({
      id: String(10000 + issueSeq),
      key: `PROJ-${issueSeq}`,
      fields: { summary: 'Broken', status: { name: 'To Do', statusCategory: { key: 'new' } } },
    });
  }
  return json({ errorMessages: ['Not found'] }, 404);
}

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let client: ReturnType<typeof createClient>;
let tmpDir: string;
let connectionId = 0;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-issue-share-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../server/database/migrations', import.meta.url)) });
  dbc = db as unknown as DbClient;

  await db.insert(schema.users).values({ id: 7, username: 'robin', password: '', role: 'member' });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', label: 'Shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  for (const id of [1, 2]) {
    await db.insert(schema.testCases).values({ id, projectId: 1, title: `test ${id}`, filePath: 'tests/a.spec.ts' });
    await db.insert(schema.failureClusters).values({
      id,
      projectId: 1,
      fingerprint: `fp-${id}`,
      signature: `Error: broken ${id}`,
      errorType: 'unknown',
      firstSeenRunId: 1,
      lastSeenRunId: 1,
    });
    await db.insert(schema.testRunsCases).values({
      id: 100 + id,
      testRunId: 1,
      testCaseId: id,
      status: 'failed',
      error: `Error: broken ${id}`,
      failureClusterId: id,
    });
  }
  vi.stubGlobal('fetch', vi.fn(jira));
  const connection = await createConnection(dbc, {
    provider: 'jira',
    name: 'Share Jira',
    baseUrl: SITE,
    credentials: { email: 'ci@example.com', apiToken: 'token' },
  });
  connectionId = connection.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.PIWI_SHARE_LINKS_ENABLED;
  await client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  jiraUp = true;
  await db.delete(schema.shareLinks);
});

function file(clusterId: number) {
  return createIssue(dbc, {
    entityType: 'failure_cluster',
    entityId: clusterId,
    connectionId,
    projectKey: 'PROJ',
    issueType: 'Bug',
    title: 'Broken',
    include: { includeShareLink: true },
    requestedBy: 7,
    siteUrl: PIWI,
  });
}

describe('the share link of a ticket', () => {
  test('the draft shows where it goes and creates none', async () => {
    const draft = await buildIssueDraft(dbc, 'failure_cluster', 1, {
      include: { includeShareLink: true },
      siteUrl: PIWI,
    });
    expect(draft?.markdown).toContain(`${PIWI}/share/…`);
    expect(await db.select().from(schema.shareLinks)).toHaveLength(0);
  });

  test('filing the issue creates one, in the name of the person who filed it', async () => {
    const filed = await file(1);
    expect(filed?.status).toBe('done');
    const links = await db.select().from(schema.shareLinks);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ projectId: 1, entityKind: 'cluster', entityId: 1, createdBy: 7 });
  });

  test('a filing asked again before it was done keeps the link of its first attempt', async () => {
    jiraUp = false;
    expect((await file(2))?.status).toBe('pending');
    const [action] = await db
      .select()
      .from(schema.integrationActions)
      .where(like(schema.integrationActions.dedupeKey, 'create-issue:failure_cluster:2:%'));
    const firstUrl = (action?.payload as { shareUrl?: string } | null)?.shareUrl;
    expect(firstUrl).toMatch(new RegExp(`^${PIWI}/share/`));

    jiraUp = true;
    expect((await file(2))?.status).toBe('done');
    expect(await db.select().from(schema.shareLinks)).toHaveLength(1);
  });
});
