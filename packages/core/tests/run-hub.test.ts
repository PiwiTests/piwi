import { describe, expect, test } from 'vitest';
import type { EditorDiscovery } from '../src/editor-discovery';
import { MAX_STOP_ERROR } from '../src/run-channel';
import {
  HUB_CLOSE,
  HUB_KEEPALIVE_MS,
  HUB_PATH,
  MAX_HUB_CLIENT,
  MAX_HUB_COMMAND,
  MAX_HUB_FRAME,
  MAX_HUB_MESSAGE,
  MAX_HUB_PROJECT,
  MAX_HUB_ROOTS,
  MAX_HUB_WARNINGS,
  isExtensionOrigin,
  isHubHost,
  liveHubsOf,
  liveUrlOf,
  parseHubCommand,
  parseHubHello,
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

  test('reads the token of hello, and nothing else as one', () => {
    expect(parseHubHello(json({ type: 'hello', token: 'abc' }))).toBe('abc');
    for (const text of [json({ type: 'hello' }), json({ type: 'subscribe', id: 1, token: 'abc' }), 'abc', '{']) {
      expect(parseHubHello(text), text).toBeNull();
    }
    expect(parseHubHello(json({ type: 'hello', token: 'x'.repeat(300) }))).toBeNull();
  });

  test('reads each command field by field', () => {
    expect(parseHubCommand(json({ type: 'subscribe', id: 1 }))).toEqual({ type: 'subscribe', id: 1 });
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
      { type: 'runControl', ref: 'ed-1', action: 'end' },
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
      { type: '' },
      { type: 7 },
    ]) {
      expect(invalid(broken), JSON.stringify(broken)).toMatchObject({ type: 'invalid', id: 9 });
    }
    expect(invalid({ type: 'evaluate', code: 'alert(1)' })).toEqual({ type: 'unknown', id: 9, what: 'evaluate' });
  });

  test('refuses a command that answers a stop without naming it, and takes a pause without one', () => {
    const needsStop = { type: 'invalid', id: 9, message: 'The command needs the stop it answers.' };
    for (const action of ['step', 'resume', 'finish']) {
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
      { type: 'welcome', pid: 4242, version: '0.60.0', client: 'WebStorm', roots: ['/work/shop'], keepaliveMs: 20_000 },
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
      { type: 'keepalive' },
    ];
    for (const message of messages) expect(parseHubMessage(json(message))).toEqual(message);
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
    expect(
      parseHubMessage(
        json({
          type: 'session',
          session: { ...session, workers: [{ ...worker, intents: ['dance', 'mock', 'pick'] }] },
        }),
      ),
    ).toMatchObject({ session: { workers: [{ intents: ['pick', 'mock'] }] } });
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
    const worker = session.workers[0]!;
    for (const broken of [
      { type: 'answer', id: 1, ok: 'yes', message: '' },
      { type: 'answer', id: 1, ok: true, message: 'x', image: { mime: 'image/svg+xml', data: 'PHN2Zz4=' } },
      { type: 'answer', id: 1, ok: true, message: 'x', image: { mime: 'image/jpeg', data: '<svg>' } },
      { type: 'answer', id: 1, ok: true, message: 'x', requests: {} },
      { type: 'answer', id: 1, ok: true, message: 'x', requests: [{ id: 1, method: 'GET', url: 'u', status: 9 }] },
      { type: 'welcome', pid: 0, version: '1', client: null, roots: [], keepaliveMs: 1 },
      { type: 'session', session: { ...session, ref: 'ed 1' } },
      { type: 'session', session: { ...session, command: 5 } },
      { type: 'session', session: { ...session, workers: [{ ...worker, state: 'gone' }] } },
      { type: 'session', session: { ...session, workers: [{ ...worker, stop: { ...worker.stop, line: -1 } }] } },
      { type: 'session', session: { ...session, workers: [{ ...worker, test: { ...worker.test, title: [1] } }] } },
      { type: 'session', session: { ...session, command: 'x'.repeat(MAX_HUB_COMMAND + 1) } },
      { type: 'session', session: { ...session, project: 'x'.repeat(MAX_HUB_PROJECT + 1) } },
      { type: 'session', session: { ...session, workers: [{ ...worker, stop: { ...worker.stop, error: 5 } }] } },
      {
        type: 'session',
        session: {
          ...session,
          workers: [{ ...worker, stop: { ...worker.stop, error: 'x'.repeat(MAX_STOP_ERROR + 1) } }],
        },
      },
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
      if (heard?.type === 'frame') expect(heard.data.length).toBeLessThanOrEqual(MAX_VIEW_FRAME_BASE64);
    }
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
  });
});
