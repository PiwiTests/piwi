/**
 * The layers of a lane's view beside its images: what a viewer of a running test reads besides its pixels. Each layer is
 * produced only while a viewer subscribes to it, names the test it is of, is bounded in size and rate, and is read here
 * field by field on every side that takes it. They travel on the two wires a worker speaks: the run channel to the hub
 * of the developer's machine (`@piwitests/core/run-channel`'s `layers` and `lane-layer`, which the hub hands on to the
 * lane's viewers alone as `@piwitests/core/run-hub`'s `lane-layer`), and the live view to the team instance
 * (`@piwitests/core/live-view`'s `view.layers`, `page-event`, `text` and `thumb`), which relays them to the watches that
 * asked for them and keeps none.
 *
 * - `calls`: the call the test is in, as Playwright logs it (`LiveCallLog` of `@piwitests/core/live-view`): on the run
 *   channel while asked, from Playwright's in-process instrumentation, which pauses nothing; on the live view with the
 *   full view, as its `call-log`.
 * - `events`: what the page and the test's requests say as they go (`PageEvent`): console errors, errors the page threw
 *   that nothing caught, requests that failed or were answered with an error status, requests pending long, the errors
 *   and warnings a backend logged on a response (its `X-Piwi-Logs` header), and each call the test makes through an API
 *   request context, a test with no page included. `MAX_PAGE_EVENTS_PER_SECOND` a second at most, the others counted
 *   (`dropped`).
 * - `text`: the page as roles and names (`LaneText`), an ARIA snapshot: from the trace's own file of the call when the
 *   project's trace writes one (`aria/<callId>-after.json`, rendered by `ariaTreeText`), else taken when a viewer asks
 *   (`ariaSnapshot` in AI mode, `LANE_TEXT_DEPTH` levels deep), each field that holds a secret written as `<hidden>`
 *   (`maskAriaSnapshot` of `@piwitests/core/mask`), `MAX_LANE_TEXT` characters at most.
 * - `filmstrip`: one image for each call of the test that ended (`LaneThumb`), for a viewer who comes late: on the
 *   developer's machine the trace's own screencast image of it, nothing captured beside it; for the team the view's own
 *   masked images, taken only while someone watches, kept in the worker's memory (`MAX_FILMSTRIP` images and
 *   `MAX_FILMSTRIP_BYTES` at most). `MAX_LANE_THUMB` bytes each, `LANE_THUMBS_PER_SECOND` a second at most.
 */
import { hideSecretsInText, hideSecretsInUrl, hideTypedText, maskAriaSnapshot } from './mask';

/** A layer of a lane's view beside its images. */
export type LaneLayer = 'calls' | 'events' | 'text' | 'filmstrip';

/** Every layer, in the order a reader lists them. */
export const LANE_LAYERS: readonly LaneLayer[] = ['calls', 'events', 'text', 'filmstrip'];

/** The longest list of layers a reader reads: a longer one is read as none. */
const MAX_LAYER_LIST = 16;

/** The layers a message lists, those this side knows, each once, in `LANE_LAYERS`' order; null for no list. */
export function readLaneLayers(value: unknown): LaneLayer[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_LAYER_LIST) return [];
  return LANE_LAYERS.filter((layer) => value.includes(layer));
}

/** The longest text a page event carries, in characters: a longer one is cut. */
export const MAX_PAGE_EVENT_TEXT = 1000;
/** The longest address a page event carries, in characters: a longer one is cut. */
export const MAX_PAGE_EVENT_URL = 2048;
/** The most page events a worker sends a second on one wire: the others are counted, and said as `dropped`. */
export const MAX_PAGE_EVENTS_PER_SECOND = 20;
/** How long a request waits for its answer before it is told pending, and again each time as long passed. */
export const PENDING_REQUEST_MS = 5000;
/** The most requests of a worker followed for their answer at once: past them, a request is not followed. */
export const MAX_FOLLOWED_REQUESTS = 200;
/** The longest a request is said to have taken, in milliseconds: a week. */
const MAX_EVENT_MS = 7 * 24 * 3_600_000;

