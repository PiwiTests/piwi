/**
 * The desktop build's hub of the runs its shell starts, driven as its three sides drive it: a fake worker on the run
 * channel the shell names in a run's environment, Piwi Picker's WebSocket with the desktop token, and the app's window
 * as a peer of the hub (its stream and its commands).
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { WebSocket } from 'ws';
import { parsePairing } from '@piwitests/core/editor-send';
import { lineReader, parseRecordChannel } from '@piwitests/core/ide-recorder';
import { parseHubToRun, type HubToRun, type RunToHub } from '@piwitests/core/run-channel';
import {
  parseHubMessage,
  parseLiveAnswer,
  type HubAnswer,
  type HubMessage,
  type HubSession,
} from '@piwitests/core/run-hub';
import { DESKTOP_HUB_CLIENT, DesktopRuns, insideFolder } from '../../server/utils/desktop-runs';
import { isBrowserRequest, isOpenDesktopRoute } from '../../server/utils/desktop-access';
import { DESKTOP_PICKS_PATH, type DesktopRunCommand, type DesktopRunEvent } from '#shared/desktop-runs';

const TOKEN = `pd_${'ab'.repeat(32)}`;
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const SPEC =
  "import { test, expect } from '@playwright/test';\n\ntest('pays', async ({ page }) => {\n  await page.goto('/');\n  await page.getByRole('button', { name: 'Pay' }).click();\n});\n";

let folder = '';
let worktree = '';
let runs: DesktopRuns;
let channel: { path: string; token: string };

async function waitFor<T>(read: () => T | undefined | false | null, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false && value !== null) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A worker of a run on its run connection: what it heard, and what it sends. */
class Worker {
  readonly heard: HubToRun[] = [];
  readonly socket: net.Socket;
  readonly closed: Promise<void>;

  constructor(private readonly cwd: string) {
    this.socket = net.connect(channel.path);
    this.socket.setEncoding('utf8');
    this.socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseHubToRun(line);
          if (message && message.type !== 'unknown') this.heard.push(message);
        },
        () => this.socket.destroy(),
      ),
    );
    this.closed = new Promise((resolve) => this.socket.on('close', () => resolve()));
  }

  send(message: RunToHub): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  attach(ref: string, token = channel.token, workerIndex = 0): this {
    this.send({
      type: 'run-attach',
      token,
      ref,
      cwd: this.cwd,
      workerIndex,
      parallelIndex: workerIndex,
      pid: process.pid,
      playwright: '1.64.1',
      reporter: '0.62.0',
      takes: ['pick', 'record', 'assert', 'assert-region', 'requests', 'mock', 'view', 'input', 'pick-at'],
      holds: ['failure'],
    });
    return this;
  }

  begin(): void {
    this.send({
      type: 'test-begin',
      testId: 'id-pays',
      title: ['checkout', 'pays'],
      file: 'tests/checkout.spec.ts',
      line: 3,
      project: 'chromium',
      retry: 0,
      cannotPause: null,
    });
  }

  stop(stop: number, reason: 'page-pause' | 'failure' = 'page-pause', bar = false): void {
    this.send({
      type: 'stopped',
      stop,
      reason,
      title: "Click getByRole('button', { name: 'Pay' })",
      place: { file: 'tests/checkout.spec.ts', line: 5, column: 3 },
      locator: "getByRole('button', { name: 'Pay' })",
      bar,
      ...(reason === 'failure' ? { error: 'Error: expect(locator).toBeVisible() failed' } : {}),
    });
  }

  next<T extends HubToRun['type']>(type: T, after = 0): Promise<Extract<HubToRun, { type: T }>> {
    return waitFor(() => this.heard.filter((m) => m.type === type)[after] as Extract<HubToRun, { type: T }>);
  }

  /** The request of `what` asked of it, after `after` of them. */
  request(what: string, after = 0): Promise<Extract<HubToRun, { type: 'request' }>> {
    return waitFor(
      () =>
        this.heard.filter((m): m is Extract<HubToRun, { type: 'request' }> => m.type === 'request' && m.what === what)[
          after
        ],
    );
  }
}

