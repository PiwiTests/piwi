import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { BrowserContext, Frame, Page, TestInfo } from '@playwright/test';
import {
  IDE_DISPATCH_GLOBAL,
  IDE_RECORDER_BINDING,
  RECORD_CHANNEL_ENV,
  lineReader,
  parseHandoffToTest,
  parseRecordChannel,
  type HandoffReason,
  type HandoffToEditor,
} from '@piwitests/core/ide-recorder';

/**
 * Record from a paused test: the page the test left is handed to the recorder of the editor that started the run,
 * over the record channel the run's environment names (`PIWI_RECORD_CHANNEL`, `@piwitests/core/ide-recorder`). The
 * editor service asks the person's editor to take the recording, then has the recorder's IDE bundle (a file of the
 * editor's) loaded into the page: each call of its binding goes to the editor service, which answers it, and what the
 * editor says (a pause, the stop) is handed to the recorder in the page. The steps are written in the editor, before
 * the paused line. It ends when the recording stops, the page closes, or the editor does not take it; the test then
 * goes on from where it paused.
 */

/** How long the editor may take to start the recording before the test goes on without it. */
const START_WAIT_MS = 60_000;

/** What the person hears once for each tab or popup the application opens, where nothing is recorded. */
const NEW_TAB_NOTICE = 'A new tab opened: what you do there is not recorded yet. Record in the first tab.';

/** Where a call of the binding came from, as Playwright hands it. */
type Source = { page: Page; frame: Frame };

type Handler = (source: Source, payload: unknown) => unknown;

/**
 * The binding of each context the recorder was loaded into, the recording it relays to (none when idle), and whether
 * the recorder's init script stays in the context, on a Playwright that cannot remove it.
 */
const relays = new WeakMap<BrowserContext, { recording: Handler | null; lingering: boolean }>();

/** What `addInitScript` gives back from Playwright 1.56: the script's removal. Older versions give nothing. */
type Removable = { dispose?: () => Promise<unknown> } | void;

/**
 * The answer to a call of the binding while no recording runs in the context, as the editor answers outside one: the
 * recorder's storage reads empty, and every message is refused, so a page loaded after a recording stays inert.
 */
export function idleAnswer(payload: unknown): unknown {
  const request = (payload ?? {}) as { kind?: unknown; message?: { type?: unknown; op?: unknown } };
  if (request.kind === 'local-get') return {};
  if (request.kind !== 'message') return null;
  if (request.message?.type === 'piwi-ping') return { ok: true };
  if (request.message?.type === 'piwi-session-storage') {
    return request.message.op === 'get' ? { ok: true, items: {} } : { ok: true };
  }
  return { ok: false, error: 'No recording runs in this page.' };
}

export interface RecordFromHereOptions {
  page: Page;
  testInfo: TestInfo;
  /** The call site the test is paused before, `file:line:col` relative to the working directory. */
  location: string;
  reason: HandoffReason;
  /** The record channel; `PIWI_RECORD_CHANNEL` by default. */
  channel?: string;
}

/** Whether the editor that started the run can record from a pause: the run names its record channel. */
export function canRecordFromHere(channel: string | undefined = process.env[RECORD_CHANNEL_ENV]): boolean {
  return parseRecordChannel(channel) !== null;
}

/** The absolute file and 1-based line of a call site (`file:line:col`, relative to `cwd`); null when it is none. */
export function handoffPlace(location: string, cwd: string = process.cwd()): { file: string; line: number } | null {
  const m = /^(.+):(\d+):\d+$/.exec(location);
  if (!m) return null;
  return { file: path.resolve(cwd, m[1]!), line: Number(m[2]) };
}

/**
 * Hand the page to the editor's recorder and wait until the recording ends. Resolves with what to say when no
 * recording took place (no channel, the editor did not take it, the channel failed); null once a recording ended.
 * Never throws.
 */
