/**
 * The hub's WebSocket: how Piwi Picker follows and steers the runs an editor service started. Each service listens
 * on `127.0.0.1` alone, on a free port, and names the address and a token in its discovery file
 * (`@piwitests/core/editor-discovery`); the editor's Send to editor endpoint hands them to the paired extension
 * (`GET /piwi/live`, `GET /api/piwi/live`: `LiveAnswer`). The hub takes a handshake only with its own `Host`
 * (`127.0.0.1:<port>` or `localhost:<port>`) and an extension's `Origin` (`chrome-extension://<id>`,
 * `moz-extension://<uuid>`); the first message must be `hello` with the token, within `HUB_HELLO_MS`. Every later
 * message is a command with an `id`, answered once with that `id` (`HubAnswer`); `subscribe` has the hub push each run
 * as it changes (`HubSessionMessage`). The hub sends `keepalive` every `HUB_KEEPALIVE_MS`, and a frame longer than
 * `MAX_HUB_FRAME` closes the connection. Messages are text frames of JSON, checked field by field on both sides.
 * Nothing a command asks evaluates code, reads a file or reaches an instance.
 */
import type { EditorDiscovery, HubAddress } from './editor-discovery';

/** The WebSocket's path. */
export const HUB_PATH = '/piwi/hub';
/** How often the hub sends `keepalive`: within the 30 s an MV3 worker stays alive after a WebSocket message. */
export const HUB_KEEPALIVE_MS = 20_000;
/** How long the hub waits for `hello`. */
export const HUB_HELLO_MS = 5_000;
/** The longest frame the hub reads, in bytes: a longer one closes the connection (1009). */
export const MAX_HUB_FRAME = 64 * 1024;
/** The commands a connection may have waiting for their answer at once: one more is refused. */
export const MAX_HUB_PENDING = 16;
/** The longest command line a `session` carries: the hub cuts a longer one, marking the cut. */
export const MAX_HUB_COMMAND = 20_000;
/** The most workspace folders a `welcome` names: the hub names the first ones. */
export const MAX_HUB_ROOTS = 64;
/** The longest Piwi project name a `session` carries: the hub cuts a longer one. */
export const MAX_HUB_PROJECT = 500;
/** The longest client name a `welcome` carries: the hub cuts a longer one. */
export const MAX_HUB_CLIENT = 200;

/** Why the hub closed a connection, as the WebSocket's close code. */
export const HUB_CLOSE = {
  /** The service stops. */
  goingAway: 1001,
  /** A binary frame. */
  unsupported: 1003,
  /** A frame longer than `MAX_HUB_FRAME`. */
  tooBig: 1009,
  /** The first message was not `hello` with the hub's token. */
  unauthorized: 4001,
  /** No `hello` within `HUB_HELLO_MS`. */
  helloTimeout: 4002,
  /** A message that is no command: not JSON, not an object, or without an `id`. */
  malformed: 4003,
} as const;

/** Why a test stopped (`RunStopReason` in the editor's protocol); `other` for a reason of a newer reporter. */
export type HubStopReason = 'breakpoint' | 'step' | 'pause' | 'run-to' | 'page-pause' | 'other';

/** Where a worker stands stopped: before a call, which runs as soon as the stop is answered. */
export interface HubStop {
  reason: HubStopReason;
  /** The call about to run, as Playwright titles it: `Click getByRole('button', { name: 'Pay' })`. */
  title: string;
  /** The file of the call's line, a spec or a page object, as a `file:` URI, and the 0-based line and character. */
  uri: string;
  line: number;
  character: number | null;
  /** The locator the call acts on, as source; null for none. */
  locator: string | null;
  /** Whether Piwi's pause bar shows in the test's window: false in a headless run, where Pick and Record need one. */
  bar: boolean;
  /** Names the stop: a control passes it back as `since`, and one that no worker stands at any more is refused. */
  since: string;
}

/** A test a worker runs. */
export interface HubTest {
  /** Playwright's id of the test. */
  id: string;
  /** Its `test.describe` blocks' titles, then its own. */
  title: string[];
  /** Its spec as a `file:` URI, and the 0-based line of its `test(…)` call. */
  uri: string;
  line: number;
  /** Its Playwright project; empty for a config without projects. */
  project: string;
  /** 0 on its first attempt. */
  retry: number;
  /** Why it never stops; null when it can. */
  cannotPause: string | null;
}

/** What a stop of a worker can start from outside the page: the pause bar's Pick a locator and Record here. */
export type HubIntent = 'pick' | 'record';

