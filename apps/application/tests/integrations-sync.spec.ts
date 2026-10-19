/**
 * Keep the ticket honest: bind a project, file an issue, then drive the two-way
 * sync against a mock Jira Cloud server whose issue status the test controls.
 *
 * Covered: the binding saves; a sync sweep caches the ticket's status; a fix
 * verified by a passing run comments on and transitions the ticket; a ticket
 * moved to Done offers the reconcile (policy off) then auto-resolves the cluster
 * (policy on); a reopened ticket reopens the cluster; the inbound webhook
 * refreshes one link; Sync now and Disable webhook on the settings page; and
 * the binding endpoint needs Project admin. Nothing calls out.
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

interface MockState {
  server: http.Server;
  setStatus: (name: string, category: 'new' | 'indeterminate' | 'done') => void;
  comments: () => string[];
  transitions: () => string[];
  issueId: () => string;
  issueKey: () => string;
}

/** A mock Jira whose one issue's status the test flips, recording comments + transitions. */
function startMockJira(port: number): MockState {
  let counter = 100;
  let key = '';
  let issueId = '';
  let statusName = 'To Do';
  let statusCategory: 'new' | 'indeterminate' | 'done' = 'new';
  const comments: string[] = [];
  const transitions: string[] = [];

  const collect = (node: unknown): string[] => {
    if (!node || typeof node !== 'object') return [];
    const n = node as { text?: string; content?: unknown[] };
    const here = typeof n.text === 'string' ? [n.text] : [];
    const kids = Array.isArray(n.content) ? n.content.flatMap(collect) : [];
    return [...here, ...kids];
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');
    const send = (body: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    const readBody = (cb: (parsed: any) => void) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          cb(JSON.parse(raw));
        } catch {
          cb(null);
        }
      });
    };

    // Test control: flip the issue status.
    const ctrl = /^\/__status\?name=([^&]+)&category=(\w+)/.exec(url);
    if (ctrl) {
      statusName = decodeURIComponent(ctrl[1]!);
      statusCategory = ctrl[2] as typeof statusCategory;
      return send({ ok: true });
    }

    if (url.startsWith('/rest/api/3/myself')) return send({ accountId: 'acct-1', displayName: 'Mock Jira User' });
    if (url.startsWith('/rest/api/3/project/search'))
      return send({ values: [{ id: '1', key: 'PROJ', name: 'Project' }] });
    if (/^\/rest\/api\/3\/project\/PROJ/.test(url))
      return send({ id: '1', key: 'PROJ', issueTypes: [{ id: '1', name: 'Bug' }] });
    if (url.startsWith('/rest/api/3/user/assignable/search')) return send([]);
    if (req.method === 'POST' && url.startsWith('/rest/api/3/search/jql')) return send({ issues: [] });

    if (req.method === 'POST' && url === '/rest/api/3/issue') {
      counter++;
      key = `PROJ-${counter}`;
      issueId = String(10000 + counter);
      statusName = 'To Do';
      statusCategory = 'new';
      return send({ id: issueId, key }, 201);
    }

    const transMatch = /^\/rest\/api\/3\/issue\/(PROJ-\d+)\/transitions/.exec(url);
    if (transMatch) {
      if (req.method === 'GET') {
        return send({
          transitions: [
            { id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } },
            { id: '11', name: 'To Do', to: { name: 'To Do', statusCategory: { key: 'new' } } },
          ],
        });
      }
      return readBody((body) => {
        const id = body?.transition?.id;
        transitions.push(String(id));
        if (id === '31') {
          statusName = 'Done';
          statusCategory = 'done';
        } else if (id === '11') {
          statusName = 'To Do';
          statusCategory = 'new';
        }
        send({}, 204);
      });
    }

    const commentMatch = /^\/rest\/api\/3\/issue\/(PROJ-\d+)\/comment/.exec(url);
    if (commentMatch && req.method === 'POST') {
      return readBody((body) => {
        comments.push(collect(body?.body).join(' '));
        send({ id: String(comments.length) }, 201);
      });
    }

    // Jira resolves /issue/{idOrKey} by either the numeric id or the key; the
    // sync fetches by the stored external id, the create flow by the key.
    const issueMatch = /^\/rest\/api\/3\/issue\/([^/?]+)/.exec(url);
    if (issueMatch && req.method === 'GET') {
      return send({
        id: issueId,
        key,
        fields: { summary: 'Filed by Piwi', status: { name: statusName, statusCategory: { key: statusCategory } } },
      });
    }

    send({ errorMessages: ['Not found'] }, 404);
  });
  server.listen(port, '127.0.0.1');
  return {
    server,
    setStatus: (name, category) => {
      statusName = name;
      statusCategory = category;
    },
    comments: () => comments,
    transitions: () => transitions,
    issueId: () => issueId,
    issueKey: () => key,
  };
}

