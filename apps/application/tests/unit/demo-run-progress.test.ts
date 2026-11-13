import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DemoEventMessage } from '../../app/demo/run-events';
import { RUN_PROGRESS_INTERVAL_MS } from '../../server/utils/run-progress-throttle';

/**
 * The demo's tallies, as its service worker broadcasts them to the lists (`app/demo/run-events.ts`): throttled per run
 * as the server's `/api/stream` sends them, the run's held tally before its next lifecycle event.
 */

let channel: BroadcastChannel;
let messages: DemoEventMessage[];
let events: typeof import('../../app/demo/run-events');

/** Let the channel deliver what was posted. */
async function delivered() {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** What the channel carried: a tally's passed count, or a lifecycle event's type. */
const carried = () =>
  messages.map((m) =>
    m.scope === 'progress' ? `progress ${m.event.passedTests}` : m.scope === 'global' ? m.event.type : m.scope,
  );

const tally = (passedTests: number) => ({
  runId: 5,
  projectId: 1,
  totalTests: 10,
  passedTests,
  failedTests: 0,
  skippedTests: 0,
  didNotRunTests: 0,
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.resetModules();
  events = await import('../../app/demo/run-events');
  messages = [];
  channel = new BroadcastChannel('piwi-demo-run-events');
  channel.onmessage = (event) => messages.push(event.data as DemoEventMessage);
});

afterEach(() => {
  channel.close();
  vi.useRealTimers();
});

describe('the demo’s tallies', () => {
  test('broadcasts a run’s first tally at once, then its latest one every 2 seconds', async () => {
    for (const passed of [1, 2, 3]) events.publishDemoRunProgress(tally(passed));
    await delivered();
    expect(carried()).toEqual(['progress 1']);
    expect(messages[0]).toEqual({ scope: 'progress', event: tally(1) });
    await vi.advanceTimersByTimeAsync(RUN_PROGRESS_INTERVAL_MS);
    await delivered();
    expect(carried()).toEqual(['progress 1', 'progress 3']);
  });

  test('broadcasts the run’s held tally before its next lifecycle event', async () => {
    events.publishDemoRunProgress(tally(4));
    events.publishDemoRunProgress(tally(10));
    events.publishDemoGlobalEvent({ type: 'run-finished', runId: 5, projectId: 1, status: 'passed' });
    await delivered();
    expect(carried()).toEqual(['progress 4', 'progress 10', 'run-finished']);
  });
});
