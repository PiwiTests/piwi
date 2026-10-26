/**
 * The steps document: the portable form of a recording.
 *
 * A recording leaves the recorder as data, not code: Piwi Picker saves it, and
 * `renderSpec` turns it into a spec for whichever project renders it. URLs on
 * the recorded origin are stored as paths, which is what lets a flow recorded
 * on staging run against another server's `baseURL`.
 *
 * Anything that reads a document from outside (a file) goes through
 * `parseSteps`, which checks every field and every limit and re-renders every
 * locator from its parsed chain, so a document can only ever describe steps.
 */
import { safeLocator } from './codegen';
import {
  ASSERTION_MATCHERS,
  VALUE_MATCHERS,
  type AssertionMatcher,
  type ManualInstruction,
  type ManualInstructionKind,
  type RecordedLocatorAlternative,
  type RecordedSession,
  type RecordedStep,
  type RecordedTarget,
  type StepAction,
  type StepAssertion,
  type StepManual,
  type StepViewport,
} from './recording';

/**
 * The newest version this reads. Version 2 added the `manual` step and the
 * `toContainText`, `toHaveCount` and `toBeChecked` matchers; a document is
 * written with the oldest version that holds its steps, so a reader that only
 * knows version 1 refuses a file it cannot play with a message naming the
 * version, and opens every other one.
 */
const STEPS_VERSION = 2;

export type StepsVersion = 1 | typeof STEPS_VERSION;

/** Matchers a version 1 reader does not know. */
const VERSION_2_MATCHERS: ReadonlySet<string> = new Set(['toContainText', 'toHaveCount', 'toBeChecked']);

/** The oldest version that holds `steps`: 2 when one is a manual step or uses a matcher version 2 added, else 1. */
export function stepsVersionFor(steps: readonly RecordedStep[]): StepsVersion {
  return steps.some((s) => s.action === 'manual' || (!!s.assertion && VERSION_2_MATCHERS.has(s.assertion.matcher)))
    ? 2
    : 1;
}

/** What a steps document may hold. */
export const STEPS_LIMITS = {
  steps: 200,
  alternatives: 10,
  /** Typed values, expected values, URLs, notes. */
  valueLength: 2000,
  /** Titles, names, texts, locators. */
  textLength: 500,
  viewports: 50,
  /** The widest and tallest viewport, in CSS pixels. */
  viewportSize: 10_000,
  /** The browser's zoom factors a viewport may name, as browsers allow them. */
  zoom: { min: 0.25, max: 5 },
} as const;

export interface PiwiSteps {
  v: StepsVersion;
  title: string | null;
  /** The origin the steps were recorded on, such as `https://staging.acme.test`; null when there was none. */
  origin: string | null;
  recordedAt: number;
  note: string | null;
  /** The steps, with `pageUrl` and a `goto`'s value as paths whenever they are on `origin`. */
  steps: RecordedStep[];
  /** The viewport sizes the steps were recorded at, by the step each starts at; absent when none was recorded. */
  viewports?: StepViewport[];
}

const ACTIONS: ReadonlySet<StepAction> = new Set([
  'goto',
  'click',
  'dblclick',
  'hover',
  'fill',
  'check',
  'uncheck',
  'selectOption',
  'press',
  'setInputFiles',
  'dragTo',
  'assertVisible',
  'assert',
  'manual',
]);

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function toPath(url: string, origin: string | null): string {
  if (!origin) return url;
  try {
    const parsed = new URL(url);
    return parsed.origin === origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : url;
  } catch {
    return url;
  }
}

function toAbsolute(url: string, origin: string | null): string {
  return origin && url.startsWith('/') ? `${origin}${url}` : url;
}

/** A recording as a steps document. The recorder's per-page element keys and step views stay behind; they mean nothing outside it. */
export function toStepsDocument(
  session: RecordedSession,
  meta: { title?: string | null; note?: string | null } = {},
): PiwiSteps {
  const origin = originOf(session.startUrl) ?? originOf(session.steps[0]?.pageUrl ?? '');
  return {
    v: stepsVersionFor(session.steps),
    title: meta.title ?? null,
    origin,
    recordedAt: session.startedAt,
    note: meta.note ?? null,
    steps: session.steps.map(({ view: _view, ...step }) => ({
      ...step,
      target: step.target ? withoutElementKey(step.target) : null,
      ...(step.dropTarget ? { dropTarget: withoutElementKey(step.dropTarget) } : {}),
      pageUrl: toPath(step.pageUrl, origin),
      value: step.action === 'goto' && step.value ? toPath(step.value, origin) : step.value,
    })),
    ...(session.viewports?.length ? { viewports: session.viewports.map((v) => ({ ...v })) } : {}),
  };
}

