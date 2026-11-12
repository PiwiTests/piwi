/**
 * **Inspect** on the run page's live view (`@piwitests/core/live-view`): the page of a running test at each of its
 * calls, as a document. While a viewer of a worker in full has Inspect open (`view`'s `inspect` on the worker's
 * stream), the worker sends the DOM snapshots Playwright's trace takes of the watched page (`snapshot`), and the
 * stylesheets, fonts and images they name (`resource`), each a live message whose data is the snapshot's JSON or the
 * resource's bytes. Nothing goes while no viewer has Inspect open, and nothing is stored: the instance keeps them in
 * memory for the run, and serves each viewer the page rendered, without a script.
 *
 * - **A snapshot** is the `snapshot` object of a `frame-snapshot` event of the trace, as Playwright wrote it, what the
 *   page's secrets show and the credentials its addresses and texts hold removed by the worker before it leaves, its
 *   scripts emptied (`hideFrameSnapshotSecrets`): its data, the UTF-8 JSON, `MAX_SNAPSHOT_BYTES` at most. Its header
 *   names the call it is of (Playwright's id, and its title, the text it types and its credentials hidden), its moment
 *   (`before` the call, at its `action`, `after` it), its page and frame (Playwright's ids), whether it is of the
 *   page's main frame (`main`), whether it refers to no earlier snapshot (`full`), its place among its frame's
 *   snapshots in the trace (`index`), when it was taken, and the resources it names (`resources`: each one's address,
 *   as the page asked for it, its credentials hidden as the snapshot's are (`hideResourceUrl`), and its `sha1`), those
 *   its stylesheets name included.
 * - **A frame's chain.** A snapshot that is not full refers to nodes of the snapshots of its frame before it, by how
 *   many snapshots back (`[[back, node]]` in its `html`: the snapshot whose `index` is its own less `back`, and the node
 *   `node` of that one's, numbered as `snapshotNodes` numbers them), back to its frame's last full snapshot at most.
 *   A full snapshot starts its frame's chain again, and its `index` may start again from 0 (a new trace of the page):
 *   the instance drops the frame's earlier snapshots then. A snapshot the worker does not send (one past
 *   `MAX_SNAPSHOT_BYTES`, one it cannot read whole, one whose page's secrets it could not read, one past the bounds
 *   below) stops its frame's chain until its next full snapshot, and the worker says why for a page's main frame; a
 *   reference to a snapshot not sent does not render. As Inspect opens, the worker first sends the watched page's
 *   snapshots since its last navigation (the main frame's last full snapshot onward, of every frame), in the trace's
 *   order, `MAX_SNAPSHOT_BACKLOG` bytes at most: past them, the oldest of those after a frame's full snapshot are left
 *   out, never a full one, and a frame whose full snapshots alone do not fit sends none of its chain. Then each new
 *   one, `SNAPSHOTS_PER_SECOND` at most, `MAX_SNAPSHOT_BACKLOG` bytes waiting at most.
 * - **A resource** is a file of the trace's `resources/` folder, by its name there (`sha1`: the SHA-1 of its bytes and
 *   its extension), `MAX_RESOURCE_BYTES` at most, sent once per run, only when a snapshot sent names it and only for a
 *   content type `inspectResourceType` allows, its bytes of that kind (`isInspectResourceBytes`): a stylesheet, a font
 *   or an image other than SVG. Never a script, a document, an SVG nor anything else. The instance finds a resource by
 *   its address in the `resources` of a snapshot (that of the snapshot it renders, else of one before it in its
 *   frame's chain).
 */
import { isLayerCallId, isLayerTime } from './live-layers';
import {
  HIDDEN_VALUE,
  hideSecretsInText,
  hideSecretsInUrl,
  hideTypedText,
  isSecretAutocomplete,
  isSecretFieldName,
  isSecretName,
  looksLikeCardNumber,
} from './mask';

/** The longest snapshot a worker sends, in bytes of its JSON: a longer one is not sent. */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
/** The longest resource a worker sends, in bytes: a longer one is not sent. */
export const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
/**
 * The most bytes of snapshots a worker sends as Inspect opens, and holds waiting to go: past them, as Inspect opens, the
 * oldest after a frame's full snapshot are left out; later, a frame's chain stops until its next full snapshot.
 */
