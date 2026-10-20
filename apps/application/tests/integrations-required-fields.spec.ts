/**
 * The fields Jira requires, against a mock Jira Cloud whose Bug type requires a
 * Severity and a Team, and whose Resolve transition requires a Resolution: the
 * fields endpoint reads the create screen, a create that leaves one empty is
 * refused before Jira is called, the project settings keep a default, the create
 * dialog asks for the rest and for a field Jira refused, takes typed tags and
 * labels, and files the issue with them, a refusal Jira names
 * is final and creating again replaces it, and the MCP tool names what is
 * missing and takes loosely typed values. Then the fix transition: the settings
 * check it against an open issue and keep its resolution, a verified fix moves
 * the issue with it, and a move with no resolution fails for good without
 * calling Jira. Nothing calls out.
 */
import { test, expect } from './fixtures';
import * as http from 'http';
import * as net from 'net';
import { PROJECT } from '#shared/test-project-names';
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
 * Fingerprint-safe letters for this attempt's errors, so a retried serial group
 * lands on fresh failure clusters instead of the issues the last attempt filed.
 * Digits and a–f are left out: the fingerprint masks numbers and hex runs.
 */
function uniqueFailureTag(): string {
  const alphabet = 'ghijklmnopqrstuvwxyz';
  let tag = '';
  for (let i = 0; i < 12; i++) tag += alphabet[Math.floor(Math.random() * alphabet.length)];
  return tag;
}

const SEVERITY = 'customfield_10050';
const TEAM = 'customfield_10001';
const SQUAD = 'customfield_10060';
const TAGS = 'customfield_10070';

