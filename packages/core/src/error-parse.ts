/**
 * Structured parsing of a Playwright error text.
 *
 * Playwright's error messages are finite in shape: an action that timed out
 * with its call log, a web-first assertion with `Locator:` / `Expected:` /
 * `Received:` / `Timeout:` headers, an older value assertion, a strict-mode
 * violation, a navigation error, a test timeout, a closed page, or an error
 * thrown by the test itself. `parsePlaywrightError` reads any of them into one
 * record — what was attempted, on which locator, what was expected and received,
 * how long Playwright waited, and the last state the call log reported — so the
 * dashboard, the notifications, the pull-request comment, the MCP tools and the
 * reporter's terminal line all describe a failure from the same facts.
 *
 * Pure text analysis, dependency-free, shared by the app and the reporter. It
 * never throws: an unrecognized shape yields `kind: 'unknown'` with whatever
 * fields could still be read.
 */

/** The locator-builder methods whose innermost call identifies the resolved element. */
import { scanLocatorChain } from './locator-chain';
import { LOCATOR_BUILDER_METHODS } from './locator-methods';

export type ParsedErrorKind =
  /** A locator or page action exceeded its own timeout (`locator.click: Timeout 30000ms exceeded.`). */
  | 'action-timeout'
  /** A value assertion with no retry (`expect(received).toBe(expected)`). */
  | 'assertion'
  /** A retrying web-first assertion that ran out its timeout (`expect(locator).toBeVisible() failed`). */
  | 'assertion-timeout'
  /** A locator matched several elements. */
  | 'strict-mode'
  /** A navigation failed or timed out (`page.goto`, `net::ERR_*`, `waitForURL`). */
  | 'navigation'
  /** The whole test exceeded its timeout. */
  | 'test-timeout'
  /** The page, context or browser closed or crashed under the test. */
  | 'crash'
  | 'unknown';

/** The last state Playwright's call log reported for the locator. */
export type CallLogState =
  /** Only `waiting for <locator>` lines — the element never appeared. */
  | 'not-found'
  /** `locator resolved to N elements` (0 included — see `resolvedCount`). */
  | 'resolved-count'
  /** The locator resolved to a single element and nothing later contradicted it. */
  | 'resolved'
  /** `locator resolved to hidden <…>` or `unexpected value "hidden"`. */
  | 'hidden'
  | 'not-visible'
  | 'not-enabled'
  | 'not-editable'
  | 'not-stable'
  | 'outside-viewport'
  /** Another element receives the pointer events. */
  | 'intercepts-pointer'
  /** The element left the DOM after resolving. */
  | 'detached'
  /** The page was still navigating. */
  | 'navigating'
  /** No call log, or one without a state line. */
  | 'unknown';

export interface ParsedPlaywrightError {
  kind: ParsedErrorKind;
  /** The error class prefix (`TimeoutError`, `TypeError`, `Error`), when the first line carries one. */
  errorName: string | null;
  /** The API object the failing call was made on (`locator`, `page`, `frame`, `expect`, …). */
  subject: string | null;
  /** The failing action (`click`, `fill`, `goto`, `waitForSelector`, …); null for assertions and thrown errors. */
  action: string | null;
  /** The failing matcher (`toHaveCount`, `toBeVisible`, …); null outside assertions. */
  assertion: string | null;
  /** True for `expect(…).not.<matcher>`. */
  negated: boolean;
  /** The full locator chain as Playwright code, or null when the error names none. */
  locator: string | null;
  /** The innermost locator-creating call of that chain. */
  leafLocator: string | null;
  /** Raw `Expected:` value, whitespace-trimmed; null when absent or spread over several lines. */
  expected: string | null;
  /** Raw `Received:` value, whitespace-trimmed; null when absent or spread over several lines. */
  received: string | null;
  timeoutMs: number | null;
  /** The URL a navigation was heading for, when the error names one. */
  url: string | null;
  /** The `net::ERR_*` / `NS_ERROR_*` code of a failed navigation. */
  networkErrorCode: string | null;
  /** The hook or teardown phase a test timeout hit (`beforeEach`, `context`), when stated. */
  timeoutPhase: string | null;
  lastState: CallLogState;
  /** The element count behind a `resolved-count` state (also set by strict-mode violations). */
  resolvedCount: number | null;
  /** The last call-log line, verbatim without its bullet. */
  lastCallLogLine: string | null;
  /** The call-log line that set `lastState`, verbatim without its bullet. */
  lastStateLine: string | null;
  /** The lines before the call log and the stack, at most five. */
  messageHead: string;
  /** The message an `expect(value, message)` call puts above Playwright's own matcher line. */
  customMessage: string | null;
  /** First stack frame outside `node_modules`, as `file:line`. */
  topFrame: string | null;
  /** True when the navigation signals (a navigation action or a network error code) are present. */
  isNavigationFailure: boolean;
  /** True when the locator never resolved, matched nothing, or matched several elements. */
  isLocatorResolutionFailure: boolean;
}