/** The window's stream, as a peer of the hub: what it heard. */
interface Window {
  viewer: string;
  events: DesktopRunEvent[];
  closed: boolean;
  close(): void;
  /** A command of the window's, as the route takes it, its stream named; a field left out to see it refused. */
  command(command: Partial<Omit<DesktopRunCommand, 'viewer'>> & Record<string, unknown>): Promise<HubAnswer | null>;
  session(ref: string): HubSession | undefined;
}

async function openWindow(): Promise<Window> {
  const events: DesktopRunEvent[] = [];
  const state = { closed: false };
  const opened = await runs.openWindow({
    send: (event) => void events.push(JSON.parse(JSON.stringify(event)) as DesktopRunEvent),
    buffered: () => 0,
    close: () => {
      state.closed = true;
    },
  });
  if (!opened) throw new Error('no window');
  return {
    viewer: opened.viewer,
    events,
    get closed() {
      return state.closed;
    },
    close: opened.close,
    command: (command) => runs.command({ viewer: opened.viewer, ...command }),
    session: (ref) =>
      events
        .filter(
          (e): e is Extract<DesktopRunEvent, { type: 'session' }> => e.type === 'session' && e.session.ref === ref,
        )
        .pop()?.session,
  };
}

/** Piwi Picker's connection to the hub, as a browser opens it. */
interface Picker {
  socket: WebSocket;
  messages: HubMessage[];
  closed: Promise<{ code: number }>;
  send(message: unknown): void;
  answer(id: number): Promise<HubAnswer>;
  session(ref: string): HubSession | undefined;
}

function hubUrl(): string {
  return runs.live()[0]!.url;
}

function connect(headers: { host?: string; origin?: string | null } = {}): Promise<Picker | number> {
  const origin = headers.origin === undefined ? ORIGIN : headers.origin;
  const socket = new WebSocket(hubUrl(), {
    headers: headers.host ? { host: headers.host } : {},
    ...(origin ? { origin } : {}),
  });
  const messages: HubMessage[] = [];
  socket.on('message', (data) => {
    const message = parseHubMessage(String(data));
    if (message) messages.push(message);
  });
  const closed = new Promise<{ code: number }>((resolve) => socket.on('close', (code) => resolve({ code })));
  return new Promise((resolve) => {
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    socket.on('error', () => {});
    socket.on('open', () =>
      resolve({
        socket,
        messages,
        closed,
        send: (message) => socket.send(JSON.stringify(message)),
        answer: (id) => waitFor(() => messages.find((m): m is HubAnswer => m.type === 'answer' && m.id === id)),
        session: (ref) =>
          messages
            .filter((m): m is Extract<HubMessage, { type: 'session' }> => m.type === 'session' && m.session.ref === ref)
            .pop()?.session,
      }),
    );
  });
}

async function paired(): Promise<Picker> {
  const picker = (await connect()) as Picker;
  picker.send({ type: 'hello', token: TOKEN });
  await waitFor(() => picker.messages.find((m) => m.type === 'welcome'));
  return picker;
}

beforeAll(async () => {
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-desktop-runs-')));
  worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-desktop-worktree-')));
  fs.mkdirSync(path.join(folder, 'tests'));
  fs.writeFileSync(path.join(folder, 'tests', 'checkout.spec.ts'), SPEC);
  fs.mkdirSync(path.join(worktree, 'tests'));
  fs.writeFileSync(path.join(worktree, 'tests', 'checkout.spec.ts'), SPEC);
  runs = await DesktopRuns.start({
    token: TOKEN,
    version: '0.62.0',
    links: () => [{ id: 3, path: folder }],
    projectName: async (id) => (id === 3 ? 'Shop' : null),
    keepaliveMs: 200,
    helloMs: 300,
    lingerMs: 50,
    requestMs: 2000,
  });
  channel = parseRecordChannel(runs.runChannel!)!;
});

afterAll(() => {
  runs?.close();
  fs.rmSync(folder, { recursive: true, force: true });
  fs.rmSync(worktree, { recursive: true, force: true });
});

