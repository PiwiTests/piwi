import { describe, expect, test } from 'vitest';
import type { EditorDiscovery } from '../src/editor-discovery';
import { MAX_STOP_ERROR } from '../src/run-channel';
import {
  canStopRun,
  HUB_CLOSE,
  HUB_KEEPALIVE_MS,
  HUB_PATH,
  MAX_HUB_CLIENT,
  MAX_HUB_COMMAND,
  MAX_HUB_FRAME,
  MAX_HUB_MESSAGE,
  MAX_HUB_PEERS,
  MAX_HUB_PROJECT,
  MAX_HUB_ROOTS,
  MAX_FORWARDED_PORTS,
  MAX_HUB_WARNINGS,
  forwardedPorts,
  hubHostPort,
  hubPeersOf,
  isExtensionOrigin,
  isHubHost,
  liveHubsOf,
  liveUrlOf,
  parseHubCommand,
  parseHubHello,
  MAX_HUB_PRESENCE,
  parseHubMessage,
  parseLiveAnswer,
  type HubMessage,
  type HubSession,
} from '../src/run-hub';
import { MAX_VIEW_EVENTS, MAX_VIEW_FRAME_BASE64 } from '../src/run-view';

const json = (value: unknown) => JSON.stringify(value);

const session: HubSession = {
  ref: 'ed-0a1b2c3d',
  root: '/work/shop',
  label: 'shop',
  command: 'npx playwright test tests/cart.spec.ts:3 --headed',
  project: 'Shop',
  workers: [
    {
      worker: 0,
      parallelIndex: 0,
      state: 'stopped',
      test: {
        id: 'abc',
        title: ['cart', 'adds'],
        uri: 'file:///work/shop/tests/cart.spec.ts',
        line: 2,
        project: 'chromium',
        retry: 0,
        cannotPause: null,
      },
      stop: {
        reason: 'breakpoint',
        title: `Fill "x" locator('input')`,
        uri: 'file:///work/shop/tests/cart.spec.ts',
        line: 4,
        character: 2,
        locator: "locator('input')",
        bar: true,
        since: '2026-10-25T10:00:00.000Z',
      },
      pausing: false,
      intents: ['pick', 'record', 'assert', 'assert-region', 'mock'],
    },
  ],
  ended: false,
};

