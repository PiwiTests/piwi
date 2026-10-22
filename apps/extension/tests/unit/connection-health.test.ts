import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECTION_HEALTH_KEY,
  coerceConnectionHealth,
  getConnectionHealth,
  healthOutcome,
  healthPill,
  healthSentence,
  nextHealth,
  recordConnectionHealth,
  withConnectionHealth,
  type ConnectionHealth,
} from '../../src/shared/connection-health';
import { handleRefreshCatalog, handleRefreshLocatorIndex } from '../../src/background/project-refresh';
import { handleListBugReports } from '../../src/background/bug-reports';
import { markDesktopApiKey, setConnectionSettings, setInstanceApiKey } from '../../src/shared/connection-settings';
import { desktopHealth } from './desktop-health';
import { t } from '../../src/shared/i18n';
import { memoryLocalStorage, memorySecretArea } from './memory-secret-area';
import { setBrowserLanguage } from './setup-i18n';
import type * as SecretStore from '../../src/shared/secret-store';

const secrets = memorySecretArea();
vi.mock('../../src/shared/secret-store', async (importOriginal) => ({
  ...(await importOriginal<typeof SecretStore>()),
  secretArea: () => secrets,
}));

const INSTANCE = 'https://piwi.example.com';
const NOW = new Date(2026, 9, 22, 14, 30).getTime();
const MINUTE = 60_000;

let local: ReturnType<typeof memoryLocalStorage>;

beforeEach(() => {
  local = memoryLocalStorage();
  (globalThis as any).chrome = {
    storage: { local: local.local, session: memoryLocalStorage().local },
    runtime: { getURL: (path: string) => `chrome-extension://piwipicker/${path}` },
  };
});

afterEach(() => vi.unstubAllGlobals());

describe('the outcome a request’s error stands for', () => {
  it('reads nothing answering, a refused key and any other answer from the sentence thrown', () => {
    expect(healthOutcome(new Error(t('common_instanceUnreachable')))).toBe('unreachable');
    expect(healthOutcome(new Error(t('common_instanceRedirects')))).toBe('unreachable');
    expect(healthOutcome(new Error(t('common_desktopUnreachable')))).toBe('unreachable');
    expect(healthOutcome(new Error(t('common_desktopNotProven')))).toBe('unauthorized');
    expect(healthOutcome(new Error(t('common_apiKeyRejected')))).toBe('unauthorized');
    expect(healthOutcome(new Error(t('common_projectKeyRejected')))).toBe('unauthorized');
    expect(healthOutcome(new Error(t('common_catalogFailed', { status: 401 })))).toBe('unauthorized');
    expect(healthOutcome(new Error(t('common_instanceStatus', { status: 403 })))).toBe('unauthorized');
    expect(healthOutcome(new Error(t('common_catalogFailed', { status: 500 })))).toBe('error');
    expect(healthOutcome(new Error(t('common_instanceNotPiwi')))).toBe('error');
    expect(healthOutcome('anything')).toBe('error');
  });

  it('counts an answer that says the instance works and the key is accepted as ok', () => {
    expect(healthOutcome(new Error(t('common_noLocatorIndex')))).toBe('ok');
    expect(healthOutcome(new Error(t('common_sendForbidden')))).toBe('ok');
    expect(healthOutcome(new Error(t('common_sendRefused', { error: 'title is required' })))).toBe('ok');
    expect(healthOutcome(new Error(t('options_serverUnsupported')))).toBe('ok');
  });

  it('reads the sentence in the interface language', () => {
    setBrowserLanguage('fr', 'fr-FR');
    expect(healthOutcome(new Error(t('common_instanceUnreachable')))).toBe('unreachable');
    expect(healthOutcome(new Error(t('common_locatorIndexStatus', { status: 401 })))).toBe('unauthorized');
  });
});

