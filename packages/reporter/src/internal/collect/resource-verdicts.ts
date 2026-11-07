import * as path from 'node:path';
import type { TestStep } from '@playwright/test/reporter';
import type { WireResourceFinding } from '@piwitests/core/wire';
import type { SourceLines } from '../support/source-snippet.js';
import type {
  LeakCheck,
  ResourceBirth,
  ResourceCensus,
  ResourceClose,
  ResourceTestRef,
} from '../capture/resource-ledger.js';

/**
 * Turns the resource censuses the capture fixtures attach (`piwi-resources`)
 * into findings: the objects left open after the scope that opened them, the
 * pages opened and never used, the owners whose pages, listeners or route
 * handlers pile up, and the Node handles a test left in its worker. Workers
 * report facts; the verdicts are reached here, once every census is in, because
 * only a later census can tell an object a test handed on (and a later test
 * closed) from one nobody closed.
 *
 * Pure: the reporter feeds it the parsed censuses and the steps of tests that
 * ran without the fixtures, and prints `formatResourceSummary`.
 */

export type ResourceFinding = WireResourceFinding;

export interface ResourceReport {
  findings: ResourceFinding[];
  counts: { leaked: number; idle: number; piling: number; handle: number; probable: number };
}

/** A browser, context or page a test opened or closed, from its `pw:api` steps. */
export interface LifecycleCall {
  op: 'open' | 'close';
  /**
   * A close of `context` closes a context, or a page `browser.newPage()`
   * opened, whose context goes with it.
   */
  kind: 'browser' | 'context' | 'page';
  /** The line of the call, `file:line`, relative, POSIX separators. */
  site: string | null;
  /** Made in a `beforeAll` or `afterAll` hook: the describe block holds what it opens. */
  block: boolean;
  /**
   * Made by a fixture, which closes what it opens: such an open is never a
   * finding, but a close the test makes may be for it.
   */
  fixture: boolean;
  /** The name the call was made on, from its line: `browser` in `browser.newPage()`, `ctx` in `ctx.close()`. */
  on: string | null;
  /** An open's name: what it was assigned to (`ctx` in `const ctx = await …`), or its fixture's. */
  name: string | null;
}

/** One attempt's lifecycle calls, in the order it made them, for a run without the fixtures. */
export interface LifecycleTally {
  /** Spec file, relative, POSIX separators. */
  file: string;
  test: string;
  /** The worker process that ran it: a `beforeAll`'s objects stay in it. */
  worker: number;
  /** It ended otherwise than expected: Playwright shut its worker down right after it. */
  failed: boolean;
  calls: LifecycleCall[];
}

export interface ResourceReportInput {
  censuses: ResourceCensus[];
  /** Per test id: the user fixtures its `Before Hooks` set up, `name (file:line)`. */
  fixturesByTest?: Map<string, string[]>;
  tallies?: LifecycleTally[];
}

interface Tracked {
  worker: number;
  birth: ResourceBirth;
  bornCensus: ResourceCensus;
  close: ResourceClose | null;
  lastOpenAt: number | null;
  used: boolean | undefined;
  series: Array<{ pages?: number; listeners?: number; routes?: number; elements?: number; test: ResourceTestRef }>;
  /** Pages: main-thread CPU read at each census, over CDP. */
  mainCpu: Array<{ at: number; cpuMs: number }>;
}

/**
 * The `pw:api` steps that open or close a browser, a context or a page, with
 * the method each is called by. A page has a context of its own only from
 * `browser.newPage()`, and closing it is a `Close context`; `Close page` closes
 * a page of a context, which goes with it. An API request context's
 * `dispose()` is no step, so `Create request context` is not counted.
 */
const OPEN_STEPS: Record<string, { kind: LifecycleCall['kind']; method: string }> = {
  'Create context': { kind: 'context', method: 'newContext' },
  'Launch persistent context': { kind: 'context', method: 'launchPersistentContext' },
  'Launch browser': { kind: 'browser', method: 'launch' },
  'Connect over CDP': { kind: 'browser', method: 'connectOverCDP' },
  'Create page': { kind: 'page', method: 'newPage' },
};
const CLOSE_STEPS: Record<string, LifecycleCall['kind']> = {
  'Close context': 'context',
  'Close browser': 'browser',
};

/** A census attachment's body, or null when it is not one this reporter reads. */
export function parseResourceCensus(body: Buffer | string | undefined): ResourceCensus | null {
  if (!body) return null;
  try {
    const value = JSON.parse(body.toString()) as Partial<ResourceCensus>;
    if (value?.v !== 1 || !Array.isArray(value.born) || !Array.isArray(value.closed) || !Array.isArray(value.open)) {
      return null;
    }
    if (typeof value.worker !== 'number' || typeof value.at !== 'number') return null;
    return value as ResourceCensus;
  } catch {
    return null;
  }
}

/** Every census line of the workers' shutdown file; malformed lines are skipped. */
export function parseResourceResults(text: string): ResourceCensus[] {
  return text
    .split('\n')
    .map((line) => (line.trim() ? parseResourceCensus(line) : null))
    .filter((census): census is ResourceCensus => census !== null);
}