function withoutElementKey(target: RecordedTarget): RecordedTarget {
  const { elementKey: _elementKey, ...rest } = target;
  return rest;
}

/** A steps document as a recording on `origin` (the recorded one by default), for `renderSpec` and the function matcher. */
export function sessionFromSteps(doc: PiwiSteps, origin: string | null = doc.origin): RecordedSession {
  const steps = doc.steps.map((step) => ({
    ...step,
    pageUrl: toAbsolute(step.pageUrl, origin),
    value: step.action === 'goto' && step.value ? toAbsolute(step.value, origin) : step.value,
  }));
  const firstGoto = steps.find((s) => s.action === 'goto');
  return {
    steps,
    startedAt: doc.recordedAt,
    startUrl: firstGoto?.value ?? steps[0]?.pageUrl ?? origin ?? '',
    ...(doc.viewports?.length ? { viewports: doc.viewports } : {}),
  };
}

export type ParseStepsResult = { ok: true; steps: PiwiSteps } | { ok: false; errors: string[] };

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Checker {
  readonly errors: string[] = [];

  fail(path: string, message: string): void {
    if (this.errors.length < 20) this.errors.push(`${path}: ${message}`);
  }

  text(v: unknown, path: string, max: number, nullable: boolean): string | null {
    if (v == null) {
      if (!nullable) this.fail(path, 'is required');
      return null;
    }
    if (typeof v !== 'string') {
      this.fail(path, 'must be a string');
      return null;
    }
    if (v.length > max) this.fail(path, `is longer than ${max} characters`);
    return v;
  }

  number(v: unknown, path: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.fail(path, 'must be a number');
      return 0;
    }
    return v;
  }
}

function checkTarget(c: Checker, v: unknown, path: string): RecordedTarget | null {
  if (v == null) return null;
  if (!isObject(v)) {
    c.fail(path, 'must be an object');
    return null;
  }
  const alternativesIn = v.alternatives ?? [];
  const alternatives: RecordedLocatorAlternative[] = [];
  if (!Array.isArray(alternativesIn)) c.fail(`${path}.alternatives`, 'must be a list');
  else if (alternativesIn.length > STEPS_LIMITS.alternatives)
    c.fail(`${path}.alternatives`, `holds more than ${STEPS_LIMITS.alternatives}`);
  else {
    alternativesIn.forEach((alt, i) => {
      const at = `${path}.alternatives[${i}]`;
      if (!isObject(alt)) return c.fail(at, 'must be an object');
      const locator = c.text(alt.locator, `${at}.locator`, STEPS_LIMITS.textLength, false);
      const safe = locator ? safeLocator(locator) : null;
      if (locator && !safe) return c.fail(`${at}.locator`, 'is not a Playwright locator chain');
      if (!safe) return;
      alternatives.push({
        locator: safe.text,
        method: safe.chain.calls[safe.chain.calls.length - 1]!.method,
        score: typeof alt.score === 'number' && Number.isFinite(alt.score) ? alt.score : 0,
      });
    });
  }
  return {
    tagName: c.text(v.tagName, `${path}.tagName`, 64, false) ?? '',
    role: c.text(v.role, `${path}.role`, 64, true),
    accessibleName: c.text(v.accessibleName, `${path}.accessibleName`, STEPS_LIMITS.textLength, true),
    testId: c.text(v.testId, `${path}.testId`, STEPS_LIMITS.textLength, true),
    text: c.text(v.text, `${path}.text`, STEPS_LIMITS.textLength, true),
    alternatives,
  };
}

function checkAssertion(c: Checker, v: unknown, path: string): StepAssertion | undefined {
  if (!isObject(v)) {
    c.fail(path, 'is required on an assert step');
    return undefined;
  }
  const matcher = v.matcher as AssertionMatcher;
  if (!ASSERTION_MATCHERS.includes(matcher)) {
    c.fail(`${path}.matcher`, `must be one of ${ASSERTION_MATCHERS.join(', ')}`);
    return undefined;
  }
  const expected = c.text(v.expected, `${path}.expected`, STEPS_LIMITS.valueLength, !VALUE_MATCHERS.has(matcher));
  if (matcher === 'toHaveCount' && expected != null && !/^\d{1,6}$/.test(expected)) {
    c.fail(`${path}.expected`, 'must be a whole number of elements on a toHaveCount assertion');
  }
  return {
    matcher,
    expected: VALUE_MATCHERS.has(matcher) ? expected : null,
    actual: c.text(v.actual, `${path}.actual`, STEPS_LIMITS.valueLength, true),
    negated: v.negated === true,
    note: c.text(v.note, `${path}.note`, STEPS_LIMITS.valueLength, true),
  };
}