describe('the record kept', () => {
  it('keeps the start of a run while the outcome repeats, and starts again when it changes', () => {
    const first = nextHealth(null, INSTANCE, 'unreachable', NOW);
    expect(first).toEqual({ instanceUrl: INSTANCE, outcome: 'unreachable', checkedAt: NOW, since: NOW });
    const again = nextHealth(first, INSTANCE, 'unreachable', NOW + 5 * MINUTE);
    expect(again).toEqual({ instanceUrl: INSTANCE, outcome: 'unreachable', checkedAt: NOW + 5 * MINUTE, since: NOW });
    expect(nextHealth(again, INSTANCE, 'ok', NOW + 6 * MINUTE).since).toBe(NOW + 6 * MINUTE);
    // Another instance's run is not this one's.
    expect(nextHealth(again, 'https://other.example', 'unreachable', NOW + 6 * MINUTE).since).toBe(NOW + 6 * MINUTE);
  });

  it('reads back only a well-formed record', () => {
    expect(coerceConnectionHealth(null)).toBeNull();
    expect(coerceConnectionHealth({ instanceUrl: INSTANCE, outcome: 'fine', checkedAt: NOW })).toBeNull();
    expect(coerceConnectionHealth({ instanceUrl: INSTANCE, outcome: 'ok', checkedAt: 'now' })).toBeNull();
    expect(coerceConnectionHealth({ instanceUrl: INSTANCE, outcome: 'ok', checkedAt: NOW })).toEqual({
      instanceUrl: INSTANCE,
      outcome: 'ok',
      checkedAt: NOW,
      since: NOW,
    });
  });

  it('is read for the instance it was written for only', async () => {
    await recordConnectionHealth(INSTANCE, 'unauthorized', NOW);
    expect(await getConnectionHealth(INSTANCE)).toMatchObject({ outcome: 'unauthorized', since: NOW });
    expect(await getConnectionHealth('https://other.example')).toBeNull();
    expect(await getConnectionHealth('')).toBeNull();
  });

  it('never makes a request fail: a storage that throws leaves the answer as it was', async () => {
    local.failNextSet = true;
    await expect(withConnectionHealth(INSTANCE, async () => 42)).resolves.toBe(42);
  });

  it('passes the answer or the error on unchanged', async () => {
    await expect(withConnectionHealth(INSTANCE, async () => 'answer')).resolves.toBe('answer');
    expect((await getConnectionHealth(INSTANCE))?.outcome).toBe('ok');
    const refused = new Error(t('common_apiKeyRejected'));
    await expect(
      withConnectionHealth(INSTANCE, async () => {
        throw refused;
      }),
    ).rejects.toBe(refused);
    expect((await getConnectionHealth(INSTANCE))?.outcome).toBe('unauthorized');
  });
});

describe('what the popup and the settings say', () => {
  const health = (outcome: ConnectionHealth['outcome'], since = NOW - 90 * MINUTE): ConnectionHealth => ({
    instanceUrl: `${INSTANCE}/`,
    outcome,
    checkedAt: NOW - 5 * MINUTE,
    since,
  });
  const text = (parts: Array<Node | string>) => parts.map((part) => (typeof part === 'string' ? part : '')).join('');

  it('names the host and when it was checked, or since when it fails, with what to do', () => {
    expect(text(healthSentence(health('ok'), NOW))).toBe('Connected to piwi.example.com, checked 5 minutes ago.');
    expect(text(healthSentence(health('unreachable'), NOW))).toMatch(
      /^piwi\.example\.com has not answered since 1:00\sPM, check the settings\.$/,
    );
    expect(text(healthSentence(health('unauthorized'), NOW))).toMatch(
      /has refused the API key since 1:00\sPM, connect again in the settings\.$/,
    );
    expect(text(healthSentence(health('error'), NOW))).toMatch(/has answered with errors since 1:00\sPM/);
    // A failure since another day names the day.
    expect(text(healthSentence(health('unreachable', NOW - 2 * 24 * 60 * MINUTE), NOW))).toMatch(/since Oct 20/);
  });

  it('hands the words of what to do to the caller, to make them a link', () => {
    const parts = healthSentence(health('unreachable'), NOW, (words) => `[${words}]`);
    expect(parts.join('')).toMatch(/, \[check the settings\]\.$/);
  });

  it('says the same in a few words on the settings page’s pill', () => {
    expect(healthPill(health('ok'), NOW)).toBe('Answered 5 minutes ago');
    expect(healthPill(health('unauthorized'), NOW)).toMatch(/^Key refused since 1:00\sPM$/);
    expect(healthPill(health('unreachable'), NOW)).toMatch(/^No answer since 1:00\sPM$/);
  });

  it('in the interface language', () => {
    setBrowserLanguage('fr', 'fr-FR');
    expect(text(healthSentence(health('ok'), NOW))).toBe('Connecté à piwi.example.com, vérifié il y a 5 minutes.');
    expect(healthPill(health('unreachable'), NOW)).toBe('Sans réponse depuis 13:00');
  });
});

