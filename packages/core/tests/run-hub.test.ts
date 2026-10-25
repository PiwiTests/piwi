import { describe, expect, test } from 'vitest';
import type { EditorDiscovery } from '../src/editor-discovery';
import {
  HUB_CLOSE,
  HUB_KEEPALIVE_MS,
  HUB_PATH,
  MAX_HUB_FRAME,
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
      intents: ['pick', 'record'],
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
    for (const type of ['pick', 'record'] as const) {
      expect(parseHubCommand(json({ type, id: 5, ref: 'ed-1', since: 'S' }))).toEqual({
        type,
        id: 5,
        ref: 'ed-1',
        worker: null,
        since: 'S',
      });
    }
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
      { type: '' },
      { type: 7 },
    ]) {
      expect(invalid(broken), JSON.stringify(broken)).toMatchObject({ type: 'invalid', id: 9 });
    }
    expect(invalid({ type: 'evaluate', code: 'alert(1)' })).toEqual({ type: 'unknown', id: 9, what: 'evaluate' });
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
    ).toMatchObject({ session: { workers: [{ stop: { reason: 'other' } }] } });
    expect(
      parseHubMessage(
        json({ type: 'session', session: { ...session, workers: [{ ...worker, intents: ['assert', 'pick'] }] } }),
      ),
    ).toMatchObject({ session: { workers: [{ intents: ['pick'] }] } });
  });

  test('has the extension refuse a message it cannot read', () => {
    const worker = session.workers[0]!;
    for (const broken of [
      { type: 'answer', id: 1, ok: 'yes', message: '' },
      { type: 'answer', id: 1, ok: true, message: 'x', image: { mime: 'image/svg+xml', data: 'PHN2Zz4=' } },
      { type: 'answer', id: 1, ok: true, message: 'x', image: { mime: 'image/jpeg', data: '<svg>' } },
      { type: 'welcome', pid: 0, version: '1', client: null, roots: [], keepaliveMs: 1 },
      { type: 'session', session: { ...session, ref: 'ed 1' } },
      { type: 'session', session: { ...session, command: 5 } },
      { type: 'session', session: { ...session, workers: [{ ...worker, state: 'gone' }] } },
      { type: 'session', session: { ...session, workers: [{ ...worker, stop: { ...worker.stop, line: -1 } }] } },
      { type: 'session', session: { ...session, workers: [{ ...worker, test: { ...worker.test, title: [1] } }] } },
      { type: 'frame', data: 'x' },
    ]) {
      expect(parseHubMessage(json(broken)), JSON.stringify(broken)).toBeNull();
    }
    expect(parseHubMessage('not json')).toBeNull();
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
