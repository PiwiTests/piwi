import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { INTEGRATION_PROVIDERS } from '../../shared/integrations/registry';
import { IntegrationHttpError } from '../../server/utils/integrations/http-error';
import {
  ZEPHYR_MAX_PAGES,
  ZEPHYR_TIMEOUT_STATUS,
  ZephyrScaleClient,
  ZephyrScaleError,
} from '../../server/utils/integrations/test-management/zephyr-scale';

/**
 * The Zephyr Scale Cloud client against a stubbed `fetch`. The bodies are in `tests/fixtures/zephyr-scale/`, each
 * written from a schema of SmartBear's public OpenAPI document and named in the file's `_spec` field.
 */

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.secret-payload.secret-signature';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/zephyr-scale/${name}.json`, import.meta.url), 'utf8'));
}

function reply(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
const client = () => {
  const made = ZephyrScaleClient.forRegion('us', { apiToken: TOKEN });
  if (!made) throw new Error('client not built');
  return made;
};
const requested = (call = 0) => new URL(String(fetchMock.mock.calls[call]![0]));

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ZephyrScaleClient.forRegion', () => {
  test('calls the host of each registry region and no other', async () => {
    for (const region of INTEGRATION_PROVIDERS['zephyr-scale'].endpoint.regions) {
      fetchMock.mockResolvedValueOnce(reply(fixture('projects-first')));
      await ZephyrScaleClient.forRegion(region.id, { apiToken: TOKEN })!.whoAmI();
      expect(String(fetchMock.mock.calls.at(-1)![0]).startsWith(`${region.baseUrl}/projects?`)).toBe(true);
    }
  });

  test('is null for a region the registry does not list', () => {
    expect(ZephyrScaleClient.forRegion('mars', { apiToken: TOKEN })).toBeNull();
    expect(ZephyrScaleClient.forRegion('https://evil.example', { apiToken: TOKEN })).toBeNull();
  });

  test('is null for a token that cannot be sent as a header value', () => {
    expect(ZephyrScaleClient.forRegion('us', { apiToken: '' })).toBeNull();
    expect(ZephyrScaleClient.forRegion('us', { apiToken: 'abc\r\nX-Injected: 1' })).toBeNull();
    expect(ZephyrScaleClient.forRegion('us', { apiToken: 'two words' })).toBeNull();
  });
});

describe('whoAmI', () => {
  test('reads one project with a Bearer token and names the region', async () => {
    fetchMock.mockResolvedValueOnce(reply(fixture('projects-first')));
    expect(await client().whoAmI()).toEqual({
      id: 'zephyr-scale:us',
      displayName: 'Zephyr Scale Cloud (United States)',
    });

    const url = requested();
    expect(url.origin + url.pathname).toBe('https://api.zephyrscale.smartbear.com/v2/projects');
    expect(url.searchParams.get('maxResults')).toBe('1');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('listProjects', () => {
  test('follows the pages until isLast and maps the neutral type', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(fixture('projects-page-1')))
      .mockResolvedValueOnce(reply(fixture('projects-page-2')));
    expect(await client().listProjects()).toEqual([
      { id: '10001', key: 'SHOP', enabled: true },
      { id: '10002', key: 'OLD', enabled: false },
      { id: '10003', key: 'WEB_APP', enabled: true },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requested(0).searchParams.get('startAt')).toBe('0');
    expect(requested(1).searchParams.get('startAt')).toBe('2');
    expect(requested(1).searchParams.get('maxResults')).toBe('1000');
  });

  test('stops when startAt plus the values reaches total, without isLast', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ startAt: 0, maxResults: 1000, total: 2, values: fixture('projects-page-1').values }),
    );
    expect(await client().listProjects()).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('stops on an empty page even when the server never says it is the last', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ ...fixture('projects-page-1'), total: undefined }))
      .mockResolvedValueOnce(reply({ startAt: 2, maxResults: 2, isLast: false, values: [] }));
    expect(await client().listProjects()).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('stops at the page cap when the server never says it is the last', async () => {
    // Without the cap this would never end: the stub throws past the cap so a missing cap fails the assertions below.
    fetchMock.mockImplementation(async () => {
      if (fetchMock.mock.calls.length > ZEPHYR_MAX_PAGES + 5) throw new Error('the page cap did not stop the read');
      return reply({ ...fixture('projects-page-1'), next: 'https://more', total: undefined });
    });
    const read = client().listProjects();
    await expect(read).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining(`${ZEPHYR_MAX_PAGES} pages`),
    });
    expect(fetchMock).toHaveBeenCalledTimes(ZEPHYR_MAX_PAGES);
  });

  test('treats an answer without values as an error, not an empty list', async () => {
    fetchMock.mockResolvedValueOnce(reply({ startAt: 0, maxResults: 1000 }));
    await expect(client().listProjects()).rejects.toMatchObject({ status: 502 });
  });
});

