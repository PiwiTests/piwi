import { describe, it, expect, beforeEach } from 'vitest';
import {
  getConnectionSettings,
  setConnectionSettings,
  clearConnectionSettings,
  isConnected,
  applyServerSync,
  coerceConnectionSettings,
  mappedProjects,
  getInstanceApiKey,
  setInstanceApiKey,
  clearInstanceApiKey,
  isDesktopApiKey,
  markDesktopApiKey,
  moveLegacyApiKey,
  type ConnectionSettings,
} from '../../src/shared/connection-settings.js';
import { memoryLocalStorage, memorySecretArea } from './memory-secret-area.js';

const EMPTY_SETTINGS: ConnectionSettings = {
  instanceUrl: '',
  projectMappings: [],
  serverMappings: [],
  serverProjects: [],
  serverSyncedAt: 0,
  connectedAs: '',
};
const conn = (s: Partial<ConnectionSettings>): ConnectionSettings => ({ ...EMPTY_SETTINGS, ...s });

function fakeChromeStorage() {
  const store: Record<string, unknown> = {};
  return {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        },
        remove: async (key: string) => {
          delete store[key];
        },
      },
    },
  };
}

beforeEach(() => {
  (globalThis as any).chrome = fakeChromeStorage();
});

const shopMapping = { urlPattern: 'https://shop.test/**', projectId: 1, projectLabel: 'Shop' };

describe('connection settings', () => {
  it('defaults to empty/disconnected', async () => {
    const settings = await getConnectionSettings();
    expect(settings).toEqual(EMPTY_SETTINGS);
    expect(isConnected(settings)).toBe(false);
  });

  it('round-trips a saved connection with one mapping', async () => {
    await setConnectionSettings(
      conn({
        instanceUrl: 'https://piwi.example.com',
        projectMappings: [shopMapping],
      }),
    );
    const settings = await getConnectionSettings();
    expect(settings).toEqual(conn({ instanceUrl: 'https://piwi.example.com', projectMappings: [shopMapping] }));
    expect(isConnected(settings)).toBe(true);
  });

  it('round-trips multiple mappings, preserving order', async () => {
    const otherMapping = { urlPattern: 'https://admin.test/**', projectId: 2, projectLabel: 'Admin' };
    await setConnectionSettings(
      conn({
        instanceUrl: 'https://piwi.example.com',
        projectMappings: [shopMapping, otherMapping],
      }),
    );
    const settings = await getConnectionSettings();
    expect(settings.projectMappings.map((m) => m.projectId)).toEqual([1, 2]);
  });

  it('is not connected with a URL but no mappings', async () => {
    await setConnectionSettings(conn({ instanceUrl: 'https://piwi.example.com', projectMappings: [] }));
    expect(isConnected(await getConnectionSettings())).toBe(false);
  });

  it('clearConnectionSettings resets to empty', async () => {
    await setConnectionSettings(
      conn({
        instanceUrl: 'https://piwi.example.com',
        projectMappings: [shopMapping],
      }),
    );
    await clearConnectionSettings();
    expect(await getConnectionSettings()).toEqual(EMPTY_SETTINGS);
  });

  it('tolerates garbage stored under the key (e.g. an old shape)', async () => {
    (globalThis as any).chrome.storage.local.set({ piwiConnection: 'not-an-object' });
    const settings = await getConnectionSettings();
    expect(settings).toEqual(EMPTY_SETTINGS);
  });

  it('drops individually malformed mapping entries instead of the whole list', async () => {
    (globalThis as any).chrome.storage.local.set({
      piwiConnection: {
        instanceUrl: 'https://piwi.example.com',
        apiKey: '',
        projectMappings: [shopMapping, { urlPattern: '' }, { projectId: 'not-a-number' }, null, 'garbage'],
      },
    });
    const settings = await getConnectionSettings();
    expect(settings.projectMappings).toEqual([shopMapping]);
  });

  it('keeps a mapping branch, trimmed, and drops an empty one', async () => {
    await setConnectionSettings(
      conn({
        instanceUrl: 'https://piwi.example.com',
        projectMappings: [
          { ...shopMapping, branch: ' develop ' },
          { ...shopMapping, urlPattern: 'https://b.test/**', branch: '  ' },
        ],
      }),
    );
    const [staging, other] = (await getConnectionSettings()).projectMappings;
    expect(staging!.branch).toBe('develop');
    expect(other).not.toHaveProperty('branch');
  });

  it('keeps a mapping path prefix, normalized, and drops an empty or refused one', async () => {
    await setConnectionSettings(
      conn({
        instanceUrl: 'https://piwi.example.com',
        projectMappings: [
          { ...shopMapping, pathPrefix: 'app/' },
          { ...shopMapping, urlPattern: 'https://b.test/**', pathPrefix: ' ' },
          { ...shopMapping, urlPattern: 'https://c.test/**', pathPrefix: '/app?x' },
        ],
      }),
    );
    const [prefixed, empty, refused] = (await getConnectionSettings()).projectMappings;
    expect(prefixed!.pathPrefix).toBe('/app');
    expect(empty).not.toHaveProperty('pathPrefix');
    expect(refused).not.toHaveProperty('pathPrefix');
  });

  it('keeps a mapping tests’ path prefix, normalized, and drops a refused one', async () => {
    await setConnectionSettings(
      conn({
        instanceUrl: 'https://piwi.example.com',
        projectMappings: [
          { ...shopMapping, testPathPrefix: 'shop/' },
          { ...shopMapping, urlPattern: 'https://b.test/**', testPathPrefix: '/shop/*' },
        ],
      }),
    );
    const [kept, refused] = (await getConnectionSettings()).projectMappings;
    expect(kept!.testPathPrefix).toBe('/shop');
    expect(refused).not.toHaveProperty('testPathPrefix');
  });

  it('defaults a missing projectLabel to #<id>', async () => {
    (globalThis as any).chrome.storage.local.set({
      piwiConnection: {
        instanceUrl: 'https://piwi.example.com',
        apiKey: '',
        projectMappings: [{ urlPattern: 'https://x.test/**', projectId: 7 }],
      },
    });
    const settings = await getConnectionSettings();
    expect(settings.projectMappings[0]!.projectLabel).toBe('#7');
  });
});

