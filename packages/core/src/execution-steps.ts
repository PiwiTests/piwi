/**
 * A test execution as a bug report: the steps Playwright reported for a run of
 * the test, read back into a steps document that Piwi Picker's Replay plays
 * and the converter writes as a spec, with the failure as the report's
 * expected result.
 *
 * The stored steps say which call ran, on which locator, from which line, and
 * the value typed into a field; they never say what a passing assertion
 * expected. So the steps that lead to the failure become steps (a goto, a
 * click, a fill, a check of a state), the failing assertion becomes the
 * `assert` step with the expected and received values of its error, and what
 * cannot be played either goes to a person as a `manual` step (anything done
 * on the page) or into the report's notes (requests, scripts, mocks and checks
 * on values). Setup runs before the body and counts; teardown and everything
 * after the failure do not.
 */
import {
  BUG_EVIDENCE_LIMITS,
  BUG_REPORT_VERSION,
  describeManualInstruction,
  emptyBugEvidence,
  reportedRequestUrl,
  type BugConsoleEntry,
  type BugFailedRequest,
  type BugReport,
  type BugReportNote,
} from './bug-report';
import { safeLocator } from './codegen';
import { parsePlaywrightError, stripAnsi } from './error-parse';
import { LOCATING_METHODS, locatorCallValues, type LocatorCall, type LocatorChain } from './locator-chain';
import type {
  ManualCheckValues,
  ManualInstruction,
  RecordedLocatorAlternative,
  RecordedStep,
  RecordedTarget,
  StepAssertion,
} from './recording';
import { capStepValue, MAX_STEP_PARAM_VALUE_CHARS, stepLabel } from './step-analysis';
import { extractStepLocatorUse, findLocationRoot, stepLocations, stripLocationRoot } from './step-locators';
import { parseSteps, STEPS_LIMITS, stepsVersionFor, type PiwiSteps } from './steps';
import {
  failingStepIndex,
  isCaptureStep,
  isPhaseContainer,
  sameCodeLocation,
  stepFailureRoles,
  stepParents,
  stepPhases,
} from './step-tree';

/** The element a call site acted on in a run, as locator healing stored it. */
export interface ExecutionElementSnapshot {
  /** The call site, `file:line:col`, as the step's own location. */
  location: string;
  /** The locator call the test made there: its method and arguments. */
  used: { method: string; args: unknown[] } | null;
  tagName: string | null;
  /** The element's attributes, as stored (`type`, `role`, `data-testid`, …). */
  attributes: Record<string, unknown>;
  text: string | null;
  accessibleName: string | null;
  /** Other locators for the element, best first. */
  alternatives: Array<{ locator: string; method: string; score: number }>;
  /**
   * Taken in another run of the test, since the store keeps the latest per
   * call site: the element may have changed, so it only ever adds that a field
   * takes a secret, never what the element is.
   */
  otherRun?: boolean;
}

export interface ExecutionReportInput {
  executionId?: number | null;
  /** The test's title, the report's title. */
  title: string;
  /** The execution's stored step list. */
  steps: unknown;
  /** The execution's error text, which names the step that failed. */
  error: string | null;
  /** The test's file, relative to the project, to write step locations relative to it. */
  testFilePath?: string | null;
  /** A page of the site the test ran on (the page it ended on), for a test whose navigations name no origin. */
  origin?: string | null;
  snapshots?: readonly ExecutionElementSnapshot[];
  console?: ReadonlyArray<{ level: 'error' | 'warn'; message: string; time?: number | null }>;
  requests?: ReadonlyArray<{ method: string; url: string; status: number; time?: number | null }>;
  viewport?: { width: number; height: number } | null;
  /** The browser the test ran in, such as `chromium`. */
  browser?: string | null;
  /** When the execution started, in milliseconds since 1970. */
  time?: number | null;
  /** Whether the archive holds the screenshot taken as the test failed, as `screenshots/1-finish.png`. */
  screenshot?: boolean;
}

export interface ExecutionReportResult {
  report: BugReport;
  /** How many of the report's steps a person does by hand. */
  manualSteps: number;
}

/** The file a report made from a run holds the failure screenshot as. */
export const EXECUTION_SCREENSHOT_FILE = 'screenshots/1-finish.png';

