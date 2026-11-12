/**
 * **Inspect** on the run page's live view (`@piwitests/core/live-view`): the page of a running test at each of its
 * calls, as a document. While a viewer of a worker in full has Inspect open (`view`'s `inspect` on the worker's
 * stream), the worker sends the DOM snapshots Playwright's trace takes of the watched page (`snapshot`), and the
 * stylesheets, fonts and images they name (`resource`), each a live message whose data is the snapshot's JSON or the
 * resource's bytes. Nothing goes while no viewer has Inspect open, and nothing is stored: the instance keeps them in
 * memory for the run, and serves each viewer the page rendered, without a script.
 *
 * - **A snapshot** is the `snapshot` object of a `frame-snapshot` event of the trace, as Playwright wrote it, what the
 *   page's secrets show removed by the worker before it leaves (`hideSnapshotSecrets`): its data, the UTF-8 JSON,
 *   `MAX_SNAPSHOT_BYTES` at most. Its header names the call it is of (Playwright's id, and its title, the text it types
 *   and its credentials hidden), its moment (`before` the call, at its `action`, `after` it), its page and
 *   frame (Playwright's ids), whether it is of the page's main frame (`main`), whether it refers to no earlier snapshot
 *   (`full`), its place among its frame's snapshots in the trace (`index`), when it was taken, and the resources it
 *   names (`resources`: each one's address, as the page asked for it, and its `sha1`), those its stylesheets name
 *   included.
 * - **A frame's chain.** A snapshot that is not full refers to nodes of the snapshots of its frame before it, by how
 *   many snapshots back (`[[back, node]]` in its `html`: the snapshot whose `index` is its own less `back`, and the node
 *   `node` of that one's, numbered as `snapshotNodes` numbers them), back to its frame's last full snapshot at most.
 *   A full snapshot starts its frame's chain again, and its `index` may start again from 0 (a new trace of the page):
 *   the instance drops the frame's earlier snapshots then. A snapshot the worker could not send (one past
 *   `MAX_SNAPSHOT_BYTES`, one it could not read, one left out below) leaves a gap a reference may name: the instance
 *   renders no snapshot whose chain it does not hold whole. As Inspect opens, the worker first sends the watched page's
 *   snapshots since its last navigation (the main frame's last full snapshot onward, of every frame), in the trace's
 *   order, `MAX_SNAPSHOT_BACKLOG` bytes at most, the oldest left out past them, then each new one,
 *   `SNAPSHOTS_PER_SECOND` at most.
 * - **A resource** is a file of the trace's `resources/` folder, by its name there (`sha1`: the SHA-1 of its bytes and
 *   its extension), `MAX_RESOURCE_BYTES` at most, sent once per run, only when a snapshot sent names it and only for a
 *   content type `inspectResourceType` allows: a stylesheet, a font, or an image other than SVG. Never a script, a
 *   document, an SVG nor anything else. The instance finds a resource by its address in the `resources` of a snapshot
 *   (that of the snapshot it renders, else of one before it in its frame's chain).
 */
import { isLayerCallId, isLayerTime } from './live-layers';
import {
  HIDDEN_VALUE,
  hideSecretsInText,
  hideTypedText,
  isSecretAutocomplete,
  isSecretFieldName,
  looksLikeCardNumber,
} from './mask';

/** The longest snapshot a worker sends, in bytes of its JSON: a longer one is not sent. */
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

/** The deepest a snapshot's tree is walked. */
const MAX_DEPTH = 512;