/** The user fixtures a test's `Before Hooks` set up: those with a location outside `node_modules`. */
export function userFixturesOf(steps: TestStep[]): string[] {
  const out: string[] = [];
  const walk = (list: TestStep[]) => {
    for (const step of list) {
      const file = step.location?.file;
      if (step.category === 'fixture' && file && !file.includes(`${path.sep}node_modules${path.sep}`)) {
        const name = fixtureName(step);
        if (!name.startsWith('piwi')) out.push(`${name} (${relativeFile(file)}:${step.location!.line})`);
      }
      walk(step.steps ?? []);
    }
  };
  walk(steps);
  return [...new Set(out)];
}

/** A fixture step's fixture: `page` for `Fixture "page"`. */
function fixtureName(step: TestStep): string {
  return step.title.replace(/^(?:Fixture\s+|fixture:\s*)/, '').replace(/^"(.*)"$/, '$1');
}

/**
 * The browsers, contexts and pages an attempt opened and closed, in order,
 * from its `pw:api` steps: a fixture's opens marked as such, its closes left
 * out, a failed call left out. `source` reads the lines the steps point at, for
 * the names each call gives (`namesAt`) and the kind of a hook given a title.
 */
export function tallyLifecycleSteps(
  attempt: Omit<LifecycleTally, 'calls'>,
  steps: TestStep[],
  source: SourceLines,
): LifecycleTally {
  const calls: LifecycleCall[] = [];
  const walk = (list: TestStep[], block: boolean, fixture: string | null) => {
    for (const step of list) {
      // A hook has a location; `Before Hooks` and `After Hooks`, which hold them, have none.
      if (step.category === 'hook' && step.location) {
        walk(step.steps ?? [], blockHook(step, source), fixture);
        continue;
      }
      const opened = OPEN_STEPS[step.title];
      const closed = CLOSE_STEPS[step.title];
      // A fixture's teardown closes what it opened.
      if (step.category === 'pw:api' && !step.error && (opened || (closed && fixture === null))) {
        const site = step.location ? `${relativeFile(step.location.file)}:${step.location.line}` : null;
        const names = namesAt(step, source, opened?.method ?? 'close');
        const call = { site, block, fixture: fixture !== null, on: names.on };
        if (opened) calls.push({ op: 'open', kind: opened.kind, ...call, name: fixture ?? names.name });
        else calls.push({ op: 'close', kind: closed!, ...call, name: null });
      }
      walk(step.steps ?? [], block, step.category === 'fixture' ? fixtureName(step) : fixture);
    }
  };
  walk(steps, false, null);
  return { ...attempt, calls };
}

/**
 * Whether a hook is a `beforeAll` or an `afterAll`: by its title, `beforeAll hook`,
 * or for a hook given a title of its own, by the method its column points at.
 */
function blockHook(step: TestStep, source: SourceLines): boolean {
  const location = step.location!;
  const method =
    /^((?:before|after)(?:All|Each)) hook$/.exec(step.title)?.[1] ??
    /^\w+/.exec(source(location.file)?.[location.line - 1]?.slice(location.column - 1) ?? '')?.[0];
  return method === 'beforeAll' || method === 'afterAll';
}

/**
 * The names a call's line gives it: the name right before `.method(` (or `?.`,
 * `!.`), the first call of that method at or after the step's column, which
 * Playwright puts at the method or at the `await` before it; and the name that
 * call is assigned to. A chain broken across lines is read with the two lines
 * above.
 */
function namesAt(step: TestStep, source: SourceLines, method: string): { on: string | null; name: string | null } {
  const location = step.location;
  const lines = location ? source(location.file) : null;
  const line = location ? lines?.[location.line - 1] : undefined;
  if (!location || !lines || line === undefined) return { on: null, name: null };
  const text = [...lines.slice(Math.max(0, location.line - 3), location.line - 1), line].join('\n');
  const column = text.length - line.length + location.column - 1;
  const calls = new RegExp(`([\\w$]+)\\s*[!?]?\\.\\s*${method}\\s*\\(`, 'g');
  for (const match of text.matchAll(calls)) {
    if (match.index + match[0].lastIndexOf(method) < column) continue;
    const assigned = /([\w$]+)\s*(?::[\w$.<>[\]|& \t]*)?=\s*(?:await\s+)?(?:[\w$]+\s*[!?]?\.\s*)*$/.exec(
      text.slice(0, match.index),
    );
    return { on: match[1]!, name: assigned?.[1] ?? null };
  }
  return { on: null, name: null };
}

function relativeFile(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join('/');
}