/** The fields of a stored step this module reads. */
interface StoredStep {
  title?: unknown;
  category?: unknown;
  subtitle?: unknown;
  params?: unknown;
  location?: unknown;
  error?: { message?: unknown; location?: unknown } | string | null;
  failed?: boolean | null;
  recovered?: boolean | null;
  depth?: unknown;
  startTime?: unknown;
  duration?: unknown;
}

/** What one stored step becomes. */
type Converted =
  | { kind: 'step'; step: Omit<RecordedStep, 'pageUrl' | 'timestamp'> }
  | { kind: 'manual'; instruction: ManualInstruction }
  | { kind: 'note'; reason: string }
  | { kind: 'drop' };

const KEEPS_PAGE: ReadonlySet<string> = new Set(['fill', 'hover', 'assert']);

/** Markers `maskTokenLike` puts in place of a token: the value around one is not the value typed. */
const MASKED_RE = /data:\[masked\]|\[masked-(?:token|hex)\]/;

/** A field whose value is a secret: by the label, test id or text it is found by. */
const SECRET_FIELD_RE = /pass(?:word|code|phrase)|passwd|pwd|secret|\bpin\b|\botp\b|one-time code/i;

/** Matchers whose expected value a failing step's error carries. */
const VALUE_EXPECTATIONS: ReadonlySet<string> = new Set([
  'toHaveText',
  'toContainText',
  'toHaveValue',
  'toHaveAccessibleName',
  'toHaveCount',
  'toHaveURL',
]);

