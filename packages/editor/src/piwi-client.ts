/**
 * The requests the editor service makes to a Piwi instance. Every read is a
 * GET with the `pd_` key in `X-API-Key`; nothing from the workspace is sent
 * but file paths the index already holds.
 */
import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { LocatorIndex, LocatorIndexTest } from '@piwitests/core/locator-index';
import type { CoverageFile, CoverageRuntime, LineRange } from '@piwitests/core/coverage';
import type { TestFunctionEntry } from '@piwitests/core/function-match';
import type { LocatorHealingResult, RankedLocator } from '@piwitests/core/locator-healing-types';
import type { PiwiConnection } from '@piwitests/core/dotenv';
import type { BisectResultBody } from '@piwitests/core/bisect';
import type { DesktopJobRequest, DesktopJobVerdict, FlakeLabJobPlan } from '@piwitests/core/desktop-job';
import type { TimeoutAdvice } from './analysis.js';
import { instanceFetch } from './http.js';

const TIMEOUT_MS = 15_000;
/** How long a stored file may take to download: a trace can weigh tens of megabytes. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

export class PiwiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PiwiHttpError';
  }
}

/**
 * The code index: the source files the project's tests reach. Each reach names where the code ran (`runtime`) and how
 * the reach is known (`via`: `coverage` when the tests' coverage recorded the file, `route` when inferred from the
 * routes they called); an older instance sends `origin` alone.
 */
export interface CodeIndex {
  files: string[];
  tests: LocatorIndexTest[];
  reach: Array<{
    file: number;
    tests: number[];
    origin: 'client' | 'server';
    runtime?: 'browser' | 'server';
    via?: 'coverage' | 'route';
  }>;
  builtAt: string | null;
  truncated: boolean;
}

/** One coverage of a file as tests recorded it, and the tests that recorded it: positions in `FileCoverage.tests`. */
export interface CoverageFragment extends CoverageFile {
  tests: number[];
}

/**
 * A file's coverage on a branch (`GET /api/projects/:id/coverage?file=`): each distinct coverage of the file the tests
 * recorded (a version of the file, by its git blob id, and the functions and lines that ran), the tests, with their
 * latest outcome, and the executable lines of each version a run recorded them for, which an older instance does not
 * send.
 */
export interface FileCoverage {
  file: string;
  branch: string;
  fragments: CoverageFragment[];
  tests: LocatorIndexTest[];
  executable?: Array<{ path: string; runtime: CoverageRuntime; blob: string; lines: LineRange[] }>;
}

/** One test case of the catalog. */
export interface CatalogCase {
  id: number;
  title: string;
  filePath: string;
  /** Its `describe` blocks, outermost first, joined by `\x1f` (`Auth\x1fLogin`); empty outside any. */
  suitePath?: string | null;
  /** `passed`, `failed`, `flaky`, `skipped`, `didnotrun` or `never-run`, from the latest executions. */
  status?: string | null;
  totalRuns?: number;
  passedRuns?: number;
  failedRuns?: number;
  flakyRuns?: number;
}

/** The stored alternatives of one call site. */
export interface CallSiteAlternatives {
  testCaseId: number;
  location: string;
  method: string;
  alternatives: RankedLocator[];
  lastSeenAt: string;
}

/**
 * The latest complete run on a branch, the later runs of the branch laid over it, its failed executions as they stand
 * after them, and the failures they passed (`GET /api/projects/:id/branch-failures?overlays=1`). The fields an instance
 * older than the overlays does not send are optional.
 */
