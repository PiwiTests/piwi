import { describe, expect, it } from 'vitest';
import { LIVE_SHARE_MISSING, LIVE_SHARE_UNKNOWN } from '@piwitests/core/live-view';
import type { HubProgress, HubSession, HubWorker } from '@piwitests/core/run-hub';
import { MAX_VIEW_EVENTS } from '@piwitests/core/run-view';
import {
  attentionOf,
  ciDashboardWatch,
  pageHintOf,
  parseRunsRequest,
  shareRefusalOf,
  keyTargetOf,
  readRunsBounds,
  stopKeyOf,
  workerKey,
  shortcutCommands,
  stateForViewer,
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
      layers: true,
      presence: true,
      holds,
      stops: false,
      traces: false,
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

describe('Stop the run, as the worker reads it', () => {
  const command = { type: 'command', id: 7, hub: 'ws://127.0.0.1:1/piwi/hub', ref: 'r-1', worker: null, since: null };

  it('names the run alone', () => {
    expect(parseRunsRequest({ ...command, what: 'stop' })).toEqual({ ...command, what: 'stop' });
    for (const bad of [
      { ...command, what: 'stop', worker: 0 },
      { ...command, what: 'stop', since: 's3' },
      { ...command, what: 'stop', on: true },
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

describe('Watch on a CI run, as the worker reads it', () => {
  const lane = { type: 'ci-watch', id: 4, runId: 78, shard: null, lane: 1 };

  it('names the run on the instance, its shard and its lane, and whether to watch it', () => {
    expect(parseRunsRequest({ ...lane, on: true })).toEqual({ ...lane, on: true });
    expect(parseRunsRequest({ ...lane, shard: 2, on: false })).toEqual({ ...lane, shard: 2, on: false });
    for (const bad of [
      { ...lane },
      { ...lane, on: 'yes' },
      { ...lane, id: 0, on: true },
      { ...lane, runId: 0, on: true },
      { ...lane, runId: '78', on: true },
      { ...lane, shard: 0, on: true },
      { ...lane, shard: undefined, on: true },
      { ...lane, lane: -1, on: true },
      { ...lane, lane: 1.5, on: true },
    ]) {
      expect(parseRunsRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('opens the lane’s view on the run’s page, the worker counted from 1', () => {
    const run = { url: 'https://piwi.example/test-runs/78' };
    expect(ciDashboardWatch(run, { shard: null, lane: 1 })).toBe('https://piwi.example/test-runs/78?watch=2');
    expect(ciDashboardWatch(run, { shard: 3, lane: 0 })).toBe('https://piwi.example/test-runs/78?watch=3.1');
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
      hubs: [
        {
          id: hub,
          connected: true,
          client: null,
          desktop: false,
          lanes: false,
          layers: false,
          presence: false,
          holds: false,
          stops: false,
          traces: false,
        },
      ],
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
      // Only Watch and Open the trace so far name a lane.
      { ...command, what: 'share', lane: 1, on: true },
      { ...command, worker: 0, since: 's1', what: 'view', lane: 1, on: true },
    ]) {
      expect(parseRunsRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('names the layers of the lane the window takes, those the worker knows, each once, in their order', () => {
    expect(
      parseRunsRequest({ ...command, what: 'watch', lane: 2, on: true, layers: ['filmstrip', 'calls', 'calls'] }),
    ).toEqual({ ...command, what: 'watch', lane: 2, on: true, layers: ['calls', 'filmstrip'] });
    expect(parseRunsRequest({ ...command, what: 'watch', lane: 2, on: true, layers: ['newer'] })).toMatchObject({
      layers: [],
    });
    for (const bad of [
      { ...command, what: 'watch', lane: 1, on: true, layers: 'calls' },
      // Only Watch names layers.
      { ...command, what: 'share', on: true, layers: ['calls'] },
    ]) {
      expect(parseRunsRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('Open the trace so far, as the worker reads it', () => {
  const command = { type: 'command', id: 7, hub: 'ws://127.0.0.1:1/piwi/hub', ref: 'r-1', worker: null, since: null };

  it('names the run and its lane alone', () => {
    expect(parseRunsRequest({ ...command, what: 'trace', lane: 2 })).toEqual({ ...command, what: 'trace', lane: 2 });
    expect(parseRunsRequest({ ...command, what: 'trace', lane: 0 })).toMatchObject({ lane: 0 });
    for (const bad of [
      { ...command, what: 'trace' },
      { ...command, what: 'trace', lane: -1 },
      { ...command, what: 'trace', lane: 1.5 },
      { ...command, what: 'trace', lane: '1' },
      { ...command, what: 'trace', lane: 1, on: true },
      { ...command, what: 'trace', lane: 1, worker: 1 },
      { ...command, what: 'trace', lane: 1, since: 's1' },
      { ...command, what: 'trace', lane: 1, layers: ['calls'] },
    ]) {
      expect(parseRunsRequest(bad), JSON.stringify(bad)).toBeNull();
    }
    // Nothing else goes to the hub with it: a path the window named is left out.
    expect(parseRunsRequest({ ...command, what: 'trace', lane: 1, file: '/tmp/x.trace' })).toEqual({
      ...command,
      what: 'trace',
      lane: 1,
    });
  });
});

describe('a lane watched while it runs', () => {
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
      hubs: [
        {
          id: hub,
          connected: true,
          client: null,
          desktop: false,
          lanes: true,
          layers: false,
          presence: false,
          holds: false,
          stops: false,
          traces: false,
        },
      ],
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

describe('what the runs ask of the person', () => {
  const hub = 'ws://127.0.0.1:50123/piwi/hub';
  const hubs: RunsState['hubs'] = [
    {
      id: hub,
      connected: true,
      client: null,
      desktop: false,
      lanes: true,
      layers: false,
      presence: false,
      holds: false,
      stops: false,
      traces: false,
    },
  ];
  const progress = (status: HubProgress['status'], failed: number): HubProgress => ({
    total: 4,
    done: 4,
    failed,
    flaky: 0,
    skipped: 0,
    status,
    failure: null,
  });
  const failedRun = (ref: string, failed: number, unseen?: boolean) => ({
    ...run(ref, [], true),
    session: { ...run(ref, [], true).session, progress: progress('failed', failed) },
    ...(unseen ? { unseen } : {}),
  });

  it('counts the failed tests of a run that ended unseen, a run with none failed as one, until it is seen', () => {
    expect(attentionOf({ hubs, runs: [failedRun('a', 2)] })).toBeNull();
    expect(attentionOf({ hubs, runs: [failedRun('a', 2, true), failedRun('b', 0, true)] })).toEqual({
      state: 'failing',
      waiting: 0,
      heldFailures: 0,
      failed: 3,
    });
  });

  it('says a test waiting first, the unseen failures added to the live ones', () => {
    const waiting = run('w', [worker({ state: 'stopped', stop: stop('s1') })]);
    const live = { ...waiting, session: { ...waiting.session, progress: progress('running', 1) } };
    expect(attentionOf({ hubs, runs: [live, failedRun('a', 2, true)] })).toEqual({
      state: 'waiting',
      waiting: 1,
      heldFailures: 0,
      failed: 3,
    });
  });
});