export const MAX_SNAPSHOT_BACKLOG = 16 * 1024 * 1024;
/** The most snapshots a worker sends a second: the others wait their turn. */
export const SNAPSHOTS_PER_SECOND = 12;
/** The most resources one snapshot names in its header: the others are not named. */
export const MAX_SNAPSHOT_RESOURCES = 256;
/** The longest address of a resource a snapshot names, in characters: a longer one is not named. */
export const MAX_RESOURCE_URL = 2048;
/** The largest place of a snapshot among its frame's. */
const MAX_SNAPSHOT_INDEX = 10_000_000;
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
  /** Its place among its frame's snapshots in the trace, from 0, as a later snapshot's references count. */
  index: number;
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

/** The fonts a resource may be: never an SVG font, which is a document. */
const FONT_TYPES: ReadonlySet<string> = new Set([
  'font/woff',
  'font/woff2',
  'font/ttf',
  'font/otf',
  'font/sfnt',
  'font/collection',
  'application/font-woff',
  'application/x-font-ttf',
  'application/vnd.ms-fontobject',
]);

/**
 * The content type of a resource Inspect may send, from a `Content-Type` as a trace records it (its parameters
 * dropped, in lower case): a stylesheet (`text/css`), a font (`FONT_TYPES`) or an image other than SVG (`IMAGE_TYPES`);
 * null for any other, a script, a document, an SVG and an SVG font among them.
 */
export function inspectResourceType(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  const type = value.split(';')[0]!.trim().toLowerCase();
  return type === 'text/css' || FONT_TYPES.has(type) || IMAGE_TYPES.has(type) ? type : null;
}

/** Whether `data` holds `magic` at `at`: bytes, or the characters of a string. */
function holdsAt(data: Uint8Array, magic: readonly number[] | string, at = 0): boolean {
  const bytes = typeof magic === 'string' ? [...magic].map((c) => c.charCodeAt(0)) : magic;
  return data.length >= at + bytes.length && bytes.every((byte, i) => data[at + i] === byte);
}

