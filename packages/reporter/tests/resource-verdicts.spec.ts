import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import type { TestStep } from '@playwright/test/reporter';
import type {
  ResourceBirth,
  ResourceCensus,
  ResourceClose,
  ResourceOpen,
  ResourceTestRef,
} from '../src/internal/capture/resource-ledger.js';
import {
  buildResourceReport,
  fixturesTornDownOf,
  formatHeld,
  formatResourceSummary,
  parseResourceCensus,
  parseResourceResults,
  pileUp,
  tallyLifecycleSteps,
  userFixturesOf,
  type LifecycleTally,
  type ResourceFinding,
} from '../src/internal/collect/resource-verdicts.js';
import type { SourceLines } from '../src/internal/support/source-snippet.js';

const SPEC = 'tests/cart.spec.ts';
const OTHER_SPEC = 'tests/admin.spec.ts';

const test = (id: string, file = SPEC, suite: string[] = []): ResourceTestRef => ({ id, file, suite });

function birth(id: number, kind: ResourceBirth['kind'], extra: Partial<ResourceBirth> = {}): ResourceBirth {
  return { id, kind, parent: null, at: 0, phase: 'test', fixture: null, test: test('t1'), site: `${SPEC}:4`, ...extra };
}

function close(id: number, extra: Partial<ResourceClose> = {}): ResourceClose {
  return { id, at: 0, phase: 'test', test: test('t1'), ...extra };
}

function census(
  at: number,
  ref: ResourceTestRef | null,
  parts: { born?: ResourceBirth[]; closed?: ResourceClose[]; open?: ResourceOpen[]; worker?: number } = {},
  handles?: ResourceCensus['handles'],
): ResourceCensus {
  return {
    v: 1,
    worker: parts.worker ?? 0,
    pid: 1,
    at,
    test: ref ? { ...ref, title: `title of ${ref.id}` } : null,
    born: parts.born ?? [],
    closed: parts.closed ?? [],
    open: parts.open ?? [],
    ...(handles ? { handles } : {}),
  };
}

const leaks = (findings: ResourceFinding[]) => findings.filter((f) => f.verdict === 'leaked');

