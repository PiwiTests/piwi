/**
 * The tests of the editor's own runs as their workers tell them, for a test's line: a test running now, one standing at
 * a stop (`paused`) or held at its failure (`failed`), from the run sessions; and each test's result as its worker
 * ended it, kept for a run that names no page on an instance, whose results no instance reads. A run's results show
 * while it runs, then until another run of the same Playwright config begins. A test is told by its spec and its
 * titles (`RunTest.title`), so an edit above it since the run started moves nothing.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_STOP_WORDS, type RunLineStatus, type RunLineTest, type RunSession, type RunTest } from './protocol.js';

/** A test of a spec as the editor's own run has it now, and what its line says of it. */
export interface OwnRunTest {
  status: RunLineStatus;
  /** Its state in a few words, ahead of the run they are in: `paused, line 14,`, `passed`. */
  words: string;
  ref: string;
  /** Its state now in a run in progress (running, or at a stop), rather than the result of an attempt that ended. */
  live: boolean;
}

interface Ended {
  test: RunTest;
  status: 'passed' | 'failed' | 'skipped';
}

/** A test's key: its spec's path and its titles. */
const keyOf = (file: string, titles: readonly string[]) => `${file}\0${JSON.stringify(titles)}`;

export class OwnRunTests {
  /** The test each worker of a run began last, by ref, then worker. */
  private begun = new Map<string, Map<number, RunTest>>();
  /** The results of each run, by ref, then test and Playwright project: its last attempt's. */
  private runs = new Map<string, { root: string | null; results: Map<string, Ended> }>();
  /** The runs that name their page on an instance, which reads their results. */
  private reported = new Set<string>();
  /** The results of the latest run of each config folder that ended, by root. */
  private kept = new Map<string, { ref: string; results: Map<string, Ended> }>();

  /** A worker of a run began a test, or ended the one it began last, as `RunSessionsOptions.heard` says it. */
  heard(
    ref: string,
    worker: number | null,
    what: { type: string; test?: RunTest; status?: string },
    root: string | null,
  ): void {
    if (what.type === 'ended') return this.ended(ref, root);
    if (worker === null) return;
    if (what.type === 'test-begin' && what.test) {
      if (!this.runs.has(ref)) {
        // Another run of the config began: the results kept of the one before go.
        for (const at of this.kept.keys()) if (sameRoot(at, root)) this.kept.delete(at);
        this.runs.set(ref, { root, results: new Map() });
      }
      const workers = this.begun.get(ref) ?? new Map<number, RunTest>();
      workers.set(worker, what.test);
      this.begun.set(ref, workers);
      return;
    }
    if (what.type !== 'test-end' && what.type !== 'left') return;
    const test = this.begun.get(ref)?.get(worker);
    this.begun.get(ref)?.delete(worker);
    const run = this.runs.get(ref);
    const file = test ? uriToPath(test.uri) : null;
    if (!test || !run || !file) return;
    const key = `${keyOf(file, test.title)}\0${test.project}`;
    const status = what.type === 'left' ? 'interrupted' : what.status;
    if (status === 'passed' || status === 'skipped') run.results.set(key, { test, status });
    else if (status === 'failed' || status === 'timedOut') run.results.set(key, { test, status: 'failed' });
    // An interrupted attempt leaves the attempt before it.
  }

  /** A run's session as the client hears it: one that names its page on an instance has its results read there. */
  sessionChanged(session: RunSession): void {
    if (session.page) this.reported.add(session.ref);
  }

  private ended(ref: string, root: string | null): void {
    const run = this.runs.get(ref);
    this.runs.delete(ref);
    this.begun.delete(ref);
    const reported = this.reported.delete(ref);
    const at = run?.root ?? root;
    if (!run || reported || !run.results.size || at === null) return;
    this.kept.set(at, { ref, results: run.results });
  }

  /**
   * The test of `file` titled `titles` as the editor's own runs of the config at `root` have it now: its state at a
   * stop or while it runs in `sessions`, else its result in a run no instance reads; undefined when none ran it.
   */
  stateOf(
    root: string,
    file: string,
    titles: readonly string[],
    sessions: readonly RunSession[],
  ): OwnRunTest | undefined {
    const key = keyOf(file, titles);
    let running: OwnRunTest | undefined;
    for (const session of sessions) {
      if (session.ended || session.checkout || !sameRoot(session.root, root)) continue;
      for (const worker of session.workers) {
        const test = worker.test;
        if (!test || worker.state === 'between' || keyOf(uriToPath(test.uri) ?? '', test.title) !== key) continue;
        const stop = worker.stop;
        if (worker.state === 'stopped' && stop) {
          const at = `line ${stop.line + 1}${sameFile(uriToPath(stop.uri), file) ? '' : ` of ${path.basename(stop.uri)}`}`;
          const words = `${lowerFirst(RUN_STOP_WORDS[stop.reason])}, ${at},`;
          return { status: stop.reason === 'failure' ? 'failed' : 'paused', words, ref: session.ref, live: true };
        }
        running ??= { status: 'running', words: 'running', ref: session.ref, live: true };
      }
    }
    if (running) return running;
    for (const [ref, run] of this.runs) {
      if (this.reported.has(ref) || !sameRoot(run.root, root)) continue;
      const result = combined(run.results, key);
      if (result) return { status: result, words: result, ref, live: false };
    }
    const kept = this.keptOf(root);
    const result = kept && combined(kept.results, key);
    return kept && result ? { status: result, words: result, ref: kept.ref, live: false } : undefined;
  }

  private keptOf(root: string): { ref: string; results: ReadonlyMap<string, Ended> } | undefined {
    for (const [at, kept] of this.kept) if (sameRoot(at, root)) return kept;
    return undefined;
  }

  /** The tests of the config at `root` that a line shows from the editor's own runs, for the run status. */
  testsOf(root: string, sessions: readonly RunSession[]): RunLineTest[] {
    const tests = new Map<string, RunTest>();
    for (const session of sessions) {
      if (session.ended || session.checkout || !sameRoot(session.root, root)) continue;
      for (const worker of session.workers) if (worker.test) tests.set(testKey(worker.test), worker.test);
    }
    for (const [ref, run] of this.runs) {
      if (this.reported.has(ref) || !sameRoot(run.root, root)) continue;
      for (const { test } of run.results.values()) tests.set(testKey(test), test);
    }
    for (const { test } of this.keptOf(root)?.results.values() ?? []) tests.set(testKey(test), test);
    return [...tests.values()].flatMap((test) => {
      const file = uriToPath(test.uri);
      const state = file ? this.stateOf(root, file, test.title, sessions) : undefined;
      return state ? [{ uri: test.uri, title: test.title, status: state.status }] : [];
    });
  }
}

/** A test's result over its Playwright projects: failed when one project's last attempt failed. */
function combined(results: ReadonlyMap<string, Ended>, key: string): Ended['status'] | undefined {
  let result: Ended['status'] | undefined;
  for (const [at, ended] of results) {
    if (!at.startsWith(`${key}\0`)) continue;
    if (ended.status === 'failed') return 'failed';
    if (ended.status === 'passed' || !result) result = ended.status;
  }
  return result;
}

const testKey = (test: RunTest) => `${test.uri}\0${JSON.stringify(test.title)}`;

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function sameRoot(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && path.relative(a, b) === '';
}

function sameFile(a: string | null, b: string): boolean {
  return a !== null && path.relative(a, b) === '';
}

function uriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}
