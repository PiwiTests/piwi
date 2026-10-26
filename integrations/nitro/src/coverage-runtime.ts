/**
 * The coverage recorder of a coverage build (`PIWI_COVERAGE_BUILD=true`). The
 * coverage transform (`coverage-transform.ts`) makes every instrumented module
 * register here (`__piwiModule`) and every function ask its module for its
 * payload when it is called: a `Uint8Array` where entry 0 marks the function as
 * entered and each other entry one statement as run.
 *
 * - Inside a request, a function records into that request's payload, found
 *   through the request store the plugin sets (`requestScope`); outside one, or
 *   once its request is collected, into the shared payload, the run level.
 * - A module's top-level code always records into the shared payload.
 * - The plugin names a request on its response (`X-Piwi-Coverage`) when
 *   instrumented code ran for it, and keeps it until the reporter collects it
 *   (`POST /__piwi/coverage/collect`), up to `MAX_KEPT_REQUESTS` and
 *   `MAX_KEPT_BYTES`, the oldest going first. `GET /__piwi/coverage/run` answers
 *   the run level: the shared payloads and the requests still kept.
 *
 * The answers have the shape of the ASP.NET Core package's: the reporter reads
 * them the same way. Line numbers come from the span table the build wrote
 * (`enableCoverage`), never from a source map at run time.
 *
 * The state lives on a global, so a second copy of this module in the bundle
 * records into the same one.
 */
import { randomBytes } from 'node:crypto';
import { requestScope } from './request-scope.js';

export type CoverageGranularity = 'files' | 'functions' | 'lines';
export type LineRange = [number, number];

/**
 * One instrumented file in the span table: its repository-relative path, the
 * checksum of its source, and per function (0 is the module's top-level code)
 * its line range and the line of each payload entry (entry 0 has none: 0).
 */
export interface CoverageTableFile {
  path: string;
  checksums: string[];
  /** Per function, its first and last line; null for the top-level code. */
  f: Array<LineRange | null>;
  /** Per function, the line of each entry; 0 when unknown, and for entry 0. */
  s: number[][];
}

/** The span table the build writes: the instrumented files, by file id. */
export interface CoverageTable {
  v: 1;
  files: Record<string, CoverageTableFile>;
}

/** The coverage of one request: per registered module, per function, its payload. */
export interface RequestCoverage {
  p: Array<Array<Uint8Array | undefined> | undefined>;
  /** Instrumented code ran for the request: its response gets an id. */
  ran: boolean;
  /** Collected, evicted or never named: later writes go to the run level. */
  closed: boolean;
  /** The id its response carried, once named. */
  id?: string;
  /** About how many bytes its payloads hold. */
  bytes: number;
}

export interface CoverageFile {
  path: string;
  runtime: 'server';
  functions?: LineRange[];
  lines?: LineRange[];
  executable?: LineRange[];
  allFunctions?: LineRange[];
  checksums?: string[];
}

/** Ended requests kept until collected, at most. */
export const MAX_KEPT_REQUESTS = 5000;
/** Bytes of payloads kept, about, at most. */
export const MAX_KEPT_BYTES = 64 * 1024 * 1024;
/** Request ids per collection call, at most. */
export const MAX_IDS_PER_CALL = 10_000;

interface CoverageState {
  run: boolean;
  modules: CoverageModule[];
  byId: Map<string, CoverageModule>;
  table: CoverageTable | null;
  tableSource: string | null;
  enabled: boolean;
  instanceId: string;
  startedAt: string;
  sequence: number;
  kept: Map<string, RequestCoverage>;
  keptBytes: number;
}

const STATE_KEY = Symbol.for('piwitests.coverage');
const globals = globalThis as Record<symbol, unknown>;

function state(): CoverageState {
  return (globals[STATE_KEY] ??= {
    run: process.env.PIWI_COVERAGE_MODE === 'run',
    modules: [],
    byId: new Map(),
    table: null,
    tableSource: null,
    enabled: false,
    instanceId: randomBytes(6).toString('hex'),
    startedAt: new Date().toISOString(),
    sequence: 0,
    kept: new Map(),
    keptBytes: 0,
  } satisfies CoverageState) as CoverageState;
}

/** An instrumented module: its shared payloads, and the lookup its functions call on entry. */
export class CoverageModule {
  constructor(
    readonly id: string,
    /** Its index in the state, the index of its payloads in a request's coverage. */
    readonly n: number,
    /** The payload length of each function. */
    readonly l: number[],
    /** The shared payload of each function, the run level. */
    readonly s: Uint8Array[],
    private readonly run: boolean,
  ) {}

  /** The payload function `i` records into: the request's being served, else the shared one. */
  f(i: number): Uint8Array {
    if (this.run) return this.s[i];
    const coverage = (requestScope.getStore() as { coverage?: RequestCoverage } | undefined)?.coverage;
    if (coverage === undefined || coverage.closed) return this.s[i];
    let functions = coverage.p[this.n];
    if (functions === undefined) functions = coverage.p[this.n] = [];
    let payload = functions[i];
    if (payload === undefined) {
      payload = functions[i] = new Uint8Array(this.l[i]);
      coverage.bytes += this.l[i] + 32;
      coverage.ran = true;
    }
    return payload;
  }
}

