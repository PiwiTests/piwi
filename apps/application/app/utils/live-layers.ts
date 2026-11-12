import { MAX_FILMSTRIP, type LaneThumb, type PageEvent } from '@piwitests/core/live-layers';
import { LOCATING_METHODS, locatorCallValues, scanLocatorChain } from '@piwitests/core/locator-chain';
import { foldText, foldTextWithOffsets, type FoldedText } from '#shared/utils/fold-text';

/**
 * What the lane panel shows of the layers a worker sends beside its images (`@piwitests/core/live-layers`), held in the
 * page's memory for the test the view shows and let go with it:
 *
 * - the page's events, newest first, `MAX_SHOWN_EVENTS` at most (`addLaneEvent`): a request told pending is one line
 *   whose time grows, and what a backend logged while it answered a request goes under that request when the list holds
 *   it; how many the worker left out (`dropped`) and how many older ones the list let go (`letGo`) are counted;
 * - the test's filmstrip, one image per call, by the call's place in the strip (`addLaneThumb`): an image of a call the
 *   strip holds is let go, as the worker sends the strip again to each watch that comes later;
 * - the page's text, line by line, searched as every search of the app is, case and accents ignored (`laneTextLines`,
 *   `laneTextMatches`), and the lines naming the element the shown call's locator targets (`laneTextTarget`,
 *   `laneTextTargets`).
 */

/** The most page events the panel lists: older ones are let go, and counted. */
export const MAX_SHOWN_EVENTS = 100;
/** How many of the latest events are looked through for the request a backend's log line belongs to. */
const BACKEND_REACH = 20;
/** The most lines of a backend's log kept under one request. */
const MAX_BACKEND_LINES = 5;

type RequestEvent = Extract<PageEvent, { kind: 'request-failed' | 'request-pending' | 'api' }>;
type BackendEvent = Extract<PageEvent, { kind: 'backend' }>;

/** A line a backend logged while it answered a request. */
export interface BackendLine {
  level: BackendEvent['level'];
  text: string;
}

/** One line of the list: an event, when it happened (`at`, the worker's clock), and its request's backend lines. */
export interface ShownEvent {
  /** A key of its own, for the list. */
  key: number;
  event: Exclude<PageEvent, { kind: 'dropped' }>;
  at: number;
  backend: BackendLine[];
}

export interface LaneEvents {
  /** Newest first. */
  shown: ShownEvent[];
  /** How many events the worker said it left out (`dropped`). */
  dropped: number;
  /** How many older events the list let go, past `MAX_SHOWN_EVENTS`. */
  letGo: number;
  next: number;
}

export function emptyLaneEvents(): LaneEvents {
  return { shown: [], dropped: 0, letGo: 0, next: 1 };
}

/** `list` with its item at `index` replaced by `item`. */
function replaced<T>(list: readonly T[], index: number, item: T): T[] {
  return list.map((each, i) => (i === index ? item : each));
}

function isRequest(event: PageEvent): event is RequestEvent {
  return event.kind === 'request-failed' || event.kind === 'request-pending' || event.kind === 'api';
}

/** Whether a backend's log line is of `request`: its method and address, and its status when both say one. */
function sameRequest(request: RequestEvent, backend: BackendEvent): boolean {
  if (request.method !== backend.method || request.url !== backend.url) return false;
  const status = request.kind === 'request-pending' ? null : request.status;
  return status === null || backend.status === null || status === backend.status;
}

