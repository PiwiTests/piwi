/**
 * One plain-language line that explains a Playwright failure before the raw
 * error is read: `getByRole('button', { name: 'Pay' }) never became enabled —
 * click timed out after 30 s`, `Expected 26 rows, found 51 — getByRole('row')
 * toHaveCount`, `Connection refused loading http://localhost:3000/`.
 *
 * Deterministic and built only from the parsed error, so the execution page,
 * the run list, the alerts, the pull-request comment, the MCP tools and the
 * reporter's terminal line all say the same thing. The headline is plain text,
 * at most about 120 characters, and never contains a fingerprint mask token;
 * `parts` splits it so a UI can render the locator as code. Shapes the parser
 * does not recognize fall back to the error's first line.
 */
import { parsePlaywrightError, type ParsedPlaywrightError } from './error-parse';
import {
  failingStepIndex,
  failureHookContext,
  isCaptureStep,
  isPhaseContainer,
  stepParents,
  stepPhases,
  type FailureHookContext,
  type TreeStepLike,
} from './step-tree';

type HeadlinePartKind = 'text' | 'locator' | 'value';

export interface HeadlinePart {
  kind: HeadlinePartKind;
  text: string;
}

export interface FailureDescription {
  headline: string;
  /** A second, shorter fact the headline left out (the last call-log state, the received value), or null. */
  detail: string | null;
  parts: HeadlinePart[];
}

export interface DescribeFailureContext {
  /**
   * The title of the failed step (or the last step that ran). Names what a
   * test timeout interrupted when the error itself carries no pending action.
   */
  lastStepTitle?: string | null;
  /**
   * The failing step's curated params. Its `locator` / `url` back the headline
   * where the error text names none (custom matchers, `test.step` failures).
   */
  stepParams?: Record<string, string | number | boolean> | null;
  /** The hook or fixture the failure happened in, when it happened outside the test body. */
  failedIn?: FailureHookContext | null;
}

/** Longest headline before the builder falls back to the leaf locator and shorter values. */
export const HEADLINE_MAX_CHARS = 120;
const VALUE_MAX_CHARS = 40;
const SHORT_VALUE_MAX_CHARS = 20;
const MASK_TOKEN_RE = /<(?:N|VALUE|URL|STR|UUID|HASH|EMAIL)>/g;

const ACTION_VERBS: Record<string, string> = {
  click: 'click',
  dblclick: 'double-click',
  fill: 'fill',
  type: 'type',
  press: 'press',
  pressSequentially: 'type',
  check: 'check',
  uncheck: 'uncheck',
  hover: 'hover',
  tap: 'tap',
  focus: 'focus',
  blur: 'blur',
  clear: 'clear',
  selectOption: 'select',
  selectText: 'select text',
  setInputFiles: 'file upload',
  setChecked: 'check',
  dragTo: 'drag',
  dragAndDrop: 'drag',
  scrollIntoViewIfNeeded: 'scroll',
  screenshot: 'screenshot',
  waitFor: 'wait',
  waitForSelector: 'waitForSelector',
  waitForLoadState: 'waitForLoadState',
  waitForFunction: 'waitForFunction',
  waitForResponse: 'waitForResponse',
  waitForRequest: 'waitForRequest',
  waitForEvent: 'waitForEvent',
  waitForTimeout: 'waitForTimeout',
  innerText: 'read text',
  textContent: 'read text',
  inputValue: 'read value',
  getAttribute: 'read attribute',
  isVisible: 'visibility check',
  isEnabled: 'enabled check',
  isChecked: 'checked check',
  boundingBox: 'measure',
  evaluate: 'evaluate',
  goto: 'navigation',
};

const ACTION_GERUNDS: Record<string, string> = {
  click: 'clicking',
  dblclick: 'double-clicking',
  fill: 'filling',
  type: 'typing into',
  press: 'pressing a key on',
  pressSequentially: 'typing into',
  check: 'checking',
  uncheck: 'unchecking',
  hover: 'hovering',
  tap: 'tapping',
  focus: 'focusing',
  clear: 'clearing',
  selectOption: 'selecting an option in',
  setInputFiles: 'uploading a file to',
  dragTo: 'dragging',
  waitFor: 'waiting for',
  waitForSelector: 'waiting for',
  evaluate: 'evaluating on',
};

