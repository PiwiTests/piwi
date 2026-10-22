/**
 * Playwright blob-report reader.
 *
 * A blob report is a ZIP holding `report.jsonl` — the reporter event stream
 * Playwright replays when merging shards — plus a `resources/<sha1>.<ext>`
 * entry per attachment (traces, screenshots, videos). Reading it lets a team
 * import runs recorded before they adopted Piwi.
 *
 * The format is internal to Playwright and shifts between releases, so parsing
 * is deliberately tolerant: unknown events are ignored, malformed lines are
 * skipped, and only `onBlobReportMetadata.version` is enforced. Everything the
 * parser produces is shaped for `persistRunCases`, and the derived fields
 * (statuses, step metrics, error text) come from the same `@piwitests/core`
 * helpers the live reporter uses, so an imported run is indistinguishable from
 * a reported one wherever the data exists.
 */

import {
  collectStepMetrics,
  extractTestStepEvents,
  extractWaitEvents,
  type TestErrorLike,
} from '#shared/step-analysis';
import { dirnamePosix, isAbsolutePosix, joinPosix, normalizePosix, relativePosix } from '#shared/utils/posix-path';
import { classifyStatus, expectedFailureError, mergeAnnotations } from '#shared/status-classify';
import { normalizeTestTags, parseTestMetadata } from '@piwitests/core/test-meta';
import { joinErrorMessages, appendErrorLocation } from '#shared/error-text';
import type { TestAnnotation } from '#shared/types';
import type { RunCaseInput } from './persist-run-cases';

/**
 * Reads one entry out of the archive, or null when it is absent or unreadable.
 * Injected so the same parser serves the server (node zlib) and demo mode (the
 * browser's `DecompressionStream`).
 */
export type ArchiveEntryReader = (name: string) => Promise<Uint8Array | null>;

/**
 * `onBlobReportMetadata.version` values this parser understands. Playwright
 * refuses to merge across versions for the same reason: the event shapes are
 * not compatible. A newer archive fails loudly rather than importing garbage.
 */
export const SUPPORTED_BLOB_VERSIONS = [1, 2];

/** Raised for an archive we can recognise but not import. */
export class BlobReportError extends Error {}

/** One attachment still sitting inside the archive, to be read on demand. */
export interface BlobAttachmentRef {
  /** Entry name inside the archive (`resources/<sha1>.<ext>`). */
  entry: string;
  /** Playwright attachment name (`trace`, `screenshot`, `video`, …). */
  name: string;
  contentType: string;
}

/** A test execution ready to persist, with its files still unread. */
export interface ImportedRunCase {
  case: RunCaseInput;
  /** Attachments named `trace` — stored as deduped trace blobs. */
  traces: BlobAttachmentRef[];
  /** Everything else — stored as per-case attachment files. */
  attachments: BlobAttachmentRef[];
}

export interface ParsedBlobReport {
  blobVersion: number;
  playwrightVersion: string | null;
  startTime: Date;
  duration: number | null;
  /** Run status in Piwi's vocabulary (`passed` / `failed` / `timedout` / `interrupted`). */
  status: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  timedOutTests: number;
  skippedTests: number;
  didNotRunTests: number;
  flakyTests: number;
  /** Playwright `--shard` config when the archive is one shard of a larger run. */
  shard: { current: number; total: number } | null;
  /** Playwright project (browser) names present in the archive. */
  projectNames: string[];
  /** The commit and branch Playwright's git info recorded in the config metadata, when it did. */
  scm: BlobScm | null;
  cases: ImportedRunCase[];
}

