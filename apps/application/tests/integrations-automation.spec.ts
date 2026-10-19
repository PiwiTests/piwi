/**
 * Automatic tracker writes against a mock Jira Cloud server: a rule that counts
 * only the runs on `main` files a failure on its second failing run there, not
 * on a run of a feature branch, and the issue opens with what the rule
 * counted; a diagnosis comments on the issue and rewrites its description; an
 * edit made in Jira stops the next rewrite; a failure an open issue already
 * carries the labels of is left to a person; and the settings preview says what
 * the rules do with each open failure. Nothing calls out.
 */
import { test, expect } from './fixtures';
import * as http from 'http';
import * as net from 'net';
import type { APIRequestContext } from '@playwright/test';
import { PROJECT } from '#shared/test-project-names';

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

/** The text of an ADF tree, in document order. */
function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { text?: unknown; content?: unknown[] };
  return (typeof n.text === 'string' ? n.text : '') + (Array.isArray(n.content) ? n.content.map(adfText).join('') : '');
}

interface MockIssue {
  id: string;
  key: string;
  summary: string;
  description: unknown;
  labels: string[];
  status: { name: string; category: 'new' | 'indeterminate' | 'done' };
}

interface MockJira {
  server: http.Server;
  issues: Map<string, MockIssue>;
  created: () => MockIssue[];
  updates: () => Array<{ key: string; fields: Record<string, unknown> }>;
  comments: () => string[];
  /** An issue someone filed in Jira, outside Piwi. */
  seed: (issue: Pick<MockIssue, 'key' | 'labels'>) => void;
  /** A person rewriting a description in Jira. */
  editDescription: (key: string, text: string) => void;
}

function adfParagraph(text: string) {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function startMockJira(port: number): MockJira {
  const issues = new Map<string, MockIssue>();
  const created: MockIssue[] = [];
  const updates: Array<{ key: string; fields: Record<string, unknown> }> = [];
  const comments: string[] = [];
  let counter = 0;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');
    const send = (body: unknown, status = 200) => {
      res.statusCode = status;
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const readBody = (cb: (parsed: any) => void) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          cb(raw ? JSON.parse(raw) : null);
        } catch {
          cb(null);
        }
      });
    };
    const issueJson = (issue: MockIssue) => ({
      id: issue.id,
      key: issue.key,
      fields: {
        summary: issue.summary,
        description: issue.description,
        labels: issue.labels,
        status: { name: issue.status.name, statusCategory: { key: issue.status.category } },
      },
    });

    if (url.startsWith('/rest/api/3/myself')) return send({ accountId: 'acct-1', displayName: 'Mock Jira User' });
    if (url.startsWith('/rest/api/3/project/search'))
      return send({ values: [{ id: '1', key: 'PROJ', name: 'Project' }] });
    if (url.startsWith('/rest/api/3/issue/createmeta/')) return send({ fields: [], total: 0 });
    if (/^\/rest\/api\/3\/project\/PROJ/.test(url))
      return send({ id: '1', key: 'PROJ', issueTypes: [{ id: '1', name: 'Bug' }] });

    if (req.method === 'POST' && url.startsWith('/rest/api/3/search/jql')) {
      return readBody((body) => {
        const wanted = [...String(body?.jql ?? '').matchAll(/labels = "([^"]+)"/g)].map((m) => m[1]!);
        const found = [...issues.values()].filter((issue) => wanted.every((label) => issue.labels.includes(label)));
        send({ issues: found.map(issueJson) });
      });
    }

    if (req.method === 'POST' && url === '/rest/api/3/issue') {
      return readBody((body) => {
        counter++;
        const issue: MockIssue = {
          id: String(20000 + counter),
          key: `PROJ-${counter}`,
          summary: body?.fields?.summary ?? '',
          description: body?.fields?.description ?? null,
          labels: body?.fields?.labels ?? [],
          status: { name: 'To Do', category: 'new' },
        };
        issues.set(issue.key, issue);
        created.push(issue);
        send({ id: issue.id, key: issue.key }, 201);
      });
    }

    const comment = /^\/rest\/api\/3\/issue\/([^/?]+)\/comment/.exec(url);
    if (comment && req.method === 'POST') {
      return readBody((body) => {
        comments.push(adfText(body?.body));
        send({ id: String(comments.length) }, 201);
      });
    }

    const one = /^\/rest\/api\/3\/issue\/([^/?]+)(?:\?|$)/.exec(url);
    if (one) {
      const issue = issues.get(decodeURIComponent(one[1]!));
      if (!issue) return send({ errorMessages: ['Issue does not exist'] }, 404);
      if (req.method === 'GET') return send(issueJson(issue));
      if (req.method === 'PUT') {
        return readBody((body) => {
          const fields = (body?.fields ?? {}) as Record<string, unknown>;
          updates.push({ key: issue.key, fields });
          if (typeof fields.summary === 'string') issue.summary = fields.summary;
          if (fields.description) issue.description = fields.description;
          send(undefined, 204);
        });
      }
    }

    send({ errorMessages: ['Not found'] }, 404);
  });
  server.listen(port, '127.0.0.1');

  return {
    server,
    issues,
    created: () => created,
    updates: () => updates,
    comments: () => comments,
    seed: ({ key, labels }) => {
      issues.set(key, {
        id: `9${key.replace(/\D/g, '')}`,
        key,
        summary: 'Filed by a person',
        description: adfParagraph('Filed by hand'),
        labels,
        status: { name: 'In Progress', category: 'indeterminate' },
      });
    },
    editDescription: (key, text) => {
      const issue = issues.get(key);
      if (issue) issue.description = adfParagraph(text);
    },
  };
}

