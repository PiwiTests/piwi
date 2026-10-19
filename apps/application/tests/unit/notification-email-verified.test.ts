import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/** Notification email goes only to verified addresses: a tested email channel, a verified account email. */

delete process.env.PIWI_DATABASE_URL;

const { matchAndEnqueue } = await import('../../server/utils/notifications/match');

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.users).values([
    { id: 1, username: 'vera', password: '', role: 'member', email: 'vera@example.com', emailVerified: true },
    { id: 2, username: 'una', password: '', role: 'member', email: 'una@example.com', emailVerified: false },
  ]);
  await db.insert(schema.projects).values({ id: 10, name: 'web' });
  await db.insert(schema.notificationChannels).values([
    { id: 1, name: 'Tested', type: 'email', config: { address: 'team@example.com' }, verified: true },
    { id: 2, name: 'Untested', type: 'email', config: { address: 'someone@example.com' }, verified: false },
    { id: 3, name: 'Vera', type: 'personal_email', config: {}, userId: 1, verified: true },
    { id: 4, name: 'Una', type: 'personal_email', config: {}, userId: 2, verified: true },
    { id: 5, name: 'Slack', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/x' }, verified: false },
  ]);
  // Global subscriptions, so the subscriber's project access plays no part.
  await db
    .insert(schema.subscriptions)
    .values([1, 2, 3, 4, 5].map((channelId) => ({ channelId, events: ['run.finished'] })));
});
afterEach(() => close());

describe('matchAndEnqueue', () => {
  test('queues email only for verified addresses, and other channels whatever their state', async () => {
    const payload = {
      runId: 1,
      projectId: 10,
      projectName: 'web',
      status: 'passed',
      totalTests: 1,
      failedTests: 0,
      passedTests: 1,
      flakyTests: 0,
      flakinessRate: 0,
    };
    await matchAndEnqueue(db as never, 'run.finished', payload as never);
    const queued = await db
      .select({ channelId: schema.notificationDeliveries.channelId })
      .from(schema.notificationDeliveries);
    expect(queued.map((d) => d.channelId).sort()).toEqual([1, 3, 5]);
  });
});
