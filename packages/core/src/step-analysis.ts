/**
 * Playwright step analysis: categorisation, flattening and the derived
 * per-case metrics (slowest step, wasted time, timeline events).
 *
 * Shared because two producers must agree on the shape: the reporter reads
 * `result.steps` from a live run, and the server rebuilds the same structures
 * from an imported blob report's step events.
 */
import { stripAnsi } from './error-parse';
import { maskTokenLike } from './mask';
import { isCaptureStep, sameCodeLocation } from './step-tree';
import type { TestStepEvent, TestStepEventHook } from './wire';

/** Max param keys kept per step. */
export const MAX_STEP_PARAM_KEYS = 20;
/** Max characters kept per stored param value. */
export const MAX_STEP_PARAM_VALUE_CHARS = 200;

/**
 * Cap a stored step value to `max` characters, ending a cut value with `…` so
 * readers can tell it is incomplete (a cut locator chain can still parse as a
 * shorter, different chain).
 */
export function capStepValue(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

/** An API request's title in newer Playwright: the bare HTTP method (`GET`, `POST`, …). */
const HTTP_METHOD_TITLE_RE = /^(?:get|post|put|patch|delete|head|options|fetch)$/i;

/**
 * Categorise a Playwright step into `navigation`, `action`, `input`,
 * `assertion`, `wait`, `api`, `hook`, `fixture`, `test.step`, `attach`, or
 * `other`.
 *
 * Supports two title formats:
 *  - Legacy api-path titles ("page.goto", "locator.click", "page.waitForTimeout")
 *  - Modern human-readable titles introduced in newer Playwright versions
 *    ("Navigate to \"{url}\"", "Click", "Wait for timeout", "Wait for load state").
 * Hook/fixture/expect steps, `test.step` groups and attachments are detected via
 * Playwright's own `category`, so a `test.step` titled "Fill the form" stays a
 * group rather than an input.
 *
 * `params` is Playwright's curated per-step argument object (the rendered
 * `locator`, a navigation's `url`, …). When present it is the exact signal for
 * a step's kind, preferred over parsing a title that newer Playwright reduced
 * to a bare verb.
 */
export function categorizeStep(title: string, pwCategory?: string, params?: Record<string, unknown>): string {
  if (!title) return 'other';
  if (pwCategory === 'hook' || pwCategory === 'fixture' || pwCategory === 'test.step') return pwCategory;
  if (pwCategory === 'expect') return 'assertion';
  if (pwCategory === 'test.attach') return 'attach';
  const lower = title.toLowerCase();

  // An API request (`request.get(…)`): newer Playwright titles it with the bare
  // HTTP method and a `url` param, so it is caught before the url-means-navigation rule.
  if (HTTP_METHOD_TITLE_RE.test(title.trim())) return 'api';

  // Waits — modern "Wait for timeout/function/selector/state/navigation/load state/url/event"
  // and legacy "*.waitFor*" (locator.waitFor, page.waitForLoadState, frame.waitForTimeout, ...).
  if (
    lower.startsWith('wait for') ||
    lower.startsWith('locator.waitfor') ||
    lower.startsWith('page.waitfor') ||
    lower.startsWith('frame.waitfor')
  )
    return 'wait';

  // A rendered `params.url` is a goto step's exact navigation signal; prefer it
  // over the title, which recent Playwright reduced to a bare "Navigate".
  if (typeof params?.url === 'string' && pwCategory !== 'expect') return 'navigation';

  // Navigation — modern "Navigate"/"Navigate to ...", "Go back", "Go forward", "Reload"; legacy "page.goto" etc.
  if (
    lower.startsWith('navigate') ||
    lower.startsWith('go back') ||
    lower.startsWith('go forward') ||
    lower.startsWith('reload') ||
    lower.startsWith('page.goto') ||
    lower.startsWith('page.reload') ||
    lower.startsWith('page.goback') ||
    lower.startsWith('page.goforward')
  )
    return 'navigation';

  // Actions — clicks, taps, checks, selects, hovers
  if (
    lower.startsWith('click') ||
    lower.startsWith('double click') ||
    lower.startsWith('check') ||
    lower.startsWith('uncheck') ||
    lower.startsWith('tap') ||
    lower.startsWith('hover') ||
    lower.startsWith('select option') ||
    lower.startsWith('drag') ||
    lower.startsWith('locator.click') ||
    lower.startsWith('locator.dblclick') ||
    lower.startsWith('locator.check') ||
    lower.startsWith('locator.uncheck') ||
    lower.startsWith('locator.selectoption') ||
    lower.startsWith('locator.tap')
  )
    return 'action';

  // Input — fill, type, press, insert text, set input files
  if (
    lower.startsWith('fill ') ||
    lower === 'fill' ||
    lower.startsWith('type') ||
    lower.startsWith('press') ||
    lower.startsWith('insert ') ||
    lower.startsWith('set input files') ||
    lower.startsWith('locator.fill') ||
    lower.startsWith('locator.type') ||
    lower.startsWith('locator.press') ||
    lower.startsWith('locator.clear') ||
    lower.startsWith('locator.setinputfiles')
  )
    return 'input';

  // Assertions — legacy "expect..." titles (modern ones caught via pwCategory above)
  if (lower.startsWith('expect') || lower.startsWith('locator.expect') || lower.startsWith('page.expect'))
    return 'assertion';

  if (lower.startsWith('apirequestcontext') || lower.startsWith('apiresponse')) return 'api';
  if (lower === 'before hooks' || lower === 'after hooks' || lower.startsWith('fixture:')) return 'hook';
  return 'other';
}

/** A single step flattened from the Playwright step tree with its derived category */
export interface FlatStep {
  title: string;
  duration: number;
  category: string;
  /**
   * The step's target, carried separately from the title by newer Playwright:
   * the rendered locator, or a navigation's URL. Composed with the title by
   * {@link stepLabel}.
   */
  subtitle?: string;
  /**
   * Curated per-step arguments: the rendered `locator`, a navigation `url`, an
   * action's `button`/`value`, or a `test.step` author's own values. Primitives
   * are kept as-is; anything else is JSON-stringified. Capped and masked.
   */
  params?: Record<string, string | number | boolean>;
  /**
   * The step's error when it failed (undefined when the step passed): its
   * message, and where it was thrown as `file:line:col` when Playwright
   * reports it.
   */
  error?: { message: string; location?: string };
  /** True when the step carried an error — the signal the server needs for inline failure markers. */
  failed?: boolean;
  /**
   * True when the step's error is none of the test's errors: the test caught it
   * (`try`/`catch`, a retried `toPass` attempt) and went on. Set by
   * {@link markRecoveredSteps}.
   */
  recovered?: boolean;
  /** Source pointer `file:line:col` (not a code snippet); present when Playwright reports one. */
  location?: string;
  /** Absolute start time in ms; enables per-step timing/waterfall on the case detail page. */
  startTime?: number;
  /** Nesting depth in Playwright's step tree: 0 for a top-level step, 1 for its children, and so on. */
  depth?: number;
}

/**
 * A step's display label: the title followed by its subtitle when the subtitle
 * carries a target not already spelled out in the title. The one place the
 * 1.61 (`Click getByRole(…)`) and newer (`Click` + subtitle) title shapes
 * converge, so every consumer labels a step the same way on both.
 */
export function stepLabel(step: { title?: unknown; subtitle?: unknown }): string {
  const title = typeof step.title === 'string' ? step.title : '';
  const subtitle = typeof step.subtitle === 'string' ? step.subtitle.trim() : '';
  if (!subtitle) return title;
  if (!title) return subtitle;
  return title.includes(subtitle) ? title : `${title} ${subtitle}`;
}

/**
 * The title and subtitle split for two-element display: the title, and the
 * subtitle only when it adds a target the title does not already spell out.
 * The visual counterpart of {@link stepLabel} (which joins the same two parts
 * into one plain-text string) — a renderer shows `title` then a muted
 * `subtitle`, and joining them with a space reproduces `stepLabel`.
 */
export function stepLabelParts(step: { title?: unknown; subtitle?: unknown }): {
  title: string;
  subtitle: string | null;
} {
  const title = typeof step.title === 'string' ? step.title : '';
  const subtitle = typeof step.subtitle === 'string' ? step.subtitle.trim() : '';
  if (!subtitle) return { title, subtitle: null };
  if (!title) return { title: subtitle, subtitle: null };
  return title.includes(subtitle) ? { title, subtitle: null } : { title, subtitle };
}

/**
 * A step's params in display order: the rendered `locator` first (it is the
 * step's subject), then the remaining keys in insertion order. Used by the
 * timeline's parameter list and the analysis lines so every surface lists them
 * the same way. Returns an empty array when the step carries none.
 */
export function orderedStepParams(
  params: Record<string, string | number | boolean> | null | undefined,
): Array<[string, string | number | boolean]> {
  if (!params || typeof params !== 'object') return [];
  const entries = Object.entries(params);
  return entries.sort(([a], [b]) => (a === 'locator' ? -1 : b === 'locator' ? 1 : 0));
}

/**
 * Normalize a step's raw `params`: keep primitives as they are, JSON-stringify
 * anything else, mask token-shaped strings, and cap both the key count and each
 * value's length. Returns undefined when nothing survives.
 */
function normalizeStepParams(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_STEP_PARAM_KEYS) break;
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      count++;
    } else if (typeof value === 'string') {
      out[key] = capStepValue(maskTokenLike(value), MAX_STEP_PARAM_VALUE_CHARS);
      count++;
    } else if (value != null) {
      try {
        out[key] = capStepValue(maskTokenLike(JSON.stringify(value)), MAX_STEP_PARAM_VALUE_CHARS);
        count++;
      } catch {
        // Non-serializable (circular) values are dropped.
      }
    }
  }
  return count > 0 ? out : undefined;
}

