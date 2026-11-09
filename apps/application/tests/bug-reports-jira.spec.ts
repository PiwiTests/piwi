/**
 * A bug report filed in Jira: the intake the extension asks before its
 * preview, a send that asks for an issue, a send into a project that files
 * every report, the screenshot attached through the outbox, and the ticket in
 * the project's language. Against a mock Jira Cloud server; nothing calls out.
 */
import { test, expect } from './fixtures';
import * as http from 'http';
import * as net from 'net';
import { PROJECT } from '#shared/test-project-names';
import { ProjectRole } from '#shared/permissions';
import { couponBugReport, TINY_PNG } from './utils/bug-report-sample';
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

function startMockJira(port: number) {
  let counter = 500;
  const creates: Array<{ fields?: { description?: unknown; labels?: string[] } }> = [];
  const attachments: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');
    const send = (body: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (url.startsWith('/rest/api/3/myself')) return send({ accountId: 'acct-1', displayName: 'Mock' });
      if (url.startsWith('/rest/api/3/project/search'))
        return send({ values: [{ id: '1', key: 'SHOP', name: 'Shop' }] });
      if (/^\/rest\/api\/3\/project\/SHOP/.test(url))
        return send({ id: '1', key: 'SHOP', issueTypes: [{ id: '1', name: 'Bug' }] });
      if (req.method === 'POST' && url.startsWith('/rest/api/3/search/jql')) return send({ issues: [] });
      if (req.method === 'POST' && url === '/rest/api/3/issue') {
        creates.push(JSON.parse(body || '{}'));
        counter++;
        return send({ id: String(10000 + counter), key: `SHOP-${counter}` }, 201);
      }
      const attach = /^\/rest\/api\/3\/issue\/(SHOP-\d+)\/attachments$/.exec(url);
      if (attach && req.method === 'POST') {
        attachments.push(`${attach[1]}:${/filename="([^"]+)"/.exec(body)?.[1] ?? ''}`);
        return send([{ id: '1' }]);
      }
      const issue = /^\/rest\/api\/3\/issue\/(SHOP-\d+)/.exec(url);
      if (issue && req.method === 'GET')
        return send({
          id: String(10000 + Number(issue[1]!.split('-')[1])),
          key: issue[1],
          fields: { summary: 'Filed', status: { name: 'À faire', statusCategory: { key: 'new' } } },
        });
      send({ errorMessages: ['Not found'] }, 404);
    });
  });
  server.listen(port, '127.0.0.1');
  return { server, creates, attachments };
}

function adfText(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as { text?: string; content?: unknown[] };
  return [
    ...(typeof n.text === 'string' ? [n.text] : []),
    ...(Array.isArray(n.content) ? n.content.flatMap(adfText) : []),
  ];
}

