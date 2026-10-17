import {
  mergeCoverage,
  normalizeCoveragePath,
  normalizeFunctionRanges,
  normalizeLineRanges,
  sanitizeCoverage,
  type CoverageCapture,
  type CoverageFile,
  type CoverageGranularity,
  type LineRange,
} from '@piwitests/core/coverage';
import { Logger } from '../support/logger.js';
import { errorMessage } from '../support/errors.js';
import { createLimiter } from '../support/limiter.js';
import { backendRequest } from '../transport/backend-request.js';
import type { BlobIds } from './blob-ids.js';
import { checksumsOf, type SourceChecksums } from './source-checksums.js';

/**
 * Collection of server coverage, in the reporter process. A backend built
 * with Piwi's coverage instrumentation names each request's coverage on its
 * response (`X-Piwi-Coverage: <request id>`); the capture fixtures keep the
 * ids a test's responses carried, per origin, and once the test ends this
 * asks each origin for their coverage:
 *
 * - `POST <path base>/__piwi/coverage/collect` with `{ granularity, groups }`,
 *   one group per test, answers each group's files and the ids it no longer
 *   holds (`missing`), and forgets the ids it answered;
 * - `GET <path base>/__piwi/coverage/run?granularity=…` answers the run-level
 *   coverage, with each server file's executable lines.
 *
 * Tests are batched per origin, up to `batchTests` tests or `batchDelayMs`
 * after the first one queued, and a batch is split into calls that stay
 * within the backend's limits (request ids and body bytes per call). The path
 * base is the path of a configured base URL on that origin, then the origin
 * root; the first that answers with coverage is kept for the run. A missing
 * id, a failed or timed-out call, or a cap reached marks the test's coverage
 * incomplete. A file whose source checksums (`checksums`) do not match the
 * checkout keeps its path without its line numbers, and marks the test
 * incomplete. Nothing here throws.
 */

/** The request ids a test's responses carried, by origin. */
export type ServerCoverageRequests = Record<string, string[]>;

/** A test's server coverage as collected: its files, and whether part of it is missing. */
export interface ServerCoverage {
  files: CoverageFile[];
  incomplete: boolean;
}

/**
 * One file of a run's coverage: a backend's, with its executable lines and every method (`allFunctions`) at `lines`
 * granularity, or the browser's, with every function the tests' pages declared in it, run or not (`allFunctions`).
 */
export interface RunCoverageFile extends CoverageFile {
  executable?: LineRange[];
  allFunctions?: LineRange[];
}

/** The bounds collection keeps to. */
export interface CollectorLimits {
  /** Tests per batch at most. */
  batchTests: number;
  /** How long the first test of a batch waits for others, in ms. */
  batchDelayMs: number;
  /** Time limit of one collection call, in ms. */
  callTimeoutMs: number;
  /** Time limit of one run-level call, in ms. */
  runTimeoutMs: number;
  /** Request ids per call at most (the backend's limit). */
  maxIdsPerCall: number;
  /** Body bytes per call at most (under the backend's limit). */
  maxBodyBytes: number;
  /** Request ids per test at most; past it the rest are dropped and the test is incomplete. */
  maxIdsPerTest: number;
  /** Calls in flight per origin at most. */
  concurrency: number;
}

export const DEFAULT_COLLECTOR_LIMITS: CollectorLimits = {
  batchTests: 25,
  batchDelayMs: 1000,
  callTimeoutMs: 10_000,
  runTimeoutMs: 30_000,
  maxIdsPerCall: 10_000,
  maxBodyBytes: 1024 * 1024 - 4096,
  maxIdsPerTest: 50_000,
  concurrency: 2,
};

const COLLECT_PATH = '/__piwi/coverage/collect';
const RUN_PATH = '/__piwi/coverage/run';

/** A request id as the reporter keeps it: printable ASCII without spaces, 128 characters at most. */
const REQUEST_ID = /^[\x21-\x7e]{1,128}$/;

/** Largest answer read from a backend, in bytes. */
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The request ids of a `piwi-server-coverage-requests` attachment body
 * (`{ "<origin>": ["<id>", …] }`): http and https origins only, valid ids,
 * each kept once. Null when none remains.
 */