/** The source revision a blob report ran against. */
export interface BlobScm {
  commit: string | null;
  branch: string | null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The commit and branch in a blob report's `config.metadata`: Playwright's git
 * info (`captureGitInfo`) writes `ci` (the CI provider's view: the pull
 * request's head branch) and `gitCommit` (the checkout's), and older versions
 * a flat `revision.id`. The CI provider's branch wins, since a CI checkout is
 * usually a detached HEAD.
 */
export function readBlobScm(metadata: unknown): BlobScm | null {
  const meta = record(metadata);
  const ci = record(meta.ci);
  const gitCommit = record(meta.gitCommit);
  const commit = nonEmptyString(ci.commitHash) ?? nonEmptyString(gitCommit.hash) ?? nonEmptyString(meta['revision.id']);
  const branch = nonEmptyString(ci.branch) ?? nonEmptyString(gitCommit.branch);
  return commit || branch ? { commit, branch } : null;
}

/** A step being assembled from its `onStepBegin` / `onStepEnd` pair. */
interface StepNode {
  title: string;
  category: string;
  subtitle?: string;
  params?: Record<string, unknown>;
  startTime: number;
  duration: number;
  location?: { file: string; line: number; column: number };
  error?: { message?: string; location?: { file: string; line: number; column: number } };
  steps: StepNode[];
}

/** Everything accumulated for one `(testId, resultId)` execution. */
interface ResultAccumulator {
  testId: string;
  retry: number;
  workerIndex: number | null;
  startedAt: number | null;
  rootSteps: StepNode[];
  stepsById: Map<string, StepNode>;
  traces: BlobAttachmentRef[];
  attachments: BlobAttachmentRef[];
}

/** A test as declared in the `onProject` suite tree. */
interface PlannedTest {
  title: string;
  filePath: string;
  line: number | null;
  column: number | null;
  suitePath: string[];
  annotations: TestAnnotation[];
  tags: string[];
  timeout: number | null;
  /** Playwright's `repeatEachIndex`: each `--repeat-each` repetition is a test of its own. */
  repeatEachIndex: number;
  projectName: string;
  browser: Record<string, unknown>;
}

/**
 * Resolve the paths recorded in an archive back to the repo-relative form the
 * reporter writes for live runs, so imported executions land on the same
 * `test_cases` rows as everything reported since.
 *
 * Playwright records test locations relative to `config.rootDir` and error
 * locations as absolute paths, while the reporter resolves both against the
 * working directory — which for any normal invocation is the directory holding
 * the config file. `config.configFile` is recorded relative to `rootDir`, so
 * its directory recovers that base.
 */
function createPathResolver(config: Record<string, unknown>, pathSeparator: string) {
  const toPosix = (p: string) => (pathSeparator === '\\' ? p.split('\\').join('/') : p);

  const rootDir = typeof config.rootDir === 'string' ? toPosix(config.rootDir) : '';
  const configFile = typeof config.configFile === 'string' ? toPosix(config.configFile) : null;
  const baseDir = configFile ? normalizePosix(joinPosix(rootDir, dirnamePosix(configFile))) : rootDir;

  /** Make a path relative to `baseDir`, keeping the input when it escapes it. */
  const relativize = (absolute: string, fallback: string) => {
    if (!baseDir) return fallback;
    const rel = relativePosix(baseDir, absolute);
    return !rel || rel.startsWith('..') ? fallback : rel;
  };

  return {
    /** A test/step location, recorded relative to `rootDir`. */
    fromRoot(file: string): string {
      const normalized = toPosix(file);
      if (isAbsolutePosix(normalized)) return relativize(normalized, normalized);
      return relativize(joinPosix(rootDir, normalized), normalized);
    },
    /** An error location, recorded as an absolute path. */
    fromAbsolute(file: string): string {
      const normalized = toPosix(file);
      return relativize(normalized, normalized);
    },
  };
}

type PathResolver = ReturnType<typeof createPathResolver>;

/** Read and JSON-parse `report.jsonl`, skipping lines that do not parse. */
async function readEvents(readEntry: ArchiveEntryReader): Promise<Record<string, unknown>[]> {
  const bytes = await readEntry('report.jsonl');
  if (!bytes) {
    throw new BlobReportError(
      'No report.jsonl found in the archive. Upload a Playwright blob report (blob-report/report-*.zip), not an HTML report or a trace file.',
    );
  }

  const text = new TextDecoder().decode(bytes);
  const events: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed as Record<string, unknown>);
    } catch {
      // A truncated tail line is expected when a run was killed mid-write.
    }
  }
  return events;
}

