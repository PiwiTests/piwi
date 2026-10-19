import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleBugSendTarget,
  handleGetBugReport,
  handleListBugReports,
  handleShareReproduction,
} from '../../src/background/bug-reports';
import { handleDesktopRepro } from '../../src/background/desktop-repro';
import { newReplayState, setReplayState } from '../../src/shared/replay-storage';
import { setActiveProjectOverride } from '../../src/shared/active-project';
import { setConnectionSettings, setInstanceApiKey } from '../../src/shared/connection-settings';
import { memoryLocalStorage, memorySecretArea } from './memory-secret-area';
import { desktopHealth } from './desktop-health';
import type * as SecretStore from '../../src/shared/secret-store';

// The extension's IndexedDB, in memory: the worker reads the key from it.
const secrets = memorySecretArea();
vi.mock('../../src/shared/secret-store', async (importOriginal) => ({
  ...(await importOriginal<typeof SecretStore>()),
  secretArea: () => secrets,
}));

const INSTANCE = 'https://piwi.example.com';

beforeEach(async () => {
  (globalThis as any).chrome = {
    storage: { local: memoryLocalStorage().local, session: memoryLocalStorage().local },
  };
  secrets.data.clear();
  await setConnectionSettings({
    instanceUrl: INSTANCE,
    projectMappings: [
      { urlPattern: 'https://staging.shop.test/**', projectId: 1, projectLabel: 'Shop' },
      { urlPattern: 'https://other.test/**', projectId: 2, projectLabel: 'Other' },
    ],
    serverMappings: [],
    serverProjects: [],
    serverSyncedAt: 0,
    connectedAs: '',
  });
  await setInstanceApiKey(INSTANCE, 'pd_key');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('the project a bug report from a tab goes to', () => {
  it('is the Active project chosen for that tab’s site, and only there', async () => {
    await setActiveProjectOverride('https://staging.shop.test/cart', { projectId: 3, projectLabel: 'Manual' });
    const shop = await handleBugSendTarget({ url: 'https://staging.shop.test/checkout' } as chrome.tabs.Tab);
    expect(shop.project).toEqual({ id: 3, label: 'Manual' });
    const other = await handleBugSendTarget({ url: 'https://other.test/' } as chrome.tabs.Tab);
    expect(other.project).toEqual({ id: 2, label: 'Other' });
    const list = await handleListBugReports({ url: 'https://other.test/' } as chrome.tabs.Tab);
    expect(list).toMatchObject({ ok: true, project: { id: 2, label: 'Other' } });
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const [url, init] = calls[calls.length - 1] as [string, RequestInit];
    expect(url).toBe(`${INSTANCE}/api/projects/2/bug-reports`);
    expect(init.headers).toEqual({ 'X-API-Key': 'pd_key' });
  });
});

const STEPS = {
  v: 1,
  title: 'Coupon not applied',
  origin: 'https://staging.shop.test',
  recordedAt: 0,
  note: null,
  steps: [{ action: 'goto', target: null, value: '/cart', redacted: false, pageUrl: '/cart', timestamp: 0 }],
};

/** The instance: report 37 belongs to project 1, report 12 to project 2. */
function instance() {
  const posts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/health')) return desktopHealth(url, init, 'pd_desktop');
      if (init?.method === 'POST') {
        posts.push(url);
        return new Response(JSON.stringify(url.endsWith('/repro-requests') ? { id: 'ab12' } : {}), { status: 201 });
      }
      const id = Number(url.match(/\/api\/bug-reports\/(\d+)$/)?.[1]);
      return new Response(JSON.stringify({ projectId: id === 37 ? 1 : 2, title: 'Coupon not applied', steps: STEPS }), {
        status: 200,
      });
    }),
  );
  return posts;
}

describe('a report the page names', () => {
  const shop = { url: 'https://staging.shop.test/cart' } as chrome.tabs.Tab;
  const verdict = { source: 'replay', verdict: 'reproduced', origin: 'https://staging.shop.test' };

  it('is read only from the project the tab maps to', async () => {
    instance();
    expect(await handleGetBugReport(37, shop)).toMatchObject({ ok: true, steps: { title: 'Coupon not applied' } });
    expect(await handleGetBugReport(12, shop)).toMatchObject({ ok: false });
    expect(await handleGetBugReport(37, { url: 'https://unmapped.test/' } as chrome.tabs.Tab)).toMatchObject({
      ok: false,
    });
  });

  it('gets a verdict shared only when it is the stored replay’s report', async () => {
    const posts = instance();
    expect(await handleShareReproduction({ ...verdict, bugReportId: 37 })).toMatchObject({ ok: false });
    await setReplayState(newReplayState(STEPS as never, 'https://staging.shop.test', false, 0, null, 37));
    expect(await handleShareReproduction({ ...verdict, bugReportId: 12 })).toMatchObject({ ok: false });
    expect(posts).toEqual([]);
    expect(await handleShareReproduction({ ...verdict, bugReportId: 37 })).toEqual({ ok: true });
    expect(posts).toEqual([`${INSTANCE}/api/bug-reports/37/reproductions`]);
  });

  it('gets a desktop run’s verdict shared only once it was sent to the desktop app', async () => {
    const posts = instance();
    secrets.data.set('desktop', { url: 'http://127.0.0.1:4318', token: 'pd_desktop' });
    const desktop = { ...verdict, source: 'desktop', origin: null, bugReportId: 37 };
    expect(await handleShareReproduction(desktop)).toMatchObject({ ok: false });
    expect(await handleDesktopRepro({ steps: STEPS, bugReportId: 37 })).toMatchObject({ ok: true, id: 'ab12' });
    expect(await handleShareReproduction(desktop)).toEqual({ ok: true });
    expect(posts).toEqual([
      'http://127.0.0.1:4318/api/desktop/repro-requests',
      `${INSTANCE}/api/bug-reports/37/reproductions`,
    ]);
  });
});