describe('the run channel the shell names in a run', () => {
  it('is a socket only this user reaches, with a token of its own, apart from the desktop token', () => {
    expect(channel.token).toMatch(/^[\w-]{32}$/);
    expect(channel.token).not.toBe(TOKEN);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(channel.path)).mode & 0o077).toBe(0);
      expect(fs.statSync(channel.path).isSocket()).toBe(true);
    }
  });

  it('takes a worker with its token, and closes one with another token or none', async () => {
    const window = await openWindow();
    const stranger = new Worker(folder).attach('desktop-90', 'x'.repeat(32));
    await stranger.closed;
    const raw = net.connect(channel.path);
    raw.write('{"type":"hello"}\n');
    await new Promise((resolve) => raw.on('close', resolve));
    await sleep(50);
    expect(window.session('desktop-90')).toBeUndefined();

    const worker = new Worker(folder).attach('desktop-1');
    // The hub shows a failure, so it says so to a worker that holds one only for a hub that does.
    expect(await worker.next('attached')).toEqual({ type: 'attached', holds: ['failure'] });
    worker.begin();
    const session = await waitFor(() => window.session('desktop-1')?.workers[0]?.test ?? undefined);
    expect(session.title).toEqual(['checkout', 'pays']);
    expect(window.session('desktop-1')).toMatchObject({
      root: folder,
      label: path.basename(folder),
      command: null,
    });
    // The project's name, read once, comes with the next change.
    worker.send({ type: 'test-end', testId: 'id-pays', status: 'passed', pausedMs: 0 });
    await waitFor(() => window.session('desktop-1')?.project === 'Shop');
    worker.socket.destroy();
    await waitFor(() => window.session('desktop-1')?.ended);
    window.close();
  });
});

