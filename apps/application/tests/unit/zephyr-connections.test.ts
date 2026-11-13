import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as schema from '../../server/database/schema.sqlite';
import { INTEGRATION_PROVIDERS, connectionBaseUrl } from '../../shared/integrations/registry';
import { getEnvVarMeta } from '../../shared/piwi-env-vars';
import { openTempDb, type TempDb } from './temp-db';

/**
 * A Zephyr Scale Cloud connection through the connection layer: its factory, its checks, its environment-managed
 * form, and every place that reads `integration_connections` as if each row were Jira.
 */

delete process.env.PIWI_DATABASE_URL;
process.env.PIWI_SECRET_KEY = 'unit-test-secret-key-not-for-production';

const {
  createConnection,
  updateConnection,
  listConnections,
  getConnectionRow,
  createTracker,
  createTestManagement,
  testManagementForRow,
  trackerForRow,
  listTrackerConnections,
  ensureEnvManagedConnections,
  testConnection,
  regionCredentialsForCheck,
  setWebhookToken,
  connectionByWebhookToken,
  resolveJiraUnfurlConfig,
} = await import('../../server/utils/integrations/connections');
const { CONNECTION_CHECKS, ConnectionCheckRefusal } = await import('../../server/utils/integrations/connection-check');
const { detectProviderWithConnection } = await import('../../server/utils/integrations/link-resolve');
const { ZephyrScaleClient } = await import('../../server/utils/integrations/test-management/zephyr-scale');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.zephyr-payload.zephyr-signature';
const OTHER_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.other-payload.other-signature';

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/zephyr-scale/${name}.json`, import.meta.url), 'utf8'));
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Every call sent to Zephyr, with the token it carried. */
const sent: { url: URL; token: string | null }[] = [];
let accepted: string[] = [TOKEN];
const zephyrFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const token = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace('Bearer ', '') ?? null;
  sent.push({ url, token });
  if (!token || !accepted.includes(token)) return json(fixture('error-unauthorized'), 401);
  const first = url.searchParams.get('maxResults') === '1';
  return json(fixture(first ? 'projects-first' : 'projects-page-2'));
};
const fetchMock = vi.fn(zephyrFetch);

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
});
afterAll(async () => {
  await close();
  delete process.env.PIWI_SECRET_KEY;
});
beforeEach(async () => {
  accepted = [TOKEN];
  sent.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(zephyrFetch);
  vi.stubGlobal('fetch', fetchMock);
  await db.delete(schema.integrationConnections);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PIWI_ZEPHYR_API_TOKEN;
  delete process.env.PIWI_ZEPHYR_REGION;
  delete process.env.PIWI_JIRA_BASE_URL;
  delete process.env.PIWI_JIRA_EMAIL;
  delete process.env.PIWI_JIRA_API_TOKEN;
});

const zephyr = (overrides: Partial<Parameters<typeof createConnection>[1]> = {}) =>
  createConnection(db as never, {
    provider: 'zephyr-scale',
    name: 'Zephyr',
    baseUrl: 'https://api.zephyrscale.smartbear.com/v2',
    config: { region: 'us' },
    credentials: { apiToken: TOKEN },
    ...overrides,
  });
const jira = (site = 'acme') =>
  createConnection(db as never, {
    provider: 'jira',
    name: 'Jira',
    baseUrl: `https://${site}.atlassian.net`,
    credentials: { email: 'ci@example.com', apiToken: 'jira-token' },
  });