describe('the hub’s WebSocket', () => {
  test('has its path, its keepalive within Chrome’s 30 s, its frame cap and its close codes', () => {
    expect(HUB_PATH).toBe('/piwi/hub');
    expect(HUB_KEEPALIVE_MS).toBeLessThan(30_000);
    expect(MAX_HUB_FRAME).toBe(65_536);
    expect(HUB_CLOSE).toMatchObject({ unauthorized: 4001, helloTimeout: 4002, malformed: 4003, tooBig: 1009 });
  });

  test('takes an extension’s origin alone: never a page’s, a file’s, null or none', () => {
    expect(isExtensionOrigin(`chrome-extension://${'a'.repeat(32)}`)).toBe(true);
    expect(isExtensionOrigin('chrome-extension://pakhnokpjboejcghgcmkjlpnogfjihhe')).toBe(true);
    expect(isExtensionOrigin('moz-extension://0f3a8e2c-1b4d-4c5e-9f6a-7b8c9d0e1f2a')).toBe(true);
    for (const origin of [
      'http://127.0.0.1:43123',
      'https://piwitests.dev',
      'null',
      'file://',
      '',
      null,
      undefined,
      `chrome-extension://${'z'.repeat(32)}`,
      `chrome-extension://${'a'.repeat(32)}/`,
      `chrome-extension://${'a'.repeat(32)}.evil.test`,
      'moz-extension://not-a-uuid',
      'safari-web-extension://x',
    ]) {
      expect(isExtensionOrigin(origin), String(origin)).toBe(false);
    }
  });

  test('takes its own Host alone, so a page under another name (DNS rebinding) is refused', () => {
    expect(isHubHost('127.0.0.1:43123', 43123)).toBe(true);
    expect(isHubHost('localhost:43123', 43123)).toBe(true);
    expect(isHubHost('LOCALHOST:43123', 43123)).toBe(true);
    for (const host of [
      'evil.test:43123',
      '127.0.0.1',
      '127.0.0.1:80',
      '[::1]:43123',
      '127.0.0.2:43123',
      '',
      undefined,
    ]) {
      expect(isHubHost(host, 43123), String(host)).toBe(false);
    }
  });

  test('takes a loopback Host at a port the editor forwards to it, and no other name or port', () => {
    expect(hubHostPort('127.0.0.1:43123', 43123, [55001])).toBe(43123);
    expect(hubHostPort('127.0.0.1:55001', 43123, [55001])).toBe(55001);
    expect(hubHostPort('localhost:55001', 43123, [55001])).toBe(55001);
    expect(isHubHost('localhost:55001', 43123)).toBe(false);
    for (const host of ['evil.test:55001', '127.0.0.1:55002', '127.0.0.1:055001', '[::1]:55001', '10.0.0.2:55001']) {
      expect(hubHostPort(host, 43123, [55001]), host).toBeNull();
    }
  });

  test('reads the forwarded ports a client names: ports alone, each once, eight at most', () => {
    expect(forwardedPorts([55001, 55001, 0, 65_536, 1.5, '55002', 55003])).toEqual([55001, 55003]);
    expect(forwardedPorts(Array.from({ length: 12 }, (_, i) => 50_000 + i))).toHaveLength(MAX_FORWARDED_PORTS);
    expect(forwardedPorts('55001')).toEqual([]);
    expect(forwardedPorts(undefined)).toEqual([]);
  });

  test('reads the token of hello, and nothing else as one', () => {
    expect(parseHubHello(json({ type: 'hello', token: 'abc' }))).toBe('abc');
    for (const text of [json({ type: 'hello' }), json({ type: 'subscribe', id: 1, token: 'abc' }), 'abc', '{']) {
      expect(parseHubHello(text), text).toBeNull();
    }
    expect(parseHubHello(json({ type: 'hello', token: 'x'.repeat(300) }))).toBeNull();
  });

  test('reads each command field by field', () => {
    expect(parseHubCommand(json({ type: 'subscribe', id: 1 }))).toEqual({ type: 'subscribe', id: 1 });
    expect(parseHubCommand(json({ type: 'follow', id: 1, on: true }))).toEqual({ type: 'follow', id: 1, on: true });
    expect(parseHubCommand(json({ type: 'follow', id: 1, on: false }))).toEqual({ type: 'follow', id: 1, on: false });
    expect(parseHubCommand(json({ type: 'runControl', id: 2, ref: 'ed-1', action: 'pause' }))).toEqual({
      type: 'runControl',
      id: 2,
      ref: 'ed-1',
      worker: null,
      action: 'pause',
      since: null,
    });
    expect(
      parseHubCommand(json({ type: 'runControl', id: 3, ref: 'ed-1', worker: 1, action: 'step', since: 'S' })),
    ).toEqual({ type: 'runControl', id: 3, ref: 'ed-1', worker: 1, action: 'step', since: 'S' });
    expect(
      parseHubCommand(json({ type: 'runControl', id: 4, ref: 'ed-1', worker: null, action: 'end', since: 'S' })),
    ).toEqual({ type: 'runControl', id: 4, ref: 'ed-1', worker: null, action: 'end', since: 'S' });
    // End the test while a Pause waits for the call: no stop to name.
    expect(parseHubCommand(json({ type: 'runControl', id: 5, ref: 'ed-1', worker: 1, action: 'give-up' }))).toEqual({
      type: 'runControl',
      id: 5,
      ref: 'ed-1',
      worker: 1,
      action: 'give-up',
      since: null,
    });
    expect(parseHubCommand(json({ type: 'pausedPage', id: 4, ref: 'ed-1', worker: 0 }))).toEqual({
      type: 'pausedPage',
      id: 4,
      ref: 'ed-1',
      worker: 0,
    });
    for (const type of ['pick', 'record', 'assert', 'assert-region', 'requests'] as const) {
      expect(parseHubCommand(json({ type, id: 5, ref: 'ed-1', since: 'S' }))).toEqual({
        type,
        id: 5,
        ref: 'ed-1',
        worker: null,
        since: 'S',
      });
    }
    expect(parseHubCommand(json({ type: 'mock', id: 6, ref: 'ed-1', worker: 2, since: 'S', request: 3 }))).toEqual({
      type: 'mock',
      id: 6,
      ref: 'ed-1',
      worker: 2,
      since: 'S',
      request: 3,
    });
  });

  test('answers a command it cannot take as refused, with why, and one it does not know as unknown', () => {
    const invalid = (value: object) => parseHubCommand(json({ id: 9, ...value }));
    expect(invalid({ type: 'runControl', ref: 'ed-1', action: 'run-to' })).toEqual({
      type: 'invalid',
      id: 9,
      message: 'Run to a line stays in the editor: use Run to Cursor there.',
    });
    for (const broken of [
      { type: 'runControl', ref: 'ed-1', action: 'stop', since: 'S' },
      { type: 'runControl', ref: 'ed 1', action: 'pause' },
      { type: 'runControl', action: 'pause' },
      { type: 'runControl', ref: 'ed-1', worker: -1, action: 'pause' },
      { type: 'runControl', ref: 'ed-1', worker: '0', action: 'pause' },
      { type: 'runControl', ref: 'ed-1', action: 'step', since: 5 },
      { type: 'pausedPage', ref: 'ed-1' },
      { type: 'pick', ref: 'ed-1', since: '' },
      { type: 'mock', ref: 'ed-1', since: 'S' },
      { type: 'mock', ref: 'ed-1', since: 'S', request: 0 },
      { type: 'mock', ref: 'ed-1', since: 'S', request: '3' },
      { type: 'follow' },
      { type: 'follow', on: 'true' },
      { type: 'follow', on: 1 },
      { type: '' },
      { type: 7 },
    ]) {
      expect(invalid(broken), JSON.stringify(broken)).toMatchObject({ type: 'invalid', id: 9 });
    }
    expect(invalid({ type: 'evaluate', code: 'alert(1)' })).toEqual({ type: 'unknown', id: 9, what: 'evaluate' });
  });

  test('refuses a command that answers a stop without naming it, and takes a pause without one', () => {
    const needsStop = { type: 'invalid', id: 9, message: 'The command needs the stop it answers.' };
    for (const action of ['step', 'resume', 'finish', 'end']) {
      for (const since of [undefined, null]) {
        expect(parseHubCommand(json({ type: 'runControl', id: 9, ref: 'ed-1', worker: 0, action, since }))).toEqual(
          needsStop,
        );
      }
    }
    for (const type of ['pick', 'record', 'assert', 'assert-region', 'requests', 'mock', 'view', 'input', 'pick-at']) {
      expect(parseHubCommand(json({ type, id: 9, ref: 'ed-1', worker: 0, request: 1 }))).toEqual(needsStop);
      expect(parseHubCommand(json({ type, id: 9, ref: 'ed-1', since: null }))).toEqual(needsStop);
    }
    expect(parseHubCommand(json({ type: 'runControl', id: 9, ref: 'ed-1', action: 'pause', since: 'S' }))).toEqual({
      type: 'runControl',
      id: 9,
      ref: 'ed-1',
      worker: null,
      action: 'pause',
      since: 'S',
    });
  });

  test('reads no command without an id it can answer', () => {
    for (const text of [
      json({ type: 'subscribe' }),
      json({ type: 'subscribe', id: 0 }),
      json({ type: 'subscribe', id: 1.5 }),
      json({ type: 'subscribe', id: 2 ** 31 }),
      json({ type: 'hello', token: 'x' }),
      '[]',
      'subscribe',
    ]) {
      expect(parseHubCommand(text), text).toBeNull();
    }
  });

  test('has the extension read every message the hub sends, field by field', () => {
    const messages: HubMessage[] = [
      {
        type: 'welcome',
        pid: 4242,
        version: '0.60.0',
        client: 'WebStorm',
        roots: ['/work/shop'],
        keepaliveMs: 20_000,
        features: ['peers'],
      },
      { type: 'answer', id: 1, ok: true, message: 'Pausing at the next call.' },
      {
        type: 'answer',
        id: 2,
        ok: true,
        message: 'The stopped page.',
        image: { mime: 'image/jpeg', data: '/9j/4A==' },
      },
      { type: 'answer', id: 3, ok: false, message: 'No image.', image: null },
      {
        type: 'answer',
        id: 4,
        ok: true,
        message: 'The test kept 2 responses.',
        requests: [
          {
            id: 1,
            method: 'GET',
            url: 'https://shop.test/api/cart',
            status: 200,
            type: 'application/json',
            size: 12,
            time: 830,
          },
          {
            id: 2,
            method: 'POST',
            url: 'https://shop.test/api/orders',
            status: 201,
            type: 'application/json',
            size: null,
            time: 900,
          },
        ],
      },
      { type: 'answer', id: 5, ok: false, message: 'The test went on.', requests: [] },
      {
        type: 'code',
        ref: 'ed-0a1b2c3d',
        worker: 0,
        since: '2026-10-25T10:00:00.000Z',
        action: 'mock',
        ok: true,
        message: 'Piwi wrote the mock above cart.spec.ts:5.',
        warnings: ['A value named or shaped like a credential is written as <hidden>.'],
      },
      {
        type: 'code',
        ref: 'ed-0a1b2c3d',
        worker: 0,
        since: '2026-10-25T10:00:00.000Z',
        action: 'assert',
        ok: false,
        message: 'Nothing was checked: the test went on.',
      },
      { type: 'session', session },
      {
        type: 'session',
        session: { ...session, root: null, label: null, command: null, project: null, workers: [], ended: true },
      },
      { type: 'session', session: { ...session, command: null, terminal: true } },
      { type: 'session', session: { ...session, command: null, terminal: true, runner: true } },
      { type: 'keepalive' },
    ];
    for (const message of messages) expect(parseHubMessage(json(message))).toEqual(message);
    // A pausing worker's call it waits in; none read of a worker not pausing, nor one this version cannot read.
    const waiting = {
      title: "Click getByRole('button', { name: 'Pay' })",
      uri: 'file:///work/shop/tests/pages/checkout.page.ts',
      line: 11,
      since: '2026-10-25T10:00:00.000Z',
      endable: true,
    };
    const pausing = { ...session.workers[0]!, state: 'running' as const, stop: null, pausing: true, waiting };
    const withWaiting = { ...session, workers: [pausing] };
    expect(parseHubMessage(json({ type: 'session', session: withWaiting }))).toEqual({
      type: 'session',
      session: withWaiting,
    });
    for (const worker of [
      { ...pausing, pausing: false },
      { ...pausing, waiting: { ...waiting, uri: 'https://x' } },
    ]) {
      const read = parseHubMessage(json({ type: 'session', session: { ...session, workers: [worker] } }));
      expect(read).toMatchObject({ type: 'session' });
      expect((read as { session: { workers: Array<{ waiting?: unknown }> } }).session.workers[0]).not.toHaveProperty(
        'waiting',
      );
    }
    const worker = session.workers[0]!;
    expect(
      parseHubMessage(
        json({
          type: 'session',
          session: { ...session, workers: [{ ...worker, stop: { ...worker.stop, reason: 'failure' } }] },
        }),
      ),
    ).toMatchObject({ session: { workers: [{ stop: { reason: 'failure' } }] } });
    expect(
      parseHubMessage(
        json({
          type: 'session',
          session: { ...session, workers: [{ ...worker, stop: { ...worker.stop, reason: 'dance' } }] },
        }),
      ),
    ).toMatchObject({ session: { workers: [{ stop: { reason: 'other' } }] } });
    // A stop an agent asked for says so; any other value of `by` is left out.
    const byAgent = { ...session, workers: [{ ...worker, stop: { ...worker.stop!, by: 'agent' as const } }] };
    expect(parseHubMessage(json({ type: 'session', session: byAgent }))).toEqual({ type: 'session', session: byAgent });
    const byOther = parseHubMessage(
      json({ type: 'session', session: { ...session, workers: [{ ...worker, stop: { ...worker.stop, by: 'me' } }] } }),
    ) as { session: HubSession };
    expect(byOther.session.workers[0]!.stop).not.toHaveProperty('by');
    expect(
      parseHubMessage(
        json({
          type: 'session',
          session: { ...session, workers: [{ ...worker, intents: ['dance', 'end', 'mock', 'pick'] }] },
        }),
      ),
    ).toMatchObject({ session: { workers: [{ intents: ['pick', 'mock', 'end'] }] } });
    // A run of the editor's own says nothing of a terminal; `terminal` is true or left out.
    expect(parseHubMessage(json({ type: 'session', session: { ...session, terminal: 'yes' } }))).toEqual({
      type: 'session',
      session,
    });
    // A test runner's run is one of the runs `terminal` names: `runner` is true, of such a run alone, or left out.
    expect(parseHubMessage(json({ type: 'session', session: { ...session, runner: true } }))).toEqual({
      type: 'session',
      session,
    });
    expect(parseHubMessage(json({ type: 'session', session: { ...session, terminal: true, runner: 'yes' } }))).toEqual({
      type: 'session',
      session: { ...session, terminal: true },
    });
    // A failure's stop names its error; a hub that predates it names none.
    const failed = { ...worker.stop!, reason: 'failure', error: 'expect(locator).toBeVisible() failed' };
    expect(
      parseHubMessage(json({ type: 'session', session: { ...session, workers: [{ ...worker, stop: failed }] } })),
    ).toEqual({ type: 'session', session: { ...session, workers: [{ ...worker, stop: failed }] } });
  });

  test('has the extension read what a code from a stop came to, its warnings bounded, and never its code', () => {
    const code = {
      type: 'code',
      ref: 'ed-0a1b2c3d',
      worker: 1,
      since: '2026-10-25T10:00:00.000Z',
      action: 'assert-region',
      ok: true,
      message: "Piwi wrote the region's ARIA snapshot above cart.spec.ts:5.",
    };
    expect(parseHubMessage(json({ ...code, code: 'await expect(page).toMatchAriaSnapshot(``);' }))).toEqual(code);
    expect(parseHubMessage(json({ ...code, warnings: [] }))).toEqual({ ...code, warnings: [] });
    const most = Array.from({ length: MAX_HUB_WARNINGS }, (_, i) => `Warning ${i}.`);
    expect(parseHubMessage(json({ ...code, warnings: most }))).toEqual({ ...code, warnings: most });
    for (const broken of [
      { ...code, ref: 'ed 1' },
      { ...code, worker: -1 },
      { ...code, worker: null },
      { ...code, since: '' },
      { ...code, since: 'x'.repeat(65) },
      { ...code, action: 'pick' },
      { ...code, ok: 'yes' },
      { ...code, message: 5 },
      { ...code, message: 'x'.repeat(MAX_HUB_MESSAGE + 1) },
      { ...code, warnings: 'A warning.' },
      { ...code, warnings: [5] },
      { ...code, warnings: ['x'.repeat(MAX_HUB_MESSAGE + 1)] },
      { ...code, warnings: [...most, 'One more.'] },
    ]) {
      expect(parseHubMessage(json(broken)), JSON.stringify(broken)).toBeNull();
    }
  });

  test('has the extension refuse a message it cannot read', () => {
    for (const broken of [
      { type: 'answer', id: 1, ok: 'yes', message: '' },
      { type: 'answer', id: 1, ok: true, message: 'x', image: { mime: 'image/svg+xml', data: 'PHN2Zz4=' } },
      { type: 'answer', id: 1, ok: true, message: 'x', image: { mime: 'image/jpeg', data: '<svg>' } },
      { type: 'answer', id: 1, ok: true, message: 'x', requests: {} },
      { type: 'answer', id: 1, ok: true, message: 'x', requests: [{ id: 1, method: 'GET', url: 'u', status: 9 }] },
      { type: 'welcome', pid: 0, version: '1', client: null, roots: [], keepaliveMs: 1 },
      { type: 'session', session: { ...session, ref: 'ed 1' } },
      { type: 'session', session: { ...session, command: 5 } },
      { type: 'session', session: { ...session, workers: 'all' } },
      { type: 'session', session: { ...session, command: 'x'.repeat(MAX_HUB_COMMAND + 1) } },
      { type: 'session', session: { ...session, project: 'x'.repeat(MAX_HUB_PROJECT + 1) } },
      { type: 'answer', id: 1, ok: true, message: 'x'.repeat(MAX_HUB_MESSAGE + 1) },
      {
        type: 'welcome',
        pid: 1,
        version: '1',
        client: null,
        roots: Array.from({ length: MAX_HUB_ROOTS + 1 }, (_, i) => `/w/${i}`),
        keepaliveMs: 1,
      },
      { type: 'welcome', pid: 1, version: '1', client: 'x'.repeat(MAX_HUB_CLIENT + 1), roots: [], keepaliveMs: 1 },
      { type: 'frame', data: 'x' },
    ]) {
      expect(parseHubMessage(json(broken)), JSON.stringify(broken)).toBeNull();
    }
    expect(parseHubMessage('not json')).toBeNull();
  });

  test('has the extension read a worker state of a newer service as other, and keep the run', () => {
    const worker = session.workers[0]!;
    const read = parseHubMessage(
      json({ type: 'session', session: { ...session, workers: [{ ...worker, state: 'waiting-for-you' }] } }),
    );
    expect(read).toEqual({ type: 'session', session: { ...session, workers: [{ ...worker, state: 'other' }] } });
    for (const state of [5, null, 'x'.repeat(65)]) {
      expect(
        parseHubMessage(json({ type: 'session', session: { ...session, workers: [{ ...worker, state }] } })),
        JSON.stringify(state),
      ).toEqual({ type: 'session', session: { ...session, workers: [] } });
    }
  });

  test('has the extension leave out a worker it cannot read, and keep the run and its other workers', () => {
    const worker = session.workers[0]!;
    const next = { ...worker, worker: 1, parallelIndex: 1, state: 'running', stop: null };
    for (const broken of [
      { ...worker, worker: -1 },
      { ...worker, stop: { ...worker.stop, line: -1 } },
      { ...worker, test: { ...worker.test, title: [1] } },
      { ...worker, stop: { ...worker.stop, error: 5 } },
      { ...worker, stop: { ...worker.stop, error: 'x'.repeat(MAX_STOP_ERROR + 1) } },
      'worker',
    ]) {
      expect(
        parseHubMessage(json({ type: 'session', session: { ...session, workers: [broken, next] } })),
        JSON.stringify(broken),
      ).toEqual({ type: 'session', session: { ...session, workers: [next] } });
    }
  });
});

