import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { reactive } from 'vue';
import type { HubSession, HubStop, HubWorker } from '@piwitests/core/run-hub';
import type { StopCode } from '@piwitests/editor/run-host';
import {
  desktopArgsAttended,
  desktopCodeActions,
  desktopCodeItem,
  desktopHoldRefusal,
  desktopHoldsByDefault,
  desktopLiveInstance,
  desktopLiveText,
  desktopPickItem,
  desktopRunName,
  desktopRunOf,
  desktopRunRef,
  desktopShareOffered,
  desktopShareWarning,
  desktopSteering,
  desktopStopPlace,
  desktopWorkerMeta,
  desktopWorkerState,
  isDesktopRunImage,
} from '../../app/utils/desktop-run-view';
import { isUnattendedDesktopRun } from '#shared/desktop-runs';
import { LIVE_SHARE_MISSING } from '@piwitests/core/live-view';

/**
 * The desktop window's view of the runs its shell starts: which run of the Local runs tray a hub session is, what a
 * worker says and takes, what a code made at a stop or a locator picked reads as to copy, and the window's stream:
 * opened while it is wanted, the runs and codes it hears, the frames to who watches alone, and the runs it shows live
 * said again on each new stream.
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
    ]) {
      expect(desktopArgsAttended(args), args.join(' ')).toBe(false);
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
      'A run that repeats its tests goes on past each failure.',
    );
    expect(desktopHoldRefusal(run('repro', ['--repeat-each=5']))).toBe(
      'A run that repeats its tests goes on past each failure.',
    );
    // A reproduction runs to see its failure at its line: it holds from its start; every other run starts off.
    expect(desktopHoldsByDefault({ kind: 'reproduce' })).toBe(true);
    for (const kind of ['tests', 'repro', 'bisect', 'flake'] as const)
      expect(desktopHoldsByDefault({ kind })).toBe(false);
  });

  test('says where it stands, with Pause while it runs and Resume, Step and Finish at a stop', () => {
    const running = workerOf();
    expect(desktopWorkerState(running, ROOT)).toBe('Running');
    expect(desktopWorkerMeta(running)).toBe('chromium · attempt 1');
    expect(desktopSteering(running)).toEqual(['pause']);
    expect(desktopSteering(workerOf({ pausing: true }))).toEqual([]);
    expect(desktopSteering(workerOf({ state: 'between' }))).toEqual([]);

    const stopped = workerOf({ state: 'stopped', stop: stopOf({ reason: 'page-pause' }) });
    expect(desktopWorkerState(stopped, ROOT)).toBe('Stopped at page.pause()');
    expect(desktopSteering(stopped)).toEqual(['resume', 'step', 'finish']);
    expect(desktopStopPlace(stopped.stop!, ROOT)).toBe('tests/checkout.spec.ts:5');
    // End the test, where the stop takes it: its reporter ends the test there, skipped.
    const endable = workerOf({ state: 'stopped', stop: stopOf({ intents: ['view', 'end'] }) });
    expect(desktopSteering(endable)).toEqual(['resume', 'step', 'finish', 'end']);
  });

  test('says a stop an agent asked for is the agent’s', () => {
    const at = (reason: HubStop['reason']) =>
      desktopWorkerState(workerOf({ state: 'stopped', stop: stopOf({ reason, by: 'agent' }) }), ROOT);
    expect(at('pause')).toBe('Paused by the agent');
    expect(at('step')).toBe('Stopped after the agent’s step');
    expect(at('run-to')).toBe('Stopped at the line the agent ran it to');
    expect(at('page-pause')).toBe('Stopped at page.pause()');
    expect(desktopWorkerState(workerOf({ state: 'stopped', stop: stopOf({ reason: 'pause' }) }), ROOT)).toBe('Paused');
  });

  test('ends a failure as it failed, Resume alone', () => {
    const failed = workerOf({ state: 'stopped', stop: stopOf({ reason: 'failure', error: 'expect failed' }) });
    expect(desktopWorkerState(failed, ROOT)).toBe('Failed at tests/checkout.spec.ts:5');
    expect(desktopSteering(failed)).toEqual(['resume']);
    const told = workerOf({ state: 'stopped', stop: stopOf({ reason: 'failure', intents: ['end'] }) });
    expect(desktopSteering(told)).toEqual(['resume']);
  });

  test('offers the code actions the stop takes from the window, never those that end in an editor', () => {
    const at = workerOf({ state: 'stopped', stop: stopOf() });
    expect(desktopCodeActions(at, at.stop!)).toEqual(['assert-region', 'mock']);
    const none = workerOf({ state: 'stopped', stop: stopOf({ intents: ['view'] }) });
    expect(desktopCodeActions(none, none.stop!)).toEqual([]);
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
    const { useDesktopRunHub } = await import('../../app/composables/useDesktopRunHub');
    return useDesktopRunHub();
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

  test('offers no Share live for a run that reports to this app, which no teammate reaches', () => {
    expect(desktopShareOffered(live)).toBe(true);
    expect(desktopShareOffered({ refused: LIVE_SHARE_MISSING.off })).toBe(true);
    expect(desktopShareOffered({ refused: LIVE_SHARE_MISSING.local })).toBe(false);
    expect(desktopShareOffered(null)).toBe(false);
  });
});
