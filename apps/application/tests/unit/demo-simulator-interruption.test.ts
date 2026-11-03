import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { SimulationController } from '~~/app/demo/simulator';
import { streamSimulation, type StreamedRun } from './demo-simulator-harness';

/**
 * A simulated run cut short sends what the reporter sends for a real one: the tests in flight end `interrupted`, in no
 * outcome, the rest did not run, and a run stopped on its failure budget carries Playwright's error outside any test.
 */

let simulator: typeof import('~~/app/demo/simulator');

// The simulator's module graph is large: loaded before the tests, its import
// never counts against the first test's timeout when the whole suite runs.
beforeAll(async () => {
  simulator = await import('~~/app/demo/simulator');
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Complete {
  title: string;
  status: string;
  error: unknown;
  didNotRunReason?: string;
}

/** Each test's last `complete` event: the result that decides it. */
function finalResults(run: StreamedRun): Complete[] {
  const last = new Map<string, Complete>();
  for (const e of run.events) if (e.type === 'complete') last.set(e.title as string, e as unknown as Complete);
  return [...last.values()];
}

function withStatus(results: Complete[], status: string): Complete[] {
  return results.filter((r) => r.status === status);
}

describe('a simulated run cut short', () => {
  test('ends the tests in flight interrupted, in no outcome, and the rest did not run', async () => {
    const scenario = simulator.DEMO_SCENARIOS.find((s) => s.id === 'interrupted')!;
    const ctl: SimulationController = { stopped: false };
    // Stopped once each worker has begun a test: one test in flight on each.
    let begun = 0;
    const run = await streamSimulation(simulator, scenario.id, {
      ctl,
      onRequest: (url, body) => {
        const events = (body?.testCases ?? []) as Array<{ type: string }>;
        begun += events.filter((e) => e.type === 'begin').length;
        if (begun === scenario.workers) ctl.stopped = true;
      },
    });
    const results = finalResults(run);
    const interrupted = withStatus(results, 'interrupted');
    const didNotRun = withStatus(results, 'didnotrun');

    expect(results).toHaveLength(scenario.tests().length);
    expect(interrupted).toHaveLength(scenario.workers);
    for (const r of interrupted) expect(r.error, r.title).toBeNull();
    expect(didNotRun).toHaveLength(results.length - scenario.workers);
    for (const r of didNotRun) expect(r.didNotRunReason, r.title).toBe('interrupted');
    expect(run.finish).toMatchObject({
      status: 'interrupted',
      totalTests: results.length,
      passedTests: 0,
      failedTests: 0,
      didNotRunTests: didNotRun.length,
    });
    expect(run.finish).not.toHaveProperty('runErrors');
  });

  test("sends Playwright's run error when the run stopped on its failures", async () => {
    const ctl: SimulationController = { stopped: false };
    const run = await streamSimulation(simulator, 'failures', {
      ctl,
      hooks: {
        onProgress: (_completed, failed) => {
          if (failed > 0) ctl.stopped = true;
        },
      },
    });
    const results = finalResults(run);
    const failed = withStatus(results, 'failed').length;

    expect(failed).toBeGreaterThan(0);
    for (const r of withStatus(results, 'didnotrun')) expect(r.didNotRunReason, r.title).toBe('max-failures');
    expect(run.finish).toMatchObject({
      status: 'interrupted',
      passedTests: withStatus(results, 'passed').length,
      failedTests: failed,
      didNotRunTests: withStatus(results, 'didnotrun').length,
      runErrors: [
        {
          message: `\u001b[31mTesting stopped early after ${failed} maximum allowed failures.\u001b[39m`,
          stack: null,
          location: null,
        },
      ],
    });
  });

  test('ends a stuck test interrupted when the run is stopped during its wait', async () => {
    const ctl: SimulationController = { stopped: false };
    const run = await streamSimulation(simulator, 'stuck', {
      ctl,
      onRequest: (url) => {
        if (url.endsWith('/heartbeat')) ctl.stopped = true;
      },
    });
    const stuck = finalResults(run).find((r) => r.title === 'should complete checkout with PayPal');

    expect(stuck).toMatchObject({ status: 'interrupted', error: null });
    expect(run.finish).toMatchObject({ status: 'interrupted' });
  });
});