function checkManual(c: Checker, v: unknown, path: string): StepManual | undefined {
  if (!isObject(v)) {
    c.fail(path, 'is required on a manual step');
    return undefined;
  }
  const description = c.text(v.description, `${path}.description`, STEPS_LIMITS.valueLength, false);
  if (description != null && !description.trim()) c.fail(`${path}.description`, 'must not be empty');
  const instruction = readInstruction(v.instruction);
  return {
    description: description ?? '',
    location: c.text(v.location, `${path}.location`, STEPS_LIMITS.textLength, true),
    call: c.text(v.call, `${path}.call`, STEPS_LIMITS.textLength, true),
    ...(instruction ? { instruction } : {}),
  };
}

const isText = (v: unknown): boolean => typeof v === 'string' && v.length <= STEPS_LIMITS.valueLength;
const isTextOrNull = (v: unknown): boolean => v == null || isText(v);
const isCount = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;

/** What each field of a manual instruction holds. */
const INSTRUCTION_FIELDS = {
  locator: isText,
  call: isText,
  matcher: isText,
  what: isText,
  expected: isTextOrNull,
  received: isTextOrNull,
  x: (v: unknown) => typeof v === 'number' && Number.isFinite(v),
  y: (v: unknown) => typeof v === 'number' && Number.isFinite(v),
  count: isCount,
  limit: isCount,
  options: (v: unknown) =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.length <= STEPS_LIMITS.alternatives &&
    v.every((o) => isText(o) || isCount(o)),
} satisfies Record<string, (v: unknown) => boolean>;

type InstructionField = keyof typeof INSTRUCTION_FIELDS;

const CHECK_VALUES: readonly InstructionField[] = ['expected', 'received'];

/** The fields each kind of manual instruction has. */
const INSTRUCTION_KINDS: Readonly<Record<ManualInstructionKind, readonly InstructionField[]>> = {
  goBack: [],
  goForward: [],
  reload: [],
  gotoUnknown: [],
  setContent: [],
  keyboardType: [],
  mouseAt: ['x', 'y', 'call'],
  mouseOrKeyboard: ['call'],
  failedCall: ['call'],
  locatorCall: ['locator', 'call'],
  fillUnknown: ['locator'],
  fillPartial: ['locator'],
  pressUnknown: ['locator'],
  selectOptionUnknown: ['locator'],
  setInputFiles: ['locator'],
  dragTo: ['locator'],
  drop: ['locator'],
  focus: ['locator'],
  blur: ['locator'],
  dispatchEvent: ['locator'],
  scrollIntoViewIfNeeded: ['locator'],
  selectOptions: ['locator', 'options'],
  expectPoll: ['matcher', ...CHECK_VALUES],
  expectValue: ['what', ...CHECK_VALUES],
  expectLocator: ['locator', 'matcher', ...CHECK_VALUES],
  expectURL: CHECK_VALUES,
  leadingSteps: ['count', 'limit'],
};

/**
 * A manual step's instruction, or null for one of a kind this version does
 * not know or whose fields do not check: the step's `description` says what
 * to do then.
 */
function readInstruction(v: unknown): ManualInstruction | null {
  if (!isObject(v) || typeof v.kind !== 'string' || !Object.prototype.hasOwnProperty.call(INSTRUCTION_KINDS, v.kind))
    return null;
  const kind = v.kind as ManualInstructionKind;
  const out: Json = { kind };
  for (const field of INSTRUCTION_KINDS[kind]) {
    if (!INSTRUCTION_FIELDS[field](v[field])) return null;
    out[field] = v[field] ?? null;
  }
  return out as ManualInstruction;
}

/** A document's viewport sizes: whole pixels within the limit, each on a step it has, in step order, one per step. */
function checkViewports(c: Checker, v: unknown, stepCount: number): StepViewport[] {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    c.fail('viewports', 'must be a list');
    return [];
  }
  if (v.length > STEPS_LIMITS.viewports) {
    c.fail('viewports', `holds more than ${STEPS_LIMITS.viewports}`);
    return [];
  }
  const out: StepViewport[] = [];
  v.forEach((entry, i) => {
    const at = `viewports[${i}]`;
    if (!isObject(entry)) return c.fail(at, 'must be an object');
    const { step, width, height } = entry;
    if (!Number.isInteger(step) || (step as number) < 0 || (step as number) >= stepCount)
      return c.fail(`${at}.step`, 'must be the index of a step');
    for (const [name, size] of [
      ['width', width],
      ['height', height],
    ] as const) {
      if (!Number.isInteger(size) || (size as number) < 1 || (size as number) > STEPS_LIMITS.viewportSize)
        return c.fail(`${at}.${name}`, `must be a whole number of pixels from 1 to ${STEPS_LIMITS.viewportSize}`);
    }
    const { zoom } = entry;
    if (zoom != null && (typeof zoom !== 'number' || !(zoom >= STEPS_LIMITS.zoom.min && zoom <= STEPS_LIMITS.zoom.max)))
      return c.fail(`${at}.zoom`, `must be a zoom factor from ${STEPS_LIMITS.zoom.min} to ${STEPS_LIMITS.zoom.max}`);
    const last = out[out.length - 1];
    if (last && last.step >= (step as number)) return c.fail(`${at}.step`, 'must come after the step before it');
    out.push({
      step: step as number,
      width: width as number,
      height: height as number,
      ...(zoom != null && zoom !== 1 ? { zoom: zoom as number } : {}),
    });
  });
  return out;
}