/**
 * What the page and the test's requests said, each text and address with its credentials hidden
 * (`hideSecretsInText`, `hideSecretsInUrl`):
 *
 * - `console`: the page logged an error;
 * - `page-error`: the page threw an error nothing caught;
 * - `request-failed`: a request of the page failed (`failure`, the browser's words) or was answered with a status of
 *   400 or more;
 * - `request-pending`: a request of the page has waited `ms` for its answer, told once it waited `PENDING_REQUEST_MS`
 *   and again each time as long passed (`done: false`), then once more as it ends (`done: true`, the time it took), by
 *   the worker's number for it (`id`), so a viewer shows one line for it ("POST /api/checkout pending 17 s");
 * - `backend`: the backend logged an error or a warning while it answered a request, as its instrumentation says on the
 *   response (`X-Piwi-Logs`, the capture fixtures' reading): the request, its status and the logged message;
 * - `api`: the test called its backend through an API request context (`request.post(…)`): how it was answered, or why
 *   not, and how long it took;
 * - `dropped`: how many events were not sent, past `MAX_PAGE_EVENTS_PER_SECOND`.
 */
export type PageEvent =
  | { kind: 'console'; text: string }
  | { kind: 'page-error'; text: string }
  | { kind: 'request-failed'; method: string; url: string; status: number | null; failure: string | null }
  | { kind: 'request-pending'; id: number; method: string; url: string; ms: number; done: boolean }
  | { kind: 'backend'; method: string; url: string; status: number | null; level: 'error' | 'warning'; text: string }
  | { kind: 'api'; method: string; url: string; status: number | null; ms: number; failure: string | null }
  | { kind: 'dropped'; count: number };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** A text an event carries: its credentials hidden, then cut; null for anything but a text. */
function eventText(value: unknown, max = MAX_PAGE_EVENT_TEXT): string | null {
  return typeof value === 'string' ? hideSecretsInText(value).slice(0, max) : null;
}

/** An address an event carries: one line, its credentials hidden, then cut; null for anything else. */
function eventUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) return null;
  return hideSecretsInUrl(value.slice(0, 8192)).slice(0, MAX_PAGE_EVENT_URL);
}

/** An HTTP method, upper case; null for anything but letters, 16 at most. */
function method(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{1,16}$/.test(value) ? value.toUpperCase() : null;
}

/** An HTTP status, 100 to 599, or null; undefined for anything else. */
function status(value: unknown): number | null | undefined {
  if (value === null) return null;
  return isInt(value, 100, 599) ? value : undefined;
}

/** A text that may be absent: null stays null; undefined for anything but a text or null. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? hideSecretsInText(value).slice(0, max) : undefined;
}

/** A page event, checked field by field, its texts and addresses hidden again and cut; null when it is not one. */
export function readPageEvent(value: unknown): PageEvent | null {
  if (!isObject(value)) return null;
  switch (value.kind) {
    case 'console':
    case 'page-error': {
      const text = eventText(value.text);
      return text === null ? null : { kind: value.kind, text };
    }
    case 'request-failed': {
      const verb = method(value.method);
      const url = eventUrl(value.url);
      const code = status(value.status);
      const failure = optionalText(value.failure, 500);
      if (!verb || !url || code === undefined || failure === undefined) return null;
      return { kind: 'request-failed', method: verb, url, status: code, failure };
    }
    case 'request-pending': {
      const verb = method(value.method);
      const url = eventUrl(value.url);
      if (!verb || !url || !isInt(value.id, 1, Number.MAX_SAFE_INTEGER) || !isInt(value.ms, 0, MAX_EVENT_MS)) {
        return null;
      }
      if (typeof value.done !== 'boolean') return null;
      return { kind: 'request-pending', id: value.id, method: verb, url, ms: value.ms, done: value.done };
    }
    case 'backend': {
      const verb = method(value.method);
      const url = eventUrl(value.url);
      const code = status(value.status);
      const text = eventText(value.text);
      if (!verb || !url || code === undefined || text === null) return null;
      if (value.level !== 'error' && value.level !== 'warning') return null;
      return { kind: 'backend', method: verb, url, status: code, level: value.level, text };
    }
    case 'api': {
      const verb = method(value.method);
      const url = eventUrl(value.url);
      const code = status(value.status);
      const failure = optionalText(value.failure, 500);
      if (!verb || !url || code === undefined || failure === undefined || !isInt(value.ms, 0, MAX_EVENT_MS)) {
        return null;
      }
      return { kind: 'api', method: verb, url, status: code, ms: value.ms, failure };
    }
    case 'dropped':
      return isInt(value.count, 1, Number.MAX_SAFE_INTEGER) ? { kind: 'dropped', count: value.count } : null;
    default:
      return null;
  }
}

