import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { lineReader } from '@piwitests/core/ide-recorder';
import type { HubAnswer, HubSessionMessage } from '@piwitests/core/run-hub';
import { linkedSpelling, ShellRuns, type ShellRunsOptions, type ShellRunsWords } from '../src/shell-runs';
import { serveShellRuns } from '../src/shell-runs-http';
import {
  DESKTOP_PICKS_PATH,
  DESKTOP_RUN_CHANNEL_PATH,
  DESKTOP_RUN_COMMANDS_PATH,
  DESKTOP_RUN_EVENTS_PATH,
  DESKTOP_RUN_STARTED_PATH,
  DESKTOP_RUN_ENDED_PATH,
  type DesktopRunEvent,
} from '../src/shell-run-events';
import { matchShellRunsRoute } from '../src/shell-runs-routes';

/**
 * The contract of a desktop shell's run hub (`ShellRuns`) and its routes, on a bare `node:http` host: what every host of
 * them answers. Piwi Runner's host serves these functions (`apps/runner/tests/host.test.ts`), and the dashboard's
 * desktop build calls them from its Nitro routes (`apps/application/tests/unit/desktop-runs.test.ts`).
 */

const TOKEN = `pd_${'d'.repeat(64)}`;
const SHELL = { 'x-piwi-token': TOKEN };
const PREFIX = 'piwi-test-shell-run-';

const WORDS: ShellRunsWords = {
  host: 'the test host',
  surfaces: "the test host's window",
  client: 'Test host',
  presence: { kind: 'desktop', name: 'the test host' },
  declined: { record: 'Record here records into an editor, and the test host has none.' },
  picked: (locator) => `${locator}: copy it in the test host's window.`,
  codeSent: (what, at) => `Piwi made ${what} to write ${at}: copy it in the test host's window.`,
  outside: (file) => `${file} is not in a linked folder.`,
  noWindowToStop: "The test host's window is closed.",
  stopping: 'The test host stops the run.',
  closing: 'The test host stopped.',
  log: '[test-runs]',
};

let folder: string;
let runs: ShellRuns | null;
let server: http.Server;
let base: string;
let port: number;