describe('the registry entry', () => {
  const entry = INTEGRATION_PROVIDERS['zephyr-scale'];

  test('is a test management provider reached on four regional hosts', () => {
    expect(entry.kind).toBe('test-management');
    expect(entry.endpoint.kind).toBe('region');
    expect(entry.endpoint.regions.map((r) => r.id)).toEqual(['us', 'eu', 'au', 'de']);
    for (const region of entry.endpoint.regions) {
      expect(connectionBaseUrl('zephyr-scale', { region: region.id })).toEqual({
        baseUrl: region.baseUrl,
        region: region.id,
      });
      expect(new URL(region.baseUrl).protocol).toBe('https:');
      expect(region.baseUrl.endsWith('.api.zephyrscale.smartbear.com/v2') || region.id === 'us').toBe(true);
    }
  });

  test('has no host the administrator can type, and asks for the token only', () => {
    expect(connectionBaseUrl('zephyr-scale', { baseUrl: 'https://attacker.example/v2', region: 'eu' })).toEqual({
      baseUrl: 'https://eu.api.zephyrscale.smartbear.com/v2',
      region: 'eu',
    });
    expect(connectionBaseUrl('zephyr-scale', { baseUrl: 'https://attacker.example/v2' })).toHaveProperty('error');
    expect(connectionBaseUrl('zephyr-scale', { region: 'mars' })).toHaveProperty('error');
    expect(entry.credentialFields.map((f) => [f.key, f.secret, f.required])).toEqual([['apiToken', true, true]]);
  });

  test('offers every region the environment variable accepts, and no other', () => {
    const region = getEnvVarMeta('PIWI_ZEPHYR_REGION');
    expect(region.type).toBe('enum');
    expect(region.enum).toEqual(entry.endpoint.regions.map((r) => r.id));
    expect(region.default).toBe('us');
    expect(getEnvVarMeta('PIWI_ZEPHYR_API_TOKEN')).toMatchObject({ secret: true });
  });
});

describe('the factory', () => {
  test('builds a client on the host of the connection’s region', async () => {
    const created = await zephyr({ baseUrl: 'https://eu.api.zephyrscale.smartbear.com/v2', config: { region: 'eu' } });
    const client = await createTestManagement(db as never, created.id);
    expect(client).toBeInstanceOf(ZephyrScaleClient);
    await client!.whoAmI();
    expect(sent[0]!.url.host).toBe('eu.api.zephyrscale.smartbear.com');
    expect(sent[0]!.token).toBe(TOKEN);
  });

  test('ignores the stored address: only the region reaches a host', async () => {
    const created = await zephyr({ baseUrl: 'https://attacker.example/v2', config: { region: 'au' } });
    await (await createTestManagement(db as never, created.id))!.whoAmI();
    expect(sent.map((s) => s.url.host)).toEqual(['au.api.zephyrscale.smartbear.com']);
  });

  test('is null without a token, without a known region, for a missing row, and for a tracker', async () => {
    const noToken = await zephyr({ credentials: null });
    const noRegion = await zephyr({ config: null });
    const badRegion = await zephyr({ config: { region: 'mars' } });
    for (const id of [noToken.id, noRegion.id, badRegion.id, 9999, (await jira()).id]) {
      expect(await createTestManagement(db as never, id)).toBeNull();
    }
  });

  test('is never built for a tracker, and a tracker is never built for Zephyr, whatever credentials it holds', async () => {
    const connection = await zephyr({ credentials: { apiToken: TOKEN, email: 'ci@example.com' } });
    expect(await createTracker(db as never, connection.id)).toBeNull();
    expect(trackerForRow((await getConnectionRow(db as never, connection.id))!)).toBeNull();
    const row = (await getConnectionRow(db as never, (await jira()).id))!;
    expect(testManagementForRow(row)).toBeNull();
  });
});

