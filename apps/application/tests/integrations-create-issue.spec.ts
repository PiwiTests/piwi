/**
 * Create an issue from a failure: draft → create → the known-issue link with its
 * key and status → a duplicate create is a no-op → the draft then suggests the
 * existing issue → the MCP `create_issue` tool → role checks. Everything runs
 * against a mock Jira Cloud HTTP server on a random port; nothing calls out.
 */
import { test, expect } from './fixtures';
import * as http from 'http';
import * as net from 'net';
import { PROJECT } from '#shared/test-project-names';
import { ProjectRole } from '#shared/permissions';
import { createMember } from './utils/access';
import { waitForHydration } from './utils';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

/**
 * A per-run tag of fingerprint-safe letters, appended to the seeded error so
 * every suite attempt lands on a brand-new failure cluster.
 *
 * The alphabet deliberately excludes digits and the hex letters a–f: the error
 * fingerprint (shared/error-fingerprint.ts) masks numbers and hex runs to
 * `<N>`/`<HASH>`, so a numeric or hex token would normalize away and collide.
 *
 * Why it matters: this is a `describe.serial` group, so Playwright re-runs
 * `beforeAll` when it retries the group. With a fixed error string the retry
 * reused the same fingerprint cluster and inherited the known-issue link the
 * previous attempt had filed against it — which made "finds no existing issue
 * yet" (existing.length grew past 0) and "creating files the issue" (the create
 * deduped to the stale link, so mock.created() stayed 0) flaky.
 */
function uniqueFailureTag(): string {
  const alphabet = 'ghijklmnopqrstuvwxyz';
  let tag = '';
  for (let i = 0; i < 12; i++) tag += alphabet[Math.floor(Math.random() * alphabet.length)];
  return tag;
}

/** A mock Jira Cloud REST v3 server that mints PROJ-<n> keys and remembers them. */
function startMockJira(port: number): {
  server: http.Server;
  created: () => number;
  lastCreate: () => { fields?: { description?: unknown } } | null;
} {
  let counter = 100;
  let lastCreateBody: { fields?: { description?: unknown } } | null = null;
  const issues = new Map<string, { summary: string }>();

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');
    const send = (body: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };

    if (url.startsWith('/rest/api/3/myself')) return send({ accountId: 'acct-1', displayName: 'Mock Jira User' });
    if (url.startsWith('/rest/api/3/project/search'))
      return send({ values: [{ id: '1', key: 'PROJ', name: 'Project' }] });
    if (/^\/rest\/api\/3\/project\/PROJ/.test(url))
      return send({
        id: '1',
        key: 'PROJ',
        issueTypes: [
          { id: '1', name: 'Bug' },
          { id: '2', name: 'Task' },
        ],
      });
    if (url.startsWith('/rest/api/3/user/assignable/search'))
      return send([{ accountId: 'acct-2', displayName: 'Assignee', emailAddress: 'a@x.io' }]);

    if (req.method === 'POST' && url.startsWith('/rest/api/3/search/jql')) return send({ issues: [] });

    if (req.method === 'POST' && url === '/rest/api/3/issue') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          lastCreateBody = JSON.parse(body);
        } catch {
          lastCreateBody = null;
        }
        counter++;
        const key = `PROJ-${counter}`;
        issues.set(key, { summary: 'Filed by Piwi' });
        send({ id: String(10000 + counter), key }, 201);
      });
      return;
    }

    const issueMatch = /^\/rest\/api\/3\/issue\/(PROJ-\d+)/.exec(url);
    if (issueMatch && req.method === 'GET') {
      const key = issueMatch[1]!;
      if (!issues.has(key)) return send({ errorMessages: ['Not found'] }, 404);
      return send({
        id: String(10000 + Number(key.split('-')[1])),
        key,
        fields: { summary: issues.get(key)!.summary, status: { name: 'To Do', statusCategory: { key: 'new' } } },
      });
    }

    send({ errorMessages: ['Not found'] }, 404);
  });
  server.listen(port, '127.0.0.1');
  return { server, created: () => counter - 100, lastCreate: () => lastCreateBody };
}

