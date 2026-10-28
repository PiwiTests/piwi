import { describe, expect, it } from 'vitest';
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import { MAX_VIEW_EVENTS } from '@piwitests/core/run-view';
import {
  pagePoint,
  parseRunsRequest,
  runFile,
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
    expect(parseRunsRequest({ ...command, worker: null, since: null, what: 'pause' })).toMatchObject({ worker: null });
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
      { ...command, since: null, what: 'pick' },
      { ...command, since: null, what: 'assert' },
      { ...command, since: null, what: 'requests' },
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
      hubs: [{ id: hub, connected: true, client: null }],
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