/** Matchers that check a state, and the option that turns each around (`toBeChecked({ checked: false })`). */
const STATE_EXPECTATIONS: Readonly<Record<string, string>> = {
  toBeVisible: 'visible',
  toBeHidden: '',
  toBeEnabled: 'enabled',
  toBeDisabled: '',
  toBeChecked: 'checked',
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function paramsOf(step: StoredStep): Record<string, unknown> {
  return isRecord(step.params) ? step.params : {};
}

function errorText(step: StoredStep): string {
  const error = step.error;
  return typeof error === 'string' ? error : str(error?.message);
}

/** A value read back whole: not cut at the stored cap and not masked. */
function isWhole(value: string, capped: boolean): boolean {
  if (MASKED_RE.test(value)) return false;
  return !capped || !(value.endsWith('…') || value.length >= MAX_STEP_PARAM_VALUE_CHARS);
}

/** The text between a title's `Verb "` and the quote that closes it, before the chain a 1.61 title ends with. */
function quotedTitleValue(step: StoredStep, prefix: string): string | null {
  const title = str(step.title);
  if (!title.startsWith(prefix)) return null;
  const params = paramsOf(step);
  // From 1.63 the chain is in the params or the subtitle, and the title ends with the value's quote.
  if (typeof params.locator === 'string' || str(step.subtitle)) {
    return title.endsWith('"') && title.length > prefix.length ? title.slice(prefix.length, -1) : null;
  }
  // On 1.61 and 1.62 the chain follows the value: the earliest `" ` after which the rest is a whole chain.
  for (let at = title.indexOf('" ', prefix.length); at >= 0; at = title.indexOf('" ', at + 1)) {
    if (safeLocator(title.slice(at + 2))) return title.slice(prefix.length, at);
  }
  return title.endsWith('"') ? title.slice(prefix.length, -1) : null;
}

/** The value a fill, a type or a key press used: the params' first, then the title's; whether it is whole. */
function typedValue(step: StoredStep, prefix: string, param = 'value'): { value: string; whole: boolean } | null {
  const fromParams = paramsOf(step)[param];
  if (typeof fromParams === 'string') return { value: fromParams, whole: isWhole(fromParams, true) };
  const fromTitle = quotedTitleValue(step, prefix);
  return fromTitle == null ? null : { value: fromTitle, whole: isWhole(fromTitle, false) };
}

/**
 * The options a select chose, read from the `options` param Playwright renders (`[{ valueOrLabel }]`, `[{ value }]`,
 * `[{ label }]` or `[{ index }]`) and the store keeps as JSON: each option's value or label, else its index. Null when
 * the run does not keep them whole.
 */
function chosenOptions(step: StoredStep): Array<string | number> | null {
  const raw = paramsOf(step).options;
  let options: unknown = raw;
  if (typeof raw === 'string') {
    if (MASKED_RE.test(raw)) return null;
    try {
      options = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(options) || options.length === 0) return null;
  const chosen: Array<string | number> = [];
  for (const option of options) {
    if (!isRecord(option)) return null;
    const text = option.valueOrLabel ?? option.value ?? option.label;
    if (typeof text === 'string') chosen.push(text);
    else if (typeof option.index === 'number') chosen.push(option.index);
    else return null;
  }
  return chosen;
}

/** A step's call as a report names it: never with the value it typed. */
function callOf(step: StoredStep, locator: string | null): string {
  const title = str(step.title);
  const verb = /^(Fill|Type|Press|Insert text) "/.exec(title)?.[1];
  const call = verb ? `${verb}${locator ? ` ${locator}` : ''}` : stepLabel(step);
  return capStepValue(call, BUG_EVIDENCE_LIMITS.messageLength);
}

/** The last locating call of a chain. */
function leafCall(chain: LocatorChain): LocatorCall | null {
  for (let i = chain.calls.length - 1; i >= 0; i--) {
    if (LOCATING_METHODS.has(chain.calls[i]!.method)) return chain.calls[i]!;
  }
  return null;
}

/** The snapshot of the element a step acted on: the one taken at its call site, by the same locator call. */
function snapshotFor(
  step: StoredStep,
  leaf: LocatorCall | null,
  snapshots: readonly ExecutionElementSnapshot[],
): ExecutionElementSnapshot | null {
  const location = str(step.location);
  if (!location || !leaf) return null;
  const first = locatorCallValues(leaf)[0];
  return (
    snapshots.find(
      (s) =>
        sameCodeLocation(s.location, location) &&
        (!s.used || (s.used.method === leaf.method && JSON.stringify(s.used.args[0]) === JSON.stringify(first))),
    ) ?? null
  );
}

/** A snapshot that describes the element as this run saw it; null for one taken in another run. */
function seenInRun(snapshot: ExecutionElementSnapshot | null): ExecutionElementSnapshot | null {
  return snapshot && !snapshot.otherRun ? snapshot : null;
}

function attribute(snapshot: ExecutionElementSnapshot | null, name: string): string | null {
  const value = snapshot?.attributes[name];
  return typeof value === 'string' && value ? value : null;
}

/**
 * The element a step acted on: what its locator says about it (role, name,
 * test id, text), what the run saw of it when a snapshot was taken there, and
 * the locators to find it by, the test's own first.
 */
function targetFor(locator: string, chain: LocatorChain, snapshot: ExecutionElementSnapshot | null): RecordedTarget {
  const leaf = leafCall(chain);
  const values = leaf ? locatorCallValues(leaf) : [];
  const text = typeof values[0] === 'string' ? (values[0] as string) : null;
  const options = isRecord(values[1]) ? values[1] : {};
  const name = typeof options.name === 'string' ? options.name : null;
  const alternatives: RecordedLocatorAlternative[] = [];
  const add = (locator: string, score: number) => {
    const safe = safeLocator(locator);
    // A locator too long for a steps document is left out rather than cut: a cut chain finds another element.
    if (!safe || safe.text.length > STEPS_LIMITS.textLength || alternatives.some((a) => a.locator === safe.text))
      return;
    if (alternatives.length >= STEPS_LIMITS.alternatives) return;
    alternatives.push({ locator: safe.text, method: safe.chain.calls[safe.chain.calls.length - 1]!.method, score });
  };
  add(locator, 100);
  for (const alternative of snapshot?.alternatives ?? []) add(alternative.locator, alternative.score);
  const snapshotText = snapshot?.text?.replace(/\s+/g, ' ').trim().slice(0, 120) || null;
  const cap = (value: string | null) => (value == null ? null : value.slice(0, STEPS_LIMITS.textLength));
  return {
    tagName: (snapshot?.tagName ?? '').toLowerCase().slice(0, 64),
    role: (attribute(snapshot, 'role') ?? (leaf?.method === 'getByRole' ? text : null))?.slice(0, 64) ?? null,
    accessibleName: cap(
      snapshot?.accessibleName ||
        name ||
        (leaf && ['getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle'].includes(leaf.method) ? text : null),
    ),
    testId: cap(attribute(snapshot, 'data-testid') ?? (leaf?.method === 'getByTestId' ? text : null)),
    text: cap(snapshotText ?? (leaf?.method === 'getByText' ? text : null)),
    alternatives,
  };
}

/** Whether a field takes a secret: its type, its autocomplete, or the words it is found by. */
function isSecretField(target: RecordedTarget, snapshot: ExecutionElementSnapshot | null, locator: string): boolean {
  if (attribute(snapshot, 'type')?.toLowerCase() === 'password') return true;
  if (/(?:current|new)-password|one-time-code/i.test(attribute(snapshot, 'autocomplete') ?? '')) return true;
  return [target.accessibleName, target.testId, target.text, locator].some((s) => !!s && SECRET_FIELD_RE.test(s));
}

/** A value as an error prints it, unquoted; null for a pattern, a list or an object. */
function plainValue(raw: string | null): string | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'string' ? value : null;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (/^\/.*\/[a-z]*$/.test(text) || text.startsWith('[') || text.startsWith('{')) return null;
  return text;
}

/** The matcher an `Expect "…"` title names, whether it is negated, and whether it polls or retries a block. */
function readExpect(title: string): { matcher: string; negated: boolean; polls: boolean } | null {
  const m = /^Expect "([^"]+)"/.exec(title);
  if (!m) return null;
  const words = m[1]!.replace(/\(.*\)$/, '').split(/\s+/);
  const matcher = words[words.length - 1]!;
  return { matcher, negated: words.includes('not'), polls: words.includes('poll') || matcher === 'toPass' };
}