describe('the hub Piwi Picker reaches', () => {
  it('is named by GET /api/desktop/live as an editor’s live endpoint names its hubs, with the desktop token', () => {
    const hubs = parseLiveAnswer({ hubs: runs.live() });
    expect(hubs).toEqual([
      {
        url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/piwi\/hub$/),
        token: TOKEN,
        pid: process.pid,
        version: '0.62.0',
        client: DESKTOP_HUB_CLIENT,
        roots: [folder],
        startedAt: expect.stringMatching(/^\d{4}-/),
      },
    ]);
  });

  it('opens only for an extension that names it as this machine, and after hello with the desktop token', async () => {
    const port = new URL(hubUrl()).port;
    expect(await connect({ origin: 'http://127.0.0.1:3000' })).toBe(403);
    expect(await connect({ origin: null })).toBe(403);
    expect(await connect({ host: `evil.example:${port}` })).toBe(403);
    expect(await connect({ host: `localhost:${port}` })).not.toBeTypeOf('number');

    const wrong = (await connect()) as Picker;
    wrong.send({ type: 'hello', token: `pd_${'cd'.repeat(32)}` });
    expect((await wrong.closed).code).toBe(4001);
    // The run channel's token is not the hub's.
    const other = (await connect()) as Picker;
    other.send({ type: 'hello', token: channel.token });
    expect((await other.closed).code).toBe(4001);
    const silent = (await connect()) as Picker;
    expect((await silent.closed).code).toBe(4002);

    const picker = await paired();
    expect(picker.messages.find((m) => m.type === 'welcome')).toEqual({
      type: 'welcome',
      pid: process.pid,
      version: '0.62.0',
      client: DESKTOP_HUB_CLIENT,
      roots: [folder],
      keepaliveMs: 200,
    });
    // Its keepalive, and its closed set of commands.
    await waitFor(() => picker.messages.find((m) => m.type === 'keepalive'));
    picker.send({ type: 'evaluate', id: 4, code: 'process.exit()' });
    expect(await picker.answer(4)).toMatchObject({ ok: false, message: 'Piwi does not know the command "evaluate".' });
    picker.socket.send('not json');
    expect((await picker.closed).code).toBe(4003);
  });

  it('pauses, steps and resumes a desktop run, with the image of its stop, as for an editor’s run', async () => {
    const picker = await paired();
    onTestFinished(() => picker.socket.close());
    picker.send({ type: 'subscribe', id: 1 });
    await picker.answer(1);
    const worker = new Worker(folder).attach('desktop-2');
    worker.begin();
    await waitFor(() => picker.session('desktop-2')?.workers[0]?.state === 'running');
    picker.send({ type: 'runControl', id: 2, ref: 'desktop-2', worker: null, action: 'pause', since: null });
    expect(await picker.answer(2)).toMatchObject({ ok: true, message: 'Pausing at the next call.' });
    expect(await worker.next('control')).toEqual({ type: 'control', action: 'pause' });

    // A headless stop waits while a subscribed connection can answer it.
    worker.stop(1);
    const stop = await waitFor(() => picker.session('desktop-2')?.workers[0]?.stop ?? undefined);
    expect(stop).toMatchObject({
      reason: 'page-pause',
      bar: false,
      uri: pathToFileURL(path.join(folder, 'tests/checkout.spec.ts')).href,
      line: 4,
    });
    // Pick in the test's window, Record and Assert end in an editor, which the desktop app has none of; a headless
    // stop takes Assert a region only from a viewer of its view.
    expect(stop.intents).toEqual(['mock', 'view', 'pick-at']);
    expect(picker.session('desktop-2')!.workers[0]!.intents).toEqual([
      'assert-region',
      'mock',
      'view',
      'input',
      'pick-at',
    ]);
    picker.send({ type: 'pick', id: 3, ref: 'desktop-2', worker: 0, since: stop.since });
    expect(await picker.answer(3)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Pick a locator in the test/),
    });
    picker.send({ type: 'record', id: 4, ref: 'desktop-2', worker: 0, since: stop.since });
    expect(await picker.answer(4)).toMatchObject({ ok: false, message: expect.stringMatching(/^Record here records/) });
    picker.send({ type: 'assert', id: 5, ref: 'desktop-2', worker: 0, since: stop.since });
    expect(await picker.answer(5)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^Assert makes its check/),
    });

    picker.send({ type: 'pausedPage', id: 6, ref: 'desktop-2', worker: 0 });
    const asked = await worker.request('image');
    worker.send({ type: 'answer', request: asked.request, what: 'image', value: { mime: 'image/jpeg', data: 'AAAA' } });
    expect(await picker.answer(6)).toMatchObject({ ok: true, image: { mime: 'image/jpeg', data: 'AAAA' } });

    picker.send({ type: 'runControl', id: 7, ref: 'desktop-2', worker: 0, action: 'step', since: stop.since });
    expect(await picker.answer(7)).toMatchObject({ ok: true, message: 'Stepping to the next call.' });
    expect(await worker.next('control', 1)).toEqual({ type: 'control', action: 'step', stop: 1 });
    worker.send({ type: 'running', stop: 1 });
    await waitFor(() => picker.session('desktop-2')?.workers[0]?.state === 'running');
    // A stop it answered is gone: an answer naming it reaches no worker.
    picker.send({ type: 'runControl', id: 8, ref: 'desktop-2', worker: 0, action: 'resume', since: stop.since });
    expect(await picker.answer(8)).toMatchObject({ ok: false, message: 'The test went on.' });
    // A run nobody connects to is the desktop app's to say.
    picker.send({ type: 'runControl', id: 9, ref: 'desktop-99', worker: null, action: 'pause', since: null });
    expect(await picker.answer(9)).toMatchObject({
      ok: false,
      message: 'No worker of this run is connected to the desktop app.',
    });
    worker.socket.destroy();
    picker.socket.close();
  });

  it('lets a headless stop go on at once while nobody can answer it', async () => {
    const worker = new Worker(folder).attach('desktop-3');
    worker.begin();
    worker.stop(1);
    expect(await worker.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });
    worker.socket.destroy();
  });
});

