import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { migrateToLatest } from './temp-db';

/**
 * Required Jira fields on the create path, against a SQLite database and a
 * stubbed Jira: a create that would leave a required field empty is refused
 * before Jira is called, project defaults and request values fill it, only the
 * fields on the screen are sent, a refusal Jira names is final, and creating
 * again replaces the refused request instead of replaying it.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';

const { createConnection } = await import('../../server/utils/integrations/connections');
const { writeProjectIntegration } = await import('../../server/utils/integrations/binding');
const { createIssue } = await import('../../server/utils/integrations/create');
const { isFinalRefusal, runAction } = await import('../../server/utils/integrations/actions');
const { JiraError } = await import('../../server/utils/integrations/jira/client');
const { createFieldsCache } = await import('../../server/utils/integrations/picker-cache');

const SITE = 'https://fields.atlassian.net';

/** Create metadata per issue type: 10004 requires a Severity; 10005 lists a Squad as optional. */
const SCREENS: Record<string, unknown[]> = {
  '10004': [
    { fieldId: 'project', name: 'Project', required: true, schema: { type: 'project', system: 'project' } },
    { fieldId: 'issuetype', name: 'Issue type', required: true, schema: { type: 'issuetype', system: 'issuetype' } },
    { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string', system: 'summary' } },
    {
      fieldId: 'customfield_10050',
      name: 'Severity',
      required: true,
      schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' },
      allowedValues: [
        { id: '10100', value: 'Critical' },
        { id: '10101', value: 'Major' },
      ],
    },
  ],
  '10005': [
    { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string', system: 'summary' } },
    { fieldId: 'customfield_10060', name: 'Squad', required: false, schema: { type: 'string' } },
  ],
};

let posted: Array<{ fields: Record<string, unknown> }> = [];
let failNextWith: number | null = null;
let issueSeq = 0;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A stub Jira: create metadata, create (with a workflow validator on 10005 requiring a Squad), and read-back. */
async function jira(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const meta = /\/rest\/api\/3\/issue\/createmeta\/PROJ\/issuetypes\/(\d+)$/.exec(url.pathname);
  if (meta) {
    const fields = SCREENS[meta[1]!] ?? [];
    return json({ startAt: 0, maxResults: 100, total: fields.length, fields });
  }
  if (url.pathname === '/rest/api/3/issue' && init?.method === 'POST') {
    if (failNextWith) {
      const status = failNextWith;
      failNextWith = null;
      return json({ errorMessages: ['Jira is having a moment'] }, status);
    }
    const body = JSON.parse(String(init.body)) as { fields: Record<string, unknown> };
    posted.push(body);
    const type = (body.fields.issuetype as { id?: string }).id;
    if (type === '10005' && !body.fields.customfield_10060) {
      return json({ errorMessages: [], errors: { customfield_10060: 'Squad is required.' } }, 400);
    }
    issueSeq += 1;
    return json({ id: String(10000 + issueSeq), key: `PROJ-${issueSeq}` }, 201);
  }
  const read = /\/rest\/api\/3\/issue\/(PROJ-\d+)$/.exec(url.pathname);
  if (read) {
    return json({ key: read[1], fields: { summary: 'x', status: { name: 'To Do', statusCategory: { key: 'new' } } } });
  }
  return json({ errorMessages: ['Not found'] }, 404);
}

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let client: ReturnType<typeof createClient>;
let tmpDir: string;
let connectionId = 0;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-required-fields-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;

  await db.insert(schema.projects).values({ id: 1, name: 'shop', label: 'Shop' });
  await db.insert(schema.testRuns).values({ id: 1, projectId: 1, status: 'failed', startTime: new Date() });
  for (const id of [1, 2, 3, 4, 5]) {
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
    name: 'Fields Jira',
    baseUrl: SITE,
    credentials: { email: 'ci@example.com', apiToken: 'token' },
  });
  connectionId = connection.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  posted = [];
  failNextWith = null;
  createFieldsCache.deleteWhere(() => true);
  await writeProjectIntegration(dbc, 1, { connectionId, projectKey: 'PROJ', issueType: '10004' });
});

