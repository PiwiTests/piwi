/**
 * The tests of the editor's own runs as their workers tell them, for a test's line: a test running now, one standing at
 * a stop (`paused`) or held at its failure (`failed`), from the run sessions; and each test's result as its worker
 * ended it, kept for a run that names no page on an instance, whose results no instance reads. A run's results show
 * while it runs, then until another run of the same Playwright config begins or the instance gives a newer latest run
 * (`forget`); the newest run's result of a test comes first. A test is told by its spec and its titles
 * (`RunTest.title`), so an edit above it since the run started moves nothing.
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

type Result = 'passed' | 'failed' | 'skipped';

/** A run's results: by test (`keyOf`), the test and its last attempt's result in each Playwright project. */
type Results = Map<string, { test: RunTest; projects: Map<string, Result> }>;

export class OwnRunTests {
  /** The test each worker of a run began last, by ref, then worker. */
  private begun = new Map<string, Map<number, RunTest>>();
  /** The results of each run in progress, by ref, oldest first. */
  private runs = new Map<string, { root: string | null; results: Results }>();
  /** The runs that name their page on an instance, which reads their results. */
  private reported = new Set<string>();
  /** The results of the latest run of each config folder that ended, by root. */
  private kept = new Map<string, { ref: string; results: Results }>();

  /** A worker of a run began a test, or ended the one it began last, as `RunSessionsOptions.heard` says it. */
  heard(
    ref: string,
    worker: number | null,
    what: { type: string; test?: RunTest; status?: string; ok?: boolean },
    root: string | null,
  ): void {
    if (what.type === 'ended') return this.ended(ref, root);
    if (worker === null) return;
    if (what.type === 'test-begin' && what.test) {
      if (!this.runs.has(ref)) {
        // Another run of the config began: the results kept of the one before go.
        if (root !== null) this.forget(root);
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
    const key = test && testKeyOf(test);
    if (!test || !run || !key) return;
    const status = what.type === 'left' ? 'interrupted' : what.status;
    // A test that ended as it was expected to passes: a `test.fail()` test that failed (`ok`, when the reporter says).
    const ok = what.type === 'left' ? undefined : what.ok;
    const result: Result | null =
      status === 'skipped'
        ? status
        : status === 'passed' || status === 'failed' || status === 'timedOut'
          ? (ok ?? status === 'passed')
            ? 'passed'
            : 'failed'
          : // An interrupted attempt leaves the attempt before it.
            null;
    if (!result) return;
    const entry = run.results.get(key) ?? { test, projects: new Map<string, Result>() };
    entry.projects.set(test.project, result);
    run.results.set(key, entry);
  }

  /** A run's session as the client hears it: one that names its page on an instance has its results read there. */
  sessionChanged(session: RunSession): void {
    if (session.page) this.reported.add(session.ref);
  }

  /** The results kept of the config at `root` go: another run of it began, or the instance gave a newer latest run. */
  forget(root: string): boolean {
    let forgot = false;
    for (const at of this.kept.keys()) {
      if (sameRoot(at, root)) forgot = this.kept.delete(at) || forgot;
    }
    return forgot;
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
   * stop or while it runs in `sessions`, else its result in the newest run no instance reads; undefined when none ran
   * it.
   */
  stateOf(
    root: string,
    file: string,
    titles: readonly string[],
    sessions: readonly RunSession[],
  ): OwnRunTest | undefined {
    return this.stateOfKey(root, keyOf(file, titles), file, sessions);
  }

  private stateOfKey(root: string, key: string, file: string, sessions: readonly RunSession[]): OwnRunTest | undefined {
    let running: OwnRunTest | undefined;
    for (const session of sessions) {
      if (session.ended || session.checkout || !sameRoot(session.root, root)) continue;
      for (const worker of session.workers) {
        const test = worker.test;
        if (!test || worker.state === 'between' || testKeyOf(test) !== key) continue;
        const stop = worker.stop;
        if (worker.state === 'stopped' && stop) {
          const stopFile = uriToPath(stop.uri);
          const of = stopFile && !sameRoot(stopFile, file) ? ` of ${path.basename(stopFile)}` : '';
          const words = `${lowerFirst(RUN_STOP_WORDS[stop.reason])}, line ${stop.line + 1}${of},`;
          return { status: stop.reason === 'failure' ? 'failed' : 'paused', words, ref: session.ref, live: true };
        }
        running ??= { status: 'running', words: 'running', ref: session.ref, live: true };
      }
    }
    if (running) return running;
    for (const [ref, run] of [...this.runs].reverse()) {
      if (this.reported.has(ref) || !sameRoot(run.root, root)) continue;
      const result = combined(run.results.get(key)?.projects);
      if (result) return { status: result, words: result, ref, live: false };
    }
    const kept = this.keptOf(root);
    const result = combined(kept?.results.get(key)?.projects);
    return kept && result ? { status: result, words: result, ref: kept.ref, live: false } : undefined;
  }

  private keptOf(root: string): { ref: string; results: Results } | undefined {
    for (const [at, kept] of this.kept) if (sameRoot(at, root)) return kept;
    return undefined;
  }

  /** The tests of the config at `root` that a line shows from the editor's own runs, for the run status. */
  testsOf(root: string, sessions: readonly RunSession[]): RunLineTest[] {
    const tests = new Map<string, RunTest>();
    const add = (test: RunTest) => {
      const key = testKeyOf(test);
      if (key && !tests.has(key)) tests.set(key, test);
    };
    for (const session of sessions) {
      if (session.ended || session.checkout || !sameRoot(session.root, root)) continue;
      for (const worker of session.workers) if (worker.test && worker.state !== 'between') add(worker.test);
    }
    for (const [ref, run] of this.runs) {
      if (this.reported.has(ref) || !sameRoot(run.root, root)) continue;
      for (const { test } of run.results.values()) add(test);
    }
    for (const { test } of this.keptOf(root)?.results.values() ?? []) add(test);
    return [...tests].flatMap(([key, test]) => {
      const state = this.stateOfKey(root, key, uriToPath(test.uri)!, sessions);
      return state ? [{ uri: test.uri, title: test.title, status: state.status, words: state.words }] : [];
    });
  }
}

/** A test's result over its Playwright projects: failed when one project's last attempt failed. */
function combined(projects: ReadonlyMap<string, Result> | undefined): Result | undefined {
  let result: Result | undefined;
  for (const status of projects?.values() ?? []) {
    if (status === 'failed') return 'failed';
    if (status === 'passed' || !result) result = status;
  }
  return result;
}

/** A test's key: its spec's path, without regard to case on Windows, as `path.relative` compares them, and its titles. */
function keyOf(file: string, titles: readonly string[]): string {
  const normal = path.resolve(file);
  return `${process.platform === 'win32' ? normal.toLowerCase() : normal}\0${JSON.stringify(titles)}`;
}

/** The key of a test a worker names, by its spec's URI; null for a URI that names no file. */
function testKeyOf(test: RunTest): string | null {
  const file = uriToPath(test.uri);
  return file ? keyOf(file, test.title) : null;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function sameRoot(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && path.relative(a, b) === '';
}

function uriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}