/** Whether `value` is a time in epoch milliseconds: a finite number after 2001. */
export function isLayerTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 1e12;
}

/** Playwright's id of a call, as a trace and its call stream name it (`pw:api@12`, `call@4`). */
const CALL_ID = /^[\w@:.-]{1,100}$/;

/** Whether `value` is a call's id as a layer names it. */
export function isLayerCallId(value: unknown): value is string {
  return typeof value === 'string' && CALL_ID.test(value);
}

/** The longest page's text a layer carries, in characters: a longer one is cut, and says so (`cut`). */
export const MAX_LANE_TEXT = 96 * 1024;
/** How deep the page's text taken on request reads its tree. */
export const LANE_TEXT_DEPTH = 8;
/** The most texts a worker sends a second on one wire: the latest alone waits. */
export const LANE_TEXTS_PER_SECOND = 1;

/**
 * The page as roles and names, an ARIA snapshot in Playwright's text form: after the call `call` (Playwright's id),
 * from the trace's file of it (`source: 'trace'`), or taken as a viewer asked (`snapshot`, `call` null), when (`at`, epoch
 * ms). Each field that holds a secret shows `<hidden>` (`maskAriaSnapshot`), and every credential is hidden
 * (`hideSecretsInText`). `cut` says it was cut at `MAX_LANE_TEXT`.
 */
export interface LaneText {
  call: string | null;
  source: 'trace' | 'snapshot';
  text: string;
  cut: boolean;
  at: number;
}

/**
 * A page's text, checked field by field, cut at `MAX_LANE_TEXT` and masked again as a snapshot alone tells (a field
 * named for a secret, a card's number) with its credentials hidden; null when it is not one.
 */
export function readLaneText(value: unknown): LaneText | null {
  if (!isObject(value) || typeof value.text !== 'string' || !value.text.trim()) return null;
  if (value.source !== 'trace' && value.source !== 'snapshot') return null;
  if (value.call !== null && !isLayerCallId(value.call)) return null;
  if (!isLayerTime(value.at)) return null;
  const text = hideSecretsInText(maskAriaSnapshot(value.text.slice(0, MAX_LANE_TEXT)));
  const cut = value.cut === true || value.text.length > MAX_LANE_TEXT || text.length > MAX_LANE_TEXT;
  return {
    call: value.call as string | null,
    source: value.source,
    text: text.slice(0, MAX_LANE_TEXT),
    cut,
    at: value.at,
  };
}

/** The longest image of a filmstrip, in bytes of JPEG: a longer one is not sent. */
export const MAX_LANE_THUMB = 128 * 1024;
/** The longest image of a filmstrip, in characters of base64. */
export const MAX_LANE_THUMB_BASE64 = 4 * Math.ceil(MAX_LANE_THUMB / 3);
/** The size an image of the team's filmstrip is made at most, in pixels. */
export const LANE_THUMB_WIDTH = 320;
export const LANE_THUMB_HEIGHT = 200;
/** The most images a test's filmstrip keeps, the latest, and sends again to a viewer who comes later. */
export const MAX_FILMSTRIP = 40;
/** The most bytes of images a worker keeps of the team's filmstrip of its test. */
export const MAX_FILMSTRIP_BYTES = 1024 * 1024;
/** The most images of a filmstrip a worker sends a second on one wire. */
export const LANE_THUMBS_PER_SECOND = 8;
/** The longest title an image of a filmstrip carries, in characters. */
const MAX_THUMB_TITLE = 300;

/**
 * An image of a test's filmstrip: the page after the call `call` (Playwright's id) ended, its title (the text a call
 * types hidden, `hideTypedText`, and its credentials, `hideSecretsInText`), its place in the strip from 1 (`index`: a
 * later call's is larger), the image's size in pixels, and when the page looked so (`at`, epoch ms). Its JPEG goes
 * beside it: base64 on the run channel and the hub, the bytes of a live message on the live view.
 */
export interface LaneThumb {
  call: string;
  title: string;
  index: number;
  width: number;
  height: number;
  at: number;
}