beforeEach(async () => {
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piwi-shell-runs-')));
  runs = await ShellRuns.start({
    token: TOKEN,
    version: '1.2.3',
    folders: () => [{ id: 7, path: folder }],
    words: WORDS,
    folderPrefix: PREFIX,
    projectName: async () => 'Checkout',
  });
  server = http.createServer((req, res) => {
    void serveShellRuns(req, res, TOKEN, runs, port).then((served) => {
      if (!served) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  runs?.close();
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  fs.rmSync(folder, { recursive: true, force: true });
});

/** A request as the shell sends one: `node:http`, which adds no header a browser would (`fetch` sends `Sec-Fetch-Mode`). */
function call(
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const sent = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${pathname}`,
      { method, headers: { ...headers, ...(sent === undefined ? {} : { 'content-type': 'application/json' }) } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
      },
    );
    req.on('error', reject);
    req.end(sent);
  });
}

/** The window's stream: the events it heard, and its end. */
function openStream(headers: Record<string, string> = SHELL) {
  const heard: DesktopRunEvent[] = [];
  return new Promise<{ status: number; heard: DesktopRunEvent[]; close(): void }>((resolve, reject) => {
    const req = http.request(`${base}${DESKTOP_RUN_EVENTS_PATH}`, { headers }, (res) => {
      let rest = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        rest += chunk;
        const frames = rest.split('\n\n');
        rest = frames.pop() ?? '';
        for (const frame of frames) {
          if (frame.startsWith('data: ')) heard.push(JSON.parse(frame.slice(6)) as DesktopRunEvent);
        }
      });
      res.on('error', () => {});
      resolve({ status: res.statusCode ?? 0, heard, close: () => req.destroy() });
    });
    req.on('error', () => {});
    req.on('error', reject);
    req.end();
  });
}

async function waitFor<T>(read: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A worker of the run `ref` on the hub's run channel, in the host's folder. */
function attach(ref: string): net.Socket {
  const [socketPath, token] = runs!.runChannel!.split('#') as [string, string];
  const worker = net.connect(socketPath);
  worker.on('error', () => {});
  worker.write(
    `${JSON.stringify({
      type: 'run-attach',
      token,
      ref,
      cwd: folder,
      workerIndex: 0,
      parallelIndex: 0,
      pid: process.pid,
      playwright: '1.64.1',
      reporter: '0.62.0',
    })}\n`,
  );
  return worker;
}

describe('the routes', () => {
  test('match the six paths and methods alone', () => {
    expect(matchShellRunsRoute('GET', DESKTOP_RUN_CHANNEL_PATH)).toBe('run-channel');
    expect(matchShellRunsRoute('GET', DESKTOP_RUN_EVENTS_PATH)).toBe('events');
    expect(matchShellRunsRoute('POST', DESKTOP_RUN_COMMANDS_PATH)).toBe('commands');
    expect(matchShellRunsRoute('POST', DESKTOP_PICKS_PATH)).toBe('picks');
    expect(matchShellRunsRoute('POST', DESKTOP_RUN_STARTED_PATH)).toBe('started');
    expect(matchShellRunsRoute('GET', DESKTOP_RUN_STARTED_PATH)).toBeNull();
    expect(matchShellRunsRoute('POST', DESKTOP_RUN_ENDED_PATH)).toBe('ended');
    expect(matchShellRunsRoute('GET', DESKTOP_RUN_ENDED_PATH)).toBeNull();
    expect(matchShellRunsRoute('POST', DESKTOP_RUN_CHANNEL_PATH)).toBeNull();
    expect(matchShellRunsRoute('GET', DESKTOP_PICKS_PATH)).toBeNull();
    expect(matchShellRunsRoute('GET', '/api/desktop/live')).toBeNull();
  });

  test('refuse every request without the access token', async () => {
    expect((await call('GET', DESKTOP_RUN_CHANNEL_PATH)).status).toBe(401);
    expect((await call('GET', DESKTOP_RUN_EVENTS_PATH)).status).toBe(401);
    expect((await call('POST', DESKTOP_RUN_COMMANDS_PATH, {}, { type: 'subscribe', id: 1 })).status).toBe(401);
    expect((await call('POST', DESKTOP_PICKS_PATH, {}, { kind: 'locator', text: "getByText('Pay')" })).status).toBe(
      401,
    );
    expect((await call('GET', DESKTOP_RUN_CHANNEL_PATH, { 'x-piwi-token': `pd_${'e'.repeat(64)}` })).status).toBe(401);
    expect((await call('POST', DESKTOP_RUN_STARTED_PATH, {}, { ref: 'desktop-1', args: [] })).status).toBe(401);
    expect((await call('POST', DESKTOP_RUN_ENDED_PATH, {}, { ref: 'desktop-1', exitCode: 0 })).status).toBe(401);
  });

  test('hear that a run the shell started ended, from the window too', async () => {
    const window = { ...SHELL, origin: 'http://127.0.0.1:3000' };
    expect(await call('POST', DESKTOP_RUN_ENDED_PATH, window, { ref: 'desktop-1', exitCode: 1 })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect((await call('POST', DESKTOP_RUN_ENDED_PATH, SHELL, { ref: 'desktop-2' })).status).toBe(200);
    expect((await call('POST', DESKTOP_RUN_ENDED_PATH, SHELL, { ref: 'ed-1', exitCode: 0 })).status).toBe(400);
    expect((await call('POST', DESKTOP_RUN_ENDED_PATH, SHELL, { ref: 'desktop-3', exitCode: 'x' })).status).toBe(400);
  });

  test('name the run channel, the picks address and the hub to the shell, and nothing to a browser', async () => {
    const answer = await call('GET', DESKTOP_RUN_CHANNEL_PATH, SHELL);
    expect(answer.status).toBe(200);
    expect(answer.body.runChannel).toMatch(/#[\w-]{16,}$/);
    expect(answer.body.runChannel).toBe(runs!.runChannel);
    expect(answer.body.picks).toBe(`http://127.0.0.1:${port}${DESKTOP_PICKS_PATH}#${runs!.picksToken()}`);
    expect(answer.body.picks).not.toContain(TOKEN);
    expect(answer.body.hub).toEqual({ url: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+/), token: TOKEN });

    const browsers: Record<string, string>[] = [
      { origin: 'http://127.0.0.1:3000' },
      { 'sec-fetch-site': 'same-origin' },
    ];
    for (const browser of browsers) {
      const refused = await call('GET', DESKTOP_RUN_CHANNEL_PATH, { ...SHELL, ...browser });
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).not.toContain('#');
    }
  });

  test('take a pick with the picks token on the picks route alone, from this machine', async () => {
    const picks = { authorization: `Bearer ${runs!.picksToken()}` };
    const stream = await openStream();
    await waitFor(() => stream.heard.some((e) => e.type === 'listed'));

    const pick = { kind: 'locator', text: "getByRole('button', { name: 'Pay' })", at: { file: 'a.spec.ts', line: 4 } };
    expect(await call('POST', DESKTOP_PICKS_PATH, picks, pick)).toEqual({ status: 200, body: { ok: true } });
    await waitFor(() => stream.heard.find((e) => e.type === 'pick'));
    expect(stream.heard.find((e) => e.type === 'pick')).toEqual({
      type: 'pick',
      pick: { locator: "getByRole('button', { name: 'Pay' })", file: 'a.spec.ts', line: 4 },
    });

    // The access token posts one too; the picks token opens no other route, nor a page's request.
    expect((await call('POST', DESKTOP_PICKS_PATH, SHELL, pick)).status).toBe(200);
    expect((await call('GET', DESKTOP_RUN_CHANNEL_PATH, picks)).status).toBe(401);
    expect((await call('POST', DESKTOP_RUN_COMMANDS_PATH, picks, { type: 'subscribe', id: 1 })).status).toBe(401);
    expect((await call('POST', DESKTOP_PICKS_PATH, { ...picks, origin: 'https://example.com' }, pick)).status).toBe(
      401,
    );
    expect(
      (await call('POST', DESKTOP_PICKS_PATH, { authorization: `Bearer pdp_${'0'.repeat(64)}` }, pick)).status,
    ).toBe(401);

    // Only a picked locator is taken.
    expect((await call('POST', DESKTOP_PICKS_PATH, picks, { kind: 'snippet', text: 'x' })).status).toBe(400);
    expect((await call('POST', DESKTOP_PICKS_PATH, picks, 'not json')).status).toBe(400);

    // A window that opens later hears the picks kept.
    const later = await openStream();
    await waitFor(() => later.heard.some((e) => e.type === 'listed'));
    expect(later.heard.filter((e) => e.type === 'pick')).toHaveLength(2);
    stream.close();
    later.close();
  });

  test('answer a window’s commands on its stream alone', async () => {
    const stream = await openStream();
    expect(stream.status).toBe(200);
    const hello = await waitFor(() => stream.heard.find((e) => e.type === 'hello'));
    await waitFor(() => stream.heard.some((e) => e.type === 'listed'));
    const viewer = (hello as { viewer: string }).viewer;

    expect(
      (await call('POST', DESKTOP_RUN_COMMANDS_PATH, SHELL, { type: 'subscribe', id: 2, viewer: 'f'.repeat(32) }))
        .status,
    ).toBe(404);
    expect((await call('POST', DESKTOP_RUN_COMMANDS_PATH, SHELL, { type: 'nothing', id: 2, viewer })).status).toBe(200);
    expect((await call('POST', DESKTOP_RUN_COMMANDS_PATH, SHELL, { type: 'subscribe', viewer })).status).toBe(400);
    const shown = await call('POST', DESKTOP_RUN_COMMANDS_PATH, SHELL, {
      type: 'show',
      id: 3,
      ref: 'desktop-1',
      viewer,
      on: true,
    });
    expect(shown).toMatchObject({ status: 200, body: { type: 'answer', id: 3, ok: true } });
    const unattended = await call('POST', DESKTOP_RUN_COMMANDS_PATH, SHELL, {
      type: 'show',
      id: 4,
      ref: 'desktop-2-unattended',
      viewer,
      on: true,
    });
    expect(unattended.body.message).toContain('Nobody attends');
    stream.close();
  });

  test('answer 503 while the host has no hub open', async () => {
    const open = runs;
    runs = null;
    expect((await call('POST', DESKTOP_RUN_COMMANDS_PATH, SHELL, { type: 'subscribe', id: 1 })).status).toBe(503);
    expect((await call('POST', DESKTOP_PICKS_PATH, SHELL, { kind: 'locator', text: 'x' })).status).toBe(503);
    expect((await call('POST', DESKTOP_RUN_STARTED_PATH, SHELL, { ref: 'desktop-1', args: [] })).status).toBe(503);
    expect((await openStream()).status).toBe(503);
    expect(await call('GET', DESKTOP_RUN_CHANNEL_PATH, SHELL)).toEqual({
      status: 200,
      body: { runChannel: null, picks: null, hub: null },
    });
    runs = open;
  });
});