/** Stitch every worker's censuses and reach the verdicts. */
export function buildResourceReport(input: ResourceReportInput): ResourceReport {
  const findings: ResourceFinding[] = [];
  const byWorker = new Map<number, ResourceCensus[]>();
  for (const census of input.censuses) {
    const list = byWorker.get(census.worker) ?? [];
    list.push(census);
    byWorker.set(census.worker, list);
  }

  const leaked: Array<{ tracked: Tracked; scope: 'test' | 'describe'; heldMs: number; untilWorkerEnd: boolean }> = [];
  const idle: Tracked[] = [];
  const all: Tracked[] = [];

  for (const censuses of byWorker.values()) {
    censuses.sort((a, b) => a.at - b.at);
    const tracked = new Map<number, Tracked>();
    for (const census of censuses) {
      for (const birth of census.born) {
        tracked.set(birth.id, {
          worker: census.worker,
          birth,
          bornCensus: census,
          close: null,
          lastOpenAt: null,
          used: undefined,
          series: [],
          mainCpu: [],
        });
      }
      for (const close of census.closed) {
        const entry = tracked.get(close.id);
        if (!entry) continue;
        entry.close = close;
        if (close.used !== undefined) entry.used = close.used;
      }
      for (const open of census.open) {
        const entry = tracked.get(open.id);
        if (!entry) continue;
        entry.lastOpenAt = census.at;
        if (open.used !== undefined) entry.used = open.used;
        if (census.test) {
          entry.series.push({
            pages: open.pages,
            listeners: open.listeners,
            routes: open.routes,
            elements: open.main?.elements,
            test: census.test,
          });
        }
        if (open.main) entry.mainCpu.push({ at: census.at, cpuMs: open.main.cpuMs });
      }
    }
    const testCensuses = censuses.filter((census) => census.test !== null);
    const workerEnded = censuses.some((census) => census.test === null);

    for (const entry of tracked.values()) {
      all.push(entry);
      if (entry.birth.kind === 'page' && entry.used === false && !entry.bornCensus.test?.failed) idle.push(entry);
      const verdict = leakVerdict(entry, testCensuses, workerEnded);
      if (verdict) leaked.push({ tracked: entry, ...verdict });
    }
  }

  findings.push(...groupLeaks(leaked, all));
  findings.push(...pilingFindings(all));
  findings.push(...workerPilingFindings(byWorker));
  findings.push(...handleFindings(byWorker));
  findings.push(...groupIdle(idle, input.fixturesByTest ?? new Map()));
  findings.push(...probableFindings(input.tallies ?? []));

  const counts = { leaked: 0, idle: 0, piling: 0, handle: 0, probable: 0 };
  for (const finding of findings) counts[finding.verdict] += finding.verdict === 'idle' ? finding.count : 1;
  return { findings, counts };
}

/** Whether a ref belongs to the same spec file as the object's birth: the scope hand-overs stay within. */
function sameFile(birth: ResourceBirth, ref: { file: string } | null): boolean {
  return !!ref && !!birth.test && ref.file === birth.test.file;
}

/**
 * Whether a ref is a test of the describe block a hook object was opened in:
 * the describe of the test that ran the hook, or the whole file for a hook at
 * its top level.
 */
function insideBlock(birth: ResourceBirth, ref: ResourceTestRef | null): boolean {
  if (!ref || !sameFile(birth, ref)) return false;
  return birth.test!.suite.every((title, index) => ref.suite[index] === title);
}

/**
 * The verdict on one object: leaked past its test, leaked past its describe
 * block, or nothing. An object a test opened and a later test or hook of the
 * same file closed was handed on, not leaked; one a worker-scoped fixture opened
 * lives as long as the worker by design.
 */
function leakVerdict(
  entry: Tracked,
  testCensuses: ResourceCensus[],
  workerEnded: boolean,
): { scope: 'test' | 'describe'; heldMs: number; untilWorkerEnd: boolean } | null {
  const { birth, close, bornCensus } = entry;
  if (birth.reused || birth.phase === 'worker' || birth.fixture?.worker || !birth.test) return null;
  if (birth.kind === 'context' && birth.implicit) return null;
  // `PIWI_LEAK_CHECK=close` closed it at the end of its test: gone from that census, still a leak.
  if (close?.byPiwi) return { scope: 'test', heldMs: 0, untilWorkerEnd: false };
  const closedByShutdown = !!close && (close.phase === 'worker' || close.test === null);

  if (birth.phase === 'beforeAll' || birth.phase === 'afterAll') {
    if (close && !closedByShutdown && sameFile(birth, close.test)) return null;
    // The block ended when a test outside it ran on this worker, or the worker shut down.
    const ended =
      workerEnded || testCensuses.some((census) => census.at >= bornCensus.at && !insideBlock(birth, census.test));
    if (!ended) return null;
    const lastInside = [...testCensuses].reverse().find((census) => insideBlock(birth, census.test));
    const blockEnd = lastInside?.at ?? bornCensus.at;
    const end = close?.at ?? entry.lastOpenAt ?? blockEnd;
    return { scope: 'describe', heldMs: Math.max(0, end - blockEnd), untilWorkerEnd: !close || closedByShutdown };
  }

  // Born in a test's span: it outlived the test when it was open at the census closing that test.
  if (bornCensus.test === null || bornCensus.test.id !== birth.test.id) return null;
  // The test failed, so Playwright shut its worker down right after it.
  if (bornCensus.test.failed) return null;
  const openAtItsEnd = bornCensus.open.some((open) => open.id === birth.id);
  if (!openAtItsEnd) return null;
  // Closed later in its own test (a fixture tearing down after the census), or
  // handed on to a later test or hook of the same file that closed it.
  if (close && !closedByShutdown && (close.test?.id === birth.test.id || sameFile(birth, close.test))) return null;
  const end = close?.at ?? entry.lastOpenAt ?? bornCensus.at;
  return { scope: 'test', heldMs: Math.max(0, end - bornCensus.at), untilWorkerEnd: !close || closedByShutdown };
}