describe('Share live on the hub', () => {
  test('reads share, naming the run and whether to share it', () => {
    expect(parseHubCommand(json({ type: 'share', id: 7, ref: 'ed-1', on: true }))).toEqual({
      type: 'share',
      id: 7,
      ref: 'ed-1',
      on: true,
    });
    expect(parseHubCommand(json({ type: 'share', id: 7, ref: 'ed-1', on: false }))).toMatchObject({ on: false });
    expect(parseHubCommand(json({ type: 'share', id: 7, ref: 'ed 1', on: true }))).toMatchObject({ type: 'invalid' });
    expect(parseHubCommand(json({ type: 'share', id: 7, ref: 'ed-1' }))).toEqual({
      type: 'invalid',
      id: 7,
      message: 'share needs on: true to share the run live, false to stop.',
    });
  });

  test('has the extension read how a run stands on the instance, and leave out what it cannot read', () => {
    const live = {
      shared: true,
      refused: null,
      stopped: null,
      page: 'https://piwi.example.com/test-runs/42',
      viewers: 3,
    };
    const shared = { ...session, live };
    expect(parseHubMessage(json({ type: 'session', session: shared }))).toEqual({ type: 'session', session: shared });
    const refused = { ...live, shared: false, refused: 'This run cannot be shared live.', page: null, viewers: 0 };
    expect(parseHubMessage(json({ type: 'session', session: { ...session, live: refused } }))).toMatchObject({
      session: { live: refused },
    });
    // Why its sharing stopped though nobody asked; an older hub says nothing of it.
    const stopped = { ...live, shared: false, stopped: 'Sharing stopped: the instance did not answer.', viewers: 0 };
    expect(parseHubMessage(json({ type: 'session', session: { ...session, live: stopped } }))).toMatchObject({
      session: { live: stopped },
    });
    const { stopped: _stopped, ...older } = live;
    expect(parseHubMessage(json({ type: 'session', session: { ...session, live: older } }))).toMatchObject({
      session: { live: { ...older, stopped: null } },
    });
    for (const broken of [
      { ...live, shared: 'yes' },
      { ...live, viewers: -1 },
      { ...live, refused: 5 },
      { ...live, refused: 'x'.repeat(MAX_HUB_MESSAGE + 1) },
      { ...live, stopped: 5 },
      { ...live, page: 'javascript:alert(1)' },
      'shared',
    ]) {
      expect(parseHubMessage(json({ type: 'session', session: { ...session, live: broken } })), json(broken)).toEqual({
        type: 'session',
        session,
      });
    }
  });
});