/** A worker of a run. */
export interface HubWorker {
  /** Playwright's worker index, which the commands name. */
  worker: number;
  parallelIndex: number;
  state: 'running' | 'stopped' | 'between';
  test: HubTest | null;
  stop: HubStop | null;
  /** A Pause reached it and it has not stopped yet. */
  pausing: boolean;
  /** The intents its reporter takes: none for one that predates them, whose stops Pick and Record are refused at. */
  intents: HubIntent[];
}

/** A run the editor started, with its workers. */
export interface HubSession {
  /** The ref of the command that started it: the commands name the run by it. */
  ref: string;
  /** The folder of the run's Playwright config, absolute; null when no config of the workspace holds it. */
  root: string | null;
  /** That folder as the editor names it (`shop`, `shop/e2e`); null without one. */
  label: string | null;
  /** The command the editor ran (`npx playwright test tests/cart.spec.ts:3 --headed`); null when it does not know. */
  command: string | null;
  /** The name of the Piwi project the folder reads; null without one. */
  project: string | null;
  /** Its workers connected now; none for a moment while Playwright starts a new one. */
  workers: HubWorker[];
  /** The run ended: its last message. A later run of the same ref is a new session. */
  ended: boolean;
}

/** An image of a stopped page: a JPEG, base64. */
export interface HubImage {
  mime: 'image/jpeg';
  data: string;
}

/** The controls the extension sends; Run to a line stays in the editor, which has the file. */
export type HubControlAction = 'pause' | 'step' | 'resume' | 'finish';

/** The first message: the token of the hub's discovery file. */
export interface HubHello {
  type: 'hello';
  token: string;
}

/** A command, after `hello`: `id` (1 to 2147483647) names its answer. */
export type HubCommand =
  /** Hear every run of the editor: one `session` for each live now, after the answer, then each change. */
  | { type: 'subscribe'; id: number }
  /**
   * Steer a run, as `piwi/runControl` does: `pause` every running worker (or `worker`), or answer the stop of the one
   * stopped (`worker`, needed when several are): `step`, `resume`, `finish`. `since` names the stop the extension
   * showed, and these three need it: one that went on is refused (`The test went on.`), so a click twice does not skip
   * the next stop. `pause` takes none.
   */
  | {
      type: 'runControl';
      id: number;
      ref: string;
      worker: number | null;
      action: HubControlAction;
      since: string | null;
    }
  /** An image of a stopped worker's page, without the pause bar: the answer's `image`. */
  | { type: 'pausedPage'; id: number; ref: string; worker: number }
  /**
   * At the stop `since` names (of the one stopped worker, or `worker`), start what the pause bar's **Pick a locator**
   * (`pick`) or **Record here** (`record`) starts, in the test's window: the picked locator goes to the editor in place
   * of the locator on the stopped line, the recorded steps above that line. Refused at a stop no pause bar shows (a
   * headless run), and at a stop the test went on from.
   */
  | { type: HubIntent; id: number; ref: string; worker: number | null; since: string };

/** What `parseHubCommand` reads: a command, or one answered as refused. */
export type ParsedHubCommand =
  | HubCommand
  /** A command of a type this version does not know. */
  | { type: 'unknown'; id: number; what: string }
  /** A command of a known type with a field it cannot take, and why. */
  | { type: 'invalid'; id: number; message: string };

/** The answer to a command: whether it was done, or why not, in one sentence a person can read. */
export interface HubAnswer {
  type: 'answer';
  id: number;
  ok: boolean;
  message: string;
  /** For `pausedPage`: the image, null when there is none. */
  image?: HubImage | null;
}

/** Sent once `hello` was accepted: the service the connection reached. */
export interface HubWelcome {
  type: 'welcome';
  pid: number;
  version: string;
  client: string | null;
  roots: string[];
  keepaliveMs: number;
}

/** A run that changed, or every run live as `subscribe` is answered. */
export interface HubSessionMessage {
  type: 'session';
  session: HubSession;
}

/** What the hub sends. */
export type HubMessage = HubWelcome | HubAnswer | HubSessionMessage | { type: 'keepalive' };

/** A live hub, as the Send to editor endpoint's `GET …/live` lists it. */
export interface LiveHub extends HubAddress {
  pid: number;
  version: string;
  client: string | null;
  roots: string[];
  startedAt: string;
}

/** The body of `GET /piwi/live` and `GET /api/piwi/live`. */
export interface LiveAnswer {
  hubs: LiveHub[];
}

/** The hubs of the live services' discovery files (`readLiveEditors`), as `GET …/live` lists them. */
export function liveHubsOf(editors: readonly EditorDiscovery[]): LiveHub[] {
  return editors.flatMap((editor) =>
    editor.hub
      ? [
          {
            url: editor.hub.url,
            token: editor.hub.token,
            pid: editor.pid,
            version: editor.version,
            client: editor.client,
            roots: editor.roots,
            startedAt: editor.startedAt,
          },
        ]
      : [],
  );
}