/** Human wording for a call-log state, or null when the state adds nothing. */
const STATE_PHRASES: Record<string, string> = {
  'not-found': 'was not found on the page',
  hidden: 'never became visible',
  'not-visible': 'never became visible',
  'not-enabled': 'never became enabled',
  'not-editable': 'never became editable',
  inert: 'stayed inert',
  'not-stable': 'never stopped moving',
  'outside-viewport': 'stayed outside the viewport',
  'intercepts-pointer': 'was covered by another element',
  detached: 'was detached from the DOM',
  navigating: 'was still navigating',
};

/** Matchers whose expectation is a state of the element rather than a value. */
const STATE_MATCHERS: Record<string, { met: string; unmet: string }> = {
  toBeVisible: { met: 'visible', unmet: 'never became visible' },
  toBeHidden: { met: 'hidden', unmet: 'never became hidden' },
  toBeEnabled: { met: 'enabled', unmet: 'never became enabled' },
  toBeDisabled: { met: 'disabled', unmet: 'never became disabled' },
  toBeChecked: { met: 'checked', unmet: 'never became checked' },
  toBeEditable: { met: 'editable', unmet: 'never became editable' },
  toBeFocused: { met: 'focused', unmet: 'never received focus' },
  toBeAttached: { met: 'attached', unmet: 'never appeared in the DOM' },
  toBeDetached: { met: 'detached', unmet: 'never left the DOM' },
  toBeInViewport: { met: 'in the viewport', unmet: 'never entered the viewport' },
  toBeEmpty: { met: 'empty', unmet: 'never became empty' },
};

/** Matchers that compare a value, with the noun the headline uses for it. */
const VALUE_MATCHERS: Record<string, string> = {
  toHaveText: 'text',
  toContainText: 'text containing',
  toHaveValue: 'value',
  toHaveValues: 'values',
  toHaveAttribute: 'attribute',
  toHaveClass: 'class',
  toContainClass: 'class',
  toHaveId: 'id',
  toHaveCSS: 'CSS',
  toHaveJSProperty: 'property',
  toHaveAccessibleName: 'accessible name',
  toHaveAccessibleDescription: 'accessible description',
  toHaveRole: 'role',
  toHaveURL: 'URL',
  toHaveTitle: 'title',
  toHaveScreenshot: 'screenshot',
  toMatchAriaSnapshot: 'ARIA snapshot',
};

const NETWORK_ERRORS: Record<string, string> = {
  ERR_CONNECTION_REFUSED: 'Connection refused loading',
  ERR_CONNECTION_RESET: 'Connection reset loading',
  ERR_CONNECTION_CLOSED: 'Connection closed loading',
  ERR_CONNECTION_TIMED_OUT: 'Connection timed out loading',
  ERR_TIMED_OUT: 'Connection timed out loading',
  ERR_NAME_NOT_RESOLVED: 'DNS lookup failed for',
  ERR_INTERNET_DISCONNECTED: 'No network while loading',
  ERR_ADDRESS_UNREACHABLE: 'Address unreachable loading',
  ERR_ABORTED: 'Navigation aborted loading',
  ERR_EMPTY_RESPONSE: 'Empty response loading',
  ERR_TOO_MANY_REDIRECTS: 'Too many redirects loading',
  ERR_SSL_PROTOCOL_ERROR: 'TLS error loading',
  ERR_CERT_AUTHORITY_INVALID: 'Untrusted certificate loading',
  ERR_CERT_COMMON_NAME_INVALID: 'Certificate name mismatch loading',
  ERR_CERT_DATE_INVALID: 'Expired certificate loading',
  ERR_BLOCKED_BY_CLIENT: 'Request blocked loading',
  ERR_FAILED: 'Request failed loading',
  ERR_HTTP_RESPONSE_CODE_FAILURE: 'HTTP error loading',
  NS_ERROR_CONNECTION_REFUSED: 'Connection refused loading',
  NS_ERROR_UNKNOWN_HOST: 'DNS lookup failed for',
  NS_ERROR_NET_TIMEOUT: 'Connection timed out loading',
  NS_ERROR_OFFLINE: 'No network while loading',
  NS_ERROR_ABORT: 'Navigation aborted loading',
  NS_BINDING_ABORTED: 'Navigation aborted loading',
};