describe('the live view on the hub', () => {
  test('reads view, input and pick-at, each naming the stop it is at, field by field', () => {
    expect(parseHubCommand(json({ type: 'view', id: 1, ref: 'ed-1', worker: 0, since: 'S', on: true }))).toEqual({
      type: 'view',
      id: 1,
      ref: 'ed-1',
      worker: 0,
      since: 'S',
      on: true,
    });
    expect(parseHubCommand(json({ type: 'view', id: 1, ref: 'ed-1', since: 'S', on: false }))).toMatchObject({
      worker: null,
      on: false,
    });
    expect(parseHubCommand(json({ type: 'view', id: 1, ref: 'ed-1', since: 'S' }))).toEqual({
      type: 'invalid',
      id: 1,
      message: 'view needs on: true to watch the stop, false to stop watching it.',
    });
    const events = [
      { type: 'mouse', action: 'move', x: 1, y: 2 },
      { type: 'text', text: 'é' },
    ];
    expect(parseHubCommand(json({ type: 'input', id: 2, ref: 'ed-1', since: 'S', events }))).toEqual({
      type: 'input',
      id: 2,
      ref: 'ed-1',
      worker: null,
      since: 'S',
      events,
    });
    // The input says which event it cannot play.
    expect(
      parseHubCommand(json({ type: 'input', id: 2, ref: 'ed-1', since: 'S', events: [events[0], { type: 'code' }] })),
    ).toEqual({
      type: 'invalid',
      id: 2,
      message: 'Event 2 is of a type other than mouse, wheel, key or text.',
    });
    const many = Array.from({ length: MAX_VIEW_EVENTS + 1 }, () => events[0]);
    expect(parseHubCommand(json({ type: 'input', id: 2, ref: 'ed-1', since: 'S', events: many }))).toMatchObject({
      type: 'invalid',
      message: `The input carries ${MAX_VIEW_EVENTS} events at most.`,
    });
    expect(parseHubCommand(json({ type: 'pick-at', id: 3, ref: 'ed-1', worker: 2, since: 'S', x: 20, y: 90 }))).toEqual(
      { type: 'pick-at', id: 3, ref: 'ed-1', worker: 2, since: 'S', x: 20, y: 90 },
    );
    for (const [x, y] of [
      [-1, 5],
      [5, 10_001],
      [Number.NaN, 5],
      ['5', 5],
      [undefined, 5],
    ]) {
      expect(parseHubCommand(json({ type: 'pick-at', id: 3, ref: 'ed-1', since: 'S', x, y }))).toEqual({
        type: 'invalid',
        id: 3,
        message: 'pick-at needs x and y, the point in CSS pixels of the page.',
      });
    }
  });

  test('has the extension read a frame, a pick’s locator, an image’s viewport and what a stop takes from it', () => {
    const frame: HubMessage = {
      type: 'frame',
      ref: 'ed-1',
      worker: 0,
      since: '2026-10-25T10:00:00.000Z',
      width: 1280,
      height: 720,
      data: '/9j/4A==',
    };
    expect(parseHubMessage(json(frame))).toEqual(frame);
    for (const broken of [
      { ...frame, ref: 'ed 1' },
      { ...frame, worker: -1 },
      { ...frame, since: '' },
      { ...frame, width: 0 },
      { ...frame, data: 'A'.repeat(MAX_VIEW_FRAME_BASE64 + 4) },
      { ...frame, data: '<svg>' },
    ]) {
      expect(parseHubMessage(json(broken))).toBeNull();
    }
    // Why the view sends no frame, as a frame goes: its sentence alone.
    const refused: HubMessage = { type: 'frame', ref: 'ed-1', worker: 0, since: frame.since, refused: 'Too heavy.' };
    expect(parseHubMessage(json(refused))).toEqual(refused);
    for (const broken of [
      { ...refused, refused: '' },
      { ...refused, refused: 'x'.repeat(MAX_HUB_MESSAGE + 1) },
    ]) {
      expect(parseHubMessage(json(broken))).toBeNull();
    }
    const picked: HubMessage = { type: 'answer', id: 7, ok: true, message: 'Sent.', locator: "getByText('Go')" };
    expect(parseHubMessage(json(picked))).toEqual(picked);
    expect(parseHubMessage(json({ ...picked, locator: null }))).toEqual({ ...picked, locator: null });
    expect(parseHubMessage(json({ ...picked, locator: 'x'.repeat(1001) }))).toBeNull();
    const image: HubMessage = {
      type: 'answer',
      id: 8,
      ok: true,
      message: 'The stopped page.',
      image: { mime: 'image/jpeg', data: '/9j/', width: 640, height: 480 },
    };
    expect(parseHubMessage(json(image))).toEqual(image);
    const stop = session.workers[0]!.stop!;
    const withIntents = {
      ...session,
      workers: [{ ...session.workers[0]!, stop: { ...stop, intents: ['view', 'pick', 'dance', 'input'] } }],
    };
    expect(parseHubMessage(json({ type: 'session', session: withIntents }))).toEqual({
      type: 'session',
      session: {
        ...session,
        workers: [{ ...session.workers[0]!, stop: { ...stop, intents: ['pick', 'view', 'input'] } }],
      },
    });
    // A service that predates them names none: the stop has no intents of its own.
    expect(
      (parseHubMessage(json({ type: 'session', session })) as { session: HubSession }).session.workers[0]!.stop,
    ).not.toHaveProperty('intents');
  });

  test('reads any command and message without throwing', () => {
    let state = 5;
    const next = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const odd = [
      null,
      undefined,
      0,
      -1,
      1,
      2.5,
      2 ** 31,
      '',
      'S',
      'ed-1',
      '/9j/',
      [],
      {},
      true,
      [{ type: 'key', action: 'press', key: 'Tab' }],
    ];
    const pick = () => odd[Math.floor(next() * odd.length)];
    const types = ['view', 'input', 'pick-at', 'frame', 'answer'];
    for (let i = 0; i < 20_000; i++) {
      const message = {
        type: types[i % types.length],
        id: next() < 0.7 ? 1 + (i % 100) : pick(),
        ref: next() < 0.7 ? 'ed-1' : pick(),
        worker: pick(),
        since: next() < 0.7 ? 'S' : pick(),
        on: pick(),
        events: pick(),
        x: pick(),
        y: pick(),
        width: pick(),
        height: pick(),
        data: pick(),
        ok: pick(),
        message: pick(),
        locator: pick(),
      };
      const command = parseHubCommand(json(message));
      if (command?.type === 'input') expect(command.events.length).toBeLessThanOrEqual(MAX_VIEW_EVENTS);
      const heard = parseHubMessage(json(message));
      if (heard?.type === 'frame') {
        if ('data' in heard) expect(heard.data.length).toBeLessThanOrEqual(MAX_VIEW_FRAME_BASE64);
        else expect(heard.refused.length).toBeLessThanOrEqual(MAX_HUB_MESSAGE);
      }
    }
  });
});

