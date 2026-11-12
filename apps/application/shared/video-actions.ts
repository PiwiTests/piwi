/**
 * The marks under the Video tab's player: the actions a test took (a click, a fill, a key press, a navigation), where
 * each sits in the test's video and how the marks of one stretch of the bar merge. An action is read from the stored
 * trace when the execution has one, else from its stored steps, and is described here without the text it typed, the
 * options it chose or the query of the page it opened. Pure, so the server, the demo and the page share it.
 */
import { quoteJsString, tryParseLocatorChain } from '@piwitests/core/locator-chain';
import { extractStepLocatorUse } from '@piwitests/core/step-locators';
import {
  HIDDEN_VALUE,
  hideSecretsInText,
  hideSecretsInUrl,
  isSecretFieldName,
  isSecretLocator,
  isSecretValue,
  looksLikeCardNumber,
} from '@piwitests/core/mask';
import { MAX_STEP_PARAM_VALUE_CHARS } from '@piwitests/core/step-analysis';
import { videoTimingMap, type VideoTimingInput } from './video-reel';

/** The most marks an execution's answer holds. */
export const MAX_VIDEO_ACTIONS = 500;
/**
 * Marks closer than this on the lane merge into one. A mark's hit area is 26 px wide around its 10 px dot
 * (`RunVideoActionMarks`) and a merged badge's a little more, so neighbours this far apart never share a hit area.
 */
export const MARK_MERGE_PX = 28;

export type VideoActionKind =
  | 'goto'
  | 'click'
  | 'dblclick'
  | 'fill'
  | 'type'
  | 'press'
  | 'check'
  | 'uncheck'
  | 'selectOption'
  | 'hover';

/** One action of a test: when it started in its video and what it was, already masked. */
export interface VideoAction {
  kind: VideoActionKind;
  /** The action's start in the video, in ms. Not held to the video: before its first frame it is negative. */
  atMs: number;
  /** What the tooltip says: `Click getByRole('button', { name: 'Save' })`, `Fill getByLabel('Email'): typed 17 chars`. */
  label: string;
  failed: boolean;
}

export type VideoActionsSource = 'trace' | 'steps' | 'none';

/** `GET /api/test-run-cases/:id/video-actions`. */
export interface VideoActionsResponse {
  /** Where the actions were read: the stored trace, the stored steps, or neither. */
  source: VideoActionsSource;
  /** `create-page`: timed from the end of the `Create page` step; `start`: from the test's start. Null without actions. */
  timing: 'create-page' | 'start' | null;
  /** In the order they ran; at most `MAX_VIDEO_ACTIONS`. */
  actions: VideoAction[];
  /** How many actions the test took, the ones past the cap included. */
  total: number;
  /** True when the answer holds fewer actions than the test took. */
  capped: boolean;
}

/** An action before it is timed: when it started in epoch ms. */
export interface RawAction {
  kind: VideoActionKind;
  epochMs: number;
  label: string;
  failed: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// What an action says of itself, without what it carried
// ---------------------------------------------------------------------------------------------------------------------

const VERBS: Readonly<Record<VideoActionKind, string>> = {
  goto: 'Navigate to',
  click: 'Click',
  dblclick: 'Double click',
  fill: 'Fill',
  type: 'Type',
  press: 'Press',
  check: 'Check',
  uncheck: 'Uncheck',
  selectOption: 'Select option',
  hover: 'Hover',
};

const NAMED_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Insert',
  'Space',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'CapsLock',
  'ContextMenu',
  'Pause',
  'PrintScreen',
  'ScrollLock',
  'NumLock',
]);
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'ControlOrMeta', 'AltGraph']);
const SHORTCUT_MODIFIERS = new Set(['Control', 'Meta', 'ControlOrMeta']);
const FUNCTION_KEY = /^F(?:[1-9]|1[0-9]|2[0-4])$/;

/** How a key press reads: a named key or a shortcut as it is, any single character as `a key`. */
export function keyLabel(key: unknown): string {
  if (typeof key !== 'string' || key === '') return 'a key';
  const parts = key.length > 1 ? key.split('+') : [key];
  const last = parts[parts.length - 1]!;
  const modifiers = parts.slice(0, -1);
  if (!modifiers.every((m) => MODIFIER_KEYS.has(m))) return 'a key';
  const named = NAMED_KEYS.has(last) || MODIFIER_KEYS.has(last) || FUNCTION_KEY.test(last);
  // A character behind Control or Meta is a shortcut (`Control+A`); behind Shift or Alt it types text, so it stays hidden.
  const shortcut = modifiers.some((m) => SHORTCUT_MODIFIERS.has(m)) && Array.from(last).length === 1;
  return named || shortcut ? parts.join('+') : 'a key';
}