/** `30000` → `30 s`, `1500` → `1.5 s`, `500` → `500 ms`. */
export function formatTimeout(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  const rounded = Math.round(seconds * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded} s`;
}

/** The route of a URL (`/users`), or the text itself when it is not an absolute URL. */
function routeOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    return url;
  }
}

function truncateValue(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `getByRole('row')` → `rows`, `getByRole('button')` → `buttons`, anything else → `elements`. */
function countNoun(locator: string | null, count: number): string {
  const role = locator ? /getByRole\(\s*['"]([a-z]+)['"]/.exec(locator)?.[1] : null;
  const noun = role ?? 'element';
  if (count === 1) return noun;
  return noun.endsWith('s') ? noun : noun.endsWith('x') || noun.endsWith('ch') ? `${noun}es` : `${noun}s`;
}

/** `getByText('Invite sent')` → `Invite sent`, for the `Text "…"` phrasing. */
function textOfGetByText(locator: string | null): string | null {
  if (!locator) return null;
  const m = /^getByText\(\s*(['"`])((?:\\.|(?!\1)[^\\\n\r\u2028\u2029])*)\1\s*(?:,\s*\{[^}]*\})?\s*\)$/.exec(locator);
  return m ? m[2]! : null;
}

/** A received URL shown as its route, so `toHaveURL` fits on one line; other values verbatim. */
function receivedDisplay(parsed: ParsedPlaywrightError): string {
  const received = parsed.received ?? '';
  if (parsed.assertion !== 'toHaveURL') return received;
  const m = /^"?(https?:\/\/[^"\s]+)"?$/.exec(received);
  return m ? `"${routeOf(m[1]!)}"` : received;
}

/** The error's first line without a bare `Error:` prefix, mask tokens and surplus whitespace. */
function firstLineFallback(parsed: ParsedPlaywrightError): string {
  const line = (parsed.messageHead.split('\n')[0] ?? '').replace(/^Error:\s*/, '').replace(MASK_TOKEN_RE, '…');
  return truncateValue(line || 'Unknown error', HEADLINE_MAX_CHARS);
}

// ── Part assembly ────────────────────────────────────────────────────────────

class Line {
  readonly parts: HeadlinePart[] = [];

  text(text: string): this {
    if (!text) return this;
    const last = this.parts[this.parts.length - 1];
    if (last && last.kind === 'text') last.text += text;
    else this.parts.push({ kind: 'text', text });
    return this;
  }

  locator(text: string): this {
    this.parts.push({ kind: 'locator', text });
    return this;
  }

  value(text: string): this {
    this.parts.push({ kind: 'value', text });
    return this;
  }

  toString(): string {
    return this.parts.map((p) => p.text).join('');
  }
}

interface BuildOptions {
  /** Which locator expression to print: the full chain or its innermost call. */
  locator: string | null;
  valueMax: number;
}

/** The locator, or the `Text "…"` form for a plain getByText call. */
function subject(line: Line, locator: string | null, opts: BuildOptions): Line {
  const text = textOfGetByText(locator);
  if (text !== null) return line.text('Text ').value(`"${truncateValue(text, opts.valueMax)}"`);
  return line.locator(opts.locator ?? locator ?? '');
}

function timeoutSuffix(timeoutMs: number | null): string {
  return timeoutMs !== null ? ` after ${formatTimeout(timeoutMs)}` : '';
}

function timeoutParen(timeoutMs: number | null): string {
  return timeoutMs !== null ? ` (${formatTimeout(timeoutMs)})` : '';
}

