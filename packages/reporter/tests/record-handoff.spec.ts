import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IDE_RECORDER_BINDING,
  formatRecordChannel,
  lineReader,
  parseHandoffToEditor,
  type HandoffToEditor,
  type HandoffToTest,
} from '@piwitests/core/ide-recorder';
import { canRecordFromHere, handoffPlace, idleAnswer, recordFromHere } from '../src/internal/capture/record-handoff.js';

const TOKEN = 'record-token-0123456789';

/** An editor service on a socket of a fresh folder: it hears each line and answers through `reply`. */
async function startEditor(reply: (message: HandoffToEditor, send: (m: HandoffToTest) => void) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-handoff-'));
  const socketPath = path.join(dir, 'record.sock');
  const heard: HandoffToEditor[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    const send = (m: HandoffToTest) => socket.write(`${JSON.stringify(m)}\n`);
    socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseHandoffToEditor(line);
          if (!message) return;
          heard.push(message);
          reply(message, send);
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    heard,
    channel: formatRecordChannel({ path: socketPath, token: TOKEN }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A page and its context, as the relay uses them: the binding it exposes, the scripts it loads, what it evaluates. */
function fakePage(url = 'http://localhost:3000/cart') {
  const listeners = new Map<string, () => void>();
  const evaluated: unknown[] = [];
  let binding: ((source: unknown, payload: unknown) => unknown) | null = null;
  const mainFrame = {};
  const context = {
    exposeBinding: vi.fn(async (name: string, fn: (source: unknown, payload: unknown) => unknown) => {
      expect(name).toBe(IDE_RECORDER_BINDING);
      binding = fn;
    }),
    addInitScript: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  };
  const page = {
    context: () => context,
    mainFrame: () => mainFrame,
    evaluate: vi.fn(async (fn: unknown, arg?: unknown) => void evaluated.push(arg ?? fn)),
    url: () => url,
    once: (event: string, fn: () => void) => void listeners.set(event, fn),
    off: (event: string) => void listeners.delete(event),
  };
  const call = (payload: unknown, frame: unknown = mainFrame) => binding!({ page, frame }, payload);
  /** The page closes, or crashes. */
  const emit = (event: 'close' | 'crash') => listeners.get(event)?.();
  return { page, context, evaluated, call, emit };
}

const testInfo = { project: { use: { testIdAttribute: 'data-qa', baseURL: 'http://localhost:3000' } } };

describe('recording from a paused test', () => {
  let bundle: string;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-bundle-')), 'record-ide.js');
    fs.writeFileSync(bundle, 'globalThis.__loaded = true;');
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
  });

  it('asks the editor with where the test is paused, relays the recorder’s calls, and ends with the stop', async () => {
    const { page, context, evaluated, call } = fakePage();
    let answered: unknown = null;
    const editor = await startEditor((message, send) => {
      if (message.type === 'attach') send({ type: 'load', bundle });
      if (message.type === 'loaded') {
        void Promise.resolve(call({ kind: 'local-get', keys: 'piwiLanguage' })).then((value) => {
          answered = value;
          send({ type: 'dispatch', message: { type: 'piwi-recording-stopped' } });
          send({ type: 'stop' });
        });
      }
      if (message.type === 'binding') send({ type: 'answer', call: message.call, value: { piwiLanguage: 'fr' } });
    });
    try {
      const said = await recordFromHere({
        page: page as never,
        testInfo: testInfo as never,
        location: 'tests/cart.spec.ts:12:5',
        reason: 'breakpoint',
        channel: editor.channel,
      });
      expect(said).toBeNull();
      expect(editor.heard[0]).toEqual({
        type: 'attach',
        token: TOKEN,
        file: path.resolve('tests/cart.spec.ts'),
        line: 12,
        reason: 'breakpoint',
        testIdAttribute: 'data-qa',
        baseURL: 'http://localhost:3000',
      });
      expect(editor.heard.map((m) => m.type)).toEqual(['attach', 'loaded', 'binding']);
      expect(editor.heard[2]).toMatchObject({ outside: false, payload: { kind: 'local-get', keys: 'piwiLanguage' } });
      expect(answered).toEqual({ piwiLanguage: 'fr' });
      expect(context.addInitScript).toHaveBeenCalledWith({ path: bundle });
      // The bundle went into the document on screen, then the stop to the recorder there.
      expect(evaluated[0]).toBe('globalThis.__loaded = true;');
      expect(evaluated).toContainEqual(['__piwiIdeDispatch', { type: 'piwi-recording-stopped' }]);
      // Once over, the page is answered as outside a recording, and a call from another frame was never the recording's.
      expect(await call({ kind: 'message', message: { type: 'piwi-session-storage', op: 'get' } })).toEqual({
        ok: true,
        items: {},
      });
    } finally {
      await editor.close();
    }
  });

  it('exposes the binding once per context: a second recording in the same test relays to itself', async () => {
    const { page, context } = fakePage();
    const editor = await startEditor((message, send) => {
      if (message.type === 'attach') send({ type: 'load', bundle });
      if (message.type === 'loaded') send({ type: 'stop' });
    });
    try {
      const options = {
        page: page as never,
        testInfo: testInfo as never,
        location: 'tests/cart.spec.ts:12:5',
        reason: 'pause' as const,
        channel: editor.channel,
      };
      expect(await recordFromHere(options)).toBeNull();
      expect(await recordFromHere(options)).toBeNull();
      expect(context.exposeBinding).toHaveBeenCalledOnce();
      expect(context.addInitScript).toHaveBeenCalledOnce();
    } finally {
      await editor.close();
    }
  });

  it('removes the recorder from the documents loaded after a recording, where Playwright can', async () => {
    const { page, context } = fakePage();
    const dispose = vi.fn(async () => {});
    context.addInitScript.mockImplementation(async () => ({ dispose }) as never);
    const editor = await startEditor((message, send) => {
      if (message.type === 'attach') send({ type: 'load', bundle });
      if (message.type === 'loaded') send({ type: 'stop' });
    });
    try {
      const options = {
        page: page as never,
        testInfo: testInfo as never,
        location: 'tests/cart.spec.ts:12:5',
        reason: 'pause' as const,
        channel: editor.channel,
      };
      expect(await recordFromHere(options)).toBeNull();
      expect(dispose).toHaveBeenCalledOnce();
      // The next recording loads it again, for its own time.
      expect(await recordFromHere(options)).toBeNull();
      expect(context.addInitScript).toHaveBeenCalledTimes(2);
      expect(dispose).toHaveBeenCalledTimes(2);
      expect(context.exposeBinding).toHaveBeenCalledOnce();
    } finally {
      await editor.close();
    }
  });

  it('records http(s) pages only, and says so to the editor before it gives the page back', async () => {
    const { page, context } = fakePage('about:blank');
    const editor = await startEditor((message, send) => {
      if (message.type === 'attach') send({ type: 'load', bundle });
    });
    try {
      const said = await recordFromHere({
        page: page as never,
        testInfo: testInfo as never,
        location: 'tests/cart.spec.ts:12:5',
        reason: 'pause',
        channel: editor.channel,
      });
      expect(said).toBe('the recorder records http(s) pages only, and this page is about:blank.');
      await vi.waitFor(() => expect(editor.heard.map((m) => m.type)).toEqual(['attach', 'notice']));
      expect(editor.heard[1]).toEqual({
        type: 'notice',
        message: 'Nothing can be recorded here: the recorder records http(s) pages only, and this page is about:blank.',
      });
      expect(context.exposeBinding).not.toHaveBeenCalled();
    } finally {
      await editor.close();
    }
  });

  it('ends at once when the page closes before the editor takes the recording', async () => {
    const { page, emit } = fakePage();
    const editor = await startEditor((message) => {
      if (message.type === 'attach') emit('close');
    });
    try {
      const said = await recordFromHere({
        page: page as never,
        testInfo: testInfo as never,
        location: 'tests/cart.spec.ts:12:5',
        reason: 'breakpoint',
        channel: editor.channel,
      });
      expect(said).toBe('the page closed.');
      await vi.waitFor(() => expect(editor.heard.map((m) => m.type)).toEqual(['attach', 'closed']));
    } finally {
      await editor.close();
    }
  });

  it('ends with the test: the recorder in the page stops, the editor hears it closed, and none starts after', async () => {
    const { page, evaluated } = fakePage();
    const ended = new AbortController();
    const editor = await startEditor((message, send) => {
      if (message.type === 'attach') send({ type: 'load', bundle });
      if (message.type === 'loaded') ended.abort('ended');
    });
    const options = {
      page: page as never,
      testInfo: testInfo as never,
      location: 'tests/cart.spec.ts:12:5',
      reason: 'breakpoint' as const,
      channel: editor.channel,
      ended: ended.signal,
    };
    try {
      expect(await recordFromHere(options)).toBeNull();
      expect(evaluated).toContainEqual(['__piwiIdeDispatch', { type: 'piwi-recording-stopped' }]);
      await vi.waitFor(() => expect(editor.heard.map((m) => m.type)).toEqual(['attach', 'loaded', 'closed']));
      expect(await recordFromHere(options)).toBe('the test ended.');
      expect(editor.heard).toHaveLength(3);
    } finally {
      await editor.close();
    }
  });

  it('says why when the editor does not take the recording, or cannot be reached', async () => {
    const { page } = fakePage();
    const editor = await startEditor((message, send) => {
      if (message.type === 'attach') send({ type: 'refused', message: 'no editor window holds tests/cart.spec.ts.' });
    });
    try {
      const options = {
        page: page as never,
        testInfo: testInfo as never,
        location: 'tests/cart.spec.ts:12:5',
        reason: 'breakpoint' as const,
      };
      expect(await recordFromHere({ ...options, channel: editor.channel })).toBe(
        'no editor window holds tests/cart.spec.ts.',
      );
      expect(await recordFromHere({ ...options, channel: `/nonexistent/piwi.sock#${TOKEN}` })).toMatch(
        /^the editor could not be reached: /,
      );
      expect(await recordFromHere({ ...options, channel: 'nothing' })).toBe('this run names no editor to record into.');
    } finally {
      await editor.close();
    }
  });

  it('reads where a call site is, and whether the run can record', () => {
    expect(handoffPlace('tests/a.spec.ts:3:7', '/w')).toEqual({ file: path.resolve('/w', 'tests/a.spec.ts'), line: 3 });
    expect(handoffPlace('nowhere')).toBeNull();
    expect(canRecordFromHere(`/tmp/x.sock#${TOKEN}`)).toBe(true);
    expect(canRecordFromHere(undefined)).toBe(false);
    expect(idleAnswer({ kind: 'local-get', keys: null })).toEqual({});
    expect(idleAnswer({ kind: 'message', message: { type: 'piwi-append-recording-event' } })).toMatchObject({
      ok: false,
    });
  });
});