/** How much text a fill or a typing wrote: the count only; `typed text` when the length is not known. */
export function typedLabel(chars: number | null): string {
  if (chars == null) return 'typed text';
  return `typed ${chars} ${chars === 1 ? 'char' : 'chars'}`;
}

/** The schemes whose whole URL names no page content: `about:blank`, `about:srcdoc`. */
const CONTENTLESS_SCHEMES = new Set(['about:']);

/**
 * A URL as its origin and path: the query string, the fragment and any credentials dropped, and a path segment shaped
 * like a credential hidden (`hideSecretsInUrl`, the masking of the rest of the app). Null when it names none.
 */
export function originAndPath(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null;
  const text = url.trim();
  try {
    const parsed = new URL(text);
    if (parsed.origin === 'null') {
      // `file:` names a path and `about:blank` names no page; `data:`, `javascript:` and the like carry content, so only their scheme shows.
      if (CONTENTLESS_SCHEMES.has(parsed.protocol)) return `${parsed.protocol}${parsed.pathname}`.slice(0, 200);
      return (parsed.protocol === 'file:' ? `${parsed.protocol}${parsed.pathname}` : parsed.protocol).slice(0, 200);
    }
    return hideSecretsInUrl(`${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`).slice(0, 200);
  } catch {
    // A relative path (`/login?next=…`), a protocol-relative one (`//user:pw@host/p`), or text that is no URL: without a
    // query, a fragment or credentials.
    const bare = text.replace(/[?#].*$/s, '').replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)[^/]*@/i, '$1');
    return hideSecretsInUrl(bare).slice(0, 200) || null;
  }
}

export interface ActionParts {
  kind: VideoActionKind;
  /** The locator the action used, as Playwright prints it. */
  locator?: string | null;
  /** The selector the action used before it was rendered, when the source has one: read for a secret field as well. */
  selector?: string | null;
  /** How many characters a fill or a typing wrote; null when unknown. */
  typedChars?: number | null;
  /** The key a press used. */
  key?: unknown;
  /** The URL a navigation opened. */
  url?: unknown;
}

/** Whether a locator, as written or as Playwright's engines hold it, names a field that holds a secret or a card's number. */
function namesSecretField(locator: string): boolean {
  if (isSecretLocator(locator)) return true;
  for (const quoted of locator.matchAll(/(['"])((?:(?!\1)[^\\]|\\.)*)\1/g))
    if (isSecretFieldName(quoted[2]!)) return true;
  return false;
}

/**
 * The tooltip of an action: its verb, the locator, and for the kinds that carry a value, only what is safe of it. A
 * fill or a typing into a field that may hold a secret, or into none the action names (`keyboard.type`), shows no
 * count either, as the step path does: `typed text`.
 */
export function actionLabel(parts: ActionParts): string {
  const { kind } = parts;
  const locator = parts.locator ? hideSecretsInText(parts.locator) : null;
  const target = locator ? ` ${locator}` : '';
  switch (kind) {
    case 'goto': {
      const where = originAndPath(parts.url);
      return where ? `${VERBS.goto} ${where}` : 'Navigate';
    }
    case 'fill':
    case 'type': {
      const secret =
        !parts.locator ||
        namesSecretField(parts.locator) ||
        (parts.selector != null && namesSecretField(parts.selector));
      return `${VERBS[kind]}${target}: ${typedLabel(secret ? null : (parts.typedChars ?? null))}`;
    }
    case 'press':
      return `${VERBS.press} ${keyLabel(parts.key)}${locator ? ` on ${locator}` : ''}`;
    default:
      return `${VERBS[kind]}${target}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// From the stored trace
// ---------------------------------------------------------------------------------------------------------------------

/** What this module reads of a trace action. */
export interface TraceActionLike {
  apiName: string;
  class?: string;
  method?: string;
  params?: Record<string, unknown>;
  /** The trace's own clock, in ms. */
  startTime: number;
  error?: unknown;
}

/** What this module reads of a trace's `context-options` header. */
export interface TraceContextLike {
  origin?: string;
  wallTime?: number;
  monotonicTime?: number;
}

const TRACE_METHODS: Readonly<Record<string, VideoActionKind>> = {
  click: 'click',
  mouseClick: 'click',
  dblclick: 'dblclick',
  fill: 'fill',
  type: 'type',
  pressSequentially: 'type',
  keyboardType: 'type',
  keyboardInsertText: 'type',
  press: 'press',
  keyboardPress: 'press',
  check: 'check',
  uncheck: 'uncheck',
  selectOption: 'selectOption',
  hover: 'hover',
  goto: 'goto',
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** How many characters a typed value has; null when it is no text or reads as a credential or a card's number. */
function textLength(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  return looksLikeCardNumber(value) || isSecretValue(value) ? null : Array.from(value).length;
}

/** One quoted engine argument: `"Save"i` is `Save`, and `s` makes it exact. */
function quoted(body: string): { text: string; exact: boolean } | null {
  const m = /^"((?:[^"\\]|\\.)*)"([is])?$/.exec(body.trim());
  if (!m) return null;
  return { text: m[1]!.replace(/\\(.)/g, '$1'), exact: m[2] === 's' };
}

function textCall(method: string, body: string): string | null {
  const q = quoted(body);
  if (!q) return null;
  return q.exact ? `${method}(${quoteJsString(q.text)}, { exact: true })` : `${method}(${quoteJsString(q.text)})`;
}

/** One part of an internal selector (`internal:role=button[name="Save"i]`) as the locator call that made it. */
function renderSelectorPart(part: string): string {
  const text = part.trim();
  const nth = /^nth=(-?\d+)$/.exec(text);
  if (nth) return nth[1] === '0' ? 'first()' : nth[1] === '-1' ? 'last()' : `nth(${nth[1]})`;
  const role = /^internal:role=([\w-]+)((?:\[[^\]]*\])*)$/.exec(text);
  if (role) {
    const name = /\[name=("(?:[^"\\]|\\.)*"[is]?)\]/.exec(role[2]!);
    const q = name ? quoted(name[1]!) : null;
    const options = q ? `, { name: ${quoteJsString(q.text)}${q.exact ? ', exact: true' : ''} }` : '';
    return `getByRole(${quoteJsString(role[1]!)}${options})`;
  }
  const label = /^internal:label=(.+)$/.exec(text);
  if (label) return textCall('getByLabel', label[1]!) ?? `locator(${quoteJsString(text)})`;
  const plain = /^internal:text=(.+)$/.exec(text);
  if (plain) return textCall('getByText', plain[1]!) ?? `locator(${quoteJsString(text)})`;
  const attr = /^internal:attr=\[(placeholder|alt|title)=(.+)\]$/.exec(text);
  if (attr) {
    const method = { placeholder: 'getByPlaceholder', alt: 'getByAltText', title: 'getByTitle' }[attr[1]!]!;
    return textCall(method, attr[2]!) ?? `locator(${quoteJsString(text)})`;
  }
  const testId = /^internal:testid=\[data-testid=("(?:[^"\\]|\\.)*")s?\]$/.exec(text);
  if (testId) return textCall('getByTestId', testId[1]!) ?? `locator(${quoteJsString(text)})`;
  return `locator(${quoteJsString(text)})`;
}

/** The parts of a selector chain, split at each ` >> ` that is not inside a quoted string. */
function selectorParts(selector: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (selector.startsWith(' >> ', i)) {
      parts.push(selector.slice(start, i));
      start = i + 4;
      i += 3;
    }
  }
  parts.push(selector.slice(start));
  return parts;
}

/** A trace action's `selector` as the locator chain a test would write. Null for no selector. */
export function renderInternalSelector(selector: unknown): string | null {
  if (typeof selector !== 'string' || selector.trim() === '') return null;
  return selectorParts(selector).map(renderSelectorPart).join('.');
}

/** The test's wall clock at a trace time: through the anchor of the browser context's header, else null. */
function wallClockOf(contexts: readonly TraceContextLike[]): ((traceMs: number) => number) | null {
  const anchored = (c: TraceContextLike) => typeof c.wallTime === 'number' && typeof c.monotonicTime === 'number';
  const anchor = contexts.find((c) => c.origin === 'library' && anchored(c)) ?? contexts.find(anchored);
  if (!anchor) return null;
  return (traceMs) => Math.round(anchor.wallTime! + (traceMs - anchor.monotonicTime!));
}

/**
 * The actions in a stored trace, in the order they started. Null when the trace cannot be put on the wall clock (it
 * carries no anchor), so the caller reads the steps instead. A `setChecked` is a check or an uncheck by its `checked`
 * param.
 */
export function actionsFromTrace(
  actions: readonly TraceActionLike[],
  contexts: readonly TraceContextLike[],
): RawAction[] | null {
  const toWall = wallClockOf(contexts);
  if (!toWall) return null;
  const out: RawAction[] = [];
  for (const action of actions) {
    if (action.class === 'Test' || action.apiName.startsWith('expect')) continue;
    const method = action.method ?? '';
    const kind =
      method === 'setChecked' ? (action.params?.checked === false ? 'uncheck' : 'check') : TRACE_METHODS[method];
    if (!kind) continue;
    const params = action.params ?? {};
    const label = actionLabel({
      kind,
      locator: renderInternalSelector(params.selector),
      selector: str(params.selector) || null,
      typedChars: textLength(kind === 'fill' ? params.value : params.text),
      key: params.key,
      url: params.url,
    });
    out.push({ kind, epochMs: toWall(action.startTime), label, failed: action.error != null });
  }
  return out.sort((a, b) => a.epochMs - b.epochMs);
}

// ---------------------------------------------------------------------------------------------------------------------
// From the stored steps
// ---------------------------------------------------------------------------------------------------------------------

/** What this module reads of a stored step. */
export interface ActionStepLike {
  title?: unknown;
  category?: unknown;
  subtitle?: unknown;
  params?: unknown;
  location?: unknown;
  failed?: unknown;
  error?: unknown;
  startTime?: unknown;
}

/** Steps that are not an action of the test, whatever their title says. */
const OTHER_CATEGORIES = new Set(['assertion', 'hook', 'fixture', 'test.step', 'attach', 'wait', 'api']);

const STEP_KINDS: ReadonlyArray<readonly [RegExp, VideoActionKind]> = [
  [/^Navigate(?: to\b|$)/, 'goto'],
  [/^Double click\b/, 'dblclick'],
  [/^Click\b/, 'click'],
  [/^Fill "/, 'fill'],
  [/^Type "/, 'type'],
  [/^Press "/, 'press'],
  [/^Uncheck\b/, 'uncheck'],
  [/^Check\b/, 'check'],
  [/^Select option\b/, 'selectOption'],
  [/^Hover\b/, 'hover'],
];

const LOCATOR_KINDS = new Set<string>([
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'check',
  'uncheck',
  'selectOption',
  'hover',
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The value a title quotes after its verb, before the locator a 1.61 title ends with; null when it is not whole. */
function titleValue(title: string, prefix: string): string | null {
  if (!title.startsWith(prefix)) return null;
  // The earliest `" ` after which the rest is a whole locator ends a value that goes on to name one.
  for (let at = title.indexOf('" ', prefix.length); at >= 0; at = title.indexOf('" ', at + 1)) {
    if (tryParseLocatorChain(title.slice(at + 2))) return title.slice(prefix.length, at);
  }
  return title.endsWith('"') && title.length > prefix.length ? title.slice(prefix.length, -1) : null;
}

/** A stored value that is whole: not cut at the stored cap, not already hidden or masked. */
function whole(value: string | null): string | null {
  if (value == null) return null;
  if (value === HIDDEN_VALUE || /\[masked-(?:token|hex)\]|data:\[masked\]/.test(value)) return null;
  if (value.endsWith('…') || value.length >= MAX_STEP_PARAM_VALUE_CHARS) return null;
  return value;
}

function quotedOf(title: string): string | null {
  const m = /^Navigate to "(.*)"$/s.exec(title);
  return m ? m[1]! : null;
}

/** The actions in a stored step list, in step order; steps the test's own tooling ran and steps with no start are left out. */
export function actionsFromSteps(steps: unknown): RawAction[] {
  if (!Array.isArray(steps)) return [];
  const out: RawAction[] = [];
  steps.forEach((raw, index) => {
    const step = record(raw) as ActionStepLike;
    const title = str(step.title);
    if (typeof step.startTime !== 'number' || OTHER_CATEGORIES.has(str(step.category))) return;
    const kind = STEP_KINDS.find(([re]) => re.test(title))?.[1];
    if (!kind) return;
    // The capture's own steps are not the test's.
    if (/^Attach\s+["“]piwi-/i.test(title)) return;
    const params = record(step.params);
    const use = LOCATOR_KINDS.has(kind) ? extractStepLocatorUse(step, index) : null;
    const locator = use && use.action === kind ? use.locator : null;
    let typedChars: number | null = null;
    let key: unknown;
    if (kind === 'fill' || kind === 'type') {
      const stored = typeof params.value === 'string' ? params.value : null;
      const value = whole(stored ?? titleValue(title, kind === 'fill' ? 'Fill "' : 'Type "'));
      typedChars = value == null ? null : Array.from(value).length;
    } else if (kind === 'press') {
      key = typeof params.key === 'string' ? params.key : titleValue(title, 'Press "');
    }
    const url = kind === 'goto' ? (typeof params.url === 'string' ? params.url : quotedOf(title)) : undefined;
    out.push({
      kind,
      epochMs: step.startTime,
      label: actionLabel({ kind, locator, typedChars, key, url }),
      failed: step.failed === true || (step.error != null && step.error !== false),
    });
  });
  return out.sort((a, b) => a.epochMs - b.epochMs);
}

// ---------------------------------------------------------------------------------------------------------------------
// Onto the video
// ---------------------------------------------------------------------------------------------------------------------

/** The video time of each action, in order, capped at `MAX_VIDEO_ACTIONS`. Null when the test's clock is unknown. */
export function timeActions(
  raw: readonly RawAction[],
  timing: VideoTimingInput,
  cap = MAX_VIDEO_ACTIONS,
): Pick<VideoActionsResponse, 'timing' | 'actions' | 'total' | 'capped'> | null {
  const map = videoTimingMap(timing);
  if (!map) return null;
  const kept = raw.slice(0, cap);
  return {
    timing: raw.length > 0 ? map.source : null,
    actions: kept.map((a) => ({
      kind: a.kind,
      atMs: Math.round(a.epochMs - map.videoStartMs),
      label: a.label,
      failed: a.failed,
    })),
    total: raw.length,
    capped: raw.length > kept.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// On the lane
// ---------------------------------------------------------------------------------------------------------------------

/** One mark on the lane: an action, or the actions that fall within `MARK_MERGE_PX` of one another. */
export interface VideoMark {
  /** Where it sits in the video, in ms, held to the lane's span. */
  atMs: number;
  /** Where it sits on the lane, 0 to 1. */
  position: number;
  /** The actions it stands for, in order. */
  actions: VideoAction[];
  /** One of them failed. */
  failed: boolean;
  /** All of them started before the first frame or after the end of the test and sit at that edge. */
  clamped: boolean;
}

/** The text of a mark: its action's label, or its count when it merges several. */
export function markLabel(mark: VideoMark): string {
  return mark.actions.length === 1 ? mark.actions[0]!.label : `${mark.actions.length} actions`;
}

/**
 * The marks of a lane `spanMs` long and `widthPx` wide: each action held to the lane (and flagged when it had to be),
 * and the actions less than `gapPx` from the first of their group merged into one mark. Never drops an action.
 */
export function placeMarks(
  actions: readonly VideoAction[],
  spanMs: number,
  widthPx: number,
  gapPx = MARK_MERGE_PX,
): VideoMark[] {
  if (spanMs <= 0 || actions.length === 0) return [];
  const sorted = [...actions].sort((a, b) => a.atMs - b.atMs);
  const marks: VideoMark[] = [];
  let first: { x: number; mark: VideoMark } | null = null;
  for (const action of sorted) {
    const atMs = Math.min(spanMs, Math.max(0, action.atMs));
    const clamped = atMs !== action.atMs;
    const x = (atMs / spanMs) * widthPx;
    if (first && widthPx > 0 && x - first.x < gapPx) {
      first.mark.actions.push(action);
      first.mark.failed ||= action.failed;
      first.mark.clamped &&= clamped;
      continue;
    }
    const mark: VideoMark = { atMs, position: atMs / spanMs, actions: [action], failed: action.failed, clamped };
    marks.push(mark);
    first = { x, mark };
  }
  return marks;
}