describe('buildResourceReport', () => {
  it('reports a context a test never closed, with its page, until the worker shut down', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), {
          born: [birth(1, 'context'), birth(2, 'page', { parent: 1, site: `${SPEC}:5` })],
          open: [{ id: 1, pages: 1 }, { id: 2, used: true }],
        }),
        census(4000, test('t2'), { open: [{ id: 1, pages: 1 }, { id: 2, used: true }] }),
        census(5000, null, {
          closed: [close(2, { at: 5000, phase: 'worker', test: null, used: true }), close(1, { at: 5000, phase: 'worker', test: null })],
        }),
      ],
    });
    expect(leaks(report.findings)).toEqual([
      expect.objectContaining({
        kind: 'context',
        where: `${SPEC}:4`,
        scope: 'test',
        tests: 1,
        count: 1,
        pages: 1,
        heldMs: 4000,
        untilWorkerEnd: true,
      }),
    ]);
    expect(report.counts.leaked).toBe(1);
  });

  it('does not judge what a failed test left open, nor the pages it never got to use', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, { ...test('t1'), failed: true }, {
          born: [birth(1, 'context'), birth(2, 'page', { parent: 1 })],
          open: [{ id: 1, pages: 1 }, { id: 2, used: false }],
        }),
        census(1100, null, {
          closed: [close(2, { at: 1100, phase: 'worker', used: false }), close(1, { at: 1100, phase: 'worker' })],
        }),
      ],
    });
    expect(report.findings).toEqual([]);
  });

  it('adds up the page CPU a leaked context used after its test', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), {
          born: [birth(1, 'context'), birth(2, 'page', { parent: 1 })],
          open: [{ id: 1, pages: 1 }, { id: 2, used: true, main: { cpuMs: 40, heapMb: 2, nodes: 10, listeners: 0 } }],
        }),
        census(3000, test('t2'), {
          open: [{ id: 1, pages: 1 }, { id: 2, used: true, main: { cpuMs: 1540, heapMb: 2, nodes: 10, listeners: 0 } }],
        }),
        census(3100, null, { closed: [close(2, { at: 3100, phase: 'worker', test: null }), close(1, { at: 3100, phase: 'worker', test: null })] }),
      ],
    });
    expect(leaks(report.findings)).toEqual([expect.objectContaining({ kind: 'context', pages: 1, afterTestCpuMs: 1500 })]);
    expect(formatResourceSummary(report, 'report')[1]).toContain('· 1.5 s of page CPU after its test');
  });

  it('keeps an object a later test of the same file closed out of the leaks', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), { born: [birth(1, 'context')], open: [{ id: 1, pages: 0 }] }),
        census(2000, test('t2'), { closed: [close(1, { at: 1500, test: test('t2') })] }),
      ],
    });
    expect(leaks(report.findings)).toEqual([]);
  });

  it('keeps an object closed later in its own test, by a fixture tearing down after the census', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), { born: [birth(1, 'context')], open: [{ id: 1, pages: 0 }] }),
        census(2000, test('t2'), { closed: [close(1, { at: 1100, test: test('t1') })] }),
      ],
    });
    expect(leaks(report.findings)).toEqual([]);
  });

  it('reports an object a later test of another file closed', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), { born: [birth(1, 'context')], open: [{ id: 1, pages: 0 }] }),
        census(3000, test('t2', OTHER_SPEC), { closed: [close(1, { at: 2500, test: test('t2', OTHER_SPEC) })] }),
      ],
    });
    expect(leaks(report.findings)).toEqual([
      expect.objectContaining({ kind: 'context', heldMs: 1500, untilWorkerEnd: false }),
    ]);
  });

  it('accepts a beforeAll context its afterAll closed', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1', SPEC, ['block']), {
          born: [birth(1, 'context', { phase: 'beforeAll', test: test('t1', SPEC, ['block']) })],
          open: [{ id: 1, pages: 0 }],
        }),
        census(2000, test('t2', OTHER_SPEC), {
          closed: [close(1, { at: 1200, phase: 'afterAll', test: test('t1', SPEC, ['block']) })],
        }),
      ],
    });
    expect(leaks(report.findings)).toEqual([]);
  });

  it('reports a beforeAll context still open after its block, naming the block', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1', SPEC, ['block']), {
          born: [birth(1, 'context', { phase: 'beforeAll', site: `${SPEC}:8`, test: test('t1', SPEC, ['block']) })],
          open: [{ id: 1, pages: 0 }],
        }),
        census(3000, test('t2', OTHER_SPEC), { open: [{ id: 1, pages: 0 }] }),
      ],
    });
    expect(leaks(report.findings)).toEqual([
      expect.objectContaining({
        scope: 'describe',
        where: `${SPEC}:8`,
        detail: 'beforeAll of "block"',
        heldMs: 2000,
      }),
    ]);
  });

  it('measures a beforeAll leak from the last test of its describe block', () => {
    const block = (id: string) => test(id, SPEC, ['block']);
    const report = buildResourceReport({
      censuses: [
        census(1000, block('t1'), {
          born: [birth(1, 'context', { phase: 'beforeAll', test: block('t1') })],
          open: [{ id: 1, pages: 0 }],
        }),
        census(2000, block('t2'), { open: [{ id: 1, pages: 0 }] }),
        census(3000, test('t3'), { open: [{ id: 1, pages: 0 }] }),
        census(5000, null, { closed: [close(1, { at: 5000, phase: 'worker', test: null })] }),
      ],
    });
    expect(leaks(report.findings)).toEqual([
      expect.objectContaining({ scope: 'describe', heldMs: 3000, untilWorkerEnd: true }),
    ]);
  });

  it('judges a beforeAll object once a test outside its describe block ran', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1', SPEC, ['block']), {
          born: [birth(1, 'context', { phase: 'beforeAll', test: test('t1', SPEC, ['block']) })],
          open: [{ id: 1, pages: 0 }],
        }),
        census(2500, test('t2'), { open: [{ id: 1, pages: 0 }] }),
      ],
    });
    expect(leaks(report.findings)).toEqual([
      expect.objectContaining({ scope: 'describe', heldMs: 1500, untilWorkerEnd: true }),
    ]);
  });

  it('does not judge a beforeAll object when nothing shows its block ended', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1', SPEC, ['block']), {
          born: [birth(1, 'context', { phase: 'beforeAll', test: test('t1', SPEC, ['block']) })],
          open: [{ id: 1, pages: 0 }],
        }),
      ],
    });
    expect(leaks(report.findings)).toEqual([]);
  });

  it('never reports what a worker-scoped fixture holds, nor a context Playwright reuses', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), {
          born: [
            birth(1, 'context', { fixture: { title: 'shared', location: `${SPEC}:2`, worker: true } }),
            birth(2, 'context', { reused: true }),
            birth(3, 'browser', { phase: 'worker', test: null }),
          ],
          open: [{ id: 1, pages: 0 }, { id: 2, pages: 0 }, { id: 3 }],
        }),
        census(2000, null, {}),
      ],
    });
    expect(leaks(report.findings)).toEqual([]);
  });

  it("reports browser.newPage()'s page, not its implicit context, and folds a launched browser's page into it", () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), {
          born: [
            birth(1, 'context', { implicit: true, site: `${SPEC}:4` }),
            birth(2, 'page', { parent: 1, site: `${SPEC}:4` }),
            birth(3, 'browser', { site: `${SPEC}:9` }),
            birth(4, 'context', { parent: 3, implicit: true, site: `${SPEC}:10` }),
            birth(5, 'page', { parent: 4, site: `${SPEC}:10` }),
          ],
          open: [{ id: 1, pages: 1 }, { id: 2, used: true }, { id: 3 }, { id: 4, pages: 1 }, { id: 5, used: true }],
        }),
        census(2000, null, {}),
      ],
    });
    expect(leaks(report.findings).map((f) => [f.kind, f.where, f.pages])).toEqual([
      ['page', `${SPEC}:4`, 0],
      ['browser', `${SPEC}:9`, 1],
    ]);
  });

  it('keeps the objects of different workers apart, though their ids repeat', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), {
          worker: 0,
          born: [birth(1, 'context', { site: `${SPEC}:4` })],
          open: [{ id: 1, pages: 0 }],
        }),
        census(1000, test('t2', OTHER_SPEC), {
          worker: 1,
          born: [
            birth(1, 'context', { site: `${OTHER_SPEC}:3`, test: test('t2', OTHER_SPEC), fixture: { title: 'ctx', location: null, worker: true } }),
            birth(2, 'page', { parent: 1, site: `${OTHER_SPEC}:7`, test: test('t2', OTHER_SPEC), opener: 9, trigger: 'locator.click' }),
          ],
          open: [{ id: 1, pages: 1 }, { id: 2, used: true }],
        }),
        census(2000, null, { worker: 0 }),
        census(2000, null, { worker: 1 }),
      ],
    });
    expect(leaks(report.findings).map((f) => [f.kind, f.where, f.pages ?? 0])).toEqual([
      ['context', `${SPEC}:4`, 0],
      ['page', `popup after locator.click at ${OTHER_SPEC}:7`, 0],
    ]);
  });

  it('groups the same leak across tests and keeps the longest time held', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), { born: [birth(1, 'context')], open: [{ id: 1, pages: 0 }] }),
        census(2000, test('t2'), {
          born: [birth(2, 'context', { test: test('t2') })],
          open: [{ id: 1, pages: 0 }, { id: 2, pages: 0 }],
        }),
        census(9000, null, {}),
      ],
    });
    expect(leaks(report.findings)).toEqual([
      expect.objectContaining({ count: 2, tests: 2, heldMs: 1000, untilWorkerEnd: true }),
    ]);
  });

  it('reports what PIWI_LEAK_CHECK=close closed as a leak closed by Piwi', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), {
          born: [birth(1, 'context')],
          closed: [close(1, { at: 900, byPiwi: true })],
        }),
      ],
    });
    expect(leaks(report.findings)).toEqual([expect.objectContaining({ closedByPiwi: true })]);
  });

  it('groups the pages nothing ran on by what opened them, with the fixtures set up beside them', () => {
    const pageFixture = { title: 'page', location: null, worker: false };
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), {
          born: [birth(1, 'page', { fixture: pageFixture, site: null })],
          closed: [close(1, { used: false })],
        }),
        census(2000, test('t2'), {
          born: [birth(2, 'page', { fixture: pageFixture, site: null, test: test('t2') })],
          closed: [close(2, { used: false, test: test('t2') })],
        }),
        census(3000, test('t3'), {
          born: [birth(3, 'page', { fixture: pageFixture, site: null, test: test('t3') })],
          closed: [close(3, { used: true, test: test('t3') })],
        }),
      ],
      fixturesByTest: new Map([
        ['t1', ['consoleCollector (tests/fixtures.ts:12)']],
        ['t2', ['consoleCollector (tests/fixtures.ts:12)']],
      ]),
    });
    expect(report.findings.filter((f) => f.verdict === 'idle')).toEqual([
      expect.objectContaining({
        where: 'fixture "page"',
        count: 2,
        tests: 2,
        detail: 'set up with consoleCollector (tests/fixtures.ts:12)',
      }),
    ]);
    expect(report.counts.idle).toBe(2);
  });

  it('reports a long-lived context whose pages keep growing, and not one that settles', () => {
    const shared = { title: 'adminPage', location: 'tests/fixtures.ts:30', worker: true };
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), {
          born: [birth(1, 'context', { fixture: shared, site: 'tests/fixtures.ts:31' }), birth(2, 'context', { fixture: shared })],
          open: [{ id: 1, pages: 1 }, { id: 2, pages: 1 }],
        }),
        census(2000, test('t2'), { open: [{ id: 1, pages: 2 }, { id: 2, pages: 2 }] }),
        census(3000, test('t3'), { open: [{ id: 1, pages: 3 }, { id: 2, pages: 1 }] }),
        census(4000, test('t4'), { open: [{ id: 1, pages: 4 }, { id: 2, pages: 2 }] }),
      ],
    });
    expect(report.findings.filter((f) => f.verdict === 'piling')).toEqual([
      expect.objectContaining({
        where: 'fixture "adminPage" at tests/fixtures.ts:31',
        growth: { what: 'pages', from: 1, to: 4, tests: 4 },
      }),
    ]);
  });

  it('reports a server a test left listening, not one its afterAll closed', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), {}, { start: {}, end: { TCPServerWrap: 1 } }),
        census(2000, test('t2'), {}, { start: { TCPServerWrap: 1 }, end: { TCPServerWrap: 2 } }),
        census(3000, test('t3'), {}, { start: { TCPServerWrap: 1 }, end: { TCPServerWrap: 1 } }),
      ],
    });
    expect(report.findings.filter((f) => f.verdict === 'handle')).toEqual([
      expect.objectContaining({ where: 'TCPServerWrap', count: 1, detail: `"title of t1" (${SPEC})` }),
    ]);
  });

  it('reports the servers and child processes a test left running at their lines, leaving servers out of the counts', () => {
    const left = (at: number, ref: ResourceTestRef, running: ResourceCensus['running'], handles?: ResourceCensus['handles']) => ({
      ...census(at, ref, {}, handles),
      running,
    });
    const report = buildResourceReport({
      censuses: [
        left(1000, test('t1'), [{ type: 'TCPServerWrap', site: `${SPEC}:9` }], { start: {}, end: { TCPServerWrap: 1 } }),
        left(2000, test('t2'), [], { start: { TCPServerWrap: 1 }, end: { TCPServerWrap: 1 } }),
        left(3000, test('t3'), [
          { type: 'ChildProcess', site: `${SPEC}:20`, command: 'docker' },
          { type: 'ChildProcess', site: `${SPEC}:20`, command: 'docker' },
        ]),
        { ...left(4000, test('t4'), [{ type: 'TCPServerWrap', site: `${SPEC}:30` }]), test: { ...test('t4'), title: 't4', failed: true } },
      ],
    });
    expect(report.findings.filter((f) => f.verdict === 'handle')).toEqual([
      expect.objectContaining({ where: 'TCPServerWrap', site: `${SPEC}:9`, count: 1, detail: `"title of t1" (${SPEC})` }),
      expect.objectContaining({ where: 'ChildProcess', site: `${SPEC}:20`, count: 2, detail: `"title of t3" (${SPEC})` }),
    ]);
    expect(formatResourceSummary(report, 'report')[2]).toContain(`process     ${SPEC}:20 · 2 processes · left running`);
  });

});

