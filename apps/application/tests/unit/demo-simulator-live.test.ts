import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { LiveViewerMessage } from '@piwitests/core/live-view';
import { DEMO_NO_PAGES } from '~~/app/demo/live-calls';
import { streamSimulation } from './demo-simulator-harness';

/**
 * What the demo's simulated workers say to a view of them, as the 'stuck' scenario plays it: the PayPal test's call log
 * waits on the disabled Pay button through its hang, and Inspect has the checkout page at that click; a test that runs
 * no call of the demo's trace says the demo has no page of it.
 */

const said = vi.hoisted(() => [] as Array<{ runId: number; message: LiveViewerMessage }>);
vi.mock('~~/app/demo/run-events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~~/app/demo/run-events')>()),
  publishDemoLiveMessage: (runId: number, message: LiveViewerMessage) => said.push({ runId, message }),
}));

let simulator: typeof import('~~/app/demo/simulator');

beforeAll(async () => {
  simulator = await import('~~/app/demo/simulator');
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  said.length = 0;
});

const TITLE = 'should complete checkout with PayPal';

describe("the 'stuck' scenario's workers", () => {
  test('play the PayPal test’s call log on its Pay click through the hang, and the checkout page at that click', async () => {
    const run = await streamSimulation(simulator, 'stuck');
    const messages = said.map((s) => s.message);
    expect(said.every((s) => s.runId === 1)).toBe(true);

    const ofTest = messages.filter((m) => 'test' in m && m.test === TITLE);
    const logs = ofTest.flatMap((m) => (m.type === 'call-log' ? [m.log] : []));
    const pay = logs.filter((log) => log.call.title === "Click getByRole('button', { name: 'Pay' })");
    // The click logs as it begins, at each tick of the hang, and as the test timeout ends it.
    expect(pay.length).toBeGreaterThan(30);
    const waiting = pay.filter((log) => log.status === 'running').at(-1)!;
    expect(waiting.lines).toEqual(
      expect.arrayContaining([
        "- waiting for getByRole('button', { name: 'Pay' })",
        expect.stringMatching(/^- locator resolved to <button disabled/),
        '- element is not enabled',
      ]),
    );
    expect(waiting.lines.some((line) => / × waiting for element to be visible, enabled and stable$/.test(line))).toBe(
      true,
    );
    expect(waiting.target).toEqual({ count: 1, box: null, enabled: false });
    expect(waiting.ms).toBeGreaterThan(6 * 60_000);
    expect(pay.at(-1)).toMatchObject({ status: 'failed', error: 'locator.click: Test timeout of 30000ms exceeded.' });

    // The steps before it, each in a simple form, the one the test is in last.
    expect(logs.find((log) => log.call.title === 'Navigate /checkout')?.lines).toEqual([
      '- navigating to "https://shop.example.com/checkout", waiting until "load"',
    ]);
    const shown = logs.at(-1)!;
    expect(shown.call.title).toBe("Click getByRole('button', { name: 'Pay' })");

    const pages = ofTest.flatMap((m) => (m.type === 'snapshot' && 'call' in m ? [`${m.phase}@${m.call}`] : []));
    const attempt = /:(\d+)$/.exec(pages[0] ?? '')?.[1];
    expect(pages).toEqual(
      ['after@call@8', 'before@call@10', 'after@call@10', 'before@call@12', 'after@call@12'].map(
        (page) => `${page}:${attempt}`,
      ),
    );
    const ended = messages.find((m) => m.type === 'test-ended' && m.outcome?.test === TITLE);
    expect(ended).toMatchObject({ slot: (ofTest[0] as { slot: number }).slot, outcome: { status: 'failed' } });
    expect(messages.indexOf(ended!)).toBeGreaterThan(messages.indexOf(ofTest.at(-1)!));

    // The live step the row shows while the test hangs is that click.
    const steps = run.events.filter((e) => e.type === 'step-begin' && e.parentTitle === TITLE);
    expect(steps.at(-1)).toMatchObject({ title: 'Click', subtitle: "getByRole('button', { name: 'Pay' })" });

    // Any other test has the one call of it the trace holds: the checkout page once it navigated there. Each attempt
    // names its calls apart, so a view that follows a lane takes each test's pages afresh.
    const others = messages.filter((m) => m.type === 'snapshot' && m.test !== TITLE);
    expect(others.length).toBeGreaterThan(0);
    for (const m of others) expect(m).toMatchObject({ call: expect.stringMatching(/^call@8:\d+$/), phase: 'after' });
    const calls = others.map((m) => (m as { call: string }).call);
    expect(new Set(calls).size).toBe(calls.length);
    for (const m of messages) {
      expect(m).toMatchObject({ shard: null, worker: expect.any(Number) });
      expect((m as { slot?: number }).slot).toBe((m as { worker: number }).worker);
    }
  });
});

describe("the 'breakpoint' scenario's workers", () => {
  test('log no call running while the test stands stopped: the call before the stop ended', async () => {
    await streamSimulation(simulator, 'breakpoint');
    const logs = said.flatMap(({ message }) => (message.type === 'call-log' ? [message.log] : []));
    expect(logs.length).toBeGreaterThan(0);
    // The stop lasts 5 minutes: no call is still running a minute in.
    expect(logs.filter((log) => log.status === 'running' && log.ms > 60_000)).toEqual([]);
  });
});

describe("the 'staging-down' scenario's workers", () => {
  test('say the demo has no page of a test that ran no call, and how it ended', async () => {
    await streamSimulation(simulator, 'staging-down');
    const messages = said.map((s) => s.message);
    const refusals = messages.filter((m) => m.type === 'snapshot');
    expect(refusals.length).toBeGreaterThan(0);
    for (const m of refusals) expect(m).toMatchObject({ refused: DEMO_NO_PAGES });
    expect(messages.filter((m) => m.type === 'call-log')).toEqual([]);
    expect(messages.filter((m) => m.type === 'test-ended').length).toBe(refusals.length);
  });
});