const CHECKOUT_ERROR = 'TimeoutError: locator.click: Timeout 5000ms exceeded.';
const SEARCH_ERROR = 'Error: expect(received).toBe(expected) // search results count';

/** Submit a finished run with one failing test, on a branch. */
async function submitFailingRun(
  request: APIRequestContext,
  opts: { branch: string; title: string; error: string; location: string },
): Promise<number> {
  const res = await request.post('/api/test-runs/submit', {
    data: {
      projectName: PROJECT.INTEGRATIONS_AUTOMATION,
      status: 'failed',
      startTime: new Date().toISOString(),
      duration: 1000,
      totalTests: 1,
      passedTests: 0,
      failedTests: 1,
      skippedTests: 0,
      metadata: { scm: { branch: opts.branch } },
      testCases: [{ title: opts.title, status: 'failed', duration: 500, location: opts.location, error: opts.error }],
    },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).runId as number;
}

async function clusterOfRun(request: APIRequestContext, runId: number): Promise<number> {
  const cases = (await (await request.get(`/api/test-runs/${runId}`)).json()).testCases as {
    failureClusterId?: number;
  }[];
  return cases.find((c) => c.failureClusterId)!.failureClusterId!;
}

const DIAGNOSIS = {
  summary: 'The pay button was renamed to Checkout.',
  confidenceScore: 80,
  severity: 'medium',
  affectedArea: null,
  hypotheses: [{ category: 'test-bug', rootCause: 'The test still looks for Pay', likelihood: 80, evidence: [] }],
  suggestedFix: { description: 'Look for Checkout', file: null, code: null, patch: null },
  investigationSteps: [],
  preventionTips: [],
};

test.describe.serial('Integrations — automatic tracker writes', () => {
  let mock: MockJira;
  let connectionId = 0;
  let projectId = 0;
  let checkoutCluster = 0;

  interface PreviewItem {
    clusterId: number;
    decision: { verdict: string };
    description: string;
  }
  async function preview(request: APIRequestContext): Promise<PreviewItem[]> {
    const res = await request.post(`/api/projects/${projectId}/integrations/auto-create-preview`, { data: {} });
    expect(res.ok()).toBe(true);
    return (await res.json()).items as PreviewItem[];
  }
  async function actions(request: APIRequestContext) {
    return (await (await request.get(`/api/integrations/actions?projectId=${projectId}`)).json()).actions as Array<{
      kind: string;
      entityId: number;
      status: string;
      error: string | null;
    }>;
  }

  test.beforeAll(async ({ request }) => {
    const port = await getFreePort();
    mock = startMockJira(port);
    const created = await request.post('/api/integrations/connections', {
      data: {
        provider: 'jira',
        name: 'Mock Jira (automation)',
        baseUrl: `http://127.0.0.1:${port}`,
        credentials: { email: 'ci@piwi.dev', apiToken: 'mock-token' },
      },
    });
    connectionId = (await created.json()).connection.id;

    const runId = await submitFailingRun(request, {
      branch: 'main',
      title: 'pays with a card',
      error: CHECKOUT_ERROR,
      location: 'checkout.spec.ts:3:1',
    });
    checkoutCluster = await clusterOfRun(request, runId);
    projectId = (await (await request.get(`/api/failure-clusters/${checkoutCluster}`)).json()).project.id;

    const saved = await request.put(`/api/projects/${projectId}/integrations`, {
      data: {
        connectionId,
        projectKey: 'PROJ',
        issueType: '1',
        labels: ['e2e'],
        policies: {
          scope: { branches: ['main'], defaultBranch: false, environments: [] },
          commentOnDiagnosis: true,
          updateDescription: true,
        },
        autoCreate: {
          enabled: true,
          rules: [
            {
              branches: ['main'],
              defaultBranch: false,
              environments: [],
              tags: [],
              minOccurrences: 2,
              minRuns: 2,
              minDays: 0,
              labels: ['auto-filed'],
            },
          ],
          skipFlaky: true,
          dailyCap: 5,
          routeUnmatchedToDefault: false,
        },
      },
    });
    expect(saved.ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    if (connectionId) await request.delete(`/api/integrations/connections/${connectionId}`);
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  test('the preview shows the failure waiting on its rule', async ({ request }) => {
    // The run's finalize work runs after the submit answers; wait for the cluster to reach the preview.
    await expect
      .poll(async () => (await preview(request)).find((i) => i.clusterId === checkoutCluster)?.decision.verdict, {
        timeout: 10_000,
      })
      .toBe('wait');
    const item = (await preview(request)).find((i) => i.clusterId === checkoutCluster);
    expect(item?.description).toBe('Waiting on rule 1: 1 of 2 occurrences, 1 of 2 runs');
  });

  test('a failing run on a feature branch is not counted', async ({ request }) => {
    await submitFailingRun(request, {
      branch: 'feat/new-checkout',
      title: 'pays with a card',
      error: CHECKOUT_ERROR,
      location: 'checkout.spec.ts:3:1',
    });
    const item = (await preview(request)).find((i) => i.clusterId === checkoutCluster);
    expect(item?.description).toBe('Waiting on rule 1: 1 of 2 occurrences, 1 of 2 runs');
  });

  test('the second failing run on main files the issue, saying why', async ({ request }) => {
    await submitFailingRun(request, {
      branch: 'main',
      title: 'pays with a card',
      error: CHECKOUT_ERROR,
      location: 'checkout.spec.ts:3:1',
    });
    await expect.poll(() => mock.created().length, { timeout: 20_000 }).toBe(1);
    const issue = mock.created()[0]!;
    expect(issue.labels).toEqual(
      expect.arrayContaining(['piwi', `piwi-cluster-${checkoutCluster}`, 'auto-filed', 'e2e']),
    );
    const body = adfText(issue.description);
    // Counted on main only: the feature-branch occurrence is not in the count.
    expect(body).toContain('Filed automatically by Piwi after 2 occurrences in 2 runs');
    expect(body).toContain('Counted on main.');
    expect(body).toContain(`Piwi-Cluster: ${checkoutCluster}`);

    // The link is stored once the tracker has answered, after the mock records the issue.
    await expect
      .poll(
        async () => {
          const cluster = await (await request.get(`/api/failure-clusters/${checkoutCluster}`)).json();
          return cluster.links.some((l: { key: string | null }) => l.key === issue.key);
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  test('a diagnosis comments on the issue and rewrites its description', async ({ request }) => {
    const res = await request.post(`/api/failure-clusters/${checkoutCluster}/agent-diagnosis`, {
      data: { model: 'test-model', diagnosis: DIAGNOSIS },
    });
    expect(res.ok()).toBe(true);
    await expect
      .poll(() => mock.comments().some((c) => c.includes('Piwi diagnosed this failure:') && c.includes('renamed')), {
        timeout: 20_000,
      })
      .toBe(true);
    const rewritten = () =>
      mock.updates().find((u) => adfText(u.fields.description).includes('The pay button was renamed to Checkout.'));
    await expect.poll(() => !!rewritten(), { timeout: 20_000 }).toBe(true);
    // The automatic note stays at the top of the rewritten description.
    expect(adfText(rewritten()!.fields.description)).toContain('Filed automatically by Piwi');
  });

  test('a description edited in Jira is never overwritten', async ({ request }) => {
    const key = mock.created()[0]!.key;
    const updatesBefore = mock.updates().length;
    mock.editDescription(key, 'A person rewrote this description.');
    const res = await request.post(`/api/failure-clusters/${checkoutCluster}/agent-diagnosis`, {
      data: { model: 'test-model', diagnosis: { ...DIAGNOSIS, summary: 'A second look: the button moved.' } },
    });
    expect(res.ok()).toBe(true);
    await expect
      .poll(
        async () =>
          (await actions(request)).some(
            (a) => a.kind === 'update-issue' && a.status === 'skipped' && /edited in the tracker/.test(a.error ?? ''),
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    expect(mock.updates()).toHaveLength(updatesBefore);
    expect(adfText(mock.issues.get(key)!.description)).toBe('A person rewrote this description.');
  });

  test('a failure an open issue already carries the labels of is left to a person', async ({ request }) => {
    const runId = await submitFailingRun(request, {
      branch: 'main',
      title: 'finds a product',
      error: SEARCH_ERROR,
      location: 'search.spec.ts:8:1',
    });
    const searchCluster = await clusterOfRun(request, runId);
    mock.seed({ key: 'PROJ-900', labels: ['piwi', `piwi-cluster-${searchCluster}`] });
    await submitFailingRun(request, {
      branch: 'main',
      title: 'finds a product',
      error: SEARCH_ERROR,
      location: 'search.spec.ts:8:1',
    });
    await expect
      .poll(
        async () =>
          (await actions(request)).find(
            (a) => a.kind === 'create-issue' && a.entityId === searchCluster && a.status === 'skipped',
          )?.error ?? null,
        { timeout: 20_000 },
      )
      .toMatch(/PROJ-900 already carries this failure's labels/);
    expect(mock.created()).toHaveLength(1);
  });

  test('the settings form shows the rules and previews them', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=settings&section=issue-tracker`);
    const block = page.locator('[data-shot="binding-auto-create"]');
    // The form loads its binding and the tracker's pickers after the page mounts.
    await expect(block.getByText('File issues automatically')).toBeVisible({ timeout: 20_000 });
    await expect(block.getByText('Rule 1')).toBeVisible();
    await expect(block.getByText('After 2 occurrences in 2 runs, on main.')).toBeVisible();
    await block.getByRole('button', { name: 'Preview' }).click();
    await expect(block.getByText(/issues filed automatically in the last 24 hours/)).toBeVisible();
  });
});
