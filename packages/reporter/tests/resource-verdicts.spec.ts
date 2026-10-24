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
  formatHeld,
  formatResourceSummary,
  parseResourceCensus,
  parseResourceResults,
  tallyLifecycleSteps,
  userFixturesOf,
  type ResourceFinding,
} from '../src/internal/collect/resource-verdicts.js';

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

  it('turns the steps of a run without the fixtures into probable leaks, per file', () => {
    const report = buildResourceReport({
      censuses: [],
      tallies: [
        { file: SPEC, opened: [{ kind: 'context', site: `${SPEC}:4` }], closed: { context: 0, browser: 0 } },
        { file: SPEC, opened: [{ kind: 'context', site: `${SPEC}:4` }], closed: { context: 0, browser: 0 } },
        { file: OTHER_SPEC, opened: [{ kind: 'context', site: `${OTHER_SPEC}:3` }], closed: { context: 1, browser: 0 } },
      ],
    });
    expect(report.findings).toEqual([
      expect.objectContaining({
        verdict: 'probable',
        kind: 'context',
        where: `${SPEC}:4`,
        count: 2,
        detail: `2 opened, 0 closed in ${SPEC}`,
      }),
    ]);
  });
});

describe('tallyLifecycleSteps', () => {
  const step = (title: string, category: string, steps: TestStep[] = [], line = 4): TestStep =>
    ({ title, category, steps, location: { file: path.resolve(SPEC), line, column: 1 } }) as unknown as TestStep;

  it('counts what the test and its hooks opened and closed, never what a fixture did', () => {
    const tally = tallyLifecycleSteps(SPEC, [
      step('Before Hooks', 'hook', [
        step('Fixture "context"', 'fixture', [step('Create context', 'pw:api')]),
        step('beforeAll hook', 'hook', [step('Launch browser', 'pw:api', [], 7)]),
      ]),
      step('Create context', 'pw:api', [], 12),
      step('After Hooks', 'hook', [step('Fixture "context"', 'fixture', [step('Close context', 'pw:api')]), step('Close browser', 'pw:api')]),
    ]);
    expect(tally).toEqual({
      file: SPEC,
      opened: [
        { kind: 'browser', site: `${SPEC}:7` },
        { kind: 'context', site: `${SPEC}:12` },
      ],
      closed: { context: 0, browser: 1 },
    });
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
    expect(formatResourceSummary({ findings: [], counts: { leaked: 0, idle: 0, piling: 0, handle: 0, probable: 0 } }, 'report')).toEqual([]);
  });

  it('heads with the counts, lists each finding, and hints at the strict modes', () => {
    const lines = formatResourceSummary(
      { findings: [leak], counts: { leaked: 1, idle: 0, piling: 0, handle: 0, probable: 0 } },
      'report',
    );
    expect(lines[0]).toBe('Resources: 1 leak');
    expect(lines[1]).toBe(
      `  leaked   context     ${SPEC}:4 · 2 contexts · with 1 page · 2 tests · open until the worker shut down (4.8 s past its test)`,
    );
    expect(lines[2]).toMatch(/PIWI_LEAK_CHECK=fail/);
    expect(formatResourceSummary({ findings: [leak], counts: { leaked: 1, idle: 0, piling: 0, handle: 0, probable: 0 } }, 'fail')).toHaveLength(2);
  });

  it('lists at most the given number of findings and counts the rest', () => {
    const findings = Array.from({ length: 13 }, () => leak);
    const lines = formatResourceSummary({ findings, counts: { leaked: 13, idle: 0, piling: 0, handle: 0, probable: 0 } }, 'fail', 10);
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
