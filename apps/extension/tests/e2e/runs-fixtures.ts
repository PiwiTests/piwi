import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Worker } from '@playwright/test';
import {
  EDITOR_CHALLENGE_HEADER,
  EDITOR_PROOF_HEADER,
  editorTokenProof,
  isEditorChallenge,
} from '@piwitests/core/editor-send';
import { lineReader, parseHandoffToTest, type HandoffToTest } from '@piwitests/core/ide-recorder';
import type { RawCaptureEvent } from '@piwitests/core/recording';
import { RUN_TAKES, type HubToRun, type KeptResponse, type RunTake } from '@piwitests/core/run-channel';
import { liveHubsOf, type HubKeptRequest, type LiveHub } from '@piwitests/core/run-hub';
import {
  FakeWorker,
  service,
  waitFor,
  writeRunWorkspace,
  type Service,
} from '../../../../packages/editor/tests/run-fixtures.js';
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
    const challenge = req.headers[EDITOR_CHALLENGE_HEADER];
    if (isEditorChallenge(challenge)) {
      const port = (server.address() as AddressInfo).port;
      res.setHeader(EDITOR_PROOF_HEADER, await editorTokenProof(PAIRING_TOKEN, port, challenge));
    }
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
 * the secret area).
 */
export async function pairedExtension(
  editor: Editor,
  options: { deviceScaleFactor?: number; language?: string } = {},
): Promise<{ context: BrowserContext; worker: Worker; extensionId: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'piwi-picker-runs-'));
  cpSync(DIST, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [`${editor.origin}/*`];
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const context = await launchWithExtension(dir, options);
  const worker = await extensionWorker(context);
  await worker.evaluate(({ url, token }) => chrome.storage.local.set({ piwiEditorPairing: { url, token } }), {
    url: `${editor.origin}/piwi/send`,
    token: PAIRING_TOKEN,
  });
  return { context, worker, extensionId: worker.url().split('/')[2]! };
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