/**
 * Walk one project's suite tree into a flat `testId → PlannedTest` map.
 * Suites nest as `file suite → describe suites → tests`; only describe titles
 * make up the suite path, matching what the reporter derives for live runs.
 */
function collectPlannedTests(
  project: Record<string, unknown>,
  resolver: PathResolver,
  into: Map<string, PlannedTest>,
): void {
  const projectName = typeof project.name === 'string' ? project.name : '';
  const use = (project.use ?? {}) as Record<string, unknown>;
  const browser: Record<string, unknown> = { projectName };
  for (const key of ['browserName', 'channel', 'viewport', 'locale', 'timezoneId', 'userAgent'] as const) {
    if (use[key] !== undefined) browser[key] = use[key];
  }
  const projectTimeout = typeof project.timeout === 'number' ? project.timeout : null;

  // v2 nests everything under `entries`; older archives split `suites`/`tests`.
  const childrenOf = (node: Record<string, unknown>): Record<string, unknown>[] => {
    if (Array.isArray(node.entries)) return node.entries as Record<string, unknown>[];
    return [
      ...((node.suites as Record<string, unknown>[] | undefined) ?? []),
      ...((node.tests as Record<string, unknown>[] | undefined) ?? []),
    ];
  };

  const walk = (node: Record<string, unknown>, suitePath: string[]) => {
    for (const child of childrenOf(node)) {
      if (typeof child.testId === 'string') {
        const location = (child.location ?? {}) as Record<string, unknown>;
        const file = typeof location.file === 'string' ? location.file : '';
        into.set(child.testId, {
          title: typeof child.title === 'string' ? child.title : '',
          filePath: file ? resolver.fromRoot(file) : 'unknown',
          line: typeof location.line === 'number' ? location.line : null,
          column: typeof location.column === 'number' ? location.column : null,
          suitePath,
          annotations: Array.isArray(child.annotations) ? (child.annotations as TestAnnotation[]) : [],
          tags: normalizeTestTags(child.tags),
          timeout: typeof child.timeout === 'number' ? child.timeout : projectTimeout,
          repeatEachIndex: typeof child.repeatEachIndex === 'number' ? child.repeatEachIndex : 0,
          projectName,
          browser,
        });
      } else {
        walk(child, [...suitePath, typeof child.title === 'string' ? child.title : '']);
      }
    }
  };

  // Iteration starts inside each file suite: its title is the spec file name,
  // not a describe block, so it never enters the suite path — every suite below
  // it does.
  for (const fileSuite of (project.suites as Record<string, unknown>[] | undefined) ?? []) {
    walk(fileSuite, []);
  }
}

/** Build the step tree for an execution from its begin/end event pair. */
function applyStepBegin(acc: ResultAccumulator, step: Record<string, unknown>, resolver: PathResolver): void {
  const id = typeof step.id === 'string' ? step.id : null;
  if (!id) return;

  const location = step.location as Record<string, unknown> | undefined;
  const node: StepNode = {
    title: typeof step.title === 'string' ? step.title : '',
    category: typeof step.category === 'string' ? step.category : '',
    startTime: typeof step.startTime === 'number' ? step.startTime : 0,
    duration: 0,
    steps: [],
  };
  if (typeof step.subtitle === 'string' && step.subtitle.length > 0) node.subtitle = step.subtitle;
  if (step.params && typeof step.params === 'object' && !Array.isArray(step.params))
    node.params = step.params as Record<string, unknown>;
  if (typeof location?.file === 'string') {
    node.location = {
      file: resolver.fromRoot(location.file),
      line: typeof location.line === 'number' ? location.line : 0,
      column: typeof location.column === 'number' ? location.column : 0,
    };
  }

  acc.stepsById.set(id, node);
  const parent = typeof step.parentStepId === 'string' ? acc.stepsById.get(step.parentStepId) : undefined;
  if (parent) parent.steps.push(node);
  else acc.rootSteps.push(node);
}

