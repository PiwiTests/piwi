import { describe, test, expect } from 'vitest';
import { buildPerfettoTrace } from '../../shared/perfetto/build';
import type { PerfettoRunInput, TraceEvent } from '../../shared/perfetto/types';

/**
 * A run across two shards, each with one worker, one execution failing: shard 1's on lane 0, shard 2's on lane 1 in
 * the worker process Playwright started there after an earlier failure.
 */
function sampleRun(): PerfettoRunInput {
  const t0 = 1_000_000_000_000;
  return {
    run: {
      id: 42,
      label: 'nightly',
      status: 'failed',
      startTime: t0,
      duration: 5000,
      playwrightVersion: '1.63.0',
      project: { id: 1, name: 'checkout', label: 'Checkout' },
    },
    executions: [
      {
        executionId: 100,
        testCaseId: 10,
        title: 'adds an item to the cart',
        filePath: 'tests/cart.spec.ts',
        location: 'tests/cart.spec.ts:12:3',
        status: 'passed',
        workerIndex: 0,
        parallelIndex: 0,
        shardIndex: 1,
        startedAt: t0,
        duration: 2000,
        retries: 0,
        tags: ['smoke', 'cart'],
        locks: ['database'],
        annotations: [{ type: 'slow', description: 'network heavy' }],
        steps: [
          {
            title: 'Navigate',
            subtitle: 'https://shop.test/cart',
            category: 'navigation',
            startTime: t0 + 10,
            duration: 500,
            location: 'tests/cart.spec.ts:13:5',
            params: { url: 'https://shop.test/cart' },
          },
          {
            title: 'Click',
            subtitle: "getByRole('button', { name: 'Add' })",
            category: 'action',
            startTime: t0 + 520,
            duration: 300,
          },
        ],
      },
      {
        executionId: 101,
        testCaseId: 11,
        title: 'checks out',
        filePath: 'tests/checkout.spec.ts',
        location: 'tests/checkout.spec.ts:20:3',
        status: 'failed',
        workerIndex: 3,
        parallelIndex: 1,
        shardIndex: 2,
        startedAt: t0 + 100,
        duration: 1500,
        retries: 1,
        tags: ['checkout'],
        locks: ['database'],
        error: 'Timed out waiting for selector',
        steps: [
          {
            title: 'Expect',
            subtitle: "getByText('Thank you')",
            category: 'expect',
            startTime: t0 + 200,
            duration: 1200,
            failed: true,
            error: { message: 'Timed out waiting for selector' },
          },
        ],
        attachments: [{ name: 'screenshot', path: 'proj/1/run/42/shot.png', contentType: 'image/png' }],
      },
    ],
    setupSteps: [
      {
        title: 'beforeAll',
        category: 'hook',
        startedAt: t0 - 50,
        duration: 40,
        status: 'passed',
        workerIndex: 0,
        location: 'tests/cart.spec.ts:1:1',
      },
    ],
  };
}

function byName(events: TraceEvent[], name: string): TraceEvent[] {
  return events.filter((e) => e.name === name);
}