function create(entityId: number, extra: Partial<Parameters<typeof createIssue>[1]> = {}) {
  return createIssue(dbc, {
    entityType: 'failure_cluster',
    entityId,
    connectionId,
    projectKey: 'PROJ',
    issueType: '10004',
    title: 'Broken',
    ...extra,
  });
}

describe('required fields on create', () => {
  test('a create that leaves a required field empty is refused before Jira is called, naming it', async () => {
    const outcome = await create(1);
    expect(outcome).toMatchObject({ status: 'failed', actionId: null });
    expect(outcome?.missingFields).toEqual([{ id: 'customfield_10050', name: 'Severity' }]);
    expect(outcome?.error).toMatch(/^Jira requires Severity for this issue type/);
    expect(posted).toHaveLength(0);
    const actions = await db.select().from(schema.integrationActions);
    expect(actions).toHaveLength(0);
  });

  test('a request value fills it, and a default for a field off the screen is not sent', async () => {
    await writeProjectIntegration(dbc, 1, {
      connectionId,
      projectKey: 'PROJ',
      issueType: '10004',
      fieldDefaults: { customfield_99999: { value: 'elsewhere', label: 'elsewhere' } },
    });
    const outcome = await create(1, {
      fields: { customfield_10050: { value: { id: '10100' }, label: 'Critical' } },
    });
    expect(outcome?.status).toBe('done');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.fields.customfield_10050).toEqual({ id: '10100' });
    expect(posted[0]!.fields).not.toHaveProperty('customfield_99999');
    // Piwi's own fields are never overridden by field values.
    expect(posted[0]!.fields.summary).toBe('Broken');
  });

  test("the project's field defaults fill it", async () => {
    await writeProjectIntegration(dbc, 1, {
      connectionId,
      projectKey: 'PROJ',
      issueType: '10004',
      fieldDefaults: { customfield_10050: { value: { id: '10101' }, label: 'Major' } },
    });
    const outcome = await create(2);
    expect(outcome?.status).toBe('done');
    expect(posted[0]!.fields.customfield_10050).toEqual({ id: '10101' });
  });

  test('an issue already filed is returned as it is, even with a field now missing', async () => {
    const outcome = await create(1);
    expect(outcome?.status).toBe('done');
    expect(outcome?.key).toMatch(/^PROJ-\d+$/);
    expect(posted).toHaveLength(0);
  });
});

describe('refusals', () => {
  test('a refusal Jira names is final, and creating again replaces the refused request', async () => {
    const refused = await create(3, { issueType: '10005' });
    expect(refused?.status).toBe('failed');
    expect(refused?.fieldErrors).toEqual([{ id: 'customfield_10060', name: 'Squad', message: 'Squad is required.' }]);
    const [row] = await db.select().from(schema.integrationActions).where(eq(schema.integrationActions.entityId, 3));
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });

    const fixed = await create(3, {
      issueType: '10005',
      fields: { customfield_10060: { value: 'Checkout', label: 'Checkout' } },
    });
    expect(fixed?.status).toBe('done');
    expect(fixed?.actionId).toBe(row!.id);
    expect(posted.at(-1)!.fields.customfield_10060).toBe('Checkout');
  });

  test('a server error is retried later, not failed', async () => {
    failNextWith = 503;
    const outcome = await create(4, { fields: { customfield_10050: { value: { id: '10100' }, label: 'Critical' } } });
    // The filing is queued for a retry, with the tracker's answer.
    expect(outcome?.status).toBe('pending');
    expect(outcome?.error).toMatch(/503/);
    const [row] = await db.select().from(schema.integrationActions).where(eq(schema.integrationActions.entityId, 4));
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });

    // The background retry succeeds with the same request.
    const retried = await runAction(dbc, { ...row!, scheduledFor: new Date(0) });
    expect(retried.status).toBe('done');
  });

  test('only a refusal about the request itself is final', () => {
    expect(isFinalRefusal(new JiraError(400, 'bad'))).toBe(true);
    expect(isFinalRefusal(new JiraError(403, 'forbidden'))).toBe(true);
    expect(isFinalRefusal(new JiraError(401, 'expired'))).toBe(false);
    expect(isFinalRefusal(new JiraError(429, 'slow down'))).toBe(false);
    expect(isFinalRefusal(new JiraError(503, 'down'))).toBe(false);
    expect(isFinalRefusal(new Error('fetch failed'))).toBe(false);
  });
});