export function parseServerCoverageRequests(body: unknown): ServerCoverageRequests | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const requests: ServerCoverageRequests = {};
  for (const [key, value] of Object.entries(parsed)) {
    let origin: string;
    try {
      const url = new URL(key);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== key) continue;
      origin = url.origin;
    } catch {
      continue;
    }
    if (!Array.isArray(value)) continue;
    const ids = [...new Set(value.filter((id): id is string => typeof id === 'string' && REQUEST_ID.test(id)))];
    if (ids.length > 0) requests[origin] = ids;
  }
  return Object.keys(requests).length > 0 ? requests : null;
}

/** The parts of a Playwright config the collection reads. */
interface ConfigUse {
  use?: { baseURL?: unknown; ignoreHTTPSErrors?: unknown };
  projects?: Array<{ use?: { baseURL?: unknown; ignoreHTTPSErrors?: unknown } }>;
}

/** The distinct configured base URLs, for finding the path base of an origin. */
export function baseUrlsFromConfig(config: ConfigUse): string[] {
  const urls = [config?.use?.baseURL, ...(config?.projects ?? []).map((project) => project?.use?.baseURL)];
  return [...new Set(urls.filter((url): url is string => typeof url === 'string' && url !== ''))];
}

/** Whether any project ignores HTTPS errors, as the backends the browsers reach are then trusted the same way. */
export function ignoresHttpsErrors(config: ConfigUse): boolean {
  return (
    config?.use?.ignoreHTTPSErrors === true ||
    (config?.projects ?? []).some((project) => project?.use?.ignoreHTTPSErrors === true)
  );
}

/** The source checksums an answer's files name, by normalized path. */
function fileChecksums(files: unknown, into = new Map<string, string[]>()): Map<string, string[]> {
  if (!Array.isArray(files)) return into;
  for (const item of files) {
    if (!isRecord(item)) continue;
    const filePath = normalizeCoveragePath(item.path);
    const checksums = checksumsOf(item.checksums);
    if (filePath === null || checksums.length === 0) continue;
    into.set(filePath, [...new Set([...(into.get(filePath) ?? []), ...checksums])]);
  }
  return into;
}

/** The files of a run-level answer (`{ v: 1, files }`), cleaned like a test's coverage; null when not one. */
function runFilesOf(answer: unknown): RunCoverageFile[] | null {
  if (!isRecord(answer) || answer.v !== 1 || !Array.isArray(answer.files)) return null;
  const files: RunCoverageFile[] = [];
  for (const item of answer.files) {
    if (!isRecord(item) || (item.runtime !== 'server' && item.runtime !== 'browser')) continue;
    const filePath = normalizeCoveragePath(item.path);
    if (filePath === null) continue;
    const file: RunCoverageFile = { path: filePath, runtime: item.runtime };
    const functions = normalizeFunctionRanges(item.functions);
    const lines = normalizeLineRanges(item.lines);
    const executable = normalizeLineRanges(item.executable);
    const allFunctions = normalizeFunctionRanges(item.allFunctions);
    if (functions.length > 0) file.functions = functions;
    if (lines.length > 0) file.lines = lines;
    if (executable.length > 0) file.executable = executable;
    if (allFunctions.length > 0) file.allFunctions = allFunctions;
    files.push(file);
  }
  return files;
}

/** Whether a collection answer has the shape `{ v: 1, groups: [...] }`. */
function isCollectAnswer(answer: unknown): answer is { v: 1; groups: unknown[] } {
  return isRecord(answer) && answer.v === 1 && Array.isArray(answer.groups);
}

/** One test waiting for its server coverage, across origins and calls. */
interface TestEntry {
  /** Groups still to answer, plus origins not yet split into calls. */
  pending: number;
  captures: CoverageCapture[];
  /** The source checksums the answers named, by path. */
  checksums: Map<string, string[]>;
  incomplete: boolean;
  resolve: (coverage: ServerCoverage) => void;
}

/** A test's ids for one origin, queued until its batch is sent. */
interface QueuedPart {
  entry: TestEntry;
  ids: string[];
}

/** One group of a call: a test's ids, or part of them. */
interface CallGroup {
  key: string;
  entry: TestEntry;
  ids: string[];
}

/** The queue and the path base of one origin. */
interface OriginState {
  queue: QueuedPart[];
  timer: ReturnType<typeof setTimeout> | null;
  /** The path base that answered with coverage, once one did. */
  base: string | null;
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Whether a failure was already reported at warn level. */
  warned: boolean;
}

