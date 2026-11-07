/**
 * Flake plans: the file one arm of a flake experiment hands the reporter. The
 * lab runs a control arm and one arm per condition, each a Playwright run with
 * `PIWI_FLAKE_PLAN` pointing at that arm's plan; the capture fixtures apply the
 * arm's conditions to the matching test and append one results line per
 * finished attempt to `PIWI_FLAKE_RESULTS`. The dashboard (which plans an
 * experiment), the command line (which runs it) and the reporter (which applies
 * it) all read the plan through {@link parseFlakePlan}.
 */
import { extractErrorSignature } from './error-signature';

/** The plan file format this module reads and writes. */
export const FLAKE_PLAN_VERSION = 1;

/** A test as the lab names it: spec file (project-root-relative, POSIX), leaf title and describe path. */
export interface FlakeTestRef {
  file: string;
  title: string;
  /** Describe-block titles from the outermost down. */
  suite: string[];
}

/** The test an experiment targets, pinned to the Playwright project its failures ran in when known. */
export interface FlakePlanTest extends FlakeTestRef {
  project: string | null;
}

/**
 * Which matching requests a route condition acts on: every one, or only the Nth
 * (1-based) after the page's first navigation, as probes count.
 */
type FlakeRouteMatch = 'all' | number;

/** Hold one route's responses until `ms` after each request started. */
interface FlakeDelayCondition {
  kind: 'delay';
  /** Route key: method and normalized path (`GET /api/cart/:id`). */
  route: string;
  ms: number;
  match: FlakeRouteMatch;
}

/** Answer one route with an error status, or reset its connection. */
type FlakeFailCondition =
  | { kind: 'fail'; route: string; status: number; match: FlakeRouteMatch }
  | { kind: 'fail'; route: string; abort: true; match: FlakeRouteMatch };

/** Throttle the page's CPU by `rate` (Chromium only). */
interface FlakeCpuCondition {
  kind: 'cpu';
  rate: number;
}

/** Emulate a slow network: added latency and throughput caps (Chromium only). */
interface FlakeNetworkCondition {
  kind: 'network';
  latencyMs: number;
  downKbps: number;
  upKbps: number;
}

/** Run with the browser context's time zone set to an IANA zone (`Europe/Paris`, `UTC`). */
interface FlakeTimezoneCondition {
  kind: 'timezone';
  timeZone: string;
}

/** Run with the browser context's locale set to a BCP 47 tag (`fr-FR`). */
interface FlakeLocaleCondition {
  kind: 'locale';
  locale: string;
}

/** Run another test at the same time (applied by the command line with `--workers=2`). */
export interface FlakeAlongsideCondition {
  kind: 'alongside';
  test: FlakeTestRef;
}

/** Run another test just before, on the same worker (applied by the command line with `--workers=1`). */
export interface FlakeAfterCondition {
  kind: 'after';
  test: FlakeTestRef;
}

/** Run in one Playwright project (applied by the command line with `--project`). */
interface FlakeProjectCondition {
  kind: 'project';
  name: string;
}

export type FlakeCondition =
  | FlakeDelayCondition
  | FlakeFailCondition
  | FlakeCpuCondition
  | FlakeNetworkCondition
  | FlakeTimezoneCondition
  | FlakeLocaleCondition
  | FlakeAlongsideCondition
  | FlakeAfterCondition
  | FlakeProjectCondition;

export type FlakeConditionKind = FlakeCondition['kind'];

const FLAKE_CONDITION_KINDS: readonly FlakeConditionKind[] = [
  'delay',
  'fail',
  'cpu',
  'network',
  'timezone',
  'locale',
  'alongside',
  'after',
  'project',
];

/** Conditions the command line applies through Playwright's arguments; flake mode only records them. */
export const COMMAND_CONDITION_KINDS: readonly FlakeConditionKind[] = ['alongside', 'after', 'project'];

/** One arm of an experiment: the control arm has no conditions. */
interface FlakeArm {
  id: string;
  conditions: FlakeCondition[];
}