// eslint-disable-next-line no-control-regex -- intentionally matches the ESC byte to strip ANSI color codes
const ANSI_RE = new RegExp('\\u001B\\[[0-9;]*m', 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

const SELECTOR_FN_RE =
  /\b(?:locator|frameLocator|getByRole|getByTestId|getByText|getByLabel|getByPlaceholder|getByAltText|getByTitle)\(/;

/** Methods that extend a locator chain without leaving it. */
const CHAIN_LINK_METHODS = new Set<string>([
  ...LOCATOR_BUILDER_METHODS,
  'frameLocator',
  'contentFrame',
  'filter',
  'first',
  'last',
  'nth',
  'and',
  'or',
  'describe',
]);

/**
 * Cut the error down to its message head: everything before the Playwright
 * call log and the JS stack trace, capped at 5 non-empty lines so long
 * element dumps (strict-mode violations) don't destabilize the fingerprint.
 * Notifications and pull-request comments quote the same head.
 */
export function extractMessageHead(text: string): string {
  let head = text;
  const callLogIdx = head.indexOf('\nCall log:');
  if (callLogIdx !== -1) head = head.slice(0, callLogIdx);
  const stackIdx = stackStart(head);
  if (stackIdx !== -1) head = head.slice(0, stackIdx);
  const lines = head
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.slice(0, 5).join('\n');
}

/**
 * Where the JS stack starts: the first line break that whitespace leads from to
 * an `at ` frame (`\n    at …`), the match of `/\n\s+at /`. Read in one pass
 * over the text's whitespace runs, so its time stays linear however long a run
 * of blank lines it holds.
 */
function stackStart(text: string): number {
  const runs = /\s+/g;
  for (let run = runs.exec(text); run; run = runs.exec(text)) {
    if (!text.startsWith('at ', runs.lastIndex)) continue;
    const lineBreak = run[0].indexOf('\n');
    if (lineBreak !== -1 && lineBreak < run[0].length - 1) return run.index + lineBreak;
  }
  return -1;
}

/**
 * Extract the first Playwright locator expression, scanning forward with a
 * paren-depth counter so nested forms like getByRole('row', { name: '…' })
 * are captured whole.
 */
export function extractSelector(text: string): string | null {
  const match = SELECTOR_FN_RE.exec(text);
  if (!match) return null;
  const start = match.index;
  let depth = 0;
  for (let i = start; i < Math.min(text.length, start + 200); i++) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    } else if (ch === '\n') {
      break;
    }
  }
  // Unbalanced within the window — keep a stable prefix
  return text.slice(start, start + 80);
}

