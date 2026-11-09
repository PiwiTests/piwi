import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { parseTestStop } from '@piwitests/core/wire';
import { streamSimulation } from './demo-simulator-harness';

/**
 * The demo's run from an editor: its PayPal test stands stopped at a breakpoint and goes on, told as the reporter of a
 * run outside CI tells it (`test-stopped`, then `test-resumed` with the time it stood stopped), and then passes.
 */

let simulator: typeof import('~~/app/demo/simulator');

beforeAll(async () => {
  simulator = await import('~~/app/demo/simulator');
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the 'breakpoint' scenario", () => {
  test('tells its test’s stop and its end on the test’s row, from a run outside CI, and the test passes', async () => {
    const scenario = simulator.DEMO_SCENARIOS.find((s) => s.id === 'breakpoint')!;
    expect(scenario.metadata()).toMatchObject({ piwiOrigin: { kind: 'editor' } });
    expect(scenario.metadata()).not.toHaveProperty('ci');

    const run = await streamSimulation(simulator, scenario.id);
    const title = 'should complete checkout with PayPal';
    const ofTest = run.events.filter((e) => e.title === title);
    const types = ofTest.map((e) => e.type).filter((t) => t !== 'step-begin' && t !== 'step-end');
    expect(types).toEqual(['begin', 'test-stopped', 'test-resumed', 'complete']);

    const stopped = ofTest.find((e) => e.type === 'test-stopped')!;
    const stop = parseTestStop(stopped.stop);
    expect(stop).toMatchObject({ reason: 'breakpoint', bar: true, pausedMs: 0 });
    expect(stop!.file).toMatch(/^tests\/.+\.ts$/);
    expect(stop!.line).toBeGreaterThan(0);
    expect(stopped).toMatchObject({ location: ofTest[0]!.location, workerIndex: ofTest[0]!.workerIndex });
    expect(ofTest.find((e) => e.type === 'test-resumed')).toMatchObject({ pausedMs: 5 * 60_000 });
    expect(ofTest.at(-1)).toMatchObject({ type: 'complete', status: 'passed' });
  });
});