/** The list with `event`, which happened at `at`, in its place; the list given is left as it was. */
export function addLaneEvent(
  events: LaneEvents,
  event: PageEvent,
  at: number,
  max: number = MAX_SHOWN_EVENTS,
): LaneEvents {
  if (event.kind === 'dropped') return { ...events, dropped: events.dropped + event.count };
  let shown = events.shown;
  if (event.kind === 'request-pending') {
    const index = shown.findIndex((line) => line.event.kind === 'request-pending' && line.event.id === event.id);
    if (index >= 0) return { ...events, shown: replaced(shown, index, { ...shown[index]!, event, at }) };
  }
  if (event.kind === 'backend') {
    const index = shown
      .slice(0, BACKEND_REACH)
      .findIndex((line) => isRequest(line.event) && sameRequest(line.event, event));
    if (index >= 0) {
      const line = shown[index]!;
      if (line.backend.length >= MAX_BACKEND_LINES) return events;
      const backend = [...line.backend, { level: event.level, text: event.text }];
      return { ...events, shown: replaced(shown, index, { ...line, backend }) };
    }
  }
  let backend: BackendLine[] = [];
  if (isRequest(event)) {
    // A backend's lines told before their request go under it.
    const before = shown
      .slice(0, BACKEND_REACH)
      .filter((line) => line.event.kind === 'backend' && sameRequest(event, line.event));
    if (before.length) {
      backend = before
        .reverse()
        .slice(0, MAX_BACKEND_LINES)
        .map((line) => {
          const logged = line.event as BackendEvent;
          return { level: logged.level, text: logged.text };
        });
      shown = shown.filter((line) => !before.includes(line));
    }
  }
  const all = [{ key: events.next, event, at, backend }, ...shown];
  return {
    shown: all.slice(0, max),
    dropped: events.dropped,
    letGo: events.letGo + Math.max(0, all.length - max),
    next: events.next + 1,
  };
}

/** What a line of the page's events is, in a word or two. */
export function laneEventLabel(event: ShownEvent['event']): string {
  switch (event.kind) {
    case 'console':
      return 'Console error';
    case 'page-error':
      return 'Uncaught error';
    case 'request-failed':
      return 'Failed request';
    case 'request-pending':
      return event.done ? 'Slow request' : 'Pending request';
    case 'backend':
      return event.level === 'error' ? 'Backend error' : 'Backend warning';
    case 'api':
      return 'API call';
  }
}

/**
 * A line of the page's events in words: its message, or its request (`code`); how the request went (`note`), followed
 * by its time when it has one (`ms`); and what a backend logged of it (`logged`).
 */
export function laneEventParts(event: ShownEvent['event']): {
  code: string;
  note: string | null;
  ms: number | null;
  logged: string | null;
} {
  if (event.kind === 'console' || event.kind === 'page-error') {
    return { code: event.text, note: null, ms: null, logged: null };
  }
  const code = `${event.method} ${event.url}`;
  const failed = (failure: string | null) => `Failed: ${failure ?? 'no answer'}`;
  switch (event.kind) {
    case 'request-failed':
      return { code, note: event.status ? `Answered ${event.status}` : failed(event.failure), ms: null, logged: null };
    case 'request-pending':
      return { code, note: event.done ? 'Answered after' : 'Pending for', ms: event.ms, logged: null };
    case 'api':
      return {
        code,
        note: event.status ? `Answered ${event.status} in` : `${failed(event.failure)}, after`,
        ms: event.ms,
        logged: null,
      };
    case 'backend':
      return { code, note: event.status ? `Answered ${event.status}` : null, ms: null, logged: event.text };
  }
}

/**
 * The filmstrip with `next` in its place, ordered by the place each image holds in the strip (`index`), the latest
 * `max`; and the images let go: `next` itself when the strip holds an image of its call already, or the oldest past
 * `max`.
 */
export function addLaneThumb<T extends { thumb: LaneThumb }>(
  strip: readonly T[],
  next: T,
  max: number = MAX_FILMSTRIP,
): { strip: T[]; letGo: T[] } {
  if (strip.some((shot) => shot.thumb.call === next.thumb.call)) return { strip: [...strip], letGo: [next] };
  const all = [...strip, next].sort((a, b) => a.thumb.index - b.thumb.index || a.thumb.at - b.thumb.at);
  const cut = Math.max(0, all.length - max);
  return { strip: all.slice(cut), letGo: all.slice(0, cut) };
}

/** What the element a call's locator targets is named in the page's text. */
export type LaneTextTarget =
  | { kind: 'role'; role: string; name: string; exact: boolean }
  | { kind: 'name'; name: string; exact: boolean }
  | { kind: 'text'; text: string; exact: boolean };