/** Whether `data` starts as a PNG, a JPEG, a GIF, a WebP, an AVIF, an icon (or a cursor) or a BMP does. */
function isImageBytes(data: Uint8Array): boolean {
  return (
    holdsAt(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    holdsAt(data, [0xff, 0xd8, 0xff]) ||
    holdsAt(data, 'GIF87a') ||
    holdsAt(data, 'GIF89a') ||
    (holdsAt(data, 'RIFF') && holdsAt(data, 'WEBP', 8)) ||
    (holdsAt(data, 'ftyp', 4) && ['avif', 'avis', 'mif1', 'msf1'].some((brand) => holdsAt(data, brand, 8))) ||
    holdsAt(data, [0, 0, 1, 0]) ||
    holdsAt(data, [0, 0, 2, 0]) ||
    holdsAt(data, 'BM')
  );
}

/** Whether `data` starts as a WOFF, a WOFF2, a TrueType font (or a collection), an OpenType font or an EOT does. */
function isFontBytes(data: Uint8Array): boolean {
  return (
    holdsAt(data, 'wOFF') ||
    holdsAt(data, 'wOF2') ||
    holdsAt(data, [0, 1, 0, 0]) ||
    holdsAt(data, 'true') ||
    holdsAt(data, 'typ1') ||
    holdsAt(data, 'OTTO') ||
    holdsAt(data, 'ttcf') ||
    // An EOT's magic number, 0x504C, written little-endian after its first 34 bytes.
    holdsAt(data, [0x4c, 0x50], 34)
  );
}

/** Whether `data` reads as a stylesheet: text in UTF-8 that does not start with `<` (a document) after a BOM and spaces. */
function isCssBytes(data: Uint8Array): boolean {
  if (holdsAt(data, [0xfe, 0xff]) || holdsAt(data, [0xff, 0xfe])) return false;
  let at = holdsAt(data, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (at < data.length && [0x20, 0x09, 0x0a, 0x0c, 0x0d].includes(data[at]!)) at++;
  return data[at] !== 0x3c;
}

/**
 * Whether a resource's bytes are what its content type (as `inspectResourceType` reads it) says: an image's start as a
 * PNG's, a JPEG's, a GIF's, a WebP's, an AVIF's, an icon's or a BMP's do; a font's as a WOFF's, a WOFF2's, a TrueType
 * font's, an OpenType font's or an EOT's do; a stylesheet's are text that does not start with `<` after a BOM and
 * spaces. Never empty bytes.
 */
export function isInspectResourceBytes(contentType: string, data: Uint8Array): boolean {
  if (!data.length) return false;
  if (contentType === 'text/css') return isCssBytes(data);
  if (IMAGE_TYPES.has(contentType)) return isImageBytes(data);
  return FONT_TYPES.has(contentType) && isFontBytes(data);
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

/**
 * The resources a snapshot names, each checked, its address's credentials hidden again (`hideResourceUrl`), those that
 * are not one left out, `MAX_SNAPSHOT_RESOURCES` at most.
 */
function readResources(value: unknown): LiveSnapshotResource[] | null {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOT_RESOURCES) return null;
  const resources: LiveSnapshotResource[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const named = resourceUrl(item.url);
    const url = named && hideResourceUrl(named);
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
    index: snapshot.index,
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
  const { call, title, phase, page, frame, main, full, index, at } = header;
  if (!isLayerCallId(call) || typeof title !== 'string' || !title.trim() || !PHASES.includes(phase as string)) {
    return 'A snapshot names its call, its title and its moment: before, action or after.';
  }
  if (!isLayerCallId(page) || !isLayerCallId(frame) || typeof main !== 'boolean' || typeof full !== 'boolean') {
    return 'A snapshot names its page and its frame, and says whether it is of the main frame and whether it is full.';
  }
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > MAX_SNAPSHOT_INDEX) {
    return 'A snapshot says its place among its frame’s snapshots.';
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
    index,
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
 * resources, a content type `inspectResourceType` allows, and bytes of that kind (`isInspectResourceBytes`),
 * `MAX_RESOURCE_BYTES` at most; why not, as a sentence, when it is not one.
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
  if (!isInspectResourceBytes(contentType, data)) return 'A resource’s bytes are what its content type says.';
  return { sha1: header.sha1, contentType, data };
}

/**
 * A snapshot's moment as a trace names it: its `phase` (`before`, `action`, `after`), or the start of its
 * `snapshotName` where an older Playwright writes one (`before@call@8`, `input@call@8` at the action, `after@call@8`);
 * null for any other.
 */
export function snapshotPhase(snapshot: Record<string, unknown>): SnapshotPhase | null {
  if (typeof snapshot.phase === 'string')
    return PHASES.includes(snapshot.phase) ? (snapshot.phase as SnapshotPhase) : null;
  const name = typeof snapshot.snapshotName === 'string' ? snapshot.snapshotName : '';
  const start = name.slice(0, Math.max(0, name.indexOf('@')));
  if (start === 'input') return 'action';
  return PHASES.includes(start) ? (start as SnapshotPhase) : null;
}

/** A node of a snapshot that names a node of an earlier one: `[[back, node]]`. */
function isReference(node: unknown): node is [[number, number]] {
  return Array.isArray(node) && Array.isArray(node[0]);
}

/** A node of a snapshot that is an element: `[name, attributes, ...children]`. */
function isElement(node: unknown): node is [string, Record<string, unknown> | undefined, ...unknown[]] {
  return Array.isArray(node) && typeof node[0] === 'string';
}

/** An element's attributes: its second item, when it is an object; null for any other second item. */
function attributesOf(node: [string, ...unknown[]]): Record<string, unknown> | null {
  return node.length < 2 ? {} : isObject(node[1]) ? node[1] : null;
}

/** The deepest a snapshot's tree is walked: a snapshot with a deeper node cannot be read whole. */
const MAX_DEPTH = 512;
/** The most nodes a walk of a snapshot visits, its references followed: past them, it cannot be read whole. */
export const MAX_SNAPSHOT_NODES = 500_000;

/**
 * Whether a snapshot's `html` refers to no node of an earlier snapshot: its frame's chain starts with it. One with a
 * node deeper than the walk goes, or past `MAX_SNAPSHOT_NODES`, is not read as full.
 */
export function isFullSnapshot(html: unknown): boolean {
  let nodes = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (++nodes > MAX_SNAPSHOT_NODES || depth > MAX_DEPTH || isReference(node)) return false;
    if (!isElement(node)) return true;
    for (let i = 2; i < node.length; i++) if (!visit(node[i], depth + 1)) return false;
    return true;
  };
  return Array.isArray(html) && visit(html, 0);
}

/**
 * The node a reference of a snapshot names (`[[back, node]]`), with the resolver of the snapshot it belongs to, for the
 * references inside it; null when its snapshot is not known.
 */
export type SnapshotResolver = (back: number, index: number) => { node: unknown; resolve: SnapshotResolver } | null;

/**
 * A snapshot's nodes as Playwright numbers them for a later snapshot's references: its texts and elements, each element
 * after its children, its own references left out; null for one with a node deeper than the walk goes, or past
 * `MAX_SNAPSHOT_NODES`, which cannot be numbered.
 */
export function snapshotNodes(html: unknown): unknown[] | null {
  const nodes: unknown[] = [];
  let whole = true;
  const visit = (node: unknown, depth: number): void => {
    if (!whole) return;
    if (nodes.length >= MAX_SNAPSHOT_NODES || depth > MAX_DEPTH) {
      whole = false;
    } else if (typeof node === 'string') {
      nodes.push(node);
    } else if (isElement(node)) {
      for (let i = 2; i < node.length; i++) visit(node[i], depth + 1);
      nodes.push(node);
    }
  };
  visit(html, 0);
  return whole && nodes.length <= MAX_SNAPSHOT_NODES ? nodes : null;
}

/** The longest text of a label read. */
const MAX_LABEL_TEXT = 200;
/** The most nodes of one label read for its text. */
const MAX_LABEL_NODES = 1000;

/** The attributes that hold a field's value: its own, and the live value Playwright records beside it. */
const VALUE_ATTRIBUTES = ['value', '__playwright_value_'];
/** The attributes that name a field. */
const NAMING_ATTRIBUTES = ['name', 'id', 'aria-label', 'placeholder'];
/** The attributes whose value is an address, read as one (`hideSecretsInUrl`). */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'data',
  'xlink:href',
  'background',
  'cite',
  '__playwright_current_src__',
]);
/** The attributes whose value is a list of addresses, each with its size (`srcset`). */
const SRCSET_ATTRIBUTES: ReadonlySet<string> = new Set(['srcset', 'imagesrcset']);
/** The attributes that name what a `meta` holds. */
const META_NAMES = ['name', 'http-equiv', 'property', 'itemprop'];
/** An element that runs a script: an SVG's or an XHTML document's, which Playwright's snapshot keeps. */
const SCRIPT_ELEMENT = /(?:^|:)script$/i;
/** An address that runs a script when followed. */
const SCRIPT_URL = /^(?:javascript|vbscript):/i;
/** An address in a `meta`'s content: absolute, or from the site's root. */
const META_URL = /^\s*(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i;
/** An image's or a font's `data:` address in base64, kept as it is: its bytes are no text to hide. */
const KEPT_DATA =
  /data:(?:image\/[a-z0-9.+-]+|font\/[a-z0-9.+-]+|application\/(?:font-|x-font-)[a-z0-9.+-]+|application\/vnd\.ms-fontobject)(?:;[a-z0-9.+=-]+)*;base64,[A-Za-z0-9+/=]+/gi;

/** What `hideSnapshotSecrets` hides beside the fields that hold a secret. */
export interface SnapshotSecretOptions {
  /**
   * The values the attempt's secret fields held and its calls typed into one: a text or an attribute's value equal to
   * one is hidden, and one of 8 characters or more wherever it shows.
   */
  secrets: readonly string[];
  /**
   * The nodes the snapshot's references name, for the labels they hold: none followed without it. With it, a reference
   * it does not know leaves the snapshot unread.
   */
  resolve?: SnapshotResolver;
}

/** `text` with `hide` applied to all of it but the images' and fonts' `data:` addresses in it (`KEPT_DATA`). */
function besideKeptData(text: string, hide: (text: string) => string): string {
  if (!/data:/i.test(text) || text.includes('\u0000')) return hide(text);
  const kept: string[] = [];
  const marked = text.replace(KEPT_DATA, (uri) => `\u0000${kept.push(uri) - 1}\u0000`);
  // eslint-disable-next-line no-control-regex -- matches the NUL bytes that mark each address kept
  return hide(marked).replace(/\u0000(\d+)\u0000/g, (_all, i: string) => kept[Number(i)] ?? '');
}

/** A stylesheet's `url(…)`: its address, quoted or not, and what is around it. */
const CSS_URL = /(url\(\s*)(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))(\s*\))/gi;

