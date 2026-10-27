import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatRecordChannel, lineReader } from '@piwitests/core/ide-recorder';
import { parseRunToHub, type HubToRun, type Place, type RunToHub } from '@piwitests/core/run-channel';
import {
  closeRunChannel,
  editorSendAddress,
  hideRunChannel,
  holdStop,
  openRunChannel,
  runChannelOpen,
  type RunControl,
  type StopToHold,
} from '../src/internal/capture/run-channel.js';

const TOKEN = 'run-token-0123456789abcdef';
const WORKER = { workerIndex: 2, parallelIndex: 1, config: { version: '1.64.1' } } as never;

/** An editor service on a socket of a fresh folder: what it heard from the worker, and its side of the connection. */
async function startHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-run-channel-'));
  const socketPath = path.join(dir, 'channel.sock');
  const heard: RunToHub[] = [];
  let worker: net.Socket | null = null;
  const server = net.createServer((socket) => {
    worker = socket;
    socket.setEncoding('utf8');
    socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseRunToHub(line);
          if (message) heard.push(message);
        },
        () => socket.destroy(),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    heard,
    env: { PIWI_RUN_CHANNEL: formatRecordChannel({ path: socketPath, token: TOKEN }), PIWI_ORIGIN_REF: 'ed-12345678' },
    send: (message: HubToRun | { type: string; [key: string]: unknown }) =>
      worker!.write(`${JSON.stringify(message)}\n`),
    drop: () => worker?.destroy(),
    close: async () => {
      worker?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function until<T>(read: () => T | undefined): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - start > 3000) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function handlers() {
  const asked: string[] = [];
  const control: RunControl = {
    pause: () => void asked.push('pause'),
    breakpoints: (places: Place[]) => void asked.push(`breakpoints ${places.map((p) => p.line).join(',')}`),
    runTo: (place: Place) => void asked.push(`run-to ${place.file}:${place.line}`),
  };
  return { asked, control };
}

const STOP: StopToHold = {
  reason: 'breakpoint',
  title: "Click getByRole('button')",
  place: { file: 'tests/a.spec.ts', line: 4, column: 9 },
  locator: "getByRole('button')",
  bar: false,
  page: null,
};

describe('the worker’s run connection', () => {
  afterEach(() => closeRunChannel());

  it('opens only for a run that names a channel and a ref, and leaves the run as it is when nothing answers', async () => {
    const { control } = handlers();
    expect(await openRunChannel(WORKER, control, {})).toBe(false);
    expect(
      await openRunChannel(WORKER, control, {
        PIWI_RUN_CHANNEL: formatRecordChannel({ path: '/nowhere/channel.sock', token: TOKEN }),
      }),
    ).toBe(false);
    const missing = path.join(os.tmpdir(), `piwi-missing-${process.pid}.sock`);
    expect(
      await openRunChannel(WORKER, control, {
        PIWI_RUN_CHANNEL: formatRecordChannel({ path: missing, token: TOKEN }),
        PIWI_ORIGIN_REF: 'ed-12345678',
      }),
    ).toBe(false);
    expect(runChannelOpen()).toBe(false);
  });

  it('takes the channel and the editor’s pairing out of the environment while a test runs, and puts them back after', () => {
    const pairing = 'http://127.0.0.1:47211/piwi/send#abcdefghijklmnop_1234';
    const env: NodeJS.ProcessEnv = { PIWI_RUN_CHANNEL: 'a#b', PIWI_RECORD_CHANNEL: 'a#b', PIWI_EDITOR_SEND: pairing };
    const show = hideRunChannel(env);
    expect(env).toEqual({ PIWI_RECORD_CHANNEL: 'a#b' });
    // The test's picks still go to the pairing.
    expect(editorSendAddress(env)).toBe(pairing);
    show();
    expect(env).toEqual({ PIWI_RUN_CHANNEL: 'a#b', PIWI_RECORD_CHANNEL: 'a#b', PIWI_EDITOR_SEND: pairing });
    expect(editorSendAddress(env)).toBe(pairing);
    const none: NodeJS.ProcessEnv = {};
    hideRunChannel(none)();
    expect(none).toEqual({});
    expect(editorSendAddress(none)).toBeUndefined();
  });

  it('attaches first, holds a stop until the editor answers it, once, and says when it ended', async () => {
    const hub = await startHub();
    try {
      const { asked, control } = handlers();
      expect(await openRunChannel(WORKER, control, hub.env)).toBe(true);
      expect(await until(() => hub.heard[0])).toEqual({
        type: 'run-attach',
        token: TOKEN,
        ref: 'ed-12345678',
        cwd: process.cwd(),
        workerIndex: 2,
        parallelIndex: 1,
        pid: process.pid,
        playwright: '1.64.1',
        reporter: expect.any(String),
        takes: ['pick', 'record'],
      });
      const answers: string[] = [];
      const held = holdStop(STOP, (answer) => void answers.push(answer));
      const stopped = await until(() => hub.heard.find((m) => m.type === 'stopped'));
      expect(stopped).toEqual({
        type: 'stopped',
        stop: expect.any(Number),
        reason: 'breakpoint',
        title: STOP.title,
        place: STOP.place,
        locator: STOP.locator,
        bar: false,
      });
      const stop = (stopped as { stop: number }).stop;
      // A pause while stopped, and an answer to another stop, change nothing.
      hub.send({ type: 'control', action: 'pause' });
      hub.send({ type: 'control', action: 'resume', stop: stop + 1 });
      hub.send({ type: 'run-to', stop, place: { file: 'tests/a.spec.ts', line: 9 } });
      hub.send({ type: 'control', action: 'step', stop });
      await until(() => answers[0]);
      await new Promise((r) => setTimeout(r, 50));
      expect(answers).toEqual(['resume']);
      expect(asked).toEqual(['run-to tests/a.spec.ts:9']);
      held.release();
      expect(await until(() => hub.heard.find((m) => m.type === 'running'))).toEqual({ type: 'running', stop });

      hub.send({ type: 'control', action: 'pause' });
      hub.send({ type: 'breakpoints', places: [{ file: 'tests/a.spec.ts', line: 3 }] });
      await until(() => (asked.length === 3 ? true : undefined));
      expect(asked.slice(1)).toEqual(['pause', 'breakpoints 3']);
    } finally {
      await hub.close();
    }
  });

  it('starts an intent at the stop it names, through the bar, and refuses one at another stop or without a bar', async () => {
    const hub = await startHub();
    try {
      expect(await openRunChannel(WORKER, handlers().control, hub.env)).toBe(true);
      const intents: string[] = [];
      const held = holdStop({ ...STOP, bar: true, intent: (what) => (intents.push(what), { ok: true, message: `${what} started` }) }, () => {});
      const { stop } = (await until(() => hub.heard.find((m) => m.type === 'stopped'))) as { stop: number };
      const answers = () => hub.heard.filter((m) => m.type === 'answer');
      hub.send({ type: 'request', request: 1, what: 'pick', stop });
      hub.send({ type: 'request', request: 2, what: 'record', stop: stop + 1 });
      await until(() => (answers().length === 2 ? true : undefined));
      expect(answers()).toEqual([
        { type: 'answer', request: 1, what: 'pick', value: { ok: true, message: 'pick started' } },
        { type: 'answer', request: 2, what: 'record', value: { ok: false, message: 'The test went on.' } },
      ]);
      expect(intents).toEqual(['pick']);
      held.release();
      hub.send({ type: 'request', request: 3, what: 'pick', stop });
      expect(await until(() => answers()[2])).toMatchObject({ value: { ok: false, message: 'The test went on.' } });

      // A stop no bar shows has no window to pick in.
      holdStop(STOP, () => {});
      const headless = (await until(() => hub.heard.filter((m) => m.type === 'stopped')[1])) as { stop: number };
      hub.send({ type: 'request', request: 4, what: 'record', stop: headless.stop });
      expect(await until(() => answers()[3])).toEqual({
        type: 'answer',
        request: 4,
        what: 'record',
        value: {
          ok: false,
          message: "Record here needs the pause bar in the test's window, and this stop shows none: run the test headed.",
        },
      });
    } finally {
      await hub.close();
    }
  });

  it('answers a request with no image when not stopped, and a message it does not know with a notice', async () => {
    const hub = await startHub();
    try {
      expect(await openRunChannel(WORKER, handlers().control, hub.env)).toBe(true);
      hub.send({ type: 'request', request: 3, what: 'image' });
      expect(await until(() => hub.heard.find((m) => m.type === 'answer'))).toEqual({
        type: 'answer',
        request: 3,
        what: 'image',
        value: null,
      });
      hub.send({ type: 'control', action: 'end', stop: 1 });
      expect(await until(() => hub.heard.find((m) => m.type === 'notice'))).toEqual({
        type: 'notice',
        message: expect.stringMatching(/^@piwitests\/reporter .* does not take the editor's control end: update it\.$/),
      });
    } finally {
      await hub.close();
    }
  });

  it('lets a stop no bar shows go on when the connection closes, and leaves one the bar shows to the bar', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const hub = await startHub();
    try {
      expect(await openRunChannel(WORKER, handlers().control, hub.env)).toBe(true);
      const answers: string[] = [];
      holdStop({ ...STOP, bar: true }, (answer) => void answers.push(`bar ${answer}`));
      await until(() => hub.heard.find((m) => m.type === 'stopped'));
      hub.drop();
      await until(() => (runChannelOpen() ? undefined : true));
      expect(answers).toEqual([]);

      expect(await openRunChannel(WORKER, handlers().control, hub.env)).toBe(true);
      holdStop(STOP, (answer) => void answers.push(answer));
      await until(() => hub.heard.filter((m) => m.type === 'stopped')[1]);
      hub.drop();
      expect(await until(() => answers[0])).toBe('resume');
      expect(log).toHaveBeenCalledWith('[piwi] The connection to the editor closed: the test goes on.');
      // Without the connection, a stop no bar shows goes on at once.
      const later: string[] = [];
      holdStop(STOP, (answer) => void later.push(answer));
      expect(later).toEqual(['resume']);
    } finally {
      log.mockRestore();
      await hub.close();
    }
  });
});
