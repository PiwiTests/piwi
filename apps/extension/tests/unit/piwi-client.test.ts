import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  fetchCatalog,
  fetchLocatorIndex,
  fetchProjects,
  testConnection,
  testDesktop,
} from '../../src/shared/piwi-client';
import { normalizeBaseUrl, projectCatalogUrl, projectLocatorsUrl, testCaseUrl } from '../../src/shared/instance-links';
import { markDesktopApiKey, setInstanceApiKey } from '../../src/shared/connection-settings';
import { clearDesktopSettings, setDesktopSettings } from '../../src/shared/desktop-settings';
import { memoryLocalStorage, memorySecretArea } from './memory-secret-area';
import { desktopHealth } from './desktop-health';
import type * as SecretStore from '../../src/shared/secret-store';

// The extension's IndexedDB, in memory: the client reads the key from it.
const secrets = memorySecretArea();
vi.mock('../../src/shared/secret-store', async (importOriginal) => ({
  ...(await importOriginal<typeof SecretStore>()),
  secretArea: () => secrets,
}));

describe('normalizeBaseUrl', () => {
  test('trims whitespace and a trailing slash', () => {
    expect(normalizeBaseUrl('  https://piwi.example.com/  ')).toBe('https://piwi.example.com');
  });

  test('strips multiple trailing slashes', () => {
    expect(normalizeBaseUrl('https://piwi.example.com///')).toBe('https://piwi.example.com');
  });

  test('leaves an already-clean URL untouched', () => {
    expect(normalizeBaseUrl('https://piwi.example.com')).toBe('https://piwi.example.com');
  });
});

describe('projectCatalogUrl', () => {
  test('builds the dashboard test-functions page URL for a project', () => {
    expect(projectCatalogUrl('https://piwi.example.com', 7)).toBe('https://piwi.example.com/projects/7/test-functions');
  });

  test('normalizes a trailing slash on the instance URL first', () => {
    expect(projectCatalogUrl('https://piwi.example.com/', 7)).toBe(
      'https://piwi.example.com/projects/7/test-functions',
    );
  });
});

describe('dashboard deep links', () => {
  test('projectLocatorsUrl prefills the locators to check, one per line', () => {
    expect(projectLocatorsUrl('https://piwi.example.com/', 3)).toBe('https://piwi.example.com/projects/3/locators');
    expect(projectLocatorsUrl('https://piwi.example.com', 3, ["getByTestId('pay')", "getByText('Pay')"])).toBe(
      `https://piwi.example.com/projects/3/locators?q=${encodeURIComponent("getByTestId('pay')\ngetByText('Pay')")}`,
    );
  });

  test('projectLocatorsUrl names the branch when there is one', () => {
    expect(projectLocatorsUrl('https://piwi.example.com', 3, [], 'feature/x')).toBe(
      'https://piwi.example.com/projects/3/locators?branch=feature%2Fx',
    );
    expect(projectLocatorsUrl('https://piwi.example.com', 3, ["getByText('A')"], '*')).toBe(
      `https://piwi.example.com/projects/3/locators?q=${encodeURIComponent("getByText('A')")}&branch=*`,
    );
  });

  test('testCaseUrl points at the test case page', () => {
    expect(testCaseUrl('https://piwi.example.com/', 42)).toBe('https://piwi.example.com/test-cases/42');
  });
});