/** A text with the address of each `url(…)` in it hidden as one (`hideSecretsInUrl`), its quotes and parentheses kept. */
function hideCssUrls(text: string): string {
  if (!/url\(/i.test(text)) return text;
  return text.replace(
    CSS_URL,
    (_all, open: string, double?: string, single?: string, bare?: string, close?: string) => {
      const url = double ?? single ?? bare ?? '';
      const shown = url.includes('\u0000') ? url : hideSecretsInUrl(url);
      const quote = double !== undefined ? '"' : single !== undefined ? "'" : '';
      return `${open}${quote}${shown}${quote}${close ?? ''}`;
    },
  );
}

/** An image's or a font's `data:` address in base64, alone. */
const KEPT_DATA_URL = new RegExp(`^${KEPT_DATA.source}$`, 'i');

/** An address with its credentials hidden (`hideSecretsInUrl`), an image's or a font's `data:` address kept. */
function hideUrl(url: string): string {
  return KEPT_DATA_URL.test(url.trim()) ? url : hideSecretsInUrl(url);
}

/** A `srcset` with each candidate's address hidden as `hideUrl` hides one, its size kept. */
function hideSrcset(value: string): string {
  return besideKeptData(value, (text) =>
    text
      .split(',')
      .map((candidate) => {
        const [, lead = '', url = '', rest = ''] = /^(\s*)(\S*)([\s\S]*)$/.exec(candidate) ?? [];
        return `${lead}${url.includes('\u0000') ? url : hideSecretsInUrl(url)}${rest}`;
      })
      .join(','),
  );
}

/** How a snapshot's strings are hidden: as a text or an attribute's value, and as an address. */
interface StringHider {
  text: (value: string) => string;
  url: (value: string) => string;
  srcset: (value: string) => string;
}

/**
 * The hider of a snapshot's strings with the attempt's `secrets`: a string equal to one of them, or that reads as a
 * card's number, is `HIDDEN_VALUE`; a secret of 8 characters or more is written so wherever it shows; then the
 * credentials of what is left are hidden, as an address (`hideSecretsInUrl`) or as a text (`hideSecretsInText`, each
 * `url(…)` in it read as an address), the images' and fonts' `data:` addresses kept.
 */
function stringHider(secrets: readonly string[]): StringHider {
  const values = [...new Set(secrets.filter((value) => value.trim()))];
  const exact = new Set(values.map((value) => value.trim()));
  const long = values.filter((value) => value.length >= 8);
  const own = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (exact.has(trimmed) || looksLikeCardNumber(trimmed)) return HIDDEN_VALUE;
    let out = value;
    for (const secret of long) if (out.includes(secret)) out = out.split(secret).join(HIDDEN_VALUE);
    return out;
  };
  const by =
    (hide: (value: string) => string) =>
    (value: string): string => {
      const out = own(value);
      return out === null ? value : out === HIDDEN_VALUE ? out : hide(out);
    };
  return {
    text: by((value) => besideKeptData(value, (text) => hideSecretsInText(hideCssUrls(text)))),
    url: by(hideUrl),
    srcset: by(hideSrcset),
  };
}

