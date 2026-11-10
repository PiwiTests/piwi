import { describe, expect, it } from 'vitest';
import { LIVE_SHARE_MISSING, LIVE_SHARE_UNKNOWN } from '@piwitests/core/live-view';
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import { MAX_VIEW_EVENTS } from '@piwitests/core/run-view';
import {
  heldUntilWatched,
  laneFrameNow,
  laneWatchOf,
  pageHintOf,
  pagePoint,
  parseRunsRequest,
  runFile,
  shareRefusalOf,
  keyTargetOf,
  readRunsBounds,
  runLevelControls,
  shownWorkerOf,
  stopKeyOf,
  workerKey,
  shortcutCommands,
  stateForViewer,
  stopError,
  stopIntents,
  stopPlace,
  testName,
  viewKey,
  type RunsState,
} from '../../src/shared/runs.js';

const worker = (over: Partial<HubWorker>): HubWorker => ({
  worker: 0,
  parallelIndex: 0,
  state: 'running',
  pausing: false,
  intents: [],
  test: null,
  stop: null,
  ...over,
});

const run = (ref: string, workers: HubWorker[], ended = false) => ({
  hub: 'ws://127.0.0.1:50123/piwi/hub',
  session: { ref, root: null, label: null, command: null, project: null, workers, ended } satisfies HubSession,
});

const stop = (since: string) => ({
  reason: 'pause' as const,
  title: 'Click',
  uri: 'file:///x.ts',
  line: 0,
  character: null,
  locator: null,
  bar: false,
  since,
});