/** Where an object was opened, as the summary names it. */
function whereOf(birth: ResourceBirth): string {
  if (birth.opener !== undefined) {
    return `popup${birth.trigger ? ` after ${birth.trigger}` : ''}${birth.site ? ` at ${birth.site}` : ''}`;
  }
  if (birth.fixture) {
    const at = birth.site ?? birth.fixture.location;
    return `fixture "${birth.fixture.title}"${at ? ` at ${at}` : ''}`;
  }
  return birth.site ?? 'an unknown line';
}

/** The main-thread CPU a page used after the census that closed its test. */
function afterTestCpu(entry: Tracked): number {
  const readings = entry.mainCpu;
  if (readings.length < 2) return 0;
  const first = readings.find((reading) => reading.at >= entry.bornCensus.at) ?? readings[0]!;
  return Math.max(0, readings[readings.length - 1]!.cpuMs - first.cpuMs);
}

/** The line that opened an object, or the fixture's, `file:line`. */
function siteOf(birth: ResourceBirth): string | null {
  return birth.site ?? birth.fixture?.location ?? null;
}

/** The key of an object across workers: ids restart in every worker process. */
const keyOf = (worker: number, id: number) => `${worker}:${id}`;

type Leak = { tracked: Tracked; scope: 'test' | 'describe'; heldMs: number; untilWorkerEnd: boolean };

/**
 * Group leaked objects by where they were opened. A page in a leaked context,
 * and a context in a leaked browser, are folded into it; the context
 * `browser.newPage()` opened for its page is folded into the page.
 */
function groupLeaks(leaked: Leak[], all: Tracked[]): ResourceFinding[] {
  const leaks = new Map(leaked.map((leak) => [keyOf(leak.tracked.worker, leak.tracked.birth.id), leak]));
  const tracked = new Map(all.map((entry) => [keyOf(entry.worker, entry.birth.id), entry]));
  const groups = new Map<string, ResourceFinding & { testIds: Set<string> }>();
  const groupKey = (leak: Leak) => `${leak.scope}|${leak.tracked.birth.kind}|${whereOf(leak.tracked.birth)}`;
  for (const leak of leaked) {
    const { birth } = leak.tracked;
    if (birth.kind === 'context' && birth.implicit) continue;
    if (foldTarget(leak.tracked, leaks, tracked)) continue;
    const key = groupKey(leak);
    const group = groups.get(key) ?? {
      verdict: 'leaked' as const,
      kind: birth.kind,
      where: whereOf(birth),
      site: siteOf(birth),
      scope: leak.scope,
      tests: 0,
      count: 0,
      heldMs: 0,
      untilWorkerEnd: false,
      pages: 0,
      testIds: new Set<string>(),
      ...(leak.scope === 'describe' && birth.test?.suite.length
        ? { detail: `beforeAll of "${birth.test.suite.join(' › ')}"` }
        : {}),
    };
    group.count++;
    if (birth.test) group.testIds.add(birth.test.id);
    group.heldMs = Math.max(group.heldMs ?? 0, leak.heldMs);
    group.untilWorkerEnd = group.untilWorkerEnd || leak.untilWorkerEnd;
    if (leak.tracked.close?.byPiwi) group.closedByPiwi = true;
    if (birth.kind === 'page' && leak.scope === 'test') addCpu(group, afterTestCpu(leak.tracked));
    groups.set(key, group);
  }
  // Count the pages folded into each group, and what they used after their test.
  for (const leak of leaked) {
    if (leak.tracked.birth.kind !== 'page') continue;
    const root = foldTarget(leak.tracked, leaks, tracked);
    const group = root ? groups.get(groupKey(root)) : undefined;
    if (!group) continue;
    group.pages = (group.pages ?? 0) + 1;
    if (root!.scope === 'test') addCpu(group, afterTestCpu(leak.tracked));
  }
  return [...groups.values()]
    .map(({ testIds, ...finding }) => ({ ...finding, tests: testIds.size }))
    .sort((a, b) => (a.scope === b.scope ? b.count - a.count : a.scope === 'test' ? -1 : 1));
}

function addCpu(group: ResourceFinding, cpuMs: number): void {
  if (cpuMs > 0) group.afterTestCpuMs = (group.afterTestCpuMs ?? 0) + cpuMs;
}

/**
 * The leaked ancestor an object folds into, if any: a page's leaked context, a
 * context's leaked browser, walking through the context `browser.newPage()`
 * opened for a page, which is never a finding of its own.
 */
