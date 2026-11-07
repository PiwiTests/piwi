/**
 * A run request: a page of a team instance asks for a Playwright run of tests the instance resolved, on one of the
 * person's own machines. The instance stores it, one of the person's targets (the desktop app, Piwi Runner) claims it
 * once, shows it, and runs it only after the person clicks **Run** there.
 *
 * A request names tests by spec path relative to the Playwright config, title, line and Playwright project, and
 * options from a closed list. It never carries an absolute path, a command line, an environment variable, a URL or
 * code: the target checks each test against its own folder and builds the command itself. The instance, the targets
 * and the dashboard read it through the one parser here, which refuses an unknown field and a value out of bounds.
 */

/** What a request asks a target to do. A target refuses a kind it does not know, with a message to update. */
export const RUN_REQUEST_KINDS = ['run'] as const;
export type RunRequestKind = (typeof RUN_REQUEST_KINDS)[number];

/** The bounds of a request, fixed here rather than in a setting. */
export const RUN_REQUEST_LIMITS = {
  tests: { min: 1, max: 200 },
  repeatEach: { min: 1, max: 10 },
  workers: { min: 1, max: 4 },
  /** How long a request waits for a target to claim it, in milliseconds. */
  lifetimeMs: 2 * 60 * 1000,
} as const;

/**
 * The states of a request and its run, one model for every surface:
 *
 * - `waiting`: stored, not claimed by a target yet;
 * - `claimed`: shown in the target, not answered yet;
 * - `declined`: the person answered **Not now**;
 * - `expired`: no target claimed it in time;
 * - `refused`: a check failed in the target, before the confirmation;
 * - `starting`, `running`, `stopping`: the run, once the person clicked **Run**;
 * - `ended`: the run is over, with a {@link RunRequestOutcome}.
 */
export const RUN_REQUEST_STATES = [
  'waiting',
  'claimed',
  'declined',
  'expired',
  'refused',
  'starting',
  'running',
  'stopping',
  'ended',
] as const;
export type RunRequestState = (typeof RUN_REQUEST_STATES)[number];

/** The states a request never leaves. */
export const FINAL_RUN_REQUEST_STATES: ReadonlySet<RunRequestState> = new Set([
  'declined',
  'expired',
  'refused',
  'ended',
]);

/** How an `ended` run ended. */
export const RUN_REQUEST_OUTCOMES = ['passed', 'failed', 'stopped', 'error'] as const;
export type RunRequestOutcome = (typeof RUN_REQUEST_OUTCOMES)[number];

/** A request id: 32 lowercase hex digits. It is also the run's ref, so it stays within `parseRunOriginRef`'s rule. */
export const RUN_REQUEST_ID = /^[0-9a-f]{32}$/;

/** One test, as the instance resolved it. */
export interface RunRequestTest {
  /** Spec path relative to the Playwright config, POSIX separators. */
  filePath: string;
  title: string;
  line: number | null;
  projectName: string | null;
}

/** The options of a request, from a closed list. */
export interface RunRequestOptions {
  headed: boolean;
  trace?: 'on' | 'retain-on-failure';
  repeatEach?: number;
  workers?: number;
  /** One Playwright project for every test, among those the instance recorded for them. */
  project?: string;
}

/** What the request came from: for the target's branch check, and for an issue filed from the run. */
export interface RunRequestSource {
  runId?: number;
  executionId?: number;
  branch?: string;
  commit?: string;
}

/** A request as a target receives it. */
export interface RunRequest {
  id: string;
  kind: RunRequestKind;
  projectId: number;
  tests: RunRequestTest[];
  options: RunRequestOptions;
  source: RunRequestSource;
}

export type RunRequestParse<T> = { ok: true; value: T } | { ok: false; problems: string[] };

