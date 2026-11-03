import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';

/**
 * The share link a ticket carries, against a SQLite database and a stubbed
 * Jira: the draft only shows where it goes, filing the issue creates it once in
 * the name of the person who filed, as the issue is sent, and a description
 * update sends the link the issue carries. No row Piwi stores keeps its token.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';
process.env.PIWI_SHARE_LINKS_ENABLED = 'true';

const { createConnection } = await import('../../server/utils/integrations/connections');
const { writeProjectIntegration } = await import('../../server/utils/integrations/binding');
const { createIssue } = await import('../../server/utils/integrations/create');
const { buildIssueDraft } = await import('../../server/utils/integrations/draft');
const { enqueueDescriptionUpdate } = await import('../../server/utils/integrations/policies');
const { hashToken } = await import('../../server/utils/token-hash');

const SITE = 'https://share.atlassian.net';
const PIWI = 'https://piwi.example.test';

/** Whether the stub Jira answers a create, or fails like a site that is down. */
let jiraUp = true;
let issueSeq = 0;
/** The issues the stub Jira holds, by key: what their summary and description say. */
const issues = new Map<string, { summary: string; description: unknown }>();
/** Every body Piwi sent to create or update an issue, in order. */
let sent: Array<{ method: string; body: string }> = [];

/** A share token, anywhere in a text. */
const SHARE_TOKEN = /psl_[0-9a-f]{64}/;

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
    const body = String(init.body);
    sent.push({ method: 'POST', body });
    const { fields } = JSON.parse(body);
    issues.set(`PROJ-${issueSeq}`, { summary: fields.summary, description: fields.description });
    return json({ id: String(10000 + issueSeq), key: `PROJ-${issueSeq}` }, 201);
  }
  const read = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(url.pathname);
  const issue = read ? issues.get(read[1]!) : undefined;
  if (read && issue && init?.method === 'PUT') {
    const body = String(init.body);
    sent.push({ method: 'PUT', body });
    const { fields } = JSON.parse(body);
    if (fields.summary) issue.summary = fields.summary;
    if (fields.description) issue.description = fields.description;
    return new Response(null, { status: 204 });
  }
  if (read && issue) {
    return json({
      id: read[1]!.replace('PROJ-', '1000'),
      key: read[1],
      fields: {
        summary: issue.summary,
        description: issue.description,
        status: { name: 'To Do', statusCategory: { key: 'new' } },
      },
    });
  }
  return json({ errorMessages: ['Not found'] }, 404);
}

/** The share token a body sent to Jira carries. */
function sentToken(body: string): string {
  const token = SHARE_TOKEN.exec(body)?.[0];
  expect(token).toBeDefined();
  return token!;
}

/** Every row Piwi keeps of a filing: its actions and its issue links, as text. */
async function storedFilings(): Promise<string> {
  return JSON.stringify([
    await db.select().from(schema.integrationActions),
    await db.select().from(schema.entityLinks),
  ]);
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
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;

  await db.insert(schema.users).values({ id: 7, username: 'robin', password: '', role: 'member' });
  await db.insert(schema.projects).values({ id: 1, name: 'shop', label: 'Shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  for (const id of [1, 2, 3, 4]) {
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
  // The actions run through the connection the project is bound to, which keeps the descriptions current.
  await writeProjectIntegration(dbc, 1, {
    connectionId,
    projectKey: 'PROJ',
    issueType: 'Bug',
    policies: { updateDescription: true } as never,
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.PIWI_SHARE_LINKS_ENABLED;
  await client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  jiraUp = true;
  sent = [];
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

  test('filing the issue creates one, in the name of the person who filed it, and stores no token', async () => {
    const filed = await file(1);
    expect(filed?.status).toBe('done');
    const links = await db.select().from(schema.shareLinks);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ projectId: 1, entityKind: 'cluster', entityId: 1, createdBy: 7 });

    // The issue carries a working link; Piwi keeps its id and the URL with the token redacted.
    const token = sentToken(sent[0]!.body);
    expect(hashToken(token)).toBe(links[0]!.tokenHash);
    expect(await storedFilings()).not.toMatch(SHARE_TOKEN);
    const [link] = await db.select().from(schema.entityLinks).where(eq(schema.entityLinks.failureClusterId, 1));
    expect(link?.metadata).toMatchObject({ shareUrl: `${PIWI}/share/<redacted>`, shareLinkId: links[0]!.id });
  });

  test('a filing the tracker refused keeps no link, and the filing asked again creates one', async () => {
    jiraUp = false;
    expect((await file(2))?.status).toBe('pending');
    const [action] = await db
      .select()
      .from(schema.integrationActions)
      .where(like(schema.integrationActions.dedupeKey, 'create-issue:failure_cluster:2:%'));
    expect((action?.payload as { shareUrl?: string } | null)?.shareUrl).toBe(`${PIWI}/share/<redacted>`);
    expect(await db.select().from(schema.shareLinks)).toHaveLength(0);
    expect(await storedFilings()).not.toMatch(SHARE_TOKEN);

    jiraUp = true;
    expect((await file(2))?.status).toBe('done');
    const links = await db.select().from(schema.shareLinks);
    expect(links).toHaveLength(1);
    expect(hashToken(sentToken(sent.at(-1)!.body))).toBe(links[0]!.tokenHash);
    expect(await storedFilings()).not.toMatch(SHARE_TOKEN);
  });
});

describe('the share link of a rewritten description', () => {
  /** A cluster's issue filed, then a new occurrence of it, so its description reads differently. */
  async function fileThenRecur(clusterId: number): Promise<void> {
    expect((await file(clusterId))?.status).toBe('done');
    await db.update(schema.failureClusters).set({ occurrences: 9 }).where(eq(schema.failureClusters.id, clusterId));
  }

  test('is the one the issue carries, and is not stored', async () => {
    await fileThenRecur(3);
    const token = sentToken(sent[0]!.body);

    await enqueueDescriptionUpdate(dbc, { clusterId: 3, projectId: 1, reason: 'day:2026-11-03' });

    expect(sent.map((s) => s.method)).toEqual(['POST', 'PUT']);
    expect(sentToken(sent[1]!.body)).toBe(token);
    const [update] = await db
      .select()
      .from(schema.integrationActions)
      .where(like(schema.integrationActions.dedupeKey, 'update-issue:failure_cluster:3:%'));
    expect(update).toMatchObject({ status: 'done', result: { updated: true } });
    expect(await storedFilings()).not.toMatch(SHARE_TOKEN);
  });

  test('that cannot be read back from the issue skips the rewrite', async () => {
    await fileThenRecur(4);
    // The issue reads the same, with its links gone.
    const issue = issues.get(`PROJ-${issueSeq}`)!;
    issue.description = JSON.parse(JSON.stringify(issue.description).replace(/,"marks":\[[^\]]*\]/g, ''));

    await enqueueDescriptionUpdate(dbc, { clusterId: 4, projectId: 1, reason: 'day:2026-11-03' });

    expect(sent.map((s) => s.method)).toEqual(['POST']);
    const [update] = await db
      .select()
      .from(schema.integrationActions)
      .where(like(schema.integrationActions.dedupeKey, 'update-issue:failure_cluster:4:%'));
    expect(update).toMatchObject({
      status: 'skipped',
      error: 'the share link could not be read back from the issue',
    });
  });
});