function foldTarget(entry: Tracked, leaks: Map<string, Leak>, tracked: Map<string, Tracked>): Leak | null {
  let parentId = entry.birth.parent;
  while (parentId !== null) {
    const key = keyOf(entry.worker, parentId);
    const parent = tracked.get(key);
    if (!parent) return null;
    if (!(parent.birth.kind === 'context' && parent.birth.implicit)) return leaks.get(key) ?? null;
    parentId = parent.birth.parent;
  }
  return null;
}

/** Group pages that ended unused by what opened them. */
function groupIdle(idle: Tracked[], fixturesByTest: Map<string, string[]>): ResourceFinding[] {
  const groups = new Map<string, ResourceFinding & { testIds: Set<string> }>();
  for (const entry of idle) {
    const { birth } = entry;
    const fixtures = birth.test ? (fixturesByTest.get(birth.test.id) ?? []) : [];
    const detail = birth.fixture && fixtures.length ? `set up with ${fixtures.join(', ')}` : undefined;
    const where = whereOf(birth);
    const key = `${where}|${detail ?? ''}`;
    const group = groups.get(key) ?? {
      verdict: 'idle' as const,
      kind: 'page' as const,
      where,
      site: siteOf(birth),
      tests: 0,
      count: 0,
      testIds: new Set<string>(),
      ...(detail ? { detail } : {}),
    };
    group.count++;
    if (birth.test) group.testIds.add(birth.test.id);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ testIds, ...finding }) => ({ ...finding, tests: testIds.size }))
    .sort((a, b) => b.count - a.count);
}

type GrowthWhat = NonNullable<ResourceFinding['growth']>['what'];

/**
 * How much of each thing must pile up before it is a finding: the growth, and
 * for the larger counts a share of where it started, over at least
 * `minPoints` censuses. Pages, listeners and route handlers are counted
 * exactly; attached elements too. The worker's heap is read after V8's own
 * full garbage collections, so only a few tests carry it; descriptors are
 * exact.
 */
const PILING_RULES: Record<GrowthWhat, { min: number; share: number; minPoints: number }> = {
  pages: { min: 2, share: 0, minPoints: 3 },
  listeners: { min: 2, share: 0, minPoints: 3 },
  routes: { min: 2, share: 0, minPoints: 3 },
  elements: { min: 200, share: 0.25, minPoints: 4 },
  heapMb: { min: 32, share: 0.2, minPoints: 3 },
  descriptors: { min: 8, share: 0.2, minPoints: 4 },
};

/**
 * Whether a series of readings, one per census, piled up: from where to where,
 * or null. Either it never went down and grew by the rule's amount, or what it
 * kept grew: the floor at each census (the lowest reading from there on, which
 * a dip back down lowers) rose by that amount by three quarters of the series
 * and a quarter of that rise was there by its middle, so a series that only
 * jumps at its end, or wanders, is not one.
 */
export function pileUp(values: number[], what: GrowthWhat): { from: number; to: number } | null {
  const rule = PILING_RULES[what];
  if (values.length < rule.minPoints) return null;
  const enough = (from: number, to: number) => to - from >= Math.max(rule.min, from * rule.share);
  const first = values[0]!;
  const last = values[values.length - 1]!;
  if (values.every((value, i) => i === 0 || value >= values[i - 1]!) && enough(first, last)) {
    return { from: first, to: last };
  }
  if (values.length < 4) return null;
  const floor = [...values];
  for (let i = floor.length - 2; i >= 0; i--) floor[i] = Math.min(floor[i]!, floor[i + 1]!);
  const start = floor[0]!;
  const middle = floor[Math.floor((floor.length - 1) / 2)]!;
  const late = floor[Math.floor(((floor.length - 1) * 3) / 4)]!;
  if (!enough(start, late) || middle - start < (late - start) / 4) return null;
  return { from: start, to: last };
}

/** An open context whose pages, or an open page whose listeners, route handlers or elements, grew test after test. */
function pilingFindings(all: Tracked[]): ResourceFinding[] {
  const out: ResourceFinding[] = [];
  for (const entry of all) {
    for (const what of ['pages', 'listeners', 'routes', 'elements'] as const) {
      const values = entry.series.map((point) => point[what]).filter((v): v is number => typeof v === 'number');
      const growth = pileUp(values, what);
      if (!growth) continue;
      out.push({
        verdict: 'piling',
        kind: entry.birth.kind,
        where: whereOf(entry.birth),
        site: siteOf(entry.birth),
        tests: values.length,
        count: 1,
        growth: { what, from: Math.round(growth.from), to: Math.round(growth.to), tests: values.length },
      });
    }
  }
  return out.sort((a, b) => b.growth!.to - b.growth!.from - (a.growth!.to - a.growth!.from));
}

/** A test that left an object, a server or a process open: what it added to its worker is already a finding. */
function leftSomethingOpen(census: ResourceCensus): boolean {
  if ((census.leftOpen ?? 0) > 0 || (census.running?.length ?? 0) > 0) return true;
  const handles = census.handles;
  return !!handles && Object.entries(handles.end).some(([type, n]) => n > (handles.start[type] ?? 0));
}