/** Called by each instrumented module when it loads: its file id and the payload length of each function. */
export function __piwiModule(id: string, lengths: number[]): CoverageModule {
  const current = state();
  const known = current.byId.get(id);
  if (known && known.l.length === lengths.length && known.l.every((length, i) => length === lengths[i])) return known;
  const module = new CoverageModule(
    id,
    current.modules.length,
    lengths,
    lengths.map((length) => new Uint8Array(length)),
    current.run,
  );
  current.modules.push(module);
  current.byId.set(id, module);
  return module;
}

/** Whether the guard the plugin applies lets it serve coverage in this environment. */
function servesCoverage(): boolean {
  const env = process.env.NODE_ENV;
  if (process.env.PIWI_TEST_LOGS_DISABLED === 'true') return false;
  return env === 'development' || env === 'test' || process.env.PIWI_TEST_LOGS_DISABLED === 'false';
}

/**
 * Called once at startup by the plugin the module generates, with the span
 * table as JSON. A coverage build refuses to start in production unless the
 * plugin is explicitly enabled there, and warns in any other environment
 * where it serves no coverage.
 */
export function enableCoverage(table: string): void {
  const current = state();
  current.enabled = true;
  current.tableSource = table;
  current.table = null;
  if (servesCoverage()) return;
  const message =
    'this server was built with Piwi coverage (PIWI_COVERAGE_BUILD=true), which runs slower code and serves source paths and line numbers';
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`[piwi] ${message}: refusing to start in production. Build without PIWI_COVERAGE_BUILD, or set PIWI_TEST_LOGS_DISABLED=false to serve it anyway.`);
  }
  console.warn(`[piwi] ${message}, and serves no coverage in this environment (NODE_ENV=${process.env.NODE_ENV ?? 'unset'}).`);
}

/** Whether this process runs a coverage build. */
export function coverageActive(): boolean {
  const current = globals[STATE_KEY] as CoverageState | undefined;
  return current !== undefined && (current.enabled || current.modules.length > 0);
}

/** A new request's coverage, or undefined when nothing records per request. */
export function beginRequestCoverage(): RequestCoverage | undefined {
  if (!coverageActive() || state().run) return undefined;
  return { p: [], ran: false, closed: false, bytes: 0 };
}

/** Add a request's payloads to the run level and stop recording into it. */
function close(coverage: RequestCoverage): void {
  if (coverage.closed) return;
  coverage.closed = true;
  const { modules } = state();
  coverage.p.forEach((functions, n) => {
    const module = modules[n];
    if (!functions || !module) return;
    functions.forEach((payload, i) => {
      if (!payload) return;
      const shared = module.s[i];
      for (let k = 0; k < payload.length; k++) if (payload[k]) shared[k] = 1;
    });
  });
  coverage.p = [];
}

/**
 * The id a response names its request's coverage by, once instrumented code ran
 * for it; the request is then kept until collected. Undefined when nothing ran.
 */
export function nameRequest(coverage: RequestCoverage): string | undefined {
  if (coverage.id) return coverage.id;
  if (!coverage.ran || coverage.closed) return undefined;
  const current = state();
  coverage.id = `${current.instanceId}.${++current.sequence}.${randomBytes(16).toString('hex')}`;
  current.kept.set(coverage.id, coverage);
  current.keptBytes += coverage.bytes;
  for (const [id, oldest] of current.kept) {
    if (current.kept.size <= MAX_KEPT_REQUESTS && current.keptBytes <= MAX_KEPT_BYTES) break;
    if (id === coverage.id) break;
    forget(id, oldest);
  }
  return coverage.id;
}

/** Called when the response is done: a request no response named goes to the run level. */
export function settleRequest(coverage: RequestCoverage): void {
  if (!coverage.id) close(coverage);
}

function forget(id: string, coverage: RequestCoverage): void {
  const current = state();
  current.kept.delete(id);
  current.keptBytes -= coverage.bytes;
  close(coverage);
}

function table(): CoverageTable {
  const current = state();
  if (!current.table) {
    let parsed: CoverageTable | null = null;
    try {
      parsed = current.tableSource ? (JSON.parse(current.tableSource) as CoverageTable) : null;
    } catch {
      parsed = null;
    }
    current.table = parsed?.v === 1 && parsed.files ? parsed : { v: 1, files: {} };
  }
  return current.table;
}

function toRanges(values: Iterable<number>): LineRange[] {
  const sorted = [...new Set(values)].filter((value) => value > 0).sort((a, b) => a - b);
  const ranges: LineRange[] = [];
  for (const value of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && value === last[1] + 1) last[1] = value;
    else ranges.push([value, value]);
  }
  return ranges;
}