describe('buildPerfettoTrace', () => {
  test('produces a Trace Event Format envelope', () => {
    const trace = buildPerfettoTrace(sampleRun(), { scope: 'run', generatedAt: '2026-09-06T00:00:00.000Z' });
    expect(trace.displayTimeUnit).toBe('ms');
    expect(Array.isArray(trace.traceEvents)).toBe(true);
    expect(trace.metadata.source).toBe('piwi');
    expect(trace.metadata['run-id']).toBe(42);
    expect(trace.metadata['playwright-version']).toBe('1.63.0');
    expect(trace.metadata.project).toBe('Checkout');
  });

  test('maps shards to processes and workers to threads named by their lane from 1', () => {
    const { traceEvents } = buildPerfettoTrace(sampleRun(), { scope: 'run' });
    const processNames = byName(traceEvents, 'process_name');
    expect(processNames.map((e) => (e.args as { name: string }).name).sort()).toEqual(['Shard 1', 'Shard 2']);
    // Each shard is its own process id (its 1-based shard index).
    const cart = traceEvents.find((e) => e.name === 'adds an item to the cart')!;
    const checkout = traceEvents.find((e) => e.name === 'checks out')!;
    expect([cart.pid, cart.tid]).toEqual([1, 1]);
    expect([checkout.pid, checkout.tid]).toEqual([2, 2]);
    expect(byName(traceEvents, 'thread_name').map((e) => [e.pid, e.tid, (e.args as { name: string }).name])).toEqual([
      [1, 1, 'Worker 1'],
      [2, 2, 'Worker 2'],
    ]);
    expect(checkout.args).toMatchObject({ worker: 2, workerIndex: 3, shardIndex: 2 });
  });

  test('keeps a worker Playwright started again in its lane on one thread', () => {
    const input: PerfettoRunInput = {
      run: { id: 3, startTime: 0 },
      executions: [
        { executionId: 1, title: 'fails', status: 'failed', workerIndex: 0, parallelIndex: 0, startedAt: 0 },
        { executionId: 2, title: 'passes', status: 'passed', workerIndex: 2, parallelIndex: 0, startedAt: 10 },
        { executionId: 3, title: 'beside', status: 'passed', workerIndex: 1, parallelIndex: 1, startedAt: 0 },
      ],
    };
    const { traceEvents } = buildPerfettoTrace(input, { scope: 'run' });
    expect(['fails', 'passes', 'beside'].map((name) => traceEvents.find((e) => e.name === name)!.tid)).toEqual([
      1, 1, 2,
    ]);
    expect(byName(traceEvents, 'thread_name').map((e) => (e.args as { name: string }).name)).toEqual([
      'Worker 1',
      'Worker 2',
    ]);
  });

  test('names the worker of a result without a lane by its worker process', () => {
    const input: PerfettoRunInput = {
      run: { id: 4, startTime: 0 },
      executions: [{ executionId: 1, title: 'older reporter', status: 'passed', workerIndex: 3, startedAt: 0 }],
    };
    const { traceEvents } = buildPerfettoTrace(input, { scope: 'run' });
    expect(traceEvents.find((e) => e.name === 'older reporter')!.tid).toBe(3);
    expect(byName(traceEvents, 'thread_name').map((e) => (e.args as { name: string }).name)).toEqual(['Worker 3']);
  });

  test('emits a complete slice per execution with rich args', () => {
    const { traceEvents } = buildPerfettoTrace(sampleRun(), { scope: 'run', baseUrl: 'https://piwi.test/' });
    const cart = traceEvents.find((e) => e.name === 'adds an item to the cart')!;
    expect(cart.ph).toBe('X');
    expect(cart.cname).toBe('good');
    expect(cart.dur).toBeGreaterThan(0);
    const args = cart.args as Record<string, unknown>;
    expect(args.status).toBe('passed');
    expect(args.location).toBe('tests/cart.spec.ts:12:3');
    expect(args.tags).toBe('smoke cart');
    expect(args.locks).toEqual(['database']);
    expect(args.annotations).toEqual(['slow: network heavy']);
    expect(args.url).toBe('https://piwi.test/test-run-cases/100');
  });

  test('nests steps under their execution and names them with the subtitle', () => {
    const { traceEvents } = buildPerfettoTrace(sampleRun(), { scope: 'run' });
    const nav = traceEvents.find((e) => e.name.startsWith('Navigate'))!;
    expect(nav.name).toBe('Navigate https://shop.test/cart');
    expect(nav.cat).toBe('navigation');
    expect((nav.args as { params?: unknown }).params).toEqual({ url: 'https://shop.test/cart' });
    // The step sits on its execution's thread and process.
    expect(nav.pid).toBe(1);
    expect(nav.tid).toBe(1);
  });

  test('marks a failing step and emits the moment of failure', () => {
    const { traceEvents } = buildPerfettoTrace(sampleRun(), { scope: 'run' });
    const failingStep = traceEvents.find((e) => e.name.startsWith('Expect'))!;
    expect(failingStep.cname).toBe('bad');
    const instant = traceEvents.find((e) => e.ph === 'i')!;
    expect(instant.name).toBe('failed');
    expect(instant.s).toBe('t');
    expect(instant.pid).toBe(2);
    expect((instant.args as { error: string }).error).toBe('Timed out waiting for selector');
  });

  test('turns attachment paths into download URLs', () => {
    const { traceEvents } = buildPerfettoTrace(sampleRun(), { scope: 'execution', baseUrl: 'https://piwi.test' });
    const checkout = traceEvents.find((e) => e.name === 'checks out')!;
    expect((checkout.args as { attachments: string[] }).attachments).toEqual([
      'https://piwi.test/api/files/proj/1/run/42/shot.png',
    ]);
  });

  test('places suite-level setup steps on the thread of their worker process', () => {
    const { traceEvents } = buildPerfettoTrace(sampleRun(), { scope: 'run' });
    const setup = traceEvents.find((e) => e.name.startsWith('[setup]'))!;
    expect(setup.name).toBe('[setup] beforeAll');
    expect([setup.pid, setup.tid]).toEqual([1, 1]);
    expect(setup.ph).toBe('X');
  });

  test('normalizes timestamps to microseconds from the earliest event', () => {
    const { traceEvents } = buildPerfettoTrace(sampleRun(), { scope: 'run' });
    const nonMeta = traceEvents.filter((e) => e.ph !== 'M');
    // The earliest event (the beforeAll setup step) anchors ts = 0.
    expect(Math.min(...nonMeta.map((e) => e.ts))).toBe(0);
    // ms → µs: the cart execution starts 50 ms after the setup step.
    const cart = traceEvents.find((e) => e.name === 'adds an item to the cart')!;
    expect(cart.ts).toBe(50_000);
  });

  test('falls back to stepEvents when no full step list is stored', () => {
    const input: PerfettoRunInput = {
      run: { id: 1, startTime: 0 },
      executions: [
        {
          executionId: 5,
          title: 'legacy',
          status: 'passed',
          workerIndex: 0,
          shardIndex: null,
          startedAt: 0,
          duration: 100,
          stepEvents: [{ title: 'beforeEach', category: 'hook', startedAt: 10, duration: 20, status: 'passed' }],
        },
      ],
    };
    const { traceEvents } = buildPerfettoTrace(input, { scope: 'run' });
    const process = traceEvents.find((e) => e.name === 'process_name')!;
    expect((process.args as { name: string }).name).toBe('Tests');
    const hook = traceEvents.find((e) => e.name === 'beforeEach')!;
    expect(hook.cat).toBe('hook');
  });

  test('handles a run with no timestamps without throwing', () => {
    const input: PerfettoRunInput = {
      run: { id: 9 },
      executions: [{ executionId: 1, title: 't', status: 'passed', workerIndex: 0, shardIndex: 1 }],
    };
    const trace = buildPerfettoTrace(input, { scope: 'run' });
    expect(trace.traceEvents.some((e) => e.name === 't')).toBe(true);
  });
});