describe('CONNECTION_CHECKS', () => {
  test('has a check for every provider', () => {
    expect(Object.keys(CONNECTION_CHECKS).sort()).toEqual(Object.keys(INTEGRATION_PROVIDERS).sort());
  });

  test('Zephyr without a token only names the region', async () => {
    const result = await CONNECTION_CHECKS['zephyr-scale'](db as never, { region: 'de' });
    expect(result).toMatchObject({
      baseUrl: 'https://de.api.zephyrscale.smartbear.com/v2',
      site: { ok: true, reachable: true, title: 'Germany' },
    });
    expect(result.auth).toBeUndefined();
    expect(sent).toEqual([]);
  });

  test('Zephyr reports a token a header cannot carry, and keeps the bare site only for no token at all', async () => {
    for (const apiToken of ['two words', '   ', 'abc\r\nX-Injected: 1']) {
      const result = await CONNECTION_CHECKS['zephyr-scale'](db as never, { region: 'us', credentials: { apiToken } });
      expect(result.site.ok).toBe(true);
      expect(result.auth).toEqual({ ok: false, error: 'The token holds characters a header cannot carry.' });
      expect(result.projects).toBeUndefined();
    }
    const none = await CONNECTION_CHECKS['zephyr-scale'](db as never, { region: 'us', credentials: { apiToken: '' } });
    expect(none.auth).toBeUndefined();
    expect(sent).toEqual([]);
  });

  test('Zephyr signs in on the region’s host and counts the enabled projects', async () => {
    accepted = [TOKEN];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent.push({ url, token: (headers.Authorization ?? '').replace('Bearer ', '') });
      return json(url.searchParams.get('maxResults') === '1' ? fixture('projects-first') : fixture('projects-page-2'));
    });
    const result = await CONNECTION_CHECKS['zephyr-scale'](db as never, {
      region: 'eu',
      credentials: { apiToken: TOKEN },
    });
    expect(result.auth).toMatchObject({ ok: true, account: { id: 'zephyr-scale:eu' } });
    expect(result.projects).toMatchObject({ ok: true, count: 1, keys: ['WEB_APP'] });
    expect(new Set(sent.map((s) => s.url.host))).toEqual(new Set(['eu.api.zephyrscale.smartbear.com']));
  });

  test('Zephyr turns a refused token into a hint, and a dead network into an unreachable site', async () => {
    const refused = await CONNECTION_CHECKS['zephyr-scale'](db as never, {
      region: 'us',
      credentials: { apiToken: OTHER_TOKEN },
    });
    expect(refused.site.ok).toBe(true);
    expect(refused.auth).toMatchObject({ ok: false, hint: expect.stringContaining('refused the token') });
    expect(JSON.stringify(refused)).not.toContain(OTHER_TOKEN);

    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }));
    const down = await CONNECTION_CHECKS['zephyr-scale'](db as never, {
      region: 'us',
      credentials: { apiToken: TOKEN },
    });
    expect(down.site).toMatchObject({ ok: false, reachable: false });
    expect(down.auth).toBeUndefined();
  });

  test('Zephyr refuses an unknown region, and ignores a typed address', async () => {
    await expect(CONNECTION_CHECKS['zephyr-scale'](db as never, { region: 'mars' })).rejects.toBeInstanceOf(
      ConnectionCheckRefusal,
    );
    await expect(
      CONNECTION_CHECKS['zephyr-scale'](db as never, { baseUrl: 'https://attacker.example/v2' }),
    ).rejects.toBeInstanceOf(ConnectionCheckRefusal);
    expect(sent).toEqual([]);
  });

  test('Jira keeps checking the typed site', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      sent.push({ url: new URL(String(input)), token: null });
      return json({ deploymentType: 'Cloud', serverTitle: 'Acme' });
    });
    const result = await CONNECTION_CHECKS.jira(db as never, { baseUrl: 'https://acme.atlassian.net' });
    expect(result.site).toMatchObject({ ok: true, deploymentType: 'Cloud' });
    expect(sent[0]!.url.pathname).toBe('/rest/api/3/serverInfo');
  });
});

describe('regionCredentialsForCheck', () => {
  const check = (input: Partial<Parameters<typeof regionCredentialsForCheck>[1]>) =>
    regionCredentialsForCheck(db as never, { provider: 'zephyr-scale', region: 'us', ...input });

  test('a typed token wins', async () => {
    const stored = await zephyr();
    expect(await check({ credentials: { apiToken: OTHER_TOKEN }, connectionId: stored.id })).toEqual({
      apiToken: OTHER_TOKEN,
    });
  });

  test('a blank token is taken from the connection being edited while its region is unchanged', async () => {
    const stored = await zephyr();
    expect(await check({ credentials: { apiToken: '' }, connectionId: stored.id })).toEqual({ apiToken: TOKEN });
    expect(await check({ connectionId: stored.id })).toEqual({ apiToken: TOKEN });
  });

  test('a blank token is not sent to another region', async () => {
    const stored = await zephyr();
    expect(await check({ region: 'eu', credentials: { apiToken: '' }, connectionId: stored.id })).toBeNull();
  });

  test('a blank token is never taken from another provider’s connection, or from no connection', async () => {
    const other = await createConnection(db as never, {
      provider: 'jira',
      name: 'Jira at the same address',
      baseUrl: 'https://api.zephyrscale.smartbear.com/v2',
      credentials: { email: 'ci@example.com', apiToken: 'jira-token' },
    });
    expect(await check({ connectionId: other.id })).toBeNull();
    expect(await check({ connectionId: 9999 })).toBeNull();
    expect(await check({})).toBeNull();
  });

  test('an unknown region has no credentials', async () => {
    const stored = await zephyr();
    expect(await check({ region: 'mars', credentials: { apiToken: TOKEN }, connectionId: stored.id })).toBeNull();
  });
});

