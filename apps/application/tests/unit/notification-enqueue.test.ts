import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/** Queuing a notification's deliveries: a repeat is skipped, any other failed insert is reported. */

delete process.env.PIWI_DATABASE_URL;

const { matchAndEnqueue } = await import('../../server/utils/notifications/match');

let db: TempDb;
let close: () => Promise<void>;

const payload = {
  runId: 1,
  projectId: 10,
  projectName: 'web',
  status: 'failed',
  totalTests: 2,
  failedTests: 1,
  passedTests: 1,
  flakyTests: 0,
  flakinessRate: 0,
};

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values({ id: 10, name: 'web' });
  await db.insert(schema.notificationChannels).values([
    { id: 1, name: 'Hook', type: 'webhook', config: { url: 'https://hooks.example.com/a' } },
    { id: 2, name: 'Slack', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/x' } },
  ]);
  await db.insert(schema.subscriptions).values([1, 2].map((channelId) => ({ channelId, events: ['run.failed'] })));
});
afterEach(() => {
  vi.restoreAllMocks();
  return close();
});

async function queuedChannels(): Promise<number[]> {
  const rows = await db
    .select({ channelId: schema.notificationDeliveries.channelId })
    .from(schema.notificationDeliveries);
  return rows.map((row) => row.channelId).sort();
}

describe('matchAndEnqueue', () => {
  test('queues the same event once per channel', async () => {
    expect(await matchAndEnqueue(db as never, 'run.failed', payload as never)).toBe(2);
    expect(await matchAndEnqueue(db as never, 'run.failed', payload as never)).toBe(0);
    expect(await queuedChannels()).toEqual([1, 2]);
  });

  test('reports an insert that failed for another reason, after queuing the other channels', async () => {
    const insert = db.insert.bind(db);
    let calls = 0;
    vi.spyOn(db, 'insert').mockImplementation(((table: never) => {
      if (++calls > 1) return insert(table);
      return {
        values: async () => {
          throw Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' });
        },
      };
    }) as never);

    await expect(matchAndEnqueue(db as never, 'run.failed', payload as never)).rejects.toThrow('SQLITE_BUSY');
    expect(await queuedChannels()).toEqual([2]);
  });
});
