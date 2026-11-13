import * as path from 'node:path';
import type { TestStep } from '@playwright/test/reporter';
import type { WireResourceFinding } from '@piwitests/core/wire';
import type { SourceLines } from '../support/source-snippet.js';
import type {
  LeakCheck,
  ResourceBirth,
  ResourceCensus,
  ResourceClose,
  ResourceKind,
  ResourceTestRef,
  ResourceUse,
} from '../capture/resource-ledger.js';

/**
 * Turns the resource censuses the capture fixtures attach (`piwi-resources`)
 * into findings: the objects left open after the scope that opened them, the
 * ones a test closed long after it last used them, the pages opened and never
 * used, the owners whose pages, listeners or route handlers pile up, and the
 * Node handles a test left in its worker. Workers
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
  counts: Record<ResourceFinding['verdict'], number>;
  /** The objects behind the leaked and lingering findings, each with the stretch it was open for nothing. */
  spans: ResourceSpan[];
}

/** An object open for nothing from `from` to `to` (epoch ms), as the timeline draws it. */
export interface ResourceSpan {
  worker: number;
  verdict: 'leaked' | 'lingering';
  kind: ResourceKind;
  where: string;
  site: string | null;
  lastUse: string | null;
  from: number;
  to: number;
  untilWorkerEnd: boolean;
  /** A leak: the scope it outlived. */
  scope: 'test' | 'describe' | null;
  /** The open pages that went with it: 1 for a page. */
  pages: number;
  test: { title: string; file: string } | null;
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
  /** Made in a `beforeAll` or `afterAll` hook, which holds what it opens past the test. */
  block: boolean;
  /**
   * Made by a fixture: what it opens is never a finding, and is closed by the
   * end of its attempt, by its teardown or by the test.
   */
  fixture: boolean;
  /** The name the call was made on, from its line: `browser` in `browser.newPage()`, `ctx` in `ctx.close()`. */
  on: string | null;
  /** The fixture that made the call; else an open's name, what it was assigned to: `ctx` in `const ctx = await …`. */
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
  /** Per test id: the user fixtures its `After Hooks` tore down, `title|file:line` (`fixturesTornDownOf`). */
  testFixtures?: Map<string, string[]>;
  tallies?: LifecycleTally[];
}