export interface BranchFailures {
  run: {
    id: number;
    status: string;
    branch: string | null;
    startTime: string;
    /** What launched it: `ci`, `ci-rerun`, `local`, `desktop`, `editor`… */
    origin?: string;
    /** The commit it ran at; null when the reporter recorded none. */
    commit?: string | null;
    totalTests: number;
    passedTests: number;
    failedTests: number;
    flakyTests: number;
    skippedTests: number;
  } | null;
  /** The finished runs of the branch started after `run`, whole or partial, newest first. */
  overlays?: Array<{
    id: number;
    status: string;
    /** What launched it: `ci`, `ci-rerun`, `local`, `desktop`, `editor`… */
    origin: string;
    isFullRun: boolean;
    startTime: string;
    commit: string | null;
    totalTests: number;
    passedTests: number;
    failedTests: number;
    flakyTests: number;
    skippedTests: number;
  }>;
  failures: Array<{
    executionId: number;
    testCaseId: number;
    clusterId?: number | null;
    title: string;
    file: string;
    line: number | null;
    status: string;
    headline: string | null;
    location: string | null;
    /** Absent from an instance older than the editor service. */
    message?: string | null;
    /** The error's frames outside `node_modules`, innermost first; absent from an instance older than the editor service. */
    frames?: string[];
    traces: string[];
    screenshot: string | null;
    /** `baseline` for an execution of `run`, `overlay` for one of `overlays`. */
    source?: 'baseline' | 'overlay';
    /** The run the execution belongs to. */
    runId?: number;
    /** The Playwright project; null when unknown. */
    browserName?: string | null;
    /** In milliseconds; null when not recorded. */
    duration?: number | null;
    /** A new regression in `run`, or, from an overlay, a test that did not fail on this project in `run`. */
    isNew?: boolean;
    clusterTitle?: string | null;
    owner?: string | null;
    /** What an overlay says about the test on another project: `passed on chromium in run #124`. */
    note?: string;
  }>;
  /** The failures of `run` an overlay passed since, on the same Playwright project. */
  resolved?: Array<{
    testCaseId: number;
    title: string;
    /** The spec file and the line of the `test(…)` call, as the passing run reported them. */
    file: string;
    line: number | null;
    browserName: string | null;
    /** The overlay that passed it, and its passing execution. */
    runId: number;
    executionId: number;
    /** The execution that failed in `run`. */
    baselineExecutionId: number;
  }>;
}

export type BranchFailure = BranchFailures['failures'][number];
export type BranchResolved = NonNullable<BranchFailures['resolved']>[number];

/** The fields the editor reads of a run's details (`GET /api/test-runs/:id`). */
export interface RunDetails {
  id: number;
  /** `running`, `initializing`, `finalizing`, or the final status. */
  status: string;
  branch: string | null;
  startTime: string;
  /** Holds what launched it, under `piwiOrigin`. */
  metadata?: Record<string, unknown> | null;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  didNotRunTests?: number;
  flakyTests?: number;
}

/** A flaky test as the flaky list ranks it (`GET /api/projects/:id/flaky-tests`). */
export interface FlakyTest {
  testCaseId: number;
  /** 1–100, from retry passes and pass/fail alternation. */
  score: number;
  /** CI minutes spent re-running it. */
  wastedCiMinutes: number;
  /** `timing`, `network`, `assertion`, `environment` or `other`; null when unclassified. */
  rootCause: string | null;
}

/** A test of the project's Flake Lab (`GET /api/projects/:id/flake-lab?suspects=true`). */
export interface FlakeLabEntry {
  testCaseId: number;
  /** `untested`, `not-reproduced`, `amplified`, `reproduced`, `still-fails`, `inconclusive`, `verified` or `flaked-again`. */
  state: string;
  /** The `piwi flake` command it needs next; null once its fix holds. */
  nextCommand: string | null;
  flaky: boolean;
  /** The condition that last reproduced it. */
  reproducedBy: string | null;
  /** Share of the runs read in which it failed at least once; absent from an older instance. */
  flakeRate?: number | null;
  /** The suspect it is shown with; absent from an older instance or past the instance's limit. */
  suspect?: { id: string; label: string; standing: string; lab: string } | null;
  /** How many of its suspects no experiment tested; absent from an older instance or past the instance's limit. */
  untestedSuspects?: number;
}

