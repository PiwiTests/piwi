import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import {
  DESKTOP_CHALLENGE_HEADER,
  DESKTOP_PROOF_HEADER,
  desktopTokenProof,
  isDesktopChallenge,
} from '@piwitests/core/desktop-proof';
import {
  EDITOR_CHALLENGE_HEADER,
  EDITOR_PROOF_HEADER,
  editorTokenProof,
  isEditorChallenge,
} from '@piwitests/core/editor-send';
import { lineReader, parseHandoffToTest, type HandoffToTest } from '@piwitests/core/ide-recorder';
import type { RawCaptureEvent } from '@piwitests/core/recording';
import { RUN_TAKES, type HubToRun, type KeptResponse, type RunTake } from '@piwitests/core/run-channel';
import { liveHubsOf, type HubKeptRequest, type HubSession, type LiveHub } from '@piwitests/core/run-hub';
import type { ViewInput } from '@piwitests/core/run-view';
import {
  FakeWorker,
  service,
  waitFor,
  writeRunWorkspace,
  type Service,
} from '../../../../packages/editor/tests/run-fixtures.js';
import {
  RecordChannel,
  RunHub,
  RunSessions,
  StopActions,
  type StopCode,
} from '../../../../packages/editor/src/run-host.js';
import { extensionWorker, launchWithExtension } from './fixtures.js';

/**
 * The editor the Runs window follows: the real editor service, started in-process on a workspace folder as its own
 * tests start it, its hub and run channel included, its client one that writes the code made at a stop
 * (`stopCode`, the code it is sent kept in `svc.codes`), and a local server standing in for the editor's Send to
 * editor endpoint, whose `GET /piwi/live` lists the service's hub as VS Code's listener does, and which answers a
 * request carrying a challenge with the proof that it holds the pairing's token. A run is a fake worker on the run
 * channel its command names (`FakeWorker`), played by the spec, as is the test's half of a check's hand-off.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', '..', 'dist');

export const PAIRING_TOKEN = 'pairing_token_0123456789';

export { FakeWorker, RUN_TAKES, waitFor };

/** The spec a test stops in where code can be written: the click on Pay, its 5th line, inside the test. */
export const CHECKOUT = 'tests/checkout.spec.ts';
const CHECKOUT_SPEC = [
  "import { test } from '@playwright/test';",
  '',
  "test('pays', async ({ page }) => {",
  "  await page.goto('/cart');",
  "  await page.getByRole('button', { name: 'Pay' }).click();",
  '});',
  '',
].join('\n');

export interface Editor {
  dir: string;
  svc: Service;
  /** The editor's endpoint's origin, which also serves a plain page at `/`. */
  origin: string;
  hub: LiveHub;
  close(): Promise<void>;
}