function applyStepEnd(acc: ResultAccumulator, step: Record<string, unknown>, resolver: PathResolver): void {
  const id = typeof step.id === 'string' ? step.id : null;
  const node = id ? acc.stepsById.get(id) : undefined;
  if (!node) return;
  if (typeof step.duration === 'number') node.duration = step.duration;
  const error = step.error as Record<string, unknown> | undefined;
  if (typeof error?.message === 'string') {
    node.error = { message: error.message };
    const location = errorLocation(error, resolver);
    if (location) node.error.location = location;
  }
}

/** Where a recorded error was thrown, its path resolved the way the error text's frame is. */
function errorLocation(
  error: Record<string, unknown> | undefined,
  resolver: PathResolver,
): { file: string; line: number; column: number } | undefined {
  const location = error?.location as Record<string, unknown> | undefined;
  if (typeof location?.file !== 'string') return undefined;
  return {
    file: resolver.fromAbsolute(location.file),
    line: typeof location.line === 'number' ? location.line : 0,
    column: typeof location.column === 'number' ? location.column : 0,
  };
}

/** A result's errors, their locations resolved like the steps' own errors. */
function resultErrors(errors: unknown, resolver: PathResolver): TestErrorLike[] {
  if (!Array.isArray(errors)) return [];
  return (errors as Array<Record<string, unknown>>).map((error) => ({
    message: typeof error?.message === 'string' ? error.message : undefined,
    location: errorLocation(error, resolver),
  }));
}

/** Split an execution's attachments into traces and everything else. */
function applyAttachments(acc: ResultAccumulator, attachments: unknown): void {
  if (!Array.isArray(attachments)) return;
  for (const raw of attachments as Record<string, unknown>[]) {
    // An inline `body` attachment carries no archive entry — nothing to store.
    if (typeof raw.path !== 'string' || !raw.path) continue;
    const ref: BlobAttachmentRef = {
      entry: raw.path,
      name: typeof raw.name === 'string' ? raw.name : 'attachment',
      contentType: typeof raw.contentType === 'string' ? raw.contentType : 'application/octet-stream',
    };
    if (ref.name === 'trace') acc.traces.push(ref);
    else acc.attachments.push(ref);
  }
}

/** Assemble the error text for an execution, matching the reporter's rules. */
function buildErrorText(errors: unknown, resolver: PathResolver): string | null {
  if (!Array.isArray(errors)) return null;
  const text = joinErrorMessages(errors as Array<{ message?: string }>);
  if (!text) return null;

  const location = errorLocation(errors[0] as Record<string, unknown> | undefined, resolver);
  return location ? appendErrorLocation(text, location) : text;
}

/**
 * Parse a Playwright blob-report ZIP into a run plus its executions.
 *
 * Attachment bytes stay in the archive: the returned refs name their entries so
 * the caller can read them one at a time and keep peak memory bounded.
 */