function buildActionTimeout(parsed: ParsedPlaywrightError, opts: BuildOptions): Line {
  const line = new Line();
  const verb = ACTION_VERBS[parsed.action ?? ''] ?? parsed.action ?? 'action';
  const state = STATE_PHRASES[parsed.lastState];
  if (parsed.locator && state) {
    return subject(line, parsed.locator, opts)
      .text(` ${state} — ${verb} timed out`)
      .text(timeoutSuffix(parsed.timeoutMs));
  }
  if (parsed.locator && parsed.lastState === 'resolved-count' && parsed.resolvedCount !== null) {
    const count = parsed.resolvedCount;
    return subject(line, parsed.locator, opts)
      .text(` matched ${count === 0 ? 'no' : count} ${countNoun(parsed.locator, count)} — ${verb} timed out`)
      .text(timeoutSuffix(parsed.timeoutMs));
  }
  if (parsed.locator) {
    return line
      .text(`${verb} on `)
      .locator(opts.locator ?? parsed.locator)
      .text(' timed out')
      .text(timeoutSuffix(parsed.timeoutMs));
  }
  const call = parsed.subject && parsed.action ? `${parsed.subject}.${parsed.action}` : verb;
  return line.text(`${call} timed out`).text(timeoutSuffix(parsed.timeoutMs));
}

function buildAssertion(parsed: ParsedPlaywrightError, opts: BuildOptions): Line {
  const line = new Line();
  const matcher = parsed.assertion ?? 'expect';
  const notFound =
    parsed.lastState === 'not-found' ||
    (parsed.lastState === 'resolved-count' && parsed.resolvedCount === 0) ||
    /element\(s\) not found/.test(parsed.received ?? '');
  const expected = parsed.expected ? truncateValue(parsed.expected, opts.valueMax) : null;
  const received = parsed.received ? truncateValue(receivedDisplay(parsed), opts.valueMax) : null;

  if (matcher === 'toHaveCount' && parsed.locator) {
    const want = Number(parsed.expected);
    const got = notFound ? 0 : Number(parsed.received);
    const wantText = Number.isFinite(want) ? String(want) : (expected ?? '?');
    const noun = countNoun(parsed.locator, Number.isFinite(want) ? want : 2);
    const gotText = Number.isFinite(got) ? (got === 0 ? 'none' : String(got)) : (received ?? 'none');
    return line
      .text(`Expected ${wantText} ${noun}, found ${gotText} — `)
      .locator(opts.locator ?? parsed.locator)
      .text(' toHaveCount');
  }

  const state = STATE_MATCHERS[matcher];
  if (state) {
    const unmet = parsed.negated ? `stayed ${state.met}` : state.unmet;
    if (!parsed.locator) return line.text(`Expected ${state.met}, page ${unmet}`).text(timeoutParen(parsed.timeoutMs));
    if (notFound && matcher !== 'toBeVisible' && matcher !== 'toBeAttached') {
      return subject(line, parsed.locator, opts)
        .text(` was not found on the page — expected ${state.met}`)
        .text(timeoutParen(parsed.timeoutMs));
    }
    return subject(line, parsed.locator, opts).text(` ${unmet}`).text(timeoutParen(parsed.timeoutMs));
  }

  const noun = VALUE_MATCHERS[matcher];
  if (noun) {
    if (parsed.locator && notFound) {
      return subject(line, parsed.locator, opts)
        .text(' was not found on the page — expected ')
        .text(`${noun} `)
        .value(expected ?? '')
        .text(timeoutParen(parsed.timeoutMs));
    }
    line.text(`Expected ${noun} `);
    if (expected) line.value(expected);
    else line.text('to match');
    if (received) line.text(', got ').value(received);
    if (parsed.locator)
      line
        .text(' — ')
        .locator(opts.locator ?? parsed.locator)
        .text(` ${matcher}`);
    else if (matcher === 'toHaveURL' || matcher === 'toHaveTitle') line.text(` — page ${matcher}`);
    return line;
  }

  if (matcher === 'toPass') return line.text('expect.toPass never passed').text(timeoutParen(parsed.timeoutMs));

  if (expected || received) {
    line.text('Expected ');
    if (expected) line.value(expected);
    else line.text('a different value');
    if (received) line.text(', got ').value(received);
    line.text(` — ${matcher}`);
    if (parsed.locator) line.text(' on ').locator(opts.locator ?? parsed.locator);
    return line;
  }

  if (parsed.locator) {
    return subject(line, parsed.locator, opts).text(` failed ${matcher}`).text(timeoutParen(parsed.timeoutMs));
  }
  return line.text(`${matcher} assertion failed`);
}

