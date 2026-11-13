/**
 * The Zephyr Scale connect form: the region and token are checked before anything is saved, the connection is stored
 * for the chosen region, and no endpoint ever returns the token. The server only talks to Zephyr's regional hosts, so
 * the check answer is served from the browser side; what is saved and returned is the real server behavior.
 */
import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

const NAME = 'Zephyr connect e2e';
const TOKEN = 'zephyr-e2e-token-0123456789';

interface Summary {
  id: number;
  name: string;
  provider: string;
  hasCredentials: boolean;
  config: { region?: string; baseUrl?: string } | null;
}

async function listZephyr(request: APIRequestContext): Promise<Summary[]> {
  const res = await request.get('/api/integrations/connections');
  const { connections } = (await res.json()) as { connections: Summary[] };
  return connections.filter((c) => c.provider === 'zephyr-scale');
}

async function removeConnections(request: APIRequestContext) {
  for (const c of (await listZephyr(request)).filter((c) => c.name === NAME)) {
    await request.delete(`/api/integrations/connections/${c.id}`);
  }
}

test.describe.serial('Integrations — the Zephyr Scale connect form', () => {
  test.describe.configure({ timeout: 90_000 });

  test.afterAll(async ({ request }) => {
    await removeConnections(request);
  });

  test('checks the token on the chosen region, then saves a connection that never returns it', async ({
    page,
    request,
  }) => {
    let checkBody: Record<string, unknown> | null = null;
    await page.route('**/api/integrations/connections/check', async (route) => {
      checkBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        json: {
          site: { ok: true },
          auth: { ok: true, account: { id: 'zephyr-scale:eu', displayName: 'Zephyr Scale Cloud (Europe)' } },
          projects: { ok: true, count: 2, keys: ['ABC', 'DEF'] },
        },
      });
    });

    await page.goto('/settings/integrations');
    const form = page.locator('[data-shot="zephyr-scale-connection-form"]');
    await expect(async () => {
      await page.getByRole('button', { name: 'Connect Zephyr Scale Cloud' }).first().click();
      await expect(form).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });

    await page.getByTestId('region').click();
    await page.getByRole('option', { name: 'Europe', exact: true }).click();
    await page.getByTestId('connection-name').fill(NAME);
    await page.getByTestId('credential-apiToken').fill(TOKEN);

    await form.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByTestId('region-check')).toContainText('Connected to Zephyr Scale Cloud (Europe).');
    await expect(page.getByTestId('region-check')).toContainText('Sees 2 projects: ABC, DEF');
    expect(checkBody).toMatchObject({ provider: 'zephyr-scale', region: 'eu' });
    expect(checkBody).not.toHaveProperty('baseUrl');

    await form.getByRole('button', { name: 'Connect' }).click();
    await expect(form).toBeHidden();

    const saved = (await listZephyr(request)).filter((c) => c.name === NAME);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ hasCredentials: true, config: { region: 'eu' } });

    const raw = await (await request.get('/api/integrations/connections')).text();
    expect(raw).not.toContain(TOKEN);
    const one = await (await request.get(`/api/integrations/connections/${saved[0]!.id}`)).text();
    expect(one).not.toContain(TOKEN);
  });

  test('ignores a typed host and refuses an unknown region', async ({ request }) => {
    const hostile = await request.post('/api/integrations/connections', {
      data: {
        provider: 'zephyr-scale',
        name: NAME,
        region: 'us',
        baseUrl: 'https://attacker.example.com',
        credentials: { apiToken: TOKEN },
      },
    });
    expect(hostile.ok()).toBe(true);
    const created = (await listZephyr(request)).filter((c) => c.name === NAME && c.config?.region === 'us');
    expect(created).toHaveLength(1);
    expect(JSON.stringify(created[0])).not.toContain('attacker.example.com');

    const unknown = await request.post('/api/integrations/connections', {
      data: { provider: 'zephyr-scale', name: NAME, region: 'mars', credentials: { apiToken: TOKEN } },
    });
    expect(unknown.status()).toBe(400);
  });

  test('deletes the connection', async ({ page, request }) => {
    await removeConnections(request);
    await page.goto('/settings/integrations');
    await expect(page.getByText(NAME)).toHaveCount(0);
    expect((await listZephyr(request)).filter((c) => c.name === NAME)).toHaveLength(0);
  });
});
