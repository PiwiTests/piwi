import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

/** Queuing a notification's deliveries: a repeat is skipped, any other failed insert is reported. */

delete process.env.PIWI_DATABASE_URL;

vi.mock('../../server/utils/notifications/dispatch', () => ({ sweepOutbox: async () => 0 }));

const { matchAndEnqueue } = await import('../../server/utils/notifications/match');
const { emitNotification } = await import('../../server/utils/notifications/emit');

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

describe('emitNotification', () => {
  test('gives a run’s event the environment its label resolves to, which the environment filters match', async () => {
    await db
      .insert(schema.environments)
      .values({ projectId: 10, key: 'staging', keyFold: 'staging', name: 'Staging', aliases: ['stg'] });
    const filter = (channelId: number, environments: string[]) =>
      db
        .update(schema.subscriptions)
        .set({ filters: { environments } })
        .where(eq(schema.subscriptions.channelId, channelId));
    await filter(1, ['Staging']);
    await filter(2, ['production']);

    await emitNotification(db as never, 'run.failed', { ...payload, environment: 'stg' } as never);
    const rows = await db.select().from(schema.notificationDeliveries);
    expect(rows.map((row) => row.channelId)).toEqual([1]);
    expect(rows[0]!.payload).toMatchObject({
      environment: 'stg',
      environmentName: 'Staging',
      environmentKey: 'staging',
      environmentAliases: ['stg'],
    });
  });
});
