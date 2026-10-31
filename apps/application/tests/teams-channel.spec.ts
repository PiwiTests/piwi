/**
 * The Microsoft Teams channel type: created from the channel form, its
 * webhook URL kept secret like Slack's. The cards themselves are unit-tested
 * (tests/unit/teams-cards.test.ts), since safeFetch refuses the test server's
 * loopback address.
 */
import { test, expect } from './fixtures';

test.describe.configure({ timeout: 90_000 });

test('a Teams channel is created from the form and never echoes its webhook URL', async ({ page, request }) => {
  const name = 'Teams channel e2e';
  await page.goto('/settings/notifications');
  await expect(async () => {
    await page.getByRole('button', { name: 'Add channel' }).click();
    await expect(page.getByText('New channel')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await page.getByTestId('channel-name').fill(name);
  await page.getByTestId('channel-type').click();
  await page.getByRole('option', { name: 'Microsoft Teams webhook' }).click();
  await page.getByTestId('teams-webhook-url').fill('https://example.webhook.office.com/webhookb2/abc');
  await page.getByRole('button', { name: 'Save channel' }).click();
  await expect(page.getByText('Microsoft Teams webhook').first()).toBeVisible();

  const { items } = (await (await request.get('/api/channels')).json()) as {
    items: Array<{ id: number; name: string; type: string; config: Record<string, unknown> }>;
  };
  const channel = items.find((c) => c.name === name);
  expect(channel?.type).toBe('teams');
  expect(channel?.config.webhookUrl).toBeUndefined();
  await request.delete(`/api/channels/${channel!.id}`);
});
