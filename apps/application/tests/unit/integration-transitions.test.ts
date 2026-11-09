import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import type { DbClient } from '../../server/database';
import { matchTransition, transitionSettingValue } from '#shared/integrations/transitions';
import { migrateToLatest } from './temp-db';

/**
 * Workflow transitions with fields, against a SQLite database and a stubbed
 * Jira: which transition a policy's setting means, the sample issue the binding
 * form reads transitions from, and a policy's move — refused before Jira is
 * asked when its screen requires a field with no value, sent with the
 * project's values otherwise, and final when Jira refuses it.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';

const { createConnection } = await import('../../server/utils/integrations/connections');
const { writeProjectIntegration } = await import('../../server/utils/integrations/binding');
const { enqueueAction, runAction } = await import('../../server/utils/integrations/actions');
const { getTransitionSample, sampleIssueQueries } = await import('../../server/utils/integrations/transitions');
const { transitionsCache } = await import('../../server/utils/integrations/picker-cache');

const SITE = 'https://flow.atlassian.net';

/** PROJ-1 is open: Resolve leads to Done through a screen requiring a Resolution; Close has no screen. */
const OPEN_TRANSITIONS = [
  {
    id: '31',
    name: 'Resolve',
    hasScreen: true,
    to: { name: 'Done', statusCategory: { key: 'done' } },
    fields: {
      resolution: {
        key: 'resolution',
        name: 'Resolution',
        required: true,
        hasDefaultValue: false,
        schema: { type: 'resolution', system: 'resolution' },
        allowedValues: [
          { id: '1', name: 'Fixed' },
          { id: '2', name: "Won't fix" },
        ],
      },
      assignee: { key: 'assignee', name: 'Assignee', required: false, schema: { type: 'user', system: 'assignee' } },
      comment: {
        key: 'comment',
        name: 'Comment',
        required: false,
        schema: { type: 'comments-page', system: 'comment' },
      },
    },
  },
  { id: '41', name: 'Close', hasScreen: false, to: { name: 'Closed', statusCategory: { key: 'done' } }, fields: {} },
];

let posted: Array<{ key: string; body: { transition: { id: string }; fields?: Record<string, unknown> } }> = [];
let searches: string[] = [];
/** The issues each search answers with, by whether the query asks for done ones. */
let openIssues: Array<{ key: string; status: string }> = [];
let refuseWith: Record<string, string> | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function jira(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname === '/rest/api/3/search/jql' && init?.method === 'POST') {
    const { jql } = JSON.parse(String(init.body)) as { jql: string };
    searches.push(jql);
    const issues = /statusCategory != Done/.test(jql) ? openIssues : [];
    return json({
      issues: issues.slice(0, 1).map((i) => ({
        id: '1',
        key: i.key,
        fields: { summary: 's', status: { name: i.status, statusCategory: { key: 'new' } } },
      })),
    });
  }
  const tr = /^\/rest\/api\/3\/issue\/(PROJ-\d+)\/transitions$/.exec(url.pathname);
  if (tr && (!init?.method || init.method === 'GET')) {
    expect(url.searchParams.get('expand')).toBe('transitions.fields');
    return json({ transitions: OPEN_TRANSITIONS });
  }
  if (tr && init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    posted.push({ key: tr[1]!, body });
    if (refuseWith) return json({ errorMessages: [], errors: refuseWith }, 400);
    return new Response(null, { status: 204 });
  }
  return json({ errorMessages: ['Not found'] }, 404);
}

let db: ReturnType<typeof drizzle<typeof schema>>;
let dbc: DbClient;
let client: ReturnType<typeof createClient>;
let tmpDir: string;
let connectionId = 0;
let seq = 0;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piwi-transitions-'));
  client = createClient({ url: `file:${join(tmpDir, 'test.db')}` });
  db = drizzle(client, { schema });
  await migrateToLatest(db);
  dbc = db as unknown as DbClient;
  await db.insert(schema.projects).values({ id: 1, name: 'shop', label: 'Shop' });
  vi.stubGlobal('fetch', vi.fn(jira));
  connectionId = (
    await createConnection(dbc, {
      provider: 'jira',
      name: 'Flow Jira',
      baseUrl: SITE,
      credentials: { email: 'ci@example.com', apiToken: 'token' },
    })
  ).id;
  // The actions run through the connection the project is bound to.
  await writeProjectIntegration(dbc, 1, { connectionId, projectKey: 'PROJ', issueType: 'Bug' });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  posted = [];
  searches = [];
  openIssues = [{ key: 'PROJ-1', status: 'To Do' }];
  refuseWith = null;
  transitionsCache.deleteWhere(() => true);
});

/** Queue a transition action for PROJ-1 and run it once. */
async function move(setting: string, fields: Record<string, { value: unknown; label: string }> = {}) {
  seq += 1;
  const action = await enqueueAction(dbc, {
    connectionId,
    projectId: 1,
    kind: 'transition',
    entityType: 'failure_cluster',
    entityId: seq,
    dedupeKey: `test-transition-${seq}`,
    payload: { issueKey: 'PROJ-1', transitionId: setting, statusName: setting, fields },
  });
  const outcome = await runAction(dbc, action);
  const [row] = await db.select().from(schema.integrationActions).where(eq(schema.integrationActions.id, action.id));
  return { outcome, row: row! };
}

