import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { markRaw, reactive } from 'vue';
import type { HubSession, HubStop, HubWorker } from '@piwitests/core/run-hub';
import type { StopCode } from '@piwitests/editor/run-host';
import { CONTROLS } from '@piwitests/run-model/controls';
import {
  desktopArgsAttended,
  desktopHoldRefusal,
  desktopHoldsByDefault,
  desktopRowWorker,
  desktopHeldSessions,
  desktopRunHoldRefusal,
  desktopRunHolds,
  desktopRunOf,
  desktopRunRef,
  desktopSessionsOfRun,
  desktopEditorRunOf,
  desktopShownRefs,
  desktopStopLink,
} from '../../app/utils/desktop-run-view';
import {
  DESKTOP_RUN_ICONS,
  DESKTOP_TONE_COLORS,
  desktopCodeItem,
  desktopImagePoint,
  desktopLaneKey,
  desktopLiveInstance,
  desktopLiveText,
  desktopPickItem,
  desktopRunName,
  desktopSaidAround,
  desktopSay,
  desktopShareOffered,
  desktopShareWarning,
  desktopStopSharingQuestion,
  desktopWaitedFor,
  desktopStopSaid,
  isDesktopRunImage,
} from '@piwitests/run-ui/run-view';
import { desktopEditorRuns, isUnattendedDesktopRun } from '#shared/desktop-runs';
import { LIVE_SHARE_MISSING } from '@piwitests/core/live-view';

/**
 * The desktop window's view of the runs its shell starts: which run of the Local runs tray a hub session is, what a
 * worker says and takes, what a code made at a stop or a locator picked reads as to copy, and the window's stream:
 * opened while it is wanted, the runs and codes it hears, the frames to who watches alone, and the runs it shows live
 * and the lanes it watches said again on each new stream.
 */

const ROOT = '/home/dev/shop';
const VIEWER = 'a'.repeat(32);

function stopOf(over: Partial<HubStop> = {}): HubStop {
  return {
    reason: 'breakpoint',
    title: "Click getByRole('button', { name: 'Pay' })",
    uri: `file://${ROOT}/tests/checkout.spec.ts`,
    line: 4,
    character: 2,
    locator: "getByRole('button', { name: 'Pay' })",
    bar: false,
    since: 's1',
    intents: ['assert-region', 'mock', 'view', 'pick-at'],
    ...over,
  };
}

function workerOf(over: Partial<HubWorker> = {}): HubWorker {
  return {
    worker: 0,
    parallelIndex: 0,
    state: 'running',
    test: {
      id: 't',
      title: ['checkout', 'pays'],
      uri: `file://${ROOT}/tests/checkout.spec.ts`,
      line: 2,
      project: 'chromium',
      retry: 0,
      cannotPause: null,
    },
    stop: null,
    pausing: false,
    intents: ['assert-region', 'mock', 'view', 'input', 'pick-at'],
    ...over,
  };
}

function sessionOf(ref: string, workers: HubWorker[], over: Partial<HubSession> = {}): HubSession {
  return { ref, root: ROOT, label: 'shop', command: null, project: 'Shop', workers, ended: false, ...over };
}

describe('a worker of a desktop run', () => {
  test('is a run of the tray by the name its step gave the hub', () => {
    expect(desktopRunRef(7)).toBe('desktop-7');
    // A run nobody attends is the tray's run of the same step, its mark left out.
    expect(desktopRunOf('desktop-7-unattended')).toBe('desktop-7');
    expect(desktopRunOf('desktop-7')).toBe('desktop-7');
    expect(isUnattendedDesktopRun('desktop-7-unattended')).toBe(true);
    expect(isUnattendedDesktopRun('desktop-7')).toBe(false);
    expect(desktopRunName({ project: null, label: 'shop' })).toBe('shop');
    expect(desktopRunName({ project: 'Shop', label: 'shop' })).toBe('Shop');
    expect(desktopRunName({ project: null, label: null })).toBe('Run');
  });

  test('holds its failures only for a run a person attends, as the shell tells them apart, on for a reproduction', () => {
    const run = (kind: Parameters<typeof desktopHoldRefusal>[0]['kind'], ...steps: string[][]) => ({
      kind,
      steps: steps.map((args) => ({ args })),
    });
    // As `attended_args` in hub_env.rs reads them.
    expect(desktopArgsAttended([])).toBe(true);
    expect(desktopArgsAttended(['tests/a.spec.ts:3', '--project=chromium', '--headed', '--trace=on'])).toBe(true);
    expect(desktopArgsAttended(['--repeat-each=1'])).toBe(true);
    expect(desktopArgsAttended(['--repeat-each', '1'])).toBe(true);
    for (const args of [
      ['--ui'],
      ['--ui=true'],
      ['--repeat-each=20'],
      ['--repeat-each', '3'],
      ['--repeat-each=many'],
      ['--repeat-each=20', '--max-failures=2'],
      ['--repeat-each=20', '--max-failures'],
      ['--ui', '--repeat-each=20', '--max-failures=1'],
    ]) {
      expect(desktopArgsAttended(args), args.join(' ')).toBe(false);
    }
    // A repeated run that ends at its first failure is one a person can attend, whatever the order of its flags.
    for (const args of [
      ['--repeat-each=20', '--retries=0', '--max-failures=1'],
      ['--max-failures', '1', '--repeat-each', '5'],
    ]) {
      expect(desktopArgsAttended(args), args.join(' ')).toBe(true);
    }
    expect(desktopHoldRefusal(run('tests', ['tests/a.spec.ts:3']))).toBeNull();
    expect(desktopHoldRefusal(run('reproduce'))).toBeNull();
    expect(desktopHoldRefusal(run('repro', ['--headed']))).toBeNull();
    expect(desktopHoldRefusal(run('bisect'))).toBe('A bisect goes on past each failure.');
    expect(desktopHoldRefusal(run('flake', []))).toBe('A Flake Lab run goes on past each failure.');
    expect(desktopHoldRefusal(run('tests', ['--project=a'], ['--project=b', '--ui']))).toBe(
      'UI mode goes on past each failure.',
    );
    expect(desktopHoldRefusal(run('tests', ['--grep', 'pays', '--repeat-each=20', '--trace=on']))).toBe(
      'A run that repeats its tests goes on past each failure, unless it stops at the first one.',
    );
    expect(desktopHoldRefusal(run('repro', ['--repeat-each=5']))).toBe(
      'A run that repeats its tests goes on past each failure, unless it stops at the first one.',
    );
    // A reproduction runs to see its failure at its line: it holds from its start; every other run starts off.
    expect(desktopHoldsByDefault({ kind: 'reproduce' })).toBe(true);
    for (const kind of ['tests', 'repro', 'bisect', 'flake'] as const)
      expect(desktopHoldsByDefault({ kind })).toBe(false);
    // A run started with Hold failures on holds from its start.
    expect(desktopHoldsByDefault({ kind: 'tests', options: { holdFailures: true } })).toBe(true);
    expect(desktopHoldsByDefault({ kind: 'tests', options: { holdFailures: false } })).toBe(false);
    expect(
      desktopHoldRefusal(run('tests', ['--grep', 'pays', '--repeat-each=20', '--retries=0', '--max-failures=1'])),
    ).toBeNull();
  });

  test('is shown live while it runs with Hold failures on, by its steps’ names, whatever the tray shows', () => {
    const entry = (key: number, kind: 'tests' | 'reproduce' | 'bisect', hubRefs: string[], status = 'running') => ({
      key,
      kind,
      status,
      steps: [{ args: ['tests/a.spec.ts:3'] }],
      hubRefs,
    });
    const tests = entry(1, 'tests', ['desktop-3', 'desktop-4']);
    const reproduce = entry(2, 'reproduce', ['desktop-5']);
    const bisect = entry(3, 'bisect', ['desktop-6']);
    const done = entry(4, 'reproduce', ['desktop-2'], 'passed');
    const runs = [tests, reproduce, bisect, done];
    // A reproduction holds from its start; a run of tests once the person turns it on.
    expect(desktopShownRefs(runs, {}, [])).toEqual(['desktop-5']);
    expect(desktopShownRefs(runs, { 1: true, 2: false }, [])).toEqual(['desktop-3', 'desktop-4']);
    // A bisect never holds, whatever is chosen; a run that ended is shown no more.
    expect(desktopShownRefs(runs, { 3: true, 4: true }, [])).toEqual(['desktop-5']);
    expect(desktopRunHolds(bisect, true, [])).toBe(false);
    // The hub names a step nobody attends (a run repeating its tests): it holds nothing, and says why.
    const unattended = [sessionOf('desktop-4-unattended', [workerOf()])];
    expect(desktopRunHoldRefusal(tests, unattended)).toBe(
      'Nobody attends a run of this kind: it goes on past each failure.',
    );
    expect(desktopShownRefs(runs, { 1: true }, unattended)).toEqual(['desktop-5']);
    expect(desktopRunHoldRefusal(reproduce, unattended)).toBeNull();
    // Its switch shows the run's own Hold failures once a step is live, whoever set it; the shown runs stay the
    // person's choice.
    const agentOff = [sessionOf('desktop-5', [workerOf()], { hold: { on: false, by: 'agent' } })];
    expect(desktopRunHolds(reproduce, undefined, agentOff)).toBe(false);
    expect(desktopHeldSessions(reproduce, agentOff).map((s) => s.ref)).toEqual(['desktop-5']);
    expect(desktopShownRefs(runs, {}, agentOff)).toEqual(['desktop-5']);
    const pickerOn = [sessionOf('desktop-4', [workerOf()], { hold: { on: true, by: 'person' } })];
    expect(desktopRunHolds(tests, false, pickerOn)).toBe(true);
    expect(desktopHeldSessions(bisect, pickerOn)).toEqual([]);
  });

  test('says each stop it hears with its test and its place', () => {
    const session = sessionOf('desktop-7', []);
    expect(desktopStopSaid(session, workerOf(), stopOf({ reason: 'page-pause' }))).toBe(
      'checkout › pays stopped at tests/checkout.spec.ts:5.',
    );
    expect(desktopStopSaid(session, workerOf(), stopOf({ reason: 'failure' }))).toBe(
      'checkout › pays failed at tests/checkout.spec.ts:5.',
    );
    // Between tests, the run's name.
    expect(desktopStopSaid(session, workerOf({ test: null }), stopOf())).toBe(
      'Shop stopped at tests/checkout.spec.ts:5.',
    );
  });

  test('says how long the call a Pause waits in has run, in the run model’s words', () => {
    const waiting = {
      title: "Click getByRole('button', { name: 'Pay' })",
      uri: `file://${ROOT}/tests/checkout.spec.ts`,
      line: 3,
      since: '2026-11-05T10:00:00.000Z',
      endable: true,
    };
    const at = Date.parse(waiting.since);
    const pausing = workerOf({ pausing: true, waiting, intents: ['give-up'] });
    expect(desktopWaitedFor(pausing, at + 12_400)).toBe('for 12 s');
    expect(desktopWaitedFor(pausing, at + 125_000)).toBe('for 2 min 5 s');
    // A worker that cannot tell when the call began.
    expect(desktopWaitedFor(workerOf({ pausing: true, waiting: { ...waiting, since: null } }), at)).toBeNull();
    // No Pause waits, or the worker stopped: the call is not said.
    expect(desktopWaitedFor(workerOf({ waiting }), at + 12_400)).toBeNull();
    expect(desktopWaitedFor(workerOf({ pausing: true, waiting, state: 'stopped', stop: stopOf() }), at)).toBeNull();
  });
});