/** Step-event category restricted to the values the step-event extractors emit. */
export type StepEventCategory = 'hook' | 'fixture' | 'test.step' | 'expect' | 'wait' | 'pause';

/** A Playwright `{ file, line, column }` location as `file:line:col`; undefined without a file. */
function locationText(location: { file?: unknown; line?: unknown; column?: unknown } | null | undefined) {
  if (!location || typeof location.file !== 'string' || !location.file) return undefined;
  return `${location.file}:${location.line}:${location.column}`;
}

/** One of the errors a test ended with, as Playwright reports it in `TestResult.errors`. */
export interface TestErrorLike {
  message?: string;
  location?: { file: string; line: number; column: number };
}

/**
 * Mark every flattened step whose error is none of the test's `errors` as
 * `recovered`: the test caught it and went on. A step error is one of the
 * test's errors when its first line matches one and, when both record where
 * they were thrown, at the same place. A passing test's `errors` is empty, so
 * every step error it recorded is marked.
 */
export function markRecoveredSteps(steps: FlatStep[], errors: readonly TestErrorLike[]): void {
  const fatal = errors.map((error) => ({
    head: firstErrorLine(error.message),
    location: locationText(error.location),
  }));
  for (const step of steps) {
    if (!step.error) continue;
    const head = firstErrorLine(step.error.message);
    const thrownAt = step.error.location;
    const isFatal = fatal.some(
      (error) => error.head === head && (!error.location || !thrownAt || sameCodeLocation(error.location, thrownAt)),
    );
    if (!isFatal) step.recovered = true;
  }
}