/**
 * Extract the leaf (innermost) locator call from a chained locator in the error,
 * e.g. `getByRole('row', { name: 'Acme' }).getByRole('button', { name: 'Delete' })`
 * → `getByRole('button', { name: 'Delete' })`.
 *
 * The capture side records a chain's innermost locator-creating call, so the
 * healing signature lookup must compare against the same leaf rather than the
 * outermost call `extractSelector` returns. For a non-chained locator the leaf
 * is the whole expression, so this matches `extractSelector`.
 *
 * Only top-level (depth-0) calls of the chain count — a locator nested inside
 * another call's args (e.g. `filter({ has: getByText('…') })`) sits at depth > 0
 * and is skipped, matching the capture side which advances the origin only
 * through top-level chain links.
 */
export function extractLeafSelector(text: string): string | null {
  const first = SELECTOR_FN_RE.exec(text);
  if (!first) return null;

  // Bound to the chain's own line; the Call log prints it on one line and the
  // appended stack frame is a separate line.
  const nl = text.indexOf('\n', first.index);
  const region = text.slice(first.index, nl === -1 ? undefined : nl);

  const scanned = readChain(region);
  if (scanned) {
    for (let k = scanned.chain.calls.length - 1; k >= 0; k--) {
      if (LEAF_METHODS.has(scanned.chain.calls[k]!.method)) {
        return region.slice(scanned.spans[k]!.start, scanned.spans[k]!.end);
      }
    }
    return null;
  }
  return lenientLeaf(region);
}

const LEAF_METHODS: ReadonlySet<string> = new Set(LOCATOR_BUILDER_METHODS);

/** Index just past the string literal opening at `i`, or the end of `text` when it is cut short. */
function skipQuoted(text: string, i: number): number {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === quote) return j + 1;
  }
  return text.length;
}

/**
 * The leaf of a chain the parser can't read — cut short in the error text. The
 * last top-level builder call, found by counting parentheses outside string
 * literals, up to its closing parenthesis or a stable 80-character prefix.
 */
function lenientLeaf(region: string): string | null {
  let depth = 0;
  let leafStart = -1;
  for (let i = 0; i < region.length; i++) {
    const ch = region[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(region, i) - 1;
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth !== 0) continue;
    const prev = region[i - 1];
    if (prev && /\w/.test(prev)) continue; // require a word boundary before the method
    for (const method of LOCATOR_BUILDER_METHODS) {
      if (region.startsWith(method, i) && region[i + method.length] === '(') {
        leafStart = i;
        break;
      }
    }
  }
  if (leafStart === -1) return null;

  depth = 0;
  for (let i = leafStart; i < region.length; i++) {
    const ch = region[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(region, i) - 1;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return region.slice(leafStart, i + 1);
    }
  }
  return region.slice(leafStart, leafStart + 80);
}

/**
 * The whole locator chain starting at the first locator call on its line —
 * every top-level `.method(...)` link included, so
 * `getByRole('row', { name: 'Acme' }).getByRole('button').first()` is kept
 * whole where `extractSelector` stops after the first balanced call.
 */