describe('listCases', () => {
  const casesFetch = () =>
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/statuses')) return reply(fixture('statuses-test-case'));
      return reply(fixture(url.searchParams.get('startAt') === '0' ? 'testcases-page-1' : 'testcases-page-2'));
    });

  test('returns one page of neutral cases with the status named and a cursor for the next', async () => {
    casesFetch();
    const page = await client().listCases('SHOP', null);
    expect(page).toEqual({
      items: [
        { id: '30001', key: 'SHOP-T1', name: 'Checkout with a saved card', status: 'Approved', folderId: '40001' },
        { id: '30002', key: 'SHOP-T2', name: 'Search finds a product', status: 'Draft', folderId: null },
      ],
      next: '2',
    });
    const testcases = fetchMock.mock.calls
      .map((c) => new URL(String(c[0])))
      .find((u) => u.pathname.endsWith('/testcases'))!;
    expect(testcases.searchParams.get('projectKey')).toBe('SHOP');
    expect(testcases.searchParams.get('startAt')).toBe('0');
    expect(testcases.searchParams.get('maxResults')).toBe('1000');
  });

  test('resumes from the cursor, ends with a null cursor, and leaves an unknown status null', async () => {
    casesFetch();
    const page = await client().listCases('SHOP', '2');
    expect(page.items).toEqual([
      { id: '30003', key: 'SHOP-T3', name: 'Cart keeps items after sign-in', status: null, folderId: '40002' },
    ]);
    expect(page.next).toBeNull();
  });

  test('names the statuses with one call per page, not one per case', async () => {
    casesFetch();
    await client().listCases('SHOP', null);
    const statusCalls = fetchMock.mock.calls
      .map((c) => new URL(String(c[0])))
      .filter((u) => u.pathname.endsWith('/statuses'));
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]!.searchParams.get('statusType')).toBe('TEST_CASE');
    expect(statusCalls[0]!.searchParams.get('projectKey')).toBe('SHOP');
  });

  test('refuses a project key that is not a Jira key before any call', async () => {
    for (const key of ['shop', 'SHOP&maxResults=1', 'S', '../projects', 'SHOP KEY', '']) {
      await expect(client().listCases(key, null)).rejects.toThrow('Invalid project key');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('refuses a cursor this client did not issue before any call', async () => {
    for (const cursor of ['abc', '-1', '1.5', '99999999999', '2 OR 1']) {
      await expect(client().listCases('SHOP', cursor)).rejects.toThrow('Invalid page cursor');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('listStatuses', () => {
  test('returns the execution statuses without the archived ones, and flags the default', async () => {
    fetchMock.mockResolvedValueOnce(reply(fixture('statuses-test-execution')));
    expect(await client().listStatuses('SHOP')).toEqual([
      { id: '20000', name: 'Not Executed', isDefault: true },
      { id: '20001', name: 'In Progress', isDefault: false },
      { id: '20002', name: 'Pass', isDefault: false },
      { id: '20003', name: 'Fail', isDefault: false },
    ]);
    expect(requested().searchParams.get('statusType')).toBe('TEST_EXECUTION');
  });
});

describe('listFolders', () => {
  test('returns the test cycle folders with their parents', async () => {
    fetchMock.mockResolvedValueOnce(reply(fixture('folders-test-cycle')));
    expect(await client().listFolders('SHOP')).toEqual([
      { id: '40001', name: 'Nightly', parentId: null },
      { id: '40002', name: 'Release 4.2', parentId: '40001' },
    ]);
    expect(requested().searchParams.get('folderType')).toBe('TEST_CYCLE');
    expect(requested().searchParams.get('projectKey')).toBe('SHOP');
  });

  test('refuses a project key that is not one', async () => {
    await expect(client().listFolders('shop;drop')).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

test('caseUrl names no address: Zephyr documents no web URL for a case', () => {
  expect(client().caseUrl()).toBeNull();
});

describe('failures', () => {
  const failure = async (response: Response | Error): Promise<ZephyrScaleError> => {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockResolvedValueOnce(response);
    const err = await client()
      .listProjects()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(IntegrationHttpError);
    expect(err).toBeInstanceOf(ZephyrScaleError);
    return err as ZephyrScaleError;
  };

  test('401 carries Zephyr’s explanation, from either body shape', async () => {
    const withCode = await failure(reply(fixture('error-unauthorized'), { status: 401 }));
    expect(withCode.status).toBe(401);
    expect(withCode.message).toBe(
      'Zephyr Scale refused the API token (401): Authentication credentials are missing or invalid.',
    );
    const gateway = await failure(reply(fixture('error-missing-authorization'), { status: 401 }));
    expect(gateway.status).toBe(401);
    expect(gateway.message).toBe('Zephyr Scale refused the API token (401): Unauthorized');
  });

  test('403 is a refusal with the missing permission', async () => {
    const err = await failure(reply(fixture('error-forbidden'), { status: 403 }));
    expect(err.status).toBe(403);
    expect(err.message).toContain('Browse Projects');
    expect(err.retryAfterMs).toBeUndefined();
  });

  test('404 reads the project that was not found', async () => {
    const err = await failure(reply(fixture('error-project-not-found'), { status: 404 }));
    expect(err.status).toBe(404);
    expect(err.message).toContain('The project ZZZ does not exist');
  });

  test('429 with Retry-After in seconds', async () => {
    const err = await failure(reply('', { status: 429, headers: { 'Retry-After': '30' } }));
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(30_000);
  });

  test('429 with Retry-After as an HTTP date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T06:00:00Z'));
    const err = await failure(reply('', { status: 429, headers: { 'Retry-After': 'Sun, 08 Nov 2026 06:00:30 GMT' } }));
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(30_000);
  });

  test('429 without Retry-After leaves the wait to the caller', async () => {
    const err = await failure(reply('', { status: 429 }));
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBeUndefined();
  });

  test('500 carries the status and Zephyr’s message', async () => {
    const err = await failure(reply(fixture('error-server'), { status: 500 }));
    expect(err.status).toBe(500);
    expect(err.message).toContain('An unexpected error occurred');
  });

  test('a body that is not JSON still gives the status, with or without a status text', async () => {
    const bare = await failure(reply('<html>Bad gateway</html>', { status: 502 }));
    expect(bare.status).toBe(502);
    expect(bare.message).toBe('Zephyr Scale request failed (502)');
    const named = await failure(new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    expect(named.message).toBe('Zephyr Scale request failed (502 Bad Gateway)');
  });

  test('a timeout is a 504 that names the budget', async () => {
    const err = await failure(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
    );
    expect(err.status).toBe(ZEPHYR_TIMEOUT_STATUS);
    expect(err.message).toBe('Zephyr Scale did not answer within 120 seconds');
  });

  test('a client given a shorter budget names that budget', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    const err = await ZephyrScaleClient.forRegion('us', { apiToken: TOKEN }, { timeoutMs: 10_000 })!
      .whoAmI()
      .then(
        () => null,
        (e: unknown) => e as ZephyrScaleError,
      );
    expect(err).toMatchObject({
      status: ZEPHYR_TIMEOUT_STATUS,
      message: 'Zephyr Scale did not answer within 10 seconds',
    });
  });

  test('a timeout while the body is read is the same 504, not a body that is not JSON', async () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      const response = reply({ values: [] });
      vi.spyOn(response, 'json').mockRejectedValue(Object.assign(new Error('aborted'), { name }));
      const err = await failure(response);
      expect(err.status).toBe(ZEPHYR_TIMEOUT_STATUS);
      expect(err.message).toBe('Zephyr Scale did not answer within 120 seconds');
    }
  });

  test('an answer that is not JSON on a 200 is an error', async () => {
    const err = await failure(reply('not json'));
    expect(err.status).toBe(502);
  });

  test('a network failure passes through unchanged', async () => {
    const down = new TypeError('fetch failed');
    fetchMock.mockRejectedValueOnce(down);
    await expect(client().listProjects()).rejects.toBe(down);
  });

  test('no error string holds the token, even when Zephyr echoes it back', async () => {
    const echoes = [
      reply({ errorCode: 401, message: `Invalid token ${TOKEN}` }, { status: 401 }),
      reply({ error: `Bad bearer ${TOKEN}` }, { status: 401 }),
      reply({ errorCode: 500, message: `${TOKEN}` }, { status: 500 }),
    ];
    for (const response of echoes) {
      const err = await failure(response);
      expect(err.message).not.toContain(TOKEN);
      expect(err.message).not.toContain('secret-payload');
      expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(TOKEN);
    }
  });

  test('an explanation longer than the cap is cut', async () => {
    const err = await failure(reply({ errorCode: 500, message: 'x'.repeat(5000) }, { status: 500 }));
    expect(err.message.length).toBeLessThan(700);
  });
});