describe('a lane watched on the hub', () => {
  test('reads watch, naming the run and its lane, and refuses one without either', () => {
    const watch = { type: 'watch', id: 3, ref: 'ed-1', lane: 2, on: true };
    expect(parseHubCommand(json(watch))).toEqual(watch);
    expect(parseHubCommand(json({ ...watch, on: false }))).toEqual({ ...watch, on: false });
    for (const broken of [
      { ...watch, ref: 'ed 1' },
      { ...watch, lane: -1 },
      { ...watch, lane: 1.5 },
      { ...watch, lane: undefined },
      { ...watch, on: 'yes' },
    ]) {
      expect(parseHubCommand(json(broken))).toMatchObject({ type: 'invalid', id: 3 });
    }
  });

  test('has the extension read a frame of a lane, of its test and its stop, and why none comes', () => {
    const frame: HubMessage = {
      type: 'lane-frame',
      ref: 'ed-1',
      lane: 1,
      worker: 4,
      test: 'abc',
      since: null,
      width: 1280,
      height: 720,
      data: '/9j/4A==',
    };
    expect(parseHubMessage(json(frame))).toEqual(frame);
    const atStop = { ...frame, since: '2026-10-25T10:00:00.000Z' };
    expect(parseHubMessage(json(atStop))).toEqual(atStop);
    for (const broken of [
      { ...frame, lane: -1 },
      { ...frame, worker: undefined },
      { ...frame, test: null },
      { ...frame, test: '' },
      { ...frame, since: '' },
      { ...frame, since: undefined },
      { ...frame, data: '<svg>' },
    ]) {
      expect(parseHubMessage(json(broken)), JSON.stringify(broken).slice(0, 80)).toBeNull();
    }
    const refused: HubMessage = {
      type: 'lane-frame',
      ref: 'ed-1',
      lane: 1,
      worker: 4,
      test: null,
      since: null,
      refused: 'No page to show.',
    };
    expect(parseHubMessage(json(refused))).toEqual(refused);
    expect(parseHubMessage(json({ ...refused, refused: 'x'.repeat(MAX_HUB_MESSAGE + 1) }))).toBeNull();
  });

  test('is offered by a hub whose welcome lists lanes, for a worker whose intents list watch', () => {
    const welcome = { type: 'welcome', pid: 1, version: '1', client: null, roots: [], keepaliveMs: 1 };
    expect(parseHubMessage(json({ ...welcome, features: ['lanes', 'peers'] }))).toEqual({
      ...welcome,
      features: ['peers', 'lanes'],
    });
    const watched = { ...session, workers: [{ ...session.workers[0]!, intents: ['pick', 'watch'] }] };
    expect(parseHubMessage(json({ type: 'session', session: watched }))).toEqual({
      type: 'session',
      session: watched,
    });
  });
});