describe('the run model’s words, icons and tones in the window', () => {
  test('are said in English, a placeholder set apart where the window draws its value itself', () => {
    expect(desktopSay('runs_pageCaption')).toBe('The test’s page');
    expect(desktopSay('runs_worker', { number: '2' })).toBe('worker 2');
    expect(desktopSaidAround('runs_statePausingIn', 'call')).toEqual(['Pausing: waits in ', '']);
    expect(desktopSaidAround('runs_announceStopped', 'place', { test: 'pays' })).toEqual(['pays stopped at ', '.']);
  });

  test('map every icon of a worker’s state and of a control to one of the app’s own, by its meaning', () => {
    const icons = [...Object.values(CONTROLS).map((look) => look.icon), 'x-circle', 'pause', 'clock', 'play', 'dot'];
    for (const name of icons)
      expect(DESKTOP_RUN_ICONS[name as keyof typeof DESKTOP_RUN_ICONS], name).toMatch(/^i-lucide-/);
    // Each tone a color of the app's tokens, never one written here.
    for (const color of Object.values(DESKTOP_TONE_COLORS)) expect(color).toMatch(/^var\(--(?:ui|color-status)-/);
  });
});

describe('the lane of a worker', () => {
  test('is named by its run and its lane', () => {
    expect(desktopLaneKey('desktop-7', 1)).toBe('desktop-7|lane 1');
  });

  test('names a point of its image in CSS pixels of the page it shows', () => {
    const img = {
      getBoundingClientRect: () => ({ left: 10, top: 20 }) as DOMRect,
      clientLeft: 1,
      clientTop: 1,
      clientWidth: 400,
      clientHeight: 250,
    };
    expect(desktopImagePoint(img, { clientX: 211, clientY: 146 }, { width: 1280, height: 800 })).toEqual({
      x: 640,
      y: 400,
    });
    expect(desktopImagePoint({ ...img, clientWidth: 0 }, { clientX: 1, clientY: 1 }, { width: 1, height: 1 })).toBe(
      null,
    );
  });
});

describe('the worker of a running row of the run page', () => {
  // The row as the run's stream shows it: the test's own title, its spec relative to its config's folder and the
  // 1-based line of its `test(…)` call, and Playwright's worker index.
  const row = { status: 'running', title: 'pays', location: 'tests/checkout.spec.ts:3:7', workerIndex: 1 };
  const first = workerOf();
  const second = workerOf({
    worker: 1,
    parallelIndex: 1,
    test: { ...workerOf().test!, id: 't2', title: ['checkout', 'pays'] },
  });

  test('is the worker the row names, running the row’s test', () => {
    const session = sessionOf('desktop-7', [first, second]);
    expect(desktopRowWorker([session], row)).toEqual({ session, worker: second });
    // Among several runs, the one whose worker runs it: the same worker index of another run runs another test.
    const other = sessionOf('desktop-8', [{ ...second, test: { ...second.test!, title: ['cart', 'adds'] } }]);
    expect(desktopRowWorker([other, session], row)?.session).toBe(session);
  });

  test('is looked for in the live runs of the running Local runs entry that reports the run, each step’s', () => {
    const entry = (over: Record<string, unknown>) => ({
      kind: 'tests' as const,
      status: 'running',
      originRef: 'desktop:abc',
      piwiRunId: null,
      hubRefs: [] as string[],
      ...over,
    });
    const tests = entry({ hubRefs: ['desktop-7', 'desktop-9'], piwiRunId: 71 });
    const bisect = entry({ kind: 'bisect', originRef: '37', hubRefs: ['desktop-8'] });
    const reproduce = entry({ kind: 'reproduce', originRef: '37', hubRefs: ['desktop-6'] });
    const done = entry({ kind: 'reproduce', originRef: '37', status: 'passed', hubRefs: ['desktop-5'] });
    const live = ['desktop-5', 'desktop-6', 'desktop-7', 'desktop-8-unattended', 'desktop-9', 'desktop-10'].map((ref) =>
      sessionOf(ref, [first]),
    );
    const refsOf = (
      run: { id: number; kind: string; ref: string | null } | null,
      runs = [tests, bisect, reproduce, done],
    ) => desktopSessionsOfRun(run, runs, live).map((session) => session.ref);
    // A Re-run in two Playwright projects: the run of its second step too, which the entry is not linked to.
    expect(refsOf({ id: 72, kind: 'desktop', ref: 'desktop:abc' })).toEqual(['desktop-7', 'desktop-9']);
    // A bisect, a run nobody attends, and a reproduction of the same cluster, told apart by their kind; a finished
    // reproduction of it is left out.
    expect(refsOf({ id: 80, kind: 'bisect', ref: '37' })).toEqual(['desktop-8-unattended']);
    expect(refsOf({ id: 81, kind: 'reproduce', ref: '37' })).toEqual(['desktop-6']);
    // Two reproductions of one cluster at once: the one linked to the run alone, none until one is.
    const other = entry({ kind: 'reproduce', originRef: '37', hubRefs: ['desktop-10'] });
    expect(refsOf({ id: 81, kind: 'reproduce', ref: '37' }, [reproduce, other])).toEqual([]);
    expect(refsOf({ id: 81, kind: 'reproduce', ref: '37' }, [reproduce, { ...other, piwiRunId: 81 }])).toEqual([
      'desktop-10',
    ]);
    // A run of another origin, or one that names no reference: no run of the app's reports it.
    expect(refsOf({ id: 90, kind: 'desktop', ref: 'desktop:other' })).toEqual([]);
    expect(refsOf({ id: 91, kind: 'local', ref: null })).toEqual([]);
    expect(refsOf(null)).toEqual([]);
  });

  test('is none for a row that does not run, or whose worker runs another test now', () => {
    const session = sessionOf('desktop-7', [first, second]);
    expect(desktopRowWorker([session], { ...row, status: 'passed' })).toBeNull();
    expect(desktopRowWorker([session], { ...row, workerIndex: null })).toBeNull();
    expect(desktopRowWorker([session], { ...row, workerIndex: 4 })).toBeNull();
    // The worker went on to its next test before the row's end came: another title, line or spec.
    expect(desktopRowWorker([session], { ...row, title: 'refunds' })).toBeNull();
    expect(desktopRowWorker([session], { ...row, location: 'tests/checkout.spec.ts:9:7' })).toBeNull();
    expect(desktopRowWorker([session], { ...row, location: 'tests/cart.spec.ts:3:7' })).toBeNull();
    expect(desktopRowWorker([sessionOf('desktop-7', [{ ...second, test: null, state: 'between' }])], row)).toBeNull();
    expect(desktopRowWorker([], row)).toBeNull();
  });

  test('reads the spec of a run in any folder, a Windows one or one with spaces', () => {
    const at = (uri: string, location = row.location) =>
      desktopRowWorker([sessionOf('desktop-7', [{ ...second, test: { ...second.test!, uri } }])], { ...row, location });
    expect(at('file:///C:/Users/dev/shop/tests/checkout.spec.ts')).not.toBeNull();
    expect(at('file:///home/dev/shop/e2e/tests/checkout.spec.ts')).not.toBeNull();
    expect(at('file:///home/dev/my%20shop/tests/pay%20now.spec.ts', 'tests/pay now.spec.ts:3:7')).not.toBeNull();
    expect(at('file:///home/dev/shop/mytests/checkout.spec.ts')).toBeNull();
    // A spec outside the config's folder (`testDir: '../tests'`).
    expect(at('file:///home/dev/tests/checkout.spec.ts', '../tests/checkout.spec.ts:3:7')).not.toBeNull();
  });

  test('links a stop’s place inside the run’s folder, and shows any other as text', () => {
    expect(desktopStopLink(stopOf(), ROOT)).toEqual({ file: 'tests/checkout.spec.ts', line: 5 });
    // A page object outside the run's folder, or a run with no folder of its own (a worktree's).
    expect(desktopStopLink(stopOf({ uri: 'file:///home/dev/shared/cart.page.ts' }), ROOT)).toBeNull();
    expect(desktopStopLink(stopOf(), null)).toBeNull();
    expect(desktopStopLink(stopOf({ uri: 'file:///C:/dev/shop/tests/a.spec.ts' }), '/home/dev/shop')).toBeNull();
  });
});

describe('what the window gives to copy', () => {
  const code: StopCode = {
    ref: 'desktop-7',
    worker: 0,
    since: 's1',
    action: 'mock',
    uri: `file://${ROOT}/tests/checkout.spec.ts`,
    version: null,
    line: 4,
    code: "  await page.route('**/api/cart', (route) => route.fulfill({ json: { items: [] } }));",
    edits: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: "import { expect } from '@playwright/test';\n",
      },
      {
        range: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } },
        newText: "  await page.route('**/api/cart', (route) => route.fulfill({ json: { items: [] } }));\n",
      },
    ],
    message: 'Piwi made the mock to write above checkout.spec.ts:5.',
    warnings: ['The body holds an email address.'],
  };

  test('is a code block with the import lines its edits add apart, each placed in its run’s folder', () => {
    expect(desktopCodeItem(code, ROOT, 'k')).toEqual({
      key: 'k',
      title: 'Mock a request',
      place: 'tests/checkout.spec.ts:5',
      text: code.code,
      imports: ["import { expect } from '@playwright/test';"],
      kind: 'code',
      warnings: ['The body holds an email address.'],
    });
    // A run whose folder is not known any more: the whole path.
    expect(desktopCodeItem({ ...code, edits: [code.edits[1]!] }, null, 'k')).toMatchObject({
      place: `${ROOT}/tests/checkout.spec.ts:5`,
      imports: [],
    });
  });

  test('is the steps or the locator an agent made, said to be the agent’s, a locator for its line’s place', () => {
    const steps = {
      ...code,
      action: 'steps' as const,
      message: 'Piwi made the steps the agent took to write above checkout.spec.ts:5.',
    };
    expect(desktopCodeItem(steps, ROOT, 'k')).toMatchObject({ title: 'Steps the agent took', kind: 'code' });
    const locator: StopCode = {
      ...code,
      action: 'locator',
      code: "getByRole('button', { name: 'Pay now' })",
      edits: [
        {
          range: { start: { line: 4, character: 13 }, end: { line: 4, character: 46 } },
          newText: "getByRole('button', { name: 'Pay now' })",
        },
      ],
      warnings: [],
    };
    expect(desktopCodeItem(locator, ROOT, 'l')).toEqual({
      key: 'l',
      title: 'Locator the agent picked',
      place: 'tests/checkout.spec.ts:5',
      text: "getByRole('button', { name: 'Pay now' })",
      imports: [],
      kind: 'locator',
      warnings: [],
    });
  });

  test('is a locator picked, with its call’s place when the test named it', () => {
    expect(desktopPickItem({ locator: "getByRole('link')", file: 'tests/a.spec.ts', line: 3 }, 'p')).toMatchObject({
      title: 'Locator picked',
      place: 'tests/a.spec.ts:3',
      text: "getByRole('link')",
      kind: 'locator',
    });
    expect(desktopPickItem({ locator: 'x', file: null, line: null }, 'p').place).toBeNull();
  });

  test('takes an image only as base64, whatever sent it', () => {
    expect(isDesktopRunImage('/9j/AA==')).toBe(true);
    expect(isDesktopRunImage('" onerror="alert(1)')).toBe(false);
    expect(isDesktopRunImage('')).toBe(false);
    expect(isDesktopRunImage(4)).toBe(false);
  });
});

