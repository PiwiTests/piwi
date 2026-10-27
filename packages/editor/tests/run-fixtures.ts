/**
 * What the run tests share: a service started in-process on a workspace folder with no instance, its client's side of
 * the protocol (the sessions and notices it hears, a command that runs the spec's test), the discovery file it
 * publishes, and a fake worker on the socket each run names (`PIWI_RUN_CHANNEL`).
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import { createConnection } from 'vscode-languageserver/node';
import type { EditorDiscovery } from '@piwitests/core/editor-discovery';
import { lineReader, parseRecordChannel } from '@piwitests/core/ide-recorder';
import { parseHubToRun, type HubToRun, type RunIntent, type RunToHub } from '@piwitests/core/run-channel';
import { startServer, type ServerOptions } from '../src/server';
import type { Notice, RunCommand, RunSession } from '../src/protocol';

export function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

export async function waitFor<T>(read: () => T | undefined, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Writes the folder the run tests' service opens: one Playwright config, a spec and a page object. */
export function writeRunWorkspace(dir: string): void {
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  write('playwright.config.ts', 'export default {};\n');
  write(
    'tests/cart.spec.ts',
    "import { test } from '@playwright/test';\n\ntest('adds a mug', async ({ page }) => {});\n",
  );
  write('tests/pages/cart.page.ts', 'export class CartPage {}\n');
}

/** A service on the workspace, and what its client heard. */
export interface Service {
  client: MessageConnection;
  stop: () => void;
  sessions: RunSession[];
  notices: Notice[];
  /** What the service published for its discovery file, last: null once it stopped. */
  published: Array<EditorDiscovery | null>;
  /** The latest session of a ref the client heard. */
  latest(ref: string): RunSession | undefined;
  /** A command that runs the spec's test, with its ref and the run channel it names. */
  command(): Promise<{ ref: string; channel: { path: string; token: string }; command: RunCommand }>;
}

export async function service(dir: string, runControl: boolean, options: ServerOptions = {}): Promise<Service> {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const published: Array<EditorDiscovery | null> = [];
  const stop = startServer(createConnection(toServer, toClient), {
    env: { PIWI_DESKTOP_CONFIG: '/nonexistent' },
    publish: (discovery) => void published.push(discovery),
    ...options,
  });
  const client = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
  const sessions: RunSession[] = [];
  const notices: Notice[] = [];
  client.onNotification('piwi/runSessionChanged', (session: RunSession) => void sessions.push(session));
  client.onNotification('piwi/notice', (notice: Notice) => void notices.push(notice));
  client.listen();
  await client.sendRequest('initialize', {
    processId: null,
    rootUri: null,
    capabilities: {},
    clientInfo: { name: 'Test Editor' },
    workspaceFolders: [{ uri: pathToFileURL(dir).href, name: 'shop' }],
    initializationOptions: runControl ? { runControl: true } : {},
  });
  await client.sendNotification('initialized', {});
  const command = async () => {
    // The channel opens once the service is initialized: a command built before names none.
    for (;;) {
      const run = (await client.sendRequest('piwi/runArgs', {
        uri: pathToFileURL(path.join(dir, 'tests/cart.spec.ts')).href,
        testIds: [],
        locations: ['tests/cart.spec.ts:3'],
      })) as RunCommand;
      const channel = parseRecordChannel(run.env?.PIWI_RUN_CHANNEL);
      if (channel) return { ref: run.ref!, channel, command: run };
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return {
    client,
    stop: () => {
      stop();
      client.dispose();
    },
    sessions,
    notices,
    published,
    latest: (ref) => last(sessions.filter((s) => s.ref === ref)),
    command,
  };
}

/** A worker of a run on its run connection: what it heard, and what it sends. */
export class FakeWorker {
  readonly heard: HubToRun[] = [];
  readonly socket: net.Socket;
  readonly closed: Promise<void>;

  /** `cwd` is the run's working directory, which every place is relative to. */
  constructor(
    channelPath: string,
    private readonly cwd: string,
  ) {
    this.socket = net.connect(channelPath);
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

  attach(token: string, ref: string, workerIndex = 0, takes: RunIntent[] = ['pick', 'record']): this {
    this.send({
      type: 'run-attach',
      token,
      ref,
      cwd: this.cwd,
      workerIndex,
      parallelIndex: workerIndex,
      pid: process.pid,
      playwright: '1.64.1',
      reporter: '0.60.0',
      takes,
    });
    return this;
  }

  begin(title = 'adds a mug', cannotPause: string | null = null): void {
    this.send({
      type: 'test-begin',
      testId: `id-${title}`,
      title: ['cart', title],
      file: 'tests/cart.spec.ts',
      line: 3,
      project: 'chromium',
      retry: 0,
      cannotPause,
    });
  }

  stopAt(stop: number, line: number, bar = false): void {
    this.send({
      type: 'stopped',
      stop,
      reason: 'breakpoint',
      title: "Click getByRole('button', { name: 'Add' })",
      place: { file: 'tests/pages/cart.page.ts', line, column: 5 },
      locator: "getByRole('button', { name: 'Add' })",
      bar,
    });
  }

  /** The next message heard of a type, after `after` of them. */
  next<T extends HubToRun['type']>(type: T, after = 0): Promise<Extract<HubToRun, { type: T }>> {
    return waitFor(() => this.heard.filter((m) => m.type === type)[after] as Extract<HubToRun, { type: T }>);
  }
}