describe("the instance's patterns", () => {
  const answer = {
    user: { name: 'Test User' },
    items: [
      {
        projectId: 1,
        projectName: 'shop',
        projectLabel: 'Shop',
        pattern: 'https://staging.shop.test/**',
        environment: 'staging',
        branch: 'develop',
        pathPrefix: '/app',
        testPathPrefix: '/v2',
      },
      {
        projectId: 2,
        projectName: 'admin',
        projectLabel: 'Admin',
        pattern: 'https://admin.test/**',
        environment: null,
        branch: null,
      },
    ],
    projects: [
      { id: 1, label: 'Shop', canEdit: true },
      { id: 2, label: 'Admin', canEdit: false },
    ],
  };

  it('a sync caches the patterns, projects and account name, and keeps the local patterns', () => {
    const before = conn({ instanceUrl: 'https://piwi.test', projectMappings: [shopMapping] });
    const after = applyServerSync(before, answer, 1234);
    expect(after.projectMappings).toEqual([shopMapping]);
    expect(after.serverMappings).toEqual([
      {
        urlPattern: 'https://staging.shop.test/**',
        projectId: 1,
        projectLabel: 'Shop',
        branch: 'develop',
        pathPrefix: '/app',
        testPathPrefix: '/v2',
        environment: 'staging',
      },
      { urlPattern: 'https://admin.test/**', projectId: 2, projectLabel: 'Admin' },
    ]);
    expect(after.serverProjects).toEqual(answer.projects);
    expect(after.serverSyncedAt).toBe(1234);
    expect(after.connectedAs).toBe('Test User');
  });

  it('a later sync replaces the previous one, removed patterns included', () => {
    const first = applyServerSync(conn({ instanceUrl: 'https://piwi.test' }), answer, 1);
    const second = applyServerSync(first, { user: null, items: [], projects: [] }, 2);
    expect(second.serverMappings).toEqual([]);
    expect(second.connectedAs).toBe('');
  });

  it('server patterns alone make a connection', () => {
    expect(isConnected(applyServerSync(conn({ instanceUrl: 'https://piwi.test' }), answer, 1))).toBe(true);
  });

  it('lists each mapped project once, local ones first', () => {
    const settings = applyServerSync(conn({ projectMappings: [{ ...shopMapping, projectLabel: 'Mine' }] }), answer, 1);
    expect(mappedProjects(settings)).toEqual([
      { projectId: 1, projectLabel: 'Mine' },
      { projectId: 2, projectLabel: 'Admin' },
    ]);
  });

  it('reads settings stored by an older version, before server patterns existed', () => {
    const old = { instanceUrl: 'https://piwi.test', projectMappings: [shopMapping] };
    expect(coerceConnectionSettings(old)).toEqual(conn(old));
  });
});