export async function recordFromHere(options: RecordFromHereOptions): Promise<string | null> {
  const channel = parseRecordChannel(options.channel ?? process.env[RECORD_CHANNEL_ENV]);
  const place = handoffPlace(options.location);
  if (!channel || !place) return 'this run names no editor to record into.';
  const { page, testInfo } = options;
  const use = (testInfo.project?.use ?? {}) as { testIdAttribute?: unknown; baseURL?: unknown };
  const context = page.context();
  return new Promise<string | null>((resolve) => {
    const socket = net.connect(channel.path);
    socket.setEncoding('utf8');
    const answers = new Map<number, (value: unknown) => void>();
    let calls = 0;
    let attached = false;
    let recording = false;
    let settled = false;
    /** The recorder's init script, while this recording runs. */
    let initScript: Removable;
    const send = (message: HandoffToEditor) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };
    const onPage = () => send({ type: 'notice', message: NEW_TAB_NOTICE });
    /** The page closed or crashed, before the recorder loaded or while it recorded. */
    const onGone = () => {
      if (attached) send({ type: 'closed' });
      finish('the page closed.');
    };
    page.once('close', onGone);
    page.once('crash', onGone);
    const startWait = setTimeout(() => finish('the editor did not start the recording.'), START_WAIT_MS);
    /** The context relays to no recording of this one's, and the documents it loads from now on are its own again. */
    const release = () => {
      const relay = relays.get(context);
      if (relay && relay.recording === relayed) relay.recording = null;
      // Where Playwright can remove the script.
      void Promise.resolve(initScript?.dispose?.()).catch(() => undefined);
      initScript = undefined;
    };
    /** The recording is over, however it ended: the page is answered as outside one from now on. */
    const finish = (said: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(startWait);
      release();
      for (const [call, answer] of answers) {
        answers.delete(call);
        answer(null);
      }
      context.off('page', onPage);
      page.off('close', onGone);
      page.off('crash', onGone);
      socket.end();
      resolve(recording ? null : said);
    };
    const relayed: Handler = (source, payload) =>
      new Promise((answer) => {
        const call = ++calls;
        answers.set(call, answer);
        const outside = source.page !== page || source.frame !== page.mainFrame();
        send({ type: 'binding', call, outside, payload });
      });
    /**
     * Load the recorder into the page, its binding relaying to the editor service. A recording that ended meanwhile
     * (the editor stopped it, the page closed) leaves nothing behind.
     */
    const load = async (bundle: string) => {
      // The recorder records the top document of an http(s) page, as the browser extension does.
      if (!/^https?:/i.test(page.url())) {
        const why = `the recorder records http(s) pages only, and this page is ${page.url() || 'blank'}.`;
        send({ type: 'notice', message: `Nothing can be recorded here: ${why}` });
        finish(why);
        return;
      }
      let relay = relays.get(context);
      if (!relay) {
        const created: { recording: Handler | null; lingering: boolean } = { recording: null, lingering: false };
        await context.exposeBinding(IDE_RECORDER_BINDING, (source, payload: unknown) =>
          created.recording ? created.recording(source, payload) : idleAnswer(payload),
        );
        relays.set(context, created);
        relay = created;
      }
      if (settled) return;
      relay.recording = relayed;
      // Removed when the recording ends, where Playwright can; added once per context where it cannot.
      if (!relay.lingering) {
        initScript = (await context.addInitScript({ path: bundle })) as Removable;
        if (typeof initScript?.dispose !== 'function') relay.lingering = true;
      }
      if (settled) return release();
      // The init script loads it into the next documents; this one gets it now.
      await page.evaluate(fs.readFileSync(bundle, 'utf-8'));
      if (settled) return release();
      recording = true;
      clearTimeout(startWait);
      context.on('page', onPage);
      send({ type: 'loaded' });
    };
    socket.on('connect', () => {
      attached = true;
      send({
        type: 'attach',
        token: channel.token,
        file: place.file,
        line: place.line,
        reason: options.reason,
        testIdAttribute: typeof use.testIdAttribute === 'string' ? use.testIdAttribute : null,
        baseURL: typeof use.baseURL === 'string' ? use.baseURL : null,
      });
    });
    socket.on(
      'data',
      lineReader(
        (line) => {
          const message = parseHandoffToTest(line);
          if (!message || settled) return;
          switch (message.type) {
            case 'refused':
              return finish(message.message);
            case 'load':
              return void load(message.bundle).catch((error: unknown) =>
                finish(`the recorder could not be loaded: ${error instanceof Error ? error.message : String(error)}`),
              );
            case 'answer': {
              const answer = answers.get(message.call);
              answers.delete(message.call);
              return answer?.(message.value);
            }
            case 'dispatch':
              return void page
                .evaluate(
                  ([name, value]) => {
                    const dispatch = (globalThis as unknown as Record<string, unknown>)[name];
                    if (typeof dispatch === 'function') dispatch(value);
                  },
                  [IDE_DISPATCH_GLOBAL, message.message] as const,
                )
                .catch(() => undefined);
            case 'stop':
              return finish(null);
          }
        },
        () => finish('the editor sent a message too long to read.'),
      ),
    );
    socket.on('error', (error) => finish(`the editor could not be reached: ${error.message}`));
    socket.on('close', () => finish('the editor closed the recording.'));
  });
}