export async function parseBlobReport(readEntry: ArchiveEntryReader): Promise<ParsedBlobReport> {
  const events = await readEvents(readEntry);

  const metadataEvent = events.find((e) => e.method === 'onBlobReportMetadata');
  const blobVersion = Number((metadataEvent?.params as Record<string, unknown> | undefined)?.version ?? 1);
  if (!SUPPORTED_BLOB_VERSIONS.includes(blobVersion)) {
    throw new BlobReportError(
      `Unsupported blob report version ${blobVersion}. This Piwi build reads versions ${SUPPORTED_BLOB_VERSIONS.join(' and ')}.`,
    );
  }
  const pathSeparator = String((metadataEvent?.params as Record<string, unknown> | undefined)?.pathSeparator ?? '/');

  const configEvent = events.find((e) => e.method === 'onConfigure');
  const config = ((configEvent?.params as Record<string, unknown> | undefined)?.config ?? {}) as Record<
    string,
    unknown
  >;
  const resolver = createPathResolver(config, pathSeparator);

  const planned = new Map<string, PlannedTest>();
  const results = new Map<string, ResultAccumulator>();
  const cases: ImportedRunCase[] = [];
  /** Final status per test, in report order, to derive the flaky count. */
  const attemptsByTest = new Map<string, string[]>();

  let runStartTime: number | null = null;
  let runDuration: number | null = null;
  let runStatus = 'passed';

  for (const event of events) {
    const method = event.method as string;
    const params = (event.params ?? {}) as Record<string, unknown>;

    if (method === 'onProject') {
      const project = params.project as Record<string, unknown> | undefined;
      if (project) collectPlannedTests(project, resolver, planned);
      continue;
    }

    if (method === 'onTestBegin') {
      const result = (params.result ?? {}) as Record<string, unknown>;
      const resultId = typeof result.id === 'string' ? result.id : null;
      const testId = typeof params.testId === 'string' ? params.testId : null;
      if (!resultId || !testId) continue;
      results.set(resultId, {
        testId,
        retry: typeof result.retry === 'number' ? result.retry : 0,
        workerIndex: typeof result.workerIndex === 'number' ? result.workerIndex : null,
        startedAt: typeof result.startTime === 'number' ? result.startTime : null,
        rootSteps: [],
        stepsById: new Map(),
        traces: [],
        attachments: [],
      });
      continue;
    }

    if (method === 'onStepBegin' || method === 'onStepEnd') {
      const acc = typeof params.resultId === 'string' ? results.get(params.resultId) : undefined;
      const step = params.step as Record<string, unknown> | undefined;
      if (!acc || !step) continue;
      if (method === 'onStepBegin') applyStepBegin(acc, step, resolver);
      else applyStepEnd(acc, step, resolver);
      // A step's own attachments ride its end event in newer archives.
      if (method === 'onStepEnd') applyAttachments(acc, step.attachments);
      continue;
    }

    if (method === 'onAttach') {
      const acc = typeof params.resultId === 'string' ? results.get(params.resultId) : undefined;
      if (acc) applyAttachments(acc, params.attachments);
      continue;
    }

    if (method === 'onTestEnd') {
      const test = (params.test ?? {}) as Record<string, unknown>;
      const result = (params.result ?? {}) as Record<string, unknown>;
      const resultId = typeof result.id === 'string' ? result.id : null;
      const acc = resultId ? results.get(resultId) : undefined;
      const testId = typeof test.testId === 'string' ? test.testId : acc?.testId;
      if (!testId) continue;

      const plan = planned.get(testId);
      const annotations = mergeAnnotations(
        { annotations: (test.annotations as TestAnnotation[] | undefined) ?? plan?.annotations },
        { annotations: result.annotations as TestAnnotation[] | undefined },
      );
      const rawStatus = String(result.status ?? 'failed');
      const status = classifyStatus(rawStatus, annotations);

      const metrics = collectStepMetrics(acc?.rootSteps ?? [], resultErrors(result.errors, resolver));
      const stepEvents = [
        ...extractTestStepEvents(acc?.rootSteps ?? [], new Date(acc?.startedAt ?? 0)),
        ...extractWaitEvents(acc?.rootSteps ?? []),
      ];

      cases.push({
        case: {
          filePath: plan?.filePath ?? 'unknown',
          suitePath: plan?.suitePath ?? null,
          testAnnotations: annotations.length ? annotations : null,
          tags: plan?.tags.length ? plan.tags : null,
          testMeta: parseTestMetadata(annotations),
          title: plan?.title ?? '',
          status,
          duration: typeof result.duration === 'number' ? result.duration : null,
          timeout: typeof test.timeout === 'number' ? test.timeout : (plan?.timeout ?? null),
          // A `test.fail()` test that passed is now `failed` with no recorded
          // error; Playwright reports the same line, so synthesize it.
          error: expectedFailureError(rawStatus, annotations) ?? buildErrorText(result.errors, resolver),
          expectedStatus: typeof test.expectedStatus === 'string' ? test.expectedStatus : null,
          retries: acc?.retry ?? 0,
          repeatEachIndex: plan?.repeatEachIndex ?? 0,
          line: plan?.line ?? null,
          column: plan?.column ?? null,
          steps: metrics.steps.length ? metrics.steps : null,
          stepEvents: stepEvents.length ? stepEvents : null,
          slowestStep: metrics.slowestStep?.title ?? null,
          slowestStepDuration: metrics.slowestStep?.duration ?? null,
          wastedTimeMs: metrics.waitTotalDuration,
          workerIndex: acc?.workerIndex ?? null,
          startedAt: acc?.startedAt ?? null,
          browser: plan?.browser ?? null,
        },
        traces: acc?.traces ?? [],
        attachments: acc?.attachments ?? [],
      });

      const attempts = attemptsByTest.get(testId) ?? [];
      attempts.push(status);
      attemptsByTest.set(testId, attempts);

      if (resultId) results.delete(resultId);
      continue;
    }

    if (method === 'onEnd') {
      const result = (params.result ?? {}) as Record<string, unknown>;
      if (typeof result.startTime === 'number') runStartTime = result.startTime;
      if (typeof result.duration === 'number') runDuration = Math.round(result.duration);
      if (typeof result.status === 'string') runStatus = result.status;
    }
  }

  // Tests Playwright planned but never reported — cut short by `maxFailures`,
  // or belonging to a shard this archive does not cover.
  for (const [testId, plan] of planned) {
    if (attemptsByTest.has(testId)) continue;
    cases.push({
      case: {
        filePath: plan.filePath,
        suitePath: plan.suitePath,
        testAnnotations: plan.annotations.length ? plan.annotations : null,
        tags: plan.tags.length ? plan.tags : null,
        testMeta: parseTestMetadata(plan.annotations),
        title: plan.title,
        status: 'didnotrun',
        duration: 0,
        timeout: plan.timeout,
        error: null,
        retries: 0,
        repeatEachIndex: plan.repeatEachIndex,
        line: plan.line,
        column: plan.column,
        browser: plan.browser,
      },
      traces: [],
      attachments: [],
    });
    attemptsByTest.set(testId, ['didnotrun']);
  }

  const shardConfig = config.shard as Record<string, unknown> | null | undefined;
  const shard =
    shardConfig && typeof shardConfig.total === 'number' && shardConfig.total > 1
      ? { current: Number(shardConfig.current ?? 1), total: shardConfig.total }
      : null;

  if (shard) {
    for (const entry of cases) entry.case.shardIndex = shard.current;
  }

  const counts = { passed: 0, failed: 0, timedOut: 0, skipped: 0, didNotRun: 0 };
  for (const entry of cases) {
    if (entry.case.status === 'passed') counts.passed++;
    else if (entry.case.status === 'timedOut') counts.timedOut++;
    else if (entry.case.status === 'skipped') counts.skipped++;
    else if (entry.case.status === 'didnotrun') counts.didNotRun++;
    else counts.failed++;
  }

  // Flaky: an earlier attempt failed and the last one passed.
  let flakyTests = 0;
  for (const attempts of attemptsByTest.values()) {
    if (attempts.length < 2) continue;
    const last = attempts.at(-1);
    if (last === 'passed' && attempts.slice(0, -1).some((s) => s === 'failed' || s === 'timedOut')) flakyTests++;
  }

  const projectNames = [...new Set([...planned.values()].map((p) => p.projectName).filter(Boolean))];

  return {
    blobVersion,
    playwrightVersion: typeof config.version === 'string' ? config.version : null,
    startTime: new Date(runStartTime && runStartTime > 0 ? runStartTime : Date.now()),
    duration: runDuration,
    status: runStatus,
    totalTests: cases.length,
    passedTests: counts.passed,
    failedTests: counts.failed,
    timedOutTests: counts.timedOut,
    skippedTests: counts.skipped,
    didNotRunTests: counts.didNotRun,
    flakyTests,
    shard,
    projectNames,
    scm: readBlobScm(config.metadata),
    cases,
  };
}