describe('the worker’s requests', () => {
  beforeEach(async () => {
    secrets.data.clear();
    await setConnectionSettings({
      instanceUrl: INSTANCE,
      projectMappings: [{ urlPattern: 'https://staging.shop.test/**', projectId: 1, projectLabel: 'Shop' }],
      serverMappings: [],
      serverProjects: [],
      serverSyncedAt: 0,
      connectedAs: '',
    });
    await setInstanceApiKey(INSTANCE, 'pd_key');
  });

  const shopTab = { url: 'https://staging.shop.test/cart', tab: { url: 'https://staging.shop.test/cart' } };

  it('record what the instance answered, without changing the answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );
    const answer = await handleRefreshCatalog({ projectId: 1, force: true }, shopTab as chrome.runtime.MessageSender);
    expect(answer).toEqual({ ok: false, error: t('common_catalogFailed', { status: 401 }) });
    expect(local.store[CONNECTION_HEALTH_KEY]).toMatchObject({ instanceUrl: INSTANCE, outcome: 'unauthorized' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect(
      await handleRefreshLocatorIndex({ projectId: 1, force: true }, shopTab as chrome.runtime.MessageSender),
    ).toEqual({ ok: false, error: t('common_instanceUnreachable') });
    expect(local.store[CONNECTION_HEALTH_KEY]).toMatchObject({ outcome: 'unreachable' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
    );
    expect(await handleListBugReports(shopTab.tab as chrome.tabs.Tab)).toMatchObject({ ok: true, items: [] });
    expect(local.store[CONNECTION_HEALTH_KEY]).toMatchObject({ outcome: 'ok' });
  });

  it('send the desktop app kept as the instance its token only once the program there proves it holds it', async () => {
    const app = 'http://127.0.0.1:4318';
    await setConnectionSettings({
      instanceUrl: app,
      projectMappings: [{ urlPattern: 'https://staging.shop.test/**', projectId: 1, projectLabel: 'Shop' }],
      serverMappings: [],
      serverProjects: [],
      serverSyncedAt: 0,
      connectedAs: '',
    });
    await setInstanceApiKey(app, 'pd_desktop');
    await markDesktopApiKey({ url: app, token: 'pd_desktop' });
    const program = (token: string) => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
        url.endsWith('/api/health') ? desktopHealth(url, init, token) : new Response('{"items":[]}', { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };
    let fetchMock = program('pd_other');
    const refused = await handleRefreshCatalog({ projectId: 1, force: true }, shopTab as chrome.runtime.MessageSender);
    expect(refused).toEqual({ ok: false, error: t('common_desktopNotProven') });
    expect(await handleListBugReports(shopTab.tab as chrome.tabs.Tab)).toMatchObject({ ok: false });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${app}/api/health`, `${app}/api/health`]);
    expect(local.store[CONNECTION_HEALTH_KEY]).toMatchObject({ instanceUrl: app, outcome: 'unauthorized' });

    fetchMock = program('pd_desktop');
    const answer = await handleRefreshCatalog({ projectId: 1, force: true }, shopTab as chrome.runtime.MessageSender);
    expect(answer).toMatchObject({ ok: true, refreshed: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${app}/api/health`,
      `${app}/api/projects/1/test-functions`,
    ]);
    expect(local.store[CONNECTION_HEALTH_KEY]).toMatchObject({ outcome: 'ok' });
  });
});