function checkStep(c: Checker, v: unknown, path: string): RecordedStep | null {
  if (!isObject(v)) {
    c.fail(path, 'must be an object');
    return null;
  }
  const action = v.action as StepAction;
  if (!ACTIONS.has(action)) {
    c.fail(`${path}.action`, 'is not a known action');
    return null;
  }
  // `assertVisible` is the legacy spelling of `assert` with `toBeVisible`.
  const step: RecordedStep = {
    action: action === 'assertVisible' ? 'assert' : action,
    target: checkTarget(c, v.target, `${path}.target`),
    value: c.text(v.value, `${path}.value`, STEPS_LIMITS.valueLength, true),
    redacted: v.redacted === true,
    pageUrl: c.text(v.pageUrl, `${path}.pageUrl`, STEPS_LIMITS.valueLength, false) ?? '',
    timestamp: v.timestamp == null ? 0 : c.number(v.timestamp, `${path}.timestamp`),
  };
  if (step.redacted) step.value = null;
  if (action === 'hover' || action === 'dblclick') {
    step.value = null;
    if (!step.target) c.fail(`${path}.target`, `is required on a ${action} step`);
  }
  if (action === 'setInputFiles' && !step.target) c.fail(`${path}.target`, 'is required on a setInputFiles step');
  if (action === 'dragTo') {
    step.value = null;
    if (!step.target) c.fail(`${path}.target`, 'is required on a dragTo step');
    step.dropTarget = checkTarget(c, v.dropTarget, `${path}.dropTarget`);
    if (!step.dropTarget) c.fail(`${path}.dropTarget`, 'is required on a dragTo step');
  }
  if (action === 'assertVisible') {
    step.assertion = { matcher: 'toBeVisible', expected: null, actual: null, negated: false, note: null };
  } else if (action === 'assert') {
    step.assertion = checkAssertion(c, v.assertion, `${path}.assertion`);
  } else if (action === 'manual') {
    step.value = null;
    step.manual = checkManual(c, v.manual, `${path}.manual`);
  }
  return step;
}

/**
 * Read a steps document from JSON text or a parsed value. A recording saved
 * before the format existed (`{ steps, startedAt, startUrl }`) is read too.
 * Returns the document, or every problem found (at most 20).
 */
export function parseSteps(input: unknown): ParseStepsResult {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, errors: ['not valid JSON'] };
    }
  }
  if (!isObject(value)) return { ok: false, errors: ['a steps document must be a JSON object'] };

  const c = new Checker();
  const legacy = value.v == null && typeof value.startUrl === 'string';
  if (!legacy && value.v !== 1 && value.v !== STEPS_VERSION) {
    return { ok: false, errors: [`v: this reads versions 1 to ${STEPS_VERSION}, not ${JSON.stringify(value.v)}`] };
  }
  if (!Array.isArray(value.steps)) return { ok: false, errors: ['steps: must be a list'] };
  if (value.steps.length > STEPS_LIMITS.steps) {
    return { ok: false, errors: [`steps: holds more than ${STEPS_LIMITS.steps}`] };
  }
  const steps = value.steps.flatMap((s, i) => {
    const step = checkStep(c, s, `steps[${i}]`);
    return step ? [step] : [];
  });

  let doc: PiwiSteps;
  if (legacy) {
    doc = toStepsDocument({
      steps,
      startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0,
      startUrl: value.startUrl as string,
    });
  } else {
    const originText = c.text(value.origin, 'origin', STEPS_LIMITS.textLength, true);
    const origin = originText ? originOf(originText) : null;
    if (originText && !origin) c.fail('origin', 'must be an http(s) origin');
    const viewports = checkViewports(c, value.viewports, steps.length);
    doc = {
      v: stepsVersionFor(steps),
      title: c.text(value.title, 'title', STEPS_LIMITS.textLength, true),
      origin,
      recordedAt: value.recordedAt == null ? 0 : c.number(value.recordedAt, 'recordedAt'),
      note: c.text(value.note, 'note', STEPS_LIMITS.valueLength, true),
      steps,
      ...(viewports.length > 0 ? { viewports } : {}),
    };
  }
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, steps: doc };
}