/** Whether a snapshot's `html` refers to no node of an earlier snapshot: its frame's chain starts with it. */
export function isFullSnapshot(html: unknown): boolean {
  const visit = (node: unknown, depth: number): boolean => {
    if (isReference(node)) return false;
    if (!isElement(node) || depth > MAX_DEPTH) return true;
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
 * after its children, its own references left out.
 */
export function snapshotNodes(html: unknown): unknown[] {
  const nodes: unknown[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (typeof node === 'string') {
      nodes.push(node);
    } else if (isElement(node) && depth <= MAX_DEPTH) {
      for (let i = 2; i < node.length; i++) visit(node[i], depth + 1);
      nodes.push(node);
    }
  };
  visit(html, 0);
  return nodes;
}

/** The most nodes a snapshot's labels are looked for in, references followed. */
const MAX_LABEL_NODES = 100_000;
/** The longest text of a label read. */
const MAX_LABEL_TEXT = 200;

/** The attributes that hold a field's value: its own, and the live value Playwright records beside it. */
const VALUE_ATTRIBUTES = ['value', '__playwright_value_'];
/** The attributes that name a field. */
const NAMING_ATTRIBUTES = ['name', 'id', 'aria-label', 'placeholder'];

/** What `hideSnapshotSecrets` hides beside the fields that hold a secret. */
export interface SnapshotSecretOptions {
  /**
   * The values the attempt's secret fields held and its calls typed into one: a text or an attribute's value equal to
   * one is hidden, and one of 8 characters or more wherever it shows.
   */
  secrets: readonly string[];
  /** The nodes the snapshot's references name, for the labels they hold: none followed without it. */
  resolve?: SnapshotResolver;
}

/** A label's text, its references followed, `MAX_LABEL_TEXT` characters at most. */
function labelText(node: unknown, resolve: SnapshotResolver | undefined, budget: { n: number }): string {
  let text = '';
  const visit = (one: unknown, at: SnapshotResolver | undefined, depth: number): void => {
    if (text.length >= MAX_LABEL_TEXT || budget.n-- <= 0 || depth > MAX_DEPTH) return;
    if (typeof one === 'string') {
      text += `${one} `;
    } else if (isReference(one)) {
      const found = at?.(one[0][0], one[0][1]);
      if (found) visit(found.node, found.resolve, depth + 1);
    } else if (isElement(one)) {
      for (let i = 2; i < one.length; i++) visit(one[i], at, depth + 1);
    }
  };
  visit(node, resolve, 0);
  return text.slice(0, MAX_LABEL_TEXT).trim();
}

/** The ids the labels of a snapshot name (`for`) whose text names a secret, its references followed. */
function secretLabelTargets(html: unknown, resolve: SnapshotResolver | undefined): Set<string> {
  const ids = new Set<string>();
  const budget = { n: MAX_LABEL_NODES };
  const visit = (node: unknown, at: SnapshotResolver | undefined, depth: number): void => {
    if (budget.n-- <= 0 || depth > MAX_DEPTH) return;
    if (isReference(node)) {
      const found = at?.(node[0][0], node[0][1]);
      if (found) visit(found.node, found.resolve, depth + 1);
      return;
    }
    if (!isElement(node)) return;
    const target = node[1]?.for;
    if (node[0].toUpperCase() === 'LABEL' && typeof target === 'string' && target) {
      if (isSecretFieldName(labelText(node, at, { n: 1000 }))) ids.add(target);
    }
    for (let i = 2; i < node.length; i++) visit(node[i], at, depth + 1);
  };
  visit(html, resolve, 0);
  return ids;
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

/**
 * A snapshot's `html` with what the page's secrets show removed, its shape kept (each node where it was, so a later
 * snapshot's references still name the same ones): the value (`value`, and Playwright's live value
 * `__playwright_value_`) of each field that holds a secret, a textarea's text too: a password field, one whose
 * `autocomplete` asks for a secret (`SECRET_AUTOCOMPLETE`), one whose name, id, ARIA label or placeholder names one, or
 * whose label does, around it or naming it (`for`), as `isSecretFieldName` reads a field's name; any field's value that
 * reads as a card's number; and any text or attribute's value equal to one of `secrets` or that reads as a card's
 * number, written as `HIDDEN_VALUE`, and a secret of 8 characters or more written so wherever it shows. Pure: the
 * snapshot given is left as it was.
 */
export function hideSnapshotSecrets(html: unknown, options: SnapshotSecretOptions): unknown {
  const values = [...new Set(options.secrets.filter((value) => value.trim()))];
  const exact = new Set(values.map((value) => value.trim()));
  const long = values.filter((value) => value.length >= 8);
  const labelled = secretLabelTargets(html, options.resolve);
  const hidden = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (exact.has(trimmed) || looksLikeCardNumber(trimmed)) return HIDDEN_VALUE;
    let out = value;
    for (const secret of long) if (out.includes(secret)) out = out.split(secret).join(HIDDEN_VALUE);
    return out;
  };
  const visit = (node: unknown, inSecretLabel: boolean, depth: number): unknown => {
    if (typeof node === 'string') return hidden(node);
    if (!isElement(node) || depth > MAX_DEPTH) return node;
    const [name, attributes, ...children] = node;
    const upper = name.toUpperCase();
    const label = upper === 'LABEL' && isSecretFieldName(labelText(node, options.resolve, { n: 1000 }));
    const field = upper === 'INPUT' || upper === 'TEXTAREA';
    const attrs: Record<string, unknown> = {};
    const own = attributes && typeof attributes === 'object' ? attributes : {};
    const id = typeof own.id === 'string' ? own.id : null;
    const secret = field && (inSecretLabel || holdsSecret(own) || (id !== null && labelled.has(id)));
    for (const [key, value] of Object.entries(own)) {
      if (secret && VALUE_ATTRIBUTES.includes(key)) continue;
      attrs[key] = typeof value === 'string' ? hidden(value) : value;
    }
    const kids = children.map((child) =>
      secret && upper === 'TEXTAREA' && typeof child === 'string' && child.trim()
        ? HIDDEN_VALUE
        : visit(child, inSecretLabel || label, depth + 1),
    );
    return attributes === undefined && !Object.keys(attrs).length
      ? [name, ...(kids.length ? [{}, ...kids] : [])]
      : [name, attrs, ...kids];
  };
  return visit(html, false, 0);
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