/** Where a call's title names a locator. */
const LOCATOR_START = /\b(?:getBy[A-Z][A-Za-z]*|locator)\(/;

/**
 * The element the call titled `title` targets, as the page's text names it: by role and name (`getByRole` with a
 * name), by name (`getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`) or by text (`getByText`), read with
 * core's one locator parser; null for a call whose locator the text does not name (a CSS locator, a test id, a pattern).
 */
export function laneTextTarget(title: string | null | undefined): LaneTextTarget | null {
  const start = title ? LOCATOR_START.exec(title) : null;
  if (!title || !start) return null;
  const scanned = scanLocatorChain(title.slice(start.index));
  const leaf = scanned?.chain.calls.findLast((call) => LOCATING_METHODS.has(call.method));
  if (!leaf || leaf.args[0]?.type !== 'string') return null;
  const [first, options] = locatorCallValues(leaf) as [string, Record<string, unknown> | undefined];
  const exact = options?.exact === true;
  switch (leaf.method) {
    case 'getByRole': {
      const name = leaf.args[1]?.type === 'object' ? leaf.args[1].entries.find(([key]) => key === 'name')?.[1] : null;
      return name?.type === 'string' && name.value ? { kind: 'role', role: first, name: name.value, exact } : null;
    }
    case 'getByLabel':
    case 'getByPlaceholder':
    case 'getByAltText':
    case 'getByTitle':
      return first ? { kind: 'name', name: first, exact } : null;
    case 'getByText':
      return first ? { kind: 'text', text: first, exact } : null;
    default:
      return null;
  }
}

/** A line of the page's text: its words, and the same folded for search. */
export interface LaneTextLine {
  text: string;
  folded: FoldedText;
}

/** A line of an ARIA snapshot: `- role "name" [flags]: text`. */
const ARIA_LINE = /^\s*- ([\w/-]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::(?: (.*))?)?$/;

/** A quoted value as Playwright writes it, read back; the text as it is when it is not one. */
function unquoted(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}

/** Whether `value` is what a locator asks for: the whole of it with `exact`, else a part of it, case ignored. */
function matches(value: string | null, wanted: string, exact: boolean): boolean {
  if (value === null) return false;
  return exact ? value === wanted : foldText(value).includes(foldText(wanted));
}

/** Whether an ARIA snapshot's line names `target`. */
function namesTarget(line: string, target: LaneTextTarget): boolean {
  const parts = ARIA_LINE.exec(line);
  if (!parts) return false;
  const role = parts[1]!;
  const name = parts[2] === undefined ? null : unquoted(`"${parts[2]}"`);
  const text = parts[4] === undefined ? null : unquoted(parts[4]);
  if (target.kind === 'role') return role === target.role && matches(name, target.name, target.exact);
  if (target.kind === 'name') return matches(name, target.name, target.exact);
  return matches(text, target.text, target.exact) || matches(name, target.text, target.exact);
}

/** The page's text line by line, each folded for search. */
export function laneTextLines(text: string): LaneTextLine[] {
  return text.split('\n').map((line) => ({ text: line, folded: foldTextWithOffsets(line) }));
}

/** The lines of the page's text that name `target`, by their place from 0. */
export function laneTextTargets(lines: readonly LaneTextLine[], target: LaneTextTarget | null): number[] {
  if (!target) return [];
  return lines.flatMap((line, i) => (namesTarget(line.text, target) ? [i] : []));
}

/**
 * Where each line holds what `query` searches for, case and accents ignored, as ranges of the line's own characters,
 * and how many there are; null for an empty query.
 */
export function laneTextMatches(
  lines: readonly LaneTextLine[],
  query: string,
): { ranges: Array<Array<[number, number]>>; count: number } | null {
  const wanted = foldText(query.trim());
  if (!wanted) return null;
  let count = 0;
  const ranges = lines.map(({ folded }) => {
    const found: Array<[number, number]> = [];
    for (let at = folded.text.indexOf(wanted); at >= 0; at = folded.text.indexOf(wanted, at + wanted.length)) {
      found.push([folded.starts[at]!, folded.ends[at + wanted.length - 1]!]);
    }
    count += found.length;
    return found;
  });
  return { ranges, count };
}

/** `text` cut into its parts, those inside `ranges` (in order) marked. */
export function markedParts(
  text: string,
  ranges: ReadonlyArray<[number, number]> | undefined,
): Array<{ text: string; marked: boolean }> {
  if (!ranges?.length) return [{ text, marked: false }];
  const parts: Array<{ text: string; marked: boolean }> = [];
  let at = 0;
  for (const [start, end] of ranges) {
    const from = Math.max(start, at);
    if (end <= from) continue;
    if (from > at) parts.push({ text: text.slice(at, from), marked: false });
    parts.push({ text: text.slice(from, end), marked: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), marked: false });
  return parts;
}