/** The Bug type's create screen: Severity and Team are required, Parent, Components, Squad and Tags are not. */
const BUG_SCREEN = [
  { fieldId: 'project', name: 'Project', required: true, schema: { type: 'project', system: 'project' } },
  { fieldId: 'issuetype', name: 'Issue type', required: true, schema: { type: 'issuetype', system: 'issuetype' } },
  { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string', system: 'summary' } },
  {
    fieldId: SEVERITY,
    name: 'Severity',
    required: true,
    schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' },
    allowedValues: [
      { id: '10100', value: 'Critical' },
      { id: '10101', value: 'Major' },
      { id: '10102', value: 'Minor' },
    ],
  },
  {
    fieldId: TEAM,
    name: 'Team',
    required: true,
    schema: { type: 'team', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team' },
  },
  { fieldId: 'parent', name: 'Parent', required: false, schema: { type: 'issuelink', system: 'parent' } },
  {
    fieldId: 'components',
    name: 'Components',
    required: false,
    schema: { type: 'array', items: 'component', system: 'components' },
    allowedValues: [{ id: '10200', name: 'Checkout' }],
  },
  { fieldId: SQUAD, name: 'Squad', required: false, schema: { type: 'string' } },
  {
    fieldId: TAGS,
    name: 'Tags',
    required: false,
    schema: { type: 'array', items: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:labels' },
  },
];

/** The path the mock serves its issue type icons from, as Jira Cloud does. */
const ICON_PATH = '/rest/api/2/universal_avatar/view/type/issuetype/avatar/10303?size=medium';
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#904ee2"/></svg>';

/** A person's avatar on the site, as Jira serves one a person uploaded. */
const USER_AVATAR_PATH = '/secure/useravatar?size=small&avatarId=10122';

/** The issues the mock's issue picker finds: epics to parent a bug under. */
const PICKER_ISSUES = [
  { key: 'PROJ-7', summary: 'Checkout epic' },
  { key: 'PROJ-8', summary: 'Payments epic' },
];

interface MockJira {
  server: http.Server;
  /** The fields of every issue created, in order. */
  creates: Record<string, unknown>[];
  /** A workflow validator the create screen does not show: Squad must be set. */
  requireSquad: boolean;
  /** Another such validator: Tags must be set. */
  requireTags: boolean;
  /** Another: the Parent the screen leaves optional must be set. */
  requireParent: boolean;
  /** Every issue picker search, with the JQL it was scoped to. */
  pickerQueries: { query: string; jql: string | null }[];
  /** Every transition made, in order. */
  moves: { key: string; id: string; fields: Record<string, unknown> | null }[];
}

/** An open issue resolves to Done through a screen requiring a Resolution; a done one reopens. */
const OPEN_TRANSITIONS = [
  {
    id: '21',
    name: 'Start progress',
    hasScreen: false,
    to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    fields: {},
  },
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
    },
  },
];
const DONE_TRANSITIONS = [
  { id: '11', name: 'Reopen', hasScreen: false, to: { name: 'To Do', statusCategory: { key: 'new' } }, fields: {} },
];

/** A mock Jira Cloud REST v3 that checks the Bug type's required fields the way Jira does. */
function startMockJira(port: number): MockJira {
  const state: MockJira = {
    server: null as unknown as http.Server,
    creates: [],
    requireSquad: false,
    requireTags: false,
    requireParent: false,
    pickerQueries: [],
    moves: [],
  };
  let counter = 300;
  /** Issues created, newest last, with whether each is done. */
  const issues: { key: string; done: boolean }[] = [];
  const readBody = (req: http.IncomingMessage, cb: (raw: string) => void) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => cb(raw));
  };

  state.server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const send = (body: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const path = url.pathname;

    if (path === '/rest/api/3/myself') return send({ accountId: 'acct-1', displayName: 'Mock Jira User' });
    if (path === '/rest/api/3/project/search') return send({ values: [{ id: '1', key: 'PROJ', name: 'Project' }] });
    if (path === '/rest/api/3/project/PROJ')
      return send({
        id: '1',
        key: 'PROJ',
        issueTypes: [{ id: '10004', name: 'Bug', iconUrl: `http://127.0.0.1:${port}${ICON_PATH}` }],
      });
    if (`${path}${url.search}` === ICON_PATH) {
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.end(ICON_SVG);
    }
    if (path === '/rest/api/3/issue/createmeta/PROJ/issuetypes/10004') {
      return send({ startAt: 0, maxResults: 100, total: BUG_SCREEN.length, fields: BUG_SCREEN });
    }
    if (path === '/rest/api/3/user/assignable/search') {
      return send([
        {
          accountId: 'acct-2',
          displayName: 'Assignee',
          avatarUrls: { '24x24': `http://127.0.0.1:${port}${USER_AVATAR_PATH}` },
        },
      ]);
    }
    if (`${path}${url.search}` === USER_AVATAR_PATH) {
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.end(ICON_SVG);
    }
    if (path === '/rest/api/3/issue/picker') {
      const query = url.searchParams.get('query') ?? '';
      state.pickerQueries.push({ query, jql: url.searchParams.get('currentJQL') });
      const hits = PICKER_ISSUES.filter((i) => `${i.key} ${i.summary}`.toLowerCase().includes(query.toLowerCase()));
      return send({
        sections: [
          { id: 'hs', label: 'History Search', issues: [] },
          {
            id: 'cs',
            label: 'Current Search',
            issues: hits.map((i) => ({
              key: i.key,
              summary: `<b>${i.summary}</b>`,
              summaryText: i.summary,
              img: ICON_PATH,
            })),
          },
        ],
      });
    }
    if (req.method === 'POST' && path === '/rest/api/3/search/jql') {
      // The binding's sample-issue lookup names a status category; the create's dedupe search does not.
      return readBody(req, (raw) => {
        const jql = (JSON.parse(raw || '{}') as { jql?: string }).jql ?? '';
        const category = /statusCategory (!?=) Done/.exec(jql);
        const hit = category ? [...issues].reverse().find((i) => i.done === (category[1] === '=')) : undefined;
        if (!hit) return send({ issues: [] });
        const status = hit.done
          ? { name: 'Done', statusCategory: { key: 'done' } }
          : { name: 'To Do', statusCategory: { key: 'new' } };
        send({ issues: [{ id: '1', key: hit.key, fields: { summary: 'Filed by Piwi', status } }] });
      });
    }

    const transitions = /^\/rest\/api\/3\/issue\/(PROJ-\d+)\/transitions$/.exec(path);
    if (transitions) {
      const issue = issues.find((i) => i.key === transitions[1]);
      if (!issue) return send({ errorMessages: ['Issue does not exist'] }, 404);
      if (req.method === 'GET') return send({ transitions: issue.done ? DONE_TRANSITIONS : OPEN_TRANSITIONS });
      return readBody(req, (raw) => {
        const body = JSON.parse(raw || '{}') as { transition?: { id?: string }; fields?: Record<string, unknown> };
        const id = String(body.transition?.id);
        if (id === '31' && !body.fields?.resolution) {
          return send({ errorMessages: [], errors: { resolution: 'Resolution is required.' } }, 400);
        }
        state.moves.push({ key: issue.key, id, fields: body.fields ?? null });
        issue.done = id === '31';
        res.statusCode = 204;
        res.end();
      });
    }

    if (req.method === 'POST' && path === '/rest/api/3/issue') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const fields = (JSON.parse(raw || '{}') as { fields?: Record<string, unknown> }).fields ?? {};
        const errors: Record<string, string> = {};
        if (!fields[SEVERITY]) errors[SEVERITY] = 'Severity is required.';
        if (!fields[TEAM]) errors[TEAM] = 'Team is required.';
        if (state.requireSquad && !fields[SQUAD]) errors[SQUAD] = 'Squad is required.';
        if (state.requireTags && !(fields[TAGS] as string[] | undefined)?.length) errors[TAGS] = 'Tags is required.';
        if (state.requireParent && !(fields.parent as { key?: string } | undefined)?.key) {
          errors.parent = 'Parent is required.';
        }
        if (Object.keys(errors).length) return send({ errorMessages: [], errors }, 400);
        state.creates.push(fields);
        counter++;
        issues.push({ key: `PROJ-${counter}`, done: false });
        send({ id: String(10000 + counter), key: `PROJ-${counter}` }, 201);
      });
      return;
    }

    const issue = /^\/rest\/api\/3\/issue\/(PROJ-\d+)$/.exec(path);
    if (issue && req.method === 'GET') {
      const done = issues.find((i) => i.key === issue[1])?.done ?? false;
      return send({
        id: String(10000 + Number(issue[1]!.split('-')[1])),
        key: issue[1],
        fields: {
          summary: 'Filed by Piwi',
          status: done
            ? { name: 'Done', statusCategory: { key: 'done' } }
            : { name: 'To Do', statusCategory: { key: 'new' } },
        },
      });
    }

    send({ errorMessages: ['Not found'] }, 404);
  });
  state.server.listen(port, '127.0.0.1');
  return state;
}