describe('a failure no pause bar shows', () => {
  it('waits in a run the window shows live, and goes on in one it does not', async () => {
    const window = await openWindow();
    const shown = new Worker(folder).attach('desktop-4');
    const other = new Worker(folder).attach('desktop-5');
    shown.begin();
    other.begin();
    expect(await window.command({ type: 'show', id: 1, ref: 'desktop-4', on: true })).toMatchObject({ ok: true });
    shown.stop(1, 'failure');
    other.stop(1, 'failure');
    expect(await other.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });
    const stop = await waitFor(() => window.session('desktop-4')?.workers[0]?.stop ?? undefined);
    expect(stop).toMatchObject({ reason: 'failure', error: 'Error: expect(locator).toBeVisible() failed' });
    expect(shown.heard.some((m) => m.type === 'control')).toBe(false);
    // The window no longer shows it: the failure goes on, as it would have.
    await window.command({ type: 'show', id: 2, ref: 'desktop-4', on: false });
    expect(await shown.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });
    shown.socket.destroy();
    other.socket.destroy();
    window.close();
  });

  it('waits while a Runs window of Piwi Picker follows the runs', async () => {
    const picker = await paired();
    picker.send({ type: 'subscribe', id: 1 });
    picker.send({ type: 'follow', id: 2, on: true });
    await picker.answer(2);
    const worker = new Worker(folder).attach('desktop-6');
    worker.begin();
    worker.stop(1, 'failure');
    await waitFor(() => picker.session('desktop-6')?.workers[0]?.stop?.reason === 'failure');
    picker.socket.close();
    expect(await worker.next('control')).toEqual({ type: 'control', action: 'resume', stop: 1 });
    worker.socket.destroy();
  });
});

describe('the window', () => {
  it('names its stream, and refuses a command of a stream that is not open or that is no command', async () => {
    const window = await openWindow();
    expect(window.events[0]).toEqual({ type: 'hello', viewer: window.viewer });
    expect(window.viewer).toMatch(/^[0-9a-f]{32}$/);
    expect(await runs.command({ viewer: 'f'.repeat(32), type: 'subscribe', id: 1 })).toBeNull();
    expect(await runs.command({ type: 'subscribe', id: 1 })).toBeNull();
    expect(await window.command({ type: 'subscribe' })).toMatchObject({ id: 0, ok: false });
    expect(await window.command({ type: 'show', id: 3, ref: 'a b', on: true })).toMatchObject({ ok: false });
    expect(await window.command({ type: 'runControl', id: 4, ref: 'desktop-1', action: 'jump' })).toMatchObject({
      ok: false,
    });
    window.close();
    expect(await window.command({ type: 'subscribe', id: 5 })).toBeNull();
  });

  it('watches a stop’s live view and plays its input there alone, picking on its image', async () => {
    const window = await openWindow();
    const other = await openWindow();
    const worker = new Worker(folder).attach('desktop-7');
    worker.begin();
    worker.stop(1);
    const stop = await waitFor(() => window.session('desktop-7')?.workers[0]?.stop ?? undefined);
    const at = { ref: 'desktop-7', worker: 0, since: stop.since };
    // Input before watching is refused, as for Piwi Picker.
    expect(
      await window.command({ type: 'input', id: 1, ...at, events: [{ type: 'mouse', action: 'move', x: 1, y: 1 }] }),
    ).toMatchObject({ ok: false, message: 'The input needs the live view of this stop: watch it first.' });

    const watching = window.command({ type: 'view', id: 2, ...at, on: true });
    const view = await worker.request('view');
    worker.send({ type: 'answer', request: view.request, what: 'view', value: { ok: true, message: 'Watching.' } });
    expect(await watching).toMatchObject({ ok: true });
    worker.send({ type: 'frame', stop: 1, width: 800, height: 600, data: '/9j/AA==' });
    await waitFor(() => window.events.find((e) => e.type === 'frame'));
    expect(window.events.find((e) => e.type === 'frame')).toEqual({
      type: 'frame',
      ...at,
      width: 800,
      height: 600,
      data: '/9j/AA==',
    });
    // Another window that does not watch the stop gets none of its frames.
    expect(other.events.some((e) => e.type === 'frame')).toBe(false);
    expect(window.session('desktop-7')!.workers[0]!.stop!.intents).toEqual([
      'assert-region',
      'mock',
      'view',
      'input',
      'pick-at',
    ]);

    const played = window.command({
      type: 'input',
      id: 3,
      ...at,
      events: [{ type: 'mouse', action: 'click', x: 10, y: 20, button: 'left', clickCount: 1 }],
    });
    const input = await worker.request('input');
    worker.send({ type: 'answer', request: input.request, what: 'input', value: { ok: true, message: 'Played.' } });
    expect(await played).toMatchObject({ ok: true });

    const picking = window.command({ type: 'pick-at', id: 4, ...at, x: 10, y: 20 });
    const pick = await worker.request('pick-at');
    worker.send({
      type: 'answer',
      request: pick.request,
      what: 'pick-at',
      value: { ok: true, message: 'Picked.', locator: "getByRole('button', { name: 'Pay' })" },
    });
    // Its locator goes where the run's picks go, the window, never to an editor.
    expect(await picking).toMatchObject({
      ok: true,
      locator: "getByRole('button', { name: 'Pay' })",
      message: "getByRole('button', { name: 'Pay' }): copy it in the desktop app's window.",
    });

    // The window closing ends its view: the worker stops it.
    window.close();
    const stopped = await worker.request('view', 1);
    expect(stopped).toMatchObject({ on: false });
    other.close();
    worker.socket.destroy();
  });
});