export function extractLocatorChain(text: string): string | null {
  const first = SELECTOR_FN_RE.exec(text);
  if (!first) return null;
  const nl = text.indexOf('\n', first.index);
  const region = text.slice(first.index, nl === -1 ? undefined : nl);

  const scanned = readChain(region);
  if (scanned) return region.slice(0, scanned.end);

  // Text the parser can't read (cut short): balanced calls outside string
  // literals, continuing only through chained locator links.
  let depth = 0;
  let end = -1;
  for (let i = 0; i < region.length; i++) {
    const ch = region[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(region, i) - 1;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      if (depth > 0) depth--;
      if (depth === 0) {
        end = i + 1;
        // Continue only through a chained locator link, never into `.click()`.
        const link = /^\.(\w+)\(/.exec(region.slice(end));
        if (!link || !CHAIN_LINK_METHODS.has(link[1]!)) break;
        i = end + link[0].length - 2;
      }
    }
  }
  if (end === -1) return region.slice(0, 80);
  return region.slice(0, end);
}

/**
 * The chain at the start of `region`, read with the shared parser — null when
 * it doesn't parse, or when it stops right before another chain link (one cut
 * short in the error text, or one the parser doesn't know): the caller then
 * reads the region leniently.
 */
function readChain(region: string): ReturnType<typeof scanLocatorChain> {
  const scanned = scanLocatorChain(region);
  if (!scanned) return null;
  const link = /^\s*\.\s*(\w+)\(/.exec(region.slice(scanned.end));
  return link && CHAIN_LINK_METHODS.has(link[1]!) ? null : scanned;
}

/** The stack frames outside node_modules and Node internals, innermost first. */
export function extractStackFrames(text: string): Array<{ file: string; line: number; column: number }> {
  const frameRe = /^[ \t]+at (?:.*? \()?([^()\s][^()\n]*?):(\d+):(\d+)\)?[ \t]*$/gm;
  const frames: Array<{ file: string; line: number; column: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = frameRe.exec(text)) !== null) {
    const file = m[1]!.replace(/\\/g, '/');
    if (file.includes('node_modules') || file.startsWith('node:')) continue;
    frames.push({ file, line: Number(m[2]), column: Number(m[3]) });
  }
  return frames;
}

/** The first stack frame outside node_modules and Node internals. */
export function extractTopFrame(text: string): { file: string; line: number; column: number } | null {
  return extractStackFrames(text)[0] ?? null;
}

/** First stack frame outside node_modules and Node internals, file path only. */
export function extractTopFrameFile(text: string): string | null {
  return extractTopFrame(text)?.file ?? null;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** API objects a failing call is reported on, as `<subject>.<method>: …`. */
const SUBJECTS =
  'locator|page|frame|frameLocator|elementHandle|mouse|keyboard|touchscreen|browserContext|browser|apiRequestContext|request|response|route|download|dialog|fileChooser|expect|worker|jsHandle|clock|tracing|video';
const CALL_RE = new RegExp(`\\b(${SUBJECTS})\\.(\\w+): `);
const ERROR_NAME_RE = /^((?:[A-Z]\w*)?(?:Error|Exception))\b:?/;
const MATCHER_RE = /\bexpect(?:\.soft)?\((?:[^()]|\([^()]*\))*\)(\.not)?\.(to\w+)/;
const MATCHER_SHORT_RE = /\bexpect(?:\.soft)?\.(to\w+)\b/;
const TIMED_OUT_EXPECT_RE = /Timed out (\d+)ms waiting for expect\(/;
const NAVIGATION_RE =
  /\b(?:page|frame)\.(?:goto|waitForURL|waitForNavigation|reload|goBack|goForward)\b|net::ERR_|NS_ERROR_|Navigation failed|navigating to "/i;
const NETWORK_CODE_RE = /\b(net::ERR_[A-Z0-9_]+|NS_ERROR_[A-Z0-9_]+)\b/;
const CRASH_RE =
  /Target page, context or browser has been closed|Target closed|browser has been closed|Browser closed|Page crashed|Navigation failed because page was closed/i;
const TEST_TIMEOUT_RE = /\bTest timeout of (\d+)ms exceeded(?: while (?:running "(\w+)" hook|tearing down "(\w+)"))?/;
const STRICT_RE = /strict mode violation: (.+?) resolved to (\d+) elements/;
const URL_RE = /https?:\/\/[^\s'"`)]+/;
const CALL_LOG_LINE_RE = /^\s*-\s+(?:(\d+) × )?(.*)$/;
/** A retry-count line Playwright prints without a bullet, indented under a `waiting for` bullet. */
const RETRY_COUNT_LINE_RE = /^\s+\d+ × (.+)$/;

interface CallLogRead {
  state: CallLogState;
  count: number | null;
  lastLine: string | null;
  stateLine: string | null;
  url: string | null;
  timeoutMs: number | null;
  matcher: string | null;
}

/** The text without its JS stack frames (so a helper named `goto` in a path never reads as a navigation). */
export function withoutStackFrames(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s+at /.test(line))
    .join('\n');
}

/**
 * The call-log lines: everything after `Call log:` when the header is present,
 * otherwise any `  - …` bullet in the text (a message that was cut before the
 * header still carries them). A retry-count line (`N × locator resolved to …`)
 * rides under its `waiting for` bullet without one of its own, so it is read too.
 */
function callLogLines(text: string): string[] {
  const start = text.indexOf('Call log:');
  const region = start === -1 ? text : text.slice(start + 'Call log:'.length);
  const lines: string[] = [];
  for (const line of region.split('\n')) {
    const bulleted = CALL_LOG_LINE_RE.exec(line);
    if (bulleted) {
      lines.push(bulleted[2]!.trim());
      continue;
    }
    const retry = RETRY_COUNT_LINE_RE.exec(line);
    if (retry) lines.push(retry[1]!.trim());
  }
  return lines;
}

function readCallLog(text: string): CallLogRead {
  const lines = callLogLines(text);
  const read: CallLogRead = {
    state: 'unknown',
    count: null,
    lastLine: null,
    stateLine: null,
    url: null,
    timeoutMs: null,
    matcher: null,
  };
  if (lines.length === 0) return read;
  read.lastLine = lines[lines.length - 1]!;

  let sawWaiting = false;
  let waitingLine: string | null = null;
  for (const line of lines) {
    const before = read.state;
    const lower = line.toLowerCase();
    const count = /^locator resolved to (\d+) elements?/.exec(line);
    const expectLine = /^Expect "(\w+)" with timeout (\d+)ms/.exec(line);
    const navTo = /navigat(?:ing|ion|ed) to "([^"]+)"/.exec(line);
    if (expectLine) {
      read.matcher = expectLine[1]!;
      read.timeoutMs = Number(expectLine[2]);
      continue;
    }
    if (navTo) {
      read.url ??= navTo[1]!;
      read.state = 'navigating';
      continue;
    }
    if (/^waiting for (?:navigation|page to navigate)/.test(line)) {
      read.state = 'navigating';
      continue;
    }
    if (line.startsWith('waiting for ') && SELECTOR_FN_RE.test(line)) {
      sawWaiting = true;
      waitingLine ??= line;
      continue;
    }
    if (count) {
      read.state = 'resolved-count';
      read.count = Number(count[1]);
      continue;
    }
    if (line.startsWith('locator resolved to hidden <') || line.startsWith('unexpected value "hidden"')) {
      read.state = 'hidden';
      continue;
    }
    if (/^locator resolved to (?:visible )?</.test(line)) {
      read.state = 'resolved';
      continue;
    }
    if (lower.startsWith('element is not visible')) read.state = 'not-visible';
    else if (lower.startsWith('element is not enabled')) read.state = 'not-enabled';
    else if (lower.startsWith('element is not editable')) read.state = 'not-editable';
    else if (lower.startsWith('element is not stable')) read.state = 'not-stable';
    else if (lower.startsWith('element is outside of the viewport')) read.state = 'outside-viewport';
    else if (lower.startsWith('element is not attached') || lower.includes('element was detached'))
      read.state = 'detached';
    else if (lower.includes('intercepts pointer events')) read.state = 'intercepts-pointer';
    else if (lower.startsWith('element is visible, enabled and stable')) read.state = 'resolved';
    else if (
      /^(?:attempting|performing) \w+ action/.test(lower) &&
      (read.state === 'unknown' || read.state === 'not-found')
    )
      read.state = 'resolved';
    if (read.state !== before || /^(?:locator resolved to|unexpected value|element is)/.test(lower)) {
      read.stateLine = line;
    }
  }
  if (read.state === 'unknown' && sawWaiting) {
    read.state = 'not-found';
    read.stateLine = waitingLine;
  }
  return read;
}

/** The value of a `Label:` header line (`Expected:`, `Received string:`, …), single-line only. */
function headerValue(text: string, label: 'Expected' | 'Received'): string | null {
  const re = new RegExp(`^[ \\t]*${label}(?: string| pattern| substring| value)?:[ \\t]*(.*)$`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  const value = m[1]!.trim();
  return value.length > 0 ? value : null;
}

/** The locator a web-first assertion's `Locator:` header line names, trimmed; null without one. */
export function readLocatorHeader(text: string): string | null {
  const header = /^[ \t]*Locator:[ \t]*(.+)$/m.exec(text);
  return header ? header[1]!.trim() : null;
}

/** The locator named by the error: the `Locator:` header first, else the first call in the text. */
function readLocator(text: string, strict: RegExpExecArray | null): string | null {
  const header = readLocatorHeader(text);
  if (header) return header;
  if (strict) return strict[1]!.trim();
  return extractLocatorChain(text);
}

function readTimeout(text: string, callLog: CallLogRead): number | null {
  const patterns = [
    /^[ \t]*Timeout:[ \t]*(\d+)ms/m,
    /\bTimeout (\d+)ms exceeded/,
    TEST_TIMEOUT_RE,
    TIMED_OUT_EXPECT_RE,
    /\bTimed out (\d+)ms/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return Number(m[1]);
  }
  return callLog.timeoutMs;
}

function readUrl(text: string, callLog: CallLogRead, received: string | null): string | null {
  if (callLog.url) return callLog.url;
  const at = /\b(?:net::ERR_[A-Z0-9_]+|NS_ERROR_[A-Z0-9_]+) at (\S+)/.exec(text);
  if (at) return at[1]!;
  const head = extractMessageHead(text);
  const inHead = URL_RE.exec(head.replace(/^[ \t]*Received.*$/gm, ''));
  if (inHead) return inHead[0];
  if (received) {
    const inReceived = URL_RE.exec(received);
    if (inReceived) return inReceived[0];
  }
  return null;
}

/** Context that backs the parse when the error text alone is thin. */
export interface ParseErrorContext {
  /**
   * The failing step's curated params (Playwright's rendered `locator`, a
   * navigation `url`). Read only where the error text names none — a custom
   * `expect.extend` matcher or a `test.step` failure carries no Playwright
   * locator in its message, but the step still recorded one.
   */
  stepParams?: Record<string, string | number | boolean> | null;
}

/** A line Playwright itself writes at the top of an assertion error. */
const MATCHER_LINE_RE = /^(?:expect[.(]|Timed out\b|Expected\b|Received\b|Locator\b)/;

/**
 * The custom message of `expect(value, 'message')`: Playwright prints it as the
 * error's first line, above its own `expect(…)` matcher line. Null when the
 * first line is Playwright's own.
 */
function readCustomMessage(messageHead: string): string | null {
  const lines = messageHead
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const first = lines[0]!.replace(/^Error:\s*/, '');
  if (!first || MATCHER_LINE_RE.test(first)) return null;
  return /^(?:expect[.(]|Timed out\b)/.test(lines[1]!) ? first : null;
}

/**
 * How much of an error text the parse reads. A Playwright error's facts (its
 * message, locator, call log and first frames) sit at its start.
 */
const MAX_PARSED_ERROR_CHARS = 64 * 1024;

/**
 * Parse a raw Playwright error (ANSI codes allowed) into its structured facts,
 * from its first {@link MAX_PARSED_ERROR_CHARS} characters.
 * Never throws; empty input yields an `unknown` record.
 *
 * The optional `context` supplies the failing step's params: its `locator` and
 * `url` back the parsed fields only when the error text itself names none, so
 * text parsing stays the primary source and the params are the fallback.
 */
export function parsePlaywrightError(
  raw: string | null | undefined,
  context?: ParseErrorContext,
): ParsedPlaywrightError {
  const clean = stripAnsi((raw ?? '').slice(0, MAX_PARSED_ERROR_CHARS)).replace(/\r\n?/g, '\n');
  const text = withoutStackFrames(clean);
  const messageHead = extractMessageHead(clean);
  const firstLine = messageHead.split('\n')[0] ?? '';

  const errorName = ERROR_NAME_RE.exec(firstLine)?.[1] ?? null;
  const strict = STRICT_RE.exec(text);
  const call = CALL_RE.exec(text);
  const callLog = readCallLog(text);
  const testTimeout = TEST_TIMEOUT_RE.exec(text);

  let subject: string | null = null;
  let action: string | null = null;
  let assertion: string | null = null;
  let negated = false;

  if (call) {
    subject = call[1]!;
    if (subject === 'expect') assertion = call[2]!;
    else action = call[2]!;
  }
  const matcher = MATCHER_RE.exec(text);
  const matcherShort = MATCHER_SHORT_RE.exec(text);
  if (matcher) {
    assertion = matcher[2]!;
    negated = Boolean(matcher[1]);
  } else if (!assertion && matcherShort) {
    assertion = matcherShort[1]!;
  } else if (!assertion && callLog.matcher) {
    assertion = callLog.matcher;
  }
  if (/\bexpect\((?:[^()]|\([^()]*\))*\)\.not\./.test(text)) negated = true;

  const isAssertion =
    assertion !== null || /\bexpect\(|\bexpect\.|Expected (?:string|substring|pattern|value)/.test(text);
  const isNavigationFailure = NAVIGATION_RE.test(text);
  const networkErrorCode = NETWORK_CODE_RE.exec(text)?.[1] ?? null;

  let kind: ParsedErrorKind;
  if (strict) kind = 'strict-mode';
  else if (testTimeout) kind = 'test-timeout';
  else if (CRASH_RE.test(text)) kind = 'crash';
  else if (isAssertion) {
    const retrying =
      /^[ \t]*Timeout:[ \t]*\d+ms/m.test(text) || TIMED_OUT_EXPECT_RE.test(text) || callLog.matcher !== null;
    kind = retrying ? 'assertion-timeout' : 'assertion';
  } else if (isNavigationFailure) kind = 'navigation';
  else if (/\bTimeout \d+ms exceeded/.test(text) || errorName === 'TimeoutError') kind = 'action-timeout';
  else kind = 'unknown';

  // The failing step's rendered locator / URL back the parse where the error
  // text names none (custom matchers, test.step failures); the text wins when
  // it carries its own.
  const paramsLocator = typeof context?.stepParams?.locator === 'string' ? context.stepParams.locator : null;
  const paramsUrl = typeof context?.stepParams?.url === 'string' ? context.stepParams.url : null;

  const locator = readLocator(text, strict) ?? paramsLocator;
  const leafLocator = locator ? extractLeafSelector(locator) : null;
  const expected = headerValue(text, 'Expected');
  const received = headerValue(text, 'Received');
  const timeoutMs = readTimeout(text, callLog);
  const url = readUrl(text, callLog, received) ?? paramsUrl;
  const frame = extractTopFrame(clean);

  const resolvedCount = strict ? Number(strict[2]) : callLog.count;
  const lastState: CallLogState = strict ? 'resolved-count' : callLog.state;
  const isLocatorResolutionFailure =
    kind === 'strict-mode' ||
    (locator !== null && (lastState === 'not-found' || (lastState === 'resolved-count' && resolvedCount === 0)));

  return {
    kind,
    errorName,
    subject,
    action,
    assertion,
    negated,
    locator,
    leafLocator,
    expected,
    received,
    timeoutMs,
    url,
    networkErrorCode,
    timeoutPhase: testTimeout ? (testTimeout[2] ?? testTimeout[3] ?? null) : null,
    lastState,
    resolvedCount,
    lastCallLogLine: callLog.lastLine,
    lastStateLine: callLog.stateLine,
    messageHead,
    customMessage: isAssertion ? readCustomMessage(messageHead) : null,
    topFrame: frame ? `${frame.file}:${frame.line}` : null,
    isNavigationFailure,
    isLocatorResolutionFailure,
  };
}
