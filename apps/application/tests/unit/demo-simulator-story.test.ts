import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { FAILURE_STORIES } from '#shared/demo/failure-stories.mjs';
import { streamSimulation } from './demo-simulator-harness';

interface StreamedStep {
  title: string;
  subtitle?: string;
  duration: number;
  startTime: number;
  failed?: boolean;
}

interface CompleteEvent {
  type: 'complete';
  title: string;
  status: string;
  duration: number;
  startedAt: number;
  steps: StreamedStep[];
  stepEvents: Array<{ title: string; startedAt: number; duration: number; status: string }>;
  wastedTimeMs: number | null;
  networkRequests: Array<{ method: string; url: string; startTime: number; duration: number }>;
  consoleLogs: Array<{ text: string; timestamp: number }> | null;
  dialogs: Array<{ closedAt: number }> | null;
}

let simulator: typeof import('~~/app/demo/simulator');

// The simulator's module graph is large: loaded before the tests, its import
// never counts against the first test's timeout when the whole suite runs.
beforeAll(async () => {
  simulator = await import('~~/app/demo/simulator');
}, 60_000);

/** The `complete` events a simulator scenario streams to a stubbed reporter API. */
async function streamScenario(id: string): Promise<CompleteEvent[]> {
  const { events } = await streamSimulation(simulator, id);
  return events.filter((e) => e.type === 'complete') as unknown as CompleteEvent[];
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the 'failures' scenario's cluster-1 attempts", () => {
  const story = FAILURE_STORIES.find((s) => s.clusterId === 1)!;
  const quote = story.evidence.failingNetwork![0]!;

  test('place the quote, the console warning and the dialog where the seed puts them in the attempt', async () => {
    const completes = await streamScenario('failures');
    const failing = completes.filter((c) => story.failingCases.some((fc) => fc.title === c.title));
    expect(failing).toHaveLength(2);

    for (const c of failing) {
      const end = c.startedAt + c.duration;
      const cvv = c.steps.find((s) => s.title === 'Fill "123"')!;
      const pay = c.steps.at(-1)!;
      expect(pay.failed, `${c.title}: ends on the Pay click`).toBe(true);
      expect(pay.startTime + pay.duration - c.startedAt, `${c.title}: the click runs to the test timeout`).toBe(30000);

      const req = c.networkRequests.find((r) => r.method === quote.method && r.url === quote.url)!;
      expect(req.startTime, `${c.title}: the quote starts after the CVV step`).toBeGreaterThanOrEqual(
        cvv.startTime + cvv.duration,
      );
      expect(req.startTime, `${c.title}: the quote starts during the Pay click`).toBeGreaterThanOrEqual(pay.startTime);
      expect(req.startTime + req.duration, `${c.title}: the quote is in flight at the timeout`).toBeGreaterThan(
        pay.startTime + pay.duration,
      );
      for (const r of c.networkRequests) {
        expect(r.startTime, `${c.title}: ${r.url} starts inside the attempt`).toBeGreaterThanOrEqual(c.startedAt);
        expect(r.startTime, `${c.title}: ${r.url} starts inside the attempt`).toBeLessThanOrEqual(end);
      }

      const [warning] = c.consoleLogs!;
      expect(warning!.timestamp - req.startTime, `${c.title}: warning 20 s into the quote`).toBe(
        story.evidence.consoleOnFail![0]!.intoSlowRequestMs,
      );
      expect(warning!.timestamp).toBeLessThanOrEqual(end);
      for (const d of c.dialogs ?? []) {
        expect(pay.startTime + pay.duration - d.closedAt, `${c.title}: dialog closes just before the failure`).toBe(
          150,
        );
      }
    }
  });

  test('run the beforeEach navigation inside the before hooks and never sleep', async () => {
    const completes = await streamScenario('failures');
    for (const c of completes.filter((e) => story.failingCases.some((fc) => fc.title === e.title))) {
      const hooks = c.stepEvents.find((e) => e.title === 'Before Hooks')!;
      const navigate = c.steps[0]!;
      expect(navigate.title).toBe('Navigate');
      expect(navigate.startTime, `${c.title}: navigation starts after the fixtures`).toBeGreaterThan(hooks.startedAt);
      expect(navigate.startTime + navigate.duration, `${c.title}: inside the beforeEach hook`).toBe(
        hooks.startedAt + hooks.duration,
      );
      expect(c.stepEvents.filter((e) => e.status === 'wasted')).toEqual([]);
      expect(c.wastedTimeMs).toBeNull();
    }
  });
});