/** Recursively collect every ADF text node's string. */
function adfText(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as { text?: string; content?: unknown[] };
  const here = typeof n.text === 'string' ? [n.text] : [];
  const kids = Array.isArray(n.content) ? n.content.flatMap(adfText) : [];
  return [...here, ...kids];
}

interface DraftResponse {
  entityType: string;
  clusterId: number;
  connectionId: number | null;
  projectKey: string | null;
  labels: string[];
  markdown: string;
  existing: { key: string; reason: string }[];
}

test.describe.serial('Integrations — create an issue', () => {
  let mock: ReturnType<typeof startMockJira>;
  let baseUrl = '';
  let connectionId = 0;
  let clusterId = 0;
  let runId = 0;
  let executionId = 0;
  let createdKey = '';
  // Regenerated on every beforeAll run so a serial-group retry gets fresh clusters.
  let runTag = '';

  test.beforeAll(async ({ request }) => {
    const port = await getFreePort();
    mock = startMockJira(port);
    baseUrl = `http://127.0.0.1:${port}`;
    runTag = uniqueFailureTag();

    const created = await request.post('/api/integrations/connections', {
      data: {
        provider: 'jira',
        name: 'Mock Jira (create)',
        baseUrl,
        credentials: { email: 'ci@piwi.dev', apiToken: 'mock-token' },
      },
    });
    connectionId = (await created.json()).connection.id;

    // A failing run creates a failure cluster to file against.
    const submit = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.INTEGRATIONS_CREATE_ISSUE,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'checks out',
            status: 'failed',
            duration: 500,
            location: 'checkout.spec.ts:3:1',
            error: `TimeoutError: locator.click: Timeout 5000ms exceeded. [${runTag}]`,
          },
        ],
      },
    });
    runId = (await submit.json()).runId;
    const runDetail = await request.get(`/api/test-runs/${runId}`);
    const cases = (await runDetail.json()).testCases as { failureClusterId?: number; executionId: number }[];
    const failing = cases.find((c) => c.failureClusterId)!;
    clusterId = failing.failureClusterId!;
    executionId = failing.executionId;

    // A project's issues are filed through the connection it is bound to.
    const projectId = (await (await request.get(`/api/failure-clusters/${clusterId}`)).json()).project.id;
    const bound = await request.put(`/api/projects/${projectId}/integrations`, { data: { connectionId } });
    expect(bound.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (connectionId) await request.delete(`/api/integrations/connections/${connectionId}`);
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  test('status reports the connected tracker', async ({ request }) => {
    const res = await request.get('/api/integrations/status');
    const { trackers } = await res.json();
    expect(trackers.some((t: { id: number }) => t.id === connectionId)).toBe(true);
  });

  test('the draft prefills the body and finds no existing issue yet', async ({ request }) => {
    const res = await request.get(`/api/integrations/issue-draft?entityType=failure_cluster&entityId=${clusterId}`);
    expect(res.ok()).toBeTruthy();
    const draft = (await res.json()) as DraftResponse;
    expect(draft.connectionId).toBe(connectionId);
    expect(draft.markdown).toContain('## What happened');
    expect(draft.labels).toContain(`piwi-cluster-${clusterId}`);
    expect(draft.existing.length).toBe(0);
  });

  test('creating files the issue and links it back with key and status', async ({ request }) => {
    const res = await request.post('/api/integrations/issues', {
      data: {
        entityType: 'failure_cluster',
        entityId: clusterId,
        connectionId,
        title: 'Checkout times out',
        projectKey: 'PROJ',
        issueType: 'Bug',
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('done');
    expect(body.key).toMatch(/^PROJ-\d+$/);
    createdKey = body.key;

    // The known-issue link now carries the key and a synced status.
    const cluster = await request.get(`/api/failure-clusters/${clusterId}`);
    const links = (await cluster.json()).links as {
      provider: string;
      key: string | null;
      statusText: string | null;
      origin?: string;
    }[];
    const link = links.find((l) => l.provider === 'jira');
    expect(link?.key).toBe(createdKey);
    expect(link?.statusText).toBe('To Do');
    expect(link?.origin).toBe('created');
    expect(mock.created()).toBe(1);
  });

  test('the failing execution shows the issue on its page and on its row in the run', async ({ page, request }) => {
    const execution = await (await request.get(`/api/test-run-cases/${executionId}`)).json();
    expect(execution.failureCluster.knownIssue.key).toBe(createdKey);

    await page.goto(`/test-run-cases/${executionId}`);
    const tracked = page.getByTestId('issue-line-key');
    await expect(tracked).toHaveText(createdKey);
    await expect(tracked).toHaveAttribute('href', new RegExp(`/browse/${createdKey}$`));

    // The run's rows load after hydration; the first visit compiles the run page on the dev server.
    await page.goto(`/test-runs/${runId}`);
    await waitForHydration(page);
    await expect(page.getByTestId('issue-key-chip').filter({ hasText: createdKey }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('a duplicate create is a no-op that returns the same issue', async ({ request }) => {
    const res = await request.post('/api/integrations/issues', {
      data: {
        entityType: 'failure_cluster',
        entityId: clusterId,
        connectionId,
        title: 'Checkout times out (again)',
        projectKey: 'PROJ',
        issueType: 'Bug',
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('done');
    expect(body.key).toBe(createdKey);
    // No second issue was minted on Jira.
    expect(mock.created()).toBe(1);
  });

  test('the draft now suggests the existing issue', async ({ request }) => {
    const res = await request.get(`/api/integrations/issue-draft?entityType=failure_cluster&entityId=${clusterId}`);
    const draft = (await res.json()) as DraftResponse;
    expect(draft.existing.some((e) => e.key === createdKey)).toBe(true);
  });

  test('MCP create_issue returns the existing issue rather than filing again', async ({ request }) => {
    const res = await request.post('/mcp', {
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_issue', arguments: { entityType: 'failure_cluster', entityId: clusterId } },
      },
    });
    expect(res.ok()).toBeTruthy();
    const data = JSON.parse((await res.json()).result.content[0].text);
    expect(data.key).toBe(createdKey);
    expect(data.existing?.some((e: { key: string }) => e.key === createdKey)).toBe(true);
    expect(mock.created()).toBe(1);
  });

  test('a French issue renders French ADF headings, data untouched', async ({ request }) => {
    // A distinct failure → a fresh cluster (the tracked one would dedupe).
    const submit = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.INTEGRATIONS_CREATE_ISSUE,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'adds to cart',
            status: 'failed',
            duration: 400,
            location: 'cart.spec.ts:9:1',
            error: `Error: expect(received).toBeVisible()\n  - waiting for getByRole('listitem') [${runTag}]`,
          },
        ],
      },
    });
    const { runId } = await submit.json();
    const runDetail = await request.get(`/api/test-runs/${runId}`);
    const cases = (await runDetail.json()).testCases as { failureClusterId?: number }[];
    const frClusterId = cases.find((c) => c.failureClusterId)!.failureClusterId!;

    const res = await request.post('/api/integrations/issues', {
      data: {
        entityType: 'failure_cluster',
        entityId: frClusterId,
        connectionId,
        title: 'Panier en échec',
        projectKey: 'PROJ',
        issueType: 'Bug',
        locale: 'fr',
      },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).status).toBe('done');

    const description = mock.lastCreate()?.fields?.description;
    const texts = adfText(description);
    expect(texts).toContain("Ce qui s'est passé");
    expect(texts).toContain('Preuves');
    // Data (the locator) is quoted verbatim, never translated.
    expect(texts.join('\n')).toContain("getByRole('listitem')");
  });

  test('the integration action was recorded', async ({ request }) => {
    // The project id from the cluster, so the scope-filtered list can be read.
    const cluster = await request.get(`/api/failure-clusters/${clusterId}`);
    const projectId = (await cluster.json()).project?.id;
    const res = await request.get(`/api/integrations/actions?projectId=${projectId}`);
    const { actions } = await res.json();
    const action = actions.find((a: { kind: string; status: string }) => a.kind === 'create-issue');
    expect(action?.status).toBe('done');
  });

  test('a project bound to no connection files nothing, and the dialog says why', async ({ page, request }) => {
    const filedBefore = mock.created();
    const projectId = (await (await request.get(`/api/failure-clusters/${clusterId}`)).json()).project.id;
    const unbound = await request.put(`/api/projects/${projectId}/integrations`, { data: { connectionId: null } });
    expect(unbound.ok()).toBeTruthy();

    // A distinct failure, so a fresh cluster with no issue yet.
    const submit = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.INTEGRATIONS_CREATE_ISSUE,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
        testCases: [
          {
            title: 'pays the order',
            status: 'failed',
            duration: 300,
            location: 'payment.spec.ts:4:1',
            error: `TypeError: Cannot read properties of undefined (reading 'total') [${runTag}]`,
          },
        ],
      },
    });
    const run = await (await request.get(`/api/test-runs/${(await submit.json()).runId}`)).json();
    const unboundClusterId = (run.testCases as { failureClusterId?: number }[]).find(
      (c) => c.failureClusterId,
    )!.failureClusterId!;

    await page.goto(`/failure-clusters/${unboundClusterId}`);
    await waitForHydration(page);
    const open = page.locator('[data-shot="issue-line-create"]').first();
    await expect(open).toBeVisible({ timeout: 30_000 });
    await open.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('create-issue-no-connection')).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByTestId('create-issue-missing')).toHaveText(
      'This project has no Jira connection to file through.',
    );
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();

    const res = await request.post('/api/integrations/issues', {
      data: {
        entityType: 'failure_cluster',
        entityId: unboundClusterId,
        connectionId,
        title: 'Payment fails',
        projectKey: 'PROJ',
        issueType: 'Bug',
      },
    });
    expect(res.status()).toBe(403);
    expect(mock.created()).toBe(filedBefore);
  });
});

