import { describe, expect, it } from 'vitest';
import type { HubSession, HubWorker } from '@piwitests/core/run-hub';
import { parseRunsRequest, runFile, shortcutCommands, stopPlace, testName } from '../../src/shared/runs.js';

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
      { type: 'window', windowId: 'w' },
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
});
