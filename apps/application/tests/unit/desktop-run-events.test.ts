import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../../server/database/schema.sqlite';
import { openTempDb, type TempDb } from './temp-db';

// The schema barrel picks the PostgreSQL schema when PIWI_DATABASE_URL is set,
// so clear it before the modules under test load.
delete process.env.PIWI_DATABASE_URL;

const { desktopRunEvents } = await import('../../server/utils/desktop-run-events');

let db: TempDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  await db.insert(schema.projects).values({ id: 1, name: 'shop' });
  await db.insert(schema.testRuns).values([
    {
      id: 5,
      projectId: 1,
      status: 'running',
      startTime: new Date(Date.UTC(2026, 0, 1)),
      origin: 'bisect',
      metadata: { piwiOrigin: { kind: 'bisect', ref: '12' }, piwiRunRef: 'desktop-3-unattended' },
    },
    { id: 6, projectId: 1, status: 'running', startTime: new Date(Date.UTC(2026, 0, 2)), metadata: null },
  ]);
});

afterEach(async () => {
  await close();
});

/** The events sent, once every one queued so far went out. */
async function sentEvents(sent: unknown[]) {
  await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return sent;
}

describe('the desktop window’s run events', () => {
  test('a lifecycle event and a run of the snapshot name what launched the run', async () => {
    const sent: unknown[] = [];
    const events = desktopRunEvents(db, (payload) => sent.push(payload));
    events.snapshot(async () => [{ id: 5, status: 'running' }]);
    events.lifecycle({ type: 'run-finished', runId: 5, projectId: 1, status: 'failed' });
    expect(await sentEvents(sent)).toEqual([
      {
        type: 'snapshot',
        runs: [{ id: 5, status: 'running', origin: 'bisect', originRef: '12', runName: 'desktop-3-unattended' }],
      },
      {
        type: 'run-finished',
        runId: 5,
        projectId: 1,
        status: 'failed',
        origin: 'bisect',
        originRef: '12',
        runName: 'desktop-3-unattended',
      },
    ]);
  });

  test('go out in the order they came, the snapshot first, a run with no stamp read as local', async () => {
    const sent: Array<{ type: string }> = [];
    const events = desktopRunEvents(db, (payload) => sent.push(payload as { type: string }));
    events.snapshot(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [];
    });
    events.lifecycle({ type: 'run-started', runId: 6, projectId: 1 });
    events.progress({
      runId: 6,
      projectId: 1,
      totalTests: 3,
      passedTests: 1,
      failedTests: 0,
      skippedTests: 0,
      didNotRunTests: 0,
    });
    events.lifecycle({ type: 'run-finished', runId: 6, projectId: 1, status: 'passed' });
    await sentEvents(sent);
    expect(sent.map((event) => event.type)).toEqual(['snapshot', 'run-started', 'run-progress', 'run-finished']);
    expect(sent[1]).toMatchObject({ origin: 'local', originRef: null, runName: null });
  });

  test('a snapshot that cannot be read sends nothing, and the events after it still go', async () => {
    const sent: Array<{ type: string }> = [];
    const events = desktopRunEvents(db, (payload) => sent.push(payload as { type: string }));
    events.snapshot(async () => {
      throw new Error('database locked');
    });
    events.lifecycle({ type: 'run-cancelled', runId: 99, projectId: 1, status: 'cancelled' });
    expect(await sentEvents(sent)).toEqual([{ type: 'run-cancelled', runId: 99, projectId: 1, status: 'cancelled' }]);
  });
});
