/**
 * **Inspect** on the run page's live view (`@piwitests/core/live-view`): the page of a running test at each of its
 * calls, as a document. While a viewer of a worker in full has Inspect open (`view`'s `inspect` on the worker's
 * stream), the worker sends the DOM snapshots Playwright's trace takes of the watched page (`snapshot`), and the
 * stylesheets, fonts and images they name (`resource`), each a live message whose data is the snapshot's JSON or the
 * resource's bytes. Nothing goes while no viewer has Inspect open, and nothing is stored: the instance keeps them in
 * memory for the run, and serves each viewer the page rendered, without a script.
 *
 * - **A snapshot** is the `snapshot` object of a `frame-snapshot` event of the trace, as Playwright wrote it, what the
 *   page's secret fields hold removed by the worker before it leaves: its data, the UTF-8 JSON, `MAX_SNAPSHOT_BYTES` at
 *   most. Its header names the call it is of (Playwright's id, and its title, the
 *   text it types and its credentials hidden), its moment (`before` the call, at its `action`, `after` it), its page and
 *   frame (Playwright's ids), whether it is of the page's main frame (`main`), whether it refers to no earlier snapshot
 *   (`full`), when it was taken, and the resources it names (`resources`: each one's address, as the page asked for it,
 *   and its `sha1`), those its stylesheets name included.
 * - **A frame's chain.** A snapshot that is not full refers to the nodes of the snapshots of its frame before it, by how
 *   many snapshots back (`[[back, index]]` in its `html`), so a frame's snapshots are read as one chain, from its last
 *   full one. The worker sends each chain whole and in order: one it cannot send whole (a snapshot past
 *   `MAX_SNAPSHOT_BYTES`, one it cannot read) it leaves until the frame's next full snapshot, and a full snapshot starts
 *   its frame's chain again. As Inspect opens, the worker first sends the watched page's snapshots since its last
 *   navigation (the main frame's last full snapshot onward, of every frame), `MAX_SNAPSHOT_BACKLOG` bytes at most, the
 *   oldest left out past them, then each new one, `SNAPSHOTS_PER_SECOND` at most.
 * - **A resource** is a file of the trace's `resources/` folder, by its name there (`sha1`: the SHA-1 of its bytes and
 *   its extension), `MAX_RESOURCE_BYTES` at most, sent once per run, only when a snapshot sent names it and only for a
 *   content type `inspectResourceType` allows: a stylesheet, a font, or an image other than SVG. Never a script, a
 *   document, an SVG nor anything else. The instance finds a resource by its address in the `resources` of a snapshot
 *   (that of the snapshot it renders, else of one before it in its frame's chain).
 */
import { isLayerCallId, isLayerTime } from './live-layers';
import { hideSecretsInText, hideTypedText } from './mask';

/** The longest snapshot a worker sends, in bytes of its JSON: a longer one is not sent, nor its frame's chain after it. */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
/** The longest resource a worker sends, in bytes: a longer one is not sent. */
export const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
/** The most bytes of snapshots a worker sends as Inspect opens: past them, the oldest are left out. */
export const MAX_SNAPSHOT_BACKLOG = 16 * 1024 * 1024;
/** The most snapshots a worker sends a second: the others wait their turn. */
export const SNAPSHOTS_PER_SECOND = 12;
/** The most resources one snapshot names in its header: the others are not named. */
export const MAX_SNAPSHOT_RESOURCES = 256;
/** The longest address of a resource a snapshot names, in characters: a longer one is not named. */
export const MAX_RESOURCE_URL = 2048;
/** The longest call title a snapshot carries; a longer one is cut. */
const MAX_TITLE = 300;

/** The data a live message of each Inspect type carries at most, in bytes, for a reader of live messages. */
export const LIVE_INSPECT_DATA_LIMITS: Readonly<Record<'snapshot' | 'resource', number>> = {
  snapshot: MAX_SNAPSHOT_BYTES,
  resource: MAX_RESOURCE_BYTES,
};

/** When a snapshot was taken: before its call, at its action (where an input action acts), or after it. */
export type SnapshotPhase = 'before' | 'action' | 'after';

const PHASES: readonly string[] = ['before', 'action', 'after'];

/** A resource a snapshot names: its address, as the page asked for it, and its name among the trace's resources. */
export interface LiveSnapshotResource {
  url: string;
  sha1: string;
}

/** A snapshot's header, as a worker sends it and the instance reads it: everything but its JSON. */
export interface LiveSnapshot {
  /** Playwright's id of the call it is of. */
  call: string;
  /** The call's title, the text it types and its credentials hidden. */
  title: string;
  phase: SnapshotPhase;
  /** Playwright's ids of its page and of its frame. */
  page: string;
  frame: string;
  /** Whether it is of the page's main frame. */
  main: boolean;
  /** Whether it refers to no earlier snapshot: its frame's chain starts again with it. */
  full: boolean;
  /** When it was taken, in epoch milliseconds. */
  at: number;
  resources: LiveSnapshotResource[];
}

/** A resource's header: its name among the trace's resources, and its content type, as `inspectResourceType` reads it. */
export interface LiveResource {
  sha1: string;
  contentType: string;
}

/** The images a resource may be: never an SVG, which may hold a script. */
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/x-icon',
  'image/bmp',
]);