function buildStrictMode(parsed: ParsedPlaywrightError, opts: BuildOptions): Line {
  const line = new Line();
  const count = parsed.resolvedCount ?? 0;
  if (!parsed.locator) return line.text(`Locator matched ${count} elements — strict mode`);
  return line
    .locator(opts.locator ?? parsed.locator)
    .text(` matched ${count} ${countNoun(parsed.locator, count)} — strict mode`);
}

function buildNavigation(parsed: ParsedPlaywrightError, opts: BuildOptions): Line {
  const line = new Line();
  const code = parsed.networkErrorCode?.replace(/^net::/, '') ?? null;
  if (code) {
    const phrase =
      NETWORK_ERRORS[code] ??
      `${code
        .replace(/^(?:ERR|NS_ERROR)_/, '')
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/^\w/, (c) => c.toUpperCase())} loading`;
    line.text(phrase);
    if (parsed.url) line.text(' ').value(truncateValue(parsed.url, opts.valueMax * 2));
    return line;
  }
  const route = parsed.url ? routeOf(parsed.url) : null;
  const timedOut = parsed.timeoutMs !== null || parsed.errorName === 'TimeoutError';
  if (parsed.action === 'waitForURL' || parsed.action === 'waitForNavigation') {
    line.text('Never navigated to ');
    if (route) line.value(truncateValue(route, opts.valueMax));
    else line.text('the expected URL');
    return line.text(` — ${parsed.action} timed out`).text(timeoutSuffix(parsed.timeoutMs));
  }
  line.text('Navigation');
  if (route) line.text(' to ').value(truncateValue(route, opts.valueMax));
  if (timedOut) return line.text(' timed out').text(timeoutSuffix(parsed.timeoutMs));
  return line.text(' failed');
}

function buildTestTimeout(
  parsed: ParsedPlaywrightError,
  opts: BuildOptions,
  ctx: DescribeFailureContext | undefined,
): Line {
  const line = new Line().text('Test timed out').text(timeoutSuffix(parsed.timeoutMs));
  if (parsed.timeoutPhase) {
    const phase = parsed.timeoutPhase;
    const isHook = /^(?:before|after)(?:Each|All)$/.test(phase);
    return line.text(isHook ? ` in the "${phase}" hook` : ` while tearing down "${phase}"`);
  }
  if (parsed.isNavigationFailure && parsed.url) {
    return line.text(' while navigating to ').value(truncateValue(routeOf(parsed.url), opts.valueMax));
  }
  if (parsed.assertion && parsed.locator) {
    const state = STATE_MATCHERS[parsed.assertion];
    line.text(state ? ` while waiting for ` : ' while expecting ');
    subject(line, parsed.locator, opts);
    return line.text(state ? ` to be ${state.met}` : ` ${parsed.assertion}`);
  }
  if (parsed.action && parsed.locator) {
    const gerund = ACTION_GERUNDS[parsed.action] ?? `${ACTION_VERBS[parsed.action] ?? parsed.action} on`;
    line.text(` while ${gerund} `);
    return subject(line, parsed.locator, opts);
  }
  if (parsed.subject && parsed.action) return line.text(` during ${parsed.subject}.${parsed.action}`);
  const step = ctx?.lastStepTitle?.trim();
  if (step) return line.text(' while ').value(`"${truncateValue(step, opts.valueMax * 1.5)}"`);
  return line;
}

function buildCrash(parsed: ParsedPlaywrightError, opts: BuildOptions): Line {
  const line = new Line();
  const what = /Page crashed/i.test(parsed.messageHead) ? 'Page crashed' : 'Page or browser closed';
  if (parsed.action) {
    const verb = ACTION_VERBS[parsed.action] ?? parsed.action;
    line.text(`${what} during ${verb}`);
    if (parsed.locator) line.text(' on ').locator(opts.locator ?? parsed.locator);
    return line;
  }
  if (parsed.assertion && parsed.locator) {
    return line
      .text(`${what} while expecting `)
      .locator(opts.locator ?? parsed.locator)
      .text(` ${parsed.assertion}`);
  }
  return line.text(what);
}

/** Longest custom `expect` message quoted in a headline. */
const CUSTOM_MESSAGE_MAX_CHARS = 60;