/**
 * A worker process whose heap after full garbage collections, or whose open
 * file descriptors, grew test after test: a test, a hook or a fixture keeps
 * something in the worker. What a test that left something open added is left
 * out of the decision, since that is a finding already. Node keeps no site for
 * either, so when every test carries a reading (descriptors do; the heap is
 * read only after the full collections V8 chose to run) the finding names the
 * test during which the most of the rest was gained.
 */
function workerPilingFindings(byWorker: Map<number, ResourceCensus[]>): ResourceFinding[] {
  const best = new Map<GrowthWhat, ResourceFinding & { gained: number }>();
  for (const censuses of byWorker.values()) {
    const measured = censuses
      .filter((census) => census.test && !census.test.failed && census.metrics)
      .sort((a, b) => a.at - b.at);
    const read: Array<[GrowthWhat, (census: ResourceCensus) => number | null | undefined]> = [
      ['heapMb', (census) => census.metrics!.worker.heapAfterGcMb],
      ['descriptors', (census) => census.metrics!.worker.fds],
    ];
    for (const [what, value] of read) {
      const points = measured
        .map((census) => ({ census, value: value(census) }))
        .filter((point): point is { census: ResourceCensus; value: number } => typeof point.value === 'number');
      // The readings with what tests that left something open added taken out.
      const unexplained: number[] = [];
      let top: { test: ResourceTestRef; gained: number } | null = null;
      points.forEach((point, i) => {
        if (i === 0) return void unexplained.push(point.value);
        const gained = point.value - points[i - 1]!.value;
        const counted = leftSomethingOpen(point.census) && gained > 0 ? 0 : gained;
        unexplained.push(unexplained[i - 1]! + counted);
        if (counted > 0 && (!top || counted > top.gained)) top = { test: point.census.test!, gained: counted };
      });
      const growth = pileUp(unexplained, what);
      if (!growth) continue;
      const lead = points.length === measured.length ? (top as { test: ResourceTestRef; gained: number } | null) : null;
      const span = measured.indexOf(points[points.length - 1]!.census) - measured.indexOf(points[0]!.census) + 1;
      const finding: ResourceFinding & { gained: number } = {
        verdict: 'piling',
        kind: 'worker',
        where: 'worker process',
        tests: measured.length,
        count: 1,
        growth: {
          what,
          from: Math.round(Math.min(...points.map((point) => point.value))),
          to: Math.round(points[points.length - 1]!.value),
          tests: span,
        },
        ...(lead ? { detail: `most of it during "${lead.test.title ?? ''}" (${lead.test.file})` } : {}),
        gained: growth.to - growth.from,
      };
      // One finding per kind of growth, from the worker where it grew most.
      const seen = best.get(what);
      if (!seen || finding.gained > seen.gained) best.set(what, finding);
    }
  }
  return [...best.values()].map(({ gained: _gained, ...finding }) => finding);
}

/**
 * The servers and child processes a test left running in its worker, each at
 * the line that started it, from the censuses that track them; and, from the
 * counts, a tracked Node handle type that grew during a test and was still
 * there when the next test started. A census that tracks servers one by one
 * leaves them out of its counts.
 */
function handleFindings(byWorker: Map<number, ResourceCensus[]>): ResourceFinding[] {
  const groups = new Map<string, ResourceFinding>();
  const add = (test: ResourceTestRef, type: string, count: number, site: string | null = null) => {
    const key = `${test.id}|${type}|${site ?? ''}`;
    const group = groups.get(key) ?? {
      verdict: 'handle' as const,
      kind: 'handle' as const,
      where: type,
      ...(site ? { site } : {}),
      tests: 1,
      count: 0,
      detail: `"${test.title ?? ''}" (${test.file})`,
    };
    group.count += count;
    groups.set(key, group);
  };
  for (const censuses of byWorker.values()) {
    for (const census of censuses) {
      if (!census.test || census.test.failed) continue;
      for (const handle of census.running ?? []) add(census.test, handle.type, 1, handle.site);
    }
    const ordered = censuses.filter((census) => census.test && census.handles).sort((a, b) => a.at - b.at);
    for (let i = 0; i < ordered.length - 1; i++) {
      const census = ordered[i]!;
      const next = ordered[i + 1]!;
      for (const [type, end] of Object.entries(census.handles!.end)) {
        if (census.running && type === 'TCPServerWrap') continue;
        const grew = end - (census.handles!.start[type] ?? 0);
        if (grew <= 0 || (next.handles!.start[type] ?? 0) < end) continue;
        add(census.test!, type, grew);
      }
    }
  }
  return [...groups.values()];
}

/** An open the steps showed, and whether a close was paired with it. */
interface StepOpen {
  call: LifecycleCall;
  tally: LifecycleTally;
  scope: string;
  /** A finding when left open: not a fixture's, nor a page of a context. */
  counted: boolean;
  closed: boolean;
}