describe('the Check and Test budget', () => {
  /**
   * The budgets run on a virtual clock: every budget a signal was made with is recorded with its deadline, and a call
   * answering after `ms` moves the clock to its answer, or to the first deadline before it, which aborts.
   */
  const budgets: number[] = [];
  const deadlines: { at: number; controller: AbortController }[] = [];
  let now = 0;
  beforeEach(() => {
    budgets.length = 0;
    deadlines.length = 0;
    now = 0;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      budgets.push(ms);
      const controller = new AbortController();
      deadlines.push({ at: now + ms, controller });
      return controller.signal;
    });
  });

  /** A call that answers `ms` later on the virtual clock, or fails with the signal's reason when a deadline comes first. */
  const answerAfter = (ms: number, body: () => Response) => (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason));
      const due = deadlines.filter((d) => !d.controller.signal.aborted && d.at <= now + ms);
      if (due.length === 0) {
        now += ms;
        resolve(body());
        return;
      }
      now = Math.min(...due.map((d) => d.at));
      for (const d of due) {
        if (d.at <= now) d.controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      }
    });

  test('the check gives up on a host that never answers within the short budget', async () => {
    fetchMock.mockImplementation(answerAfter(60_000, () => json({})));
    const result = await CONNECTION_CHECKS['zephyr-scale'](db as never, {
      region: 'us',
      credentials: { apiToken: TOKEN },
    });
    expect(result.site).toMatchObject({ ok: false, reachable: false, hint: expect.stringContaining('proxy') });
    expect(result.site.error).toContain('within 10 seconds');
    expect(budgets).not.toContain(120_000);
    expect(now).toBe(10_000);
  });

  test('the check’s budget covers every page of projects after the sign-in, not each page', async () => {
    const page = () => json({ ...fixture('projects-page-1'), isLast: false, next: 'more', total: undefined });
    const pages: URL[] = [];
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.searchParams.get('maxResults') === '1') return Promise.resolve(json(fixture('projects-first')));
      pages.push(url);
      return answerAfter(3_000, page)(input, init);
    });
    const result = await CONNECTION_CHECKS['zephyr-scale'](db as never, {
      region: 'us',
      credentials: { apiToken: TOKEN },
    });
    expect(result.auth).toMatchObject({ ok: true });
    expect(result.projects).toMatchObject({ ok: false, hint: expect.stringContaining('proxy') });
    // Three pages answer within the 10 s and the fourth is cut at the deadline, though each fits a budget of its own.
    expect(pages).toHaveLength(4);
    expect(now).toBe(10_000);
  });

  test('Test gives up within the short budget and records the failure', async () => {
    const created = await zephyr();
    fetchMock.mockImplementation(answerAfter(60_000, () => json({})));
    const result = await testConnection(db as never, created.id);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('within 10 seconds') });
    expect((await getConnectionRow(db as never, created.id))!.status).toBe('failed');
    // The request's own budget and the whole check's, both the short one.
    expect(budgets).toEqual([10_000, 10_000]);
    expect(now).toBe(10_000);
  });

  test('a request whose wait used up the budget is not sent, and says it timed out', async () => {
    const calls = sent.length;
    const budget = new AbortController();
    const client = ZephyrScaleClient.forRegion(
      'us',
      { apiToken: TOKEN },
      {
        timeoutMs: 1000,
        signal: budget.signal,
        beforeRequest: async () => budget.abort(new DOMException('', 'TimeoutError')),
      },
    );
    await expect(client.whoAmI()).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining('did not answer within 1 seconds'),
    });
    expect(sent).toHaveLength(calls);
  });

  test('a client built for later work keeps the long budget', async () => {
    const created = await zephyr();
    const row = await getConnectionRow(db as never, created.id);
    fetchMock.mockImplementation(async () => json(fixture('projects-first')));
    await testManagementForRow(row!)!.whoAmI();
    expect(budgets).toEqual([120_000]);
  });
});

