/**
 * The new-channel form's setup helpers: the Slack app link pre-filled with the
 * Piwi manifest, a Slack channel posting through the Web API with a bot token
 * that is never sent back, a URL pasted under the wrong type offering the right one, a
 * test sent before saving (to a loopback address here, which the SSRF guard
 * refuses without any outside network), and a name suggested from the destination.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

test.describe.configure({ timeout: 90_000 });

async function openForm(page: Page) {
  await page.goto('/settings/notifications');
  await expect(async () => {
    await page.getByRole('button', { name: 'Add channel' }).click();
    await expect(page.getByText('New channel')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  return page.locator('[data-shot="channel-form"]');
}

async function pickType(page: Page, label: string) {
  await page.locator('[data-shot="channel-form"]').getByRole('combobox').first().click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

test('the Slack steps link to an app pre-filled with the incoming-webhook scope', async ({ page }) => {
  await openForm(page);
  await pickType(page, 'Slack');
  const href = await page.getByRole('link', { name: 'Create a Slack app for Piwi' }).getAttribute('href');
  const url = new URL(href!);
  expect(url.origin + url.pathname).toBe('https://api.slack.com/apps');
  expect(JSON.parse(url.searchParams.get('manifest_json')!).oauth_config.scopes.bot).toEqual(['incoming-webhook']);
});

test('a Slack channel saved with a bot token shows its channel ID and never returns the token', async ({
  page,
  request,
}) => {
  const token = 'xoxb-e2e-0000-channel-form-secret';
  const form = await openForm(page);
  await pickType(page, 'Slack');
  await form.getByRole('radio', { name: 'Bot token (Web API)' }).check();

  const href = await form.getByRole('link', { name: 'Create a Slack app for Piwi' }).getAttribute('href');
  const manifest = JSON.parse(new URL(href!).searchParams.get('manifest_json')!);
  expect(manifest.oauth_config.scopes.bot).toEqual(['chat:write', 'chat:write.public']);

  await page.getByTestId('slack-bot-token').fill(token);
  await expect(form.getByText('Enter the channel ID')).toBeVisible();
  await expect(form.getByText('webhook URL')).toHaveCount(0);
  await page.getByTestId('slack-channel-id').fill('#general');
  await expect(form.getByText('Enter the channel ID')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Save channel' })).toBeDisabled();

  await page.getByTestId('slack-channel-id').fill('C0E2E000001');
  await page.getByTestId('channel-name').fill('Slack bot channel-form');
  await form.getByRole('button', { name: 'Save channel' }).click();
  await expect(page.getByText('Slack Web API, channel C0E2E000001')).toBeVisible();

  const res = await request.get('/api/channels');
  expect(await res.text()).not.toContain(token);
  const { items } = (await res.json()) as {
    items: Array<{ id: number; name: string; config: Record<string, unknown> }>;
  };
  const channel = items.find((c) => c.name === 'Slack bot channel-form');
  expect(channel?.config).toEqual({ channelId: 'C0E2E000001' });
  await request.delete(`/api/channels/${channel!.id}`);
});

test('creating a Slack channel with a bot token returns it masked', async ({ request }) => {
  const token = 'xoxb-e2e-0000-api-secret';
  const res = await request.post('/api/channels', {
    data: { name: 'Slack bot API', type: 'slack', config: { token, channelId: 'C0E2E000002' } },
  });
  expect(res.ok()).toBe(true);
  expect(await res.text()).not.toContain(token);
  const { channel } = (await res.json()) as { channel: { id: number; config: Record<string, unknown> } };
  expect(channel.config).toEqual({ channelId: 'C0E2E000002' });
  await request.delete(`/api/channels/${channel.id}`);

  const refused = await request.post('/api/channels', {
    data: { name: 'Slack bot no ID', type: 'slack', config: { token, channelId: 'general' } },
  });
  expect(refused.status()).toBe(400);
});

test('a Slack URL pasted under Teams offers to switch, keeping the URL', async ({ page }) => {
  const form = await openForm(page);
  await pickType(page, 'Microsoft Teams webhook');
  await page.getByTestId('teams-webhook-url').fill('https://hooks.slack.com/services/T000/B000/XXXX');
  await expect(page.getByTestId('channel-url-check')).toContainText('This is a Slack webhook.');
  await form.getByRole('button', { name: 'Switch to Slack' }).click();
  await expect(form.getByRole('combobox').first()).toContainText('Slack');
  await expect(page.getByTestId('slack-webhook-url')).toHaveValue('https://hooks.slack.com/services/T000/B000/XXXX');
  await expect(page.getByTestId('channel-url-check')).toContainText('Slack incoming webhook.');
});

test('a test sent before saving reports a refused destination with a hint', async ({ page }) => {
  const form = await openForm(page);
  await pickType(page, 'Webhook');
  await page.getByTestId('webhook-url').fill('http://127.0.0.1:9/hook');
  await expect(page.getByTestId('channel-url-check')).toContainText('private and loopback');
  await form.getByRole('button', { name: 'Send test' }).click();
  const result = page.getByTestId('channel-test-result');
  await expect(result).toContainText('URL host is not allowed');
  await expect(result).toContainText('Use an address reachable from the internet.');
});

test('a channel saved without a name takes the suggested one', async ({ page, request }) => {
  const form = await openForm(page);
  await pickType(page, 'Webhook');
  await page.getByTestId('webhook-url').fill('https://channel-form-e2e.example.com/hook');
  await expect(page.getByTestId('channel-name')).toHaveAttribute(
    'placeholder',
    'Webhook (channel-form-e2e.example.com)',
  );
  await form.getByRole('button', { name: 'Save channel' }).click();
  await expect(page.getByText('Webhook (channel-form-e2e.example.com)')).toBeVisible();

  const { items } = (await (await request.get('/api/channels')).json()) as {
    items: Array<{ id: number; name: string; verified: boolean }>;
  };
  const channel = items.find((c) => c.name === 'Webhook (channel-form-e2e.example.com)');
  expect(channel?.verified).toBe(false);
  await request.delete(`/api/channels/${channel!.id}`);
});

test('creating a channel without its destination is refused', async ({ request }) => {
  const res = await request.post('/api/channels', { data: { name: 'No URL', type: 'slack', config: {} } });
  expect(res.status()).toBe(400);
  expect(((await res.json()) as { message: string }).message).toMatch(/webhook URL/);
});