/** The window's EventSource, played by the test. */
class FakeSource {
  static CLOSED = 2;
  static last: FakeSource | null = null;
  readyState = 1;
  closed = false;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  close() {
    this.closed = true;
    this.readyState = FakeSource.CLOSED;
  }
  send(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe('the window’s stream of its runs', () => {
  const posted: Array<Record<string, unknown>> = [];
  const toasts: unknown[] = [];
  let answer: (body: Record<string, unknown>) => unknown = () => ({ type: 'answer', ok: true, message: '' });

  beforeEach(() => {
    posted.length = 0;
    toasts.length = 0;
    FakeSource.last = null;
    vi.stubGlobal('reactive', reactive);
    vi.stubGlobal('EventSource', FakeSource);
    vi.stubGlobal('useToast', () => ({ add: (toast: unknown) => toasts.push(toast) }));
    vi.stubGlobal('$fetch', async (url: string, init: { body: Record<string, unknown> }) => {
      expect(url).toBe('/api/desktop/runs/commands');
      posted.push(init.body);
      const result = answer(init.body);
      if (result instanceof Error) throw result;
      return { ...(result as object), id: init.body.id };
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  async function hub() {
    vi.resetModules();
    const { useDesktopRunHub } = await import('../../../../packages/run-ui/app/composables/useDesktopRunHub');
    return useDesktopRunHub();
  }

  /** The window's stream with the dashboard's Inspect as its host: Inspect opens with it, and what it heard reads. */
  async function inspectHub() {
    const runs = await hub();
    const { useDesktopLaneInspects } = await import('../../app/composables/useDesktopLaneInspects');
    const { reader, inspectOf } = useDesktopLaneInspects();
    const host = { ...reader, view: {}, title: '' };
    return {
      ...runs,
      setInspect: (ref: string, lane: number, on: boolean) => runs.setInspect(ref, lane, on ? host : null),
      inspectOf,
    };
  }

  test('opens while it is wanted, names its stream, and closes when it is not', async () => {
    const runs = await hub();
    expect(await runs.command({ type: 'subscribe' })).toMatchObject({ ok: false });
    expect(FakeSource.last).toBeNull();
    runs.want(true);
    const source = FakeSource.last!;
    expect(source.url).toBe('/api/desktop/runs/events');
    source.send({ type: 'hello', viewer: VIEWER });
    expect(runs.state.connected).toBe(true);
    source.send({ type: 'session', session: sessionOf('desktop-7', [workerOf()]) });
    expect(Object.keys(runs.state.sessions)).toEqual(['desktop-7']);
    runs.want(false);
    expect(source.closed).toBe(true);
    expect(runs.state.connected).toBe(false);
    expect(runs.state.sessions).toEqual({});
  });

  test('says which runs it shows live, again on each new stream, and names its stream in every command', async () => {
    const runs = await hub();
    runs.want(true);
    runs.show(['desktop-7']);
    // Not named yet: nothing goes until the stream is.
    expect(posted).toEqual([]);
    FakeSource.last!.send({ type: 'hello', viewer: VIEWER });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ type: 'show', ref: 'desktop-7', on: true, viewer: VIEWER });
    runs.show([]);
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ type: 'show', ref: 'desktop-7', on: false });
    runs.show(['desktop-8']);
    await vi.waitFor(() => expect(posted).toHaveLength(3));
    // A new stream: the run shown is said again on it.
    const other = 'b'.repeat(32);
    FakeSource.last!.send({ type: 'hello', viewer: other });
    await vi.waitFor(() => expect(posted).toHaveLength(4));
    expect(posted[3]).toMatchObject({ type: 'show', ref: 'desktop-8', on: true, viewer: other });
    const ids = posted.map((body) => body.id);
    expect(new Set(ids).size).toBe(ids.length);
    runs.want(false);
  });

  test('hears each stop once, as a worker comes to it, and drops a run that ended', async () => {
    const runs = await hub();
    const heard: string[] = [];
    const off = runs.onStop((session, worker) => heard.push(`${session.ref}:${worker.stop!.since}`));
    runs.want(true);
    const source = FakeSource.last!;
    source.send({ type: 'hello', viewer: VIEWER });
    const stopped = workerOf({ state: 'stopped', stop: stopOf() });
    source.send({ type: 'session', session: sessionOf('desktop-7', [stopped]) });
    source.send({ type: 'session', session: sessionOf('desktop-7', [stopped]) });
    source.send({
      type: 'session',
      session: sessionOf('desktop-7', [workerOf({ state: 'stopped', stop: stopOf({ since: 's2' }) })]),
    });
    expect(heard).toEqual(['desktop-7:s1', 'desktop-7:s2']);
    // The stream opens again: the runs come again, and a stop heard before is not heard again; a new one is.
    source.send({ type: 'hello', viewer: VIEWER });
    source.send({
      type: 'session',
      session: sessionOf('desktop-7', [workerOf({ state: 'stopped', stop: stopOf({ since: 's2' }) })]),
    });
    expect(heard).toEqual(['desktop-7:s1', 'desktop-7:s2']);
    source.send({
      type: 'session',
      session: sessionOf('desktop-7', [workerOf({ state: 'stopped', stop: stopOf({ since: 's3' }) })]),
    });
    expect(heard).toEqual(['desktop-7:s1', 'desktop-7:s2', 'desktop-7:s3']);
    source.send({ type: 'session', session: sessionOf('desktop-7', [], { ended: true }) });
    expect(runs.state.sessions).toEqual({});
    // Its folder stays known, for the place of its codes.
    expect(runs.state.roots['desktop-7']).toBe(ROOT);
    off();
    runs.want(false);
  });

  test('keeps Watch live for each worker through a new stream, until it is turned off or its run ends', async () => {
    const runs = await hub();
    runs.want(true);
    const source = FakeSource.last!;
    source.send({ type: 'hello', viewer: VIEWER });
    source.send({ type: 'session', session: sessionOf('desktop-7', [workerOf(), workerOf({ worker: 1 })]) });
    expect(runs.watchesLive('desktop-7', 0)).toBe(false);
    runs.setWatchLive('desktop-7', 0, true);
    runs.setWatchLive('desktop-7', 1, true);
    runs.setWatchLive('desktop-7', 1, false);
    expect([runs.watchesLive('desktop-7', 0), runs.watchesLive('desktop-7', 1)]).toEqual([true, false]);
    // The stream opens again: Watch live stays.
    source.send({ type: 'hello', viewer: VIEWER });
    expect(runs.watchesLive('desktop-7', 0)).toBe(true);
    source.send({ type: 'session', session: sessionOf('desktop-7', [], { ended: true }) });
    expect(runs.watchesLive('desktop-7', 0)).toBe(false);
    // The window stops listening: every run it showed is over, and so is their Watch live.
    runs.setWatchLive('desktop-8', 0, true);
    runs.want(false);
    expect(runs.watchesLive('desktop-8', 0)).toBe(false);
  });

  test('follows a run’s worker tabs as it hears it, the person’s choice and Resume there included', async () => {
    const runs = await hub();
    runs.want(true);
    const source = FakeSource.last!;
    source.send({ type: 'hello', viewer: VIEWER });
    const run = (...workers: HubWorker[]) => source.send({ type: 'session', session: sessionOf('desktop-7', workers) });
    const running = (w: number) => workerOf({ worker: w, parallelIndex: w });
    const stopped = (w: number, since: string) =>
      workerOf({ worker: w, parallelIndex: w, state: 'stopped', stop: stopOf({ since }) });
    run(running(0));
    expect(runs.tabsOf('desktop-7')).toBeNull();
    run(running(0), running(1));
    expect(runs.tabsOf('desktop-7')?.shown).toBe(0);
    // A stop takes the tab; the person's choice holds as long as no new stop comes.
    run(running(0), stopped(1, 's1'));
    expect(runs.tabsOf('desktop-7')?.shown).toBe(1);
    runs.chooseTab('desktop-7', 0);
    run(running(0), stopped(1, 's1'));
    expect(runs.tabsOf('desktop-7')?.shown).toBe(0);
    // A worker whose lane is watched keeps its tab when another stops; its Watch live, which shows nothing while it
    // runs, does not.
    runs.setWatchLive('desktop-7', 0, true);
    run(running(0), stopped(1, 's4'));
    expect(runs.tabsOf('desktop-7')?.shown).toBe(1);
    // Pausing with Watch live on, as Pause and watch leaves it where the lane cannot be watched, it keeps its tab.
    runs.chooseTab('desktop-7', 0);
    run({ ...running(0), pausing: true }, stopped(1, 's5'));
    expect(runs.tabsOf('desktop-7')?.shown).toBe(0);
    runs.setWatchLive('desktop-7', 0, false);
    runs.chooseTab('desktop-7', 0);
    await runs.setLaneWatch('desktop-7', 0, true);
    run(running(0), stopped(1, 's2'));
    expect(runs.tabsOf('desktop-7')?.shown).toBe(0);
    await runs.setLaneWatch('desktop-7', 0, false);
    // Resumed where it is shown, the next stopped test takes the tab once it goes on; elsewhere, nothing moves.
    run(stopped(0, 's3'), stopped(1, 's2'));
    runs.advanceTab('desktop-7', 1, 's3');
    expect(runs.tabsOf('desktop-7')?.advance).toBeNull();
    runs.advanceTab('desktop-7', 0, 's3');
    run(running(0), stopped(1, 's2'));
    expect(runs.tabsOf('desktop-7')).toEqual({ shown: 1, known: ['s2'], advance: null });
    // The run ends: its tabs go.
    source.send({ type: 'session', session: sessionOf('desktop-7', [], { ended: true }) });
    expect(runs.tabsOf('desktop-7')).toBeNull();
  });

  test('passes a frame to who watches its view alone, keeping the latest one until the last one leaves', async () => {
    const runs = await hub();
    runs.want(true);
    const source = FakeSource.last!;
    source.send({ type: 'hello', viewer: VIEWER });
    const frame = {
      type: 'frame',
      ref: 'desktop-7',
      worker: 0,
      since: 's1',
      width: 800,
      height: 600,
      data: '/9j/AA==',
    };
    // Nobody watches: it is kept nowhere.
    source.send(frame);
    const seen: unknown[] = [];
    const off = runs.onFrame('desktop-7', 0, 's1', (f) => seen.push(f));
    expect(seen).toEqual([]);
    source.send(frame);
    expect(seen).toHaveLength(1);
    source.send({ ...frame, since: 's2' });
    expect(seen).toHaveLength(1);
    // A second listener gets the latest one at once.
    const later: unknown[] = [];
    const offLater = runs.onFrame('desktop-7', 0, 's1', (f) => later.push(f));
    expect(later).toHaveLength(1);
    off();
    offLater();
    const again: unknown[] = [];
    runs.onFrame('desktop-7', 0, 's1', (f) => again.push(f))();
    expect(again).toEqual([]);
    runs.want(false);
  });

  /** What the window told the server of the lanes it shows, in order. */
  function lanesSaid() {
    return posted.filter((body) => body.type === 'watch').map(({ ref, lane, on }) => ({ ref, lane, on }));
  }

  test('says a lane watched while a listener shows it, none while hidden, and again on each new stream', async () => {
    const changed: Array<() => void> = [];
    const page = {
      hidden: false,
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'visibilitychange') changed.push(listener);
      },
    };
    vi.stubGlobal('document', page);
    const runs = await hub();
    runs.want(true);
    const source = FakeSource.last!;
    source.send({ type: 'hello', viewer: VIEWER });
    expect(await runs.setLaneWatch('desktop-7', 0, true)).toEqual({ ok: true, message: '' });
    expect(runs.watchesLane('desktop-7', 0)).toBe(true);
    // Watched, but shown nowhere: the server hears nothing.
    expect(lanesSaid()).toEqual([]);
    const off = runs.onLaneFrame('desktop-7', 0, () => {});
    await vi.waitFor(() => expect(lanesSaid()).toEqual([{ ref: 'desktop-7', lane: 0, on: true }]));

    // Hidden, the window shows no lane; shown again, it says it again.
    page.hidden = true;
    for (const listener of changed) listener();
    await vi.waitFor(() => expect(lanesSaid()).toHaveLength(2));
    expect(lanesSaid()[1]).toEqual({ ref: 'desktop-7', lane: 0, on: false });
    page.hidden = false;
    for (const listener of changed) listener();
    await vi.waitFor(() => expect(lanesSaid()).toHaveLength(3));
    expect(lanesSaid()[2]).toEqual({ ref: 'desktop-7', lane: 0, on: true });

    // A new stream: the lane is said again on it.
    const other = 'b'.repeat(32);
    source.send({ type: 'hello', viewer: other });
    await vi.waitFor(() => expect(lanesSaid()).toHaveLength(4));
    expect(posted.at(-1)).toMatchObject({ type: 'watch', ref: 'desktop-7', lane: 0, on: true, viewer: other });

    // A listener that leaves as another comes, in one tick, changes nothing; the last one to leave stops the lane.
    off();
    const again = runs.onLaneFrame('desktop-7', 0, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lanesSaid()).toHaveLength(4);
    again();
    await vi.waitFor(() => expect(lanesSaid()).toHaveLength(5));
    expect(lanesSaid()[4]).toEqual({ ref: 'desktop-7', lane: 0, on: false });
    runs.want(false);
    expect(runs.watchesLane('desktop-7', 0)).toBe(false);
  });

  test('has the server read a lane’s pages for Inspect while a view shows it, again on each stream, until the lane’s watch ends', async () => {
    const notice = (call: string) => ({
      type: 'snapshot',
      shard: null,
      worker: 0,
      call,
      title: `Click ${call}`,
      phase: 'after',
      page: 'page@1',
      frame: 'frame@1',
      main: true,
      full: true,
      index: 0,
      at: 1_800_000_000_000,
      test: 'checkout › pays',
    });
    const listed: unknown[] = [];
    vi.stubGlobal('markRaw', markRaw);
    vi.stubGlobal('$fetch', async (url: string, init: { body?: Record<string, unknown>; query?: unknown }) => {
      if (url === '/api/desktop/runs/inspect/calls') {
        listed.push(init.query);
        return { attempt: 't#0', heard: [notice('call@1')], refused: null };
      }
      posted.push(init.body!);
      return { type: 'answer', ok: true, message: '', id: init.body!.id };
    });
    const runs = await inspectHub();
    runs.want(true);
    const source = FakeSource.last!;
    source.send({ type: 'hello', viewer: VIEWER });
    await runs.setLaneWatch('desktop-7', 0, true);
    const said = () =>
      posted.filter((body) => body.type === 'inspect').map(({ ref, lane, on, viewer }) => ({ ref, lane, on, viewer }));

    // Open, but shown nowhere: the server hears nothing.
    expect(await runs.setInspect('desktop-7', 0, true)).toEqual({ ok: true, message: '' });
    expect(runs.inspectOf('desktop-7', 0)).toMatchObject({ attempt: null, heard: [] });
    expect(said()).toEqual([]);
    // A view shows it: the server reads the lane's pages, and what it read so far comes, then each one it says.
    runs.showInspect('desktop-7', 0);
    await vi.waitFor(() => expect(said()).toEqual([{ ref: 'desktop-7', lane: 0, on: true, viewer: VIEWER }]));
    await vi.waitFor(() => expect(runs.inspectOf('desktop-7', 0)?.heard).toHaveLength(1));
    expect(listed).toEqual([{ viewer: VIEWER, ref: 'desktop-7', lane: 0 }]);
    source.send({ type: 'inspect', ref: 'desktop-7', lane: 0, attempt: 't#0', snapshot: notice('call@2') });
    expect(runs.inspectOf('desktop-7', 0)!.heard.map((h) => h.call)).toEqual(['call@1', 'call@2']);
    // Another lane's, or one of a lane not open, changes nothing.
    source.send({ type: 'inspect', ref: 'desktop-7', lane: 1, attempt: 't#0', snapshot: notice('call@9') });
    expect(runs.inspectOf('desktop-7', 1)).toBeNull();

    // A view that leaves as another comes, in one tick, changes nothing.
    const views = [runs.showInspect('desktop-7', 0)];
    views.push(runs.showInspect('desktop-7', 0));
    views.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(said()).toHaveLength(1);

    // A new stream: the server is told again on it, and what it reads again replaces what the view held of the test,
    // the view staying on it.
    const turn = runs.inspectOf('desktop-7', 0)!.turn;
    const other = 'b'.repeat(32);
    source.send({ type: 'hello', viewer: other });
    await vi.waitFor(() => expect(said()).toHaveLength(2));
    expect(said()[1]).toEqual({ ref: 'desktop-7', lane: 0, on: true, viewer: other });
    await vi.waitFor(() => expect(listed).toHaveLength(2));
    await vi.waitFor(() => expect(runs.inspectOf('desktop-7', 0)!.heard.map((h) => h.call)).toEqual(['call@1']));
    expect(runs.inspectOf('desktop-7', 0)).toMatchObject({ turn, attempt: 't#0' });

    // The lane's watch off closes it.
    await runs.setLaneWatch('desktop-7', 0, false);
    await vi.waitFor(() => expect(said()).toHaveLength(3));
    expect(said()[2]).toMatchObject({ ref: 'desktop-7', lane: 0, on: false });
    expect(runs.inspectOf('desktop-7', 0)).toBeNull();
    runs.want(false);
  });

  test('tells the server Inspect is off while the window is hidden, the view kept, and says why a new stream refuses it', async () => {
    const changed: Array<() => void> = [];
    const page = {
      hidden: false,
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'visibilitychange') changed.push(listener);
      },
    };
    vi.stubGlobal('document', page);
    const notice = (call: string, at: number) => ({
      type: 'snapshot',
      shard: null,
      worker: 0,
      call,
      title: `Click ${call}`,
      phase: 'after',
      page: 'page@1',
      frame: 'frame@1',
      main: true,
      full: false,
      index: at,
      at: 1_800_000_000_000 + at,
      test: 'checkout › pays',
    });
    let listing = { attempt: 't#0', heard: [notice('call@1', 1)], refused: null as string | null };
    let refusal: string | null = null;
    vi.stubGlobal('markRaw', markRaw);
    vi.stubGlobal('$fetch', async (url: string, init: { body?: Record<string, unknown> }) => {
      if (url === '/api/desktop/runs/inspect/calls') return listing;
      posted.push(init.body!);
      const refused = init.body!.type === 'inspect' && init.body!.on && refusal;
      return { type: 'answer', ok: !refused, message: refused || '', id: init.body!.id };
    });
    const runs = await inspectHub();
    runs.want(true);
    const source = FakeSource.last!;
    source.send({ type: 'hello', viewer: VIEWER });
    await runs.setLaneWatch('desktop-7', 0, true);
    const said = () => posted.filter((body) => body.type === 'inspect').map(({ on }) => on);
    await runs.setInspect('desktop-7', 0, true);
    runs.showInspect('desktop-7', 0);
    await vi.waitFor(() => expect(runs.inspectOf('desktop-7', 0)?.heard).toHaveLength(1));
    source.send({ type: 'inspect', ref: 'desktop-7', lane: 0, attempt: 't#0', snapshot: notice('call@2', 2) });
    const turn = runs.inspectOf('desktop-7', 0)!.turn;

    // Hidden: the server reads no page meanwhile, and the view keeps what it heard.
    page.hidden = true;
    for (const listener of changed) listener();
    await vi.waitFor(() => expect(said()).toEqual([true, false]));
    expect(runs.inspectOf('desktop-7', 0)).toMatchObject({ turn, attempt: 't#0' });
    expect(runs.inspectOf('desktop-7', 0)!.heard.map((h) => h.call)).toEqual(['call@1', 'call@2']);
    // Shown again: the server reads again, and what it read since joins the view, which stays on the test.
    listing = { ...listing, heard: [notice('call@2', 2), notice('call@3', 3)] };
    page.hidden = false;
    for (const listener of changed) listener();
    await vi.waitFor(() => expect(said()).toEqual([true, false, true]));
    await vi.waitFor(() =>
      expect(runs.inspectOf('desktop-7', 0)!.heard.map((h) => h.call)).toEqual(['call@2', 'call@3']),
    );
    expect(runs.inspectOf('desktop-7', 0)!.turn).toBe(turn);
    expect(runs.inspectRefusalOf('desktop-7', 0)).toBeNull();

    // A new stream the server refuses Inspect on: it closes, saying why, as a refused click does.
    refusal = 'Inspect is open on 16 lanes already: close one first.';
    source.send({ type: 'hello', viewer: 'b'.repeat(32) });
    await vi.waitFor(() => expect(runs.inspectOf('desktop-7', 0)).toBeNull());
    expect(runs.inspectRefusalOf('desktop-7', 0)).toMatchObject({ message: refusal });
    // A click refused the same way says it again.
    const first = runs.inspectRefusalOf('desktop-7', 0);
    expect(await runs.setInspect('desktop-7', 0, true)).toMatchObject({ ok: false, message: refusal });
    expect(runs.inspectRefusalOf('desktop-7', 0)).toMatchObject({ message: refusal });
    expect(runs.inspectRefusalOf('desktop-7', 0)).not.toBe(first);
    runs.want(false);
  });

  test('passes a lane’s frames to who listens, keeping the latest image while the lane is watched', async () => {
    const runs = await hub();
    runs.want(true);
    const source = FakeSource.last!;
    source.send({ type: 'hello', viewer: VIEWER });
    source.send({ type: 'session', session: sessionOf('desktop-7', [workerOf({ intents: ['view', 'watch'] })]) });
    const frame = {
      type: 'lane-frame',
      ref: 'desktop-7',
      lane: 0,
      worker: 0,
      test: 't',
      since: null,
      width: 800,
      height: 600,
      data: '/9j/AA==',
    };
    // Not watched: it is kept nowhere.
    source.send(frame);
    await runs.setLaneWatch('desktop-7', 0, true);
    const seen: unknown[] = [];
    const off = runs.onLaneFrame('desktop-7', 0, (f) => seen.push(f));
    expect(seen).toEqual([]);
    source.send(frame);
    // Another lane's, not watched, goes to nobody.
    source.send({ ...frame, lane: 1, data: '/9j/AB==' });
    const { type: _type, ...heard } = frame;
    expect(seen).toEqual([heard]);
    // Why none comes goes to the listener, and is not kept in place of the image.
    const refused = {
      type: 'lane-frame',
      ref: 'desktop-7',
      lane: 0,
      worker: 0,
      test: 't',
      since: null,
      refused: 'Too long.',
    };
    source.send(refused);
    expect(seen).toHaveLength(2);
    off();
    // A listener that comes later, as the tray opens again, gets the latest image at once.
    const later: unknown[] = [];
    const offLater = runs.onLaneFrame('desktop-7', 0, (f) => later.push(f));
    expect(later).toEqual([expect.objectContaining({ data: '/9j/AA==' })]);
    offLater();
    // The run ends: its lanes are watched no more, and their images go.
    source.send({ type: 'session', session: sessionOf('desktop-7', [], { ended: true }) });
    expect(runs.watchesLane('desktop-7', 0)).toBe(false);
    const after: unknown[] = [];
    runs.onLaneFrame('desktop-7', 0, (f) => after.push(f))();
    expect(after).toEqual([]);
    runs.want(false);
  });

  test('watches no more a lane the hub would not show, and says why until it is asked again', async () => {
    answer = (body) =>
      body.type === 'watch' && body.on
        ? {
            type: 'answer',
            ok: false,
            message: 'Update the reporter to watch a running test: this one shows a stopped test alone.',
          }
        : { type: 'answer', ok: true, message: '' };
    const runs = await hub();
    runs.want(true);
    FakeSource.last!.send({ type: 'hello', viewer: VIEWER });
    runs.onLaneFrame('desktop-7', 0, () => {});
    const said = await runs.setLaneWatch('desktop-7', 0, true);
    expect(said).toMatchObject({ ok: false, message: expect.stringMatching(/^Update the reporter/) });
    expect(runs.watchesLane('desktop-7', 0)).toBe(false);
    expect(runs.state.laneRefusals['desktop-7|lane 0']).toMatch(/^Update the reporter/);
    answer = () => ({ type: 'answer', ok: true, message: '' });
    expect(await runs.setLaneWatch('desktop-7', 0, true)).toMatchObject({ ok: true });
    expect(runs.state.laneRefusals['desktop-7|lane 0']).toBeUndefined();
    expect(runs.watchesLane('desktop-7', 0)).toBe(true);
    runs.want(false);
  });

  test('numbers each view of a lane: a frame heard before the lane is shown again, the one kept included, is older', async () => {
    const changed: Array<() => void> = [];
    const page = {
      hidden: false,
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'visibilitychange') changed.push(listener);
      },
    };
    vi.stubGlobal('document', page);
    const runs = await hub();
    runs.want(true);
    const source = FakeSource.last!;
    source.send({ type: 'hello', viewer: VIEWER });
    await runs.setLaneWatch('desktop-7', 0, true);
    const views: number[] = [];
    const off = runs.onLaneFrame('desktop-7', 0, (_frame, view) => views.push(view));
    await vi.waitFor(() => expect(lanesSaid()).toHaveLength(1));
    expect(runs.laneView('desktop-7', 0)).toBe(1);
    const frame = {
      type: 'lane-frame',
      ref: 'desktop-7',
      lane: 0,
      worker: 0,
      test: 't',
      since: null,
      width: 800,
      height: 600,
      data: '/9j/AA==',
    };
    source.send(frame);
    expect(views).toEqual([1]);

    // Hidden, then shown again: the lane is shown in a new view, and the frame from before belongs to the one before.
    page.hidden = true;
    for (const listener of changed) listener();
    await vi.waitFor(() => expect(lanesSaid()).toHaveLength(2));
    page.hidden = false;
    for (const listener of changed) listener();
    await vi.waitFor(() => expect(lanesSaid()).toHaveLength(3));
    expect(runs.laneView('desktop-7', 0)).toBe(2);
    off();
    // The tray opens again: the kept frame comes at once, of the view it was heard in.
    const kept: number[] = [];
    const again = runs.onLaneFrame('desktop-7', 0, (_frame, view) => kept.push(view));
    expect(kept).toEqual([1]);
    source.send(frame);
    expect(kept).toEqual([1, 2]);
    again();
    runs.want(false);
  });

  test('keeps a lane watched when its command never reached the hub, and says it again on the next stream', async () => {
    answer = (body) => (body.type === 'watch' ? new Error('fetch failed') : { type: 'answer', ok: true, message: '' });
    const runs = await hub();
    runs.want(true);
    const source = FakeSource.last!;
    source.send({ type: 'hello', viewer: VIEWER });
    runs.onLaneFrame('desktop-7', 0, () => {});
    const said = await runs.setLaneWatch('desktop-7', 0, true);
    expect(said).toMatchObject({ ok: false });
    // No refusal of the hub: the lane stays watched, and no reason shows.
    expect(runs.watchesLane('desktop-7', 0)).toBe(true);
    expect(runs.state.laneRefusals).toEqual({});
    answer = () => ({ type: 'answer', ok: true, message: '' });
    const before = lanesSaid().length;
    source.send({ type: 'hello', viewer: 'b'.repeat(32) });
    await vi.waitFor(() => expect(lanesSaid()).toHaveLength(before + 1));
    expect(posted.at(-1)).toMatchObject({ type: 'watch', ref: 'desktop-7', lane: 0, on: true, viewer: 'b'.repeat(32) });
    runs.want(false);
  });

  test('forgets what it kept of a run once it ends, or once a new stream does not list it', async () => {
    answer = (body) =>
      body.type === 'watch' && body.ref === 'desktop-8'
        ? { type: 'answer', ok: false, message: 'This run has no worker 1 to watch.' }
        : { type: 'answer', ok: true, message: '' };
    const runs = await hub();
    runs.want(true);
    const source = FakeSource.last!;
    source.send({ type: 'hello', viewer: VIEWER });
    source.send({ type: 'session', session: sessionOf('desktop-7', [workerOf()]) });
    source.send({ type: 'session', session: sessionOf('desktop-8', [workerOf()]) });
    runs.onLaneFrame('desktop-8', 0, () => {});
    await runs.setLaneWatch('desktop-8', 0, true);
    expect(runs.state.laneRefusals['desktop-8|lane 0']).toBe('This run has no worker 1 to watch.');
    // A run that ends: its refusal goes with it.
    source.send({ type: 'session', session: sessionOf('desktop-8', [], { ended: true }) });
    expect(runs.state.laneRefusals).toEqual({});

    answer = () => ({ type: 'answer', ok: true, message: '' });
    await runs.setLaneWatch('desktop-7', 0, true);
    runs.setWatchLive('desktop-7', 0, true);
    const off = runs.onLaneFrame('desktop-7', 0, () => {});
    source.send({
      type: 'lane-frame',
      ref: 'desktop-7',
      lane: 0,
      worker: 0,
      test: 't',
      since: null,
      width: 800,
      height: 600,
      data: '/9j/AA==',
    });
    off();
    // A new stream lists every run live but desktop-7, which ended while the stream was down: what was kept of it goes.
    source.send({ type: 'hello', viewer: VIEWER });
    source.send({ type: 'session', session: sessionOf('desktop-9', [workerOf()]) });
    expect(runs.watchesLane('desktop-7', 0)).toBe(true);
    source.send({ type: 'listed' });
    expect(runs.watchesLane('desktop-7', 0)).toBe(false);
    expect(runs.watchesLive('desktop-7', 0)).toBe(false);
    expect(runs.laneView('desktop-7', 0)).toBe(0);
    const kept: unknown[] = [];
    runs.onLaneFrame('desktop-7', 0, (f) => kept.push(f))();
    expect(kept).toEqual([]);
    runs.want(false);
  });

  test('keeps the codes and the picks to copy, the latest twenty, and what a code came to by worker', async () => {
    const runs = await hub();
    runs.want(true);
    const source = FakeSource.last!;
    source.send({ type: 'hello', viewer: VIEWER });
    for (let i = 0; i < 25; i++) source.send({ type: 'pick', pick: { locator: `l${i}`, file: null, line: null } });
    source.send({ type: 'pick', pick: { locator: 4 } });
    expect(runs.state.kept).toHaveLength(20);
    expect(runs.state.kept.at(-1)).toMatchObject({ type: 'pick', pick: { locator: 'l24' } });
    source.send({
      type: 'code',
      ref: 'desktop-7',
      worker: 0,
      since: 's1',
      action: 'mock',
      ok: true,
      message: "Piwi made the mock to write above checkout.spec.ts:5: copy it in the desktop app's window.",
    });
    expect(runs.state.outcomes['desktop-7|0']).toMatchObject({ since: 's1', ok: true });
    source.send({ type: 'notice', root: null, severity: 'warning', message: 'The stop went on.' });
    expect(toasts).toEqual([expect.objectContaining({ description: 'The stop went on.', color: 'warning' })]);
    // A new stream sends the kept ones again: the window keeps them once.
    source.send({ type: 'hello', viewer: VIEWER });
    expect(runs.state.kept).toEqual([]);
    runs.want(false);
  });

  test('answers a command the server refused with its reason', async () => {
    const runs = await hub();
    runs.want(true);
    FakeSource.last!.send({ type: 'hello', viewer: VIEWER });
    answer = () => Object.assign(new Error('x'), { data: { message: 'The run stream is not open' } });
    expect(
      await runs.command({ type: 'runControl', ref: 'desktop-7', worker: 0, action: 'resume', since: 's1' }),
    ).toEqual({
      ok: false,
      message: 'The run stream is not open',
    });
    answer = () => ({ type: 'answer', ok: true, message: '' });
    runs.want(false);
  });
});