/** The options a matcher was called with, as the step's params keep them (`{"timeout":500,"checked":false}`). */
function matcherOptions(step: StoredStep): Record<string, unknown> {
  const raw = paramsOf(step).expected;
  if (typeof raw !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

interface ConvertContext {
  origin: string | null;
  snapshots: readonly ExecutionElementSnapshot[];
  executionError: string | null;
}

/** A URL as a steps document keeps it: a path when it is on the origin. */
function pathOnOrigin(url: string, origin: string | null): string {
  if (!origin) return url;
  try {
    const parsed = new URL(url);
    return parsed.origin === origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : url;
  } catch {
    return url;
  }
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** The URL a navigation step opened: its params, its subtitle, or the `Navigate to "…"` title. */
function navigationUrl(step: StoredStep): string | null {
  const params = paramsOf(step);
  if (typeof params.url === 'string' && params.url) return params.url;
  const subtitle = str(step.subtitle).trim();
  if (subtitle) return subtitle;
  return /^(?:Navigate to|page\.goto\() ?"([^"]+)"/.exec(str(step.title))?.[1] ?? null;
}

const BROWSER_MOVES: ReadonlyArray<[RegExp, 'goBack' | 'goForward' | 'reload']> = [
  [/^(?:go back|page\.goback)/i, 'goBack'],
  [/^(?:go forward|page\.goforward)/i, 'goForward'],
  [/^(?:reload|page\.reload)/i, 'reload'],
];

/** A step a person does by hand. */
const manual = (instruction: ManualInstruction): Converted => ({ kind: 'manual', instruction });

/** Calls of the test that act on no page, and why a report leaves them out. */
const OTHER_CALLS: ReadonlyArray<[RegExp, string | null]> = [
  [/^(?:take )?screenshot|^aria snapshot/i, null],
  [/^set content|^page\.setcontent/i, 'manual'],
  [/^evaluate|^page\.evaluate|^locator\.evaluate/i, 'Runs a script of the test in the page; Replay runs none.'],
  [/route|unroute/i, 'Changes how requests are answered (a mock); Replay leaves requests alone.'],
  [/init script/i, 'Adds a script of the test to every page; Replay adds none.'],
  [/storage state|cookies|local storage/i, 'Sets what the browser stores (a login, cookies); do it before replaying.'],
  [
    /permissions|geolocation|extra http headers|offline|emulate/i,
    'Changes the browser’s settings; Replay keeps yours.',
  ],
];

/** A goto, a click, a fill, a check: what one stored step of the test becomes. */
function convertStep(step: StoredStep, index: number, failing: boolean, ctx: ConvertContext): Converted {
  const title = str(step.title);
  const category = str(step.category);
  const use = extractStepLocatorUse(step, index);

  if (category === 'navigation') {
    for (const [re, kind] of BROWSER_MOVES) if (re.test(title)) return manual({ kind });
    const url = navigationUrl(step);
    if (!url) return manual({ kind: 'gotoUnknown' });
    const value = pathOnOrigin(url, ctx.origin).slice(0, STEPS_LIMITS.valueLength);
    return { kind: 'step', step: { action: 'goto', target: null, value, redacted: false } };
  }
  if (category === 'api') return { kind: 'note', reason: 'An API request the test sends itself; Replay sends none.' };
  if (category === 'wait') return { kind: 'drop' };
  if (category === 'assertion') return convertAssertion(step, index, failing, ctx, use?.chain ?? null);

  if (!use) {
    if (category === 'action' || category === 'input') return convertPageInput(step);
    if (!str(step.location)) return { kind: 'drop' };
    for (const [re, reason] of OTHER_CALLS) {
      if (!re.test(title)) continue;
      if (reason === null) return { kind: 'drop' };
      if (reason === 'manual') return manual({ kind: 'setContent' });
      return { kind: 'note', reason };
    }
    return { kind: 'note', reason: 'A Playwright call Replay does not perform.' };
  }
  // A bare `Fill`, `Type` or `Press` title carries its value in the params only.
  const bare = /^(Fill|Type|Press)$/.exec(title)?.[1];
  const action = use.action === 'other' && bare ? bare.toLowerCase() : use.action;
  return convertLocatorAction(step, action, use.chain, use.locator, ctx);
}

/** A key press or typing with no element: the keyboard's, and the mouse's raw moves. */
function convertPageInput(step: StoredStep): Converted {
  const title = str(step.title);
  if (title.startsWith('Press "')) {
    const key = typedValue(step, 'Press "', 'key');
    if (key?.whole && key.value) {
      return { kind: 'step', step: { action: 'press', target: null, value: key.value, redacted: false } };
    }
  }
  if (/^(?:Type|Insert text) "/.test(title)) {
    return manual({ kind: 'keyboardType' });
  }
  const params = paramsOf(step);
  if (typeof params.x === 'number' && typeof params.y === 'number') {
    return manual({
      kind: 'mouseAt',
      x: Math.round(params.x),
      y: Math.round(params.y),
      call: capStepValue(title, 100),
    });
  }
  return manual({ kind: 'mouseOrKeyboard', call: capStepValue(title, 100) });
}

/** An action on an element: played when the run kept what it needs, else handed to a person. */
function convertLocatorAction(
  step: StoredStep,
  action: string,
  chain: LocatorChain,
  locator: string,
  ctx: ConvertContext,
): Converted {
  const snapshot = snapshotFor(step, leafCall(chain), ctx.snapshots);
  const target = targetWith(locator, seenInRun(snapshot));
  const call = capStepValue(str(step.title), 100);
  if (!target) return manual({ kind: 'locatorCall', locator, call });
  const act = (action: RecordedStep['action'], value: string | null = null): Converted => ({
    kind: 'step',
    step: { action, target, value, redacted: false },
  });
  switch (action) {
    case 'click':
    case 'tap':
      return act('click');
    case 'dblclick':
      return act('dblclick');
    case 'hover':
      return act('hover');
    case 'check':
      return act('check');
    case 'uncheck':
      return act('uncheck');
    case 'fill':
    case 'type': {
      if (isSecretField(target, snapshot, locator)) {
        return { kind: 'step', step: { action: 'fill', target, value: null, redacted: true } };
      }
      const typed = typedValue(step, action === 'fill' ? 'Fill "' : 'Type "');
      if (!typed) return manual({ kind: 'fillUnknown', locator });
      if (!typed.whole) return manual({ kind: 'fillPartial', locator });
      return act('fill', typed.value.slice(0, STEPS_LIMITS.valueLength));
    }
    case 'press': {
      const key = typedValue(step, 'Press "', 'key');
      if (!key?.whole || !key.value) return manual({ kind: 'pressUnknown', locator });
      return act('press', key.value);
    }
    case 'selectOption': {
      const options = chosenOptions(step);
      if (!options) return manual({ kind: 'selectOptionUnknown', locator });
      const [only] = options;
      if (options.length === 1 && typeof only === 'string') {
        return act('selectOption', only.slice(0, STEPS_LIMITS.valueLength));
      }
      const named = options
        .slice(0, STEPS_LIMITS.options)
        .map((o) => (typeof o === 'number' ? o : capStepValue(o, 100)));
      return manual({ kind: 'selectOptions', locator, options: named });
    }
    case 'setInputFiles':
    case 'dragTo':
    case 'drop':
    case 'focus':
    case 'blur':
    case 'dispatchEvent':
    case 'scrollIntoViewIfNeeded':
      return manual({ kind: action, locator });
    case 'waitFor':
    case 'count':
      return { kind: 'drop' };
    case 'evaluate':
      return { kind: 'note', reason: 'Runs a script of the test on an element; Replay runs none.' };
    default:
      return manual({ kind: 'locatorCall', locator, call });
  }
}

/** An assertion: a check Replay makes, the failing one with its expected value, or a hand-over or a note. */
function convertAssertion(
  step: StoredStep,
  index: number,
  failing: boolean,
  ctx: ConvertContext,
  chain: LocatorChain | null,
): Converted {
  const title = str(step.title);
  const head = readExpect(title);
  const failed = failing || !!errorText(step);
  const message = errorText(step) || (failing ? (ctx.executionError ?? '') : '');
  const parsed = failed
    ? parsePlaywrightError(message, { stepParams: paramsOf(step) as Record<string, string> })
    : null;
  const matcher = head?.matcher ?? parsed?.assertion ?? null;
  const negated = head ? head.negated : (parsed?.negated ?? false);
  const locator = chain ? (extractStepLocatorUse(step, index)?.locator ?? null) : null;
  const values = inRun(parsed?.expected ?? null, parsed?.received ?? null);

  if (head?.polls) {
    if (!failed) return { kind: 'note', reason: 'A check the test retried until it held; Replay does not run it.' };
    return manual({ kind: 'expectPoll', matcher: head.matcher, ...values });
  }
  if (!matcher || !locator) {
    if (matcher === 'toHaveURL') return convertUrlAssertion(negated, failed, parsed, ctx);
    if (!failed && locator) return { kind: 'note', reason: 'A check that passed; the run does not name its matcher.' };
    if (!failed) return { kind: 'note', reason: 'A check on a value, not on the page.' };
    const what = parsed?.customMessage ?? (matcher ? `${matcher}` : title);
    return manual({ kind: 'expectValue', what: capStepValue(what, 200), ...values });
  }
  const snapshot = seenInRun(snapshotFor(step, chain ? leafCall(chain) : null, ctx.snapshots));
  const target = targetWith(locator, snapshot);
  if (!target) return failed ? manual({ kind: 'expectLocator', locator, matcher, ...values }) : { kind: 'drop' };

  if (matcher in STATE_EXPECTATIONS) {
    const option = STATE_EXPECTATIONS[matcher]!;
    const turned = option !== '' && matcherOptions(step)[option] === false;
    const assertion: StepAssertion = {
      matcher: matcher as StepAssertion['matcher'],
      expected: null,
      actual: failed ? (plainValue(parsed?.received ?? null)?.slice(0, STEPS_LIMITS.valueLength) ?? null) : null,
      negated: turned ? !negated : negated,
      note: null,
    };
    return { kind: 'step', step: { action: 'assert', target, value: null, redacted: false, assertion } };
  }
  if (VALUE_EXPECTATIONS.has(matcher)) {
    if (!failed)
      return { kind: 'note', reason: `A check that passed (${matcher}); the run does not keep the value it expected.` };
    const expected = plainValue(parsed?.expected ?? null);
    if (expected == null || (matcher === 'toHaveCount' && !/^\d{1,6}$/.test(expected))) {
      return manual({ kind: 'expectLocator', locator, matcher, ...values });
    }
    const assertion: StepAssertion = {
      matcher: matcher as StepAssertion['matcher'],
      expected: expected.slice(0, STEPS_LIMITS.valueLength),
      actual: plainValue(parsed?.received ?? null)?.slice(0, STEPS_LIMITS.valueLength) ?? null,
      negated,
      note: null,
    };
    return { kind: 'step', step: { action: 'assert', target, value: null, redacted: false, assertion } };
  }
  if (!failed) return { kind: 'note', reason: `A check that passed (${matcher}); Replay cannot make it.` };
  return manual({ kind: 'expectLocator', locator, matcher: `${negated ? 'not.' : ''}${matcher}`, ...values });
}

/** The page's address checked: its expected address from the error when it failed, else a note. */
function convertUrlAssertion(
  negated: boolean,
  failed: boolean,
  parsed: ReturnType<typeof parsePlaywrightError> | null,
  ctx: ConvertContext,
): Converted {
  if (!failed)
    return { kind: 'note', reason: 'A check that passed (toHaveURL); the run does not keep the address it expected.' };
  const expected = plainValue(parsed?.expected ?? null);
  if (!expected) return manual({ kind: 'expectURL', ...inRun(parsed?.expected ?? null, parsed?.received ?? null) });
  const received = plainValue(parsed?.received ?? null);
  const assertion: StepAssertion = {
    matcher: 'toHaveURL',
    expected: pathOnOrigin(expected, ctx.origin).slice(0, STEPS_LIMITS.valueLength),
    actual: received ? pathOnOrigin(received, ctx.origin).slice(0, STEPS_LIMITS.valueLength) : null,
    negated,
    note: null,
  };
  return { kind: 'step', step: { action: 'assert', target: null, value: null, redacted: false, assertion } };
}

/** What a check expected and received in the run, as its error says. */
function inRun(expected: string | null, received: string | null): ManualCheckValues {
  return {
    expected: expected ? capStepValue(stripAnsi(expected), 200) : null,
    received: received ? capStepValue(stripAnsi(received), 200) : null,
  };
}

/** The target of a step found by `locator`, with what the snapshot saw of the element; null when no locator for it fits a steps document. */
function targetWith(locator: string, snapshot: ExecutionElementSnapshot | null): RecordedTarget | null {
  const safe = safeLocator(locator);
  if (!safe) return null;
  const target = targetFor(safe.text, safe.chain, snapshot);
  return target.alternatives.length > 0 ? target : null;
}

/** A location as a report shows it: relative to the project, `file:line`. */
function shortLocation(location: unknown, root: string | null): string | null {
  const text = str(location);
  if (!text) return null;
  return stripLocationRoot(text, root)
    .replace(/:(\d+):\d+$/, ':$1')
    .slice(0, STEPS_LIMITS.textLength);
}

/**
 * The bug report of an execution: its steps up to the failure (setup
 * included, teardown left out), the failing step kept where it failed, every
 * call that cannot be played as a manual step or a note, and the evidence the
 * run kept. The steps document is checked with `parseSteps`, as any file is.
 */
export function bugReportFromExecution(input: ExecutionReportInput): ExecutionReportResult {
  const stored = (Array.isArray(input.steps) ? input.steps : []).filter(isRecord) as StoredStep[];
  const parents = stepParents(stored);
  const phases = stepPhases(stored, parents);
  const failing = failingStepIndex(stored, parents, input.error);
  const roles = stepFailureRoles(stored, input.error, parents, failing);
  const root = findLocationRoot(stepLocations(stored), input.testFilePath ?? null);
  const firstNavigation = stored.find((s) => str(s.category) === 'navigation' && originOf(navigationUrl(s)));
  // The first page the test opened names the site it ran on; the page it ended on may be another site's (a payment page).
  const origin = (firstNavigation ? originOf(navigationUrl(firstNavigation)) : null) ?? originOf(input.origin);
  const ctx: ConvertContext = { origin, snapshots: input.snapshots ?? [], executionError: input.error };
  const time = input.time ?? 0;

  const steps: RecordedStep[] = [];
  const notes: BugReportNote[] = [];
  let failedStep: number | null = null;
  /** The step each stored step became, by its index in the stored list. */
  const madeFrom = new Map<number, number>();
  let page = '';
  /** Steps whose own steps are taken with them. */
  const consumed = new Set<number>();
  const under = (i: number) => {
    for (let p = parents[i] ?? -1; p !== -1; p = parents[p] ?? -1) if (consumed.has(p)) return true;
    return false;
  };

  for (let i = 0; i < stored.length; i++) {
    if (failing !== null && i > failing) break;
    const step = stored[i]!;
    const category = str(step.category);
    if (phases[i] === 'teardown' || isCaptureStep(step) || isPhaseContainer(step) || under(i)) continue;
    if (category === 'hook' || category === 'fixture' || category === 'test.step' || category === 'attach') continue;
    consumed.add(i);
    const location = shortLocation(step.location, root);
    const call = callOf(step, extractStepLocatorUse(step, i)?.locator ?? null);
    if (roles[i] === 'recovered') {
      notes.push({ title: call, location, reason: 'Failed, and the test caught the error and went on.' });
      continue;
    }
    let converted = convertStep(step, i, i === failing, ctx);
    if (i === failing && (converted.kind === 'note' || converted.kind === 'drop')) {
      converted = manual({ kind: 'failedCall', call: capStepValue(call, 200) });
    }
    if (converted.kind === 'drop') continue;
    if (converted.kind === 'note') {
      notes.push({ title: call, location, reason: converted.reason });
      continue;
    }
    const recorded: RecordedStep =
      converted.kind === 'manual'
        ? {
            action: 'manual',
            target: null,
            value: null,
            redacted: false,
            pageUrl: page,
            timestamp: 0,
            manual: {
              description: capStepValue(describeManualInstruction(converted.instruction), STEPS_LIMITS.valueLength),
              location,
              call,
              instruction: converted.instruction,
            },
          }
        : { ...converted.step, pageUrl: page, timestamp: 0 };
    if (recorded.action === 'goto') recorded.pageUrl = recorded.value ?? '';
    const startedAt = typeof step.startTime === 'number' ? step.startTime : null;
    recorded.timestamp = startedAt ?? time;
    if (i === failing) failedStep = steps.length;
    madeFrom.set(i, steps.length);
    steps.push(recorded);
    if (recorded.action === 'goto') page = recorded.value ?? '';
    else if (!KEEPS_PAGE.has(recorded.action)) page = '';
  }

  // A failure inside a block taken whole (a `toPass` block, a poll) failed at the step the block became.
  for (
    let p = failing === null ? -1 : (parents[failing] ?? -1);
    failedStep === null && p !== -1;
    p = parents[p] ?? -1
  ) {
    failedStep = madeFrom.get(p) ?? null;
  }

  // A steps document holds 200 steps: the ones that lead to the failure stay.
  let kept = steps;
  if (steps.length > STEPS_LIMITS.steps) {
    const left = steps.length - (STEPS_LIMITS.steps - 1);
    const instruction: ManualInstruction = { kind: 'leadingSteps', count: left, limit: STEPS_LIMITS.steps };
    kept = [
      {
        action: 'manual',
        target: null,
        value: null,
        redacted: false,
        pageUrl: '',
        timestamp: steps[0]!.timestamp,
        manual: { description: describeManualInstruction(instruction), location: null, call: null, instruction },
      },
      ...steps.slice(left),
    ];
    if (failedStep !== null) failedStep = failedStep >= left ? failedStep - left + 1 : null;
  }

  const doc: PiwiSteps = {
    v: stepsVersionFor(kept),
    title: input.title.slice(0, STEPS_LIMITS.textLength) || null,
    origin,
    recordedAt: time,
    note: null,
    steps: kept,
    ...(input.viewport && kept.length > 0
      ? { viewports: [{ step: 0, width: Math.round(input.viewport.width), height: Math.round(input.viewport.height) }] }
      : {}),
  };
  const parsed = parseSteps(doc);
  if (!parsed.ok) throw new Error(`The steps made from the execution do not check: ${parsed.errors.join('; ')}`);

  const evidence = emptyBugEvidence();
  const consoleEntries = (input.console ?? []).map((entry): BugConsoleEntry => ({
    level: entry.level,
    source: 'console',
    message: entry.message.slice(0, BUG_EVIDENCE_LIMITS.messageLength),
    page: '',
    time: entry.time ?? 0,
  }));
  evidence.console = consoleEntries.slice(0, BUG_EVIDENCE_LIMITS.console);
  evidence.consoleDropped = consoleEntries.length - evidence.console.length;
  const pageUrl = origin ? `${origin}/` : 'http://localhost/';
  const requests = (input.requests ?? [])
    .filter((r) => r.status === 0 || r.status >= 400)
    .map((r): BugFailedRequest => ({
      method: r.method.toUpperCase(),
      url: reportedRequestUrl(r.url, pageUrl),
      status: r.status,
      page: '',
      time: r.time ?? 0,
    }));
  evidence.requests = requests.slice(0, BUG_EVIDENCE_LIMITS.requests);
  evidence.requestsDropped = requests.length - evidence.requests.length;
  if (input.screenshot) {
    evidence.screenshots = [{ file: EXECUTION_SCREENSHOT_FILE, step: null, moment: 'finish', takenAt: time }];
  } else {
    evidence.screenshotNote = 'the run kept no screenshot of the failure';
  }

  const keptNotes = notes.slice(0, BUG_EVIDENCE_LIMITS.notes);
  const report: BugReport = {
    v: BUG_REPORT_VERSION,
    steps: parsed.steps,
    evidence,
    context: {
      origin,
      pageKey: null,
      path: null,
      browser: input.browser ?? null,
      userAgent: null,
      viewport: input.viewport ?? null,
      time,
      extensionVersion: null,
    },
    export: {
      source: 'execution',
      executionId: input.executionId ?? null,
      testTitle: input.title || null,
      failedStep,
      notes: keptNotes,
      notesDropped: notes.length - keptNotes.length,
    },
  };
  return { report, manualSteps: parsed.steps.steps.filter((s) => s.action === 'manual').length };
}