type CallOutcome = { kind: 'answered'; ok: boolean; json: unknown } | { kind: 'failed'; reason: string };

export interface ServerCoverageCollectorOptions {
  /** The granularity asked of the backend. */
  granularity: CoverageGranularity;
  /** The configured base URLs; a path base is read from those on the origin. */
  baseUrls: string[];
  /** Adds blob ids to the files that name line numbers; null leaves them without. */
  blobs: BlobIds | null;
  /** Checks the source checksums the backend names against the checkout; null keeps every file's line numbers. */
  checksums?: SourceChecksums | null;
  /** Accept any certificate from an https backend, as the run's browsers do with `ignoreHTTPSErrors`. */
  ignoreHttpsErrors?: boolean;
  logger?: Logger;
  limits?: Partial<CollectorLimits>;
}

export class ServerCoverageCollector {
  private readonly limits: CollectorLimits;
  private readonly logger: Logger;
  private readonly originStates = new Map<string, OriginState>();
  private readonly closer = new AbortController();
  private groupSequence = 0;
  private versionWarned = false;

  constructor(private readonly options: ServerCoverageCollectorOptions) {
    this.limits = { ...DEFAULT_COLLECTOR_LIMITS, ...options.limits };
    this.logger = options.logger ?? new Logger();
  }

  /** The origins that named request ids so far. */
  get origins(): string[] {
    return [...this.originStates.keys()];
  }

  /**
   * The server coverage of one test, from the request ids its responses
   * carried. Resolves once every call for it answered or failed; never rejects.
   */
  collect(requests: ServerCoverageRequests): Promise<ServerCoverage> {
    let budget = this.limits.maxIdsPerTest;
    let truncated = false;
    const parts: Array<[string, string[]]> = [];
    for (const [origin, all] of Object.entries(requests)) {
      const ids = all.slice(0, Math.max(0, budget));
      if (ids.length < all.length) truncated = true;
      budget -= ids.length;
      if (ids.length > 0) parts.push([origin, ids]);
    }
    if (parts.length === 0 || this.closer.signal.aborted) {
      return Promise.resolve({ files: [], incomplete: truncated || parts.length > 0 });
    }
    return new Promise((resolve) => {
      const entry: TestEntry = {
        pending: parts.length,
        captures: [],
        checksums: new Map(),
        incomplete: truncated,
        resolve,
      };
      for (const [origin, ids] of parts) this.enqueue(origin, { entry, ids });
    });
  }

  /** Send every queued test now, without waiting for its batch to fill. */
  flush(): void {
    for (const origin of this.originStates.keys()) this.flushOrigin(origin);
  }

  /**
   * The run-level coverage of an origin, with each server file's executable
   * lines at `lines` granularity; null when the backend did not answer with it.
   */
  async fetchRun(origin: string): Promise<RunCoverageFile[] | null> {
    const state = this.stateOf(origin);
    const query = `?granularity=${encodeURIComponent(this.options.granularity)}`;
    for (const base of this.pathBases(origin)) {
      const outcome = await this.call(
        `${origin}${base}${RUN_PATH}${query}`,
        { method: 'GET' },
        this.limits.runTimeoutMs,
      );
      if (outcome.kind === 'failed') {
        this.reportFailure(state, `Could not fetch the run's server coverage from ${origin}: ${outcome.reason}.`);
        return null;
      }
      const answered = outcome.ok ? runFilesOf(outcome.json) : null;
      if (answered) {
        state.base = base;
        const files = await this.verifyChecksums(
          answered,
          fileChecksums(isRecord(outcome.json) ? outcome.json.files : null),
        );
        return this.options.blobs ? this.options.blobs.withBlobs(files.files) : files.files;
      }
    }
    this.reportFailure(state, `Could not fetch the run's server coverage: ${this.noEndpoint(origin, RUN_PATH)}.`);
    return null;
  }

  /** Abort every call in flight and fail every later one; the tests still waiting resolve incomplete. */
  close(): void {
    this.closer.abort(new Error('the collection was closed'));
    for (const state of this.originStates.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      for (const part of state.queue.splice(0)) {
        part.entry.incomplete = true;
        this.settle(part.entry);
      }
    }
  }

  private stateOf(origin: string): OriginState {
    let state = this.originStates.get(origin);
    if (!state) {
      state = {
        queue: [],
        timer: null,
        base: null,
        limit: createLimiter(this.limits.concurrency),
        warned: false,
      };
      this.originStates.set(origin, state);
    }
    return state;
  }