/** The live endpoint beside a Send to editor endpoint: `…/piwi/send` → `…/piwi/live`; null for another address. */
export function liveUrlOf(sendUrl: string): string | null {
  return sendUrl.endsWith('/send') ? `${sendUrl.slice(0, -'/send'.length)}/live` : null;
}

const CHROME_EXTENSION = /^chrome-extension:\/\/[a-p]{32}$/;
const FIREFOX_EXTENSION = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an `Origin` is a browser extension's: Chrome's and Edge's ids, Firefox's per-install UUIDs; never a page's. */
export function isExtensionOrigin(origin: string | null | undefined): boolean {
  return typeof origin === 'string' && (CHROME_EXTENSION.test(origin) || FIREFOX_EXTENSION.test(origin));
}

/** Whether a handshake's `Host` names the hub itself, listening on `port`: a page under another name is refused. */
export function isHubHost(host: string | null | undefined, port: number): boolean {
  if (typeof host !== 'string') return false;
  const lower = host.toLowerCase();
  return lower === `127.0.0.1:${port}` || lower === `localhost:${port}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isInt(value: unknown, min: number, max = 2_147_483_647): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

const REF = /^[\w-]{1,64}$/;
const ACTIONS: readonly string[] = ['pause', 'step', 'resume', 'finish'];
/** Why a command that answers a stop and names none is refused. */
const NEEDS_STOP = 'The command needs the stop it answers.';

/** The token of a `hello`; null for any other message. */
export function parseHubHello(text: string): string | null {
  const value = readJson(text);
  return value?.type === 'hello' && typeof value.token === 'string' && value.token.length <= 256 ? value.token : null;
}

/** A message after `hello`, checked field by field; null for one that is no command (it closes the connection). */
export function parseHubCommand(text: string): ParsedHubCommand | null {
  const value = readJson(text);
  if (!value || !isInt(value.id, 1)) return null;
  const { id } = value;
  const invalid = (message: string): ParsedHubCommand => ({ type: 'invalid', id, message });
  if (typeof value.type !== 'string' || !value.type) return invalid('A command needs a type.');
  if (value.type === 'subscribe') return { type: 'subscribe', id };
  if (!['runControl', 'pausedPage', 'pick', 'record'].includes(value.type)) {
    return { type: 'unknown', id, what: value.type.slice(0, 64) };
  }
  if (typeof value.ref !== 'string' || !REF.test(value.ref)) return invalid('The command needs the ref of a run.');
  const { ref } = value;
  const worker = value.worker === undefined || value.worker === null ? null : value.worker;
  if (worker !== null && !isInt(worker, 0)) return invalid('worker must be a worker index or null.');
  const since = value.since === undefined || value.since === null ? null : value.since;
  if (since !== null && (typeof since !== 'string' || !since || since.length > 64)) {
    return invalid('since must name a stop or be null.');
  }
  switch (value.type) {
    case 'runControl': {
      const { action } = value;
      if (action === 'run-to') return invalid('Run to a line stays in the editor: use Run to Cursor there.');
      if (typeof action !== 'string' || !ACTIONS.includes(action)) {
        return invalid('action must be pause, step, resume or finish.');
      }
      if (action !== 'pause' && since === null) return invalid(NEEDS_STOP);
      return { type: 'runControl', id, ref, worker, action: action as HubControlAction, since };
    }
    case 'pausedPage':
      return worker === null ? invalid('pausedPage needs the worker.') : { type: 'pausedPage', id, ref, worker };
    default:
      return since === null ? invalid(NEEDS_STOP) : { type: value.type as HubIntent, id, ref, worker, since };
  }
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

/** A text or null; undefined for anything else. */
function nullableStr(value: unknown, max: number): string | null | undefined {
  return value === null ? null : (str(value, max) ?? undefined);
}

const STOP_REASONS: readonly string[] = ['breakpoint', 'step', 'pause', 'run-to', 'page-pause'];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function readImage(value: unknown): HubImage | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || value.mime !== 'image/jpeg') return undefined;
  return typeof value.data === 'string' && value.data && BASE64.test(value.data)
    ? { mime: 'image/jpeg', data: value.data }
    : undefined;
}

function readStop(value: unknown): HubStop | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const { reason, title, uri, line, character, locator, bar, since } = value;
  if (typeof reason !== 'string' || str(title, 1000) === null || str(uri, 8192) === null) return undefined;
  if (!isInt(line, 0) || (character !== null && !isInt(character, 0)) || typeof bar !== 'boolean') return undefined;
  if ((locator !== null && str(locator, 1000) === null) || str(since, 64) === null) return undefined;
  return {
    reason: STOP_REASONS.includes(reason) ? (reason as HubStopReason) : 'other',
    title: title as string,
    uri: uri as string,
    line,
    character: character as number | null,
    locator: locator as string | null,
    bar,
    since: since as string,
  };
}

function readTest(value: unknown): HubTest | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const { id, title, uri, line, project, retry, cannotPause } = value;
  if (str(id, 256) === null || str(uri, 8192) === null || str(project, 200) === null) return undefined;
  if (!Array.isArray(title) || title.length > 64 || !title.every((t) => str(t, 1000) !== null)) return undefined;
  if (!isInt(line, 0) || !isInt(retry, 0) || (cannotPause !== null && str(cannotPause, 500) === null)) {
    return undefined;
  }
  return {
    id: id as string,
    title: title as string[],
    uri: uri as string,
    line,
    project: project as string,
    retry,
    cannotPause: cannotPause as string | null,
  };
}

function readWorker(value: unknown): HubWorker | null {
  if (!isObject(value)) return null;
  const { worker, parallelIndex, state, pausing } = value;
  if (!isInt(worker, 0) || !isInt(parallelIndex, 0) || typeof pausing !== 'boolean') return null;
  if (state !== 'running' && state !== 'stopped' && state !== 'between') return null;
  const test = readTest(value.test);
  const stop = readStop(value.stop);
  if (test === undefined || stop === undefined) return null;
  const intents = Array.isArray(value.intents)
    ? (['pick', 'record'] as const).filter((intent) => (value.intents as unknown[]).includes(intent))
    : [];
  return { worker, parallelIndex, state, test, stop, pausing, intents };
}

function readSession(value: unknown): HubSession | null {
  if (!isObject(value) || typeof value.ref !== 'string' || !REF.test(value.ref) || typeof value.ended !== 'boolean') {
    return null;
  }
  const root = nullableStr(value.root, 4096);
  const label = nullableStr(value.label, 4096);
  const command = nullableStr(value.command, MAX_HUB_COMMAND);
  const project = nullableStr(value.project, MAX_HUB_PROJECT);
  if (root === undefined || label === undefined || command === undefined || project === undefined) return null;
  if (!Array.isArray(value.workers) || value.workers.length > 1000) return null;
  const workers = value.workers.map(readWorker);
  if (!workers.every((w): w is HubWorker => w !== null)) return null;
  return { ref: value.ref, root, label, command, project, workers, ended: value.ended };
}

/** A message from the hub, checked field by field; null when it is not one, or of a type this version does not know. */
export function parseHubMessage(text: string): HubMessage | null {
  const value = readJson(text);
  if (!value) return null;
  switch (value.type) {
    case 'welcome': {
      const { pid, version, client, roots, keepaliveMs } = value;
      if (!isInt(pid, 1) || str(version, 64) === null || !isInt(keepaliveMs, 1)) return null;
      if (client !== null && str(client, MAX_HUB_CLIENT) === null) return null;
      if (!Array.isArray(roots) || roots.length > MAX_HUB_ROOTS || !roots.every((r) => str(r, 4096) !== null)) {
        return null;
      }
      return {
        type: 'welcome',
        pid,
        version: version as string,
        client: client as string | null,
        roots: roots as string[],
        keepaliveMs,
      };
    }
    case 'answer': {
      const { id, ok, message } = value;
      if (!isInt(id, 1) || typeof ok !== 'boolean' || str(message, 1000) === null) return null;
      const answer: HubAnswer = { type: 'answer', id, ok, message: message as string };
      if (value.image === undefined) return answer;
      const image = readImage(value.image);
      return image === undefined ? null : { ...answer, image };
    }
    case 'session': {
      const session = readSession(value.session);
      return session ? { type: 'session', session } : null;
    }
    case 'keepalive':
      return { type: 'keepalive' };
    default:
      return null;
  }
}

/** The hubs of a `GET …/live` answer, checked field by field: an entry it cannot read is left out; null for no answer. */
export function parseLiveAnswer(body: unknown): LiveHub[] | null {
  if (!isObject(body) || !Array.isArray(body.hubs)) return null;
  return body.hubs.flatMap((hub): LiveHub[] => {
    if (!isObject(hub)) return [];
    const { url, token, pid, version, client, roots, startedAt } = hub;
    if (typeof url !== 'string' || !/^ws:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/[\w/-]{0,64}$/.test(url)) return [];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(token) || !isInt(pid, 1)) return [];
    if (str(version, 64) === null || str(startedAt, 64) === null) return [];
    if (client !== null && str(client, 200) === null) return [];
    if (!Array.isArray(roots) || !roots.every((r) => str(r, 4096) !== null)) return [];
    return [
      {
        url,
        token,
        pid,
        version: version as string,
        client: client as string | null,
        roots: roots as string[],
        startedAt: startedAt as string,
      },
    ];
  });
}
