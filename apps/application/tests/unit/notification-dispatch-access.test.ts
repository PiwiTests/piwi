import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/**
 * A delivery is queued, and a queued one sent, only while its subscription is active and not muted, and its
 * subscriber and the owner of its personal channel can still read the project its event is about; a quality report,
 * every project of its snapshot.
 */

const slack = vi.hoisted(() => ({ bodies: [] as string[] }));

vi.mock('../../server/utils/safe-fetch', () => ({
  safeFetch: vi.fn(async (_url: string, init: { body: string }) => {
    slack.bodies.push(init.body);
    return new Response('ok', { status: 200 });
  }),
}));

delete process.env.PIWI_DATABASE_URL;
const authEnabled = process.env.PIWI_AUTH_ENABLED;
process.env.PIWI_AUTH_ENABLED = 'true';
afterAll(() => {
  if (authEnabled === undefined) delete process.env.PIWI_AUTH_ENABLED;
  else process.env.PIWI_AUTH_ENABLED = authEnabled;
});

const { sweepOutbox } = await import('../../server/utils/notifications/dispatch');
const { matchAndEnqueue } = await import('../../server/utils/notifications/match');

let db: TempDb;
let close: () => Promise<void>;
const USER = 1;
const ADMIN = 2;
const PROJECT = 10;

const run = (runId: number) => ({
  runId,
  projectId: PROJECT,
  projectName: 'web',
  status: 'failed',
  totalTests: 2,
  failedTests: 1,
  passedTests: 1,
  flakyTests: 0,
});