describe('how far a run is, on the hub', () => {
  const progress = {
    total: 9,
    done: 3,
    failed: 1,
    flaky: 0,
    skipped: 0,
    status: 'running',
    failure: null,
  } as const;

  test('has the extension read it, a status of a newer service as other, and leave out what it cannot read', () => {
    const read = (value: unknown) =>
      (parseHubMessage(json({ type: 'session', session: { ...session, progress: value } })) as { session: HubSession })
        .session.progress;
    expect(read(progress)).toEqual(progress);
    expect(read({ ...progress, status: 'exploded' })).toEqual({ ...progress, status: 'other' });
    const ended = { ...progress, done: 9, status: 'failed', failure: { title: 'cart › adds', error: null } };
    expect(read(ended)).toEqual(ended);
    for (const broken of [
      { ...progress, done: 10 },
      { ...progress, failed: 4 },
      { ...progress, total: -1 },
      { ...progress, failure: { title: '', error: null } },
      { ...progress, status: 3 },
      'nine',
    ]) {
      expect(read(broken), JSON.stringify(broken)).toBeUndefined();
    }
    // A session without it reads as one from a service that predates it.
    expect((parseHubMessage(json({ type: 'session', session })) as { session: HubSession }).session).not.toHaveProperty(
      'progress',
    );
  });
});