/**
 * A test's reproduce plan as the instance answers `GET /api/test-cases/:id/flake-plan`: the fields a Flake Lab job
 * runs, beside the suspects the command line prints.
 */
export type FlakePlan = Omit<FlakeLabJobPlan, 'suspects' | 'verifies'> & { suspects?: unknown[]; verifies?: unknown };

/** One arm's counts and conditions, as `POST /api/projects/:id/flake-lab/results` takes them. */
export interface FlakeArmResult {
  id: string;
  label: string;
  suspectId: string | null;
  conditions: unknown[];
  runs: number;
  matchingFailures: number;
  otherFailures: number;
  discardedRounds: number;
  stoppedEarly: boolean;
}

/** The body of `POST /api/projects/:id/flake-lab/results`. */
export interface FlakeResultsBody {
  experimentId: string;
  commit: string | null;
  playwrightProject: string | null;
  arms: FlakeArmResult[];
}

/** A ticket or page linked to a failure cluster or a test (`GET /api/links`). */
export interface EntityLink {
  url: string;
  /** Compact id, `PROJ-123` or `#456`. */
  key: string | null;
  title: string | null;
  statusText: string | null;
}

/** A quarantined test and its way out (`GET /api/projects/:id/quarantine`). */
export interface QuarantinedTest {
  testCaseId: number;
  /** How long it has been quarantined, in ms. */
  ageMs: number;
  consecutivePasses: number;
  releaseProposed: boolean;
}

/** The parts of a cluster's fix plan the editors use. */
export interface FixPlan {
  cluster: { id: number; title: string | null; signature: string };
  diagnosis: {
    summary: string | null;
    patch: string | null;
    patchValidation: { status: string; errors: string[] } | null;
  } | null;
  edits: Array<{
    filePath: string;
    line: number | null;
    suggestedLocator: string | null;
    edit: { filePath: string | null; line: number; oldLine: string; newLine: string } | null;
  }>;
  verify: { command: string; expectation: string };
}

/** What a reproduction of an execution needs on this machine (`desktop` of `GET /api/test-run-cases/:id/reproduce`). */
export interface ReproduceDesktop {
  cases: Array<{ filePath: string; title: string; line?: number | null; projectName?: string | null }>;
  browserName: string | null;
  commit: string | null;
  /** The bisect window: the last green commit and the failing one. */
  good: string | null;
  bad: string | null;
  clusterId: number | null;
}

/** A job request as the desktop app answers `GET /api/desktop/repro-requests/:id`. */
export interface DesktopJobState {
  id: string;
  status: 'waiting' | 'running' | 'done' | 'declined' | 'expired';
  jobVerdict: DesktopJobVerdict | null;
}

/**
 * The instance's answers, by instance, key and path: for a conditional request, the `ETag` the instance gave and the
 * value read with it; for a plain one, the value for a moment (`until`); for either, the request on its way. The
 * contexts of one service share it: the configs of a repository reading the same project share one index, read once,
 * and read the project's lists once per refresh.
 */
export type ResponseCache = Map<
  string,
  {
    etag?: string;
    value?: unknown;
    pending?: Promise<unknown>;
    /** Until when a plain answer is shared (ms since the epoch); absent from an index, kept by its `ETag`. */
    until?: number;
  }
>;

/** The indexes a `ResponseCache` keeps at most, by their `ETag`; the least recently used goes first. */
const MAX_ANSWERS = 16;
/** How long a plain answer is shared by the clients reading one instance, and how many are kept at most meanwhile. */
const SHARED_MS = 2_000;
const MAX_SHARED = 64;

/**
 * Drop the plain answers past their time, then the least recently used beyond what is kept of each kind, the indexes
 * and the plain answers; a request on its way stays.
 */