describe('Share live in the window', () => {
  const live = {
    shared: true,
    refused: null,
    stopped: null,
    page: 'https://piwi.example.com/test-runs/42',
    viewers: 0,
  };

  test('names the instance a run is shared on, and how many views of it are open there', () => {
    expect(desktopLiveInstance(live)).toBe('piwi.example.com');
    expect(desktopLiveInstance({ page: null })).toBeNull();
    expect(desktopLiveText(live)).toBe('Shared live on piwi.example.com · nobody watches yet');
    expect(desktopLiveText({ ...live, viewers: 1 })).toBe('Shared live on piwi.example.com · 1 view open');
    expect(desktopLiveText({ ...live, viewers: 3, page: null })).toBe('Shared live · 3 views open');
  });

  test('says what goes out, and to whom, before the first share', () => {
    const warning = desktopShareWarning(live);
    expect(warning).toMatch(/^While this run is shared on piwi\.example\.com, anyone with its page open there /);
    // Its stops show to whoever has the run page open, watched or not; the images only while someone watches.
    expect(warning).toContain("each stop of its tests: the call, its file and line, and the test's title, even while");
    expect(warning).toContain("images of its test's page go there too, each with its call and the test's title");
    expect(warning).toContain('on an instance with authentication off, anyone who can reach it');
    expect(warning).toMatch(/Stop sharing ends it within seconds\.$/);
    expect(desktopShareWarning({ page: null })).toContain('the Piwi instance this run reports to');
  });

  test('asks before Stop sharing: what closes on the instance, and that nothing more of the run goes there', () => {
    const page = { id: 42, url: 'https://piwi.example.com/test-runs/42' };
    expect(desktopStopSharingQuestion({ page, live })).toEqual({
      title: 'Stop sharing run #42 live?',
      body: 'Nothing more of it goes to piwi.example.com.',
    });
    expect(desktopStopSharingQuestion({ page, live: { ...live, viewers: 1 } }).body).toBe(
      'The view open on piwi.example.com closes, and nothing more of the run goes there.',
    );
    expect(desktopStopSharingQuestion({ page, live: { ...live, viewers: 3 } }).body).toBe(
      'The 3 views open on piwi.example.com close, and nothing more of the run goes there.',
    );
    // Before its process named its page, the run has no number, and an instance named by no page is the team's.
    expect(desktopStopSharingQuestion({ live: { ...live, page: null, viewers: 2 } })).toEqual({
      title: 'Stop sharing the run live?',
      body: 'The 2 views open on the team instance close, and nothing more of the run goes there.',
    });
  });

  test('offers no Share live for a run that reports to this app, which no teammate reaches', () => {
    expect(desktopShareOffered(live)).toBe(true);
    expect(desktopShareOffered({ refused: LIVE_SHARE_MISSING.off })).toBe(true);
    expect(desktopShareOffered({ refused: LIVE_SHARE_MISSING.local })).toBe(false);
    expect(desktopShareOffered(null)).toBe(false);
  });
});

