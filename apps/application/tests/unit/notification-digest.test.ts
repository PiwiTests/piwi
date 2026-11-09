import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

/** A digest batch sends what it can draw: a row whose payload cannot be drawn fails alone. */

const slack = vi.hoisted(() => ({ bodies: [] as string[] }));

vi.mock('../../server/utils/safe-fetch', () => ({
  safeFetch: vi.fn(async (_url: string, init: { body: string }) => {
    slack.bodies.push(init.body);
    return new Response('ok', { status: 200 });
  }),
}));

delete process.env.PIWI_DATABASE_URL;
const { sweepOutbox } = await import('../../server/utils/notifications/dispatch');

let db: ReturnType<typeof drizzle<typeof schema>>;
let channelId = 0;
let subscriptionId = 0;

const run = (runId: number) => ({
  runId,
  projectId: 1,
  projectName: 'web',
  status: 'failed',
  totalTests: 2,
  failedTests: 1,
  passedTests: 1,
  flakyTests: 0,
});

async function enqueue(event: string, payload: unknown): Promise<number> {
  const [row] = await db
    .insert(schema.notificationDeliveries)
    .values({
      subscriptionId,
      channelId,
      event,
      payload: payload as Record<string, unknown>,
      dedupeKey: `${event}:${JSON.stringify(payload)}`,
      status: 'pending',
      scheduledFor: new Date(Date.now() - 1000),
    })
    .returning({ id: schema.notificationDeliveries.id });
  return row!.id;
}

async function rowOf(id: number) {
  const [row] = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, id));
  return row!;
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  const [channel] = await db
    .insert(schema.notificationChannels)
    .values({ name: 'Slack', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/x' } })
    .returning({ id: schema.notificationChannels.id });
  channelId = channel!.id;
  const [subscription] = await db
    .insert(schema.subscriptions)
    .values({ channelId, events: ['run.failed', 'bug.looks_fixed'], mode: 'digest', digestAt: '09:00' })
    .returning({ id: schema.subscriptions.id });
  subscriptionId = subscription!.id;
});

beforeEach(async () => {
  slack.bodies = [];
  await db.delete(schema.notificationDeliveries);
});

describe('a digest batch', () => {
  test('sends the rows it can draw and fails the one it cannot', async () => {
    const first = await enqueue('run.failed', run(1));
    const second = await enqueue('run.failed', run(2));
    // A looks-fixed event that names no tests cannot be drawn.
    const broken = await enqueue('bug.looks_fixed', { projectId: 1, projectName: 'web', runId: 3 });

    const result = await sweepOutbox(db as never);

    expect(result).toEqual({ sent: 2, failed: 1 });
    expect(slack.bodies).toHaveLength(1);
    expect((JSON.parse(slack.bodies[0]!) as { text: string }).text).toContain('2 notifications');
    expect(await rowOf(first)).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await rowOf(second)).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await rowOf(broken)).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await rowOf(broken)).error).toBeTruthy();
  });
});