describe('testConnection', () => {
  test('a Zephyr connection signs in on its own host and records the success', async () => {
    const created = await zephyr();
    expect(await testConnection(db as never, created.id)).toEqual({
      ok: true,
      account: { id: 'zephyr-scale:us', displayName: 'Zephyr Scale Cloud (United States)' },
    });
    const row = await getConnectionRow(db as never, created.id);
    expect(row).toMatchObject({ status: 'ok', lastError: null });
    expect(row!.lastCheckedAt).toBeTruthy();
    expect(sent.map((s) => s.url.host)).toEqual(['api.zephyrscale.smartbear.com']);
  });

  test('a 401 marks the connection failed with a hint, and the token stays out of what is stored', async () => {
    const created = await zephyr({ credentials: { apiToken: OTHER_TOKEN } });
    const result = await testConnection(db as never, created.id);
    expect(result).toMatchObject({ ok: false, hint: expect.stringContaining('refused the token') });
    const row = await getConnectionRow(db as never, created.id);
    expect(row).toMatchObject({ status: 'failed' });
    expect(row!.lastError).toContain('401');
    expect(`${row!.lastError}${JSON.stringify(result)}`).not.toContain(OTHER_TOKEN);
  });

  test('a connection without a token says so and calls nothing', async () => {
    const created = await zephyr({ credentials: null });
    expect(await testConnection(db as never, created.id)).toEqual({
      ok: false,
      error: 'No credentials configured for this connection.',
    });
    expect(sent).toEqual([]);
  });

  test('a stored token a header cannot carry is reported as that, not as no credentials', async () => {
    const created = await zephyr({ credentials: { apiToken: 'two words' } });
    expect(await testConnection(db as never, created.id)).toEqual({
      ok: false,
      error: 'The token holds characters a header cannot carry.',
    });
    expect(sent).toEqual([]);
  });

  test('a Jira connection is still tested through Jira', async () => {
    const created = await jira();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      sent.push({ url: new URL(String(input)), token: null });
      return json({ accountId: 'a1', displayName: 'Ada' });
    });
    expect(await testConnection(db as never, created.id)).toMatchObject({ ok: true, account: { id: 'a1' } });
    expect(sent[0]!.url.host).toBe('acme.atlassian.net');
  });
});

describe('editing a Zephyr connection', () => {
  test('keeps the stored token when the region is unchanged and the token blank', async () => {
    const created = await zephyr();
    await updateConnection(db as never, created.id, { name: 'Renamed', credentials: {} });
    const row = (await getConnectionRow(db as never, created.id))!;
    expect(row.name).toBe('Renamed');
    await (await createTestManagement(db as never, created.id))!.whoAmI();
    expect(sent.at(-1)!.token).toBe(TOKEN);
  });

  test('drops the stored token when the region moves, so it never goes to another host', async () => {
    const created = await zephyr();
    await updateConnection(db as never, created.id, {
      baseUrl: 'https://eu.api.zephyrscale.smartbear.com/v2',
      config: { region: 'eu' },
      credentials: {},
    });
    const summary = (await listConnections(db as never)).find((c) => c.id === created.id)!;
    expect(summary.hasCredentials).toBe(false);
    expect(await createTestManagement(db as never, created.id)).toBeNull();
  });

  test('never returns the token, only whether there is one', async () => {
    await zephyr();
    const [summary] = await listConnections(db as never);
    expect(summary).toMatchObject({ provider: 'zephyr-scale', hasCredentials: true, credentialValues: {} });
    expect(JSON.stringify(summary)).not.toContain(TOKEN);
  });
});

describe('Zephyr rows never reach tracker code', () => {
  test('listTrackerConnections lists the Jira connection and not the Zephyr one', async () => {
    const tracker = await jira();
    await zephyr();
    expect((await listTrackerConnections(db as never)).map((c) => c.id)).toEqual([tracker.id]);
  });

  test('an environment-managed Zephyr connection is not a tracker either', async () => {
    process.env.PIWI_ZEPHYR_API_TOKEN = TOKEN;
    expect(await listTrackerConnections(db as never)).toEqual([]);
    expect(await listConnections(db as never)).toHaveLength(1);
  });

  test('a webhook token is only ever matched to a connection whose provider has a webhook', async () => {
    const created = await zephyr();
    const token = await setWebhookToken(db as never, created.id);
    expect(token).toBeTruthy();
    expect(await connectionByWebhookToken(db as never, token!)).toBeNull();

    const tracker = await jira();
    const real = await setWebhookToken(db as never, tracker.id);
    expect((await connectionByWebhookToken(db as never, real!))?.id).toBe(tracker.id);
  });

  test('a link is never matched to a Zephyr connection, nor an unfurl configured from one', async () => {
    const created = await zephyr({ credentials: { apiToken: TOKEN, email: 'ci@example.com' } });
    const url = 'https://api.zephyrscale.smartbear.com/v2/projects/PAY-1';
    expect(await resolveJiraUnfurlConfig(db as never, url, created.id)).toBeNull();
    expect(
      await detectProviderWithConnection(db as never, 'https://acme.atlassian.net/browse/PAY-1', created.id),
    ).toEqual(expect.not.objectContaining({ connectionId: created.id }));
  });
});