interface Tracked {
  worker: number;
  birth: ResourceBirth;
  bornCensus: ResourceCensus;
  close: ResourceClose | null;
  lastOpenAt: number | null;
  used: boolean | undefined;
  /** The last call a test made on it, as the latest census saw it. */
  lastUse: ResourceUse | null;
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

/**
 * The user fixtures a test's `After Hooks` tore down, `title|file:line`: the
 * fixtures of the test's own scope. A worker fixture is torn down in a
 * `Worker Cleanup` step or after the worker's last test, never there.
 */
export function fixturesTornDownOf(steps: TestStep[]): string[] {
  const after = steps.find((step) => step.category === 'hook' && step.title === 'After Hooks' && !step.location);
  return (after?.steps ?? [])
    .filter((step) => step.category === 'fixture' && step.location)
    .map((step) => `${fixtureName(step)}|${relativeFile(step.location!.file)}:${step.location!.line}`);
}

/** A fixture step's fixture: `page` for `Fixture "page"`. */
function fixtureName(step: TestStep): string {
  return step.title.replace(/^(?:Fixture\s+|fixture:\s*)/, '').replace(/^"(.*)"$/, '$1');
}

/**
 * The browsers, contexts and pages an attempt opened and closed, in order,
 * from its `pw:api` steps, a failed call left out. `source` reads the lines the
 * steps point at, for the names each call gives (`namesAt`) and the kind of a
 * hook given a title.
 */
export function tallyLifecycleSteps(
  attempt: Omit<LifecycleTally, 'calls'>,
  steps: TestStep[],
  source: SourceLines,
): LifecycleTally {
  const calls: LifecycleCall[] = [];
  // Calls under one `await` share a location: the nth step there is the nth call on it.
  const seen = new Map<string, number>();
  const walk = (list: TestStep[], block: boolean, fixture: string | null) => {
    for (const step of list) {
      // A hook has a location; `Before Hooks` and `After Hooks`, which hold them, have none.
      if (step.category === 'hook' && step.location) {
        walk(step.steps ?? [], blockHook(step, source), fixture);
        continue;
      }
      const opened = OPEN_STEPS[step.title];
      const closed = CLOSE_STEPS[step.title];
      if (step.category === 'pw:api' && !step.error && (opened || closed)) {
        const { location } = step;
        const site = location ? `${relativeFile(location.file)}:${location.line}` : null;
        const method = opened?.method ?? 'close';
        const key = location ? `${location.file}:${location.line}:${location.column}:${method}` : '';
        const nth = seen.get(key) ?? 0;
        seen.set(key, nth + 1);
        const names = namesAt(step, source, method, nth);
        const call = { site, block, fixture: fixture !== null, on: names.on };
        if (opened) calls.push({ op: 'open', kind: opened.kind, ...call, name: fixture ?? names.name });
        else calls.push({ op: 'close', kind: closed!, ...call, name: fixture });
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
 * `!.`), in the `nth` call of that method at or after the step's column, which
 * Playwright puts at the method or at the `await` before it, counted around
 * again for a call a loop repeats; and the name that call is assigned to. A
 * chain broken across lines is read with the two lines above.
 */
function namesAt(
  step: TestStep,
  source: SourceLines,
  method: string,
  nth: number,
): { on: string | null; name: string | null } {
  const location = step.location;
  const lines = location ? source(location.file) : null;
  const line = location ? lines?.[location.line - 1] : undefined;
  if (!location || !lines || line === undefined) return { on: null, name: null };
  const text = [...lines.slice(Math.max(0, location.line - 3), location.line - 1), line].join('\n');
  const column = text.length - line.length + location.column - 1;
  const calls = new RegExp(`([\\w$]+)\\s*[!?]?\\.\\s*${method}\\s*\\(`, 'g');
  const after = [...text.matchAll(calls)].filter((match) => match.index + match[0].lastIndexOf(method) >= column);
  // A loop comes back to the same calls.
  const match = after[nth % Math.max(1, after.length)];
  if (match) {
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

  const leaked: Leak[] = [];
  const lingering: Lingering[] = [];
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
          lastUse: null,
          series: [],
          mainCpu: [],
        });
      }
      for (const close of census.closed) {
        const entry = tracked.get(close.id);
        if (!entry) continue;
        entry.close = close;
        if (close.used !== undefined) entry.used = close.used;
        if (close.lastUse) entry.lastUse = close.lastUse;
      }
      for (const open of census.open) {
        const entry = tracked.get(open.id);
        if (!entry) continue;
        entry.lastOpenAt = census.at;
        if (open.used !== undefined) entry.used = open.used;
        if (open.lastUse) entry.lastUse = open.lastUse;
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
    const timedTests = timedFixtureTests(tracked.values());
    const testFixtures = input.testFixtures ?? new Map<string, string[]>();

    for (const entry of tracked.values()) {
      all.push(entry);
      if (entry.birth.kind === 'page' && entry.used === false && !entry.bornCensus.test?.failed) idle.push(entry);
      const verdict = leakVerdict(entry, testCensuses, workerEnded, timedTests, testFixtures);
      if (verdict) leaked.push({ tracked: entry, ...verdict });
      const tailMs = verdict ? null : lingerTail(entry);
      if (tailMs !== null) lingering.push({ tracked: entry, tailMs });
    }
  }

  const spans: ResourceSpan[] = [];
  findings.push(...groupLeaks(leaked, all, spans));
  findings.push(...pilingFindings(all));
  findings.push(...workerPilingFindings(byWorker));
  findings.push(...handleFindings(byWorker));
  findings.push(...groupIdle(idle, input.fixturesByTest ?? new Map()));
  findings.push(...groupLingering(lingering, all, spans));
  findings.push(...probableFindings(input.tallies ?? []));

  const counts = { leaked: 0, lingering: 0, idle: 0, piling: 0, handle: 0, probable: 0 };
  for (const finding of findings) counts[finding.verdict] += finding.verdict === 'idle' ? finding.count : 1;
  return { findings, counts, spans: spans.sort((a, b) => a.from - b.from) };
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

/** What a leak verdict says: the scope the object outlived, and from when to when it stayed open past it. */
interface LeakSpan {
  scope: 'test' | 'describe';
  /** When its scope ended. */
  from: number;
  /** When it closed, or its worker's last census. */
  to: number;
  heldMs: number;
  untilWorkerEnd: boolean;
}

type Leak = LeakSpan & { tracked: Tracked };
type Lingering = { tracked: Tracked; tailMs: number };

/** A fixture's identity within a worker: its title and location. */
const fixtureKey = (fixture: { title: string; location: string | null }) =>
  `${fixture.title}|${fixture.location ?? ''}`;

/**
 * The tests in which each fixture with a timeout of its own opened something,
 * per worker: a worker fixture is set up once per worker, so one that opened
 * objects in two tests of a worker is test-scoped.
 */
function timedFixtureTests(tracked: Iterable<Tracked>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const entry of tracked) {
    const fixture = entry.birth.fixture;
    if (!fixture?.timed || !entry.birth.test) continue;
    const key = fixtureKey(fixture);
    const tests = out.get(key) ?? new Set<string>();
    tests.add(entry.birth.test.id);
    out.set(key, tests);
  }
  return out;
}

/**
 * Whether an object a fixture with a timeout of its own opened is judged as a
 * test fixture's, which its timeout slot does not tell from a worker
 * fixture's: only when its test's `After Hooks` tore that fixture down
 * (`testFixtures`) or it opened objects in two tests of the worker, its own
 * teardown did not close it, and no later test used it.
 */
function judgedAsTestScoped(
  entry: Tracked,
  timedTests: Map<string, Set<string>>,
  testFixtures: Map<string, string[]>,
): boolean {
  const fixture = entry.birth.fixture;
  if (!fixture?.timed) return false;
  const key = fixtureKey(fixture);
  const tornDownWithTest = !!entry.birth.test && !!testFixtures.get(entry.birth.test.id)?.includes(key);
  if (!tornDownWithTest && (timedTests.get(key)?.size ?? 0) < 2) return false;
  const close = entry.close?.fixture;
  if (close && fixtureKey(close) === fixtureKey(fixture)) return false;
  return !(entry.lastUse?.test && entry.lastUse.test !== entry.birth.test?.id);
}

/** A context `browser.newPage()` opened for its page, or a browser `launchPersistentContext` opened for its context. */
function isImplicit(birth: ResourceBirth): boolean {
  return (birth.kind === 'context' || birth.kind === 'browser') && !!birth.implicit;
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
  timedTests: Map<string, Set<string>>,
  testFixtures: Map<string, string[]>,
): LeakSpan | null {
  const { birth, close, bornCensus } = entry;
  if (birth.reused || birth.phase === 'worker' || !birth.test || isImplicit(birth)) return null;
  if (birth.fixture?.worker && !judgedAsTestScoped(entry, timedTests, testFixtures)) return null;
  // `PIWI_LEAK_CHECK=close` closed it at the end of its test: gone from that census, still a leak.
  if (close?.byPiwi) return { scope: 'test', from: bornCensus.at, to: bornCensus.at, heldMs: 0, untilWorkerEnd: false };
  const closedByShutdown = !!close && (close.phase === 'worker' || close.test === null);

  if (birth.phase === 'beforeAll' || birth.phase === 'afterAll') {
    if (close && !closedByShutdown && sameFile(birth, close.test)) return null;
    // The block ended when a test outside it ran on this worker, or the worker shut down.
    const ended =
      workerEnded || testCensuses.some((census) => census.at >= bornCensus.at && !insideBlock(birth, census.test));
    if (!ended) return null;
    const lastInside = [...testCensuses].reverse().find((census) => insideBlock(birth, census.test));
    const blockEnd = lastInside?.at ?? bornCensus.at;
    const end = Math.max(blockEnd, close?.at ?? entry.lastOpenAt ?? blockEnd);
    return {
      scope: 'describe',
      from: blockEnd,
      to: end,
      heldMs: end - blockEnd,
      untilWorkerEnd: !close || closedByShutdown,
    };
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
  const end = Math.max(bornCensus.at, close?.at ?? entry.lastOpenAt ?? bornCensus.at);
  return {
    scope: 'test',
    from: bornCensus.at,
    to: end,
    heldMs: end - bornCensus.at,
    untilWorkerEnd: !close || closedByShutdown,
  };
}

/** How long an object must stay open after its last use, at least, and as a share of its test, to be lingering. */
export const LINGER_MIN_MS = 2000;
export const LINGER_SHARE = 1 / 3;

/** When an object's close began: before the work a close does first, else when it closed. */
function closeBegan(close: ResourceClose): number {
  return Math.min(close.at, close.closingAt ?? close.at);
}

/**
 * How long a browser, context or page the test body opened stayed open after
 * the test last used it, up to when its close began, when it closed within
 * that test (by the test, or a fixture tearing down) and that tail is both
 * `LINGER_MIN_MS` and `LINGER_SHARE` of the test; null otherwise. What a
 * fixture or a hook opens is theirs to close, an object that outlived its test
 * is a leak instead, and an API request context holds no browser while it
 * waits.
 */
function lingerTail(entry: Tracked): number | null {
  const { birth, close, lastUse, bornCensus } = entry;
  if (!birth.test || birth.fixture || birth.reused || isImplicit(birth) || birth.kind === 'request') return null;
  if (birth.phase !== 'test') return null;
  if (!close || close.byPiwi || close.phase === 'worker' || close.test?.id !== birth.test.id) return null;
  if (!lastUse || lastUse.at < birth.at) return null;
  const census = bornCensus;
  if (census.test?.id !== birth.test.id || census.test.failed) return null;
  const duration = Math.max(1, census.at - (census.startedAt ?? birth.at));
  const tail = closeBegan(close) - lastUse.at;
  return tail >= LINGER_MIN_MS && tail >= duration * LINGER_SHARE ? tail : null;
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

/** The test a span names: the one a census closed. */
function spanTest(census: ResourceCensus): ResourceSpan['test'] {
  return census.test ? { title: census.test.title ?? '', file: census.test.file } : null;
}

/** The last-use line most of a group's objects share, the latest one on a tie; null when none was used. */
function commonLastUse(uses: Array<ResourceUse | null>): string | null {
  const tally = new Map<string, { n: number; at: number }>();
  for (const use of uses) {
    if (!use?.site) continue;
    const seen = tally.get(use.site) ?? { n: 0, at: 0 };
    tally.set(use.site, { n: seen.n + 1, at: Math.max(seen.at, use.at) });
  }
  let best: [string, { n: number; at: number }] | null = null;
  for (const item of tally)
    if (!best || item[1].n > best[1].n || (item[1].n === best[1].n && item[1].at > best[1].at)) best = item;
  return best?.[0] ?? null;
}

/**
 * Group leaked objects by where they were opened. A page in a leaked context,
 * and a context in a leaked browser, are folded into it; the context
 * `browser.newPage()` opened for its page is folded into the page, and the
 * browser `launchPersistentContext` opened into its context. Each group's
 * objects become spans for the timeline.
 */
function groupLeaks(leaked: Leak[], all: Tracked[], spans: ResourceSpan[]): ResourceFinding[] {
  const leaks = new Map(leaked.map((leak) => [keyOf(leak.tracked.worker, leak.tracked.birth.id), leak]));
  const tracked = new Map(all.map((entry) => [keyOf(entry.worker, entry.birth.id), entry]));
  const groups = new Map<string, ResourceFinding & { testIds: Set<string>; uses: Array<ResourceUse | null> }>();
  const groupKey = (leak: Leak) => `${leak.scope}|${leak.tracked.birth.kind}|${whereOf(leak.tracked.birth)}`;
  // The outermost leaked ancestor a page folds into, through any number of folds.
  const rootOf = (leak: Leak): Leak => {
    let root = leak;
    for (let next = foldTarget(root.tracked, leaks, tracked); next; next = foldTarget(next.tracked, leaks, tracked)) {
      root = next;
    }
    return root;
  };
  const pagesByRoot = new Map<Leak, number>();
  for (const leak of leaked) {
    if (leak.tracked.birth.kind !== 'page') continue;
    const root = rootOf(leak);
    pagesByRoot.set(root, (pagesByRoot.get(root) ?? 0) + 1);
  }
  for (const leak of leaked) {
    const { birth } = leak.tracked;
    if (isImplicit(birth)) continue;
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
      uses: [],
      ...(leak.scope === 'describe' && birth.test?.suite.length
        ? { detail: `beforeAll of "${birth.test.suite.join(' › ')}"` }
        : {}),
    };
    group.count++;
    if (birth.test) group.testIds.add(birth.test.id);
    group.uses.push(leak.tracked.lastUse);
    group.heldMs = Math.max(group.heldMs ?? 0, leak.heldMs);
    group.untilWorkerEnd = group.untilWorkerEnd || leak.untilWorkerEnd;
    if (leak.tracked.close?.byPiwi) group.closedByPiwi = true;
    if (birth.kind === 'page' && leak.scope === 'test') addCpu(group, afterTestCpu(leak.tracked));
    groups.set(key, group);
    if (leak.to > leak.from) {
      spans.push({
        worker: leak.tracked.worker,
        verdict: 'leaked',
        kind: birth.kind,
        where: whereOf(birth),
        site: siteOf(birth),
        lastUse: leak.tracked.lastUse?.site ?? null,
        from: leak.from,
        to: leak.to,
        untilWorkerEnd: leak.untilWorkerEnd,
        scope: leak.scope,
        pages: birth.kind === 'page' ? 1 : (pagesByRoot.get(leak) ?? 0),
        test: spanTest(leak.tracked.bornCensus),
      });
    }
  }
  // Count the pages folded into each group, and what they used after their test.
  for (const leak of leaked) {
    if (leak.tracked.birth.kind !== 'page') continue;
    const root = rootOf(leak);
    const group = root !== leak ? groups.get(groupKey(root)) : undefined;
    if (!group) continue;
    group.pages = (group.pages ?? 0) + 1;
    if (root.scope === 'test') addCpu(group, afterTestCpu(leak.tracked));
  }
  return [...groups.values()]
    .map(({ testIds, uses, ...finding }) => {
      const lastUse = commonLastUse(uses);
      return { ...finding, tests: testIds.size, ...(lastUse ? { lastUse } : {}) };
    })
    .sort((a, b) => (a.scope === b.scope ? b.count - a.count : a.scope === 'test' ? -1 : 1));
}

/**
 * Group lingering objects by where they were opened. A page or a context that
 * lingered in a context or a browser that lingered too folds into the
 * outermost one, as a leaked one does.
 */
function groupLingering(lingering: Lingering[], all: Tracked[], spans: ResourceSpan[]): ResourceFinding[] {
  const byKey = new Map(lingering.map((item) => [keyOf(item.tracked.worker, item.tracked.birth.id), item]));
  const tracked = new Map(all.map((entry) => [keyOf(entry.worker, entry.birth.id), entry]));
  // The outermost lingering ancestor, walking through the objects opened for another.
  const rootOf = (item: Lingering): Lingering => {
    let root = item;
    for (let parentId = item.tracked.birth.parent; parentId !== null;) {
      const key = keyOf(item.tracked.worker, parentId);
      const parent = byKey.get(key);
      if (parent) root = parent;
      else if (!tracked.get(key) || !isImplicit(tracked.get(key)!.birth)) break;
      parentId = tracked.get(key)?.birth.parent ?? null;
    }
    return root;
  };
  const pages = new Map<Lingering, number>();
  for (const item of lingering) {
    const root = rootOf(item);
    if (item.tracked.birth.kind === 'page' && root !== item) pages.set(root, (pages.get(root) ?? 0) + 1);
  }
  const groups = new Map<string, ResourceFinding & { testIds: Set<string>; longest: Lingering }>();
  for (const item of lingering) {
    const { birth } = item.tracked;
    if (rootOf(item) !== item) continue;
    const where = whereOf(birth);
    const key = `${birth.kind}|${where}`;
    const group = groups.get(key) ?? {
      verdict: 'lingering' as const,
      kind: birth.kind,
      where,
      site: siteOf(birth),
      tests: 0,
      count: 0,
      heldMs: 0,
      testIds: new Set<string>(),
      longest: item,
    };
    group.count++;
    if (birth.test) group.testIds.add(birth.test.id);
    if (item.tailMs >= (group.heldMs ?? 0)) {
      group.heldMs = item.tailMs;
      group.longest = item;
    }
    const folded = pages.get(item) ?? 0;
    if (folded) group.pages = (group.pages ?? 0) + folded;
    groups.set(key, group);
    spans.push({
      worker: item.tracked.worker,
      verdict: 'lingering',
      kind: birth.kind,
      where,
      site: siteOf(birth),
      lastUse: item.tracked.lastUse?.site ?? null,
      from: closeBegan(item.tracked.close!) - item.tailMs,
      to: closeBegan(item.tracked.close!),
      untilWorkerEnd: false,
      scope: null,
      pages: birth.kind === 'page' ? 1 : folded,
      test: spanTest(item.tracked.bornCensus),
    });
  }
  return [...groups.values()]
    .map(({ testIds, longest, ...finding }) => {
      const lastUse = longest.tracked.lastUse?.site ?? null;
      return { ...finding, tests: testIds.size, ...(lastUse ? { lastUse } : {}) };
    })
    .sort((a, b) => (b.heldMs ?? 0) - (a.heldMs ?? 0));
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
    if (!isImplicit(parent.birth)) return leaks.get(key) ?? null;
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
 * by the open that gave it its name in this test or the file's `beforeAll` and
 * `afterAll` hooks, else by the name itself (`browser`, `adminBrowser`, not
 * `browserContext`).
 */
function ownsContext(on: string | null, boundTo: (name: string) => LifecycleCall['kind'] | undefined): boolean {
  if (!on) return false;
  const kind = boundTo(on);
  return kind ? kind === 'browser' : /browser/i.test(on) && !/context|ctx/i.test(on);
}

/**
 * The opens no close was paired with, in one worker's attempts of one spec
 * file, in the order they ran. A scope is an attempt with its `beforeEach` and
 * `afterEach` hooks, or the file's `beforeAll` and `afterAll` hooks.
 *
 * A test's close looks in its scope, then the `beforeAll` and `afterAll`
 * hooks', then the earlier attempts', which can only have handed it a counted
 * object. In each, it takes the latest open of the name it was called on, else
 * one with no name, a counted open first; failing those, any open of its scope.
 * A fixture's close takes what the fixture opened, else what its attempt opened
 * through it. A `Close browser` also closes the contexts and pages opened on its
 * browser's name since, and a `Close context` the pages of its context; with no
 * names to tell, those its scope opened since. What a fixture opened is closed
 * by the end of its attempt.
 */
function unpairedOpens(attempts: LifecycleTally[]): StepOpen[] {
  const opens: StepOpen[] = [];
  const latest = (test: (open: StepOpen) => boolean): StepOpen | undefined => {
    for (let i = opens.length - 1; i >= 0; i--) if (test(opens[i]!)) return opens[i];
    return undefined;
  };
  const pair = (call: LifecycleCall, scope: string): StepOpen | undefined => {
    const kinds: string[] = call.kind === 'browser' ? ['browser'] : ['context', 'page'];
    const free = (open: StepOpen) => !open.closed && kinds.includes(open.call.kind);
    if (call.fixture) {
      return (
        latest((o) => free(o) && o.call.fixture && o.call.name === call.name) ??
        latest((o) => free(o) && o.scope === scope && o.counted)
      );
    }
    const ranks: Array<(open: StepOpen) => boolean> = call.on
      ? [
          (o) => o.call.name === call.on && o.counted,
          (o) => o.call.name === call.on,
          (o) => o.call.name === null && o.counted,
          (o) => o.call.name === null,
        ]
      : [(o) => o.counted, () => true];
    const levels = [
      (o: StepOpen) => o.scope === scope,
      (o: StepOpen) => o.scope === 'block',
      (o: StepOpen) => o.counted,
    ];
    for (const level of levels) {
      for (const rank of ranks) {
        const open = latest((o) => free(o) && level(o) && rank(o));
        if (open) return open;
      }
    }
    return latest((o) => free(o) && o.scope === scope && o.counted) ?? latest((o) => free(o) && o.scope === scope);
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
      const open = pair(call, scope);
      if (!open) continue;
      open.closed = true;
      // What was opened in it: a browser's contexts and pages, a context's pages.
      const inside = open.call.kind === 'browser' ? ['context', 'page'] : open.call.kind === 'context' ? ['page'] : [];
      for (const later of opens.slice(opens.indexOf(open) + 1)) {
        if (!inside.includes(later.call.kind) || (open.call.kind === 'context' && later.counted)) continue;
        const named = open.call.name !== null && later.call.on !== null;
        if (named ? later.call.on === open.call.name : later.scope === open.scope) later.closed = true;
      }
    }
    for (const open of opens) if (open.tally === tally && open.call.fixture) open.closed = true;
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
  const verdict = finding.verdict.padEnd(9);
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
      if (finding.lastUse) parts.push(`last used at ${finding.lastUse}`);
      break;
    }
    case 'lingering':
      if (finding.count > 1) parts.push(`${finding.count} ${KIND_LABEL[finding.kind]}s`);
      if (finding.pages) parts.push(`with ${plural(finding.pages, 'page')}`);
      if (finding.tests) parts.push(plural(finding.tests, 'test'));
      parts.push(`open ${formatHeld(finding.heldMs ?? 0)} after its last use`);
      if (finding.lastUse) parts.push(`last used at ${finding.lastUse}`);
      break;
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
    counts.lingering ? `${counts.lingering} lingering` : '',
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
      'Probable leaks are read from the steps and the lines they point at, without API request contexts (their dispose() leaves no step); the capture fixtures (extendPiwiFixtures) make them exact.',
    );
  }
  return lines;
}