/** A first word in plain sentence case (`Expected`, `Timed`), not a name such as `TypeError` or `GraphQL`. */
const SENTENCE_CASE_WORD_RE = /^[A-Z][a-z]*(?![A-Za-z])/;

/**
 * Put what the failure is about ahead of the line: the hook or fixture it
 * happened in, then the message the author gave `expect`. The line's first word
 * drops its capital when it follows a lead (`In beforeAll: expected …`), unless
 * it is a name (`In beforeAll: TypeError: …`).
 * A test timeout that already names its hook keeps its own wording.
 */
function withLeads(line: Line, parsed: ParsedPlaywrightError, ctx: DescribeFailureContext | undefined): Line {
  const hook = ctx?.failedIn && !parsed.timeoutPhase ? ctx.failedIn.hook : null;
  const message = parsed.customMessage ? truncateValue(parsed.customMessage, CUSTOM_MESSAGE_MAX_CHARS) : null;
  if (!hook && !message) return line;

  const led = new Line();
  if (hook) led.text(`In ${hook}${message ? ', ' : ': '}`);
  if (message) led.text(`"${message}" failed: `);
  line.parts.forEach((part, i) => {
    const text =
      i === 0 && part.kind === 'text' && SENTENCE_CASE_WORD_RE.test(part.text)
        ? part.text[0]!.toLowerCase() + part.text.slice(1)
        : part.text;
    if (part.kind === 'text') led.text(text);
    else if (part.kind === 'locator') led.locator(text);
    else led.value(text);
  });
  return led;
}

function build(parsed: ParsedPlaywrightError, opts: BuildOptions, ctx: DescribeFailureContext | undefined): Line {
  return withLeads(buildLine(parsed, opts, ctx), parsed, ctx);
}

function buildLine(parsed: ParsedPlaywrightError, opts: BuildOptions, ctx: DescribeFailureContext | undefined): Line {
  switch (parsed.kind) {
    case 'action-timeout':
      return buildActionTimeout(parsed, opts);
    case 'assertion':
    case 'assertion-timeout':
      return buildAssertion(parsed, opts);
    case 'strict-mode':
      return buildStrictMode(parsed, opts);
    case 'navigation':
      return buildNavigation(parsed, opts);
    case 'test-timeout':
      return buildTestTimeout(parsed, opts, ctx);
    case 'crash':
      return buildCrash(parsed, opts);
    default:
      return new Line().text(firstLineFallback(parsed));
  }
}

/** The secondary fact under the headline, or null when the headline already carries it. */
function detailOf(parsed: ParsedPlaywrightError, headline: string): string | null {
  switch (parsed.kind) {
    case 'test-timeout':
    case 'action-timeout': {
      const state = parsed.lastStateLine;
      if (!state || parsed.lastState === 'not-found' || headline.includes(state)) return null;
      return truncateValue(state, HEADLINE_MAX_CHARS);
    }
    case 'assertion':
    case 'assertion-timeout': {
      const received = parsed.received;
      if (received && !/element\(s\) not found/.test(received)) {
        const shown = truncateValue(receivedDisplay(parsed), SHORT_VALUE_MAX_CHARS).slice(0, 8);
        if (!headline.includes(shown)) return truncateValue(`Received: ${received}`, HEADLINE_MAX_CHARS);
      }
      const state = parsed.lastStateLine;
      if (!state || /^(?:waiting for |unexpected value )/.test(state)) return null;
      return truncateValue(state, HEADLINE_MAX_CHARS);
    }
    case 'navigation':
      return parsed.networkErrorCode ?? parsed.lastStateLine;
    case 'strict-mode':
    case 'crash':
      return null;
    default:
      return null;
  }
}

/**
 * Describe a parsed failure in one deterministic line. Pass the raw error text
 * through `parsePlaywrightError` first, or use {@link describeFailureText}.
 */