function trim(answers: ResponseCache): void {
  const now = Date.now();
  let indexes = 0;
  let shared = 0;
  // The newest come last: counted from the end, the entries beyond a cap are the oldest.
  for (const [key, entry] of [...answers].reverse()) {
    if (entry.pending) continue;
    if (entry.until === undefined) {
      if (++indexes > MAX_ANSWERS) answers.delete(key);
    } else if (entry.until <= now || ++shared > MAX_SHARED) {
      answers.delete(key);
    }
  }
}

/** Drop the plain answers shared for a moment: the reads that follow, together, read the instance as it stands. */
export function forgetShared(answers: ResponseCache): void {
  for (const [key, entry] of answers) if (entry.until !== undefined) answers.delete(key);
}

export class PiwiClient {
  /**
   * `answers` keeps what an `ETag` came with: the instance answers 304 while it holds, and the same value is used; a
   * plain answer for `SHARED_MS`; the same request on its way for another client is shared.
   */
  constructor(
    readonly connection: PiwiConnection,
    private readonly answers?: ResponseCache,
  ) {}

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await instanceFetch(`${this.connection.serverUrl}${path}`, {
      headers: this.connection.apiKey ? { 'X-API-Key': this.connection.apiKey } : {},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new PiwiHttpError(`${path} answered ${response.status}`, response.status);
    return (await response.json()) as T;
  }

  /** The key of a request's answer in `answers`: the instance, the key it is read with and the path. */
  private answerKey(path: string): string {
    return `${this.connection.serverUrl}\n${this.connection.apiKey ?? ''}\n${path}`;
  }

  /**
   * A GET whose request on its way, and its answer for `SHARED_MS`, the clients sharing `answers` reuse: the configs
   * of a repository reading one project read it once per refresh, each getting its own copy of the answer, as if it
   * had parsed it itself. `fresh`, for a run as it moves, shares the request on its way and keeps no answer. A request
   * that failed is shared by the callers that joined it alone. A plain GET without `answers`.
   */
  private async get<T>(path: string, fresh = false): Promise<T> {
    const answers = this.answers;
    if (!answers) return this.fetchJson<T>(path);
    const key = this.answerKey(path);
    const known = answers.get(key);
    if (known?.pending) return (known.pending as Promise<T>).then((value) => structuredClone(value));
    if (!fresh && known?.until !== undefined && known.until > Date.now()) return structuredClone(known.value as T);
    const pending = this.fetchJson<T>(path);
    // Awaited by the clients that share it, if any.
    pending.catch(() => {});
    answers.delete(key);
    answers.set(key, { pending });
    try {
      const value = await pending;
      if (answers.get(key)?.pending === pending) {
        if (fresh) answers.delete(key);
        else answers.set(key, { value, until: Date.now() + SHARED_MS });
      }
      trim(answers);
      return value;
    } catch (e) {
      if (answers.get(key)?.pending === pending) answers.delete(key);
      throw e;
    }
  }

  /** A GET answered from `answers` while the instance says it did not change; a plain GET without them. */
  private async getConditional<T>(path: string): Promise<T> {
    const answers = this.answers;
    if (!answers) return this.fetchJson<T>(path);
    const key = this.answerKey(path);
    const known = answers.get(key);
    if (known?.pending) return known.pending as Promise<T>;
    const asked = this.askKnown<T>(path, known?.etag ? { etag: known.etag, value: known.value as T } : null);
    const pending = asked.then((answer) => answer.value);
    // Awaited by the clients that share it, if any.
    pending.catch(() => {});
    answers.delete(key);
    answers.set(key, { ...known, pending });
    try {
      const answer = await asked;
      if (answer.etag) answers.set(key, { etag: answer.etag, value: answer.value });
      else answers.delete(key);
      trim(answers);
      return answer.value;
    } catch (e) {
      if (known?.etag) answers.set(key, { etag: known.etag, value: known.value });
      else answers.delete(key);
      throw e;
    }
  }

  /** A GET with the `ETag` of what is known: what is known when the instance answers 304. */
  private async askKnown<T>(
    path: string,
    known: { etag: string; value: T } | null,
  ): Promise<{ value: T; etag: string | null }> {
    const response = await instanceFetch(`${this.connection.serverUrl}${path}`, {
      headers: {
        ...(this.connection.apiKey ? { 'X-API-Key': this.connection.apiKey } : {}),
        ...(known ? { 'If-None-Match': known.etag } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 304 && known) return known;
    if (!response.ok) throw new PiwiHttpError(`${path} answered ${response.status}`, response.status);
    return { value: (await response.json()) as T, etag: response.headers.get('etag') };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await instanceFetch(`${this.connection.serverUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.connection.apiKey ? { 'X-API-Key': this.connection.apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new PiwiHttpError(`${path} answered ${response.status}`, response.status);
    return (await response.json()) as T;
  }

  /** The projects the key can open. */
  async projects(): Promise<Array<{ id: number; name: string }>> {
    const body = await this.get<{ items?: Array<{ id: number; name: string }> }>('/api/projects/menu');
    return body.items ?? [];
  }

  /** The project a name or a numeric id names; null when none does. */
  async resolveProject(project: string): Promise<{ id: number; name: string } | null> {
    const all = await this.projects();
    if (/^\d+$/.test(project))
      return all.find((p) => p.id === Number(project)) ?? { id: Number(project), name: project };
    return all.find((p) => p.name.toLowerCase() === project.toLowerCase()) ?? null;
  }

  locatorIndex(projectId: number, branch: string | null): Promise<LocatorIndex> {
    return this.getConditional(
      `/api/projects/${projectId}/locator-index${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`,
    );
  }

  codeIndex(projectId: number, branch: string | null): Promise<CodeIndex> {
    return this.getConditional(
      `/api/projects/${projectId}/code-index${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`,
    );
  }

  /**
   * A file's coverage (`file` repository-relative) on `branch`, the default branch when null, asked with the `ETag` of
   * `known`: `known` itself, the same object, when the instance answers 304.
   */
  fileCoverage(
    projectId: number,
    file: string,
    branch: string | null,
    known: { etag: string; value: FileCoverage } | null,
  ): Promise<{ value: FileCoverage; etag: string | null }> {
    const query = new URLSearchParams(branch ? { file, branch } : { file });
    return this.askKnown(`/api/projects/${projectId}/coverage?${query}`, known);
  }

  async testCases(projectId: number, file: string): Promise<CatalogCase[]> {
    const body = await this.get<{ items?: CatalogCase[] }>(
      `/api/projects/${projectId}/test-cases?limit=1000&file=${encodeURIComponent(file)}`,
    );
    return body.items ?? [];
  }

  async locatorAlternatives(projectId: number, file: string): Promise<CallSiteAlternatives[]> {
    const body = await this.get<{ items?: CallSiteAlternatives[] }>(
      `/api/projects/${projectId}/locator-alternatives?file=${encodeURIComponent(file)}`,
    );
    return body.items ?? [];
  }

  /** The Playwright arguments and command that run these tests, through the selection resolver. */
  async runArgs(projectId: number, testIds: number[]): Promise<{ args: string[]; command: string }> {
    const body = await this.post<{ materialization?: { args?: string[]; command?: string } }>(
      `/api/projects/${projectId}/selections/preview`,
      { definition: { include: [{ ids: testIds }] }, format: 'args' },
    );
    return { args: body.materialization?.args ?? [], command: body.materialization?.command ?? '' };
  }

  /**
   * The latest complete run on `branch` (any branch when null), with the later runs of its branch laid over it; with
   * `run`, that run instead; with `origin: 'local'`, a developer's own runs only, laid over none when no complete one
   * exists. An instance older than these answers as if they were absent. `fresh` reads the instance rather than the
   * answer shared for a moment.
   */
  branchFailures(
    projectId: number,
    branch: string | null,
    baseline: { run?: number; origin?: 'local' } = {},
    fresh = false,
  ): Promise<BranchFailures> {
    const query = new URLSearchParams(branch ? { branch, overlays: '1' } : { overlays: '1' });
    if (baseline.run !== undefined) query.set('run', String(baseline.run));
    if (baseline.origin) query.set('origin', baseline.origin);
    return this.get(`/api/projects/${projectId}/branch-failures?${query}`, fresh);
  }

  /** A run's details, with what launched it in its metadata, as it stands now. */
  runDetails(runId: number): Promise<RunDetails> {
    return this.get(`/api/test-runs/${runId}`, true);
  }

  /** The newest run of the project whose launcher stamped this origin and ref (`PIWI_ORIGIN_REF`); null when none. */
  latestRunByRef(projectId: number, origin: string, ref: string): Promise<{ id: number; status: string } | null> {
    const query = new URLSearchParams({ origin, ref });
    return this.get(`/api/projects/${projectId}/latest-run?${query}`, true);
  }

  /** The instance's run events (`GET /api/stream`): a response whose body is a server-sent events stream. */
  events(signal: AbortSignal): Promise<Response> {
    return this.stream('/api/stream', signal);
  }

  /** One run's events (`GET /api/test-runs/:id/stream`), until it ends. */
  runEvents(runId: number, signal: AbortSignal): Promise<Response> {
    return this.stream(`/api/test-runs/${runId}/stream`, signal);
  }

  /** A server-sent events stream, open until it ends or `signal` aborts. */
  private stream(path: string, signal: AbortSignal): Promise<Response> {
    return instanceFetch(`${this.connection.serverUrl}${path}`, {
      headers: {
        Accept: 'text/event-stream',
        ...(this.connection.apiKey ? { 'X-API-Key': this.connection.apiKey } : {}),
      },
      signal,
    });
  }

  locatorHealing(executionId: number): Promise<LocatorHealingResult> {
    return this.get(`/api/test-run-cases/${executionId}/locator-healing`);
  }

  /** The project's function catalog: the helpers and page-object methods recordings call. */
  async testFunctions(projectId: number): Promise<TestFunctionEntry[]> {
    const body = await this.get<{ testFunctions?: Array<{ entry?: TestFunctionEntry }> }>(
      `/api/projects/${projectId}/test-functions`,
    );
    return (body.testFunctions ?? []).map((row) => row.entry).filter((e): e is TestFunctionEntry => !!e);
  }

  /** A stored file's bytes (`/api/files/<path>`). */
  /** A stored file written to `target` as it arrives, through a partial file beside it renamed once complete. */
  async download(storedPath: string, target: string): Promise<void> {
    const encoded = storedPath.split('/').map(encodeURIComponent).join('/');
    const response = await instanceFetch(`${this.connection.serverUrl}/api/files/${encoded}`, {
      headers: this.connection.apiKey ? { 'X-API-Key': this.connection.apiKey } : {},
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new PiwiHttpError(`/api/files answered ${response.status}`, response.status);
    }
    const partial = `${target}.${process.pid}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body as WebReadableStream), fs.createWriteStream(partial));
      await fs.promises.rename(partial, target);
    } catch (e) {
      await fs.promises.rm(partial, { force: true });
      throw e;
    }
  }

  async flakyTests(projectId: number, branch: string | null): Promise<FlakyTest[]> {
    const body = await this.get<{ items?: FlakyTest[] }>(
      `/api/projects/${projectId}/flaky-tests${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`,
    );
    return body.items ?? [];
  }

  /** The project's Flake Lab tests, each with its top suspect. */
  async flakeLab(projectId: number, branch: string | null): Promise<FlakeLabEntry[]> {
    const query = new URLSearchParams({ suspects: 'true', limit: '1' });
    if (branch) query.set('branch', branch);
    const body = await this.get<{ tests?: FlakeLabEntry[] }>(`/api/projects/${projectId}/flake-lab?${query}`);
    return body.tests ?? [];
  }

  async links(entityType: 'failure_cluster' | 'test_case', entityId: number): Promise<EntityLink[]> {
    const body = await this.get<{ items?: EntityLink[] }>(`/api/links?entityType=${entityType}&entityId=${entityId}`);
    return body.items ?? [];
  }

  async quarantine(projectId: number): Promise<{ entries: QuarantinedTest[]; releaseAfter: number }> {
    const body = await this.get<{ entries?: QuarantinedTest[]; releaseAfterConsecutivePasses?: number }>(
      `/api/projects/${projectId}/quarantine?candidates=false`,
    );
    return { entries: body.entries ?? [], releaseAfter: body.releaseAfterConsecutivePasses ?? 0 };
  }

  /**
   * The tags and features the project's tests declare, and the Test Map's features. The catalog's search values hold
   * them for every test; an instance without them is read for its first thousand tests instead.
   */
  async vocabulary(projectId: number): Promise<{ tags: string[]; features: string[] }> {
    const [declared, map] = await Promise.all([
      this.get<{ values?: { tag?: Array<{ value: string }>; feature?: Array<{ value: string }> } }>(
        `/api/projects/${projectId}/test-cases/facets`,
      )
        .then((body) => ({
          tags: (body.values?.tag ?? []).map((t) => t.value),
          features: (body.values?.feature ?? []).map((f) => f.value),
        }))
        .catch(async (e: unknown) => {
          if (!(e instanceof PiwiHttpError && e.status === 404)) throw e;
          const catalog = await this.get<{ items?: Array<{ tags?: string[] | null; feature?: string | null }> }>(
            `/api/projects/${projectId}/test-cases?limit=1000`,
          );
          const items = catalog.items ?? [];
          return {
            tags: items.flatMap((item) => item.tags ?? []),
            features: items.flatMap((item) => (item.feature ? [item.feature] : [])),
          };
        })
        .catch(() => ({ tags: [], features: [] })),
      this.get<{ features?: Array<{ key: string }> }>(`/api/projects/${projectId}/feature-map`).catch(() => ({
        features: [],
      })),
    ]);
    const features = [...declared.features, ...(map.features ?? []).map((f) => f.key)];
    return { tags: [...new Set(declared.tags)].sort(), features: [...new Set(features)].sort() };
  }

  /**
   * The project's saved and built-in selections, the first `max` of them, each resolved now: its tests and the command
   * that runs them. One request resolves them all; an instance that lists them without resolving them is asked for
   * each in turn, and one it cannot resolve is left out.
   */
  async resolvedSelections(
    projectId: number,
    max: number,
  ): Promise<Array<{ key: string; name: string; testCaseIds: number[]; command: string }>> {
    const body = await this.get<{
      items?: Array<{
        key: string;
        name?: string | null;
        resolved?: { testCaseIds?: number[]; command?: string };
      }>;
    }>(`/api/projects/${projectId}/selections?resolve=true`);
    const found = await Promise.all(
      (body.items ?? []).slice(0, max).map(async (s) => {
        const name = s.name || s.key;
        if (s.resolved) {
          return { key: s.key, name, testCaseIds: s.resolved.testCaseIds ?? [], command: s.resolved.command ?? '' };
        }
        const one = await this.resolveSelection(projectId, s.key).catch(() => null);
        return one
          ? { key: s.key, name, testCaseIds: one.tests.map((t) => t.testCaseId), command: one.materialization.command }
          : null;
      }),
    );
    return found.filter((s): s is NonNullable<typeof s> => !!s);
  }

  /** A selection resolved now: its tests and the command that runs them. */
  private resolveSelection(
    projectId: number,
    key: string,
  ): Promise<{ tests: Array<{ testCaseId: number }>; materialization: { args: string[]; command: string } }> {
    return this.get(`/api/projects/${projectId}/selections/${encodeURIComponent(key)}/resolve`);
  }

  async timeoutOpportunities(projectId: number): Promise<TimeoutAdvice[]> {
    const body = await this.get<{ items?: TimeoutAdvice[] }>(`/api/projects/${projectId}/timeout-opportunities`);
    return body.items ?? [];
  }

  /** A failure cluster's page in the dashboard. */
  clusterUrl(clusterId: number): string {
    return `${this.connection.serverUrl}/failure-clusters/${clusterId}`;
  }

  /** A failure cluster's fix plan (`GET /api/failure-clusters/:id/fix-plan`). */
  fixPlan(clusterId: number): Promise<FixPlan> {
    return this.get(`/api/failure-clusters/${clusterId}/fix-plan`);
  }

  /** The same plan as Markdown, for an agent. */
  async fixPlanMarkdown(clusterId: number): Promise<string> {
    const response = await instanceFetch(
      `${this.connection.serverUrl}/api/failure-clusters/${clusterId}/fix-plan?format=markdown`,
      {
        headers: this.connection.apiKey ? { 'X-API-Key': this.connection.apiKey } : {},
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new PiwiHttpError(`fix-plan answered ${response.status}`, response.status);
    return response.text();
  }

  /** What a reproduction of an execution needs, and why a bisect is not possible when it is not. */
  async reproduceDesktop(executionId: number): Promise<{ desktop: ReproduceDesktop; bisectReason: string | null }> {
    const body = await this.get<{ desktop: ReproduceDesktop; bisect: { available: boolean; reason?: string } }>(
      `/api/test-run-cases/${executionId}/reproduce`,
    );
    return { desktop: body.desktop, bisectReason: body.bisect.available ? null : (body.bisect.reason ?? null) };
  }

  /** Record a bisect's first bad commit on a failure cluster (`POST /api/failure-clusters/:id/bisect`). */
  recordBisect(clusterId: number, result: BisectResultBody): Promise<unknown> {
    return this.post(`/api/failure-clusters/${clusterId}/bisect`, result);
  }

  /**
   * A test's reproduce plan, recorded as an experiment the desktop app on `machine` runs; its results are posted with
   * {@link recordFlakeResults}.
   */
  flakePlan(testCaseId: number, machine: string): Promise<FlakePlan> {
    const query = new URLSearchParams({ kind: 'reproduce', source: 'desktop', machine, record: 'true' });
    return this.get(`/api/test-cases/${testCaseId}/flake-plan?${query}`);
  }

  /** Record what an experiment's arms measured (`POST /api/projects/:id/flake-lab/results`). */
  recordFlakeResults(projectId: number, body: FlakeResultsBody): Promise<{ verdict: string }> {
    return this.post(`/api/projects/${projectId}/flake-lab/results`, body);
  }

  /** Desktop app only: pass it a job, which waits for the developer in its window. */
  createDesktopJob(job: DesktopJobRequest): Promise<{ id: string; windowOpen: boolean }> {
    return this.post('/api/desktop/repro-requests', job);
  }

  /** Desktop app only: a job's status and, once done, its verdict. */
  desktopJob(id: string): Promise<DesktopJobState> {
    return this.get(`/api/desktop/repro-requests/${encodeURIComponent(id)}`, true);
  }

  /** An execution's page in the dashboard. */
  executionUrl(executionId: number): string {
    return `${this.connection.serverUrl}/test-run-cases/${executionId}`;
  }

  /** A run's page in the dashboard. */
  runUrl(runId: number): string {
    return `${this.connection.serverUrl}/test-runs/${runId}`;
  }

  /** A test case's page in the dashboard. */
  testUrl(testCaseId: number): string {
    return `${this.connection.serverUrl}/test-cases/${testCaseId}`;
  }

  /** A test case's Flakiness tab. */
  flakinessUrl(testCaseId: number): string {
    return `${this.testUrl(testCaseId)}?tab=flakiness`;
  }
}