  private enqueue(origin: string, part: QueuedPart): void {
    const state = this.stateOf(origin);
    state.queue.push(part);
    if (state.queue.length >= this.limits.batchTests) this.flushOrigin(origin);
    else if (!state.timer) state.timer = setTimeout(() => this.flushOrigin(origin), this.limits.batchDelayMs);
  }

  private flushOrigin(origin: string): void {
    const state = this.stateOf(origin);
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    const parts = state.queue.splice(0);
    if (parts.length === 0) return;
    for (const groups of this.packCalls(parts)) {
      void state.limit(() => this.send(origin, groups));
    }
  }

  /**
   * Split queued parts into calls within the id and body limits. A part too
   * large for one call is split across several, each piece its own group.
   */
  private packCalls(parts: QueuedPart[]): CallGroup[][] {
    const calls: CallGroup[][] = [];
    const emptyBody = Buffer.byteLength(JSON.stringify({ granularity: this.options.granularity, groups: [] }));
    let call: CallGroup[] = [];
    let ids = 0;
    let bytes = emptyBody;
    const closeCall = () => {
      if (call.length > 0) calls.push(call);
      call = [];
      ids = 0;
      bytes = emptyBody;
    };
    for (const part of parts) {
      let group: CallGroup | null = null;
      let groups = 0;
      for (const id of part.ids) {
        const idBytes = Buffer.byteLength(JSON.stringify(id));
        if (group && (ids >= this.limits.maxIdsPerCall || bytes + 1 + idBytes > this.limits.maxBodyBytes)) {
          closeCall();
          group = null;
        }
        if (group) {
          bytes += 1 + idBytes;
        } else {
          const key = `g${++this.groupSequence}`;
          const groupBytes = () => Buffer.byteLength(JSON.stringify({ key, requests: [] })) + (call.length > 0 ? 1 : 0);
          if (
            call.length > 0 &&
            (ids >= this.limits.maxIdsPerCall || bytes + groupBytes() + idBytes > this.limits.maxBodyBytes)
          ) {
            closeCall();
          }
          bytes += groupBytes() + idBytes;
          group = { key, entry: part.entry, ids: [] };
          call.push(group);
          groups++;
        }
        group.ids.push(id);
        ids++;
      }
      // The part counted once in `pending`; each group past the first adds one.
      part.entry.pending += groups - 1;
    }
    closeCall();
    return calls;
  }

  /** Send one call and hand each group's answer to its test. */
  private async send(origin: string, groups: CallGroup[]): Promise<void> {
    let answer: { v: 1; groups: unknown[] } | null = null;
    try {
      const body = JSON.stringify({
        granularity: this.options.granularity,
        groups: groups.map((group) => ({ key: group.key, requests: group.ids })),
      });
      answer = await this.post(origin, body);
    } catch (error) {
      this.logger.debug(`Server coverage collection from ${origin} failed: ${errorMessage(error)}`);
    }
    const answered = new Map<string, Record<string, unknown>>();
    for (const group of answer?.groups ?? []) {
      if (isRecord(group) && typeof group.key === 'string') answered.set(group.key, group);
    }
    for (const group of groups) {
      const result = answered.get(group.key);
      if (!result) {
        group.entry.incomplete = true;
      } else {
        if (Array.isArray(result.missing) && result.missing.length > 0) group.entry.incomplete = true;
        fileChecksums(result.files, group.entry.checksums);
        const capture = sanitizeCoverage({ v: 1, files: result.files });
        if (capture) {
          group.entry.captures.push(capture);
          if (capture.incomplete) group.entry.incomplete = true;
        }
      }
      this.settle(group.entry);
    }
  }

  /** POST a collection body to the origin's path base, trying each until one answers with coverage. */
  private async post(origin: string, body: string): Promise<{ v: 1; groups: unknown[] } | null> {
    const state = this.stateOf(origin);
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
    for (const base of this.pathBases(origin)) {
      const outcome = await this.call(`${origin}${base}${COLLECT_PATH}`, init, this.limits.callTimeoutMs);
      if (outcome.kind === 'failed') {
        this.reportFailure(state, this.collectFailure(origin, outcome.reason));
        return null;
      }
      if (outcome.ok && isCollectAnswer(outcome.json)) {
        state.base = base;
        return outcome.json;
      }
    }
    this.reportFailure(state, this.collectFailure(origin, this.noEndpoint(origin, COLLECT_PATH)));
    return null;
  }

