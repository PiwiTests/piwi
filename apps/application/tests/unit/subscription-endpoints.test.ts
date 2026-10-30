import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { apiError } from '../../server/utils/api-error';
import { passesSubscriptionFilters, type RunFinishedPayload } from '#shared/notification-events';
import { subscriptionFiltersSchema } from '#shared/subscription-filters';
import { migrateToLatest } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the route modules (which import the barrel) are loaded.
delete process.env.PIWI_DATABASE_URL;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../server/database', () => ({ getDatabase: async () => state.db }));
vi.mock('../../server/utils/auth', async () => ({
  requireAuth: async () => ({ id: 0, role: 'administrator' }),
  getRequestAccess: async () => (await import('#shared/permissions')).ADMIN_ACCESS,
  isAuthEnabled: () => false,
}));

interface FakeEvent {
  body?: unknown;
  params?: Record<string, string>;
}

vi.stubGlobal('defineRouteMeta', () => {});
vi.stubGlobal('eventHandler', (handler: unknown) => handler);
vi.stubGlobal('readBody', async (event: FakeEvent) => event.body);
vi.stubGlobal('getRouterParam', (event: FakeEvent, name: string) => event.params?.[name]);
vi.stubGlobal('apiError', apiError);

type Handler = (event: FakeEvent) => Promise<{ subscription: { id: number; filters: unknown } }>;
const createSubscription = (await import('../../server/api/subscriptions/index.post')).default as unknown as Handler;
const updateSubscription = (await import('../../server/api/subscriptions/[id].patch')).default as unknown as Handler;

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let channelId: number;

beforeEach(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  state.db = db;
  const [channel] = await db
    .insert(schema.notificationChannels)
    .values({ name: 'ops', type: 'slack', config: { webhookUrl: 'https://hooks.example.com/x' }, userId: null })
    .returning();
  channelId = channel!.id;
});

const create = (filters?: unknown) =>
  createSubscription({ body: { channelId, events: ['run.failed'], ...(filters === undefined ? {} : { filters }) } });

async function storedFilters(id: number): Promise<unknown> {
  const [row] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, id));
  return row!.filters;
}

const run = (owners: string[]): RunFinishedPayload => ({
  runId: 1,
  projectId: 2,
  projectName: 'web',
  status: 'failed',
  totalTests: 10,
  failedTests: 2,
  passedTests: 8,
  flakyTests: 0,
  owners,
});

describe('POST /api/subscriptions filters', () => {
  test('persists the owners filter and every other filter it accepts', async () => {
    const filters = {
      branches: ['main', 'release/*'],
      environments: ['staging'],
      statuses: ['failed'],
      defaultBranchOnly: true,
      owners: ['@team/checkout'],
      flakinessThreshold: 0.2,
      perfRegressionPct: 15,
    };
    const { subscription } = await create(filters);
    expect(subscription.filters).toEqual(filters);
    expect(await storedFilters(subscription.id)).toEqual(filters);
  });

  test('a stored owners filter routes a run to the owning team only', async () => {
    const { subscription } = await create({ owners: ['@team/checkout'] });
    const stored = (await storedFilters(subscription.id)) as Parameters<typeof passesSubscriptionFilters>[0];
    expect(passesSubscriptionFilters(stored, 'run.failed', run(['@team/checkout']))).toBe(true);
    expect(passesSubscriptionFilters(stored, 'run.failed', run(['@team/search']))).toBe(false);
  });

  test('stores no filters when none are sent', async () => {
    const { subscription } = await create();
    expect(await storedFilters(subscription.id)).toBeNull();
  });

  test('trims branch and environment names and rejects a blank one', async () => {
    const { subscription } = await create({ branches: [' main '], environments: ['staging '] });
    expect(await storedFilters(subscription.id)).toEqual({ branches: ['main'], environments: ['staging'] });
    await expect(create({ branches: [' '] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(create({ environments: 'staging' })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects an owners filter that is not a list of strings', async () => {
    await expect(create({ owners: '@team/checkout' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(create({ owners: [1] })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('PATCH /api/subscriptions/:id filters', () => {
  const patch = (id: number, body: unknown) => updateSubscription({ params: { id: String(id) }, body });

  test('replaces the filters, owners included', async () => {
    const { subscription } = await create({ branches: ['main'] });
    const { subscription: updated } = await patch(subscription.id, {
      filters: { owners: ['@team/checkout'], defaultBranchOnly: true },
    });
    expect(updated.filters).toEqual({ owners: ['@team/checkout'], defaultBranchOnly: true });
    expect(await storedFilters(subscription.id)).toEqual({ owners: ['@team/checkout'], defaultBranchOnly: true });
  });

  test('null clears the filters and an absent field leaves them alone', async () => {
    const { subscription } = await create({ owners: ['@team/checkout'] });
    await patch(subscription.id, { active: false });
    expect(await storedFilters(subscription.id)).toEqual({ owners: ['@team/checkout'] });
    await patch(subscription.id, { filters: null });
    expect(await storedFilters(subscription.id)).toBeNull();
  });

  test('rejects a filter of the wrong type and keeps what is stored', async () => {
    const { subscription } = await create({ owners: ['@team/checkout'] });
    await expect(patch(subscription.id, { filters: { owners: '@team/search' } })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(patch(subscription.id, { filters: { flakinessThreshold: 'high' } })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(patch(subscription.id, { filters: { flakinessThreshold: 2 } })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(patch(subscription.id, { filters: 'main' })).rejects.toMatchObject({ statusCode: 400 });
    expect(await storedFilters(subscription.id)).toEqual({ owners: ['@team/checkout'] });
  });
});

describe('subscriptionFiltersSchema', () => {
  test('drops keys that are not delivery filters', () => {
    expect(subscriptionFiltersSchema.parse({ owners: ['a'], unknown: 1 })).toEqual({ owners: ['a'] });
  });
});
