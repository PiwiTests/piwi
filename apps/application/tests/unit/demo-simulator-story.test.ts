import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { FAILURE_STORIES } from '#shared/demo/failure-stories.mjs';

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

/** The real `setTimeout`, captured before any test installs fake timers. */
const realSetTimeout = globalThis.setTimeout;

// The simulator's module graph is large: loaded before the tests, its import
// never counts against the first test's timeout when the whole suite runs.
// It reads `$fetch` at call time, so the stub below still applies.
beforeAll(async () => {
  simulator = await import('~~/app/demo/simulator');
}, 60_000);

/**
 * Run a simulator scenario against a stubbed reporter API on fake timers and
 * return the `complete` events it streamed.
 */
async function streamScenario(id: string): Promise<CompleteEvent[]> {
  vi.useFakeTimers();
  const completes: CompleteEvent[] = [];
  vi.stubGlobal(
    '$fetch',
    vi.fn(async (url: string, opts?: { body?: { testCases?: Array<{ type: string }> } }) => {
      if (url.endsWith('/setup')) return { runId: 1, projectId: 1, setupToken: 'setup' };
      if (url.endsWith('/begin')) return { streamToken: 'stream' };
      for (const event of opts?.body?.testCases ?? []) {
        if (event.type === 'complete') completes.push(event as CompleteEvent);
      }
      return {};
    }),
  );
  const { DEMO_SCENARIOS, runSimulation } = simulator;
  const run = runSimulation(DEMO_SCENARIOS.find((s) => s.id === id)!);
  let settled = false;
  void run.then(
    () => (settled = true),
    () => (settled = true),
  );
  // Between its fake timers the simulator awaits real work (SHA-256 digests on the
  // thread pool), so the timer queue can be empty while the run is still going:
  // keep advancing until the run settles.
  while (!settled) {
    await vi.runAllTimersAsync();
    if (!settled) await new Promise((resolve) => realSetTimeout(resolve, 1));
  }
  await run;
  return completes;
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