describe('pileUp', () => {
  it('keeps the rule for counts that never go down', () => {
    expect(pileUp([1, 1, 3], 'pages')).toEqual({ from: 1, to: 3 });
    expect(pileUp([1, 2], 'pages')).toBeNull();
    expect(pileUp([4, 5, 5], 'listeners')).toBeNull();
  });

  it('sees through a dip when what is kept keeps growing', () => {
    expect(pileUp([1, 2, 3, 2, 3, 4, 5], 'pages')).toEqual({ from: 1, to: 5 });
  });

  it('leaves a series that wanders, or only rises at its end', () => {
    expect(pileUp([3, 5, 3, 5, 3, 5, 6], 'listeners')).toBeNull();
    // A page that moves between documents of different sizes, as measured on a clean suite.
    expect(pileUp([55, 95, 135, 175, 215, 255, 295, 55, 95, 135, 175, 215, 255, 295, 55, 95], 'elements')).toBeNull();
  });

  it('asks the larger counts for a share of where they started', () => {
    expect(pileUp([1000, 1050, 1100, 1150], 'elements')).toBeNull();
    expect(pileUp([2000, 2100, 2200, 2300], 'elements')).toBeNull();
    expect(pileUp([600, 700, 800, 900], 'elements')).toEqual({ from: 600, to: 900 });
    // The heap after the full collections V8 ran on a worker keeping 30 MB a test.
    expect(pileUp([143, 602, 1852], 'heapMb')).toEqual({ from: 143, to: 1852 });
    expect(pileUp([80, 81, 82], 'heapMb')).toBeNull();
  });
});

describe('the worker process piling up', () => {
  const measured = (at: number, ref: ResourceTestRef, worker: { fds?: number | null; heapAfterGcMb?: number | null }, extra: Partial<ResourceCensus> = {}): ResourceCensus => ({
    ...census(at, ref),
    metrics: {
      worker: {
        cpuMs: 1,
        involuntarySwitches: 0,
        loopUtilization: 0.1,
        loopDelayP99Ms: 1,
        loopDelayMaxMs: 1,
        heapUsedMb: 100,
        heapAfterGcMb: worker.heapAfterGcMb ?? null,
        fds: worker.fds ?? null,
      },
    },
    ...extra,
  });

  it('reports descriptors that keep growing, naming the test that added the most', () => {
    const fds = [27, 30, 33, 36, 46, 49];
    const report = buildResourceReport({
      censuses: fds.map((n, i) => measured(1000 * (i + 1), test(`t${i}`), { fds: n })),
    });
    expect(report.findings).toEqual([
      expect.objectContaining({
        verdict: 'piling',
        kind: 'worker',
        where: 'worker process',
        growth: { what: 'descriptors', from: 27, to: 49, tests: 6 },
        detail: `most of it during "title of t4" (${SPEC})`,
      }),
    ]);
    expect(formatResourceSummary(report, 'report')[1]).toContain('27 → 49 open file descriptors over 6 tests');
  });

  it('leaves out what the tests that left something open added, since each is a finding already', () => {
    const report = buildResourceReport({
      censuses: [27, 35, 43, 51, 59].map((n, i) =>
        measured(1000 * (i + 1), test(`t${i}`), { fds: n }, i > 0 ? { leftOpen: 1 } : {}),
      ),
    });
    expect(report.findings.filter((f) => f.kind === 'worker')).toEqual([]);
  });

  it('reads the heap only after full collections, without naming a test from such sparse readings', () => {
    const heaps = [null, 143, null, null, 602, null, null, 1852, null];
    const report = buildResourceReport({
      censuses: heaps.map((mb, i) => measured(1000 * (i + 1), test(`t${i}`), { heapAfterGcMb: mb })),
    });
    const [finding] = report.findings;
    expect(finding).toMatchObject({ kind: 'worker', growth: { what: 'heapMb', from: 143, to: 1852, tests: 7 } });
    expect(finding).not.toHaveProperty('detail');
  });
});

/**
 * A spec file's lines, and the steps Playwright records for the calls and hooks
 * on them: a call's column at its method (`newPage`), a hook's at `beforeAll`.
 */
function specFile(lines: string[]) {
  const file = path.resolve(SPEC);
  const source: SourceLines = (f) => (f === file ? lines : null);
  const at = (line: number, method: RegExp) => ({ file, line, column: lines[line - 1]!.search(method) + 1 });
  const call = (title: string, line: number): TestStep =>
    ({ title, category: 'pw:api', steps: [], location: at(line, title === 'Create page' ? /newPage/ : /\S/) }) as unknown as TestStep;
  const hook = (title: string, line: number, steps: TestStep[]): TestStep =>
    ({ title, category: 'hook', steps, location: at(line, /(?:before|after)(?:All|Each)/) }) as unknown as TestStep;
  const hooks = (title: 'Before Hooks' | 'After Hooks', steps: TestStep[]): TestStep =>
    ({ title, category: 'hook', steps }) as unknown as TestStep;
  const attempt = (test: string, steps: TestStep[], extra: { worker?: number; failed?: boolean } = {}) =>
    tallyLifecycleSteps({ file: SPEC, test, worker: extra.worker ?? 0, failed: extra.failed ?? false }, steps, source);
  return { source, call, hook, hooks, attempt };
}

