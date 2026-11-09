import { vi } from 'vitest';
import type { SimulationController, SimulationHooks } from '~~/app/demo/simulator';

type Simulator = typeof import('~~/app/demo/simulator');

/** What a simulated run sent the reporter API: every event it streamed, in order, and its `/finish` body. */
export interface StreamedRun {
  events: Array<Record<string, unknown>>;
  finish: Record<string, unknown> | null;
}

/** The real `setTimeout`, captured before any test installs fake timers. */
const realSetTimeout = globalThis.setTimeout;

/**
 * Run a simulator scenario against a stubbed reporter API on fake timers and return what it sent. Load the simulator
 * in a `beforeAll` and pass it: its module graph is large, and it reads `$fetch` at call time, so the stub applies.
 * `onRequest` sees each request before it is answered, as a test that stops the run on one needs.
 */
export async function streamSimulation(
  simulator: Simulator,
  id: string,
  opts: {
    hooks?: SimulationHooks;
    ctl?: SimulationController;
    onRequest?: (url: string, body: Record<string, unknown> | undefined) => void;
  } = {},
): Promise<StreamedRun> {
  vi.useFakeTimers();
  const sent: StreamedRun = { events: [], finish: null };
  vi.stubGlobal(
    '$fetch',
    vi.fn(async (url: string, init?: { body?: Record<string, unknown> }) => {
      opts.onRequest?.(url, init?.body);
      if (url.endsWith('/setup')) return { runId: 1, projectId: 1, setupToken: 'setup' };
      if (url.endsWith('/begin')) return { streamToken: 'stream' };
      if (url.endsWith('/finish')) sent.finish = init?.body ?? null;
      const events = init?.body?.testCases;
      if (Array.isArray(events)) sent.events.push(...events);
      return {};
    }),
  );
  const { DEMO_SCENARIOS, runSimulation } = simulator;
  const run = runSimulation(
    DEMO_SCENARIOS.find((s) => s.id === id)!,
    opts.hooks,
    opts.ctl,
  );
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
  return sent;
}
