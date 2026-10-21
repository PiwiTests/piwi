import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { JiraClient, JiraError } from '../../server/utils/integrations/jira/client';
import { doc } from '../../shared/integrations/document';

function response(body: unknown, init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {}) {
  const { ok = true, status = 200, headers = {} } = init;
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const client = new JiraClient({ baseUrl: 'https://acme.atlassian.net', email: 'me@acme.io', apiToken: 'tok' });
const body = doc().heading(2, 'Hi').paragraph('there').build();

describe('JiraClient write methods', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  test('createIssue posts ADF and maps the created issue', async () => {
    fetchMock.mockResolvedValueOnce(response({ id: '10001', key: 'PROJ-1' }));
    const issue = await client.createIssue({
      projectKey: 'PROJ',
      issueType: 'Bug',
      title: 'A failure',
      body,
      labels: ['piwi'],
      assigneeId: 'acc-1',
      priority: '3',
      componentId: 'c9',
    });
    expect(issue).toMatchObject({ id: '10001', key: 'PROJ-1', url: 'https://acme.atlassian.net/browse/PROJ-1' });

    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.fields.project).toEqual({ key: 'PROJ' });
    // A non-numeric issue type is sent by name; an id would be sent as { id }.
    expect(sent.fields.issuetype).toEqual({ name: 'Bug' });
    expect(sent.fields.assignee).toEqual({ accountId: 'acc-1' });
    // Priority is only ever sent by id, never an English name.
    expect(sent.fields.priority).toEqual({ id: '3' });
    expect(sent.fields.components).toEqual([{ id: 'c9' }]);
    expect(sent.fields.description.type).toBe('doc');
  });

  test('a numeric issue type is sent by id, for a localized site', async () => {
    fetchMock.mockResolvedValueOnce(response({ id: '10002', key: 'PROJ-2' }));
    await client.createIssue({ projectKey: 'PROJ', issueType: '10001', title: 't', body });
    const sent = JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
    expect(sent.fields.issuetype).toEqual({ id: '10001' });
  });

  test('addComment posts an ADF body to the comment endpoint', async () => {
    fetchMock.mockResolvedValueOnce(response({ id: '1' }));
    await client.addComment('PROJ-1', body);
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-1/comment');
    expect(JSON.parse((init as RequestInit).body as string).body.type).toBe('doc');
  });

  test('attach posts multipart with the no-check token', async () => {
    fetchMock.mockResolvedValueOnce(response([{ id: 'att-1' }]));
    await client.attach('PROJ-1', { name: 'shot.png', bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-1/attachments');
    expect((init as RequestInit).headers).toMatchObject({ 'X-Atlassian-Token': 'no-check' });
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
  });

  test('a 429 throws a JiraError carrying the retry-after seconds', async () => {
    fetchMock.mockResolvedValueOnce(response({}, { ok: false, status: 429, headers: { 'retry-after': '30' } }));
    await expect(client.createIssue({ projectKey: 'P', issueType: 'Bug', title: 't', body })).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 30,
    });
  });

  test("a rejected create carries Jira's field errors and messages", async () => {
    fetchMock.mockResolvedValueOnce(
      response(
        {
          errorMessages: ['Issue type is a sub-task but parent issue key or id not specified.'],
          errors: { customfield_10042: 'Team is required.', labels: "Field 'labels' cannot be set." },
        },
        { ok: false, status: 400 },
      ),
    );
    const err = await client.createIssue({ projectKey: 'P', issueType: 'Bug', title: 't', body }).catch((e) => e);
    expect(err).toMatchObject({ status: 400 });
    expect(err.message).toBe(
      'Jira request failed (400 Error): Issue type is a sub-task but parent issue key or id not specified.; ' +
        "customfield_10042: Team is required.; labels: Field 'labels' cannot be set.",
    );
    expect(err.fieldErrors).toEqual({
      customfield_10042: 'Team is required.',
      labels: "Field 'labels' cannot be set.",
    });
  });

  test('createIssue sends field values under its own fields, which always win', async () => {
    fetchMock.mockResolvedValueOnce(response({ id: '1', key: 'P-1' }));
    await client.createIssue({
      projectKey: 'P',
      issueType: '10001',
      title: 'Real title',
      body,
      fields: { customfield_10050: { id: '10100' }, summary: 'Overridden?' },
    });
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body as string).fields;
    expect(sent.customfield_10050).toEqual({ id: '10100' });
    expect(sent.summary).toBe('Real title');
  });

  test('listCreateFields resolves an issue type name and pages through the create metadata', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ issueTypes: [{ id: '10004', name: 'Bug' }] }))
      .mockResolvedValueOnce(
        response({
          startAt: 0,
          maxResults: 1,
          total: 2,
          fields: [
            { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string', system: 'summary' } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          startAt: 1,
          maxResults: 1,
          total: 2,
          fields: [{ fieldId: 'customfield_10001', name: 'Team', required: true, schema: { type: 'team' } }],
        }),
      );
    const fields = await client.listCreateFields('PROJ', 'bug');
    expect(fields.map((f) => [f.id, f.kind])).toEqual([
      ['summary', 'string'],
      ['customfield_10001', 'raw'],
    ]);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[1]).toBe(
      'https://acme.atlassian.net/rest/api/3/issue/createmeta/PROJ/issuetypes/10004?startAt=0&maxResults=100',
    );
    expect(urls[2]).toContain('startAt=1');
  });

  test('listProjects pages through project search until the last page', async () => {
    const page = (startAt: number, count: number, isLast: boolean) =>
      response({
        startAt,
        maxResults: 50,
        total: 120,
        isLast,
        values: Array.from({ length: count }, (_, i) => ({ id: `${startAt + i}`, key: `P${startAt + i}`, name: 'P' })),
      });
    // Jira serves 50 a page even when asked for 100.
    fetchMock
      .mockResolvedValueOnce(page(0, 50, false))
      .mockResolvedValueOnce(page(50, 50, false))
      .mockResolvedValueOnce(page(100, 20, true));
    const projects = await client.listProjects();
    expect(projects).toHaveLength(120);
    expect(projects.at(-1)).toEqual({ id: '119', key: 'P119', name: 'P', icon: null });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual([
      'https://acme.atlassian.net/rest/api/3/project/search?startAt=0&maxResults=100',
      'https://acme.atlassian.net/rest/api/3/project/search?startAt=50&maxResults=100',
      'https://acme.atlassian.net/rest/api/3/project/search?startAt=100&maxResults=100',
    ]);
  });

  test('listProjects stops after one page when the response has no paging fields', async () => {
    fetchMock.mockResolvedValueOnce(
      response({
        values: [
          {
            id: '1',
            key: 'ABC',
            name: 'Abc',
            avatarUrls: {
              '24x24': 'https://acme.atlassian.net/rest/api/3/universal_avatar/view/type/project/avatar/1',
            },
          },
        ],
      }),
    );
    expect(await client.listProjects()).toEqual([
      { id: '1', key: 'ABC', name: 'Abc', icon: '/rest/api/3/universal_avatar/view/type/project/avatar/1' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('listCreateFields refuses an issue type the project does not have', async () => {
    fetchMock.mockResolvedValueOnce(response({ issueTypes: [{ id: '10004', name: 'Bug' }] }));
    await expect(client.listCreateFields('PROJ', 'Epic')).rejects.toMatchObject({ status: 404 });
  });

  test("a gateway rejection carries its message, such as a scoped token's missing scope", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ code: 401, message: 'Unauthorized; scope does not match' }, { ok: false, status: 401 }),
    );
    const scoped = new JiraClient({
      baseUrl: 'https://acme.atlassian.net',
      email: 'me@acme.io',
      apiToken: 'scoped',
      cloudId: 'cloud-1',
    });
    await expect(scoped.addComment('P-1', body)).rejects.toThrow(
      'Jira request failed (401 Error): Unauthorized; scope does not match',
    );
  });

  test('a non-JSON error body falls back to the status line', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: { get: () => null },
      text: async () => '<html>upstream error</html>',
    } as unknown as Response);
    await expect(client.addComment('P-1', body)).rejects.toThrow(/^Jira request failed \(502 Bad Gateway\)$/);
  });

  test("a rejected attachment carries Jira's explanation", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ errorMessages: ['Attachments are disabled.'] }, { ok: false, status: 403 }),
    );
    await expect(
      client.attach('P-1', { name: 'shot.png', bytes: new Uint8Array([1]), mime: 'image/png' }),
    ).rejects.toThrow('Jira attachment failed (403 Error): Attachments are disabled.');
  });

  test('no error message ever contains the credential', async () => {
    fetchMock.mockResolvedValueOnce(response({}, { ok: false, status: 500 }));
    const err = await client.createIssue({ projectKey: 'P', issueType: 'Bug', title: 't', body }).catch((e) => e);
    expect(err).toBeInstanceOf(JiraError);
    expect(String(err)).not.toContain('tok');
    expect(String(err)).not.toMatch(/Basic /);
  });
});