/** The binding the sync policies read; the test toggles resolveOnClose mid-run. */
function binding(connectionId: number, resolveOnClose: boolean) {
  return {
    connectionId,
    projectKey: 'PROJ',
    issueType: '1',
    policies: {
      commentOnFix: true,
      transitionOnFix: true,
      fixTransitionId: '31',
      commentOnRegression: true,
      reopenTransitionId: '11',
      commentOnNewOccurrences: true,
      resolveOnClose,
      reopenOnTicketReopen: true,
      commentOnMerge: true,
      needsTicketAfterDays: 2,
    },
  };
}

test.describe.serial('Integrations — keep the ticket honest', () => {
  let mock: MockState;
  let connectionId = 0;
  let clusterId = 0;
  let projectId = 0;

  // One sweep on demand through the admin endpoint: the same pass the scheduled
  // task makes, and unlike Nitro's `/_nitro/tasks` route it exists in the
  // production build CI runs.
  async function runSync(request: import('@playwright/test').APIRequestContext) {
    const res = await request.post('/api/integrations/sync');
    expect(res.ok()).toBe(true);
  }
  async function clusterJson(request: import('@playwright/test').APIRequestContext) {
    return (await (await request.get(`/api/failure-clusters/${clusterId}`)).json()) as {
      status: string;
      clusterState: { kind: string; action: string | null };
      links: { statusText: string | null; externalId: string | null; provider: string }[];
    };
  }

  test.beforeAll(async ({ request }) => {
    const port = await getFreePort();
    mock = startMockJira(port);

    const created = await request.post('/api/integrations/connections', {
      data: {
        provider: 'jira',
        name: 'Mock Jira (sync)',
        baseUrl: `http://127.0.0.1:${port}`,
        credentials: { email: 'ci@piwi.dev', apiToken: 'mock-token' },
      },
    });
    connectionId = (await created.json()).connection.id;

    const submit = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.INTEGRATIONS_SYNC,
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
            error: 'TimeoutError: locator.click: Timeout 5000ms exceeded.',
          },
        ],
      },
    });
    const { runId } = await submit.json();
    const runDetail = await request.get(`/api/test-runs/${runId}`);
    const cases = (await runDetail.json()).testCases as { failureClusterId?: number }[];
    clusterId = cases.find((c) => c.failureClusterId)!.failureClusterId!;
    projectId = (await (await request.get(`/api/failure-clusters/${clusterId}`)).json()).project.id;

    // Bind the project (resolve-on-close off to start), then file the issue.
    await request.put(`/api/projects/${projectId}/integrations`, { data: binding(connectionId, false) });
    const create = await request.post('/api/integrations/issues', {
      data: {
        entityType: 'failure_cluster',
        entityId: clusterId,
        connectionId,
        title: 'Checkout times out',
        projectKey: 'PROJ',
        issueType: '1',
      },
    });
    expect((await create.json()).status).toBe('done');
  });

  test.afterAll(async ({ request }) => {
    if (connectionId) await request.delete(`/api/integrations/connections/${connectionId}`);
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  test('the binding round-trips through the endpoint', async ({ request }) => {
    const res = await request.get(`/api/projects/${projectId}/integrations`);
    const b = await res.json();
    expect(b.connectionId).toBe(connectionId);
    expect(b.projectKey).toBe('PROJ');
    expect(b.policies.resolveOnClose).toBe(false);
    expect(b.policies.fixTransitionId).toBe('31');
    expect(b.autoCreate.enabled).toBe(false);
  });

  test('a sync sweep caches the ticket status', async ({ request }) => {
    mock.setStatus('In Progress', 'indeterminate');
    await runSync(request);
    const c = await clusterJson(request);
    const link = c.links.find((l) => l.provider === 'jira');
    expect(link?.statusText).toBe('In Progress');
  });

  test('Sync now on the settings page reads the statuses again and says how many', async ({ page, request }) => {
    mock.setStatus('In Review', 'indeterminate');
    await page.goto('/settings/integrations');
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Sync now' }).click();
    await expect(page.getByText('Statuses synced', { exact: true })).toBeVisible();
    await expect(
      page.locator('[data-slot="description"]').filter({ hasText: /^Refreshed \d+ links?\./ }),
    ).toBeVisible();
    const link = (await clusterJson(request)).links.find((l) => l.provider === 'jira');
    expect(link?.statusText).toBe('In Review');
  });

  test('a verified fix comments on and transitions the ticket', async ({ request }) => {
    // A passing run of the affected test records a fix, firing the fix policies.
    await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.INTEGRATIONS_SYNC,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 'checks out', status: 'passed', duration: 300, location: 'checkout.spec.ts:3:1' }],
      },
    });

    await expect.poll(() => mock.comments().some((c) => /Fix landed/.test(c)), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => mock.transitions().includes('31'), { timeout: 20_000 }).toBe(true);
  });

  test('a ticket moved to Done offers the reconcile while resolve-on-close is off', async ({ request }) => {
    mock.setStatus('Done', 'done');
    await runSync(request);
    const c = await clusterJson(request);
    expect(c.status).toBe('open');
    expect(c.clusterState.kind).toBe('ticket-done');
    expect(c.clusterState.action).toBe('mark-resolved');
  });

  test('resolve-on-close auto-resolves the cluster when the ticket moves to Done', async ({ request }) => {
    await request.put(`/api/projects/${projectId}/integrations`, { data: binding(connectionId, true) });
    // The ticket is already Done: no move, so the policy leaves the cluster open.
    await runSync(request);
    expect((await clusterJson(request)).status).toBe('open');
    // Reopened, then closed again: that move resolves the cluster.
    mock.setStatus('In Progress', 'indeterminate');
    await runSync(request);
    mock.setStatus('Done', 'done');
    await runSync(request);
    await expect.poll(async () => (await clusterJson(request)).status, { timeout: 10_000 }).toBe('resolved');
  });

  // A resolved cluster's link refreshes at most daily by the scheduled sync, so a
  // reopen (and a re-close) is what the immediate inbound webhook is for.
  let webhookToken = '';
  async function postWebhook(request: import('@playwright/test').APIRequestContext) {
    const hook = await request.post(`/api/integrations/jira/webhook/${webhookToken}`, {
      data: { webhookEvent: 'jira:issue_updated', issue: { id: mock.issueId() } },
    });
    expect((await hook.json()).ok).toBe(true);
  }

  test('the inbound webhook reopens the cluster when the ticket reopens', async ({ request }) => {
    webhookToken = (await (await request.post(`/api/integrations/connections/${connectionId}/webhook-token`)).json())
      .token;
    mock.setStatus('To Do', 'new');
    await postWebhook(request);
    await expect.poll(async () => (await clusterJson(request)).status, { timeout: 10_000 }).toBe('open');
  });

  test('the inbound webhook resolves the cluster when the ticket closes', async ({ request }) => {
    mock.setStatus('Done', 'done');
    await postWebhook(request);
    await expect.poll(async () => (await clusterJson(request)).status, { timeout: 10_000 }).toBe('resolved');
  });

  test('Disable webhook on the settings page turns the inbound webhook off', async ({ page, request }) => {
    await page.goto('/settings/integrations');
    await waitForHydration(page);
    const card = page
      .locator('li')
      .filter({ hasText: 'Mock Jira (sync)' })
      .filter({ has: page.getByRole('button', { name: 'Test connection' }) });
    await card.getByRole('button', { name: 'Disable webhook' }).click();
    await page
      .getByRole('dialog', { name: 'Disable the webhook' })
      .getByRole('button', { name: 'Disable webhook' })
      .click();
    await expect(page.getByText('Webhook disabled', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Enable webhook' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Disable webhook' })).toHaveCount(0);

    const { connection } = await (await request.get(`/api/integrations/connections/${connectionId}`)).json();
    expect(connection.hasWebhookToken).toBe(false);
    // The old URL selects no connection any more: the answer carries no refresh.
    const hook = await request.post(`/api/integrations/jira/webhook/${webhookToken}`, {
      data: { webhookEvent: 'jira:issue_updated', issue: { id: mock.issueId() } },
    });
    expect(await hook.json()).toEqual({ ok: true });
  });
});