  /** The path bases to try for an origin: the one that answered, else each base URL's path on it, then the root. */
  private pathBases(origin: string): string[] {
    const known = this.originStates.get(origin)?.base;
    if (known !== null && known !== undefined) return [known];
    const bases: string[] = [];
    for (const baseUrl of this.options.baseUrls) {
      try {
        const url = new URL(baseUrl);
        const base = url.pathname.replace(/\/+$/, '');
        if (url.origin === origin && base && !bases.includes(base)) bases.push(base);
      } catch {
        // Not a URL: no path base from it.
      }
    }
    bases.push('');
    return bases;
  }

  /** One HTTP call within a time limit, aborted when the collector closes. */
  private async call(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    timeoutMs: number,
  ): Promise<CallOutcome> {
    if (this.closer.signal.aborted) return { kind: 'failed', reason: 'the collection was closed' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    const onClose = () => controller.abort(new Error('the collection was closed'));
    this.closer.signal.addEventListener('abort', onClose, { once: true });
    try {
      const answer = await backendRequest(url, {
        ...init,
        insecure: this.options.ignoreHttpsErrors === true,
        signal: controller.signal,
        maxBytes: MAX_ANSWER_BYTES,
      });
      let json: unknown;
      try {
        json = JSON.parse(answer.text);
      } catch {
        json = undefined;
      }
      return { kind: 'answered', ok: answer.status >= 200 && answer.status < 300, json };
    } catch (error) {
      return { kind: 'failed', reason: errorMessage(controller.signal.aborted ? controller.signal.reason : error) };
    } finally {
      clearTimeout(timer);
      this.closer.signal.removeEventListener('abort', onClose);
    }
  }

  private collectFailure(origin: string, reason: string): string {
    return `Could not collect the server coverage of the tests from ${origin} (${reason}): their coverage is marked incomplete.`;
  }

  /** Why no endpoint answered: the URLs tried. */
  private noEndpoint(origin: string, endpoint: string): string {
    const urls = this.pathBases(origin).map((base) => `${origin}${base}${endpoint}`);
    return `no coverage answer at ${urls.join(' or ')}`;
  }

  /** The first failure of an origin is a warning, the next ones are verbose-only; none once closed. */
  private reportFailure(state: OriginState, message: string): void {
    if (this.closer.signal.aborted) return;
    if (state.warned) {
      this.logger.debug(message);
      return;
    }
    state.warned = true;
    this.logger.warn(message);
  }

  /** Count one group (or unsplit part) of a test as answered; once all are, resolve the test. */
  private settle(entry: TestEntry): void {
    entry.pending--;
    if (entry.pending > 0) return;
    void this.finish(entry);
  }

  /**
   * The files with the line numbers of those built from another version than
   * the checkout's dropped; the first time any is, a warning names one.
   */
  private async verifyChecksums<T extends CoverageFile>(
    files: T[],
    checksums: ReadonlyMap<string, readonly string[]>,
  ): Promise<{ files: T[]; dropped: string[] }> {
    if (!this.options.checksums || checksums.size === 0) return { files, dropped: [] };
    try {
      const verified = await this.options.checksums.verify(files, checksums);
      if (verified.dropped.length > 0 && !this.versionWarned && !this.closer.signal.aborted) {
        this.versionWarned = true;
        this.logger.warn(
          `The backend was built from other sources than the checkout (${verified.dropped[0]} differs): ` +
            `server coverage leaves out the line numbers of such files and marks their tests incomplete.`,
        );
      }
      return verified;
    } catch {
      return { files, dropped: [] };
    }
  }

  private async finish(entry: TestEntry): Promise<void> {
    const merged = mergeCoverage(...entry.captures);
    const verified = await this.verifyChecksums(merged?.files ?? [], entry.checksums);
    let files = verified.files;
    if (verified.dropped.length > 0) entry.incomplete = true;
    try {
      if (this.options.blobs) files = await this.options.blobs.withBlobs(files);
    } catch {
      // Blob ids are best-effort: the files keep their line numbers without.
    }
    entry.resolve({ files, incomplete: entry.incomplete || merged?.incomplete === true });
  }
}