describe('which transition a setting means', () => {
  const available = [
    { id: '31', name: 'Resolve', toStatus: 'Done' },
    { id: '41', name: 'Close', toStatus: 'Closed' },
  ];

  test('by id, then by the status it leads to, then by its name — in any case', () => {
    expect(matchTransition(available, '41')?.name).toBe('Close');
    expect(matchTransition(available, 'done')?.id).toBe('31');
    expect(matchTransition(available, ' RESOLVE ')?.id).toBe('31');
    expect(matchTransition(available, 'Reopen')).toBeNull();
    expect(matchTransition(available, '')).toBeNull();
  });

  test('a picked transition fills the setting with its target status', () => {
    expect(transitionSettingValue({ name: 'Resolve', toStatus: 'Done' })).toBe('Done');
    expect(transitionSettingValue({ name: 'Resolve', toStatus: null })).toBe('Resolve');
  });
});

describe('the sample issue the binding reads transitions from', () => {
  test('its queries ask for Piwi’s issues first, then the bound type, in the right state', () => {
    expect(sampleIssueQueries('PROJ', 'open', '10004')).toEqual([
      'project = "PROJ" AND labels = piwi AND statusCategory != Done ORDER BY updated DESC',
      'project = "PROJ" AND issuetype = 10004 AND statusCategory != Done ORDER BY updated DESC',
    ]);
    expect(sampleIssueQueries('PROJ', 'done', 'Bug "urgent"')[1]).toBe(
      'project = "PROJ" AND issuetype = "Bug \\"urgent\\"" AND statusCategory = Done ORDER BY updated DESC',
    );
    expect(sampleIssueQueries('PROJ', 'done')).toHaveLength(1);
  });

  test('it lists the transitions of the first issue found, with their screens’ fields', async () => {
    const sample = await getTransitionSample(dbc, connectionId, 'PROJ', 'open', '10004');
    expect(sample?.issue).toEqual({ key: 'PROJ-1', status: 'To Do' });
    const resolve = sample?.transitions.find((t) => t.id === '31');
    expect(resolve).toMatchObject({ name: 'Resolve', toStatus: 'Done', toStatusCategory: 'done' });
    expect(resolve?.fields.map((f) => [f.id, f.kind, f.required])).toEqual([
      ['resolution', 'option', true],
      ['assignee', 'user', false],
      ['comment', 'raw', false],
    ]);
    expect(resolve?.fields[0]?.options).toEqual([
      { id: '1', label: 'Fixed' },
      { id: '2', label: "Won't fix" },
    ]);
    expect(searches).toHaveLength(1);
  });

  test('a project with no issue in that state gives no sample, and that answer is not kept', async () => {
    const none = await getTransitionSample(dbc, connectionId, 'PROJ', 'done', '10004');
    expect(none).toEqual({ issue: null, transitions: [] });
    expect(searches).toHaveLength(2);
    await getTransitionSample(dbc, connectionId, 'PROJ', 'done', '10004');
    expect(searches).toHaveLength(4);
  });
});

describe("a policy's move", () => {
  test('a screen requiring a field with no value refuses the move before Jira is asked, for good', async () => {
    const { outcome, row } = await move('Done');
    expect(outcome).toMatchObject({
      status: 'failed',
      final: true,
      fieldErrors: { resolution: 'Resolution is required.' },
    });
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row.error).toBe(
      "Jira requires Resolution to move PROJ-1 to Done. Set it under that transition in the project's issue tracker settings.",
    );
    expect(posted).toHaveLength(0);
  });

  test("the project's values for the screen's fields go with the move, and only those", async () => {
    const { outcome } = await move('Done', {
      resolution: { value: { id: '1' }, label: 'Fixed' },
      assignee: { value: { accountId: 'acc-7' }, label: 'Ada' },
      customfield_10099: { value: 'elsewhere', label: 'elsewhere' },
      comment: { value: 'never sent', label: 'never sent' },
    });
    expect(outcome.status).toBe('done');
    expect(posted).toEqual([
      {
        key: 'PROJ-1',
        body: { transition: { id: '31' }, fields: { resolution: { id: '1' }, assignee: { accountId: 'acc-7' } } },
      },
    ]);
  });

  test('a transition with no screen takes no field values', async () => {
    const { outcome } = await move('Closed', { resolution: { value: { id: '1' }, label: 'Fixed' } });
    expect(outcome.status).toBe('done');
    expect(posted[0]?.body).toEqual({ transition: { id: '41' } });
  });

  test('Jira refusing the move names its fields and is final', async () => {
    refuseWith = { customfield_10070: 'Root cause is required.' };
    const { outcome, row } = await move('41');
    expect(outcome).toMatchObject({ status: 'failed', final: true, fieldErrors: refuseWith });
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
  });

  test('a transition the issue does not offer is a no-op', async () => {
    const { outcome } = await move('Reopen');
    expect(outcome.status).toBe('done');
    expect(posted).toHaveLength(0);
  });
});