/** An image of a filmstrip's fields, checked one by one, its title hidden again and cut; null when it is not one. */
export function readLaneThumb(value: unknown): LaneThumb | null {
  if (!isObject(value) || !isLayerCallId(value.call) || typeof value.title !== 'string') return null;
  if (!isInt(value.index, 1, 1_000_000) || !isInt(value.width, 1, 20_000) || !isInt(value.height, 1, 20_000)) {
    return null;
  }
  if (!isLayerTime(value.at)) return null;
  const title = hideSecretsInText(hideTypedText(value.title)).slice(0, MAX_THUMB_TITLE);
  return { call: value.call, title, index: value.index, width: value.width, height: value.height, at: value.at };
}

/** Base64, as an image's data is written. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether `data` is a filmstrip image in base64: a JPEG (`/9j/`), `MAX_LANE_THUMB` bytes at most. */
export function isLaneThumbData(data: unknown): data is string {
  return (
    typeof data === 'string' && data.startsWith('/9j/') && data.length <= MAX_LANE_THUMB_BASE64 && BASE64.test(data)
  );
}

/** Whether `bytes` are a filmstrip image: a JPEG (`FF D8 FF`), `MAX_LANE_THUMB` bytes at most. */
export function isLaneThumbBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length > 3 && bytes.length <= MAX_LANE_THUMB && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  );
}

/** The deepest a trace's ARIA tree is rendered. */
const MAX_TREE_DEPTH = 200;
/** The flags a node of a trace's ARIA tree may hold, as Playwright writes them, in its order. */
const TREE_FLAGS = ['checked', 'disabled', 'expanded', 'level', 'pressed', 'selected'] as const;

/** A role as a node names it: letters, digits and `-`; `generic` for anything else. */
function treeRole(value: unknown): string {
  return typeof value === 'string' && /^[\w-]{1,64}$/.test(value) ? value : 'generic';
}

/** A value as Playwright's text form writes it: quoted where YAML would read it as something else. */
function treeScalar(value: string): string {
  const plain =
    value.length > 0 &&
    value === value.trim() &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/: |\s#|[\n\r\t]/.test(value) &&
    !value.endsWith(':') &&
    !/^(?:[-+]?(?:\d[\d_]*)?\.?\d+(?:[eE][-+]?\d+)?|true|false|null|yes|no|on|off|~)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}

/**
 * The ARIA tree a trace keeps of a page (`aria/<callId>-<phase>.json`: a list of nodes, each with its `role`, `name`,
 * flags, `text` and `children`), in Playwright's text form (`- textbox "Password": S3cr3t`), `max` characters at most;
 * null for anything but a list of nodes.
 */
export function ariaTreeText(value: unknown, max = MAX_LANE_TEXT): { text: string; cut: boolean } | null {
  if (!Array.isArray(value)) return null;
  const lines: string[] = [];
  let length = 0;
  let cut = false;
  const add = (line: string): boolean => {
    if (length + line.length + 1 > max) {
      cut = true;
      return false;
    }
    lines.push(line);
    length += line.length + 1;
    return true;
  };
  const visit = (nodes: unknown[], depth: number): boolean => {
    const indent = '  '.repeat(depth);
    for (const node of nodes) {
      if (typeof node === 'string') {
        if (!add(`${indent}- text: ${treeScalar(node)}`)) return false;
        continue;
      }
      if (!isObject(node)) continue;
      const role = treeRole(node.role);
      const text = typeof node.text === 'string' ? node.text : null;
      if (role === 'text') {
        if (text !== null && !add(`${indent}- text: ${treeScalar(text)}`)) return false;
        continue;
      }
      let head = `${indent}- ${role}`;
      if (typeof node.name === 'string' && node.name) head += ` ${JSON.stringify(node.name)}`;
      for (const flag of TREE_FLAGS) {
        const set = node[flag];
        if (set === true) head += ` [${flag}]`;
        else if (typeof set === 'number' || set === 'mixed') head += ` [${flag}=${set}]`;
      }
      const children = Array.isArray(node.children) && depth < MAX_TREE_DEPTH ? node.children : [];
      const url = typeof node.url === 'string' ? node.url : null;
      if (!children.length && url === null) {
        if (!add(text !== null && text !== '' ? `${head}: ${treeScalar(text)}` : head)) return false;
        continue;
      }
      if (!add(`${head}:`)) return false;
      if (text !== null && text !== '' && !add(`${indent}  - text: ${treeScalar(text)}`)) return false;
      if (url !== null && !add(`${indent}  - /url: ${treeScalar(url)}`)) return false;
      if (!visit(children, depth + 1)) return false;
    }
    return true;
  };
  visit(value, 0);
  return { text: lines.join('\n'), cut };
}