const fixtureStep = (title: string, steps: TestStep[]): TestStep =>
  ({ title, category: 'fixture', steps }) as unknown as TestStep;

describe('tallyLifecycleSteps', () => {
  it('lists the calls in order, in their scopes, with the names their lines give and the fixture that made them; never a failed call', () => {
    const { call, hook, hooks, attempt } = specFile([
      'test.beforeAll(async () => {',
      '  shared = await chromium.launch();',
      '});',
      'test.beforeEach(async ({ browser }) => {',
      '  each = await browser.newContext();',
      '});',
      'test.afterAll(async () => {',
      '  await shared.close();',
      '});',
      'test("checks out", async ({ browser }) => {',
      '  const ctx: BrowserContext = await browser.newContext();',
      '  await ctx.close();',
      "  await expect(chromium.launch({ executablePath: '/none' })).rejects.toThrow();",
      '});',
    ]);
    const failed = { ...call('Launch browser', 13), error: { message: 'Executable does not exist' } } as unknown as TestStep;
    const tally = attempt('t1', [
      hooks('Before Hooks', [
        fixtureStep('Fixture "context"', [{ title: 'Create context', category: 'pw:api', steps: [] } as unknown as TestStep]),
        hook('beforeAll hook', 1, [call('Launch browser', 2)]),
        hook('beforeEach hook', 4, [call('Create context', 5)]),
      ]),
      call('Create context', 11),
      call('Close context', 12),
      failed,
      hooks('After Hooks', [fixtureStep('Fixture "context"', [call('Close context', 12)]), hook('afterAll hook', 7, [call('Close browser', 8)])]),
    ]);
    const at = (line: number) => `${SPEC}:${line}`;
    expect(tally).toEqual({
      file: SPEC,
      test: 't1',
      worker: 0,
      failed: false,
      calls: [
        { op: 'open', kind: 'context', site: null, block: false, fixture: true, on: null, name: 'context' },
        { op: 'open', kind: 'browser', site: at(2), block: true, fixture: false, on: 'chromium', name: 'shared' },
        { op: 'open', kind: 'context', site: at(5), block: false, fixture: false, on: 'browser', name: 'each' },
        { op: 'open', kind: 'context', site: at(11), block: false, fixture: false, on: 'browser', name: 'ctx' },
        { op: 'close', kind: 'context', site: at(12), block: false, fixture: false, on: 'ctx', name: null },
        { op: 'close', kind: 'context', site: at(12), block: false, fixture: true, on: 'ctx', name: 'context' },
        { op: 'close', kind: 'browser', site: at(8), block: true, fixture: false, on: 'shared', name: null },
      ],
    });
  });

  it('reads a named hook’s kind, and what each call was made on and assigned to, from the line the step points at', () => {
    const { call, hook, attempt } = specFile([
      'test.beforeAll("open the shop", async ({ browser }) => {',
      '  shop = await browser.newContext();',
      '});',
      'test.beforeEach("sign in", async ({ browser }) => {',
      '  const one = await this.browser?.newPage();',
      '  const two = await browser',
      '    .newPage();',
      '  const three = await browser!.newPage();',
      '  const four = await (await browser.newContext()).newPage();',
      '  holder.ctx = await browser.newContext();',
      '  await holder.ctx!.close();',
      '});',
    ]);
    const tally = attempt('t1', [
      hook('open the shop', 1, [call('Create context', 2)]),
      hook('sign in', 4, [call('Create page', 5), call('Create page', 7), call('Create page', 8), call('Create page', 9), call('Create context', 10), call('Close context', 11)]),
    ]);
    expect(tally.calls.map(({ op, kind, block, on, name }) => ({ op, kind, block, on, name }))).toEqual([
      { op: 'open', kind: 'context', block: true, on: 'browser', name: 'shop' },
      { op: 'open', kind: 'page', block: false, on: 'browser', name: 'one' },
      { op: 'open', kind: 'page', block: false, on: 'browser', name: 'two' },
      { op: 'open', kind: 'page', block: false, on: 'browser', name: 'three' },
      { op: 'open', kind: 'page', block: false, on: null, name: null },
      { op: 'open', kind: 'context', block: false, on: 'browser', name: 'ctx' },
      { op: 'close', kind: 'context', block: false, on: 'ctx', name: null },
    ]);
  });

  it('knows no names when the line cannot be read, or holds no call of the method at the step’s column', () => {
    const page = (file: string, column: number) =>
      ({ title: 'Create page', category: 'pw:api', steps: [], location: { file, line: 1, column } }) as unknown as TestStep;
    // A page-object library outside the suite: the step points at the suite's call into it.
    const source: SourceLines = (file) => (file === path.resolve(SPEC) ? ['const page = await browserSession.open();'] : null);
    const attempt = { file: SPEC, test: 't1', worker: 0, failed: false };
    for (const step of [page(path.resolve(OTHER_SPEC), 1), page(path.resolve(SPEC), 34)]) {
      expect(tallyLifecycleSteps(attempt, [step], source).calls).toEqual([
        { op: 'open', kind: 'page', site: expect.any(String), block: false, fixture: false, on: null, name: null },
      ]);
      expect(buildResourceReport({ censuses: [], tallies: [tallyLifecycleSteps(attempt, [step], source)] }).findings).toEqual([]);
    }
  });
});