function uniqueFunctions(ranges: Iterable<LineRange>): LineRange[] {
  const byKey = new Map<string, LineRange>();
  for (const range of ranges) byKey.set(`${range[0]}:${range[1]}`, range);
  return [...byKey.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** What ran in one file, accumulated from payloads. */
interface FileAccumulator {
  file: CoverageTableFile;
  functions: LineRange[];
  lines: number[];
}

/** Add one function's payload to its file's accumulator. */
function addPayload(files: Map<string, FileAccumulator>, module: CoverageModule, i: number, payload: Uint8Array): void {
  const file = table().files[module.id];
  if (!file) return;
  let ran = false;
  for (let k = 0; k < payload.length; k++) if (payload[k]) ran = true;
  if (!ran) return;
  let accumulator = files.get(file.path);
  if (!accumulator) files.set(file.path, (accumulator = { file, functions: [], lines: [] }));
  const range = file.f[i];
  if (range && payload[0]) accumulator.functions.push(range);
  const lines = file.s[i] ?? [];
  for (let k = 1; k < payload.length; k++) if (payload[k] && lines[k]) accumulator.lines.push(lines[k]);
}

function addRequest(files: Map<string, FileAccumulator>, coverage: RequestCoverage): void {
  const { modules } = state();
  coverage.p.forEach((functions, n) => {
    const module = modules[n];
    if (!functions || !module) return;
    functions.forEach((payload, i) => payload && addPayload(files, module, i, payload));
  });
}

function fileOf(accumulator: FileAccumulator, granularity: CoverageGranularity): CoverageFile {
  const out: CoverageFile = { path: accumulator.file.path, runtime: 'server' };
  if (granularity === 'files') return out;
  out.functions = uniqueFunctions(accumulator.functions);
  if (granularity === 'lines') out.lines = toRanges(accumulator.lines);
  out.checksums = accumulator.file.checksums;
  return out;
}

export function instance(): { id: string; startedAt: string } {
  const current = state();
  return { id: current.instanceId, startedAt: current.startedAt };
}

export function parseGranularity(value: unknown): CoverageGranularity {
  return value === 'files' || value === 'functions' ? value : 'lines';
}

export class CoverageRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Answer `POST /__piwi/coverage/collect`: per group, the coverage of its
 * requests merged, and the ids not held (`missing`); the requests answered are
 * forgotten, their coverage kept at run level.
 */
export function collectCoverage(body: unknown): object {
  const request = body as { granularity?: unknown; groups?: unknown } | null;
  if (!request || typeof request !== 'object' || !Array.isArray(request.groups)) {
    throw new CoverageRequestError(400, 'expected { granularity, groups: [{ key, requests }] }');
  }
  const granularity = parseGranularity(request.granularity);
  const groups = request.groups as Array<{ key?: unknown; requests?: unknown }>;
  const ids = groups.reduce((count, group) => count + (Array.isArray(group?.requests) ? group.requests.length : 0), 0);
  if (ids > MAX_IDS_PER_CALL) throw new CoverageRequestError(413, `at most ${MAX_IDS_PER_CALL} request ids per call`);
  const current = state();
  const answered: Array<[string, RequestCoverage]> = [];
  const out = groups.map((group) => {
    const files = new Map<string, FileAccumulator>();
    const missing: string[] = [];
    for (const id of Array.isArray(group?.requests) ? group.requests : []) {
      const coverage = typeof id === 'string' ? current.kept.get(id) : undefined;
      if (!coverage) {
        if (typeof id === 'string') missing.push(id);
        continue;
      }
      addRequest(files, coverage);
      answered.push([id, coverage]);
    }
    return { key: group?.key, files: [...files.values()].map((file) => fileOf(file, granularity)), missing };
  });
  for (const [id, coverage] of answered) if (current.kept.has(id)) forget(id, coverage);
  return { v: 1, instance: instance(), groups: out };
}

/**
 * Answer `GET /__piwi/coverage/run`: the code that ran outside any request,
 * every request collected or evicted, and the requests still kept; at `lines`,
 * each file's executable lines and every function, for every file of the span
 * table, loaded or not.
 */
export function runCoverage(granularity: CoverageGranularity): object {
  const current = state();
  const files = new Map<string, FileAccumulator>();
  for (const module of current.modules) module.s.forEach((payload, i) => addPayload(files, module, i, payload));
  for (const coverage of current.kept.values()) addRequest(files, coverage);
  const out: CoverageFile[] = [...files.values()].map((file) => fileOf(file, granularity));
  if (granularity === 'lines') {
    const byPath = new Map(out.map((file) => [file.path, file]));
    for (const file of Object.values(table().files)) {
      let entry = byPath.get(file.path);
      if (!entry) {
        entry = { path: file.path, runtime: 'server', functions: [], lines: [], checksums: file.checksums };
        byPath.set(file.path, entry);
        out.push(entry);
      }
      entry.executable = toRanges(file.s.flatMap((lines) => lines.slice(1)));
      entry.allFunctions = uniqueFunctions(file.f.filter((range): range is LineRange => range !== null));
    }
  }
  return { v: 1, instance: instance(), files: out.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Forget every module and request: for tests. */
export function resetCoverageForTests(): void {
  delete globals[STATE_KEY];
}