test.describe.serial('Integrations sync — role checks (auth server, CI only)', () => {
  const AUTH_BASE = 'http://localhost:3099';
  const ADMIN = { username: 'admin', password: 'adminpassword123' };
  function skip() {
    test.skip(!process.env.CI, 'Role checks run against the CI-only auth server (see playwright.config.ts)');
  }
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

  let userCookie = '';

  test('bootstrap a member (Maintainer of every project)', async () => {
    skip();
    await authApi('POST', '/api/auth/setup', { ...ADMIN, name: 'Admin' });
    const adminCookie = await loginAs(ADMIN.username, ADMIN.password);
    await createMember(
      { baseUrl: AUTH_BASE, cookie: adminCookie },
      { username: 'sync-reporter', password: 'reporterpass123', role: ProjectRole.MAINTAINER },
    );
    userCookie = await loginAs('sync-reporter', 'reporterpass123');
    expect(userCookie).toBeTruthy();
  });

  test('a Maintainer cannot read or write the binding', async () => {
    skip();
    const get = await authApi('GET', '/api/projects/1/integrations', undefined, userCookie);
    expect(get.status).toBe(403);
    const put = await authApi('PUT', '/api/projects/1/integrations', { connectionId: 1 }, userCookie);
    expect(put.status).toBe(403);
  });

  test('a Maintainer cannot run a sync sweep', async () => {
    skip();
    const res = await authApi('POST', '/api/integrations/sync', undefined, userCookie);
    expect(res.status).toBe(403);
  });

  test('a Maintainer cannot disable a webhook', async () => {
    skip();
    const res = await authApi('DELETE', '/api/integrations/connections/1/webhook-token', undefined, userCookie);
    expect(res.status).toBe(403);
  });
});
