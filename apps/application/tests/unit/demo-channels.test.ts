import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { openTempDb, type TempDb } from './temp-db';

/**
 * The demo's notification channels: a channel added in the demo is stored in its database and listed after the
 * account email, validated and returned as the server's routes do.
 */

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('~~/app/demo/db.client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDemoDb: async () => state.db,
}));

const { handleDemoRequest } = await import('~~/app/demo/api/router');

interface Channel {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

let db: TempDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
});

afterAll(() => close());

const list = async () => ((await handleDemoRequest('/api/channels', 'GET')) as { items: Channel[] }).items;
const add = async (body: unknown) =>
  ((await handleDemoRequest('/api/channels', 'POST', body)) as { channel: Channel }).channel;

describe('the demo notification channels', () => {
  test('lists the account email, then each channel added, without its secrets', async () => {
    expect((await list()).map((c) => c.name)).toEqual(['Account email']);
    const slack = await add({
      name: 'Team Slack',
      type: 'slack',
      config: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' },
    });
    const hook = await add({ name: 'CI hook', type: 'webhook', config: { url: 'https://ci.test/hook', secret: 's' } });

    expect(slack.id).toBeGreaterThan(1);
    expect(hook.id).toBeGreaterThan(slack.id);
    expect(slack.config).toEqual({});
    expect(hook.config).toEqual({ url: 'https://ci.test/hook' });
    expect((await list()).map((c) => [c.name, c.type])).toEqual([
      ['Account email', 'personal_email'],
      ['Team Slack', 'slack'],
      ['CI hook', 'webhook'],
    ]);
  });

  test('refuses a channel the server refuses', async () => {
    await expect(add({ name: 'Mail', type: 'email', config: {} })).rejects.toMatchObject({ statusCode: 400 });
    await expect(add({ name: 'Pager', type: 'pager', config: {} })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('names the channel a subscription goes to, and deletes its subscriptions with it', async () => {
    const team = await add({ name: 'Team mail', type: 'email', config: { address: 'team@example.com' } });
    const { subscription } = (await handleDemoRequest('/api/subscriptions', 'POST', {
      channelId: team.id,
      events: ['run.failed'],
    })) as { subscription: { channel: { name: string } } };
    expect(subscription.channel.name).toBe('Team mail');

    await handleDemoRequest(`/api/channels/${team.id}`, 'DELETE');
    expect((await list()).some((c) => c.id === team.id)).toBe(false);
    const subs = (await handleDemoRequest('/api/subscriptions', 'GET')) as { items: unknown[] };
    expect(subs.items).toEqual([]);
  });

  test('keeps the account email', async () => {
    await expect(handleDemoRequest('/api/channels/1', 'DELETE')).rejects.toMatchObject({ statusCode: 400 });
  });
});