/**
 * The content type of a resource Inspect may send, from a `Content-Type` as a trace records it (its parameters
 * dropped, in lower case): a stylesheet (`text/css`), a font (`font/*`, `application/font-*`,
 * `application/vnd.ms-fontobject`) or an image other than SVG (`IMAGE_TYPES`); null for any other, a script, a document
 * and an SVG among them.
 */
export function inspectResourceType(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  const type = value.split(';')[0]!.trim().toLowerCase();
  if (type === 'text/css' || type === 'application/vnd.ms-fontobject' || IMAGE_TYPES.has(type)) return type;
  return /^(?:font\/|application\/font-)[a-z0-9][a-z0-9.+-]{0,40}$/.test(type) ? type : null;
}

/** A resource's name among a trace's resources: the SHA-1 of its bytes in hex, and its extension. */
const SHA1 = /^[0-9a-f]{40}(?:\.[A-Za-z0-9]{1,16})?$/;

/** Whether `value` is a resource's name among a trace's resources (`resources/<sha1>`). */
export function isResourceSha1(value: unknown): value is string {
  return typeof value === 'string' && SHA1.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An http(s) address of `MAX_RESOURCE_URL` characters at most, on one line; null for anything else. */
function resourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_RESOURCE_URL || /\p{Cc}/u.test(value)) return null;
  return /^https?:\/\/[^\s]/i.test(value) ? value : null;
}

/** The resources a snapshot names, each checked, those that are not one left out, `MAX_SNAPSHOT_RESOURCES` at most. */
function readResources(value: unknown): LiveSnapshotResource[] | null {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOT_RESOURCES) return null;
  const resources: LiveSnapshotResource[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const url = resourceUrl(item.url);
    if (url && isResourceSha1(item.sha1)) resources.push({ url, sha1: item.sha1 });
  }
  return resources;
}

/** The header of a snapshot as a worker posts it, beside the fields that name the worker and its test. */
export function liveSnapshotFields(snapshot: LiveSnapshot): Record<string, unknown> {
  return {
    call: snapshot.call,
    title: snapshot.title,
    phase: snapshot.phase,
    page: snapshot.page,
    frame: snapshot.frame,
    main: snapshot.main,
    full: snapshot.full,
    at: Math.round(snapshot.at),
    resources: snapshot.resources,
  };
}

/** Whether `data` is a snapshot's JSON: UTF-8, an object whose `html` is a node list, of the frame `frame`. */
function isSnapshotJson(data: Uint8Array, frame: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  } catch {
    return false;
  }
  if (!isObject(value) || !Array.isArray(value.html)) return false;
  return value.frameId === undefined || value.frameId === frame;
}

/**
 * A snapshot's header, checked field by field: its title hidden again and cut, the resources that are not one left
 * out; why not, as a sentence, when it is not one.
 */
export function readLiveSnapshotFields(header: Record<string, unknown>): LiveSnapshot | string {
  const { call, title, phase, page, frame, main, full, at } = header;
  if (!isLayerCallId(call) || typeof title !== 'string' || !title.trim() || !PHASES.includes(phase as string)) {
    return 'A snapshot names its call, its title and its moment: before, action or after.';
  }
  if (!isLayerCallId(page) || !isLayerCallId(frame) || typeof main !== 'boolean' || typeof full !== 'boolean') {
    return 'A snapshot names its page and its frame, and says whether it is of the main frame and whether it is full.';
  }
  if (!isLayerTime(at)) return 'A snapshot says when it was taken.';
  const resources = readResources(header.resources);
  if (!resources) return `A snapshot names ${MAX_SNAPSHOT_RESOURCES} resources at most, in a list.`;
  return {
    call,
    title: hideSecretsInText(hideTypedText(title)).slice(0, MAX_TITLE),
    phase: phase as SnapshotPhase,
    page,
    frame,
    main,
    full,
    at: Math.round(at),
    resources,
  };
}

/**
 * A snapshot's header and its data, as a live message carries them: its fields as `readLiveSnapshotFields` reads them,
 * its data the JSON of a snapshot of its frame, `MAX_SNAPSHOT_BYTES` at most; why not, as a sentence, when it is not
 * one.
 */
export function readLiveSnapshot(
  header: Record<string, unknown>,
  data: Uint8Array | null,
): (LiveSnapshot & { data: Uint8Array }) | string {
  const fields = readLiveSnapshotFields(header);
  if (typeof fields === 'string') return fields;
  if (!data || data.length > MAX_SNAPSHOT_BYTES || !isSnapshotJson(data, fields.frame)) {
    return `A snapshot's data is the JSON of a snapshot of its frame, ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB at most.`;
  }
  return { ...fields, data };
}

/**
 * A resource's header and its bytes, as a live message carries them, checked field by field: its name among the trace's
 * resources, a content type `inspectResourceType` allows, and bytes, `MAX_RESOURCE_BYTES` at most; why not, as a
 * sentence, when it is not one.
 */
export function readLiveResource(
  header: Record<string, unknown>,
  data: Uint8Array | null,
): (LiveResource & { data: Uint8Array }) | string {
  if (!isResourceSha1(header.sha1)) return 'A resource names its file among the trace’s resources.';
  const contentType = inspectResourceType(header.contentType);
  if (!contentType) return 'A resource is a stylesheet, a font or an image other than SVG.';
  if (!data || data.length === 0 || data.length > MAX_RESOURCE_BYTES) {
    return `A resource's data is its bytes, ${MAX_RESOURCE_BYTES / 1024 / 1024} MB at most.`;
  }
  return { sha1: header.sha1, contentType, data };
}