export interface FlakePlan {
  version: typeof FLAKE_PLAN_VERSION;
  experimentId: string;
  test: FlakePlanTest;
  arm: FlakeArm;
  /**
   * The signatures ({@link flakeErrorSignature}) of the test's failures in
   * history. A lab failure counts toward reproduction only when its signature
   * is one of these.
   */
  errorSignatures: string[];
}

/** What happened to one condition during one attempt. */
type FlakeConditionOutcome =
  /**
   * It took effect at least once (a route condition matched a request; a CDP condition was set; the page's context
   * was created with the arm's time zone or locale).
   */
  | 'applied'
  /** A route condition whose route the attempt never called. */
  | 'not-matched'
  /**
   * A condition this browser cannot apply (`cpu`, `network` outside Chromium), one that failed to install, or a
   * `timezone` or `locale` whose page's context the test did not create.
   */
  | 'skipped'
  /** A condition the command line applies (`alongside`, `after`, `project`); the lab checks it from the results. */
  | 'by-command';

export interface FlakeConditionReport {
  kind: FlakeConditionKind;
  outcome: FlakeConditionOutcome;
  /** Why a condition was skipped. */
  note?: string;
}

/**
 * One line of the results file, appended per finished attempt. A `target` line
 * is the experiment's own test; a `companion` line is another test that ran in
 * the same arm (an `alongside` or `after` test), recorded so the lab can check
 * the overlap or the order it actually got.
 */
export interface FlakeResultLine {
  version: typeof FLAKE_PLAN_VERSION;
  experimentId: string;
  armId: string;
  role: 'target' | 'companion';
  file: string | null;
  title: string;
  project: string | null;
  browserName: string | null;
  /** Playwright's final status for the attempt: `passed`, `failed`, `timedOut`, `skipped` or `interrupted`. */
  status: string;
  /** The attempt's error signature ({@link flakeErrorSignature}), or null when it did not fail. */
  errorSignature: string | null;
  /** True when the attempt failed with one of the plan's `errorSignatures`. */
  matchesHistory: boolean;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Milliseconds. */
  duration: number;
  workerIndex: number;
  parallelIndex: number;
  repeatEachIndex: number;
  retry: number;
  /** One entry per condition of the arm, in plan order; empty on a companion line. */
  conditions: FlakeConditionReport[];
}

/**
 * The signature a lab compares: the masked message head of the error, so the
 * same failure matches across runs whatever its timeouts, ids or values.
 */
export function flakeErrorSignature(rawError: string): string {
  return extractErrorSignature(rawError).normalizedMessage;
}

/** Thrown for a plan file that does not follow the format. */
export class FlakePlanError extends Error {
  constructor(message: string) {
    super(`Invalid flake plan: ${message}`);
    this.name = 'FlakePlanError';
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(obj: Json, key: string, at: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || !value.trim()) throw new FlakePlanError(`${at}.${key} must be a non-empty string`);
  return value;
}

function num(obj: Json, key: string, at: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new FlakePlanError(`${at}.${key} must be a number from ${min} to ${max}`);
  }
  return value;
}

function stringList(value: unknown, at: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new FlakePlanError(`${at} must be a list of strings`);
  }
  return value as string[];
}

/** A route key is an HTTP method, one space, and a path starting with `/`. */
const ROUTE_KEY_RE = /^[A-Z]+ \/\S*$/;

function routeKey(obj: Json, at: string): string {
  const route = str(obj, 'route', at);
  if (!ROUTE_KEY_RE.test(route)) {
    throw new FlakePlanError(`${at}.route must be a method and a path, like "GET /api/cart/:id" (got "${route}")`);
  }
  return route;
}

function routeMatch(obj: Json, at: string): FlakeRouteMatch {
  const value = obj.match;
  if (value === undefined || value === 'all') return 'all';
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  throw new FlakePlanError(`${at}.match must be "all" or a whole number from 1`);
}

/** An IANA time zone name: `UTC`, `Europe/Paris`, `America/Argentina/Buenos_Aires`, `Etc/GMT+3`. */
const TIME_ZONE_RE = /^[A-Za-z][A-Za-z0-9/_+-]{0,63}$/;

/** A BCP 47 language tag: `en`, `fr-FR`, `zh-Hant-TW`. */
const LOCALE_RE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,4}$/;