describe('probable leaks', () => {
  const probable = (tallies: LifecycleTally[]) => buildResourceReport({ censuses: [], tallies }).findings;

  it('names only the line left open, so a closed one of its kind changes nothing', () => {
    const { call, attempt } = specFile([
      'test("forgets its browser", async () => {',
      '  await chromium.launch();',
      '});',
      'test("closes its browser, and what it opened in it", async () => {',
      '  const browser = await chromium.launch();',
      '  await browser.newContext();',
      '  await browser.newPage();',
      '  await browser.close();',
      '});',
      'test("closes its context", async ({ browser }) => {',
      '  const ctx = await browser.newContext();',
      '  await ctx.close();',
      '});',
    ]);
    const forgets = attempt('t1', [call('Launch browser', 2)]);
    const closesBrowser = attempt('t2', [5, 6, 7, 8].map((line, i) => call(['Launch browser', 'Create context', 'Create page', 'Close browser'][i]!, line)));
    const closesContext = attempt('t3', [call('Create context', 11), call('Close context', 12)]);
    const findings = probable([forgets, closesBrowser, closesContext]);
    expect(findings).toEqual([
      { verdict: 'probable', kind: 'browser', where: `${SPEC}:2`, site: `${SPEC}:2`, tests: 1, count: 1, detail: 'left open by its test' },
    ]);
    expect(probable([forgets])).toEqual(findings);
    const report = buildResourceReport({ censuses: [], tallies: [forgets, closesBrowser, closesContext] });
    expect(formatResourceSummary(report, 'report')).toEqual([
      'Resources: 1 probable leak',
      `  probable  browser     ${SPEC}:2 · left open by its test`,
      'Probable leaks are read from the steps and the lines they point at, without API request contexts (their dispose() leaves no step); the capture fixtures (extendPiwiFixtures) make them exact.',
    ]);
  });

  it('counts a page `browser.newPage()` opened, and its close against it, never against a leaked context', () => {
    const { call, attempt } = specFile([
      'test("leaks a context", async ({ browser }) => {',
      '  await browser.newContext();',
      '});',
      'test("closes its page", async ({ browser }) => {',
      '  const page = await browser.newPage();',
      '  await page.close();',
      '});',
      'test("leaks a page", async ({ browser }) => {',
      '  await browser.newPage();',
      '});',
      'test("opens a page in its context", async ({ context }) => {',
      '  const page = await context.newPage();',
      '  await page.close();',
      '});',
    ]);
    expect(
      probable([
        attempt('t1', [call('Create context', 2)]),
        attempt('t2', [call('Create page', 5), call('Close context', 6)]),
        attempt('t3', [call('Create page', 9)]),
        attempt('t4', [call('Create page', 12), call('Close page', 13)]),
      ]),
    ).toEqual([
      expect.objectContaining({ kind: 'context', where: `${SPEC}:2`, count: 1 }),
      expect.objectContaining({ kind: 'page', where: `${SPEC}:9`, count: 1, detail: 'left open by its test' }),
    ]);
  });

  it('pairs a describe block’s beforeAll with its afterAll, and an object a test handed on with a later close', () => {
    const { call, hook, hooks, attempt } = specFile([
      'test.beforeAll(async ({ browser }) => {',
      '  shared = await browser.newContext();',
      '});',
      'test.afterAll("tidy up", async () => {',
      '  await shared.close();',
      '  await page.close();',
      '});',
      'test("opens a page for the next test", async ({ browser }) => {',
      '  page = await browser.newPage();',
      '});',
      'test("uses it", async () => {});',
    ]);
    const first = attempt('t1', [hooks('Before Hooks', [hook('beforeAll hook', 1, [call('Create context', 2)])]), call('Create page', 9)]);
    const last = attempt('t2', [hooks('After Hooks', [hook('tidy up', 4, [call('Close context', 5), call('Close context', 6)])])]);
    expect(probable([first, last])).toEqual([]);
    // One close, of `shared`: the page the test handed on is the one left.
    const oneClose = attempt('t2', [hooks('After Hooks', [hook('tidy up', 4, [call('Close context', 5)])])]);
    expect(probable([first, oneClose])).toEqual([
      expect.objectContaining({ kind: 'page', where: `${SPEC}:9`, detail: 'left open by its test' }),
    ]);
    expect(probable([first])).toEqual([
      expect.objectContaining({ kind: 'context', where: `${SPEC}:2`, detail: 'left open by a beforeAll or afterAll hook' }),
      expect.objectContaining({ kind: 'page', where: `${SPEC}:9` }),
    ]);
  });

  it('closes, with a browser, what was opened on it, never what was opened on another', () => {
    const { call, hook, hooks, attempt } = specFile([
      'test.beforeAll(async () => {',
      '  dedicated = await chromium.launch();',
      '});',
      'test.afterAll(async () => {',
      '  await dedicated.close();',
      '});',
      'test("on the dedicated browser", async () => {',
      '  await dedicated.newContext();',
      '});',
      'test("on the fixture’s", async ({ browser }) => {',
      '  await browser.newContext();',
      '  const other = await chromium.launch();',
      '  await browser.newPage();',
      '  await other.newContext();',
      '  await other.close();',
      '});',
    ]);
    const first = attempt('t1', [hooks('Before Hooks', [hook('beforeAll hook', 1, [call('Launch browser', 2)])]), call('Create context', 8)]);
    const second = attempt('t2', [
      call('Create context', 11),
      call('Launch browser', 12),
      call('Create page', 13),
      call('Create context', 14),
      call('Close browser', 15),
      hooks('After Hooks', [hook('afterAll hook', 4, [call('Close browser', 5)])]),
    ]);
    expect(probable([first, second]).map(({ kind, where }) => [kind, where])).toEqual([
      ['context', `${SPEC}:11`],
      ['page', `${SPEC}:13`],
    ]);
  });

  it('pairs a close with the open of its name, so the line named is the one left open', () => {
    const { call, attempt } = specFile([
      'test("closes the first context", async ({ browser }) => {',
      '  const a = await browser.newContext();',
      '  const b = await browser.newContext();',
      '  await a.close();',
      '});',
      'test("closes its page, not its context", async ({ browser }) => {',
      '  const page = await browser.newPage();',
      '  const ctx = await browser.newContext();',
      '  await page.close();',
      '});',
    ]);
    expect(
      probable([
        attempt('t1', [call('Create context', 2), call('Create context', 3), call('Close context', 4)]),
        attempt('t2', [call('Create page', 7), call('Create context', 8), call('Close context', 9)]),
      ]).map(({ kind, where }) => [kind, where]),
    ).toEqual([
      ['context', `${SPEC}:3`],
      ['context', `${SPEC}:8`],
    ]);
  });

  it('never lets a close of something it did not see opened take an earlier test’s leak', () => {
    const { call, hook, hooks, attempt } = specFile([
      'test("leaks a browser", async () => {',
      '  await chromium.launch();',
      '});',
      'test("closes its browser twice", async () => {',
      '  const b = await chromium.launch();',
      '  await b.close();',
      '  await b.close();',
      '});',
      'test.afterEach(async ({ context }) => {',
      '  await context.close();',
      '});',
      'test("leaks a context", async ({ browser }) => {',
      '  await browser.newContext();',
      '});',
      'const openTab = (b) => b.newPage();',
      'test("closes a tab", async ({ browser }) => {',
      '  (await openTab(browser)).close();',
      '});',
    ]);
    const fixtureContext = fixtureStep('Fixture "context"', [{ title: 'Create context', category: 'pw:api', steps: [] } as unknown as TestStep]);
    expect(
      probable([
        attempt('t1', [call('Launch browser', 2)]),
        // Playwright records a repeated close as a failed step.
        attempt('t2', [call('Launch browser', 5), call('Close browser', 6), { ...call('Close browser', 7), error: { message: 'Target page, context or browser has been closed' } } as unknown as TestStep]),
        attempt('t3', [
          hooks('Before Hooks', [fixtureContext]),
          call('Create context', 13),
          hooks('After Hooks', [hook('afterEach hook', 9, [call('Close context', 10)])]),
        ]),
        attempt('t4', [call('Create page', 15), call('Close context', 17)]),
      ]).map(({ kind, where }) => [kind, where]),
    ).toEqual([
      ['browser', `${SPEC}:2`],
      ['context', `${SPEC}:13`],
    ]);
  });

  it('reads a page of a persistent context named `browser` as the context’s', () => {
    const { call, attempt } = specFile([
      'test("a profile", async ({}, testInfo) => {',
      "  const browser = await chromium.launchPersistentContext(testInfo.outputPath('profile'));",
      '  const page = await browser.newPage();',
      '  await page.close();',
      '  await browser.close();',
      '});',
    ]);
    const steps = [call('Launch persistent context', 2), call('Create page', 3), call('Close page', 4), call('Close context', 5)];
    expect(probable([attempt('t1', steps)])).toEqual([]);
    expect(probable([attempt('t1', steps.slice(0, 3))])).toEqual([expect.objectContaining({ kind: 'context', where: `${SPEC}:2` })]);
  });

  it('lets no fixture’s object take a close of the name it shares, and closes it by the end of its attempt', () => {
    const { call, hook, hooks, attempt } = specFile([
      'test.beforeAll(async ({ browser }) => {',
      '  context = await browser.newContext();',
      '});',
      'test.afterAll(async () => {',
      '  await context.close();',
      '});',
      'test.beforeEach(async ({ browser }) => {',
      '  each = await browser.newContext();',
      '});',
      'test.afterEach(async () => {',
      '  await each.close();',
      '});',
      'test("admin sees the user", async ({ page }) => {',
      '  const admin = await context.newPage();',
      '});',
    ]);
    const unlocated = (title: string) => ({ title, category: 'pw:api', steps: [] }) as unknown as TestStep;
    const pageFixtures = [fixtureStep('Fixture "context"', [unlocated('Create context')]), fixtureStep('Fixture "page"', [unlocated('Create page')])];
    const test = (id: string, first: boolean, last: boolean) =>
      attempt(id, [
        hooks('Before Hooks', [
          ...(first ? [hook('beforeAll hook', 1, [call('Create context', 2)])] : []),
          hook('beforeEach hook', 7, [call('Create context', 8)]),
          ...pageFixtures,
        ]),
        call('Create page', 14),
        hooks('After Hooks', [
          hook('afterEach hook', 10, [call('Close context', 11)]),
          fixtureStep('Fixture "context"', [unlocated('Close context')]),
          ...(last ? [hook('afterAll hook', 4, [call('Close context', 5)])] : []),
        ]),
      ]);
    expect(probable([test('t1', true, false), test('t2', false, true)])).toEqual([]);
  });

  it('pairs a close with what its own test opened through a helper, and a fixture’s close with what the test opened through it', () => {
    const { call, hooks, attempt } = specFile([
      'test("leaks a context", async ({ browser }) => {',
      '  const context = await browser.newContext();',
      '});',
      'const french = (browser) => browser.newContext({ locale: "fr-FR" });',
      'test("closes its French context", async ({ browser }) => {',
      '  const context = await french(browser);',
      '  await context.close();',
      '});',
      'test("opens two through a factory fixture", async ({ newContext }) => {',
      '  await newContext("de-DE");',
      '});',
      'export const factory = { newContext: async ({ browser }, use) => { await use((locale) => browser.newContext({ locale })); } };',
    ]);
    expect(
      probable([
        attempt('t1', [call('Create context', 2)]),
        attempt('t2', [call('Create context', 4), call('Close context', 7)]),
        attempt('t3', [call('Create context', 12), call('Create context', 12), hooks('After Hooks', [fixtureStep('Fixture "newContext"', [call('Close context', 12), call('Close context', 12)])])]),
      ]).map(({ kind, where }) => [kind, where]),
    ).toEqual([['context', `${SPEC}:2`]]);
  });

  it('closes a context’s pages with it, so a later close of that name reaches the page its own test opened', () => {
    const { call, attempt } = specFile([
      'test("french locale", async ({ browser }) => {',
      '  const context = await frenchContext(browser);',
      '  const page = await context.newPage();',
      '  await context.close();',
      '});',
      'export async function openPage(browser) {',
      '  const p = await browser.newPage();',
      '  return p;',
      '}',
      'test("small viewport", async ({ browser }) => {',
      '  const page = await openPage(browser);',
      '  await page.close();',
      '});',
    ]);
    expect(
      probable([
        attempt('t1', [call('Create context', 2), call('Create page', 3), call('Close context', 4)]),
        attempt('t2', [call('Create page', 7), call('Close context', 12)]),
      ]),
    ).toEqual([]);
  });

  it('reads each of the calls under one `await`, and a browser handed on to a later test', () => {
    const { call, attempt } = specFile([
      'test("closes two of three", async ({ browser }) => {',
      '  const admin = await browser.newContext();',
      '  const user = await browser.newContext();',
      '  const guest = await browser.newContext();',
      '  await Promise.all([admin.close(), user.close()]);',
      '});',
      'test("launches", async () => {',
      '  browser = await chromium.launch();',
      '});',
      'test("uses it and closes it", async () => {',
      '  await browser.newPage();',
      '  await browser.close();',
      '});',
    ]);
    expect(
      probable([
        attempt('t1', [call('Create context', 2), call('Create context', 3), call('Create context', 4), call('Close context', 5), call('Close context', 5)]),
        attempt('t2', [call('Launch browser', 8)]),
        attempt('t3', [call('Create page', 11), call('Close browser', 12)]),
      ]).map(({ kind, where }) => [kind, where]),
    ).toEqual([['context', `${SPEC}:4`]]);
  });

  it('keeps each worker’s attempts apart, groups a line left open by several tests, and judges no failed attempt', () => {
    const { call, hook, hooks, attempt } = specFile([
      'test.beforeAll(async ({ browser }) => {',
      '  shared = await browser.newContext();',
      '});',
      'test.afterAll(async () => {',
      '  await shared.close();',
      '});',
      'export const open = (browser) => browser.newContext();',
    ]);
    const leaks = (test: string, worker: number, failed = false) => attempt(test, [call('Create context', 7)], { worker, failed });
    expect(
      probable([
        attempt('t1', [hooks('Before Hooks', [hook('beforeAll hook', 1, [call('Create context', 2)])]), call('Create context', 7)]),
        // An afterAll in another worker closes nothing worker 0 opened.
        attempt('t2', [hooks('After Hooks', [hook('afterAll hook', 4, [call('Close context', 5)])])], { worker: 1 }),
        leaks('t3', 1),
        leaks('t4', 1, true),
        leaks('t5', 0),
      ]),
    ).toEqual([
      expect.objectContaining({ kind: 'context', where: `${SPEC}:7`, count: 3, tests: 3, detail: '3 contexts left open by 3 tests' }),
      expect.objectContaining({ kind: 'context', where: `${SPEC}:2`, count: 1, tests: 1, detail: 'left open by a beforeAll or afterAll hook' }),
    ]);
  });
});