describe('responses as the dashboard sends them', () => {
  const settings = {
    instanceUrl: 'https://piwi.example.com',
    projectMappings: [],
    serverMappings: [],
    serverProjects: [],
    serverSyncedAt: 0,
    connectedAs: '',
  };
  const answer = (body: unknown, status = 200) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
      ),
    );
  /** A desktop app holding `token`: it answers the health challenge, and every other request with JSON. */
  const desktopApp = (token: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) =>
        url.endsWith('/api/health')
          ? desktopHealth(url, init, token)
          : new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ),
    );
  const lastCall = () => {
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    return calls[calls.length - 1] as [string, RequestInit];
  };

  beforeEach(async () => {
    (globalThis as any).chrome = { storage: { local: memoryLocalStorage().local } };
    secrets.data.clear();
    await setInstanceApiKey('https://piwi.example.com', 'pd_key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('fetchProjects reads the { items } list the menu endpoint returns', async () => {
    answer({ items: [{ id: 1, name: 'shop', label: null }] });
    expect(await fetchProjects(settings)).toEqual([{ id: 1, name: 'shop', label: null }]);
    answer([{ id: 2, name: 'api', label: 'API' }]);
    expect(await fetchProjects(settings)).toEqual([{ id: 2, name: 'api', label: 'API' }]);
  });

  test('fetchCatalog reads the entries out of { items }', async () => {
    const entry = { id: 5, name: 'login', kind: 'helper' };
    answer({ items: [{ id: 5, name: 'login', entry }] });
    expect(await fetchCatalog(settings, 1)).toEqual([entry]);
    answer({ testFunctions: [{ entry }] });
    expect(await fetchCatalog(settings, 1)).toEqual([entry]);
  });

  test('fetchLocatorIndex sends the API key and returns the index', async () => {
    const index = {
      projectId: 1,
      branch: 'main',
      defaultBranch: 'main',
      branches: [],
      locators: [],
      tests: [],
      truncated: false,
    };
    answer(index);
    expect(await fetchLocatorIndex(settings, 1)).toEqual(index);
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('https://piwi.example.com/api/projects/1/locator-index');
    expect((call[1] as RequestInit).headers).toEqual({ 'X-API-Key': 'pd_key' });
  });

  test('fetchLocatorIndex asks for a branch, and reads an index without branches as every branch', async () => {
    answer({
      projectId: 1,
      locators: [
        { locator: "getByText('A')", lastSeenAt: '', uses: [{ test: 0, actions: [], callSites: [], projects: [] }] },
      ],
      tests: [],
      truncated: false,
    });
    const index = await fetchLocatorIndex(settings, 1, 'feature/x');
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('https://piwi.example.com/api/projects/1/locator-index?branch=feature%2Fx');
    expect(index).toMatchObject({ branch: null, defaultBranch: '', branches: [] });
    expect(index.locators[0]!.uses[0]!.branches).toEqual([]);
  });

  test('the key goes only to the instance it was given for', async () => {
    answer({ items: [] });
    await fetchProjects({ ...settings, instanceUrl: 'https://piwi.example.com/' });
    expect(lastCall()[1].headers).toEqual({ 'X-API-Key': 'pd_key' });
    // The stored address changed behind the settings page's back: the request goes keyless.
    await fetchProjects({ ...settings, instanceUrl: 'https://elsewhere.example.com' });
    expect(lastCall()[0]).toBe('https://elsewhere.example.com/api/projects/menu');
    expect(lastCall()[1].headers).toEqual({});
  });

  test('a key typed and not kept yet is what Save and test sends', async () => {
    answer({ items: [] });
    expect(await testConnection({ ...settings, instanceUrl: 'https://new.example.com' }, 'pd_typed')).toEqual({
      ok: true,
    });
    expect(lastCall()[1].headers).toEqual({ 'X-API-Key': 'pd_typed' });
  });

  test('no request to the instance or the desktop app follows a redirect', async () => {
    answer({ items: [] });
    await fetchCatalog(settings, 1);
    expect(lastCall()[1].redirect).toBe('error');
    desktopApp('pd_desktop');
    expect(await testDesktop({ url: 'http://127.0.0.1:4318', token: 'pd_desktop' })).toEqual({ ok: true });
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
    expect(calls.map(([, init]) => init.redirect)).toEqual(['error', 'error']);
    expect(lastCall()[1]).toMatchObject({ headers: { 'x-piwi-token': 'pd_desktop' } });
  });

  test('the desktop token goes only to the app that proves it holds it', async () => {
    // Another program on the port, or an app paired with another token, answers no proof of this one.
    desktopApp('pd_other');
    expect(await testDesktop({ url: 'http://127.0.0.1:4318', token: 'pd_desktop' })).toEqual({
      ok: false,
      error: expect.stringContaining('did not prove'),
    });
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual(['http://127.0.0.1:4318/api/health']);
    expect(JSON.stringify(calls[0]![1].headers)).not.toContain('pd_desktop');
  });

  test('fetchLocatorIndex explains a rejected key, a missing endpoint and a malformed answer', async () => {
    answer({ message: 'nope' }, 403);
    await expect(fetchLocatorIndex(settings, 1)).rejects.toThrow('rejected the API key');
    answer({ message: 'missing' }, 404);
    await expect(fetchLocatorIndex(settings, 1)).rejects.toThrow('no locator index');
    answer({ unexpected: true });
    await expect(fetchLocatorIndex(settings, 1)).rejects.toThrow('not a locator index');
    answer({ projectId: 1, locators: [{ locator: "getByText('A')" }], tests: [] });
    await expect(fetchLocatorIndex(settings, 1)).rejects.toThrow('not a locator index');
  });

  test('an answer that is not JSON, such as a sign-in page, says the instance is not Piwi', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><title>Sign in</title>', { status: 200 })),
    );
    const notPiwi = 'The instance answered with something that is not Piwi';
    await expect(fetchCatalog(settings, 1)).rejects.toThrow(notPiwi);
    await expect(fetchLocatorIndex(settings, 1)).rejects.toThrow(notPiwi);
    expect(await testConnection(settings)).toEqual({ ok: false, error: expect.stringContaining(notPiwi) });
  });

  test('Save and test names a redirect, which no request follows, asking again without the key', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.redirect === 'error') throw new TypeError('Failed to fetch');
      return { type: 'opaqueredirect', status: 0 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await testConnection({ ...settings, instanceUrl: 'http://piwi.example.com' })).toEqual({
      ok: false,
      error: expect.stringContaining('answered with a redirect'),
    });
    expect(fetchMock.mock.calls[1]).toEqual([
      'http://piwi.example.com/api/projects/menu',
      { redirect: 'manual', signal: expect.anything() },
    ]);
    // No answer at all, redirected or not.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect(await testConnection(settings)).toEqual({
      ok: false,
      error: expect.stringContaining('could not reach the instance'),
    });
  });
});