/** Whether a label's text, as `labelText` read it, names a secret: one it could not read whole does. */
function namesSecret(text: string | null): boolean {
  return text === null || isSecretFieldName(text);
}

/**
 * A label's text, its references followed with `resolve`, `MAX_LABEL_TEXT` characters at most; null when it could not
 * be read whole: a reference `resolve` does not know, a node deeper than the walk goes, or more than `MAX_LABEL_NODES`
 * before its text was long enough.
 */
function labelText(node: unknown, resolve: SnapshotResolver | undefined): string | null {
  let text = '';
  let nodes = 0;
  let whole = true;
  const visit = (one: unknown, at: SnapshotResolver | undefined, depth: number): void => {
    if (!whole || text.length >= MAX_LABEL_TEXT) return;
    if (++nodes > MAX_LABEL_NODES || depth > MAX_DEPTH) {
      whole = false;
    } else if (typeof one === 'string') {
      text += `${one} `;
    } else if (isReference(one)) {
      if (!at) return;
      const found = at(one[0][0], one[0][1]);
      if (found) visit(found.node, found.resolve, depth + 1);
      else whole = false;
    } else if (isElement(one)) {
      for (let i = 2; i < one.length; i++) visit(one[i], at, depth + 1);
    }
  };
  visit(node, resolve, 0);
  return whole || text.length >= MAX_LABEL_TEXT ? text.slice(0, MAX_LABEL_TEXT).trim() : null;
}

/** The ids the fields of a snapshot name their labels by (`aria-labelledby`); null for one that cannot be read whole. */
function labelledByIds(html: unknown): Set<string> | null {
  const ids = new Set<string>();
  let nodes = 0;
  let whole = true;
  const visit = (node: unknown, depth: number): void => {
    if (!whole) return;
    if (++nodes > MAX_SNAPSHOT_NODES || depth > MAX_DEPTH) {
      whole = false;
      return;
    }
    if (!isElement(node)) return;
    const attrs = attributesOf(node) ?? {};
    const by = attrs['aria-labelledby'];
    const upper = node[0].toUpperCase();
    if ((upper === 'INPUT' || upper === 'TEXTAREA') && typeof by === 'string') {
      for (const id of by.split(/\s+/)) if (id) ids.add(id);
    }
    for (let i = 2; i < node.length; i++) visit(node[i], depth + 1);
  };
  visit(html, 0);
  return whole ? ids : null;
}