describe('the Runs window’s requests, as the worker reads them', () => {
  it('takes a command with every field it needs', () => {
    const command = { type: 'command', id: 3, hub: 'ws://127.0.0.1:1/piwi/hub', ref: 'r-1', worker: 2, since: 's4' };
    expect(parseRunsRequest({ ...command, what: 'step' })).toEqual({ ...command, what: 'step' });
    expect(parseRunsRequest({ ...command, what: 'end' })).toEqual({ ...command, what: 'end' });
    // Show the browser, at the stop it names.
    expect(parseRunsRequest({ ...command, what: 'front' })).toEqual({ ...command, what: 'front' });
    expect(parseRunsRequest({ ...command, worker: null, since: null, what: 'pause' })).toMatchObject({ worker: null });
    // End the test while a Pause waits for a call: its worker, and no stop.
    expect(parseRunsRequest({ ...command, since: null, what: 'give-up' })).toEqual({
      ...command,
      since: null,
      what: 'give-up',
    });
    expect(parseRunsRequest({ type: 'window', windowId: 7 })).toEqual({ type: 'window', windowId: 7 });
    expect(parseRunsRequest({ type: 'find' })).toEqual({ type: 'find' });
  });

  it('refuses anything else', () => {
    const command = { type: 'command', id: 3, hub: 'h', ref: 'r1', worker: 2, since: 's1', what: 'step' };
    for (const bad of [
      null,
      'step',
      { type: 'eval', code: '1' },
      { ...command, what: 'run-to' },
      { ...command, what: 'evaluate' },
      { ...command, ref: '../etc' },
      { ...command, worker: -1 },
      { ...command, worker: 1.5 },
      { ...command, id: 0 },
      { ...command, since: '' },
      { ...command, what: 'image', worker: null },
      // Every control but Pause names the stop it answers.
      { ...command, since: null, what: 'resume' },
      { ...command, since: null, what: 'end' },
      { ...command, since: null, what: 'pick' },
      { ...command, since: null, what: 'front' },
      { ...command, since: null, what: 'assert' },
      { ...command, since: null, what: 'requests' },
      // End the test while a Pause waits names its worker, and no stop.
      { ...command, what: 'give-up' },
      { ...command, worker: null, since: null, what: 'give-up' },
      { type: 'window', windowId: 'w' },
    ]) {
      expect(parseRunsRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('takes the code a stop can write, each naming its stop, and Mock a request the response it mocks', () => {
    const command = { type: 'command', id: 4, hub: 'ws://127.0.0.1:1/piwi/hub', ref: 'r-1', worker: 0, since: 's2' };
    for (const what of ['assert', 'assert-region', 'requests']) {
      expect(parseRunsRequest({ ...command, what })).toEqual({ ...command, what });
    }
    expect(parseRunsRequest({ ...command, what: 'mock', request: 3 })).toEqual({
      ...command,
      what: 'mock',
      request: 3,
    });
    for (const bad of [
      { ...command, what: 'mock' },
      { ...command, what: 'mock', request: 0 },
      { ...command, what: 'mock', request: 1.5 },
      { ...command, what: 'mock', request: '3' },
      { ...command, what: 'mock', request: 2 ** 31 },
      { ...command, what: 'mock', request: 3, since: null },
      // Only Mock a request names a response.
      { ...command, what: 'assert', request: 3 },
      { ...command, what: 'step', request: 3 },
    ]) {
      expect(parseRunsRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the global shortcut’s rule', () => {
  it('resumes every stopped test, each at its own stop', () => {
    const runs = [
      run('a', [worker({}), worker({ worker: 1, state: 'stopped', stop: stop('s1') })]),
      run('b', [worker({ worker: 3, state: 'stopped', stop: stop('s9') })]),
    ];
    expect(shortcutCommands(runs)).toEqual([
      { hub: runs[0]!.hub, ref: 'a', worker: 1, action: 'resume', since: 's1' },
      { hub: runs[0]!.hub, ref: 'b', worker: 3, action: 'resume', since: 's9' },
    ]);
  });

  it('pauses every live run with a worker when none is stopped', () => {
    const runs = [
      run('a', [worker({})]),
      run('b', []),
      run('c', [worker({ state: 'between' })]),
      run('d', [worker({})], true),
    ];
    expect(shortcutCommands(runs).map((c) => [c.ref, c.action, c.worker])).toEqual([
      ['a', 'pause', null],
      ['c', 'pause', null],
    ]);
  });

  it('leaves ended runs alone, stopped workers included', () => {
    expect(shortcutCommands([run('a', [worker({ state: 'stopped', stop: stop('s1') })], true)])).toEqual([]);
  });

  it('pauses only the runs a person attends, where its hub keeps a Hold failures for each, and resumes any stop', () => {
    const plain = run('a', [worker({})]);
    const attended = { ...plain, session: { ...plain.session, hold: { on: false, by: 'start' as const } } };
    const unattended = run('b', [worker({ worker: 2 })]);
    const hub = (holds: boolean) => ({
      id: attended.hub,
      connected: true,
      client: null,
      desktop: true,
      lanes: true,
      presence: true,
      holds,
    });
    // A run nobody attends is left to run: the shortcut pauses the run a person attends.
    expect(shortcutCommands([attended, unattended], [hub(true)]).map((c) => [c.ref, c.action])).toEqual([
      ['a', 'pause'],
    ]);
    // A hub that keeps no Hold failures names no run unattended.
    expect(shortcutCommands([attended, unattended], [hub(false)]).map((c) => [c.ref, c.action])).toEqual([
      ['a', 'pause'],
      ['b', 'pause'],
    ]);
    // A stop of a run nobody attends, which a person paused, still resumes.
    const stopped = run('b', [worker({ worker: 2, state: 'stopped', stop: stop('s1') })]);
    expect(shortcutCommands([attended, stopped], [hub(true)]).map((c) => [c.ref, c.action])).toEqual([['b', 'resume']]);
  });
});

describe('where the Runs window was left', () => {
  it('keeps a place and size a window can have, and nothing else', () => {
    expect(readRunsBounds({ left: 1200, top: -40, width: 440, height: 720 })).toEqual({
      left: 1200,
      top: -40,
      width: 440,
      height: 720,
    });
    for (const bad of [
      null,
      'here',
      { left: 0, top: 0, width: 100, height: 720 },
      { left: 0, top: 0, width: 440, height: 720.5 },
      { left: 1e9, top: 0, width: 440, height: 720 },
      { left: 0, width: 440, height: 720 },
    ]) {
      expect(readRunsBounds(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the keys of the stop controls', () => {
  const press = (
    key: string,
    more: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {},
  ) => stopKeyOf({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...more });

  it('reads Resume on F8 or F5, Step on F10 and Finish on Shift+F11, and nothing held with Ctrl, Alt or Meta', () => {
    expect([press('F8'), press('F5'), press('F10'), press('F11', { shiftKey: true })]).toEqual([
      'resume',
      'resume',
      'step',
      'finish',
    ]);
    for (const other of [press('F11'), press('F10', { shiftKey: true }), press('F8', { ctrlKey: true }), press('a')]) {
      expect(other).toBeNull();
    }
  });

  it('steers the test whose row holds the focus, else the only stopped one', () => {
    const one = run('a', [worker({}), worker({ worker: 1, state: 'stopped', stop: stop('s1') })]);
    expect(keyTargetOf([one], null)).toMatchObject({ worker: 1, since: 's1', failed: false });
    const two = run('b', [worker({ worker: 2, state: 'stopped', stop: { ...stop('s2'), reason: 'failure' } })]);
    // Two stopped tests: a key needs the focus in one of them.
    expect(keyTargetOf([one, two], null)).toBeNull();
    expect(keyTargetOf([one, two], workerKey(two.hub, 'b', { worker: 2 }))).toMatchObject({ worker: 2, failed: true });
    expect(keyTargetOf([run('c', [worker({ state: 'stopped', stop: stop('s3') })], true)], null)).toBeNull();
    // A stop of a run whose hub was lost, shown as last heard, is no test a key steers.
    expect(keyTargetOf([one, two], null, (hub) => hub !== two.hub || false)).toBeNull();
    const lost = { ...two, hub: 'ws://127.0.0.1:50999/piwi/hub' };
    expect(keyTargetOf([one, lost], null, (hub) => hub === one.hub)).toMatchObject({ worker: 1 });
  });
});

describe('the worker a run’s tabs show', () => {
  const stopped = (w: number, since: string) =>
    worker({ worker: w, parallelIndex: w, state: 'stopped', stop: stop(since) });
  const running = (w: number) => worker({ worker: w, parallelIndex: w });

  it('shows the person’s choice while it is stopped, watched or no stop came since, else the stop that came', () => {
    const none = { chosen: null, before: null };
    expect(shownWorkerOf([running(0), running(1)], none)).toBe(0);
    expect(shownWorkerOf([running(0), stopped(1, 's1')], none)).toBe(1);
    expect(shownWorkerOf([running(0), running(1)], { chosen: 1, before: null })).toBe(1);
    // A stop elsewhere takes the tab from a running worker, and gives it back once answered.
    expect(shownWorkerOf([running(0), stopped(1, 's1')], { chosen: 0, before: 0 })).toBe(1);
    expect(shownWorkerOf([running(0), running(1)], { chosen: 0, before: 1 })).toBe(0);
    // Never from a stop being answered, nor from a page being watched.
    expect(shownWorkerOf([stopped(0, 's0'), stopped(1, 's1')], { chosen: 0, before: 0 })).toBe(0);
    const watched = (w: HubWorker) => w.worker === 0;
    expect(shownWorkerOf([running(0), stopped(1, 's1')], { chosen: 0, before: 0, watched })).toBe(0);
    // A running worker chosen while others stood at stops keeps the tab, until a stop comes since.
    const known = new Set(['s1', 's2']);
    const three = [stopped(0, 's1'), stopped(1, 's2'), running(2)];
    expect(shownWorkerOf(three, { chosen: 2, before: 0, known })).toBe(2);
    expect(shownWorkerOf([stopped(0, 's1'), stopped(1, 's3'), running(2)], { chosen: 2, before: 2, known })).toBe(1);
    // Answered, a stop gives the tab to the next one standing.
    expect(shownWorkerOf([running(0), stopped(1, 's1')], { chosen: null, before: 0 })).toBe(1);
    // A choice of a worker gone from the run falls back to the first.
    expect(shownWorkerOf([running(0), running(1)], { chosen: 7, before: null })).toBe(0);
    expect(shownWorkerOf([], none)).toBeNull();
  });
});

describe('a run’s own controls', () => {
  it('pauses all while a worker runs, and resumes all while tests are stopped, for a run of several workers', () => {
    const two = run('a', [worker({}), worker({ worker: 1, state: 'stopped', stop: stop('s1') })]);
    expect(runLevelControls(two)).toEqual({ pauseAll: true, resumeAll: [] });
    const both = run('a', [
      worker({ state: 'stopped', stop: stop('s1') }),
      worker({ worker: 1, state: 'stopped', stop: stop('s2') }),
    ]);
    expect(runLevelControls(both)).toEqual({
      pauseAll: false,
      resumeAll: [
        { hub: both.hub, ref: 'a', worker: 0, action: 'resume', since: 's1' },
        { hub: both.hub, ref: 'a', worker: 1, action: 'resume', since: 's2' },
      ],
    });
    // One worker has its own Pause and Resume; an ended run, none; a Pause on its way, no second.
    expect(runLevelControls(run('a', [worker({})]))).toEqual({ pauseAll: false, resumeAll: [] });
    expect(runLevelControls(run('a', [worker({}), worker({ worker: 1 })], true))).toEqual({
      pauseAll: false,
      resumeAll: [],
    });
    expect(runLevelControls(run('a', [worker({ pausing: true }), worker({ worker: 1, pausing: true })]))).toEqual({
      pauseAll: false,
      resumeAll: [],
    });
  });
});

describe('where a test stands, as text', () => {
  it('names a file relative to the run’s folder, with the 1-based line', () => {
    expect(stopPlace({ uri: 'file:///home/me/shop/tests/pages/cart.page.ts', line: 12 }, '/home/me/shop')).toBe(
      'tests/pages/cart.page.ts:13',
    );
    expect(runFile('file:///home/me/other/a%20b.ts', '/home/me/shop')).toBe('/home/me/other/a b.ts');
    expect(runFile('file:///home/me/shop2/a.ts', '/home/me/shop')).toBe('/home/me/shop2/a.ts');
  });

  it('reads a Windows file, whatever the case of its drive', () => {
    expect(runFile('file:///c%3A/Shop/tests/cart.spec.ts', 'C:\\Shop')).toBe('tests/cart.spec.ts');
    expect(runFile('file:///C:/Shop/tests/cart.spec.ts', null)).toBe('C:/Shop/tests/cart.spec.ts');
  });

  it('leaves anything but a file URI as it is', () => {
    expect(runFile('untitled:Untitled-1', '/home')).toBe('untitled:Untitled-1');
  });

  it('names a test by its describe blocks, then its title', () => {
    expect(testName({ title: ['cart', 'coupons', 'applies WELCOME10'] })).toBe('cart › coupons › applies WELCOME10');
  });

  it('names the error a failure stopped at, as its stop says it, else as an older one titles it', () => {
    const title = 'Failed: Error: expect(locator).toBeVisible() failed';
    expect(stopError({ title, error: "Error: the cart's own message\nLocator: getByTestId('cart')" })).toBe(
      "Error: the cart's own message\nLocator: getByTestId('cart')",
    );
    expect(stopError({ title })).toBe('expect(locator).toBeVisible() failed');
    expect(stopError({ title: 'Failed: Test timeout of 5000ms exceeded.' })).toBe('Test timeout of 5000ms exceeded.');
  });
});

describe('the live view’s commands, as the worker reads them', () => {
  const command = { type: 'command', id: 5, hub: 'ws://127.0.0.1:1/piwi/hub', ref: 'r-1', worker: 0, since: 's3' };
  const click = { type: 'mouse', action: 'click', x: 20, y: 90.5, button: 'right', clickCount: 2 };

  it('takes a view on or off, input with its events and a pick on the image with its point', () => {
    expect(parseRunsRequest({ ...command, what: 'view', on: true })).toEqual({ ...command, what: 'view', on: true });
    expect(parseRunsRequest({ ...command, what: 'view', on: false })).toMatchObject({ on: false });
    expect(parseRunsRequest({ ...command, what: 'input', events: [click, { type: 'text', text: 'é' }] })).toEqual({
      ...command,
      what: 'input',
      events: [click, { type: 'text', text: 'é' }],
    });
    expect(parseRunsRequest({ ...command, what: 'pick-at', x: 0, y: 799.5 })).toEqual({
      ...command,
      what: 'pick-at',
      x: 0,
      y: 799.5,
    });
  });

  it('refuses one without its worker, its stop or its own fields, or with another command’s', () => {
    const many = Array.from({ length: MAX_VIEW_EVENTS + 1 }, () => ({ type: 'mouse', action: 'move', x: 1, y: 1 }));
    for (const bad of [
      { ...command, what: 'view' },
      { ...command, what: 'view', on: 'yes' },
      { ...command, what: 'view', on: true, worker: null },
      { ...command, what: 'view', on: true, since: null },
      { ...command, what: 'view', on: true, events: [click] },
      { ...command, what: 'input' },
      { ...command, what: 'input', events: [] },
      { ...command, what: 'input', events: many },
      { ...command, what: 'input', events: [{ ...click, x: -1 }] },
      { ...command, what: 'input', events: [{ type: 'key', action: 'press', key: 'Alt+F4+x+y+z+w' }] },
      { ...command, what: 'input', events: [{ type: 'eval', code: 'alert(1)' }] },
      { ...command, what: 'input', events: [click], worker: null },
      { ...command, what: 'pick-at', x: 1 },
      { ...command, what: 'pick-at', x: 1, y: 10_001 },
      { ...command, what: 'pick-at', x: Number.NaN, y: 1 },
      { ...command, what: 'pick-at', x: 1, y: 1, on: true },
      { ...command, what: 'step', on: true },
      { ...command, what: 'mock', request: 2, x: 1, y: 1 },
    ]) {
      expect(parseRunsRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('Hold failures, as the worker reads it', () => {
  const command = { type: 'command', id: 7, hub: 'ws://127.0.0.1:1/piwi/hub', ref: 'r-1', worker: null, since: null };

  it('names the run alone, and whether its failures wait', () => {
    expect(parseRunsRequest({ ...command, what: 'hold', on: true })).toEqual({ ...command, what: 'hold', on: true });
    expect(parseRunsRequest({ ...command, what: 'hold', on: false })).toMatchObject({ on: false });
    for (const bad of [
      { ...command, what: 'hold' },
      { ...command, what: 'hold', on: 'yes' },
      { ...command, what: 'hold', on: true, worker: 0 },
      { ...command, what: 'hold', on: true, since: 's3' },
      { ...command, what: 'hold', on: true, lane: 1 },
    ]) {
      expect(parseRunsRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('Take control and Give back, as the worker reads them', () => {
  const command = { type: 'command', id: 8, hub: 'ws://127.0.0.1:1/piwi/hub', ref: 'r-1', worker: 0, since: 's3' };

  it('name the run, the worker and its stop, and whether to drive it', () => {
    expect(parseRunsRequest({ ...command, what: 'drive', on: true })).toEqual({ ...command, what: 'drive', on: true });
    expect(parseRunsRequest({ ...command, what: 'drive', on: false })).toMatchObject({ on: false });
    for (const bad of [
      { ...command, what: 'drive' },
      { ...command, what: 'drive', on: 'yes' },
      { ...command, what: 'drive', on: true, since: null },
      { ...command, what: 'drive', on: true, worker: null },
      { ...command, what: 'drive', on: true, ref: 'r 1' },
      { ...command, what: 'drive', on: true, lane: 1 },
      { ...command, what: 'drive', on: true, x: 1, y: 1 },
    ]) {
      expect(parseRunsRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('Share live, as the worker reads it', () => {
  const command = { type: 'command', id: 6, hub: 'ws://127.0.0.1:1/piwi/hub', ref: 'r-1', worker: null, since: null };

  it('names the run alone, and whether to share it', () => {
    expect(parseRunsRequest({ ...command, what: 'share', on: true })).toEqual({ ...command, what: 'share', on: true });
    expect(parseRunsRequest({ ...command, what: 'share', on: false })).toMatchObject({ on: false });
    for (const bad of [
      { ...command, what: 'share' },
      { ...command, what: 'share', on: 'yes' },
      { ...command, what: 'share', on: true, worker: 0 },
      { ...command, what: 'share', on: true, since: 's3' },
      { ...command, what: 'share', on: true, request: 2 },
    ]) {
      expect(parseRunsRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('reads why a run cannot be shared, as the reporter says it, and no other sentence', () => {
    expect(shareRefusalOf(LIVE_SHARE_MISSING.local)).toBe('local');
    expect(shareRefusalOf(LIVE_SHARE_MISSING.off)).toBe('off');
    expect(shareRefusalOf(LIVE_SHARE_MISSING.unregistered)).toBe('unregistered');
    // A reporter of 0.66.0 and earlier says it in its own words.
    expect(
      shareRefusalOf(
        "This run cannot be shared live: the reporter's global setup did not register it with the instance as it started (wrapConfig adds it).",
      ),
    ).toBe('unregistered');
    expect(shareRefusalOf(LIVE_SHARE_MISSING['streaming-off'])).toBe('streaming-off');
    expect(shareRefusalOf(LIVE_SHARE_MISSING['setup-failed'])).toBe('setup-failed');
    expect(shareRefusalOf(LIVE_SHARE_MISSING['no-instance'])).toBe('no-instance');
    expect(shareRefusalOf(LIVE_SHARE_UNKNOWN)).toBe('unknown');
    expect(shareRefusalOf('Sharing stopped: the instance restarted.')).toBeNull();
    expect(shareRefusalOf(`${LIVE_SHARE_MISSING.local} `)).toBeNull();
  });
});

describe('where a run says its tests’ pages show', () => {
  const editorHub = { desktop: false, lanes: false };
  const viewing = { intents: ['view' as const] };

  it('is said while the run goes on and no test of it stands stopped, by the hub that runs it', () => {
    expect(pageHintOf(run('r1', [worker(viewing)]), editorHub)).toBe('editor');
    expect(pageHintOf(run('r1', [worker({ ...viewing, state: 'between' })]), editorHub)).toBe('editor');
    expect(pageHintOf(run('r1', [worker({ ...viewing, pausing: true })]), editorHub)).toBe('editor');
    expect(pageHintOf(run('r1', [worker(viewing)]), { desktop: true, lanes: false })).toBe('desktop');
    expect(pageHintOf(run('r1', [worker(viewing)]), undefined)).toBe('editor');
  });

  it('is not said once a test stops, the run ends, or nothing could show a stopped page live', () => {
    const stopped = worker({ ...viewing, worker: 1, state: 'stopped', stop: stop('s1') });
    expect(pageHintOf(run('r1', [worker(viewing), stopped]), editorHub)).toBeNull();
    expect(pageHintOf(run('r1', [worker(viewing)], true), editorHub)).toBeNull();
    expect(pageHintOf(run('r1', []), editorHub)).toBeNull();
    // A reporter that predates the live view.
    expect(pageHintOf(run('r1', [worker({ intents: ['pick', 'record'] })]), editorHub)).toBeNull();
    // A test that never stops, under CI or Playwright's own debugger.
    const test = {
      id: 't1',
      title: ['pays'],
      uri: 'file:///x.ts',
      line: 0,
      project: 'chromium',
      retry: 0,
      cannotPause: 'it runs under CI',
    };
    expect(pageHintOf(run('r1', [worker({ ...viewing, test })]), editorHub)).toBeNull();
    expect(pageHintOf(run('r1', [worker({ ...viewing, test }), worker(viewing)]), editorHub)).toBe('editor');
  });

  it('is not said where a worker can be watched while it runs, which its row says, but by a hub that cannot', () => {
    const watching = worker({ intents: ['view', 'watch'] });
    expect(pageHintOf(run('r1', [watching]), { desktop: false, lanes: true })).toBeNull();
    expect(pageHintOf(run('r1', [watching]), editorHub)).toBe('editor');
    // An older reporter, at a hub that shows lanes: its stops alone show here.
    expect(pageHintOf(run('r1', [worker(viewing)]), { desktop: true, lanes: true })).toBe('desktop');
  });
});

describe('what a stop takes from the window', () => {
  const at = { ...stop('s1'), intents: undefined };

  it('is what the hub says it takes from this connection, when it says it', () => {
    expect(stopIntents(worker({ intents: ['pick', 'mock', 'view'] }), { ...at, intents: ['view', 'pick-at'] })).toEqual(
      ['view', 'pick-at'],
    );
    expect(stopIntents(worker({ intents: ['pick'] }), { ...at, intents: [] })).toEqual([]);
  });

  it('is, from an older service, what the reporter takes where the pause bar shows, and Mock a request anywhere', () => {
    const takes = worker({
      intents: ['pick', 'record', 'assert', 'assert-region', 'mock', 'view', 'input', 'pick-at'],
    });
    expect(stopIntents(takes, { ...at, bar: true })).toEqual(['pick', 'record', 'assert', 'assert-region', 'mock']);
    expect(stopIntents(takes, { ...at, bar: false })).toEqual(['mock']);
  });

  it('leaves a stop the window does not watch itself the input and, headless, the actions in the test’s window out', () => {
    const hub = 'ws://127.0.0.1:1/piwi/hub';
    const watched = [
      'pick',
      'record',
      'assert',
      'assert-region',
      'mock',
      'view',
      'input',
      'input-clicks',
      'pick-at',
    ] as const;
    const state: RunsState = {
      discovery: 'found',
      desktop: 'unpaired',
      hubs: [{ id: hub, connected: true, client: null, desktop: false, lanes: false, presence: false, holds: false }],
      runs: [
        {
          hub,
          session: {
            ...run('r1', []).session,
            workers: [
              worker({ worker: 0, state: 'stopped', stop: { ...stop('s1'), intents: [...watched] } }),
              worker({ worker: 1, state: 'stopped', stop: { ...stop('s2'), bar: true, intents: [...watched] } }),
              worker({ worker: 2, state: 'stopped', stop: stop('s3') }),
            ],
          },
        },
      ],
    };
    const mine = viewKey({ hub, ref: 'r1', worker: 0, since: 's1' });
    const shown = stateForViewer(state, (view) => viewKey(view) === mine);
    const intents = shown.runs[0]!.session.workers.map((w) => w.stop?.intents);
    expect(intents[0]).toEqual([...watched]);
    expect(intents[1]).toEqual(['pick', 'record', 'assert', 'assert-region', 'mock', 'view', 'pick-at']);
    expect(intents[2]).toBeUndefined();
    const none = stateForViewer(state, () => false).runs[0]!.session.workers[0]!.stop?.intents;
    expect(none).toEqual(['mock', 'view', 'pick-at']);
  });
});

describe('a point on an image of a stopped page', () => {
  it('maps to CSS pixels of the viewport the image names, whatever size it is shown at', () => {
    expect(pagePoint({ x: 194, y: 60.625 }, { width: 388, height: 242.5 }, { width: 1280, height: 800 })).toEqual({
      x: 640,
      y: 200,
    });
    expect(pagePoint({ x: 10, y: 10 }, { width: 100, height: 50 }, { width: 400, height: 200 })).toEqual({
      x: 40,
      y: 40,
    });
  });

  it('stays within the viewport, and maps nothing from an image shown at no size', () => {
    expect(pagePoint({ x: -5, y: 900 }, { width: 100, height: 50 }, { width: 400, height: 200 })).toEqual({
      x: 0,
      y: 199.99,
    });
    expect(pagePoint({ x: 1, y: 1 }, { width: 0, height: 50 }, { width: 400, height: 200 })).toBeNull();
  });
});

describe('Watch, as the worker reads it', () => {
  const command = { type: 'command', id: 7, hub: 'ws://127.0.0.1:1/piwi/hub', ref: 'r-1', worker: null, since: null };

  it('names the run and its lane alone, and whether to watch it', () => {
    expect(parseRunsRequest({ ...command, what: 'watch', lane: 2, on: true })).toEqual({
      ...command,
      what: 'watch',
      lane: 2,
      on: true,
    });
    expect(parseRunsRequest({ ...command, what: 'watch', lane: 0, on: false })).toMatchObject({ lane: 0, on: false });
    for (const bad of [
      { ...command, what: 'watch', on: true },
      { ...command, what: 'watch', lane: 1 },
      { ...command, what: 'watch', lane: -1, on: true },
      { ...command, what: 'watch', lane: 1.5, on: true },
      { ...command, what: 'watch', lane: '1', on: true },
      { ...command, what: 'watch', lane: 1, on: 'yes' },
      { ...command, what: 'watch', lane: 1, on: true, worker: 1 },
      { ...command, what: 'watch', lane: 1, on: true, since: 's1' },
      { ...command, what: 'watch', lane: 1, on: true, events: [] },
      // Only Watch names a lane.
      { ...command, what: 'share', lane: 1, on: true },
      { ...command, worker: 0, since: 's1', what: 'view', lane: 1, on: true },
    ]) {
      expect(parseRunsRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('a lane watched while it runs', () => {
  it('can be at a hub that shows lanes, for a reporter that lists watch; an older reporter is told to update', () => {
    expect(laneWatchOf({ lanes: true }, worker({ intents: ['view', 'watch'] }))).toBe('watch');
    expect(laneWatchOf({ lanes: true }, worker({ intents: ['view'] }))).toBe('outdated');
    // A hub that predates it: a stop's own view alone, and nothing said.
    expect(laneWatchOf({ lanes: false }, worker({ intents: ['view', 'watch'] }))).toBeNull();
    expect(laneWatchOf(undefined, worker({ intents: ['watch'] }))).toBeNull();
  });

  it('shows where its worker stands now: the stop it stands at, else its running test, from that worker alone', () => {
    const test = { id: 't1', title: ['pays'], uri: 'file:///x.ts', line: 0, project: '', retry: 0, cannotPause: null };
    const running = worker({ worker: 3, test });
    const frame = (over: Partial<{ worker: number; test: string | null; since: string | null }> = {}) => ({
      worker: 3,
      test: 't1',
      since: null,
      ...over,
    });
    expect(laneFrameNow(frame(), running)).toBe(true);
    // Taken at a stop the test went on from, or in the test before it.
    expect(laneFrameNow(frame({ since: 's1' }), running)).toBe(false);
    expect(laneFrameNow(frame({ test: 't0' }), running)).toBe(false);
    // A newer service's state reads as running.
    expect(laneFrameNow(frame(), { ...running, state: 'other' })).toBe(true);
    // Between two tests, none does.
    expect(laneFrameNow(frame(), { ...running, state: 'between', test: null })).toBe(false);
    // At a stop, a frame of that stop alone.
    const stopped = { ...running, state: 'stopped' as const, stop: stop('s2') };
    expect(laneFrameNow(frame({ since: 's2' }), stopped)).toBe(true);
    expect(laneFrameNow(frame({ since: 's1' }), stopped)).toBe(false);
    expect(laneFrameNow(frame(), stopped)).toBe(false);
    // The worker Playwright started in the lane in place of the one that sent it.
    expect(laneFrameNow(frame(), { ...running, worker: 4 })).toBe(false);
    expect(laneFrameNow(frame(), undefined)).toBe(false);
  });

  it('holds the actions in the test’s window at a headless stop the window does not watch, saying to watch first', () => {
    const takes = worker({ intents: ['pick', 'record', 'assert', 'mock', 'view', 'input', 'pick-at', 'watch'] });
    const unwatched = { ...stop('s1'), intents: ['mock' as const, 'view' as const, 'pick-at' as const] };
    expect(heldUntilWatched(takes, unwatched, true)).toEqual(['pick', 'record', 'assert']);
    // Watched, the stop takes them; a stop the bar shows takes them anyway.
    expect(
      heldUntilWatched(takes, { ...unwatched, intents: [...unwatched.intents, 'pick', 'record', 'assert'] }, true),
    ).toEqual([]);
    expect(heldUntilWatched(takes, { ...unwatched, bar: true }, true)).toEqual([]);
    // Nothing to watch, a reporter that takes none of them, or a service that predates stop.intents: none held.
    expect(heldUntilWatched(takes, unwatched, false)).toEqual([]);
    expect(heldUntilWatched(worker({ intents: ['mock', 'view'] }), unwatched, true)).toEqual([]);
    expect(heldUntilWatched(takes, stop('s1'), true)).toEqual([]);
  });

  it('makes the window that watches it a viewer of the stops of its tests: the input and, headless, the actions in the test’s window', () => {
    const hub = 'ws://127.0.0.1:1/piwi/hub';
    const all = ['pick', 'record', 'mock', 'view', 'input', 'pick-at'] as const;
    const test = { id: 't1', title: ['pays'], uri: 'file:///x.ts', line: 0, project: '', retry: 0, cannotPause: null };
    const stopped = worker({
      worker: 5,
      parallelIndex: 1,
      state: 'stopped',
      test,
      stop: { ...stop('s1'), intents: [...all] },
    });
    const state = (workers: HubWorker[]): RunsState => ({
      discovery: 'found',
      desktop: 'unpaired',
      hubs: [{ id: hub, connected: true, client: null, desktop: false, lanes: true, presence: false, holds: false }],
      runs: [{ hub, session: { ...run('r1', []).session, workers } }],
    });
    const lanes: Array<number | null> = [];
    const watched = stateForViewer(state([stopped]), (_view, lane) => {
      lanes.push(lane);
      return lane === 1;
    });
    expect(lanes).toEqual([1]);
    expect(watched.runs[0]!.session.workers[0]!.stop?.intents).toEqual([...all]);
    const other = stateForViewer(state([stopped]), (_view, lane) => lane === 0);
    expect(other.runs[0]!.session.workers[0]!.stop?.intents).toEqual(['mock', 'view', 'pick-at']);
    // A stop outside a test, which no lane shows: watching the lane makes no viewer of it.
    const outside = stateForViewer(state([{ ...stopped, test: null }]), (_view, lane) => lane === 1);
    expect(outside.runs[0]!.session.workers[0]!.stop?.intents).toEqual(['mock', 'view', 'pick-at']);
  });
});