function patterned(obj: Json, key: string, at: string, re: RegExp, max: number, example: string): string {
  const value = str(obj, key, at);
  if (value.length > max || !re.test(value)) {
    throw new FlakePlanError(`${at}.${key} must look like ${example} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function testRef(value: unknown, at: string): FlakeTestRef {
  if (!isObject(value)) throw new FlakePlanError(`${at} must be an object`);
  return {
    file: str(value, 'file', at),
    title: str(value, 'title', at),
    suite: stringList(value.suite, `${at}.suite`),
  };
}

function parseCondition(value: unknown, at: string): FlakeCondition {
  if (!isObject(value)) throw new FlakePlanError(`${at} must be an object`);
  const kind = value.kind;
  switch (kind) {
    case 'delay':
      return { kind, route: routeKey(value, at), ms: num(value, 'ms', at, 0, 600_000), match: routeMatch(value, at) };
    case 'fail': {
      const route = routeKey(value, at);
      const match = routeMatch(value, at);
      if (value.abort === true) {
        if (value.status !== undefined) throw new FlakePlanError(`${at} sets both status and abort; choose one`);
        return { kind, route, abort: true, match };
      }
      const status = num(value, 'status', at, 100, 599);
      if (!Number.isInteger(status)) throw new FlakePlanError(`${at}.status must be a whole number`);
      return { kind, route, status, match };
    }
    case 'cpu':
      return { kind, rate: num(value, 'rate', at, 1, 100) };
    case 'network':
      return {
        kind,
        latencyMs: num(value, 'latencyMs', at, 0, 60_000),
        downKbps: num(value, 'downKbps', at, 1),
        upKbps: num(value, 'upKbps', at, 1),
      };
    case 'timezone':
      return { kind, timeZone: patterned(value, 'timeZone', at, TIME_ZONE_RE, 64, '"Europe/Paris" or "UTC"') };
    case 'locale':
      return { kind, locale: patterned(value, 'locale', at, LOCALE_RE, 35, '"fr-FR" or "en"') };
    case 'alongside':
    case 'after':
      return { kind, test: testRef(value.test, `${at}.test`) };
    case 'project':
      return { kind, name: str(value, 'name', at) };
    default:
      throw new FlakePlanError(
        `${at}.kind ${JSON.stringify(kind)} is not a condition this version knows (${FLAKE_CONDITION_KINDS.join(', ')})`,
      );
  }
}

/**
 * Validate a parsed plan file and return it in its canonical shape (defaults
 * filled in). Throws {@link FlakePlanError} naming the first problem found,
 * including a condition kind this version does not know, so an arm is never run
 * with a condition silently dropped.
 */
export function parseFlakePlan(value: unknown): FlakePlan {
  if (!isObject(value)) throw new FlakePlanError('the plan must be a JSON object');
  if (value.version !== FLAKE_PLAN_VERSION) {
    throw new FlakePlanError(`version must be ${FLAKE_PLAN_VERSION} (got ${JSON.stringify(value.version)})`);
  }
  const experimentId = str(value, 'experimentId', 'plan');
  if (!isObject(value.test)) throw new FlakePlanError('plan.test must be an object');
  const ref = testRef(value.test, 'plan.test');
  const project = value.test.project;
  if (project !== undefined && project !== null && (typeof project !== 'string' || !project.trim())) {
    throw new FlakePlanError('plan.test.project must be a non-empty string or null');
  }
  if (!isObject(value.arm)) throw new FlakePlanError('plan.arm must be an object');
  const armId = str(value.arm, 'id', 'plan.arm');
  const rawConditions = value.arm.conditions ?? [];
  if (!Array.isArray(rawConditions)) throw new FlakePlanError('plan.arm.conditions must be a list');
  const conditions = rawConditions.map((c, i) => parseCondition(c, `plan.arm.conditions[${i}]`));
  return {
    version: FLAKE_PLAN_VERSION,
    experimentId,
    test: { ...ref, project: typeof project === 'string' ? project : null },
    arm: { id: armId, conditions },
    errorSignatures: stringList(value.errorSignatures, 'plan.errorSignatures'),
  };
}

/** Parse a plan file's text: JSON errors are reported as {@link FlakePlanError} too. */
export function parseFlakePlanText(text: string): FlakePlan {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new FlakePlanError(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseFlakePlan(json);
}

/** True when two describe paths are equal element for element. */
function suiteEqual(a: string[], b: string[] | undefined): boolean {
  return !!b && a.length === b.length && a.every((title, i) => title === b[i]);
}

/**
 * Whether a running test is the one a test reference names: same file and
 * leaf title, and the same describe path when the running test reports one.
 */
export function flakeTestMatches(
  ref: FlakeTestRef,
  test: { file: string | null; title: string; suite?: string[] },
): boolean {
  if (!test.file || ref.file !== test.file || ref.title !== test.title) return false;
  return test.suite === undefined || ref.suite.length === 0 || suiteEqual(ref.suite, test.suite);
}

/**
 * The run-metadata stamp that marks a flake-lab run, so the dashboard keeps it
 * out of flakiness, regressions, clusters and notifications. Must match the
 * dashboard's `FLAKE_LAB_RUN_METADATA_KEY`.
 */
export const FLAKE_LAB_RUN_METADATA_KEY = 'piwiFlakeLab';

export interface FlakeLabRunStamp {
  experimentId: string;
  armId: string;
}

/** A duration in a label: `800 ms`, `1.8 s`, `2 s`. */
function durationLabel(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${Number((ms / 1000).toFixed(1))} s`;
}

/** A test in a label: its describe path and title joined with ` › `. */
function flakeTestLabel(test: FlakeTestRef): string {
  return [...test.suite, test.title].join(' › ');
}

/** One condition in a few words: `delay GET /api/cart 1.8 s`, `run with admin › resets catalog`. */
export function describeFlakeCondition(condition: FlakeCondition): string {
  switch (condition.kind) {
    case 'delay':
      return `delay ${condition.route} ${durationLabel(condition.ms)}`;
    case 'fail':
      return 'abort' in condition ? `abort ${condition.route}` : `fail ${condition.route} with ${condition.status}`;
    case 'cpu':
      return `CPU ×${condition.rate}`;
    case 'network':
      return `network +${durationLabel(condition.latencyMs)}, ${condition.downKbps} kbps down`;
    case 'timezone':
      return `time zone ${condition.timeZone}`;
    case 'locale':
      return `locale ${condition.locale}`;
    case 'alongside':
      return `run with ${flakeTestLabel(condition.test)}`;
    case 'after':
      return `run after ${flakeTestLabel(condition.test)}`;
    case 'project':
      return `on ${condition.name}`;
  }
}

/** An arm's conditions in a few words, `control` when it has none. */
export function describeFlakeArm(conditions: FlakeCondition[]): string {
  return conditions.length === 0 ? 'control' : conditions.map(describeFlakeCondition).join(' + ');
}

/** Runs in one Playwright invocation of an arm that may stop early. */
export const FLAKE_BATCH_RUNS = 5;

/** A start of Playwright costs about this much on top of the tests (workers, browser). */
const FLAKE_SPAWN_OVERHEAD_MS = 3_000;

/**
 * The longest a lab session can take: every run of every arm at the test's
 * median duration (twice it for an `alongside` or `after` arm, which runs two
 * tests), plus a Playwright start per batch of {@link FLAKE_BATCH_RUNS} (one
 * for an arm that never stops early). Null without a median duration.
 */
export function estimateFlakeSessionMs(
  arms: Array<{ conditions: FlakeCondition[]; runs: number; stopAt: number | null }>,
  medianDurationMs: number | null,
): number | null {
  if (medianDurationMs == null) return null;
  let total = 0;
  for (const arm of arms) {
    const twoTests = arm.conditions.some((c) => c.kind === 'alongside' || c.kind === 'after');
    const batches = arm.stopAt == null ? 1 : Math.ceil(arm.runs / FLAKE_BATCH_RUNS);
    total += arm.runs * medianDurationMs * (twoTests ? 2 : 1) + batches * FLAKE_SPAWN_OVERHEAD_MS;
  }
  return total;
}
