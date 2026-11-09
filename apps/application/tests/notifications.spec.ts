/**
 * Notifications API & UI integration tests.
 *
 * Covers channels CRUD, subscriptions CRUD (mute / unmute / filter), and the
 * Subscribe Bell UI component on the project detail page.
 *
 * Requires a dedicated auth-enabled server on port 3097, which is only started in CI.
 * All tests are skipped when CI is not set.
 *
 * To run locally: CI=1 npx playwright test notifications
 */

import { test, expect } from './fixtures';
import { ProjectRole } from '#shared/permissions';
import { readSseUntil } from './utils/sse';
import { createMember } from './utils/access';
import { PROJECT } from '#shared/test-project-names';

// All tests share a single auth-enabled server — must run serially.
test.describe.configure({ mode: 'serial' });

const BASE = 'http://localhost:3097';
const ADMIN = { username: 'admin', password: 'adminpassword123' };

function skip() {
  test.skip(!process.env.CI, 'Notifications server tests only run in CI (see playwright.config.ts webServer)');
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function api(method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function loginAs(username: string, password: string): Promise<string> {
  const res = await api('POST', '/api/auth/login', { username, password });
  const header = res.headers.get('set-cookie') ?? '';
  return header.split(';')[0] ?? '';
}

// ── Shared state ───────────────────────────────────────────────────────────────

let adminCookie = '';
let userCookie = '';
let projectId = 0;
let channelId = 0;
let webhookChannelId = 0;
let subscriptionId = 0;

// ── Setup ──────────────────────────────────────────────────────────────────────

test.describe.serial('Setup', () => {
  test('bootstrap admin and clean state', async () => {
    skip();
    // Create admin (200 first run, 400 if already exists — both are acceptable)
    await api('POST', '/api/auth/setup', { ...ADMIN, name: 'Admin' });
    adminCookie = await loginAs(ADMIN.username, ADMIN.password);
    expect(adminCookie).toBeTruthy();

    // Delete any channels left from a previous run (cascades to subscriptions)
    const listRes = await api('GET', '/api/channels', undefined, adminCookie);
    const { items: channels } = (await listRes.json()) as { items: Array<{ id: number }> };
    for (const ch of channels) {
      await api('DELETE', `/api/channels/${ch.id}`, undefined, adminCookie);
    }
  });

  test('create a test project', async () => {
    skip();
    const res = await api(
      'POST',
      '/api/test-runs/submit',
      {
        projectName: PROJECT.NOTIFICATIONS_SERVER,
        status: 'passed',
        startTime: new Date().toISOString(),
        duration: 1000,
        totalTests: 2,
        passedTests: 2,
        failedTests: 0,
        skippedTests: 0,
        testCases: [],
      },
      adminCookie,
    );
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { projectId: number };
    projectId = data.projectId;
    expect(projectId).toBeGreaterThan(0);
  });

  test('create a member (Viewer of every project) for ownership tests', async () => {
    skip();
    await createMember(
      { baseUrl: BASE, cookie: adminCookie },
      { username: 'notif-user', password: 'userpassword123', role: ProjectRole.VIEWER },
    );
    userCookie = await loginAs('notif-user', 'userpassword123');
    expect(userCookie).toBeTruthy();
  });
});

// ── Channels API ───────────────────────────────────────────────────────────────

test.describe.serial('Channels API', () => {
  test('GET /api/channels returns 401 without a session', async () => {
    skip();
    const res = await api('GET', '/api/channels');
    expect(res.status).toBe(401);
  });

  test('GET /api/channels returns empty list for fresh admin', async () => {
    skip();
    const res = await api('GET', '/api/channels', undefined, adminCookie);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { items: unknown[] };
    expect(data.items).toHaveLength(0);
  });

  test('POST /api/channels creates an email channel', async () => {
    skip();
    const res = await api(
      'POST',
      '/api/channels',
      {
        name: 'Test email channel',
        type: 'email',
        config: { address: 'notify@example.com' },
      },
      adminCookie,
    );
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { success: boolean; channel: { id: number; name: string; type: string } };
    expect(data.success).toBe(true);
    expect(data.channel.type).toBe('email');
    channelId = data.channel.id;
    expect(channelId).toBeGreaterThan(0);
  });

  test('GET /api/channels lists created channel with full config', async () => {
    skip();
    const res = await api('GET', '/api/channels', undefined, adminCookie);
    const data = (await res.json()) as {
      items: Array<{ id: number; name: string; type: string; config: Record<string, unknown> }>;
    };
    const ch = data.items.find((c) => c.id === channelId);
    expect(ch).toBeDefined();
    expect(ch?.name).toBe('Test email channel');
    expect(ch?.config.address).toBe('notify@example.com');
  });

  test('POST /api/channels creates a webhook channel; secret is not returned to clients', async () => {
    skip();
    const res = await api(
      'POST',
      '/api/channels',
      {
        name: 'Test webhook',
        type: 'webhook',
        config: { url: 'https://example.com/hook', secret: 'my-webhook-secret' },
      },
      adminCookie,
    );
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { success: boolean; channel: { id: number } };
    webhookChannelId = data.channel.id;

    const listRes = await api('GET', '/api/channels', undefined, adminCookie);
    const listData = (await listRes.json()) as { items: Array<{ id: number; config: Record<string, unknown> }> };
    const wh = listData.items.find((c) => c.id === webhookChannelId);
    expect(wh?.config.url).toBe('https://example.com/hook');
    expect(wh?.config.secret).toBeUndefined();
  });

  test('POST /api/channels/[id]/test returns SMTP-not-configured for email channel', async () => {
    skip();
    const res = await api('POST', `/api/channels/${channelId}/test`, undefined, adminCookie);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { success: boolean; error?: string };
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/SMTP/i);
  });

  test("non-owner cannot delete another user's channel", async () => {
    skip();
    const res = await api('DELETE', `/api/channels/${channelId}`, undefined, userCookie);
    expect(res.status).toBe(403);
  });

  test('POST /api/channels rejects invalid type', async () => {
    skip();
    const res = await api(
      'POST',
      '/api/channels',
      {
        name: 'Bad channel',
        type: 'carrier-pigeon',
        config: {},
      },
      adminCookie,
    );
    expect(res.status).toBe(400);
  });

  test('POST /api/channels creates a browser channel', async () => {
    skip();
    const res = await api('POST', '/api/channels', { name: 'My tabs', type: 'browser', config: {} }, adminCookie);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { success: boolean; channel: { id: number; type: string } };
    expect(data.channel.type).toBe('browser');
    await api('DELETE', `/api/channels/${data.channel.id}`, undefined, adminCookie);
  });

  test('DELETE /api/channels/[id] removes the webhook channel', async () => {
    skip();
    const res = await api('DELETE', `/api/channels/${webhookChannelId}`, undefined, adminCookie);
    expect(res.ok).toBe(true);
    const listRes = await api('GET', '/api/channels', undefined, adminCookie);
    const data = (await listRes.json()) as { items: Array<{ id: number }> };
    expect(data.items.find((c) => c.id === webhookChannelId)).toBeUndefined();
  });
});

// ── Subscriptions API ──────────────────────────────────────────────────────────

test.describe.serial('Subscriptions API', () => {
  test('POST /api/subscriptions creates a subscription', async () => {
    skip();
    const res = await api(
      'POST',
      '/api/subscriptions',
      {
        channelId,
        projectId,
        events: ['run.failed', 'run.finished'],
        mode: 'realtime',
      },
      adminCookie,
    );
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { success: boolean; subscription: { id: number } };
    expect(data.success).toBe(true);
    subscriptionId = data.subscription.id;
    expect(subscriptionId).toBeGreaterThan(0);
  });

  test('POST /api/subscriptions rejects empty events array', async () => {
    skip();
    const res = await api(
      'POST',
      '/api/subscriptions',
      {
        channelId,
        projectId,
        events: [],
      },
      adminCookie,
    );
    expect(res.status).toBe(400);
  });

  test('GET /api/subscriptions lists the subscription with channel info', async () => {
    skip();
    const res = await api('GET', '/api/subscriptions', undefined, adminCookie);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as {
      items: Array<{ id: number; events: string[]; channel: { id: number; type: string } }>;
    };
    const sub = data.items.find((s) => s.id === subscriptionId);
    expect(sub).toBeDefined();
    expect(sub?.events).toContain('run.failed');
    expect(sub?.events).toContain('run.finished');
    expect(sub?.channel.id).toBe(channelId);
    expect(sub?.channel.type).toBe('email');
  });

  test('GET /api/subscriptions?projectId= filters correctly', async () => {
    skip();
    const res = await api('GET', `/api/subscriptions?projectId=${projectId}`, undefined, adminCookie);
    const data = (await res.json()) as { items: Array<{ id: number }> };
    expect(data.items.some((s) => s.id === subscriptionId)).toBe(true);

    const res2 = await api('GET', '/api/subscriptions?projectId=999999', undefined, adminCookie);
    const data2 = (await res2.json()) as { items: unknown[] };
    expect(data2.items).toHaveLength(0);
  });

  test('PATCH /api/subscriptions/[id] mutes subscription for 7 days', async () => {
    skip();
    const mutedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const res = await api('PATCH', `/api/subscriptions/${subscriptionId}`, { mutedUntil }, adminCookie);
    expect(res.ok).toBe(true);

    const listRes = await api('GET', '/api/subscriptions', undefined, adminCookie);
    const data = (await listRes.json()) as { items: Array<{ id: number; mutedUntil: string | null }> };
    const sub = data.items.find((s) => s.id === subscriptionId);
    expect(sub?.mutedUntil).toBeTruthy();
    expect(new Date(sub!.mutedUntil!).getTime()).toBeGreaterThan(Date.now());
  });

  test('PATCH /api/subscriptions/[id] unmutes subscription', async () => {
    skip();
    const res = await api('PATCH', `/api/subscriptions/${subscriptionId}`, { mutedUntil: null }, adminCookie);
    expect(res.ok).toBe(true);

    const listRes = await api('GET', '/api/subscriptions', undefined, adminCookie);
    const data = (await listRes.json()) as { items: Array<{ id: number; mutedUntil: string | null }> };
    const sub = data.items.find((s) => s.id === subscriptionId);
    expect(sub?.mutedUntil).toBeNull();
  });

  test("non-owner gets 404 when deleting another user's subscription", async () => {
    skip();
    // userCookie belongs to notif-user who did not create this subscription
    const res = await api('DELETE', `/api/subscriptions/${subscriptionId}`, undefined, userCookie);
    expect(res.status).toBe(404);
  });

  test('DELETE /api/subscriptions/[id] removes the subscription', async () => {
    skip();
    const res = await api('DELETE', `/api/subscriptions/${subscriptionId}`, undefined, adminCookie);
    expect(res.ok).toBe(true);

    const listRes = await api('GET', '/api/subscriptions', undefined, adminCookie);
    const data = (await listRes.json()) as { items: Array<{ id: number }> };
    expect(data.items.find((s) => s.id === subscriptionId)).toBeUndefined();
  });
});

// ── Global channels & subscriptions ────────────────────────────────────────────

test.describe.serial('Global channels & subscriptions', () => {
  let globalChannelId = 0;
  let globalSubId = 0;

  test('non-admin cannot create a global channel', async () => {
    skip();
    const res = await api(
      'POST',
      '/api/channels',
      { name: 'Rogue global', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/x' }, global: true },
      userCookie,
    );
    expect(res.status).toBe(403);
  });

  test('admin creates a global channel visible to every user', async () => {
    skip();
    const res = await api(
      'POST',
      '/api/channels',
      {
        name: 'Team Slack',
        type: 'slack',
        config: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' },
        global: true,
      },
      adminCookie,
    );
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { channel: { id: number } };
    globalChannelId = data.channel.id;

    const listRes = await api('GET', '/api/channels', undefined, userCookie);
    const listData = (await listRes.json()) as {
      items: Array<{ id: number; userId: number | null; config: Record<string, unknown> }>;
    };
    const ch = listData.items.find((c) => c.id === globalChannelId);
    expect(ch).toBeDefined();
    expect(ch?.userId).toBeNull();
    expect(ch?.config.webhookUrl).toBeUndefined();
  });

  test("channel listing excludes other users' personal channels", async () => {
    skip();
    const res = await api(
      'POST',
      '/api/channels',
      { name: 'User personal email', type: 'email', config: { address: 'user@example.com' } },
      userCookie,
    );
    const data = (await res.json()) as { channel: { id: number } };
    const userChannelId = data.channel.id;

    const listRes = await api('GET', '/api/channels', undefined, adminCookie);
    const listData = (await listRes.json()) as { items: Array<{ id: number }> };
    expect(listData.items.find((c) => c.id === userChannelId)).toBeUndefined();

    const delRes = await api('DELETE', `/api/channels/${userChannelId}`, undefined, adminCookie);
    expect(delRes.ok).toBe(true);
  });

  test('non-admin cannot fire tests at a global channel', async () => {
    skip();
    const res = await api('POST', `/api/channels/${globalChannelId}/test`, undefined, userCookie);
    expect(res.status).toBe(403);
  });

  test('global subscriptions require admin and a global channel', async () => {
    skip();
    const nonAdmin = await api(
      'POST',
      '/api/subscriptions',
      { channelId: globalChannelId, projectId, events: ['run.failed'], global: true },
      userCookie,
    );
    expect(nonAdmin.status).toBe(403);

    const personalRes = await api(
      'POST',
      '/api/channels',
      { name: 'Admin personal', type: 'email', config: { address: 'admin@example.com' } },
      adminCookie,
    );
    const personalId = ((await personalRes.json()) as { channel: { id: number } }).channel.id;
    const onPersonal = await api(
      'POST',
      '/api/subscriptions',
      { channelId: personalId, projectId, events: ['run.failed'], global: true },
      adminCookie,
    );
    expect(onPersonal.status).toBe(400);
    await api('DELETE', `/api/channels/${personalId}`, undefined, adminCookie);

    const onGlobal = await api(
      'POST',
      '/api/subscriptions',
      { channelId: globalChannelId, projectId, events: ['run.failed'], global: true },
      adminCookie,
    );
    expect(onGlobal.ok).toBe(true);
    const subData = (await onGlobal.json()) as { subscription: { id: number } };
    globalSubId = subData.subscription.id;
    expect(globalSubId).toBeGreaterThan(0);
  });

  test('global subscription is listed for every user but only admins can modify it', async () => {
    skip();
    const listRes = await api('GET', '/api/subscriptions', undefined, userCookie);
    const listData = (await listRes.json()) as { items: Array<{ id: number; userId: number | null }> };
    const sub = listData.items.find((s) => s.id === globalSubId);
    expect(sub).toBeDefined();
    expect(sub?.userId).toBeNull();

    const patchRes = await api('PATCH', `/api/subscriptions/${globalSubId}`, { active: false }, userCookie);
    expect(patchRes.status).toBe(404);
    const delRes = await api('DELETE', `/api/subscriptions/${globalSubId}`, undefined, userCookie);
    expect(delRes.status).toBe(404);
  });

  test('admin removes the global subscription and channel', async () => {
    skip();
    const delSub = await api('DELETE', `/api/subscriptions/${globalSubId}`, undefined, adminCookie);
    expect(delSub.ok).toBe(true);
    const delCh = await api('DELETE', `/api/channels/${globalChannelId}`, undefined, adminCookie);
    expect(delCh.ok).toBe(true);
  });
});

// ── Browser stream filters ─────────────────────────────────────────────────────

test.describe.serial('Browser stream filters', () => {
  test("a browser subscription's environment filter holds back other environments' runs", async () => {
    skip();
    const channelRes = await api(
      'POST',
      '/api/channels',
      { name: 'Staging tabs', type: 'browser', config: {} },
      adminCookie,
    );
    const { channel } = (await channelRes.json()) as { channel: { id: number } };
    const subRes = await api(
      'POST',
      '/api/subscriptions',
      { channelId: channel.id, projectId, events: ['run.finished'], filters: { environments: ['staging'] } },
      adminCookie,
    );
    expect(subRes.ok).toBe(true);

    const controller = new AbortController();
    try {
      const stream = await fetch(`${BASE}/api/notifications/stream`, {
        headers: { Cookie: adminCookie },
        signal: controller.signal,
      });
      expect(stream.ok).toBe(true);

      for (const environment of ['qa', 'staging']) {
        const run = await api(
          'POST',
          '/api/test-runs/submit',
          {
            projectName: PROJECT.NOTIFICATIONS_SERVER,
            environment,
            status: 'passed',
            startTime: new Date().toISOString(),
            duration: 1000,
            totalTests: 0,
            passedTests: 0,
            failedTests: 0,
            skippedTests: 0,
            testCases: [],
          },
          adminCookie,
        );
        expect(run.ok).toBe(true);
      }

      const reader = stream.body!.getReader();
      const events = await readSseUntil(
        reader,
        (es) => es.some((e) => e.type === 'run.finished' && e.environment === 'staging'),
        15000,
      );
      reader.releaseLock();

      const finished = events.filter((e) => e.type === 'run.finished' && e.projectId === projectId);
      expect(finished.map((e) => e.environment)).toEqual(['staging']);
    } finally {
      controller.abort();
      await api('DELETE', `/api/channels/${channel.id}`, undefined, adminCookie);
    }
  });
});

// ── Subscribe Bell UI ──────────────────────────────────────────────────────────

test.describe.serial('Subscribe Bell UI', () => {
  async function loginBrowser(page: import('@playwright/test').Page) {
    // Log in via the browser context so the session cookie is shared with page navigation
    await page.context().request.post(`${BASE}/api/auth/login`, { data: ADMIN });
  }

  // The project page is server-rendered; in dev mode Vue hydration can lag a
  // second or more behind the first paint, so a bell click fired immediately
  // after navigation is lost before the popover's click handler is attached.
  // Retry opening the bell until the popover content (`marker`) is visible.
  async function openBell(page: import('@playwright/test').Page, marker: import('@playwright/test').Locator) {
    const bell = page.getByTitle('Notification subscriptions for this project');
    await expect(async () => {
      // Only click while the popover is closed — clicking again once it is open
      // would toggle it shut.
      if (!(await marker.isVisible())) {
        await bell.click();
      }
      await expect(marker).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 20000 });
  }

  test('bell is not visible when not authenticated', async ({ page }) => {
    skip();
    // Unauthenticated visits to a protected page are bounced to /login by the
    // global auth middleware, so the bell is never reachable. The flake was the
    // navigation, not the assertion: this is the first hit to /projects/[id] on
    // the auth-enabled dev server, and the cold Vite route-compile under shared
    // CI CPU can push page.goto past the 30 s test budget (hence the ~33 s
    // timeouts). Allow slow-test headroom, resolve on DOMContentLoaded (a
    // redirect can keep a subresource in flight and delay the `load` event), and
    // wait for the redirect to settle before asserting.
    test.slow();
    await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/login(\?|$)/, { timeout: 30000 });
    await expect(page.getByTitle('Notification subscriptions for this project')).not.toBeVisible();
  });

  test('bell is visible when authenticated', async ({ page }) => {
    skip();
    await loginBrowser(page);
    await page.goto(`${BASE}/projects/${projectId}`);
    await expect(page.getByTitle('Notification subscriptions for this project')).toBeVisible({ timeout: 15000 });
  });

  test('subscribe via bell popover creates a subscription', async ({ page }) => {
    skip();
    await loginBrowser(page);
    await page.goto(`${BASE}/projects/${projectId}`);

    const addButton = page.getByRole('button', { name: 'Add' });
    await openBell(page, addButton);
    await addButton.click();
    await expect(page.getByRole('button', { name: 'Subscribe' })).toBeVisible();
    await page.getByRole('button', { name: 'Subscribe' }).click();

    // Wait for success toast (exact match: the toast also exposes an aria-live
    // alert reading "Notification Subscribed", which a substring match would also hit)
    await expect(page.getByText('Subscribed', { exact: true })).toBeVisible({ timeout: 10000 });

    // Verify via API that subscription was created
    const res = await api('GET', `/api/subscriptions?projectId=${projectId}`, undefined, adminCookie);
    const data = (await res.json()) as { items: Array<{ id: number }> };
    expect(data.items.length).toBeGreaterThan(0);
    subscriptionId = data.items[0]!.id;
  });

  test('bell shows subscription and unsubscribe button after subscribing', async ({ page }) => {
    skip();
    await loginBrowser(page);
    await page.goto(`${BASE}/projects/${projectId}`);

    // The subscription row and unsubscribe button should be visible
    await openBell(page, page.getByTitle('Unsubscribe'));
    await expect(page.getByTitle('Unsubscribe')).toBeVisible();
  });

  test('unsubscribe via bell popover removes subscription', async ({ page }) => {
    skip();
    await loginBrowser(page);
    await page.goto(`${BASE}/projects/${projectId}`);

    const unsubscribe = page.getByTitle('Unsubscribe').first();
    await openBell(page, unsubscribe);
    await unsubscribe.click();

    // Wait for success toast (exact match: the toast also exposes an aria-live
    // alert reading "Notification Unsubscribed", which a substring match would also hit)
    await expect(page.getByText('Unsubscribed', { exact: true })).toBeVisible();

    // Verify via API that subscription was removed
    const res = await api('GET', `/api/subscriptions?projectId=${projectId}`, undefined, adminCookie);
    const data = (await res.json()) as { items: unknown[] };
    expect(data.items).toHaveLength(0);
  });

  test('subscribe via bell with a branch filter stores it and shows it on the row', async ({ page }) => {
    skip();
    await loginBrowser(page);
    await page.goto(`${BASE}/projects/${projectId}`);

    const addButton = page.getByRole('button', { name: 'Add' });
    await openBell(page, addButton);
    await addButton.click();
    await page.getByTestId('subscription-branches').fill('release/*');
    await page.getByRole('option').filter({ hasText: 'release/*' }).click();
    await page.getByRole('button', { name: 'Subscribe' }).click();
    await expect(page.getByText('Subscribed', { exact: true })).toBeVisible({ timeout: 10000 });

    const res = await api('GET', `/api/subscriptions?projectId=${projectId}`, undefined, adminCookie);
    const data = (await res.json()) as { items: Array<{ id: number; filters: { branches?: string[] } | null }> };
    const created = data.items.find((s) => s.filters?.branches?.includes('release/*'));
    expect(created?.filters).toEqual({ branches: ['release/*'] });
    await expect(page.getByTestId('subscription-filters')).toHaveText('Branch: release/*');

    await api('DELETE', `/api/subscriptions/${created!.id}`, undefined, adminCookie);
  });

  test('notifications settings page shows SMTP unconfigured state', async ({ page }) => {
    skip();
    await loginBrowser(page);
    await page.goto(`${BASE}/settings/notifications`);
    await expect(page.getByText('Not configured')).toBeVisible();
    await expect(page.getByText('PIWI_SMTP_HOST')).toBeVisible();
  });

  test('notifications settings page shows channels and subscriptions sections', async ({ page }) => {
    skip();
    await loginBrowser(page);
    await page.goto(`${BASE}/settings/notifications`);
    await expect(page.getByRole('heading', { name: 'Notification channels' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Subscriptions' })).toBeVisible();
  });
});