export function describeFailure(parsed: ParsedPlaywrightError, ctx?: DescribeFailureContext): FailureDescription {
  const attempts: BuildOptions[] = [
    { locator: parsed.locator, valueMax: VALUE_MAX_CHARS },
    { locator: parsed.leafLocator ?? parsed.locator, valueMax: VALUE_MAX_CHARS },
    { locator: parsed.leafLocator ?? parsed.locator, valueMax: SHORT_VALUE_MAX_CHARS },
  ];
  let line = build(parsed, attempts[0]!, ctx);
  for (const opts of attempts.slice(1)) {
    if (line.toString().length <= HEADLINE_MAX_CHARS) break;
    line = build(parsed, opts, ctx);
  }

  let parts = line.parts.map((p) => ({ ...p, text: p.text.replace(MASK_TOKEN_RE, '…') }));
  let headline = parts.map((p) => p.text).join('');
  if (headline.length > HEADLINE_MAX_CHARS) {
    headline = `${headline.slice(0, HEADLINE_MAX_CHARS - 1)}…`;
    parts = clipParts(parts, HEADLINE_MAX_CHARS - 1);
    parts.push({ kind: 'text', text: '…' });
  }
  if (!headline.trim()) {
    headline = firstLineFallback(parsed);
    parts = [{ kind: 'text', text: headline }];
  }
  return { headline, detail: detailOf(parsed, headline), parts };
}

/** Cut a part list to `max` characters, dropping empty remainders. */
function clipParts(parts: HeadlinePart[], max: number): HeadlinePart[] {
  const out: HeadlinePart[] = [];
  let used = 0;
  for (const part of parts) {
    if (used >= max) break;
    const text = part.text.slice(0, max - used);
    if (text) out.push({ kind: part.kind, text });
    used += text.length;
  }
  return out;
}

/** Parse and describe a raw error in one call; empty input yields null. */
export function describeFailureText(
  raw: string | null | undefined,
  ctx?: DescribeFailureContext,
): FailureDescription | null {
  if (!raw || !raw.trim()) return null;
  return describeFailure(parsePlaywrightError(raw, { stepParams: ctx?.stepParams }), ctx);
}

/** A recorded step, as the headline helpers read it. */
export interface HeadlineStepLike extends TreeStepLike {
  title?: unknown;
  params?: Record<string, string | number | boolean> | null;
}

/**
 * The step a headline speaks for: the step that failed (the innermost of the
 * failing chain that carries `error`, the execution's error text), else the
 * last step of the test body, else the last step. The capture's own steps and
 * the hook containers are never picked.
 */
function headlineStep<T extends HeadlineStepLike>(
  steps: readonly T[] | null | undefined,
  error?: string | null,
): T | null {
  if (!steps || steps.length === 0) return null;
  const parents = stepParents(steps);
  const failed = failingStepIndex(steps, parents, error);
  if (failed !== null) return steps[failed]!;
  const phases = stepPhases(steps, parents);
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (phases[i] === 'body' && !isCaptureStep(step) && !isPhaseContainer(step)) return step;
  }
  return steps[steps.length - 1]!;
}

/**
 * The failed step's title, else the last step's, from a recorded step list —
 * the `lastStepTitle` a test-timeout headline names. `error` is the
 * execution's error text, which tells the failing step from a caught one.
 */
export function lastStepTitle(
  steps: readonly HeadlineStepLike[] | null | undefined,
  error?: string | null,
): string | null {
  const title = headlineStep(steps, error)?.title;
  return typeof title === 'string' ? title : null;
}

/**
 * The failing step's params (else the last step's) — the `stepParams` a
 * headline reads for its locator when the error text carries none. Mirrors
 * {@link lastStepTitle}'s failed-else-last choice.
 */
export function failingStepParams(
  steps: readonly HeadlineStepLike[] | null | undefined,
  error?: string | null,
): Record<string, string | number | boolean> | null {
  return headlineStep(steps, error)?.params ?? null;
}

/**
 * Everything a headline reads from the recorded steps: the failing step's title
 * and params, and the hook or fixture the failure happened in. The one source
 * the dashboard and the reporter's terminal line share.
 */
export function stepHeadlineContext(
  steps: readonly HeadlineStepLike[] | null | undefined,
  error: string | null | undefined,
): DescribeFailureContext {
  return {
    lastStepTitle: lastStepTitle(steps, error),
    stepParams: failingStepParams(steps, error),
    failedIn: steps && steps.length > 0 ? failureHookContext(steps, error ?? null) : null,
  };
}