/** Starts the editor service and its Send to editor endpoint. */
export async function startEditor(): Promise<Editor> {
  // A folder named as a project is: the window names a run after it.
  const dir = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'piwi-runs-'))), 'shop');
  writeRunWorkspace(dir);
  writeFileSync(path.join(dir, CHECKOUT), CHECKOUT_SPEC);
  // What a check needs of the service's own files: the recorder's bundle and its catalogs, which no page loads here.
  const dist = path.join(path.dirname(dir), 'editor-dist');
  mkdirSync(dist);
  writeFileSync(path.join(dist, 'record-ide.js'), '// the recorder\n');
  writeFileSync(path.join(dist, 'record-ide-messages.json'), '{"en":{}}');
  const svc = await service(dir, true, { distDir: dist }, { stopCode: true });
  const published = await waitFor(() => svc.published[0] ?? undefined);
  const [hub] = liveHubsOf([published]);
  const server: Server = createServer(async (req, res) => {
    await proveTo(req, res, (server.address() as AddressInfo).port);
    if (req.url === '/piwi/live' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${PAIRING_TOKEN}`) {
        res.statusCode = 401;
        res.end('{"error":"not paired"}');
        return;
      }
      res.end(JSON.stringify({ hubs: [hub] }));
      return;
    }
    if (req.url === '/') {
      // A page of this machine, which must not reach the hub.
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>A page on 127.0.0.1</title><p>Hello</p>');
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    dir,
    svc,
    origin,
    hub: hub!,
    close: async () => {
      svc.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(path.dirname(dir), { recursive: true, force: true });
    },
  };
}

/**
 * The extension, loaded with the grant of the editor's address the settings page requests in Pair's click, which a
 * test cannot make, and paired with the editor as an older version kept its pairing (the worker moves the token to
 * the secret area); with `desktop`, paired with that desktop app too, its address granted and its pairing in the
 * secret area as **Allow** leaves it, and with `editor: null`, with the desktop app alone.
 */
export async function pairedExtension(
  editor: Pick<Editor, 'origin'> | null,
  options: { deviceScaleFactor?: number; language?: string; desktop?: Pick<Desktop, 'origin'> } = {},
): Promise<{ context: BrowserContext; worker: Worker; extensionId: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'piwi-picker-runs-'));
  cpSync(DIST, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [editor, options.desktop].filter((paired) => !!paired).map((p) => `${p!.origin}/*`);
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const context = await launchWithExtension(dir, options);
  const worker = await extensionWorker(context);
  if (options.desktop) {
    await worker.evaluate(
      (desktop) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('piwi-secrets', 1);
          open.onupgradeneeded = () => {
            if (!open.result.objectStoreNames.contains('secrets')) open.result.createObjectStore('secrets');
          };
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const transaction = open.result.transaction('secrets', 'readwrite');
            transaction.objectStore('secrets').put(desktop, 'desktop');
            transaction.oncomplete = () => {
              open.result.close();
              // As the settings page says a pairing changed: the worker asks the app for its runs' hub.
              void chrome.storage.local.set({ piwiDesktopPairedAt: Date.now() }).then(() => resolve());
            };
            transaction.onerror = () => reject(transaction.error);
          };
        }),
      { url: options.desktop.origin, token: DESKTOP_TOKEN },
    );
  }
  if (editor) {
    await worker.evaluate(({ url, token }) => chrome.storage.local.set({ piwiEditorPairing: { url, token } }), {
      url: `${editor.origin}/piwi/send`,
      token: PAIRING_TOKEN,
    });
  }
  return { context, worker, extensionId: worker.url().split('/')[2]! };
}

/** The paired desktop app's token, which its hub takes in `hello`. */
export const DESKTOP_TOKEN = `pd_${'d1'.repeat(32)}`;

/** The desktop app's server, as Piwi Picker reaches it: its address, its hub, its run channel, the code its window got. */
export interface Desktop {
  origin: string;
  hub: LiveHub;
  channel: Channel;
  /** The code made at a stop of its runs, which the app's window alone receives, to copy. */
  codes: StopCode[];
  close(): Promise<void>;
}

/** What the desktop app's server declines, as it has no editor: Pick and Record in the test's window, and Assert. */
const DESKTOP_DECLINES = new Set(['pick', 'record', 'assert']);

/**
 * The paired desktop app, built as its server builds the hub of the runs its shell starts
 * (`apps/application/server/utils/desktop-runs.ts`): the editor service's run control hosted with the desktop token as
 * the hub's, `Piwi desktop app` its client, Pick, Record and Assert declined, the code made at a stop from the file on
 * disk going to its window alone (`codes`), Piwi Picker hearing that it was made, to copy in that window; and the two
 * routes of its server Piwi Picker reads: `/api/health`, which answers a challenge with the proof that it holds the
 * token, and `/api/desktop/live`, which names the hub to a request carrying the token. A run is a fake worker on its
 * run channel, in `dir`.
 */
export async function startDesktop(dir: string): Promise<Desktop> {
  const codes: StopCode[] = [];
  let hub: RunHub | null = null;
  const sessions = new RunSessions({
    notify: (session) => hub?.push(session),
    answersStops: () => !!hub?.answersStops(),
    notice: () => {},
    rootOf: (cwd) => (cwd === dir ? dir : null),
    writesCode: () => true,
    followed: () => !!hub?.follows(),
    declines: (what) =>
      DESKTOP_DECLINES.has(what) ? `${what} ends in an editor, and the desktop app has none.` : null,
    host: 'the desktop app',
    surfaces: "the desktop app's window",
  });
  const actions = new StopActions({
    sessions,
    writesCode: () => true,
    notify: (code) => void codes.push(code),
    notice: () => {},
    outcome: (outcome) => hub?.code(outcome),
    target: (file) =>
      file.startsWith(`${dir}${path.sep}`) && existsSync(file)
        ? {
            uri: pathToFileURL(file).href,
            text: readFileSync(file, 'utf8'),
            version: null,
            preferLocators: new Set(),
            expectModule: '@playwright/test',
          }
        : null,
    lineNow: (stop) => ({ line: stop.line }),
    language: () => null,
    words: {
      wrote: (what, at) => `Piwi made ${what} to write ${at}.`,
      sent: (what, at) => `Piwi made ${what} to write ${at}: copy it in the desktop app's window.`,
      outside: (uri) => `${uri} is not in a folder linked to a project.`,
    },
  });
  const channel = (await RecordChannel.open({
    onAttach: (handoff) => channel.refuse(handoff.id, 'The desktop app has no recorder.'),
    onRun: (socket, attach) => sessions.attach(socket, attach),
  }))!;
  hub = (await RunHub.open({
    sessions,
    actions,
    runInfo: (_ref, root) => ({ command: null, label: root ? path.basename(root) : null, project: null }),
    welcome: () => ({ pid: process.pid, version: '0.62.0', client: 'Piwi desktop app', roots: [dir] }),
    surfacesChanged: () => sessions.surfacesChanged(),
    token: DESKTOP_TOKEN,
    closing: 'The desktop app stopped.',
  }))!;
  const live: LiveHub = {
    url: hub.url,
    token: DESKTOP_TOKEN,
    pid: process.pid,
    version: '0.62.0',
    client: 'Piwi desktop app',
    roots: [dir],
    startedAt: new Date().toISOString(),
  };
  const server: Server = createServer(async (req, res) => {
    const port = (server.address() as AddressInfo).port;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') {
      const challenge = req.headers[DESKTOP_CHALLENGE_HEADER];
      if (isDesktopChallenge(challenge)) {
        res.setHeader(DESKTOP_PROOF_HEADER, await desktopTokenProof(DESKTOP_TOKEN, port, challenge));
      }
      res.end('{"status":"ok","database":"ok"}');
      return;
    }
    if (req.headers['x-piwi-token'] !== DESKTOP_TOKEN) {
      res.statusCode = 401;
      res.end('{"message":"Desktop access token required"}');
      return;
    }
    if (req.url === '/api/desktop/live' && req.method === 'GET') {
      res.end(JSON.stringify({ hubs: [live] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hub: live,
    channel: { path: channel.path, token: channel.token },
    codes,
    close: async () => {
      hub?.close();
      channel.close();
      sessions.dispose();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

/** The proof that the program on the editor's port holds the pairing's token, for a request with a challenge. */
async function proveTo(
  req: { headers: Record<string, unknown> },
  res: { setHeader(n: string, v: string): void },
  port: number,
) {
  const challenge = req.headers[EDITOR_CHALLENGE_HEADER];
  if (isEditorChallenge(challenge))
    res.setHeader(EDITOR_PROOF_HEADER, await editorTokenProof(PAIRING_TOKEN, port, challenge));
}

/** The run channel a run's command names, which a test's hand-off to the editor's recorder reaches too. */
export interface Channel {
  path: string;
  token: string;
}

/**
 * A run the editor built, with one worker on its run channel, running its test; the worker's reporter takes the
 * intents and queries `takes` names (Pick and Record alone, as one before the code from a stop).
 */
export async function startRun(
  editor: Editor,
  title?: string,
  takes: RunTake[] = ['pick', 'record'],
): Promise<{ ref: string; worker: FakeWorker; channel: Channel }> {
  const { ref, channel } = await editor.svc.command();
  const worker = new FakeWorker(channel.path, editor.dir).attach(channel.token, ref, 0, takes);
  worker.begin(title);
  return { ref, worker, channel };
}

/** The error a failed checkout test stopped at, as its reporter names it: the error's first lines, as plain text. */
export const FAILURE_ERROR = "expect(locator).toBeVisible() failed\nLocator: getByRole('button', { name: 'Pay' })";

/**
 * The worker stops before the click on Pay in the checkout spec, at a breakpoint, or there as the test failed, naming
 * its error (`FAILURE_ERROR`), or none as a reporter that predates it (`error: null`), which titles it alone.
 */
export function stopAtCheckout(
  worker: FakeWorker,
  stop: number,
  options: { reason?: 'breakpoint' | 'failure'; bar?: boolean; error?: string | null } = {},
): void {
  const { reason = 'breakpoint', bar = true, error = FAILURE_ERROR } = options;
  worker.send({
    type: 'stopped',
    stop,
    reason,
    title:
      reason === 'failure'
        ? 'Failed: Error: expect(locator).toBeVisible() failed'
        : "Click getByRole('button', { name: 'Pay' })",
    place: { file: CHECKOUT, line: 5, column: 5 },
    locator: "getByRole('button', { name: 'Pay' })",
    bar,
    ...(reason === 'failure' && error !== null ? { error } : {}),
  });
}

/** The requests each worker answered, by the number the editor gave them. */
const answered = new WeakMap<FakeWorker, Set<number>>();

/** Answers the worker's first request of `what` not answered yet with `value`, as its reporter does; that request. */
export async function answerNext(
  worker: FakeWorker,
  what: string,
  value: unknown,
): Promise<Extract<HubToRun, { type: 'request' }>> {
  const done = answered.get(worker) ?? new Set<number>();
  answered.set(worker, done);
  const asked = await waitFor(() =>
    worker.heard.find(
      (m): m is Extract<HubToRun, { type: 'request' }> =>
        m.type === 'request' && m.what === what && !done.has(m.request),
    ),
  );
  done.add(asked.request);
  worker.send({ type: 'answer', request: asked.request, what, value } as never);
  return asked;
}

/**
 * The test's half of the record channel's hand-off in its check mode, as a worker opens it for Assert: what the
 * editor sent it, and what it sends, line by line.
 */
export function checkHandoff(
  editor: Editor,
  channel: Channel,
  stop: { ref: string; worker: number; stop: number },
): { socket: Socket; heard: HandoffToTest[]; send(message: unknown): void } {
  const socket = connect(channel.path);
  socket.setEncoding('utf8');
  const heard: HandoffToTest[] = [];
  socket.on(
    'data',
    lineReader(
      (line) => {
        const message = parseHandoffToTest(line);
        if (message) heard.push(message);
      },
      () => socket.destroy(),
    ),
  );
  const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
  send({
    type: 'attach',
    token: channel.token,
    file: path.join(editor.dir, CHECKOUT),
    line: 5,
    reason: 'breakpoint',
    testIdAttribute: null,
    baseURL: 'http://127.0.0.1:3000',
    mode: 'check',
    stop,
  });
  return { socket, heard, send };
}

/** The check a person makes with the check panel's Check an element: the total's text. */
export const CHECK: RawCaptureEvent = {
  kind: 'assert',
  target: {
    tagName: 'output',
    role: 'status',
    accessibleName: null,
    testId: 'total',
    text: 'Total €72.00',
    alternatives: [{ locator: "getByTestId('total')", method: 'getByTestId', score: 90 }],
  },
  value: null,
  checked: null,
  inputType: null,
  isPasswordField: false,
  pageUrl: 'http://127.0.0.1:3000/cart',
  timestamp: 1,
  assertion: { matcher: 'toHaveText', expected: 'Total €72.00', actual: null, negated: false, note: null },
};

const APP = 'http://127.0.0.1:3000';

/**
 * The responses a stopped checkout test kept, oldest first, as its reporter lists them: one of them with an address
 * longer than the window, one whose address carries markup, which the window shows as text, and one sent in chunks,
 * which states no size, with a credential in its address, as a reporter that hides none lists it: the editor hides it.
 */
export const KEPT: HubKeptRequest[] = [
  { id: 1, method: 'GET', url: `${APP}/api/cart`, status: 200, type: 'application/json', size: 12, time: 840 },
  { id: 2, method: 'POST', url: `${APP}/api/coupons`, status: 422, type: 'application/json', size: 48, time: 1210 },
  {
    id: 3,
    method: 'GET',
    url: `${APP}/api/products?page=1&per_page=24&sort=price&order=asc&category=kitchen&colour=blue&in_stock=true`,
    status: 200,
    type: 'application/json',
    size: 18_400,
    time: 1630,
  },
  {
    id: 4,
    method: 'GET',
    url: `${APP}/api/search?q=<img src=x onerror=alert(1)>`,
    status: 200,
    type: 'text/html',
    size: 230,
    time: 1900,
  },
  { id: 5, method: 'GET', url: `${APP}/api/shipping`, status: 200, type: 'application/json', size: 96, time: 2050 },
  { id: 6, method: 'GET', url: `${APP}/api/user`, status: 401, type: 'application/json', size: 27, time: 2300 },
  { id: 7, method: 'PUT', url: `${APP}/api/basket/7`, status: 204, type: '', size: 0, time: 2410 },
  {
    id: 8,
    method: 'GET',
    url: `${APP}/api/stream?token=abc123`,
    status: 200,
    type: 'text/plain',
    size: null,
    time: 2600,
  },
];

/** The body the worker hands over for the cart's request, the one chosen to mock. */
export const CART_RESPONSE: KeptResponse = {
  method: 'GET',
  url: `${APP}/api/cart`,
  status: 200,
  type: 'application/json',
  body: '{"items":[]}',
};

/** The viewport of the page a fake worker's frames show, in CSS pixels. */
export const VIEWPORT = { width: 1280, height: 800 };

/** A JPEG of a page, as a worker sends a frame or the image of its stopped page: base64. */
export async function jpegOf(page: Page): Promise<string> {
  return (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64');
}

/** The worker's reporter starts (`on`) or stops a stop's live view, as asked. */
export function answerView(worker: FakeWorker, on = true): Promise<Extract<HubToRun, { type: 'request' }>> {
  return answerNext(worker, 'view', { ok: true, message: on ? 'The live view is on.' : 'The live view is off.' });
}

/** A frame of the live view of the stop `stop`: the JPEG `data`, of a page of `VIEWPORT`. */
export function sendFrame(worker: FakeWorker, stop: number, data: string): void {
  worker.send({ type: 'frame', stop, ...VIEWPORT, data });
}

/**
 * The worker's reporter plays the input of the stop's viewers: each `input` it hears is answered as played, and its
 * events kept, in the order they came.
 */
export function playInput(worker: FakeWorker): { events: ViewInput[]; stop(): void } {
  const events: ViewInput[] = [];
  const done = new Set<number>();
  const timer = setInterval(() => {
    for (const m of worker.heard) {
      if (m.type !== 'request' || m.what !== 'input' || done.has(m.request)) continue;
      done.add(m.request);
      events.push(...m.events);
      worker.send({ type: 'answer', request: m.request, what: 'input', value: { ok: true, message: 'Played.' } });
    }
  }, 10);
  return { events, stop: () => clearInterval(timer) };
}

/** The requests of `what` a worker heard. */
export function heardRequests<W extends string>(
  worker: FakeWorker,
  what: W,
): Array<Extract<HubToRun, { type: 'request' }> & { what: W }> {
  return worker.heard.filter(
    (m): m is Extract<HubToRun, { type: 'request' }> & { what: W } => m.type === 'request' && m.what === what,
  );
}

/** An older editor: its hub, what it heard, and the address of its Send to editor endpoint. */
export interface OlderEditor {
  origin: string;
  /** The commands the hub heard after `hello`. */
  heard: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * An editor service of a version before the live view, behind its own Send to editor endpoint: a hub that tells each
 * run as the spec gives it, with no `stop.intents` and no worker taking the view, and answers the image of a stopped
 * page without its viewport. A WebSocket server of its own, on the handshake and text frames alone.
 */
export async function olderEditor(sessions: HubSession[], image: string): Promise<OlderEditor> {
  const heard: Array<Record<string, unknown>> = [];
  const token = 'older_hub_token_0123456789';
  const server: Server = createServer(async (req, res) => {
    await proveTo(req, res, (server.address() as AddressInfo).port);
    if (req.url === '/piwi/live' && req.headers.authorization === `Bearer ${PAIRING_TOKEN}`) {
      res.setHeader('Content-Type', 'application/json');
      const hub = { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/piwi/hub`, token };
      res.end(
        JSON.stringify({
          hubs: [
            {
              ...hub,
              pid: 4242,
              version: '0.60.0',
              client: 'Older Editor',
              roots: [],
              startedAt: new Date().toISOString(),
            },
          ],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.on('upgrade', (req, socket: Socket) => {
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (message: unknown) => {
      const payload = Buffer.from(JSON.stringify(message), 'utf8');
      const length = payload.length;
      const header = Buffer.alloc(length < 126 ? 2 : length < 65_536 ? 4 : 10);
      header[0] = 0x81;
      if (length < 126) header[1] = length;
      else if (length < 65_536) {
        header[1] = 126;
        header.writeUInt16BE(length, 2);
      } else {
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
      }
      socket.write(Buffer.concat([header, payload]));
    };
    const hear = (text: string) => {
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.type === 'hello') {
        send({ type: 'welcome', pid: 4242, version: '0.60.0', client: 'Older Editor', roots: [], keepaliveMs: 20_000 });
        return;
      }
      heard.push(message);
      const answer = { type: 'answer', id: message.id, ok: true, message: '' };
      if (message.type === 'pausedPage') send({ ...answer, image: { mime: 'image/jpeg', data: image } });
      else if (message.type === 'subscribe' || message.type === 'follow') send(answer);
      else send({ ...answer, ok: false, message: `This editor does not know ${String(message.type)}.` });
      if (message.type === 'subscribe') for (const session of sessions) send({ type: 'session', session });
    };
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0]! & 0x0f;
        let length = buffer[1]! & 0x7f;
        let at = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          at = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          at = 10;
        }
        // A browser masks every frame it sends.
        if (buffer.length < at + 4 + length) return;
        const mask = buffer.subarray(at, at + 4);
        const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + length)).map((byte, i) => byte ^ mask[i % 4]!);
        buffer = buffer.subarray(at + 4 + length);
        if (opcode === 1) hear(Buffer.from(payload).toString('utf8'));
        else if (opcode === 8) socket.end();
      }
    });
    socket.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    heard,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
