import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { probeJiraSite, checkJiraCredentials } = await import('../../server/utils/integrations/jira/check');

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('probeJiraSite', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  test('a Cloud site reports itself and its cloud id', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ baseUrl: 'https://acme.atlassian.net', deploymentType: 'Cloud', serverTitle: 'Acme Jira' }),
      )
      .mockResolvedValueOnce(jsonResponse({ cloudId: 'cloud-1' }));
    const site = await probeJiraSite('https://acme.atlassian.net');
    expect(site).toMatchObject({ ok: true, reachable: true, deploymentType: 'Cloud', title: 'Acme Jira' });
    expect(site.cloudId).toBe('cloud-1');
    expect(site.reportedUrl).toBeNull();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://acme.atlassian.net/rest/api/3/serverInfo',
      'https://acme.atlassian.net/_edge/tenant_info',
    ]);
  });

  test('a site answering under another address reports it', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ baseUrl: 'https://jira.acme.com', deploymentType: 'Cloud' }))
      .mockResolvedValueOnce(jsonResponse({}, 404));
    const site = await probeJiraSite('https://acme.atlassian.net');
    expect(site.reportedUrl).toBe('https://jira.acme.com');
    expect(site.cloudId).toBeNull();
  });

  test('a Data Center site answers on v2 and is refused with a reason', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse({ deploymentType: 'DataCenter', serverTitle: 'Corp' }));
    const site = await probeJiraSite('https://jira.corp.example');
    expect(site).toMatchObject({ ok: false, reachable: true, deploymentType: 'DataCenter' });
    expect(site.hint).toMatch(/Jira Cloud/);
  });

  test('a 404 everywhere is not a Jira site', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 404));
    const site = await probeJiraSite('https://nobody.atlassian.net');
    expect(site).toMatchObject({ ok: false, reachable: true });
    expect(site.hint).toMatch(/atlassian\.net/);
  });

  test('an unreachable address is flagged so the credential step is skipped', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }));
    const site = await probeJiraSite('https://typo.example');
    expect(site).toMatchObject({ ok: false, reachable: false });
    expect(site.error).toContain('ENOTFOUND');
  });
});

describe('checkJiraCredentials', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  test('a classic token signs in on the site and counts the projects', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accountId: 'a1', displayName: 'Ada' }))
      .mockResolvedValueOnce(jsonResponse({ values: [{ id: '1', key: 'ABC', name: 'Alpha' }] }));
    const result = await checkJiraCredentials('https://classic-check.atlassian.net', {
      email: 'ada@acme.io',
      apiToken: 'classic',
    });
    expect(result.auth).toMatchObject({ ok: true, tokenKind: 'classic', account: { displayName: 'Ada' } });
    expect(result.projects).toMatchObject({ ok: true, count: 1, keys: ['ABC'], hint: null });
  });

  test('a scoped token is recognized by its detour through the gateway', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401)) // site /myself
      .mockResolvedValueOnce(jsonResponse({ cloudId: 'cloud-9' })) // tenant_info
      .mockResolvedValueOnce(jsonResponse({ accountId: 'a2', displayName: 'Bea' })) // gateway /myself
      .mockResolvedValueOnce(jsonResponse({ values: [] })); // gateway project search
    const result = await checkJiraCredentials('https://scoped-check.atlassian.net', {
      email: 'bea@acme.io',
      apiToken: 'scoped',
    });
    expect(result.auth).toMatchObject({ ok: true, tokenKind: 'scoped' });
    expect(fetchMock.mock.calls[3]![0]).toBe(
      'https://api.atlassian.com/ex/jira/cloud-9/rest/api/3/project/search?startAt=0&maxResults=100',
    );
    expect(result.projects).toMatchObject({ ok: true, count: 0 });
    expect(result.projects?.hint).toMatch(/Browse Projects/);
  });

  test('a scoped token without a scope gets the scope list', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ cloudId: 'cloud-7' }))
      .mockResolvedValueOnce(jsonResponse({ message: 'Unauthorized; scope does not match' }, 401));
    const result = await checkJiraCredentials('https://noscope-check.atlassian.net', {
      email: 'c@acme.io',
      apiToken: 'scoped-missing',
    });
    expect(result.auth?.ok).toBe(false);
    expect(result.auth?.hint).toContain('read:jira-user');
    expect(result.projects).toBeUndefined();
  });
});