describe('an editor’s run on the run page', () => {
  const ORIGIN = 'http://127.0.0.1:3000';
  const session = (page: { id: number; url: string } | undefined, ended = false) => ({ page, ended });

  test('is the page’s run when its page is that run on this app’s own server', () => {
    expect(desktopEditorRunOf(session({ id: 77, url: `${ORIGIN}/test-runs/77` }), 77, ORIGIN)).toBe(true);
    // The same server under another name of the loopback interface; not another port.
    expect(desktopEditorRunOf(session({ id: 77, url: 'http://localhost:3000/test-runs/77' }), 77, ORIGIN)).toBe(true);
    expect(desktopEditorRunOf(session({ id: 77, url: 'http://localhost:3001/test-runs/77' }), 77, ORIGIN)).toBe(false);
    // A run of the same number on the team instance, another run, an ended one, or one with no page yet.
    expect(desktopEditorRunOf(session({ id: 77, url: 'https://piwi.example.com/test-runs/77' }), 77, ORIGIN)).toBe(
      false,
    );
    expect(desktopEditorRunOf(session({ id: 78, url: `${ORIGIN}/test-runs/78` }), 77, ORIGIN)).toBe(false);
    expect(desktopEditorRunOf(session({ id: 77, url: `${ORIGIN}/test-runs/77` }, true), 77, ORIGIN)).toBe(false);
    expect(desktopEditorRunOf(session(undefined), 77, ORIGIN)).toBe(false);
  });

  test('reads from the server’s message only what reads as a run', () => {
    const run = { client: 'WebStorm', session: { ref: 'ed-1', workers: [] } };
    expect(desktopEditorRuns([run, { client: 3, session: { ref: 'x', workers: [] } }, { client: null }, null])).toEqual(
      [run],
    );
    expect(desktopEditorRuns('runs')).toEqual([]);
  });
});