describe('the hub', () => {
  test('shows a run its shell started in one of its folders to the window, in its folder’s spelling', async () => {
    const stream = await openStream();
    await waitFor(() => stream.heard.some((e) => e.type === 'listed'));
    const [socketPath, token] = runs!.runChannel!.split('#') as [string, string];
    const worker = net.connect(socketPath);
    const heard: string[] = [];
    worker.setEncoding('utf8');
    worker.on(
      'data',
      lineReader(
        (line) => heard.push(line),
        () => worker.destroy(),
      ),
    );
    worker.write(
      `${JSON.stringify({
        type: 'run-attach',
        token,
        ref: 'desktop-5',
        cwd: folder,
        workerIndex: 0,
        parallelIndex: 0,
        pid: process.pid,
        playwright: '1.64.1',
        reporter: '0.62.0',
        takes: ['view', 'input', 'pick-at'],
        holds: ['failure'],
      })}\n`,
    );
    const session = await waitFor(() =>
      stream.heard.find(
        (e): e is HubSessionMessage =>
          e.type === 'session' && e.session.ref === 'desktop-5' && e.session.workers.length > 0,
      ),
    );
    expect(session.session.root).toBe(folder);
    expect(runs!.liveRunCount()).toBe(1);

    // Another tool's stop reaches the window that holds the run.
    expect(runs!.stopRun('desktop-5')).toEqual({ ok: true, message: WORDS.stopping });
    await waitFor(() => stream.heard.find((e) => e.type === 'stop-run'));
    stream.close();
    await waitFor(() => (runs!.stopRun('desktop-5').message === WORDS.noWindowToStop ? true : null));
    worker.destroy();
  });

  test('names the command the shell started a run with, whenever the shell says it, and from the shell alone', async () => {
    const stream = await openStream();
    await waitFor(() => stream.heard.some((e) => e.type === 'listed'));
    const sessionOf = (ref: string, command: string | null) =>
      waitFor(() =>
        stream.heard.find(
          (e): e is HubSessionMessage =>
            e.type === 'session' && e.session.ref === ref && e.session.command === command && !e.session.ended,
        ),
      );
    const args = ['tests/cart.spec.ts:3', '--headed', '--grep', 'pays by card'];
    const command = 'npx playwright test tests/cart.spec.ts:3 --headed --grep "pays by card"';

    // Said before the run's first worker connects, and after.
    expect(await call('POST', DESKTOP_RUN_STARTED_PATH, SHELL, { ref: 'desktop-5', args })).toEqual({
      status: 200,
      body: { ok: true },
    });
    const early = attach('desktop-5');
    await sessionOf('desktop-5', command);
    const late = attach('desktop-6-unattended');
    await sessionOf('desktop-6-unattended', null);
    await call('POST', DESKTOP_RUN_STARTED_PATH, SHELL, { ref: 'desktop-6-unattended', args: ['--repeat-each=5'] });
    await sessionOf('desktop-6-unattended', 'npx playwright test --repeat-each=5');

    // A browser's request, a run the shell did not start and arguments that are no list of words are refused.
    const refused = [
      { headers: { ...SHELL, origin: 'http://127.0.0.1:3000' }, body: { ref: 'desktop-7', args }, status: 403 },
      { headers: { ...SHELL, 'sec-fetch-site': 'same-origin' }, body: { ref: 'desktop-7', args }, status: 403 },
      { headers: SHELL, body: { ref: 'terminal-1', args }, status: 400 },
      { headers: SHELL, body: { ref: 'ed-1', args }, status: 400 },
      { headers: SHELL, body: { ref: 'desktop-7', args: 'tests/cart.spec.ts' }, status: 400 },
      { headers: SHELL, body: { ref: 'desktop-7', args: [3] }, status: 400 },
      { headers: SHELL, body: { ref: 'desktop-7', args: ['a\nb'] }, status: 400 },
    ];
    for (const { headers, body, status } of refused) {
      expect((await call('POST', DESKTOP_RUN_STARTED_PATH, headers, body)).status).toBe(status);
    }
    early.destroy();
    late.destroy();
    stream.close();
  });

  test('spells a run’s folder as the linked folder holding it, and none outside', () => {
    const below = path.join(folder, 'e2e');
    fs.mkdirSync(below);
    expect(linkedSpelling([{ id: 1, path: folder }], below)).toBe(below);
    expect(linkedSpelling([{ id: 1, path: folder }], os.tmpdir())).toBeNull();
  });
});