function firstErrorLine(message: unknown): string {
  return stripAnsi(typeof message === 'string' ? message : '')
    .split('\n')[0]!
    .trim();
}

/**
 * Recursively flatten a nested step tree into a flat list, depth first, each
 * step recording its `depth` so the tree can be rebuilt. Uses Playwright's
 * built-in category when available.
 */
export function flattenSteps(steps: any[], depth = 0): FlatStep[] {
  const result: FlatStep[] = [];
  for (const step of steps) {
    const flat: FlatStep = {
      title: step.title,
      duration: step.duration,
      category: categorizeStep(step.title, step.category, step.params),
      depth,
    };
    if (typeof step.subtitle === 'string' && step.subtitle.length > 0) flat.subtitle = maskTokenLike(step.subtitle);
    const params = normalizeStepParams(step.params);
    if (params) flat.params = params;
    if (step.error?.message) {
      flat.error = { message: step.error.message };
      const thrownAt = locationText(step.error.location);
      if (thrownAt) flat.error.location = thrownAt;
      flat.failed = true;
    }
    const location = locationText(step.location);
    if (location) flat.location = location;
    if (step.startTime) flat.startTime = step.startTime instanceof Date ? step.startTime.getTime() : step.startTime;
    result.push(flat);
    if (step.steps?.length > 0) result.push(...flattenSteps(step.steps, depth + 1));
  }
  return result;
}