describe('userFixturesOf', () => {
  it('lists the fixtures a test set up from its own files, not Playwright’s or Piwi’s', () => {
    const fixture = (title: string, file?: string) =>
      ({ title, category: 'fixture', steps: [], location: file ? { file: path.resolve(file), line: 12, column: 1 } : undefined }) as unknown as TestStep;
    expect(
      userFixturesOf([
        fixture('Fixture "page"'),
        fixture('Fixture "consoleCollector"', 'tests/fixtures.ts'),
        fixture('fixture: auth', 'tests/auth.ts'),
        fixture('Fixture "piwiCapture"', 'dist/index.js'),
      ]),
    ).toEqual(['consoleCollector (tests/fixtures.ts:12)', 'auth (tests/auth.ts:12)']);
  });
});

describe('fixturesTornDownOf', () => {
  it('lists the fixtures the test’s After Hooks tore down, not a worker cleanup’s', () => {
    const step = (title: string, category: string, steps: TestStep[] = [], file?: string) =>
      ({ title, category, steps, location: file ? { file: path.resolve(file), line: 2, column: 1 } : undefined }) as unknown as TestStep;
    expect(
      fixturesTornDownOf([
        step('Before Hooks', 'hook', [step('Fixture "slowCtx"', 'fixture', [], SPEC)]),
        step('After Hooks', 'hook', [
          step('Fixture "slowCtx"', 'fixture', [], SPEC),
          step('Fixture "context"', 'fixture'),
          step('afterEach hook', 'hook', [step('Fixture "helper"', 'fixture', [], SPEC)]),
        ]),
        step('Worker Cleanup', 'hook', [step('Fixture "workerCtx"', 'fixture', [], SPEC)]),
      ]),
    ).toEqual([`slowCtx|${SPEC}:2`]);
  });
});