test.describe.serial('Bug reports in Jira', () => {
  let mock: ReturnType<typeof startMockJira>;
  let connectionId = 0;
  let projectId = 0;

  test.beforeAll(async ({ request }) => {
    const port = await getFreePort();
    mock = startMockJira(port);
    const created = await request.post('/api/integrations/connections', {
      data: {
        provider: 'jira',
        name: 'Mock Jira (bug reports)',
        baseUrl: `http://127.0.0.1:${port}`,
        credentials: { email: 'ci@piwi.dev', apiToken: 'mock-token' },
      },
    });
    connectionId = (await created.json()).connection.id;
    const submit = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.BUG_REPORTS_JIRA,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 10,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title: 'home', status: 'passed', duration: 5, location: 'home.spec.ts:1:1' }],
      },
    });
    projectId = (await submit.json()).projectId;
  });

  test.afterAll(async ({ request }) => {
    if (connectionId) await request.delete(`/api/integrations/connections/${connectionId}`);
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  const send = (request: import('@playwright/test').APIRequestContext, createIssue: boolean) =>
    request.post(`/api/projects/${projectId}/bug-reports`, {
      multipart: {
        report: JSON.stringify(couponBugReport('Gutschein wird nicht angewendet')),
        language: 'de',
        ...(createIssue ? { createIssue: 'true' } : {}),
        screenshot: { name: '1-marked.png', mimeType: 'image/png', buffer: TINY_PNG },
      },
    });

  test('the intake says the project files nowhere until it is bound', async ({ request }) => {
    const intake = await (await request.get(`/api/projects/${projectId}/bug-reports/intake`)).json();
    expect(intake).toEqual({
      tracker: null,
      projectKey: null,
      locale: null,
      canCreate: false,
      fileEvery: false,
      stepShots: 100,
    });

    const bound = await request.put(`/api/projects/${projectId}/integrations`, {
      data: { connectionId, projectKey: 'SHOP', issueType: '1', locale: 'fr' },
    });
    expect(bound.ok()).toBeTruthy();
    expect(await (await request.get(`/api/projects/${projectId}/bug-reports/intake`)).json()).toEqual({
      tracker: 'jira',
      projectKey: 'SHOP',
      locale: 'fr',
      canCreate: true,
      fileEvery: false,
      stepShots: 100,
    });
  });

  test('a send files nothing unless it asks', async ({ request }) => {
    const res = await send(request, false);
    expect(res.status()).toBe(201);
    expect((await res.json()).issue).toBeNull();
    expect(mock.creates).toHaveLength(0);
  });

  test('a send that asks files exactly one issue, in French, with its screenshot attached', async ({ request }) => {
    const res = await send(request, true);
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.issue.status).toBe('done');
    expect(body.issue.key).toMatch(/^SHOP-\d+$/);
    expect(mock.creates).toHaveLength(1);
    const text = adfText(mock.creates[0]!.fields?.description).join('\n');
    expect(text).toContain('Étapes pour reproduire');
    expect(text).toContain('SPRING10');
    expect(text).toContain('Signalé en allemand');
    expect(mock.creates[0]!.fields?.labels).toEqual(expect.arrayContaining(['piwi', `piwi-bug-${body.id}`]));
    await expect.poll(() => mock.attachments).toEqual([`${body.issue.key}:1-marked.png`]);

    const report = await (await request.get(`/api/bug-reports/${body.id}`)).json();
    expect(report.ticket.key).toBe(body.issue.key);

    const actions = (await (await request.get(`/api/integrations/actions?projectId=${projectId}`)).json()).actions as {
      kind: string;
      entityType: string;
      entityId: number;
    }[];
    const forReport = actions.filter((a) => a.entityType === 'bug_report' && a.entityId === body.id);
    expect(forReport.map((a) => a.kind).sort()).toEqual(['attach', 'create-issue']);
  });

  test('a project that files every report files one without being asked', async ({ request, page }) => {
    const current = await (await request.get(`/api/projects/${projectId}/integrations`)).json();
    await request.put(`/api/projects/${projectId}/integrations`, {
      data: { ...current, policies: { ...current.policies, fileEveryBugReport: true } },
    });
    expect((await (await request.get(`/api/projects/${projectId}/bug-reports/intake`)).json()).fileEvery).toBe(true);
    const res = await send(request, false);
    const body = await res.json();
    expect(body.issue.status).toBe('done');
    expect(mock.creates).toHaveLength(2);

    // The report's page names its ticket instead of offering Create issue.
    await page.goto(`/bug-reports/${body.id}`);
    await expect(page.getByRole('link', { name: body.issue.key })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Create issue' })).toHaveCount(0);
  });

  test('a report without a ticket is filed from its page', async ({ request, page }) => {
    const current = await (await request.get(`/api/projects/${projectId}/integrations`)).json();
    await request.put(`/api/projects/${projectId}/integrations`, {
      data: { ...current, policies: { ...current.policies, fileEveryBugReport: false } },
    });
    const { id } = await (await send(request, false)).json();
    const draft = await (
      await request.get(`/api/integrations/issue-draft?entityType=bug_report&entityId=${id}`)
    ).json();
    expect(draft.markdown).toContain('Étapes pour reproduire');
    const res = await request.post('/api/integrations/issues', {
      data: {
        entityType: 'bug_report',
        entityId: id,
        connectionId,
        title: draft.title,
        projectKey: 'SHOP',
        issueType: '1',
      },
    });
    expect((await res.json()).status).toBe('done');
    expect(mock.creates).toHaveLength(3);
    await page.goto(`/bug-reports/${id}`);
    await expect(page.getByText('Filed as')).toBeVisible({ timeout: 60_000 });
  });
});

// ── Role checks (auth-enabled server, CI only) ───────────────────────────────
const AUTH_BASE = 'http://localhost:3099';

test.describe('Bug reports in Jira — a Viewer (auth server, CI only)', () => {
  test('cannot ask for an issue, and is told it cannot create one', async () => {
    test.skip(!process.env.CI, 'Role checks run against the CI-only auth server (see playwright.config.ts)');
    const api = (method: string, path: string, body?: unknown, cookie?: string) =>
      fetch(`${AUTH_BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    const login = async (username: string, password: string) =>
      ((await api('POST', '/api/auth/login', { username, password })).headers.get('set-cookie') ?? '').split(';')[0] ??
      '';
    await api('POST', '/api/auth/setup', { username: 'admin', password: 'adminpassword123', name: 'Admin' });
    const admin = await login('admin', 'adminpassword123');
    // A Viewer of every project: it files bug reports but does not hold `issue:create`.
    await createMember(
      { baseUrl: AUTH_BASE, cookie: admin },
      { username: 'bug-report-user', password: 'userpassword123', role: ProjectRole.VIEWER },
    );
    const user = await login('bug-report-user', 'userpassword123');
    // A run creates the project.
    const submit = await api(
      'POST',
      '/api/test-runs/submit',
      {
        projectName: PROJECT.BUG_REPORTS_JIRA,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1,
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        testCases: [],
      },
      admin,
    );
    const pid = ((await submit.json()) as { projectId: number }).projectId;

    const res = await api(
      'POST',
      `/api/projects/${pid}/bug-reports`,
      { report: couponBugReport(), createIssue: true },
      user,
    );
    expect(res.status).toBe(403);
    const plain = await api('POST', `/api/projects/${pid}/bug-reports`, { report: couponBugReport() }, user);
    expect(plain.status).toBe(201);
  });
});