/**
 * Whether a page opened on `on` has a context of its own: `on` is a browser,
 * by the open that gave it its name in this scope or the describe block's, else
 * by the name itself (`browser`, `adminBrowser`, not `browserContext`).
 */
function ownsContext(on: string | null, boundTo: (name: string) => LifecycleCall['kind'] | undefined): boolean {
  if (!on) return false;
  const kind = boundTo(on);
  return kind ? kind === 'browser' : /browser/i.test(on) && !/context|ctx/i.test(on);
}

/**
 * The opens no close was paired with, in one worker's attempts of one spec
 * file, in the order they ran. A scope is an attempt with its `beforeEach` and
 * `afterEach` hooks, or the file's `beforeAll` and `afterAll` hooks. A close
 * reaches its scope, then the describe block's, then any earlier scope, which
 * handed the object on; a test's `Close browser` stops at the describe block,
 * since a repeated `browser.close()` is a step again. In what it reaches, it
 * is paired with the latest open of the name it was called on, else the latest
 * of its kind in the nearest scope, a counted one first. A `Close browser`
 * also closes the contexts and pages opened on its browser's name since, or
 * with no names to tell, those its browser's scope opened since.
 */
function unpairedOpens(attempts: LifecycleTally[]): StepOpen[] {
  const opens: StepOpen[] = [];
  const latest = (test: (open: StepOpen) => boolean): StepOpen | undefined => {
    for (let i = opens.length - 1; i >= 0; i--) if (test(opens[i]!)) return opens[i];
    return undefined;
  };
  attempts.forEach((tally, index) => {
    const own = `attempt ${index}`;
    const boundTo = (name: string) =>
      latest((open) => (open.scope === own || open.scope === 'block') && open.call.name === name)?.call.kind;
    for (const call of tally.calls) {
      const scope = call.block ? 'block' : own;
      if (call.op === 'open') {
        const counted = !call.fixture && (call.kind !== 'page' || ownsContext(call.on, boundTo));
        opens.push({ call, tally, scope, counted, closed: false });
        continue;
      }
      const kinds: string[] = call.kind === 'browser' ? ['browser'] : ['context', 'page'];
      const nearest = call.kind === 'browser' && !call.block ? 2 : 3;
      const levels = [(o: StepOpen) => o.scope === scope, (o: StepOpen) => o.scope === 'block', () => true];
      const free = (o: StepOpen) =>
        !o.closed && kinds.includes(o.call.kind) && levels.slice(0, nearest).some((l) => l(o));
      let open = call.on ? latest((o) => free(o) && o.call.name === call.on) : undefined;
      for (const level of levels.slice(0, nearest)) {
        open ??= latest((o) => free(o) && level(o) && o.counted) ?? latest((o) => free(o) && level(o));
      }
      if (!open) continue;
      open.closed = true;
      if (call.kind !== 'browser') continue;
      const browser = open;
      for (const later of opens.slice(opens.indexOf(browser) + 1)) {
        if (later.call.kind === 'browser') continue;
        const named = browser.call.name !== null && later.call.on !== null;
        if (named ? later.call.on === browser.call.name : later.scope === browser.scope) later.closed = true;
      }
    }
  });
  return opens.filter((open) => !open.closed && open.counted);
}

/**
 * Without the fixtures: the browsers, contexts and `browser.newPage()` pages
 * the steps show opened and never closed, one finding per line that opened
 * them. What a failed attempt opened is not judged: Playwright shut its worker
 * down right after it.
 */