describe('the environment-managed connection', () => {
  test('is created from the token, on the default region, with the credentials column left null', async () => {
    process.env.PIWI_ZEPHYR_API_TOKEN = TOKEN;
    await ensureEnvManagedConnections(db as never);
    const [row] = await db.select().from(schema.integrationConnections);
    expect(row).toMatchObject({
      provider: 'zephyr-scale',
      name: 'Zephyr Scale (environment)',
      baseUrl: 'https://api.zephyrscale.smartbear.com/v2',
      config: { region: 'us' },
      credentials: null,
      managedBy: 'env',
      status: 'unverified',
    });
    const [summary] = await listConnections(db as never);
    expect(summary).toMatchObject({ managedBy: 'env', hasCredentials: true });
    expect(JSON.stringify(summary)).not.toContain(TOKEN);
  });

  test('calls the host of its region with the token from the environment', async () => {
    process.env.PIWI_ZEPHYR_API_TOKEN = TOKEN;
    process.env.PIWI_ZEPHYR_REGION = 'de';
    const [summary] = await listConnections(db as never);
    expect(await testConnection(db as never, summary!.id)).toMatchObject({ ok: true });
    expect(sent.map((s) => [s.url.host, s.token])).toEqual([['de.api.zephyrscale.smartbear.com', TOKEN]]);
  });

  test('an environment token a header cannot carry is reported as that, not as no credentials', async () => {
    process.env.PIWI_ZEPHYR_API_TOKEN = 'two words';
    const [summary] = await listConnections(db as never);
    expect(summary).toMatchObject({ managedBy: 'env', hasCredentials: true });
    expect(await testConnection(db as never, summary!.id)).toEqual({
      ok: false,
      error: 'The token holds characters a header cannot carry.',
    });
    expect(sent).toEqual([]);
  });

  test('follows a change of region in place, keeping the same row', async () => {
    process.env.PIWI_ZEPHYR_API_TOKEN = TOKEN;
    const [first] = await listConnections(db as never);
    process.env.PIWI_ZEPHYR_REGION = 'AU';
    const list = await listConnections(db as never);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: first!.id,
      baseUrl: 'https://au.api.zephyrscale.smartbear.com/v2',
      config: { region: 'au' },
    });
  });

  test('is removed when the token is unset', async () => {
    process.env.PIWI_ZEPHYR_API_TOKEN = TOKEN;
    expect(await listConnections(db as never)).toHaveLength(1);
    delete process.env.PIWI_ZEPHYR_API_TOKEN;
    expect(await listConnections(db as never)).toEqual([]);
  });

  test('an invalid region is logged once and the default is used', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PIWI_ZEPHYR_API_TOKEN = TOKEN;
    process.env.PIWI_ZEPHYR_REGION = 'atlantis';
    await ensureEnvManagedConnections(db as never);
    await ensureEnvManagedConnections(db as never);
    const [row] = await db.select().from(schema.integrationConnections);
    expect(row).toMatchObject({ baseUrl: 'https://api.zephyrscale.smartbear.com/v2', config: { region: 'us' } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('atlantis');
    expect(String(warn.mock.calls[0]![0])).not.toContain(TOKEN);
  });

  test('is read-only through the connection layer’s own bookkeeping, and Jira’s env connection is unaffected', async () => {
    process.env.PIWI_ZEPHYR_API_TOKEN = TOKEN;
    process.env.PIWI_JIRA_BASE_URL = 'https://env.atlassian.net';
    process.env.PIWI_JIRA_EMAIL = 'env@acme.io';
    process.env.PIWI_JIRA_API_TOKEN = 'env-jira-token';
    const list = await listConnections(db as never);
    expect(list.map((c) => c.provider).sort()).toEqual(['jira', 'zephyr-scale']);
    delete process.env.PIWI_ZEPHYR_API_TOKEN;
    expect((await listConnections(db as never)).map((c) => c.provider)).toEqual(['jira']);
  });

  test('a manually created Zephyr connection survives the reconcile', async () => {
    const manual = await zephyr();
    await ensureEnvManagedConnections(db as never);
    expect((await listConnections(db as never)).map((c) => c.id)).toEqual([manual.id]);
  });
});
