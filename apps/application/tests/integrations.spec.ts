/**
 * Integration connections: create + test a Jira connection against a mock Jira
 * HTTP server on a random port, and a pinned Jira link that unfurls through the
 * connection. Role checks run against the CI-only auth server on port 3099 and
 * are skipped locally.
 */
import { test, expect } from './fixtures';
import * as http from 'http';
import * as net from 'net';
import { PROJECT } from '#shared/test-project-names';
import { ProjectRole } from '#shared/permissions';
import { createMember } from './utils/access';

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

/** A mock Jira Cloud REST v3 server: `myself` and a single issue. */
function startMockJiraServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');
    if (url.startsWith('/rest/api/3/myself')) {
      res.end(JSON.stringify({ accountId: 'acct-1', displayName: 'Mock Jira User' }));
      return;
    }
    if (url.startsWith('/rest/api/3/issue/TEST-1')) {
      res.end(
        JSON.stringify({
          key: 'TEST-1',
          fields: {
            summary: 'Checkout button is disabled',
            status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
            assignee: { accountId: 'acct-2', displayName: 'Assignee', emailAddress: 'a@x.io' },
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ errorMessages: ['Not found'] }));
  });
  server.listen(port, '127.0.0.1');
  return server;
}

interface ConnectionSummary {
  id: number;
  provider: string;
  name: string;
  baseUrl: string;
  status: string;
  managedBy: string;
  hasCredentials: boolean;
}

test.describe.serial('Integrations — connection, test and link unfurl', () => {
  let mockServer: http.Server;
  let mockBaseUrl = '';
  let connectionId = 0;

  test.beforeAll(async () => {
    const port = await getFreePort();
    mockServer = startMockJiraServer(port);
    mockBaseUrl = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async ({ request }) => {
    if (connectionId) await request.delete(`/api/integrations/connections/${connectionId}`);
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  test('create then test a Jira connection resolves the account', async ({ request }) => {
    const created = await request.post('/api/integrations/connections', {
      data: {
        provider: 'jira',
        name: 'Mock Jira',
        baseUrl: mockBaseUrl,
        credentials: { email: 'ci@piwi.dev', apiToken: 'mock-token' },
      },
    });
    expect(created.ok()).toBeTruthy();
    const { connection } = (await created.json()) as { connection: ConnectionSummary };
    connectionId = connection.id;
    expect(connection.hasCredentials).toBe(true);
    expect(connection.managedBy).toBe('db');
    // The credential is never echoed back.
    expect(JSON.stringify(connection)).not.toContain('mock-token');

    const tested = await request.post(`/api/integrations/connections/${connectionId}/test`);
    expect(tested.ok()).toBeTruthy();
    const result = (await tested.json()) as { ok: boolean; account?: { displayName: string } };
    expect(result.ok).toBe(true);
    expect(result.account?.displayName).toBe('Mock Jira User');

    // The list reflects the verified status and still hides the credential.
    const list = await request.get('/api/integrations/connections');
    const { connections } = (await list.json()) as { connections: ConnectionSummary[] };
    const mine = connections.find((c) => c.id === connectionId);
    expect(mine?.status).toBe('ok');
    expect('credentials' in (mine as object)).toBe(false);
  });

  test('an empty credential on PATCH keeps the stored one', async ({ request }) => {
    const patched = await request.patch(`/api/integrations/connections/${connectionId}`, {
      data: { name: 'Mock Jira (renamed)', credentials: {} },
    });
    expect(patched.ok()).toBeTruthy();
    const { connection } = (await patched.json()) as { connection: ConnectionSummary };
    expect(connection.name).toBe('Mock Jira (renamed)');
    expect(connection.hasCredentials).toBe(true);

    // The connection still authenticates, proving the credential survived.
    const tested = await request.post(`/api/integrations/connections/${connectionId}/test`);
    const result = (await tested.json()) as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  test('a pinned Jira link unfurls through the connection its project is bound to', async ({ request }) => {
    const submit = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.INTEGRATIONS,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 'a test', status: 'passed', duration: 500, location: 'tests/a.spec.ts:1:1' }],
      },
    });
    expect(submit.ok()).toBeTruthy();
    const { runId, projectId } = (await submit.json()) as { runId: number; projectId: number };

    const pin = async () => {
      const linkRes = await request.post('/api/links', {
        data: { entityType: 'test_run', entityId: runId, url: `${mockBaseUrl}/browse/TEST-1` },
      });
      expect(linkRes.ok()).toBeTruthy();
      return (
        (await linkRes.json()) as {
          link: {
            provider: string;
            key: string | null;
            connectionId: number | null;
            externalId: string | null;
            title: string | null;
            statusText: string | null;
            statusColor: string | null;
          };
        }
      ).link;
    };

    // A project bound to no tracker keeps the link plain: nothing is read through the connection.
    const plain = await pin();
    expect(plain.connectionId).toBeNull();
    expect(plain.statusText).toBeNull();

    const bound = await request.put(`/api/projects/${projectId}/integrations`, { data: { connectionId } });
    expect(bound.ok()).toBeTruthy();
    const link = await pin();
    expect(link.provider).toBe('jira');
    expect(link.key).toBe('TEST-1');
    expect(link.connectionId).toBe(connectionId);
    expect(link.externalId).toBe('TEST-1');
    // Enriched through the connection, not scraped.
    expect(link.title).toBe('Checkout button is disabled');
    expect(link.statusText).toBe('In Progress');
    expect(link.statusColor).toBe('warning');
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

test.describe.serial('Integrations — role checks (auth server, CI only)', () => {
  function skip() {
    test.skip(!process.env.CI, 'Role checks run against the CI-only auth server (see playwright.config.ts)');
  }
  let adminCookie = '';
  let userCookie = '';

  test('bootstrap admin and a member (Viewer of every project)', async () => {
    skip();
    await authApi('POST', '/api/auth/setup', { ...ADMIN, name: 'Admin' });
    adminCookie = await loginAs(ADMIN.username, ADMIN.password);
    expect(adminCookie).toBeTruthy();
    await createMember(
      { baseUrl: AUTH_BASE, cookie: adminCookie },
      { username: 'integrations-user', password: 'userpassword123', role: ProjectRole.VIEWER },
    );
    userCookie = await loginAs('integrations-user', 'userpassword123');
    expect(userCookie).toBeTruthy();
  });

  test('an unauthenticated request is rejected', async () => {
    skip();
    const res = await authApi('GET', '/api/integrations/connections');
    expect(res.status).toBe(401);
  });

  test('a non-admin cannot list or create connections', async () => {
    skip();
    const list = await authApi('GET', '/api/integrations/connections', undefined, userCookie);
    expect(list.status).toBe(403);
    const create = await authApi(
      'POST',
      '/api/integrations/connections',
      { provider: 'jira', name: 'x', baseUrl: 'https://x.atlassian.net' },
      userCookie,
    );
    expect(create.status).toBe(403);
  });

  test('an administrator can list connections', async () => {
    skip();
    const list = await authApi('GET', '/api/integrations/connections', undefined, adminCookie);
    expect(list.status).toBe(200);
  });
});