/** The labels of a snapshot that name a secret: by the field they are for (`for`), and by their own id (`byId`). */
interface SecretLabels {
  for: Set<string>;
  byId: Set<string>;
}

/**
 * The labels of a snapshot whose text names a secret, its references followed with `resolve`: the ids of the fields
 * a `label` is for, and the ids among `wanted` of the elements whose text names one (`aria-labelledby`). A label whose
 * text could not be read whole names one. Null for a snapshot that cannot be read whole: a node deeper than the walk
 * goes, more than `MAX_SNAPSHOT_NODES`, or a reference `resolve` does not know.
 */
function secretLabels(html: unknown, resolve: SnapshotResolver | undefined, wanted: Set<string>): SecretLabels | null {
  const labels: SecretLabels = { for: new Set(), byId: new Set() };
  let nodes = 0;
  let whole = true;
  const visit = (node: unknown, at: SnapshotResolver | undefined, depth: number): void => {
    if (!whole) return;
    if (++nodes > MAX_SNAPSHOT_NODES || depth > MAX_DEPTH) {
      whole = false;
      return;
    }
    if (isReference(node)) {
      if (!at) return;
      const found = at(node[0][0], node[0][1]);
      if (found) visit(found.node, found.resolve, depth + 1);
      else whole = false;
      return;
    }
    if (!isElement(node)) return;
    const attrs = attributesOf(node) ?? {};
    const target = attrs.for;
    if (node[0].toUpperCase() === 'LABEL' && typeof target === 'string' && target) {
      if (namesSecret(labelText(node, at))) labels.for.add(target);
    }
    if (typeof attrs.id === 'string' && wanted.has(attrs.id) && namesSecret(labelText(node, at))) {
      labels.byId.add(attrs.id);
    }
    for (let i = 2; i < node.length; i++) visit(node[i], at, depth + 1);
  };
  visit(html, resolve, 0);
  return whole ? labels : null;
}

/** Whether a field's own attributes say it holds a secret: a password, a secret `autocomplete`, or a secret's name. */
function holdsSecret(attributes: Record<string, unknown>): boolean {
  const type = attributes.type;
  if (typeof type === 'string' && type.trim().toLowerCase() === 'password') return true;
  if (typeof attributes.autocomplete === 'string' && isSecretAutocomplete(attributes.autocomplete)) return true;
  return NAMING_ATTRIBUTES.some((name) => {
    const value = attributes[name];
    return typeof value === 'string' && isSecretFieldName(value);
  });
}

/** Whether a field's labels, by its id or by its `aria-labelledby`, name a secret. */
function labelledSecret(attributes: Record<string, unknown>, labels: SecretLabels): boolean {
  if (typeof attributes.id === 'string' && labels.for.has(attributes.id)) return true;
  const by = attributes['aria-labelledby'];
  return typeof by === 'string' && by.split(/\s+/).some((id) => labels.byId.has(id));
}

/**
 * A snapshot's `html` with what the page's secrets show removed, its shape kept (each node where it was, so a later
 * snapshot's references still name the same ones); null when it cannot be read whole, which then does not go: a node
 * deeper than the walk goes, more than `MAX_SNAPSHOT_NODES` nodes (its references followed), a reference `resolve`
 * does not know, or an element whose second item is not its attributes. Removed:
 *
 * - the value (`value`, and Playwright's live value `__playwright_value_`) of each field that holds a secret, a
 *   textarea's text too: a password field, one whose `autocomplete` asks for a secret (`SECRET_AUTOCOMPLETE`), one
 *   whose name, id, ARIA label or placeholder names one, or whose label does, around it, naming it (`for`) or named by
 *   it (`aria-labelledby`), as `isSecretFieldName` reads a field's name, a label it cannot read whole naming one;
 * - any text or attribute's value equal to one of `secrets` or that reads as a card's number, written as
 *   `HIDDEN_VALUE`, a secret of 8 characters or more written so wherever it shows;
 * - the credentials of every text and attribute's value (`hideSecretsInText`), an address's read as one
 *   (`hideSecretsInUrl`: `href`, `src`, each of a `srcset`'s, `action`, `formaction`, `poster`, `data`, `xlink:href`,
 *   and a `meta`'s content that is one), the images' and fonts' `data:` addresses kept;
 * - the content of a `meta` its name or `http-equiv` names a secret by (`isSecretName`: a CSRF token, a key);
 * - each attribute whose address runs a script (`javascript:`, `vbscript:`);
 * - each `script` element Playwright keeps (an SVG's, an XHTML document's): an inert `template` in its place, its
 *   attributes and texts emptied, its nodes kept.
 *
 * Pure: the snapshot given is left as it was.
 */
