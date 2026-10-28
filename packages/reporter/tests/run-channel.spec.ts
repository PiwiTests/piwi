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
  editorShows,
  hideRunChannel,
  holdStop,
  openRunChannel,
  runChannelOpen,
  type RunControl,
  type StopToHold,
} from '../src/internal/capture/run-channel.js';
import { keepResponse, startKeeping, stopKeeping } from '../src/internal/capture/kept-responses.js';

/** A finished request of the page, as Playwright hands it. */
function fakeRequest(resourceType: string, method: string, url: string) {
  return { resourceType: () => resourceType, method: () => method, url: () => url } as never;
}

/** Its response, with a body. */
function fakeResponse(status: number, body: string | Buffer, headers: Record<string, string> = {}) {
  return {
    status: () => status,
    headers: () => ({ 'content-type': 'application/json; charset=utf-8', ...headers }),
    body: async () => (Buffer.isBuffer(body) ? body : Buffer.from(body)),
  } as never;
}

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

  it('names the run by PIWI_RUN_REF when the launcher sets it, PIWI_ORIGIN_REF naming what it was launched for', async () => {
    const hub = await startHub();
    try {
      const { control } = handlers();
      expect(
        await openRunChannel(WORKER, control, { ...hub.env, PIWI_ORIGIN_REF: '42', PIWI_RUN_REF: 'desktop-7' }),
      ).toBe(true);
      expect(await until(() => hub.heard[0])).toMatchObject({ type: 'run-attach', ref: 'desktop-7' });
      closeRunChannel();
      // A name the hub could not read opens nothing, whatever PIWI_ORIGIN_REF says.
      expect(await openRunChannel(WORKER, control, { ...hub.env, PIWI_RUN_REF: 'job:ab12' })).toBe(false);
    } finally {
      await hub.close();
    }
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

  it('holds a failure only for an editor that says it shows one, as one that predates it does not', async () => {
    const hub = await startHub();
    try {
      const { control } = handlers();
      expect(await openRunChannel(WORKER, control, hub.env)).toBe(true);
      await until(() => hub.heard[0]);
      expect(editorShows('failure')).toBe(false);
      hub.send({ type: 'attached', holds: ['failure'] });
      await until(() => (editorShows('failure') ? true : undefined));
      // A connection opened again starts from nothing.
      closeRunChannel();
      expect(editorShows('failure')).toBe(false);
      expect(await openRunChannel(WORKER, control, hub.env)).toBe(true);
      hub.send({ type: 'attached', holds: [] });
      await new Promise((r) => setTimeout(r, 50));
      expect(editorShows('failure')).toBe(false);
    } finally {
      await hub.close();
    }
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
        takes: ['pick', 'record', 'assert', 'assert-region', 'requests', 'mock', 'locator', 'view', 'input', 'input-clicks', 'pick-at', 'agent', 'events', 'bind'],
        holds: ['failure'],
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

  it('lists the responses the test kept and hands over the one to mock, at the stop the editor names', async () => {
    const hub = await startHub();
    try {
      expect(await openRunChannel(WORKER, handlers().control, hub.env)).toBe(true);
      startKeeping(Date.now() - 1000);
      await keepResponse(
        fakeRequest('fetch', 'POST', 'https://shop.test/api/cart'),
        fakeResponse(201, '{"id":7}', { 'content-length': '8' }),
      );
      const held = holdStop(STOP, () => {});
      const { stop } = (await until(() => hub.heard.find((m) => m.type === 'stopped'))) as { stop: number };
      const answers = () => hub.heard.filter((m) => m.type === 'answer');
      hub.send({ type: 'request', request: 1, what: 'requests', stop });
      hub.send({ type: 'request', request: 2, what: 'mock', stop, id: 1 });
      hub.send({ type: 'request', request: 3, what: 'mock', stop, id: 9 });
      hub.send({ type: 'request', request: 4, what: 'requests', stop: stop + 1 });
      hub.send({ type: 'request', request: 5, what: 'locator', stop, locator: "getByText('Pay')" });
      await until(() => (answers().length === 5 ? true : undefined));
      const byRequest = (n: number) => answers().find((a) => a.request === n);
      expect(byRequest(1)).toEqual({
        type: 'answer',
        request: 1,
        what: 'requests',
        value: {
          ok: true,
          message: 'The test kept 1 response.',
          requests: [
            {
              id: 1,
              method: 'POST',
              url: 'https://shop.test/api/cart',
              status: 201,
              type: 'application/json',
              size: 8,
              time: expect.any(Number),
            },
          ],
        },
      });
      expect(byRequest(2)).toEqual({
        type: 'answer',
        request: 2,
        what: 'mock',
        value: {
          ok: true,
          message: 'POST https://shop.test/api/cart',
          response: {
            method: 'POST',
            url: 'https://shop.test/api/cart',
            status: 201,
            type: 'application/json',
            body: '{"id":7}',
          },
        },
      });
      expect(byRequest(3)).toMatchObject({ value: { ok: false, response: null } });
      expect(byRequest(4)).toMatchObject({ value: { ok: false, message: 'The test went on.', requests: [] } });
      // A stop without a page counts nothing.
      expect(byRequest(5)).toEqual({
        type: 'answer',
        request: 5,
        what: 'locator',
        value: { ok: false, message: 'This stop has no page to count on.', count: null },
      });
      await held.release();
    } finally {
      stopKeeping();
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

  it('says why a viewer’s input could not be played without the credentials of the address the page names', async () => {
    const hub = await startHub();
    try {
      expect(await openRunChannel(WORKER, handlers().control, hub.env)).toBe(true);
      const secret = ['s3cr3t', 'value', 'here'].join('-');
      const page = {
        viewportSize: () => ({ width: 800, height: 600 }),
        once: () => {},
        off: () => {},
        isClosed: () => false,
        screencast: { start: async () => ({ dispose: async () => {} }) },
        mouse: {
          click: async () => {
            throw new Error(`Navigation to https://shop.test/cart?token=${secret} was interrupted`);
          },
        },
      };
      const held = holdStop({ ...STOP, page: page as never }, () => {});
      const { stop } = (await until(() => hub.heard.find((m) => m.type === 'stopped'))) as { stop: number };
      const answers = () => hub.heard.filter((m) => m.type === 'answer');
      hub.send({ type: 'request', request: 1, what: 'view', stop, on: true });
      expect(await until(() => answers()[0])).toMatchObject({ what: 'view', value: { ok: true } });
      hub.send({
        type: 'request',
        request: 2,
        what: 'input',
        stop,
        events: [{ type: 'mouse', action: 'click', x: 10, y: 20, button: 'left', clickCount: 1 }],
      });
      const played = (await until(() => answers()[1])) as { value: { ok: boolean; message: string } };
      expect(played.value.ok).toBe(false);
      expect(played.value.message).toMatch(/^Event 1 could not be played: .*https:\/\/shop\.test\/cart\?token=/);
      expect(played.value.message).not.toContain(secret);
      held.release();
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
