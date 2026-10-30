import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from '../../server/database/schema.sqlite';
import { migrateToLatest } from './temp-db';

/**
 * The notification outbox sends each delivery once: overlapping sweeps share
 * one pass at a time, every row is claimed before it is sent, a row another
 * sweep holds is left alone, and a claim whose lease ran out is retried.
 */

const webhook = vi.hoisted(() => ({
  bodies: [] as string[],
  /** Runs while a request is in flight. */
  duringSend: null as (() => Promise<void>) | null,
}));

// A webhook receiver that answers after a moment, so a sweep is still sending
// while the next call arrives.
vi.mock('../../server/utils/safe-fetch', () => ({
  safeFetch: vi.fn(async (_url: string, init: { body: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await webhook.duringSend?.();
    webhook.bodies.push(init.body);
    return new Response(null, { status: 200 });
  }),
}));

delete process.env.PIWI_DATABASE_URL;
const { sweepOutbox } = await import('../../server/utils/notifications/dispatch');
const { OUTBOX_LEASE_MS } = await import('../../server/utils/outbox');

let db: ReturnType<typeof drizzle<typeof schema>>;
let channelId = 0;
let seq = 0;

async function enqueue(over: Partial<typeof schema.notificationDeliveries.$inferInsert> = {}): Promise<number> {
  seq++;
  const [row] = await db
    .insert(schema.notificationDeliveries)
    .values({
      channelId,
      event: 'run.failed',
      payload: { seq },
      dedupeKey: `run.failed:${seq}`,
      status: 'pending',
      scheduledFor: new Date(Date.now() - 1000),
      ...over,
    })
    .returning({ id: schema.notificationDeliveries.id });
  return row!.id;
}

/** How many webhook calls carried each delivery's payload. */
function sendsOf(id: number, seqOf: Map<number, number>): number {
  const want = seqOf.get(id);
  return webhook.bodies.filter((b) => (JSON.parse(b) as { payload: { seq: number } }).payload.seq === want).length;
}

async function statusOf(id: number) {
  const [row] = await db.select().from(schema.notificationDeliveries).where(eq(schema.notificationDeliveries.id, id));
  return row!;
}

beforeAll(async () => {
  db = drizzle(createClient({ url: ':memory:' }), { schema });
  await migrateToLatest(db);
  const [channel] = await db
    .insert(schema.notificationChannels)
    .values({ name: 'Hook', type: 'webhook', config: { url: 'https://hooks.example.com/piwi' } })
    .returning({ id: schema.notificationChannels.id });
  channelId = channel!.id;
});

beforeEach(async () => {
  webhook.bodies = [];
  webhook.duringSend = null;
  await db.delete(schema.notificationDeliveries);
});

describe('sweepOutbox', () => {
  test('two sweeps started together send each delivery once', async () => {
    const seqOf = new Map<number, number>();
    for (let i = 0; i < 3; i++) {
      const id = await enqueue();
      seqOf.set(id, seq);
    }

    const first = sweepOutbox(db as never);
    const second = sweepOutbox(db as never);
    await Promise.all([first, second]);

    expect(webhook.bodies).toHaveLength(3);
    for (const id of seqOf.keys()) {
      expect(sendsOf(id, seqOf)).toBe(1);
      expect(await statusOf(id)).toMatchObject({ status: 'sent', attempts: 1 });
    }
  });

  test('a delivery written during a sweep goes out in the follow-up pass', async () => {
    await enqueue();
    const first = sweepOutbox(db as never);
    const late = await enqueue();
    const second = sweepOutbox(db as never);
    await Promise.all([first, second]);

    expect(webhook.bodies).toHaveLength(2);
    expect((await statusOf(late)).status).toBe('sent');
  });

  test('a delivery another sweep has claimed is not sent again', async () => {
    const held = await enqueue({ status: 'processing', scheduledFor: new Date(Date.now() + OUTBOX_LEASE_MS) });
    const result = await sweepOutbox(db as never);

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(webhook.bodies).toHaveLength(0);
    expect((await statusOf(held)).status).toBe('processing');
  });

  test('a claim whose lease ran out is retried', async () => {
    const stuck = await enqueue({ status: 'processing', scheduledFor: new Date(Date.now() - 1000) });
    const result = await sweepOutbox(db as never);

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(await statusOf(stuck)).toMatchObject({ status: 'sent', attempts: 1 });
  });

  test('a delivery is claimed, with a lease, while it is being sent', async () => {
    const id = await enqueue();
    let inFlight: Awaited<ReturnType<typeof statusOf>> | null = null;
    webhook.duringSend = async () => {
      inFlight = await statusOf(id);
    };
    await sweepOutbox(db as never);

    expect(inFlight).toMatchObject({ status: 'processing' });
    expect(inFlight!.scheduledFor!.getTime()).toBeGreaterThan(Date.now());
    expect((await statusOf(id)).status).toBe('sent');
  });
});