// ── Role checks (auth-enabled server, CI only) ───────────────────────────────
const AUTH_BASE = 'http://localhost:3099';
const ADMIN = { username: 'admin', password: 'adminpassword123' };

function authApi(method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  return fetch(`${AUTH_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function loginAs(username: string, password: string): Promise<string> {
  const res = await authApi('POST', '/api/auth/login', { username, password });
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

test.describe.serial('Create issue — role checks (auth server, CI only)', () => {
  function skip() {
    test.skip(!process.env.CI, 'Role checks run against the CI-only auth server (see playwright.config.ts)');
  }
  let userCookie = '';

  test('bootstrap a member (Viewer of every project)', async () => {
    skip();
    await authApi('POST', '/api/auth/setup', { ...ADMIN, name: 'Admin' });
    const adminCookie = await loginAs(ADMIN.username, ADMIN.password);
    await createMember(
      { baseUrl: AUTH_BASE, cookie: adminCookie },
      { username: 'create-issue-user', password: 'userpassword123', role: ProjectRole.VIEWER },
    );
    userCookie = await loginAs('create-issue-user', 'userpassword123');
    expect(userCookie).toBeTruthy();
  });

  test('a Viewer cannot request a draft or create an issue', async () => {
    skip();
    const draft = await authApi(
      'GET',
      '/api/integrations/issue-draft?entityType=failure_cluster&entityId=1',
      undefined,
      userCookie,
    );
    expect(draft.status).toBe(403);
    const create = await authApi(
      'POST',
      '/api/integrations/issues',
      { entityType: 'failure_cluster', entityId: 1, connectionId: 1, title: 'x', projectKey: 'P', issueType: 'Bug' },
      userCookie,
    );
    expect(create.status).toBe(403);
  });

  test('an unauthenticated create is rejected', async () => {
    skip();
    const res = await authApi('GET', '/api/integrations/status');
    expect(res.status).toBe(401);
  });
});