describe('the API key', () => {
  let local: ReturnType<typeof memoryLocalStorage>;
  let area: ReturnType<typeof memorySecretArea>;
  const legacy = {
    instanceUrl: 'https://piwi.example.com/',
    apiKey: 'pd_old',
    projectMappings: [shopMapping],
    serverMappings: [],
    serverProjects: [],
    serverSyncedAt: 5,
    connectedAs: 'Ada',
  };

  beforeEach(() => {
    local = memoryLocalStorage();
    area = memorySecretArea();
    (globalThis as any).chrome = { storage: { local: local.local } };
  });

  it('is kept in the secret area, never in the settings content scripts read', async () => {
    await setConnectionSettings(conn({ instanceUrl: 'https://piwi.example.com', projectMappings: [shopMapping] }));
    await setInstanceApiKey('https://piwi.example.com', 'pd_abc', area);
    expect(JSON.stringify(local.store)).not.toContain('pd_abc');
    expect(await getInstanceApiKey('https://piwi.example.com/', area)).toBe('pd_abc');
    expect(isConnected(await getConnectionSettings())).toBe(true);
  });

  it('goes only to the origin it was given for', async () => {
    await setInstanceApiKey('https://piwi.example.com', 'pd_abc', area);
    expect(await getInstanceApiKey('https://piwi.example.com/sub/path', area)).toBe('pd_abc');
    expect(await getInstanceApiKey('https://evil.example.com', area)).toBe('');
    expect(await getInstanceApiKey('http://piwi.example.com', area)).toBe('');
    expect(await getInstanceApiKey('https://piwi.example.com:8443', area)).toBe('');
    expect(await getInstanceApiKey('', area)).toBe('');
  });

  it('is marked as the desktop app token only when it is that token, for the app address, until another key', async () => {
    const app = { url: 'http://127.0.0.1:4318', token: 'pd_desktop' };
    await setInstanceApiKey('http://127.0.0.1:4318', 'pd_key', area);
    await markDesktopApiKey(app, area);
    expect(await isDesktopApiKey(app.url, 'pd_key', area)).toBe(false);
    await setInstanceApiKey('http://127.0.0.1:5000', 'pd_desktop', area);
    await markDesktopApiKey(app, area);
    expect(await isDesktopApiKey('http://127.0.0.1:5000', 'pd_desktop', area)).toBe(false);
    await setInstanceApiKey('http://localhost:4318/', 'pd_desktop', area);
    await markDesktopApiKey(app, area);
    expect(await isDesktopApiKey('http://localhost:4318', 'pd_desktop', area)).toBe(true);
    expect(await isDesktopApiKey('http://localhost:4318', 'pd_typed', area)).toBe(false);
    expect(await getInstanceApiKey('http://localhost:4318', area)).toBe('pd_desktop');
    // Kept again, by Save and test once the app is unpaired: still the app's token.
    await setInstanceApiKey('http://localhost:4318', 'pd_desktop', area);
    expect(await isDesktopApiKey('http://localhost:4318', 'pd_desktop', area)).toBe(true);
    await setInstanceApiKey('http://localhost:4318', 'pd_key', area);
    await setInstanceApiKey('http://localhost:4318', 'pd_desktop', area);
    expect(await isDesktopApiKey('http://localhost:4318', 'pd_desktop', area)).toBe(false);
  });

  it('an empty key, or Disconnect, keeps none', async () => {
    await setInstanceApiKey('https://piwi.example.com', 'pd_abc', area);
    await setInstanceApiKey('https://piwi.example.com', '  ', area);
    expect(await getInstanceApiKey('https://piwi.example.com', area)).toBe('');
    await setInstanceApiKey('https://piwi.example.com', 'pd_abc', area);
    await clearInstanceApiKey(area);
    expect(area.data.size).toBe(0);
  });

  it('a key left in the stored settings moves to the secret area, bound to their instance, and leaves them', async () => {
    local.store.piwiConnection = structuredClone(legacy);
    await moveLegacyApiKey(area);
    expect(area.data.get('instance')).toEqual({ apiKey: 'pd_old', origin: 'https://piwi.example.com' });
    const { apiKey: _key, ...rest } = legacy;
    expect(local.store.piwiConnection).toEqual(rest);
    // Content scripts read the same settings as before, without the key.
    const settings = await getConnectionSettings();
    expect(settings).not.toHaveProperty('apiKey');
    expect(isConnected(settings)).toBe(true);
    expect(await getInstanceApiKey(legacy.instanceUrl, area)).toBe('pd_old');
  });

  it('moving again changes nothing', async () => {
    local.store.piwiConnection = structuredClone(legacy);
    await moveLegacyApiKey(area);
    const once = { local: structuredClone(local.store), area: structuredClone([...area.data]) };
    await moveLegacyApiKey(area);
    expect({ local: local.store, area: [...area.data] }).toEqual(once);
  });

  it('a move cut short before the key is written leaves it where it was', async () => {
    local.store.piwiConnection = structuredClone(legacy);
    area.failNextSet = true;
    await expect(moveLegacyApiKey(area)).rejects.toThrow();
    expect(local.store.piwiConnection).toEqual(legacy);
    await moveLegacyApiKey(area);
    expect(await getInstanceApiKey(legacy.instanceUrl, area)).toBe('pd_old');
    expect(local.store.piwiConnection).not.toHaveProperty('apiKey');
  });

  it('a move cut short after the key is written finishes on the next one', async () => {
    local.store.piwiConnection = structuredClone(legacy);
    local.failNextSet = true;
    await expect(moveLegacyApiKey(area)).rejects.toThrow();
    // In both places for now: nothing is lost.
    expect(area.data.get('instance')).toEqual({ apiKey: 'pd_old', origin: 'https://piwi.example.com' });
    expect(local.store.piwiConnection).toHaveProperty('apiKey', 'pd_old');
    await moveLegacyApiKey(area);
    expect(local.store.piwiConnection).not.toHaveProperty('apiKey');
    expect(await getInstanceApiKey(legacy.instanceUrl, area)).toBe('pd_old');
  });

  it('a key written into the stored settings later never replaces the one kept', async () => {
    await setInstanceApiKey('https://piwi.example.com', 'pd_real', area);
    local.store.piwiConnection = { ...structuredClone(legacy), instanceUrl: 'https://evil.example.com', apiKey: 'x' };
    expect(await getInstanceApiKey('https://evil.example.com', area)).toBe('');
    expect(await getInstanceApiKey('https://piwi.example.com', area)).toBe('pd_real');
    expect(local.store.piwiConnection).not.toHaveProperty('apiKey');
  });

  it('an empty key left in the stored settings is only removed', async () => {
    local.store.piwiConnection = { ...structuredClone(legacy), apiKey: '' };
    await moveLegacyApiKey(area);
    expect(area.data.size).toBe(0);
    expect(local.store.piwiConnection).not.toHaveProperty('apiKey');
  });
});