describe('Stop for a whole run on the hub', () => {
  test('reads stop, naming the run, and refuses one without it', () => {
    expect(parseHubCommand(json({ type: 'stop', id: 9, ref: 'ed-1' }))).toEqual({ type: 'stop', id: 9, ref: 'ed-1' });
    expect(parseHubCommand(json({ type: 'stop', id: 9 }))).toEqual({
      type: 'invalid',
      id: 9,
      message: 'The command needs the ref of a run.',
    });
    expect(parseHubCommand(json({ type: 'stop', id: 9, ref: 'ed 1' }))).toMatchObject({ type: 'invalid' });
  });

  test('stops a live run its host started, never one started in a terminal or by the editor’s runner', () => {
    const welcome = { type: 'welcome', pid: 1, version: '1', client: null, roots: [], keepaliveMs: 1 };
    expect(canStopRun({ ended: false })).toBe(true);
    expect(canStopRun({ ended: true })).toBe(false);
    expect(canStopRun({ ended: false, terminal: true })).toBe(false);
    expect(parseHubMessage(json({ ...welcome, features: ['stop'] }))).toEqual({ ...welcome, features: ['stop'] });
  });
});

describe('Hold failures on the hub', () => {
  test('reads hold, naming the run and whether its failures wait, and refuses one without either', () => {
    expect(parseHubCommand(json({ type: 'hold', id: 8, ref: 'ed-1', on: true }))).toEqual({
      type: 'hold',
      id: 8,
      ref: 'ed-1',
      on: true,
    });
    expect(parseHubCommand(json({ type: 'hold', id: 8, ref: 'ed-1', on: false }))).toMatchObject({ on: false });
    expect(parseHubCommand(json({ type: 'hold', id: 8, ref: 'ed 1', on: true }))).toMatchObject({ type: 'invalid' });
    expect(parseHubCommand(json({ type: 'hold', id: 8, ref: 'ed-1' }))).toEqual({
      type: 'invalid',
      id: 8,
      message: 'hold needs on: true to hold the failures, false to let them go on.',
    });
  });

  test('has the extension read a run’s hold and who set it, a hub that lists hold, and leave out what it cannot read', () => {
    const welcome = { type: 'welcome', pid: 1, version: '1', client: null, roots: [], keepaliveMs: 1 };
    expect(parseHubMessage(json({ ...welcome, features: ['hold'] }))).toEqual({ ...welcome, features: ['hold'] });
    const read = (value: unknown) =>
      (parseHubMessage(json({ type: 'session', session: { ...session, hold: value } })) as { session: HubSession })
        .session.hold;
    for (const by of ['start', 'person', 'agent'] as const) expect(read({ on: true, by })).toEqual({ on: true, by });
    expect(read({ on: false, by: 'person' })).toEqual({ on: false, by: 'person' });
    for (const broken of [{ on: 'yes', by: 'person' }, { on: true, by: 'robot' }, { on: true }, 'on']) {
      expect(read(broken), JSON.stringify(broken)).toBeUndefined();
    }
  });
});

describe('who is present on a run, on the hub', () => {
  test('reads drive, naming the stop and whether the connection drives it, and refuses one without either', () => {
    expect(parseHubCommand(json({ type: 'drive', id: 9, ref: 'ed-1', worker: 0, since: 'x', on: true }))).toEqual({
      type: 'drive',
      id: 9,
      ref: 'ed-1',
      worker: 0,
      since: 'x',
      on: true,
    });
    expect(parseHubCommand(json({ type: 'drive', id: 9, ref: 'ed-1', on: true }))).toMatchObject({ type: 'invalid' });
    expect(parseHubCommand(json({ type: 'drive', id: 9, ref: 'ed-1', since: 'x' }))).toEqual({
      type: 'invalid',
      id: 9,
      message: 'drive needs on: true to drive the stop, false to give it back.',
    });
  });

  test('has the extension read who has a run open, watches a worker and drives its stop, and leave out the rest', () => {
    const picker = { kind: 'picker', name: 'Piwi Picker', self: true };
    const agent = { kind: 'agent', name: 'an agent' };
    const [worker] = session.workers;
    const read = (over: object, at: object = {}) =>
      (
        parseHubMessage(
          json({ type: 'session', session: { ...session, ...over, workers: [{ ...worker, ...at }] } }),
        ) as { session: HubSession }
      ).session;
    expect(read({ presence: [picker, agent] }).presence).toEqual([picker, agent]);
    expect(read({}, { watchers: [agent] }).workers[0]!.watchers).toEqual([agent]);
    expect(read({}, { stop: { ...worker!.stop, driver: agent } }).workers[0]!.stop!.driver).toEqual(agent);
    // A kind of a newer hub reads as other; a tool without a name, or a list too long, is left out.
    expect(read({ presence: [{ kind: 'robot', name: 'R' }] }).presence).toEqual([{ kind: 'other', name: 'R' }]);
    expect(read({ presence: [{ kind: 'agent' }] }).presence).toBeUndefined();
    expect(read({ presence: Array.from({ length: MAX_HUB_PRESENCE + 1 }, () => agent) }).presence).toBeUndefined();
    expect(read({}, { stop: { ...worker!.stop, driver: 'agent' } }).workers[0]!.stop!.driver).toBeUndefined();
  });
});