/** A Slack channel of the user's own and their subscription to the project, in `mode`. */
async function subscribe(mode: 'digest' | 'realtime'): Promise<{ channelId: number; subscriptionId: number }> {
  const [channel] = await db
    .insert(schema.notificationChannels)
    .values({ name: 'Mine', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/x' }, userId: USER })
    .returning({ id: schema.notificationChannels.id });
  const [subscription] = await db
    .insert(schema.subscriptions)
    .values({
      userId: USER,
      channelId: channel!.id,
      projectId: PROJECT,
      events: ['run.failed'],
      mode,
      digestAt: '09:00',
    })
    .returning({ id: schema.subscriptions.id });
  return { channelId: channel!.id, subscriptionId: subscription!.id };
}

async function enqueue(target: { channelId: number; subscriptionId: number | null }, runId: number): Promise<number> {
  const [row] = await db
    .insert(schema.notificationDeliveries)
    .values({
      ...target,
      event: 'run.failed',
      payload: run(runId),
      dedupeKey: `run.failed:${runId}:${target.channelId}`,
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

beforeEach(async () => {
  slack.bodies = [];
  ({ db, close } = await openTempDb());
  await db.insert(schema.users).values([
    { id: USER, username: 'vera', password: '', role: 'member' },
    { id: ADMIN, username: 'ada', password: '', role: 'administrator' },
  ]);
  await db.insert(schema.projects).values({ id: PROJECT, name: 'web' });
  await db.insert(schema.roleBindings).values({ userId: USER, projectId: PROJECT, role: 'viewer' });
});
afterEach(() => close());

describe('a queued delivery', () => {
  test('goes out while its subscriber can read the project', async () => {
    const target = await subscribe('digest');
    const ids = [await enqueue(target, 1), await enqueue(target, 2)];

    expect(await sweepOutbox(db as never)).toEqual({ sent: 2, failed: 0 });
    expect(slack.bodies).toHaveLength(1);
    for (const id of ids) expect(await rowOf(id)).toMatchObject({ status: 'sent' });
  });

  test('is dropped, digest or not, once its subscriber lost access to the project', async () => {
    const digest = await subscribe('digest');
    const realtime = await subscribe('realtime');
    const ids = [await enqueue(digest, 1), await enqueue(digest, 2), await enqueue(realtime, 3)];
    await db.delete(schema.roleBindings).where(eq(schema.roleBindings.userId, USER));

    expect(await sweepOutbox(db as never)).toEqual({ sent: 0, failed: 0 });
    expect(slack.bodies).toEqual([]);
    for (const id of ids) {
      expect(await rowOf(id)).toMatchObject({
        status: 'skipped',
        attempts: 1,
        error: 'The recipient can no longer read the project',
      });
    }

    // A skipped delivery is never swept again.
    await db.insert(schema.roleBindings).values({ userId: USER, projectId: PROJECT, role: 'viewer' });
    expect(await sweepOutbox(db as never)).toEqual({ sent: 0, failed: 0 });
    expect(slack.bodies).toEqual([]);
  });

  test('goes with its subscription, or its user, once removed', async () => {
    const removed = await subscribe('digest');
    await enqueue(removed, 1);
    await enqueue(removed, 2);
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.id, removed.subscriptionId));
    await enqueue(await subscribe('realtime'), 3);
    await db.delete(schema.users).where(eq(schema.users.id, USER));

    expect(await sweepOutbox(db as never)).toEqual({ sent: 0, failed: 0 });
    expect(slack.bodies).toEqual([]);
    expect(await db.select().from(schema.notificationDeliveries)).toEqual([]);
  });

  test("on another user's subscription to a personal channel follows the access of the channel owner too", async () => {
    const target = await subscribe('realtime');
    await db
      .update(schema.subscriptions)
      .set({ userId: ADMIN })
      .where(eq(schema.subscriptions.id, target.subscriptionId));
    const id = await enqueue(target, 1);
    await db.delete(schema.roleBindings).where(eq(schema.roleBindings.userId, USER));

    expect(await sweepOutbox(db as never)).toEqual({ sent: 0, failed: 0 });
    expect(slack.bodies).toEqual([]);
    expect(await rowOf(id)).toMatchObject({ status: 'skipped', error: 'The recipient can no longer read the project' });
  });

  test('to a personal channel with no subscription follows the access of the channel owner', async () => {
    const [channel] = await db
      .insert(schema.notificationChannels)
      .values({
        name: 'Mine',
        type: 'slack',
        config: { webhookUrl: 'https://hooks.slack.com/services/x' },
        userId: USER,
      })
      .returning({ id: schema.notificationChannels.id });
    const id = await enqueue({ channelId: channel!.id, subscriptionId: null }, 1);
    await db.delete(schema.roleBindings).where(eq(schema.roleBindings.userId, USER));

    await sweepOutbox(db as never);

    expect(slack.bodies).toEqual([]);
    expect(await rowOf(id)).toMatchObject({ status: 'skipped' });
  });
});

describe('a queued delivery whose subscription changed since', () => {
  test('is dropped, digest or not, once the subscription is muted', async () => {
    const digest = await subscribe('digest');
    const realtime = await subscribe('realtime');
    const ids = [await enqueue(digest, 1), await enqueue(digest, 2), await enqueue(realtime, 3)];
    await db.update(schema.subscriptions).set({ mutedUntil: new Date(Date.now() + 60 * 60 * 1000) });

    expect(await sweepOutbox(db as never)).toEqual({ sent: 0, failed: 0 });
    expect(slack.bodies).toEqual([]);
    for (const id of ids) {
      expect(await rowOf(id)).toMatchObject({ status: 'skipped', attempts: 1, error: 'The subscription is muted' });
    }
  });

  test('goes out once the mute has ended', async () => {
    const id = await enqueue(await subscribe('realtime'), 1);
    await db.update(schema.subscriptions).set({ mutedUntil: new Date(Date.now() - 1000) });

    expect(await sweepOutbox(db as never)).toEqual({ sent: 1, failed: 0 });
    expect(await rowOf(id)).toMatchObject({ status: 'sent' });
  });

  test('is dropped once the subscription is turned off', async () => {
    const id = await enqueue(await subscribe('realtime'), 1);
    await db.update(schema.subscriptions).set({ active: false });

    expect(await sweepOutbox(db as never)).toEqual({ sent: 0, failed: 0 });
    expect(slack.bodies).toEqual([]);
    expect(await rowOf(id)).toMatchObject({ status: 'skipped', error: 'The subscription is no longer active' });
  });
});

describe('a queued quality report', () => {
  const OTHER_PROJECT = 11;

  /** A webhook channel, the user's own or global, and a report of `projectIds` queued to it. */
  async function queueReport(owner: number | null, projectIds: number[] | null): Promise<number> {
    const [channel] = await db
      .insert(schema.notificationChannels)
      .values({ name: 'Hook', type: 'webhook', config: { url: 'https://hooks.example.test/piwi' }, userId: owner })
      .returning({ id: schema.notificationChannels.id });
    const [snapshot] = await db
      .insert(schema.reportSnapshots)
      .values({
        dashboardRef: 'builtin:overview',
        dashboardName: 'Overview',
        projectIds,
        periodFrom: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        periodTo: new Date(),
        bundle: { title: 'Weekly' },
      })
      .returning({ id: schema.reportSnapshots.id });
    const [row] = await db
      .insert(schema.notificationDeliveries)
      .values({
        subscriptionId: null,
        channelId: channel!.id,
        event: 'report.ready',
        payload: { snapshotId: snapshot!.id, scheduleId: 1, periodEnd: '2026-11-01' },
        dedupeKey: `report.ready:${snapshot!.id}:${channel!.id}`,
        status: 'pending',
        scheduledFor: new Date(Date.now() - 1000),
      })
      .returning({ id: schema.notificationDeliveries.id });
    return row!.id;
  }

  beforeEach(async () => {
    await db.insert(schema.projects).values({ id: OTHER_PROJECT, name: 'api' });
  });

  test('goes to a personal channel while its owner reads every project of the report', async () => {
    const id = await queueReport(USER, [PROJECT]);

    expect(await sweepOutbox(db as never)).toEqual({ sent: 1, failed: 0 });
    expect(await rowOf(id)).toMatchObject({ status: 'sent' });
  });

  test('is dropped, never retried, once the owner of its personal channel cannot read a project of it', async () => {
    const some = await queueReport(USER, [PROJECT, OTHER_PROJECT]);
    const every = await queueReport(USER, null);

    expect(await sweepOutbox(db as never)).toEqual({ sent: 0, failed: 0 });
    expect(slack.bodies).toEqual([]);
    for (const id of [some, every]) {
      expect(await rowOf(id)).toMatchObject({
        status: 'skipped',
        attempts: 1,
        error: 'The recipient can no longer read every project of the report',
      });
    }
    await db.insert(schema.roleBindings).values({ userId: USER, projectId: OTHER_PROJECT, role: 'viewer' });
    expect(await sweepOutbox(db as never)).toEqual({ sent: 0, failed: 0 });
  });

  test('goes to a global channel as it is', async () => {
    const id = await queueReport(null, [PROJECT, OTHER_PROJECT]);

    expect(await sweepOutbox(db as never)).toEqual({ sent: 1, failed: 0 });
    expect(await rowOf(id)).toMatchObject({ status: 'sent' });
  });

  test('goes to a personal channel whatever its owner reads while authentication is off', async () => {
    process.env.PIWI_AUTH_ENABLED = 'false';
    vi.stubGlobal('useRuntimeConfig', () => ({ authEnabled: false }));
    try {
      const id = await queueReport(USER, [PROJECT, OTHER_PROJECT]);

      expect(await sweepOutbox(db as never)).toEqual({ sent: 1, failed: 0 });
      expect(await rowOf(id)).toMatchObject({ status: 'sent' });
    } finally {
      vi.unstubAllGlobals();
      process.env.PIWI_AUTH_ENABLED = 'true';
    }
  });
});

describe('queuing an event', () => {
  test("on another user's subscription to a personal channel needs the channel owner's access too", async () => {
    const target = await subscribe('realtime');
    await db
      .update(schema.subscriptions)
      .set({ userId: ADMIN })
      .where(eq(schema.subscriptions.id, target.subscriptionId));

    expect(await matchAndEnqueue(db as never, 'run.failed', run(1) as never)).toBe(1);
    await db.delete(schema.roleBindings).where(eq(schema.roleBindings.userId, USER));
    expect(await matchAndEnqueue(db as never, 'run.failed', run(2) as never)).toBe(0);
  });
});