describe('parsing', () => {
  it('reads a census and rejects what is not one', () => {
    const valid = census(1, test('t1'));
    expect(parseResourceCensus(Buffer.from(JSON.stringify(valid)))).toEqual(valid);
    expect(parseResourceCensus(Buffer.from('{"v":2,"born":[],"closed":[],"open":[],"worker":0,"at":1}'))).toBeNull();
    expect(parseResourceCensus(Buffer.from('not json'))).toBeNull();
    expect(parseResourceCensus(undefined)).toBeNull();
  });

  it('reads the shutdown file line by line, skipping what does not parse', () => {
    const line = JSON.stringify(census(5, null));
    expect(parseResourceResults(`${line}\n{broken\n\n${line}\n`)).toHaveLength(2);
  });
});

describe('formatResourceSummary', () => {
  const leak: ResourceFinding = {
    verdict: 'leaked',
    kind: 'context',
    where: `${SPEC}:4`,
    scope: 'test',
    tests: 2,
    count: 2,
    heldMs: 4800,
    untilWorkerEnd: true,
    pages: 1,
  };

  it('says nothing when nothing was found', () => {
    expect(formatResourceSummary({ findings: [], counts: { leaked: 0, lingering: 0, idle: 0, piling: 0, handle: 0, probable: 0 }, spans: [] }, 'report')).toEqual([]);
  });

  it('heads with the counts, lists each finding, and hints at the strict modes', () => {
    const lines = formatResourceSummary(
      { findings: [leak], counts: { leaked: 1, lingering: 0, idle: 0, piling: 0, handle: 0, probable: 0 }, spans: [] },
      'report',
    );
    expect(lines[0]).toBe('Resources: 1 leak');
    expect(lines[1]).toBe(
      `  leaked    context     ${SPEC}:4 · 2 contexts · with 1 page · 2 tests · open until the worker shut down (4.8 s past its test)`,
    );
    expect(lines[2]).toMatch(/PIWI_LEAK_CHECK=fail/);
    expect(formatResourceSummary({ findings: [leak], counts: { leaked: 1, lingering: 0, idle: 0, piling: 0, handle: 0, probable: 0 }, spans: [] }, 'fail')).toHaveLength(2);
  });

  it('lists at most the given number of findings and counts the rest', () => {
    const findings = Array.from({ length: 13 }, () => leak);
    const lines = formatResourceSummary({ findings, counts: { leaked: 13, lingering: 0, idle: 0, piling: 0, handle: 0, probable: 0 }, spans: [] }, 'fail', 10);
    expect(lines).toHaveLength(12);
    expect(lines[11]).toBe('  … and 3 more findings');
  });

  it('formats how long an object was held', () => {
    expect(formatHeld(850)).toBe('850 ms');
    expect(formatHeld(5600)).toBe('5.6 s');
    expect(formatHeld(123_000)).toBe('2 min 3 s');
    expect(formatHeld(120_000)).toBe('2 min');
  });
});

describe('fixture scope, implicit browsers and folded pages', () => {
  const timed = { title: 'slowCtx', location: `${SPEC}:2`, worker: true, timed: true };

  /** Two tests, each with its own context from the timed fixture, closed as the worker shuts down unless `closed` says. */
  function twoTests(closed: Partial<ResourceClose> = {}) {
    return buildResourceReport({
      censuses: [
        census(1000, test('t1'), {
          born: [birth(1, 'context', { fixture: timed, site: `${SPEC}:3` })],
          open: [{ id: 1, pages: 0, lastUse: { at: 800, site: `${SPEC}:9`, test: 't1' } }],
        }),
        census(2000, test('t2'), {
          born: [birth(2, 'context', { fixture: timed, site: `${SPEC}:3`, test: test('t2') })],
          open: [
            { id: 1, pages: 0, lastUse: { at: 800, site: `${SPEC}:9`, test: 't1' } },
            { id: 2, pages: 0, lastUse: { at: 1800, site: `${SPEC}:9`, test: 't2' } },
          ],
        }),
        census(3000, null, {
          closed: [1, 2].map((id) =>
            close(id, { at: 3000, phase: 'worker', test: null, fixture: { title: 'browser', location: null }, ...closed }),
          ),
        }),
      ],
    });
  }

  it('reports what a test fixture with a timeout of its own, used by two tests, never closes', () => {
    expect(leaks(twoTests().findings)).toEqual([
      expect.objectContaining({
        kind: 'context',
        where: `fixture "slowCtx" at ${SPEC}:3`,
        count: 2,
        tests: 2,
        lastUse: `${SPEC}:9`,
      }),
    ]);
  });

  it("leaves a timed fixture's object alone when it opened in one test only, or its own teardown closed it", () => {
    const once = buildResourceReport({
      censuses: [
        census(1000, test('t1'), { born: [birth(1, 'context', { fixture: timed })], open: [{ id: 1, pages: 0 }] }),
        census(3000, null, { closed: [close(1, { at: 3000, phase: 'worker', test: null })] }),
      ],
    });
    expect(leaks(once.findings)).toEqual([]);
    expect(leaks(twoTests({ fixture: { title: 'slowCtx', location: `${SPEC}:2` } }).findings)).toEqual([]);
  });

  it('reports what a timed fixture of one test never closes, once its test tore it down', () => {
    const oneTest = (testFixtures: Map<string, string[]>) =>
      buildResourceReport({
        censuses: [
          census(1000, test('t1'), {
            born: [birth(1, 'context', { fixture: timed, site: `${SPEC}:3` }), birth(2, 'page', { parent: 1, site: `${SPEC}:9` })],
            open: [{ id: 1, pages: 1 }, { id: 2, used: true }],
          }),
          census(3000, null, { closed: [1, 2].map((id) => close(id, { at: 3000, phase: 'worker', test: null })) }),
        ],
        testFixtures,
      });
    expect(leaks(oneTest(new Map([['t1', [`slowCtx|${SPEC}:2`]]])).findings)).toEqual([
      expect.objectContaining({ kind: 'context', where: `fixture "slowCtx" at ${SPEC}:3`, count: 1, pages: 1 }),
    ]);
    // Without the teardown step, the fixture reads as worker-scoped: its context is held, its page is the test's.
    expect(leaks(oneTest(new Map([['t1', [`otherCtx|${SPEC}:2`]]])).findings).map((f) => f.kind)).toEqual(['page']);
  });

  it('folds the browser launchPersistentContext opened into its context, with the page', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), {
          born: [
            birth(1, 'browser', { implicit: true }),
            birth(2, 'context', { parent: 1 }),
            birth(3, 'page', { parent: 2 }),
          ],
          open: [{ id: 1 }, { id: 2, pages: 1 }, { id: 3, used: true }],
        }),
        census(2000, null),
      ],
    });
    expect(leaks(report.findings)).toEqual([expect.objectContaining({ kind: 'context', count: 1, pages: 1 })]);
  });

  it('counts the pages of a context in a leaked browser', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), {
          born: [birth(1, 'browser'), birth(2, 'context', { parent: 1 }), birth(3, 'page', { parent: 2 })],
          open: [{ id: 1 }, { id: 2, pages: 1 }, { id: 3, used: true }],
        }),
        census(2000, null),
      ],
    });
    expect(leaks(report.findings)).toEqual([expect.objectContaining({ kind: 'browser', count: 1, pages: 1 })]);
  });

  it('names the line most of a group last used, and spans each leak to its worker’s end', () => {
    const report = buildResourceReport({
      censuses: [
        census(1000, test('t1'), {
          born: [birth(1, 'context'), birth(2, 'page', { parent: 1 })],
          open: [
            { id: 1, pages: 1, lastUse: { at: 900, site: `${SPEC}:6`, test: 't1' } },
            { id: 2, used: true, lastUse: { at: 900, site: `${SPEC}:6`, test: 't1' } },
          ],
        }),
        census(5000, null, {
          closed: [close(2, { at: 5000, phase: 'worker', test: null }), close(1, { at: 5000, phase: 'worker', test: null })],
        }),
      ],
    });
    expect(leaks(report.findings)[0]!.lastUse).toBe(`${SPEC}:6`);
    expect(report.spans).toEqual([
      {
        worker: 0,
        verdict: 'leaked',
        kind: 'context',
        where: `${SPEC}:4`,
        site: `${SPEC}:4`,
        lastUse: `${SPEC}:6`,
        from: 1000,
        to: 5000,
        untilWorkerEnd: true,
        scope: 'test',
        pages: 1,
        test: { title: 'title of t1', file: SPEC },
      },
    ]);
  });
});