export function hideSnapshotSecrets(html: unknown, options: SnapshotSecretOptions): unknown {
  return hideHtml(html, options, stringHider(options.secrets));
}

function hideHtml(html: unknown, options: SnapshotSecretOptions, hide: StringHider): unknown {
  const wanted = labelledByIds(html);
  const labels = wanted && secretLabels(html, options.resolve, wanted);
  if (!labels) return null;
  let nodes = 0;
  let whole = true;
  /** A script element's nodes, kept for the references that name them, with nothing in them. */
  const inert = (node: unknown, depth: number): unknown => {
    if (!whole || ++nodes > MAX_SNAPSHOT_NODES || depth > MAX_DEPTH) {
      whole = false;
      return node;
    }
    if (typeof node === 'string') return '';
    if (!isElement(node)) return node;
    return ['template', {}, ...node.slice(2).map((child) => inert(child, depth + 1))];
  };
  const visit = (node: unknown, inSecretLabel: boolean, depth: number): unknown => {
    if (!whole || ++nodes > MAX_SNAPSHOT_NODES || depth > MAX_DEPTH) {
      whole = false;
      return node;
    }
    if (typeof node === 'string') return hide.text(node);
    if (!isElement(node)) return node;
    const own = attributesOf(node);
    if (!own) {
      whole = false;
      return node;
    }
    const [name, , ...children] = node;
    if (SCRIPT_ELEMENT.test(name)) {
      nodes--;
      return inert(node, depth);
    }
    const upper = name.toUpperCase();
    const label = upper === 'LABEL' && namesSecret(labelText(node, options.resolve));
    const field = upper === 'INPUT' || upper === 'TEXTAREA';
    const secret = field && (inSecretLabel || holdsSecret(own) || labelledSecret(own, labels));
    const secretMeta =
      upper === 'META' && META_NAMES.some((key) => typeof own[key] === 'string' && isSecretName(own[key] as string));
    const attrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(own)) {
      if (secret && VALUE_ATTRIBUTES.includes(key)) continue;
      if (typeof value !== 'string') {
        attrs[key] = value;
        continue;
      }
      // A value whose address runs a script, as a browser reads it: spaces and control characters left out.
      // eslint-disable-next-line no-control-regex -- matches the control characters a browser leaves out of an address
      if (SCRIPT_URL.test(value.replace(/[\u0000- ]/g, ''))) continue;
      const lower = key.toLowerCase();
      if (upper === 'META' && lower === 'content') {
        attrs[key] =
          secretMeta && value.trim() ? HIDDEN_VALUE : META_URL.test(value) ? hide.url(value) : hide.text(value);
      } else if (URL_ATTRIBUTES.has(lower)) {
        attrs[key] = hide.url(value);
      } else if (SRCSET_ATTRIBUTES.has(lower)) {
        attrs[key] = hide.srcset(value);
      } else {
        attrs[key] = hide.text(value);
      }
    }
    const kids = children.map((child) =>
      secret && upper === 'TEXTAREA' && typeof child === 'string' && child.trim()
        ? HIDDEN_VALUE
        : visit(child, inSecretLabel || label, depth + 1),
    );
    return node.length < 2 && !Object.keys(attrs).length ? [name] : [name, attrs, ...kids];
  };
  const out = visit(html, false, 0);
  return whole ? out : null;
}

/**
 * A `frame-snapshot` event's `snapshot`, as `hideSnapshotSecrets` hides its `html` with `options`, its frame's address
 * (`frameUrl`) and those of its stylesheets changed in the page (`resourceOverrides`) hidden as an address in it is;
 * null when its `html` cannot be read whole. Pure.
 */