/** A stretch of time a test stood stopped at Piwi's pause bar: its start in epoch ms and its length. */
export interface PauseSpan {
  startedAt: number;
  duration: number;
}

/** The stops among a test's step events (`category: 'pause'`); none for anything else. */
export function pauseSpans(events: unknown): PauseSpan[] {
  if (!Array.isArray(events)) return [];
  return events.filter(
    (event): event is PauseSpan =>
      !!event &&
      typeof event === 'object' &&
      (event as { category?: unknown }).category === 'pause' &&
      Number.isFinite((event as PauseSpan).startedAt) &&
      Number.isFinite((event as PauseSpan).duration),
  );
}

function epochMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * How long the test stood stopped while a span starting at `start` (epoch ms, or a `Date`) and lasting `duration` ran,
 * in ms. Stops that overlap count once. Zero for a span without a start.
 */
export function pausedOverlap(start: unknown, duration: unknown, pauses: readonly PauseSpan[]): number {
  const from = epochMs(start);
  const length = typeof duration === 'number' && duration > 0 ? duration : 0;
  if (from === null || length === 0 || pauses.length === 0) return 0;
  const to = from + length;
  const spans = pauses
    .filter((p) => p.duration > 0)
    .map((p) => [Math.max(from, p.startedAt), Math.min(to, p.startedAt + p.duration)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let ms = 0;
  let reached = from;
  for (const [a, b] of spans) {
    const begin = Math.max(a, reached);
    if (b > begin) ms += b - begin;
    reached = Math.max(reached, b);
  }
  return ms;
}

/**
 * A step's duration as the step statistics read it (the slowest step, the time in waits and navigations, a step's
 * usual time): its duration less the time the test stood stopped at Piwi's pause bar while it ran. The step's own
 * duration and start stay as Playwright measured them everywhere else.
 */
export function unpausedDuration(
  step: { startTime?: unknown; duration?: unknown },
  pauses: readonly PauseSpan[],
): number {
  const duration = typeof step.duration === 'number' && step.duration > 0 ? step.duration : 0;
  return duration - pausedOverlap(step.startTime, duration, pauses);
}

/** Aggregated step performance data for a single test case */
export interface StepMetrics {
  /** Flattened step list with categories */
  steps: FlatStep[];
  /** Sum of top-level step durations */
  totalStepDuration: number;
  /** The single slowest step (by duration) */
  slowestStep: { title: string; duration: number } | null;
  /** How many navigation steps were executed */
  navigationCount: number;
  /** Total wall-clock time spent in navigation steps */
  navigationTotalDuration: number;
  /** Total wall-clock time spent in wait steps (wasted time) */
  waitTotalDuration: number;
  /** Count of wait steps */
  waitCount: number;
}

/**
 * Collect step metrics (flat steps, slowest step, navigation stats) from a
 * Playwright step array. With the test's `errors`, the step errors the test
 * caught are marked `recovered`. With the test's `pauses` (its stops at Piwi's
 * pause bar), every figure reads each step's duration less the time the test
 * stood stopped while it ran (`unpausedDuration`); the flat steps keep their
 * measured durations.
 */
export function collectStepMetrics(
  steps: any[],
  errors?: readonly TestErrorLike[] | null,
  pauses: readonly PauseSpan[] = [],
): StepMetrics {
  const flatSteps = flattenSteps(steps);
  if (errors) markRecoveredSteps(flatSteps, errors);
  const own = (s: { startTime?: unknown; duration: number }) =>
    pauses.length > 0 ? unpausedDuration(s, pauses) : s.duration;
  const totalStepDuration = steps.reduce((sum: number, s: any) => sum + (own(s) || 0), 0);

  let slowestStep: { title: string; duration: number } | null = null;
  for (const s of flatSteps) {
    const duration = own(s);
    if (!slowestStep || duration > slowestStep.duration) slowestStep = { title: s.title, duration };
  }

  const navSteps = flatSteps.filter((s) => s.category === 'navigation');
  const waitSteps = flatSteps.filter((s) => s.category === 'wait');
  const waitTotalDuration = waitSteps.reduce((sum, s) => sum + (own(s) || 0), 0);

  return {
    steps: flatSteps,
    totalStepDuration,
    slowestStep,
    navigationCount: navSteps.length,
    navigationTotalDuration: navSteps.reduce((sum: number, s) => sum + (own(s) || 0), 0),
    waitTotalDuration,
    waitCount: waitSteps.length,
  };
}

/** Calculate the p-th percentile from a sorted array of numbers */
export function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const index = Math.min(sortedArr.length - 1, Math.max(0, Math.ceil((p / 100) * sortedArr.length) - 1));
  return sortedArr[index]!;
}

/** Summary performance statistics for a complete test run */
export interface PerformanceSummary {
  /** Average test-case duration in ms */
  avgTestDuration?: number;
  /** Median (P50) test-case duration in ms */
  p50TestDuration?: number;
  /** P90 test-case duration in ms */
  p90TestDuration?: number;
  /** P95 test-case duration in ms */
  p95TestDuration?: number;
  /** Up to 5 slowest test cases */
  slowestTests?: Array<{ title: string; duration: number }>;
  /** Total time spent in navigation steps across all cases */
  totalNavigationDuration?: number;
  /** Average time per navigation step */
  avgNavigationDuration?: number;
  /** Total time spent in wait steps across all cases */
  totalWastedTimeMs?: number;
}

/** Compute run-level performance summary (averages, percentiles, slowest tests) from all test cases */
export function computePerformanceSummary(testCases: any[]): PerformanceSummary {
  const durations = testCases.filter((tc: any) => tc.duration != null).map((tc: any) => tc.duration);

  if (durations.length === 0) return {};

  const sorted = [...durations].sort((a: number, b: number) => a - b);
  const sum = durations.reduce((a: number, b: number) => a + b, 0);

  const result: PerformanceSummary = {
    avgTestDuration: Math.round(sum / durations.length),
    p50TestDuration: percentile(sorted, 50),
    p90TestDuration: percentile(sorted, 90),
    p95TestDuration: percentile(sorted, 95),
    slowestTests: [...testCases]
      .filter((tc: any) => tc.duration != null)
      .sort((a: any, b: any) => b.duration - a.duration)
      .slice(0, 5)
      .map((tc: any) => ({ title: tc.title, duration: tc.duration })),
  };

  let totalNavDur = 0;
  let totalNavCount = 0;
  for (const tc of testCases) {
    if (tc.performanceMetrics) {
      totalNavDur += tc.performanceMetrics.navigationTotalDuration || 0;
      totalNavCount += tc.performanceMetrics.navigationCount || 0;
    }
  }

  result.totalNavigationDuration = totalNavDur;
  result.avgNavigationDuration = totalNavCount > 0 ? Math.round(totalNavDur / totalNavCount) : 0;

  let totalWasted = 0;
  for (const tc of testCases) {
    if (tc.performanceMetrics) {
      totalWasted += tc.performanceMetrics.waitTotalDuration || 0;
    }
  }
  result.totalWastedTimeMs = totalWasted;

  return result;
}

/** Max hooks and fixtures a hook section's event lists; the failed and the slowest are kept. */
export const MAX_SECTION_HOOKS = 12;
/** Max characters kept of a failed hook or fixture event's error line. */
const MAX_STEP_EVENT_ERROR_CHARS = 300;

/** A Playwright step location as `file:line:col`, or null. */
function stepLocation(step: any): string | null {
  return step.location ? `${step.location.file}:${step.location.line}:${step.location.column}` : null;
}

/** The first non-empty line of a step's error, without ANSI codes and capped; null when it has none. */
function stepErrorLine(step: any): string | null {
  const raw = step.error?.message ?? step.error?.value;
  if (typeof raw !== 'string') return null;
  const line = stripAnsi(raw)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? capStepValue(line, MAX_STEP_EVENT_ERROR_CHARS) : null;
}

/**
 * The hooks and fixtures a hook section ran: its direct hook and fixture
 * children, without Piwi's own capture steps. Past `MAX_SECTION_HOOKS` the
 * failed ones and then the slowest are kept, still in the order they ran.
 */
function sectionHooks(step: any): TestStepEventHook[] {
  const children: TestStepEventHook[] = [];
  for (const child of step.steps ?? []) {
    const category = categorizeStep(child.title, child.category);
    if (category !== 'hook' && category !== 'fixture') continue;
    if (isCaptureStep({ title: child.title, location: stepLocation(child) })) continue;
    const hook: TestStepEventHook = { title: child.title, category, duration: child.duration || 0 };
    if (child.error) hook.failed = true;
    children.push(hook);
  }
  if (children.length <= MAX_SECTION_HOOKS) return children;
  const keep = new Set(
    children
      .map((hook, i) => ({ hook, i }))
      .sort(
        (a, b) => Number(Boolean(b.hook.failed)) - Number(Boolean(a.hook.failed)) || b.hook.duration - a.hook.duration,
      )
      .slice(0, MAX_SECTION_HOOKS)
      .map(({ i }) => i),
  );
  return children.filter((_, i) => keep.has(i));
}

/**
 * Extract hook and fixture step events with absolute timings from a Playwright
 * step tree. These are used by the WorkersTimeline to render hook segments.
 *
 * Returns only top-level hook/fixture steps — Playwright's `Before Hooks`,
 * `After Hooks` and `Worker Cleanup` sections, whose sub-steps are included in
 * their duration. Each carries the hooks and fixtures it ran (`beforeAll hook`,
 * `Fixture "db"`) and, when it failed, the first line of its error, so the
 * timeline can name what ran and what broke without the full step list.
 */
export function extractTestStepEvents(steps: any[], _testStartTime: Date): TestStepEvent[] {
  const events: TestStepEvent[] = [];

  for (const step of steps) {
    const cat = categorizeStep(step.title, step.category);
    if (cat !== 'hook' && cat !== 'fixture') continue;
    if (!step.startTime) continue;

    const startedAt = step.startTime instanceof Date ? step.startTime.getTime() : step.startTime;
    const event: TestStepEvent = {
      title: step.title,
      category: cat as StepEventCategory,
      startedAt,
      duration: step.duration || 0,
      status: step.error ? 'failed' : 'passed',
      location: stepLocation(step),
    };
    const error = step.error ? stepErrorLine(step) : null;
    if (error) event.error = error;
    const hooks = sectionHooks(step);
    if (hooks.length > 0) event.hooks = hooks;
    events.push(event);
  }

  return events;
}

/**
 * Recursively extract wait-category steps from the Playwright step tree
 * with absolute timings. These are rendered as semi-transparent amber bars
 * on WorkersTimeline to visualize wasted time.
 */
export function extractWaitEvents(
  steps: any[],
  insideWait: boolean = false,
): Array<{
  title: string;
  category: StepEventCategory;
  startedAt: number;
  duration: number;
  status: string;
  location?: string | null;
}> {
  const events: Array<{
    title: string;
    category: StepEventCategory;
    startedAt: number;
    duration: number;
    status: string;
    location?: string | null;
  }> = [];
  for (const step of steps) {
    const cat = categorizeStep(step.title, step.category);
    const isWait = cat === 'wait';
    if (isWait && !insideWait && step.startTime) {
      const startedAt = step.startTime instanceof Date ? step.startTime.getTime() : step.startTime;
      events.push({
        title: step.title,
        category: 'wait' as StepEventCategory,
        startedAt,
        duration: step.duration || 0,
        status: 'wasted',
        location: step.location ? `${step.location.file}:${step.location.line}:${step.location.column}` : null,
      });
    }
    if (step.steps?.length > 0) {
      events.push(...extractWaitEvents(step.steps, insideWait || isWait));
    }
  }
  return events;
}