describe('lingering', () => {
  const popup = (extra: Partial<ResourceBirth> = {}) =>
    birth(2, 'page', { parent: 1, at: 500, opener: 9, trigger: 'locator.click', site: `${SPEC}:6`, ...extra });
  const lingeringOf = (findings: ResourceFinding[]) => findings.filter((f) => f.verdict === 'lingering');

  it('reports a page the test closed long after its last use, with that line and its span', () => {
    const report = buildResourceReport({
      censuses: [
        {
          ...census(6000, test('t1'), {
            born: [popup()],
            closed: [close(2, { at: 5800, used: true, lastUse: { at: 1000, site: `${SPEC}:7`, test: 't1' } })],
          }),
          startedAt: 0,
        },
      ],
    });
    expect(lingeringOf(report.findings)).toEqual([
      expect.objectContaining({
        verdict: 'lingering',
        kind: 'page',
        where: `popup after locator.click at ${SPEC}:6`,
        heldMs: 4800,
        lastUse: `${SPEC}:7`,
        tests: 1,
      }),
    ]);
    expect(report.counts.lingering).toBe(1);
    expect(report.spans).toEqual([expect.objectContaining({ verdict: 'lingering', from: 1000, to: 5800, pages: 1 })]);
    expect(formatResourceSummary(report, 'report')[1]).toBe(
      `  lingering page        popup after locator.click at ${SPEC}:6 · 1 test · open 4.8 s after its last use · last used at ${SPEC}:7`,
    );
  });

  it('leaves a short tail, a tail short for its test, and what a fixture opened alone', () => {
    const tail = (lastUseAt: number, closeAt: number, extra: Partial<ResourceBirth> = {}) =>
      buildResourceReport({
        censuses: [
          {
            ...census(30_000, test('t1'), {
              born: [popup(extra)],
              closed: [close(2, { at: closeAt, used: true, lastUse: { at: lastUseAt, site: `${SPEC}:7`, test: 't1' } })],
            }),
            startedAt: 0,
          },
        ],
      });
    expect(lingeringOf(tail(1000, 2500).findings)).toEqual([]);
    expect(lingeringOf(tail(1000, 6000).findings)).toEqual([]);
    expect(lingeringOf(tail(1000, 20_000).findings)).toHaveLength(1);
    expect(lingeringOf(tail(1000, 20_000, { fixture: { title: 'page', location: null, worker: false } }).findings)).toEqual([]);
  });

  it('ends the tail where the close began, and leaves what a hook opened alone', () => {
    const report = (closeExtra: Partial<ResourceClose>, birthExtra: Partial<ResourceBirth> = {}) =>
      buildResourceReport({
        censuses: [
          {
            ...census(6000, test('t1'), {
              born: [popup(birthExtra)],
              closed: [
                close(2, { at: 5800, used: true, lastUse: { at: 1000, site: `${SPEC}:7`, test: 't1' }, ...closeExtra }),
              ],
            }),
            startedAt: 0,
          },
        ],
      });
    // Piwi's reads and the trace's export ran from 1.5 s to the close at 5.8 s: the test closed it right after its use.
    expect(lingeringOf(report({ closingAt: 1500 }).findings)).toEqual([]);
    expect(lingeringOf(report({ closingAt: 4000 }).findings)).toEqual([
      expect.objectContaining({ heldMs: 3000 }),
    ]);
    expect(report({ closingAt: 4000 }).spans).toEqual([expect.objectContaining({ from: 1000, to: 4000 })]);
    expect(lingeringOf(report({}, { phase: 'beforeEach' }).findings)).toEqual([]);
  });

  it('folds a page that lingered into the context that lingered with it', () => {
    const use = { at: 1000, site: `${SPEC}:7`, test: 't1' };
    const report = buildResourceReport({
      censuses: [
        {
          ...census(6000, test('t1'), {
            born: [birth(1, 'context', { at: 200 }), birth(2, 'page', { parent: 1, at: 300 })],
            closed: [
              close(2, { at: 5900, used: true, lastUse: use }),
              close(1, { at: 5900, lastUse: use }),
            ],
          }),
          startedAt: 0,
        },
      ],
    });
    expect(lingeringOf(report.findings)).toEqual([expect.objectContaining({ kind: 'context', count: 1, pages: 1 })]);
  });

  it('folds a context and its page into the browser the test launched, and leaves an API context alone', () => {
    const use = { at: 1000, site: `${SPEC}:7`, test: 't1' };
    const report = buildResourceReport({
      censuses: [
        {
          ...census(6000, test('t1'), {
            born: [
              birth(1, 'browser', { at: 100 }),
              birth(2, 'context', { parent: 1, at: 200 }),
              birth(3, 'page', { parent: 2, at: 300 }),
              birth(4, 'request', { at: 300 }),
            ],
            closed: [
              close(3, { at: 5900, used: true, lastUse: use }),
              close(2, { at: 5900, lastUse: use }),
              close(1, { at: 5900, lastUse: use }),
              close(4, { at: 5900, lastUse: use }),
            ],
          }),
          startedAt: 0,
        },
      ],
    });
    expect(lingeringOf(report.findings)).toEqual([expect.objectContaining({ kind: 'browser', count: 1, pages: 1 })]);
  });
});