export function hideFrameSnapshotSecrets(
  snapshot: Record<string, unknown>,
  options: SnapshotSecretOptions,
): Record<string, unknown> | null {
  const hide = stringHider(options.secrets);
  const html = hideHtml(snapshot.html, options, hide);
  if (html === null) return null;
  const shown: Record<string, unknown> = { ...snapshot, html };
  if (typeof snapshot.frameUrl === 'string') shown.frameUrl = hide.url(snapshot.frameUrl);
  if (Array.isArray(snapshot.resourceOverrides)) {
    shown.resourceOverrides = snapshot.resourceOverrides.map((one: unknown) =>
      isObject(one) && typeof one.url === 'string' ? { ...one, url: hide.url(one.url) } : one,
    );
  }
  return shown;
}

/**
 * A resource's address as a snapshot's header names it: what `hideFrameSnapshotSecrets` hides of an address hidden
 * (with the same `secrets`), written as a browser resolves it, so the instance finds it by the address the snapshot it
 * hid names; null for one that is not http(s), or longer than `MAX_RESOURCE_URL`.
 */
export function hideResourceUrl(url: string, secrets: readonly string[] = []): string | null {
  return resolveResourceUrl(stringHider(secrets).url(url), null);
}

/** The longest stylesheet read for the resources it names, in characters. */
const MAX_CSS_SCANNED = MAX_RESOURCE_BYTES;

/**
 * The addresses a stylesheet names, as written: each `url(…)` (a font, an image) and each `@import`, its comments
 * left out; `data:` addresses left out too.
 */
export function cssReferences(css: string): string[] {
  const text = css.slice(0, MAX_CSS_SCANNED).replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Set<string>();
  for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi)) {
    found.add((match[1] ?? match[2] ?? match[3] ?? '').trim());
  }
  for (const match of text.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/gi))
    found.add((match[1] ?? match[2] ?? '').trim());
  return [...found].filter((ref) => ref && !/^data:/i.test(ref));
}

/** An address a page names, `ref`, read against `base`: an http(s) address alone; null for any other, or none. */
export function resolveResourceUrl(ref: string, base: string | null): string | null {
  let url: URL;
  try {
    url = base ? new URL(ref, base) : new URL(ref);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  const href = url.href;
  return href.length <= MAX_RESOURCE_URL ? href : null;
}

/** The addresses a `srcset` names: each candidate's address, its size left out. */
function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
}

/**
 * The resources a snapshot names itself (its references to earlier snapshots aside), as absolute http(s) addresses,
 * read against its `<base>`, else its frame's address: its stylesheets and icons (`link`), its images (`img`,
 * `source`, an image `input`, a video's `poster`, the address Playwright records an image showing), and the addresses
 * its styles name (a `style` element's or attribute's, and a style sheet Playwright records, `url(…)` and `@import`).
 * Pure.
 */
export function snapshotResourceUrls(snapshot: Record<string, unknown>): string[] {
  const refs: string[] = [];
  let base = typeof snapshot.frameUrl === 'string' ? snapshot.frameUrl : null;
  const visit = (node: unknown, inStyle: boolean, depth: number): void => {
    if (typeof node === 'string') {
      if (inStyle) refs.push(...cssReferences(node));
      return;
    }
    if (!isElement(node) || depth > MAX_DEPTH) return;
    const upper = node[0].toUpperCase();
    const attrs = node[1] && typeof node[1] === 'object' ? node[1] : {};
    const text = (key: string): string | null => (typeof attrs[key] === 'string' ? (attrs[key] as string) : null);
    if (upper === 'BASE' && text('href')) base = resolveResourceUrl(text('href')!, base) ?? base;
    if (upper === 'LINK' && text('href') && /\b(?:stylesheet|icon)\b/i.test(text('rel') ?? ''))
      refs.push(text('href')!);
    if (upper === 'IMG' || upper === 'SOURCE' || (upper === 'INPUT' && text('type')?.toLowerCase() === 'image')) {
      for (const key of ['src', '__playwright_current_src__']) if (text(key)) refs.push(text(key)!);
      if (text('srcset')) refs.push(...srcsetUrls(text('srcset')!));
    }
    if (upper === 'VIDEO' && text('poster')) refs.push(text('poster')!);
    for (const key of ['style', '__playwright_style_sheet_']) if (text(key)) refs.push(...cssReferences(text(key)!));
    for (let i = 2; i < node.length; i++) visit(node[i], upper === 'STYLE', depth + 1);
  };
  visit(snapshot.html, false, 0);
  const urls = new Set<string>();
  for (const ref of refs) {
    const url = resolveResourceUrl(ref, base);
    if (url) urls.add(url);
  }
  return [...urls];
}