/** The events a host that extends the hub sends its windows itself. */
type Peek = { type: 'peek'; seen: string };

/** A host that extends the hub: a window command of its own (`peek`), answered with an event of its own. */
class PeekingRuns extends ShellRuns<Peek> {
  readonly left: string[] = [];

  static async open(options: ShellRunsOptions): Promise<PeekingRuns> {
    const runs = new PeekingRuns(options);
    await runs.open();
    return runs;
  }

  protected override windowCommand(viewer: string, id: number, value: Record<string, unknown>): HubAnswer | null {
    if (value.type !== 'peek') return null;
    this.sendToWindow(viewer, { type: 'peek', seen: String(value.what) });
    return { type: 'answer', id, ok: true, message: 'Peeked.' };
  }

  protected override windowLeft(viewer: string): void {
    this.left.push(viewer);
  }
}

describe('a host that extends the hub', () => {
  test('answers a window command of its own and sends that window events of its own; the hub alone does not', async () => {
    const options = { token: TOKEN, version: '1.2.3', folders: () => [], words: WORDS, folderPrefix: PREFIX };
    const peeking = await PeekingRuns.open(options);
    const heard: Array<DesktopRunEvent | Peek> = [];
    const sink = { send: (event: DesktopRunEvent | Peek) => heard.push(event), buffered: () => 0, close() {} };
    const window = (await peeking.openWindow(sink))!;
    expect(await peeking.command({ type: 'peek', id: 2, what: 'lane 0', viewer: window.viewer })).toEqual({
      type: 'answer',
      id: 2,
      ok: true,
      message: 'Peeked.',
    });
    expect(heard).toContainEqual({ type: 'peek', seen: 'lane 0' });
    window.close();
    expect(peeking.left).toEqual([window.viewer]);
    peeking.close();

    // A hub no host extends reads it as one of its own, and knows none of that name.
    const plain = (await runs!.openWindow({ send() {}, buffered: () => 0, close() {} }))!;
    expect(await runs!.command({ type: 'peek', id: 3, what: 'lane 0', viewer: plain.viewer })).toMatchObject({
      id: 3,
      ok: false,
      message: 'Piwi does not know the command "peek".',
    });
    plain.close();
  });
});