function probableFindings(tallies: LifecycleTally[]): ResourceFinding[] {
  const streams = new Map<string, LifecycleTally[]>();
  for (const tally of tallies) {
    const key = `${tally.worker}|${tally.file}`;
    const attempts = streams.get(key) ?? [];
    attempts.push(tally);
    streams.set(key, attempts);
  }
  const groups = new Map<string, { finding: ResourceFinding; testIds: Set<string>; inTests: boolean }>();
  for (const attempts of streams.values()) {
    for (const { call, tally } of unpairedOpens(attempts)) {
      if (tally.failed) continue;
      const where = call.site ?? tally.file;
      const key = `${call.kind}|${where}`;
      const group = groups.get(key) ?? {
        finding: { verdict: 'probable', kind: call.kind, where, site: call.site, tests: 0, count: 0 },
        testIds: new Set<string>(),
        inTests: false,
      };
      group.finding.count++;
      group.testIds.add(tally.test);
      group.inTests ||= !call.block;
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .map(({ finding, testIds, inTests }) => {
      const tests = testIds.size;
      const what = finding.count > 1 ? `${finding.count} ${KIND_LABEL[finding.kind]}s ` : '';
      const by = !inTests ? 'a beforeAll or afterAll hook' : tests === 1 ? 'its test' : `${tests} tests`;
      return { ...finding, tests, detail: `${what}left open by ${by}` };
    })
    .sort((a, b) => b.count - a.count);
}

/** `5.6 s`, `2 min 3 s`, `850 ms`. */
export function formatHeld(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

const KIND_LABEL: Record<ResourceFinding['kind'], string> = {
  browser: 'browser',
  context: 'context',
  page: 'page',
  request: 'API context',
  handle: 'handle',
  worker: 'worker',
};

/** What piled up, as the kind column names it. */
const GROWTH_LABEL: Record<GrowthWhat, string> = {
  pages: 'pages',
  listeners: 'listeners',
  routes: 'routes',
  elements: 'elements',
  heapMb: 'heap',
  descriptors: 'descriptors',
};

/** What piled up, after its numbers. */
const GROWTH_NOUN: Record<GrowthWhat, string> = {
  pages: 'open pages',
  listeners: 'listeners',
  routes: 'route handlers',
  elements: 'DOM elements',
  heapMb: 'MB of heap after garbage collection',
  descriptors: 'open file descriptors',
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Node's handle type names, as a reader knows them. */
const HANDLE_LABEL: Record<string, string> = {
  TCPServerWrap: 'server',
  FSEventWrap: 'file watcher',
  StatWatcher: 'file watcher',
  ChildProcess: 'process',
};

/** One line per finding, most severe first. */
function findingLine(finding: ResourceFinding): string {
  const verdict = finding.verdict.padEnd(8);
  const label =
    finding.verdict === 'handle'
      ? (HANDLE_LABEL[finding.where] ?? finding.where)
      : finding.growth
        ? GROWTH_LABEL[finding.growth.what]
        : KIND_LABEL[finding.kind];
  const kind = label.padEnd(11);
  const parts: string[] = finding.verdict === 'handle' ? (finding.site ? [finding.site] : []) : [finding.where];
  switch (finding.verdict) {
    case 'leaked': {
      if (finding.count > 1) parts.push(`${finding.count} ${KIND_LABEL[finding.kind]}s`);
      if (finding.detail) parts.push(finding.detail);
      if (finding.pages) parts.push(`with ${plural(finding.pages, 'page')}`);
      if (finding.tests) parts.push(plural(finding.tests, 'test'));
      const past = finding.scope === 'describe' ? 'its describe block' : 'its test';
      if (finding.closedByPiwi) parts.push('closed by Piwi at the end of its test');
      else if (finding.untilWorkerEnd)
        parts.push(`open until the worker shut down (${formatHeld(finding.heldMs ?? 0)} past ${past})`);
      else parts.push(`open ${formatHeld(finding.heldMs ?? 0)} past ${past}`);
      if ((finding.afterTestCpuMs ?? 0) >= 500)
        parts.push(`${formatHeld(finding.afterTestCpuMs!)} of page CPU after its test`);
      break;
    }
    case 'idle':
      parts.push(plural(finding.count, 'page'));
      if (finding.tests) parts.push(plural(finding.tests, 'test'));
      if (finding.detail) parts.push(finding.detail);
      break;
    case 'piling': {
      const growth = finding.growth!;
      parts.push(`${growth.from} → ${growth.to} ${GROWTH_NOUN[growth.what]} over ${growth.tests} tests`);
      if (finding.detail) parts.push(finding.detail);
      break;
    }
    case 'handle':
      if (finding.count > 1) parts.push(`${finding.count} ${label}${label.endsWith('s') ? 'es' : 's'}`);
      parts.push(`left running in the worker by ${finding.detail ?? 'a test'}`);
      break;
    case 'probable':
      if (finding.detail) parts.push(finding.detail);
      break;
  }
  return `  ${verdict} ${kind} ${parts.join(' · ')}`;
}

/**
 * The end-of-run summary, without the logger prefix, or nothing when there is
 * no finding. At most `maxLines` findings are listed; the rest are counted.
 */
export function formatResourceSummary(report: ResourceReport, leakCheck: LeakCheck, maxLines = 10): string[] {
  if (report.findings.length === 0) return [];
  const { counts } = report;
  const head = [
    counts.leaked ? plural(counts.leaked, 'leak') : '',
    counts.idle ? `${plural(counts.idle, 'idle page')}` : '',
    counts.piling ? `${counts.piling} piling up` : '',
    counts.handle ? plural(counts.handle, 'handle') + ' left in workers' : '',
    counts.probable ? plural(counts.probable, 'probable leak') : '',
  ].filter(Boolean);
  const lines = [`Resources: ${head.join(' · ')}`];
  for (const finding of report.findings.slice(0, maxLines)) lines.push(findingLine(finding));
  const rest = report.findings.length - maxLines;
  if (rest > 0) lines.push(`  … and ${plural(rest, 'more finding')}`);
  const testLeaks = report.findings.some((f) => f.verdict === 'leaked' && f.scope === 'test' && !f.closedByPiwi);
  if (testLeaks && leakCheck === 'report') {
    lines.push(
      "Set leakCheck: 'fail' (PIWI_LEAK_CHECK=fail) to fail the tests that leave what they open, or 'close' to close it.",
    );
  }
  if (counts.probable) {
    lines.push(
      'Probable leaks are counted from the steps alone, without API request contexts (their dispose() leaves no step); the capture fixtures (extendPiwiFixtures) make them exact.',
    );
  }
  return lines;
}