const MAX_PATH_CHARS = 500;
const MAX_TITLE_CHARS = 500;
const MAX_BRANCH_CHARS = 255;
const PLAYWRIGHT_PROJECT = /^[\w .:@/+-]{1,100}$/;
const COMMIT = /^[0-9a-f]{7,40}$/i;
const MAX_ID = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a spec path stays inside the folder of the Playwright config: no leading `-`, `/` or `\`, no drive
 * letter, no `..` segment and no NUL character.
 */
export function isRelativeSpecPath(path: string): boolean {
  return (
    path.length > 0 &&
    !/^[-/\\]/.test(path) &&
    !/^[a-z]:/i.test(path) &&
    !path.split(/[\\/]/).includes('..') &&
    !path.includes('\0')
  );
}

/** Whether a value is a Playwright project name a request may carry. */
export function isRunRequestProjectName(value: unknown): value is string {
  return typeof value === 'string' && PLAYWRIGHT_PROJECT.test(value);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_ID;
}

function inRange(value: unknown, range: { min: number; max: number }): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max;
}

function unknownFields(value: Record<string, unknown>, known: readonly string[], at: string, problems: string[]) {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) problems.push(`${at}${key} is not a field of a run request.`);
  }
}

const OPTION_FIELDS = ['headed', 'trace', 'repeatEach', 'workers', 'project'] as const;

function readOptions(value: unknown, at: string, problems: string[]): RunRequestOptions {
  const options: RunRequestOptions = { headed: true };
  if (value === undefined) return options;
  if (!isRecord(value)) {
    problems.push(`${at} must be an object.`);
    return options;
  }
  unknownFields(value, OPTION_FIELDS, `${at}.`, problems);
  const { headed, trace, repeatEach, workers, project } = value;
  if (headed !== undefined) {
    if (typeof headed === 'boolean') options.headed = headed;
    else problems.push(`${at}.headed must be true or false.`);
  }
  if (trace !== undefined) {
    if (trace === 'on' || trace === 'retain-on-failure') options.trace = trace;
    else problems.push(`${at}.trace must be 'on' or 'retain-on-failure'.`);
  }
  if (repeatEach !== undefined) {
    const { min, max } = RUN_REQUEST_LIMITS.repeatEach;
    if (inRange(repeatEach, RUN_REQUEST_LIMITS.repeatEach)) options.repeatEach = repeatEach;
    else problems.push(`${at}.repeatEach must be a whole number from ${min} to ${max}.`);
  }
  if (workers !== undefined) {
    const { min, max } = RUN_REQUEST_LIMITS.workers;
    if (inRange(workers, RUN_REQUEST_LIMITS.workers)) options.workers = workers;
    else problems.push(`${at}.workers must be a whole number from ${min} to ${max}.`);
  }
  if (project !== undefined) {
    if (isRunRequestProjectName(project)) options.project = project;
    else problems.push(`${at}.project is not a Playwright project name.`);
  }
  return options;
}

/**
 * The options of a request, read from untrusted input: an unknown field or a value out of bounds is a problem, and
 * `headed` defaults to true.
 */
export function parseRunRequestOptions(value: unknown): RunRequestParse<RunRequestOptions> {
  const problems: string[] = [];
  const options = readOptions(value, 'options', problems);
  return problems.length ? { ok: false, problems } : { ok: true, value: options };
}

const TEST_FIELDS = ['filePath', 'title', 'line', 'projectName'] as const;

function readTest(value: unknown, at: string, problems: string[]): RunRequestTest | null {
  if (!isRecord(value)) {
    problems.push(`${at} must be an object.`);
    return null;
  }
  const before = problems.length;
  unknownFields(value, TEST_FIELDS, `${at}.`, problems);
  const { filePath, title, line, projectName } = value;
  if (typeof filePath !== 'string' || filePath.length > MAX_PATH_CHARS || !isRelativeSpecPath(filePath)) {
    problems.push(`${at}.filePath must be a spec path relative to the Playwright config.`);
  }
  if (typeof title !== 'string' || title.length > MAX_TITLE_CHARS || title.includes('\0')) {
    problems.push(`${at}.title must be a test title of at most ${MAX_TITLE_CHARS} characters.`);
  }
  if (line !== null && line !== undefined && !isId(line)) problems.push(`${at}.line must be a line number or null.`);
  if (projectName !== null && projectName !== undefined && !isRunRequestProjectName(projectName)) {
    problems.push(`${at}.projectName is not a Playwright project name.`);
  }
  if (problems.length > before) return null;
  return {
    filePath: filePath as string,
    title: title as string,
    line: (line as number | null | undefined) ?? null,
    projectName: (projectName as string | null | undefined) ?? null,
  };
}

const SOURCE_FIELDS = ['runId', 'executionId', 'branch', 'commit'] as const;

function readSource(value: unknown, at: string, problems: string[]): RunRequestSource {
  const source: RunRequestSource = {};
  if (value === undefined) return source;
  if (!isRecord(value)) {
    problems.push(`${at} must be an object.`);
    return source;
  }
  unknownFields(value, SOURCE_FIELDS, `${at}.`, problems);
  const { runId, executionId, branch, commit } = value;
  if (runId !== undefined) {
    if (isId(runId)) source.runId = runId;
    else problems.push(`${at}.runId must be a run id.`);
  }
  if (executionId !== undefined) {
    if (isId(executionId)) source.executionId = executionId;
    else problems.push(`${at}.executionId must be an execution id.`);
  }
  if (branch !== undefined) {
    if (
      typeof branch === 'string' &&
      branch.length > 0 &&
      branch.length <= MAX_BRANCH_CHARS &&
      !branch.includes('\0')
    ) {
      source.branch = branch;
    } else problems.push(`${at}.branch must be a branch name.`);
  }
  if (commit !== undefined) {
    if (typeof commit === 'string' && COMMIT.test(commit)) source.commit = commit;
    else problems.push(`${at}.commit must be a commit SHA.`);
  }
  return source;
}

const REQUEST_FIELDS = ['id', 'kind', 'projectId', 'tests', 'options', 'source'] as const;

/**
 * A request read from untrusted input, rebuilt field by field. It refuses an unknown field, a kind this version does
 * not know, a spec path that leaves the config's folder, a value out of bounds, and fewer than 1 or more than 200
 * tests, naming each problem.
 */
export function parseRunRequest(value: unknown): RunRequestParse<RunRequest> {
  if (!isRecord(value)) return { ok: false, problems: ['A run request must be an object.'] };
  const problems: string[] = [];
  unknownFields(value, REQUEST_FIELDS, '', problems);
  const { id, kind, projectId, tests, options, source } = value;
  if (typeof id !== 'string' || !RUN_REQUEST_ID.test(id)) problems.push('id must be 32 lowercase hex digits.');
  if (!(RUN_REQUEST_KINDS as readonly unknown[]).includes(kind)) {
    problems.push(`kind ${JSON.stringify(kind)} is not a kind this version knows: update to run it.`);
  }
  if (!isId(projectId)) problems.push('projectId must be a project id.');

  const parsedTests: RunRequestTest[] = [];
  const { min, max } = RUN_REQUEST_LIMITS.tests;
  if (!Array.isArray(tests) || tests.length < min || tests.length > max) {
    problems.push(`tests must list ${min} to ${max} tests.`);
  } else {
    tests.forEach((test, i) => {
      const parsed = readTest(test, `tests[${i}]`, problems);
      if (parsed) parsedTests.push(parsed);
    });
  }
  const parsedOptions = readOptions(options, 'options', problems);
  const parsedSource = readSource(source, 'source', problems);

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    value: {
      id: id as string,
      kind: kind as RunRequestKind,
      projectId: projectId as number,
      tests: parsedTests,
      options: parsedOptions,
      source: parsedSource,
    },
  };
}