describe('the live endpoint', () => {
  test('sits beside the Send to editor endpoint, in both editors', () => {
    expect(liveUrlOf('http://127.0.0.1:43123/piwi/send')).toBe('http://127.0.0.1:43123/piwi/live');
    expect(liveUrlOf('http://127.0.0.1:63342/api/piwi/send')).toBe('http://127.0.0.1:63342/api/piwi/live');
    expect(liveUrlOf('http://127.0.0.1:63342/api/piwi/open')).toBeNull();
  });

  test('lists the hub of each live service’s file, and none for a service whose hub did not listen', () => {
    const editor: EditorDiscovery = {
      pid: 4242,
      host: 'dev-laptop',
      version: '0.60.0',
      client: 'Visual Studio Code',
      startedAt: '2026-10-25T10:00:00.000Z',
      roots: ['/work/shop'],
      hub: { url: 'ws://127.0.0.1:43123/piwi/hub', token: 'h'.repeat(32) },
      runChannel: { path: '/tmp/s.sock', token: 'c'.repeat(32) },
      recorderBundle: null,
    };
    const hubs = liveHubsOf([editor, { ...editor, pid: 7, hub: null }]);
    expect(hubs).toEqual([
      {
        url: 'ws://127.0.0.1:43123/piwi/hub',
        token: 'h'.repeat(32),
        pid: 4242,
        version: '0.60.0',
        client: 'Visual Studio Code',
        roots: ['/work/shop'],
        startedAt: '2026-10-25T10:00:00.000Z',
      },
    ]);
    // The run channel's token never leaves the machine through it.
    expect(JSON.stringify(hubs)).not.toContain('c'.repeat(32));
    expect(parseLiveAnswer({ hubs })).toEqual(hubs);
    expect(
      parseLiveAnswer({
        hubs: [...hubs, { ...hubs[0], url: 'ws://evil.test:1/piwi/hub' }, { ...hubs[0], token: 'x' }],
      }),
    ).toEqual(hubs);
    expect(parseLiveAnswer({ error: 'not paired' })).toBeNull();
    // A hub named under `localhost` is read on 127.0.0.1: `localhost` may resolve to [::1], another program's.
    expect(parseLiveAnswer({ hubs: [{ ...hubs[0], url: 'ws://localhost:43123/piwi/hub' }] })).toEqual(hubs);
    expect(
      parseLiveAnswer({
        hubs: [
          'ws://[::1]:43123/piwi/hub',
          'ws://127.0.0.1.evil.test:43123/piwi/hub',
          'wss://127.0.0.1:43123/piwi/hub',
        ].map((url) => ({ ...hubs[0], url })),
      }),
    ).toEqual([]);
  });

  test('names the desktop app’s features beside its hub, those this version knows', () => {
    const hub = {
      url: 'ws://127.0.0.1:43123/piwi/hub',
      token: 'h'.repeat(32),
      pid: 4242,
      version: '0.67.0',
      client: 'Piwi desktop app',
      roots: [],
      startedAt: '2026-10-25T10:00:00.000Z',
    };
    expect(parseLiveAnswer({ hubs: [{ ...hub, features: ['view-lane', 'peers'] }] })).toEqual([
      { ...hub, features: ['peers'] },
    ]);
    expect(parseLiveAnswer({ hubs: [{ ...hub, features: 'peers' }] })).toEqual([{ ...hub, features: [] }]);
    expect(parseLiveAnswer({ hubs: [hub] })).toEqual([hub]);
  });
});

describe('the other live hubs a hub names', () => {
  const live = (port: number, client: string | null = 'Visual Studio Code') => ({
    url: `ws://127.0.0.1:${port}/piwi/hub`,
    token: `${'t'.repeat(30)}${port}`,
    pid: port,
    version: '0.67.0',
    client,
    roots: [`/work/${port}`],
    startedAt: '2026-10-25T10:00:00.000Z',
  });

  test('are the others, without their tokens, their names and folders cut to what a reader takes', () => {
    const own = live(43_001);
    const long = {
      ...live(43_002, 'C'.repeat(MAX_HUB_CLIENT + 50)),
      roots: Array.from({ length: 80 }, (_, i) => `/r${i}`),
    };
    const peers = hubPeersOf([own, long, live(43_003)], own.url);
    expect(peers.map((p) => p.url)).toEqual(['ws://127.0.0.1:43002/piwi/hub', 'ws://127.0.0.1:43003/piwi/hub']);
    expect(JSON.stringify(peers)).not.toContain('t'.repeat(30));
    expect(peers[0]!.client).toHaveLength(MAX_HUB_CLIENT);
    expect(peers[0]!.roots).toHaveLength(MAX_HUB_ROOTS);
    const many = Array.from({ length: MAX_HUB_PEERS + 5 }, (_, i) => live(44_000 + i));
    expect(hubPeersOf(many, own.url)).toHaveLength(MAX_HUB_PEERS);
  });

  test('are read by the extension field by field, on 127.0.0.1, leaving out an entry it cannot read', () => {
    const { token: _token, ...peer } = live(43_002);
    const message = { type: 'peers', hubs: [peer] };
    expect(parseHubMessage(json(message))).toEqual(message);
    expect(parseHubMessage(json({ type: 'peers', hubs: [{ ...peer, url: 'ws://localhost:43002/piwi/hub' }] }))).toEqual(
      message,
    );
    expect(
      parseHubMessage(
        json({ type: 'peers', hubs: [peer, { ...peer, url: 'ws://evil.test:1/piwi/hub' }, { ...peer, pid: 0 }, 'x'] }),
      ),
    ).toEqual(message);
    // A token a hub sends anyway is not kept.
    expect(parseHubMessage(json({ type: 'peers', hubs: [{ ...peer, token: 'h'.repeat(32) }] }))).toEqual(message);
    expect(parseHubMessage(json({ type: 'peers', hubs: [] }))).toEqual({ type: 'peers', hubs: [] });
    expect(parseHubMessage(json({ type: 'peers' }))).toBeNull();
    expect(
      parseHubMessage(json({ type: 'peers', hubs: Array.from({ length: MAX_HUB_PEERS + 1 }, () => peer) })),
    ).toBeNull();
  });

  test('come from a hub whose welcome lists them; a hub that predates the list lists none', () => {
    const welcome = { type: 'welcome', pid: 1, version: '1', client: null, roots: [], keepaliveMs: 1 };
    expect(parseHubMessage(json(welcome))).toEqual({ ...welcome, features: [] });
    expect(parseHubMessage(json({ ...welcome, features: ['dance', 'peers'] }))).toEqual({
      ...welcome,
      features: ['peers'],
    });
  });
});