/** The failing tests the suite seeds, one cluster each. */
const SEEDED_TESTS = ['refused', 'dialog', 'validator', 'agent', 'parent'] as const;
type SeededTest = (typeof SEEDED_TESTS)[number];

function locationOf(title: SeededTest): string {
  return `checkout.spec.ts:${SEEDED_TESTS.indexOf(title) + 3}:1`;
}

test.describe.serial('Integrations — the fields Jira requires', () => {
  let mock: MockJira;
  let connectionId = 0;
  let projectId = 0;
  /** One failure cluster per test title, so each create starts from nothing. */
  const clusters: Record<string, number> = {};

  function createBody(entityId: number, fields?: Record<string, { value: unknown; label: string }>) {
    return {
      entityType: 'failure_cluster',
      entityId,
      connectionId,
      title: 'Checkout breaks',
      projectKey: 'PROJ',
      issueType: '10004',
      ...(fields ? { fields } : {}),
    };
  }

  test.beforeAll(async ({ request }) => {
    const port = await getFreePort();
    mock = startMockJira(port);
    const tag = uniqueFailureTag();

    const created = await request.post('/api/integrations/connections', {
      data: {
        provider: 'jira',
        name: 'Mock Jira (required fields)',
        baseUrl: `http://127.0.0.1:${port}`,
        credentials: { email: 'ci@piwi.dev', apiToken: 'mock-token' },
      },
    });
    connectionId = (await created.json()).connection.id;

    // Distinct failures → one cluster each to file against.
    const failures: Record<SeededTest, string> = {
      refused: `TimeoutError: locator.click: Timeout 5000ms exceeded. [${tag}]`,
      dialog: `Error: expect(locator).toBeVisible() failed [${tag}]`,
      validator: `TypeError: Cannot read properties of undefined (reading 'total') [${tag}]`,
      agent: `Error: page.goto: net::ERR_CONNECTION_REFUSED [${tag}]`,
      parent: `RangeError: Maximum call stack size exceeded [${tag}]`,
    };
    const submit = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.INTEGRATIONS_REQUIRED_FIELDS,
        status: 'failed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: SEEDED_TESTS.length,
        passedTests: 0,
        failedTests: SEEDED_TESTS.length,
        skippedTests: 0,
        testCases: SEEDED_TESTS.map((title) => ({
          title,
          status: 'failed',
          duration: 500,
          location: locationOf(title),
          error: failures[title],
        })),
      },
    });
    const { runId } = await submit.json();
    const cases = (await (await request.get(`/api/test-runs/${runId}`)).json()).testCases as {
      title: string;
      failureClusterId?: number;
    }[];
    for (const c of cases) if (c.failureClusterId) clusters[c.title] = c.failureClusterId;
    expect(Object.keys(clusters).sort()).toEqual([...SEEDED_TESTS].sort());
    projectId = (await (await request.get(`/api/failure-clusters/${clusters.refused}`)).json()).project.id;

    const bound = await request.put(`/api/projects/${projectId}/integrations`, {
      data: { connectionId, projectKey: 'PROJ', issueType: '10004' },
    });
    expect(bound.ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    if (projectId) await request.put(`/api/projects/${projectId}/integrations`, { data: { connectionId: null } });
    if (connectionId) await request.delete(`/api/integrations/connections/${connectionId}`);
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  test("the fields endpoint reads the issue type's create screen, by id or name", async ({ request }) => {
    const res = await request.get(`/api/integrations/connections/${connectionId}/projects/PROJ/issue-types/Bug/fields`);
    expect(res.ok()).toBe(true);
    const { fields } = (await res.json()) as {
      fields: { id: string; required: boolean; kind: string; options: { label: string }[] | null; typeName: string }[];
    };
    const severity = fields.find((f) => f.id === SEVERITY);
    expect(severity).toMatchObject({ required: true, kind: 'option' });
    expect(severity?.options?.map((o) => o.label)).toEqual(['Critical', 'Major', 'Minor']);
    expect(fields.find((f) => f.id === TEAM)).toMatchObject({
      required: true,
      kind: 'raw',
      typeName: 'atlassian-team',
    });
  });

  test("issue types and people carry Jira's icons, served through the connection and nothing else", async ({
    request,
  }) => {
    const { issueTypes } = await (
      await request.get(`/api/integrations/connections/${connectionId}/projects/PROJ/issue-types`)
    ).json();
    expect(issueTypes).toEqual([{ id: '10004', name: 'Bug', icon: ICON_PATH }]);

    const icon = await request.get(
      `/api/integrations/connections/${connectionId}/icon?path=${encodeURIComponent(ICON_PATH)}`,
    );
    expect(icon.status()).toBe(200);
    expect(icon.headers()['content-type']).toBe('image/svg+xml');
    expect(icon.headers()['content-security-policy']).toContain('sandbox');
    expect(await icon.text()).toBe(ICON_SVG);

    // A person's avatar comes the same way.
    const { users } = await (
      await request.get(`/api/integrations/connections/${connectionId}/assignable?project=PROJ&q=`)
    ).json();
    expect(users[0]).toMatchObject({ id: 'acct-2', icon: USER_AVATAR_PATH });
    const avatar = await request.get(
      `/api/integrations/connections/${connectionId}/icon?path=${encodeURIComponent(USER_AVATAR_PATH)}`,
    );
    expect(avatar.status()).toBe(200);

    const other = await request.get(
      `/api/integrations/connections/${connectionId}/icon?path=${encodeURIComponent('/rest/api/3/myself')}`,
    );
    expect(other.status()).toBe(400);
  });

  test('a create that leaves a required field empty is refused before Jira is called', async ({ request }) => {
    const res = await request.post('/api/integrations/issues', { data: createBody(clusters.refused!) });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'failed', actionId: null });
    expect(body.missingFields.map((f: { name: string }) => f.name)).toEqual(['Severity', 'Team']);
    expect(body.error).toMatch(/^Jira requires Severity and Team for this issue type/);
    expect(mock.creates).toHaveLength(0);
  });

  test('the project settings keep a default for a required field', async ({ page, request }) => {
    await page.goto(`/projects/${projectId}?tab=settings&section=issue-tracker`);
    const block = page.locator('[data-shot="binding-jira-fields"]');
    // The section loads after the page hydrates, then reads the screen from Jira.
    await expect(block.getByText('Jira requires these fields for this issue type')).toBeVisible({ timeout: 30_000 });

    await block.locator(`[data-field-id="${SEVERITY}"] button`).first().click();
    await page.getByRole('option', { name: 'Major' }).click();
    await expect(page.getByRole('listbox')).toBeHidden();
    await page.locator('[data-shot="project-integration-binding"]').getByRole('button', { name: 'Save' }).click();

    await expect
      .poll(async () => {
        const binding = await (await request.get(`/api/projects/${projectId}/integrations`)).json();
        return binding.fieldDefaults?.[SEVERITY] ?? null;
      })
      .toEqual({ value: { id: '10101' }, label: 'Major' });
  });

  test('the create dialog asks for what is still required and files the issue with it', async ({ page }) => {
    mock.requireTags = true;
    try {
      await page.goto(`/failure-clusters/${clusters.dialog}`);
      // The Issue line renders on the server: click once the page is interactive.
      await waitForHydration(page);
      const open = page.locator('[data-shot="issue-line-create"]').first();
      await expect(open).toBeVisible({ timeout: 30_000 });
      await open.click();
      const dialog = page.getByRole('dialog');
      const asked = dialog.locator('[data-shot="create-issue-fields"]');
      await expect(asked).toBeVisible({ timeout: 15_000 });

      // Severity comes from the project default; Team is still empty.
      await expect(asked.locator(`[data-field-id="${SEVERITY}"]`)).toContainText('Major');
      await expect(dialog.getByTestId('create-issue-missing')).toHaveText('Jira still needs Team.');
      const create = dialog.getByRole('button', { name: 'Create', exact: true });
      await expect(create).toBeDisabled();

      await asked.locator(`[data-field-id="${TEAM}"] input`).fill('team-checkout');
      await expect(dialog.getByTestId('create-issue-missing')).toBeHidden();

      // A typed label or tag is kept once "Create" is picked, not dropped.
      const chip = (scope: typeof dialog, text: string) =>
        scope.locator('[data-slot="tagsItemText"]').filter({ hasText: text });
      await dialog.getByTestId('create-issue-labels').fill('checkout-flow');
      await page.getByRole('option', { name: 'Create "checkout-flow"' }).click();
      await expect(chip(dialog, 'checkout-flow')).toBeVisible();

      // Jira refuses the create over Tags, so the dialog asks for it.
      await create.click();
      const tags = asked.locator(`[data-field-id="${TAGS}"]`);
      await expect(tags).toBeVisible({ timeout: 15_000 });
      await tags.locator('input').fill('smoke');
      await page.getByRole('option', { name: 'Create "smoke"' }).click();
      await expect(chip(tags, 'smoke')).toBeVisible();

      await create.click();
      await expect(page.getByText(/PROJ-\d+ created/).first()).toBeVisible();

      expect(mock.creates.at(-1)).toMatchObject({
        [SEVERITY]: { id: '10101' },
        [TEAM]: 'team-checkout',
        [TAGS]: ['smoke'],
        labels: expect.arrayContaining(['checkout-flow']),
      });
    } finally {
      mock.requireTags = false;
    }
  });

  test('a field the screen leaves optional is added on demand, and its issue is searched', async ({ page }) => {
    mock.requireParent = true;
    try {
      await page.goto(`/failure-clusters/${clusters.parent}`);
      await waitForHydration(page);
      const open = page.locator('[data-shot="issue-line-create"]').first();
      await expect(open).toBeVisible({ timeout: 30_000 });
      await open.click();
      const dialog = page.getByRole('dialog');
      const asked = dialog.locator('[data-shot="create-issue-fields"]');
      await expect(asked).toBeVisible({ timeout: 15_000 });
      await asked.locator(`[data-field-id="${TEAM}"] input`).fill('team-checkout');

      // Jira leaves the Parent optional on the screen, so it is not asked for: add it.
      await expect(dialog.locator('[data-field-id="parent"]')).toHaveCount(0);
      await dialog.getByText('Add a field').click();
      await page.keyboard.type('Par');
      await page.getByRole('option', { name: 'Parent', exact: true }).click();
      const parent = dialog.locator('[data-shot="create-issue-added-fields"] [data-field-id="parent"]');
      await expect(parent).toBeVisible();

      // Its input searches the Jira project's issues by key or summary.
      await parent.getByText('Search an issue').click();
      await page.keyboard.type('checkout');
      // Each issue shows its type's icon, as Jira draws it.
      const epic = page.getByRole('option', { name: 'PROJ-7 — Checkout epic' });
      await expect
        .poll(() => epic.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBeGreaterThan(0);
      await epic.click();
      await expect(parent).toContainText('PROJ-7 — Checkout epic');
      expect(mock.pickerQueries).toContainEqual({ query: 'checkout', jql: 'project = "PROJ"' });

      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page.getByText(/PROJ-\d+ created/).first()).toBeVisible();
      expect(mock.creates.at(-1)).toMatchObject({ parent: { key: 'PROJ-7' }, [TEAM]: 'team-checkout' });
    } finally {
      mock.requireParent = false;
    }
  });

  test('a refusal Jira names is final, and creating again replaces it', async ({ request }) => {
    mock.requireSquad = true;
    try {
      const team = { [TEAM]: { value: 'team-checkout', label: 'team-checkout' } };
      const refused = await (
        await request.post('/api/integrations/issues', { data: createBody(clusters.validator!, team) })
      ).json();
      expect(refused.status).toBe('failed');
      expect(refused.fieldErrors).toEqual([{ id: SQUAD, name: 'Squad', message: 'Squad is required.' }]);

      // Failed for good rather than queued for a retry that would be refused the same way.
      const { actions } = await (await request.get(`/api/integrations/actions?projectId=${projectId}`)).json();
      const action = (actions as { id: number; entityId: number; status: string }[]).find(
        (a) => a.entityId === clusters.validator,
      );
      expect(action?.status).toBe('failed');

      const fixed = await (
        await request.post('/api/integrations/issues', {
          data: createBody(clusters.validator!, { ...team, [SQUAD]: { value: 'Payments', label: 'Payments' } }),
        })
      ).json();
      expect(fixed.status).toBe('done');
      expect(fixed.actionId).toBe(action?.id);
      expect(mock.creates.at(-1)).toMatchObject({ [SQUAD]: 'Payments' });
    } finally {
      mock.requireSquad = false;
    }
  });

  test('MCP create_issue names what is missing and takes loosely typed values', async ({ request }) => {
    async function callCreate(fields?: Record<string, unknown>) {
      const res = await request.post('/mcp', {
        data: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'create_issue',
            arguments: { entityType: 'failure_cluster', entityId: clusters.agent, ...(fields ? { fields } : {}) },
          },
        },
      });
      expect(res.ok()).toBe(true);
      return (await res.json()).result as { isError?: boolean; content: { text: string }[] };
    }

    const refused = await callCreate();
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain(`${TEAM} (Team) takes Jira's API value (type atlassian-team)`);

    // A listed value by its name overrides the project default.
    const filed = await callCreate({ [TEAM]: 'team-agent', [SEVERITY]: 'critical' });
    expect(filed.isError).toBeFalsy();
    expect(JSON.parse(filed.content[0]!.text).key).toMatch(/^PROJ-\d+$/);
    expect(mock.creates.at(-1)).toMatchObject({ [SEVERITY]: { id: '10100' }, [TEAM]: 'team-agent' });
  });

  /** A run in which one seeded test passes: its cluster's fix is verified, firing the fix policies. */
  async function passTest(request: import('@playwright/test').APIRequestContext, title: SeededTest) {
    const res = await request.post('/api/test-runs/submit', {
      data: {
        projectName: PROJECT.INTEGRATIONS_REQUIRED_FIELDS,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 500,
        totalTests: 1,
        passedTests: 1,
        failedTests: 0,
        skippedTests: 0,
        testCases: [{ title, status: 'passed', duration: 300, location: locationOf(title) }],
      },
    });
    expect(res.ok()).toBe(true);
  }

  test('the project settings check the fix transition against an open issue and keep its resolution', async ({
    page,
    request,
  }) => {
    await page.goto(`/projects/${projectId}?tab=settings&section=issue-tracker`);
    const binding = page.locator('[data-shot="project-integration-binding"]');
    await expect(binding.getByText('Keep the ticket honest')).toBeVisible({ timeout: 30_000 });
    await binding.getByRole('switch', { name: 'Transition on fix' }).click();

    // With nothing set yet, the transitions an open issue offers are suggested.
    const block = binding.locator('[data-shot="transition-fields-open"]');
    await block.getByRole('button', { name: 'Resolve → Done' }).click({ timeout: 15_000 });
    await expect(binding.getByPlaceholder('transition id or status name (e.g. Done)')).toHaveValue('Done');
    await expect(block.getByTestId('transition-check')).toContainText('moving it to Done requires Resolution');

    await block.locator('[data-field-id="resolution"] button').first().click();
    await page.getByRole('option', { name: 'Fixed' }).click();
    await expect(page.getByRole('listbox')).toBeHidden();
    await binding.getByRole('button', { name: 'Save' }).click();

    await expect
      .poll(async () => {
        const saved = await (await request.get(`/api/projects/${projectId}/integrations`)).json();
        return { transition: saved.policies.fixTransitionId, fields: saved.policies.fixTransitionFields };
      })
      .toEqual({ transition: 'Done', fields: { resolution: { value: { id: '1' }, label: 'Fixed' } } });
  });

  test('the project settings offer only the ticket contents Piwi builds', async ({ page }) => {
    await page.goto(`/projects/${projectId}?tab=settings&section=issue-tracker`);
    const binding = page.locator('[data-shot="project-integration-binding"]');
    await expect(binding.getByText('What the ticket carries')).toBeVisible({ timeout: 30_000 });

    for (const name of ['Diagnosis', 'Suggested patch', 'Shareable report link']) {
      await expect(binding.getByRole('switch', { name })).toBeVisible();
    }
    await expect(binding.getByRole('switch', { name: /screenshot/i })).toHaveCount(0);
  });

  test('a verified fix moves the issue with that resolution', async ({ request }) => {
    await passTest(request, 'dialog');
    await expect
      .poll(() => mock.moves.find((m) => m.id === '31')?.fields ?? null, { timeout: 20_000 })
      .toEqual({ resolution: { id: '1' } });
  });

  test('a move with no resolution fails for good, naming it, without calling Jira', async ({ request }) => {
    const binding = await (await request.get(`/api/projects/${projectId}/integrations`)).json();
    binding.policies.fixTransitionFields = {};
    expect((await request.put(`/api/projects/${projectId}/integrations`, { data: binding })).ok()).toBe(true);
    const movesBefore = mock.moves.length;

    await passTest(request, 'agent');
    await expect
      .poll(
        async () => {
          const { actions } = await (await request.get(`/api/integrations/actions?projectId=${projectId}`)).json();
          const move = (actions as { kind: string; entityId: number; status: string; error: string | null }[]).find(
            (a) => a.kind === 'transition' && a.entityId === clusters.agent,
          );
          return move ? { status: move.status, error: move.error } : null;
        },
        { timeout: 20_000 },
      )
      .toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/^Jira requires Resolution to move PROJ-\d+ to Done\./),
      });
    expect(mock.moves).toHaveLength(movesBefore);
  });
});