describe('the code from a stop of a desktop run', () => {
  it('goes to the window to copy, Piwi Picker hearing only where it went', async () => {
    const window = await openWindow();
    const picker = await paired();
    picker.send({ type: 'subscribe', id: 1 });
    await picker.answer(1);
    const worker = new Worker(folder).attach('desktop-8');
    worker.begin();
    worker.stop(1, 'page-pause', true);
    const stop = await waitFor(() => window.session('desktop-8')?.workers[0]?.stop ?? undefined);
    expect(stop.intents).toEqual(['assert-region', 'mock', 'view', 'pick-at']);
    const asking = window.command({ type: 'assert-region', id: 2, ref: 'desktop-8', worker: 0, since: stop.since });
    const region = await worker.request('assert-region');
    worker.send({
      type: 'answer',
      request: region.request,
      what: 'assert-region',
      value: { ok: true, message: 'Pick the region.' },
    });
    expect(await asking).toMatchObject({ ok: true });
    worker.send({ type: 'region', stop: 1, locator: "getByRole('region', { name: 'Cart' })", snapshot: '- text: Mug' });
    const made = await waitFor(() => window.events.find((e) => e.type === 'stop-code'));
    if (made.type !== 'stop-code') throw new Error('no code');
    expect(made.code).toMatchObject({
      ref: 'desktop-8',
      action: 'assert-region',
      uri: pathToFileURL(path.join(folder, 'tests/checkout.spec.ts')).href,
      version: null,
      line: 4,
    });
    expect(made.code.code).toContain("await expect(page.getByRole('region', { name: 'Cart' })).toMatchAriaSnapshot(");
    expect(made.code.message).toMatch(/^Piwi made the region's ARIA snapshot to write above checkout\.spec\.ts:5\./);
    const sentence = await waitFor(() => picker.messages.find((m) => m.type === 'code'));
    expect(sentence).toMatchObject({
      type: 'code',
      ok: true,
      message: expect.stringMatching(/to write above checkout\.spec\.ts:5: copy it in the desktop app's window\./),
    });
    expect(JSON.stringify(picker.messages)).not.toContain('toMatchAriaSnapshot');
    // A window that opens later is given the codes kept.
    const later = await openWindow();
    expect(later.events.filter((e) => e.type === 'stop-code')).toHaveLength(1);
    later.close();
    window.close();
    picker.socket.close();
    worker.socket.destroy();
  });

  it('is refused for a file written on disk since the run started, and outside the linked folders', async () => {
    const window = await openWindow();
    const worker = new Worker(folder).attach('desktop-9');
    worker.begin();
    worker.stop(1, 'page-pause', true);
    const stop = await waitFor(() => window.session('desktop-9')?.workers[0]?.stop ?? undefined);
    const spec = path.join(folder, 'tests', 'checkout.spec.ts');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(spec, later, later);
    expect(
      await window.command({ type: 'assert-region', id: 1, ref: 'desktop-9', worker: 0, since: stop.since }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/written on disk since the run started/) });
    worker.socket.destroy();

    // A reproduction runs in a worktree, which no project links: its stops make no code.
    const repro = new Worker(worktree).attach('desktop-10');
    repro.begin();
    repro.stop(1, 'page-pause', true);
    const there = await waitFor(() => window.session('desktop-10')?.workers[0]?.stop ?? undefined);
    expect(window.session('desktop-10')!.root).toBeNull();
    expect(there.uri).toBe(pathToFileURL(path.join(worktree, 'tests/checkout.spec.ts')).href);
    expect(
      await window.command({ type: 'assert-region', id: 2, ref: 'desktop-10', worker: 0, since: there.since }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/is not in a folder linked to a project/) });
    repro.socket.destroy();
    window.close();
  });

  it('takes the locators the runs pick at the address the shell names, for the window to copy', async () => {
    const address = runs.picksAddress(4318)!;
    // The address reads as an editor's Send to editor pairing, which the reporter posts a pick to with its token.
    expect(parsePairing(address)).toEqual({ url: `http://127.0.0.1:4318${DESKTOP_PICKS_PATH}`, token: TOKEN });
    const window = await openWindow();
    runs.picked({ locator: "getByRole('button', { name: 'Go' })", file: 'tests/shop.spec.ts', line: 3 });
    expect(window.events.filter((e) => e.type === 'pick')).toEqual([
      { type: 'pick', pick: { locator: "getByRole('button', { name: 'Go' })", file: 'tests/shop.spec.ts', line: 3 } },
    ]);
    // A window that opens later is given the picks kept, with the codes, in the order they came.
    const later = await openWindow();
    const kept = later.events.filter((e) => e.type === 'pick' || e.type === 'stop-code').map((e) => e.type);
    expect(kept.at(-1)).toBe('pick');
    later.close();
    window.close();
  });

  it('reads a file of a linked folder alone, a link out of it included', () => {
    const outside = path.join(worktree, 'tests', 'checkout.spec.ts');
    expect(insideFolder(folder, path.join(folder, 'tests', 'checkout.spec.ts'))).toBe(true);
    expect(insideFolder(folder, outside)).toBe(false);
    expect(insideFolder(folder, folder)).toBe(false);
    expect(insideFolder(folder, path.join(folder, '..', path.basename(worktree), 'tests', 'checkout.spec.ts'))).toBe(
      false,
    );
    if (process.platform !== 'win32') {
      const link = path.join(folder, 'tests', 'elsewhere.spec.ts');
      fs.symlinkSync(outside, link);
      expect(insideFolder(folder, link)).toBe(false);
      fs.rmSync(link);
    }
  });
});

describe('the routes', () => {
  const event = (headers: Record<string, string>) =>
    ({ node: { req: { headers } }, headers: new Headers(headers) }) as never;

  it('leave the guard’s open routes as they were: the hub’s routes need the desktop token', () => {
    for (const route of [
      ['GET', '/api/desktop/run-channel'],
      ['GET', '/api/desktop/live'],
      ['GET', '/api/desktop/runs/events'],
      ['POST', '/api/desktop/runs/commands'],
      ['POST', '/api/desktop/runs/picks'],
    ] as const) {
      expect(isOpenDesktopRoute(route[0], route[1])).toBe(false);
    }
  });

  it('give the run channel to the shell alone, never to a request a browser sends', () => {
    expect(isBrowserRequest(event({ 'x-piwi-token': TOKEN }))).toBe(false);
    expect(isBrowserRequest(event({ origin: ORIGIN }))).toBe(true);
    expect(isBrowserRequest(event({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isBrowserRequest(event({ 'sec-fetch-mode': 'cors' }))).toBe(true);
  });
});