describe('the desktop app kept as the instance', () => {
  const APP = 'http://127.0.0.1:4318';
  const TOKEN = 'pd_desktop';
  const settings = {
    instanceUrl: APP,
    projectMappings: [],
    serverMappings: [],
    serverProjects: [],
    serverSyncedAt: 0,
    connectedAs: '',
  };
  /** The program at the app's address: it answers the challenge as the holder of `token`, and anything else with JSON. */
  const programHolding = (token: string) => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      url.endsWith('/api/health')
        ? desktopHealth(url, init, token)
        : new Response('{"items":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return () => fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
  };
  const tokenSent = (calls: Array<[string, RequestInit]>) =>
    calls.some(([, init]) => JSON.stringify(init.headers).includes(TOKEN));

  beforeEach(async () => {
    (globalThis as any).chrome = { storage: { local: memoryLocalStorage().local } };
    secrets.data.clear();
    await setDesktopSettings({ url: APP, token: TOKEN });
    await setInstanceApiKey(APP, TOKEN);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('sends its token as the key only once the program at the address proves it holds it', async () => {
    let calls = programHolding(TOKEN);
    expect(await fetchCatalog(settings, 1)).toEqual([]);
    expect(calls().map(([url]) => url)).toEqual([`${APP}/api/health`, `${APP}/api/projects/1/test-functions`]);
    expect(calls()[1]![1].headers).toEqual({ 'X-API-Key': TOKEN });
    // Every request proves it again, a key typed and not kept yet too.
    calls = programHolding(TOKEN);
    expect(await testConnection(settings, TOKEN)).toEqual({ ok: true });
    expect(calls().map(([url]) => url)).toEqual([`${APP}/api/health`, `${APP}/api/projects/menu`]);
  });

  test('never sends it to another program that took the address', async () => {
    const calls = programHolding('pd_other');
    const notProven = 'did not prove';
    await expect(fetchCatalog(settings, 1)).rejects.toThrow(notProven);
    await expect(fetchLocatorIndex(settings, 1)).rejects.toThrow(notProven);
    await expect(fetchProjects(settings)).rejects.toThrow(notProven);
    expect(await testConnection(settings, TOKEN)).toEqual({ ok: false, error: expect.stringContaining(notProven) });
    expect(calls().length).toBe(4);
    expect(calls().every(([url]) => url === `${APP}/api/health`)).toBe(true);
    expect(tokenSent(calls())).toBe(false);
  });

  test('still proves it once the app is unpaired, or paired again with another token', async () => {
    await markDesktopApiKey({ url: APP, token: TOKEN });
    await clearDesktopSettings();
    let calls = programHolding('pd_other');
    await expect(fetchCatalog(settings, 1)).rejects.toThrow('did not prove');
    expect(tokenSent(calls())).toBe(false);
    await setDesktopSettings({ url: APP, token: 'pd_new' });
    calls = programHolding('pd_new');
    await expect(fetchCatalog(settings, 1)).rejects.toThrow('did not prove');
    expect(tokenSent(calls())).toBe(false);
    // The app still holds the token the instance was kept with.
    calls = programHolding(TOKEN);
    expect(await fetchCatalog(settings, 1)).toEqual([]);
    expect(calls().map(([url]) => url)).toEqual([`${APP}/api/health`, `${APP}/api/projects/1/test-functions`]);
  });

  test('is refused at a loopback name other than the app own address', async () => {
    const calls = programHolding(TOKEN);
    const localhost = { ...settings, instanceUrl: 'http://localhost:4318' };
    expect(await testConnection(localhost, TOKEN)).toEqual({
      ok: false,
      error: expect.stringContaining('did not prove'),
    });
    expect(calls()).toEqual([]);
  });

  test('leaves any other key on a loopback instance as it is', async () => {
    await setInstanceApiKey(APP, 'pd_key');
    const calls = programHolding('pd_other');
    expect(await fetchCatalog(settings, 1)).toEqual([]);
    expect(calls().map(([url]) => url)).toEqual([`${APP}/api/projects/1/test-functions`]);
    expect(calls()[0]![1].headers).toEqual({ 'X-API-Key': 'pd_key' });
  });
});

describe('the requests to the instance', () => {
  test('are never imported by a content script, which would hold the key in the page', () => {
    const contentDir = path.resolve(import.meta.dirname, '..', '..', 'src', 'content');
    const importers = readdirSync(contentDir).filter((file) =>
      /from '\.\.\/shared\/piwi-client\.js'/.test(readFileSync(path.join(contentDir, file), 'utf8')),
    );
    expect(importers).toEqual([]);
  });
});
