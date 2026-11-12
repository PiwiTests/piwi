/**
 * The CI runs of the branch a context reads, or of the checked-out branch, while they run: read-only sessions beside
 * the runs the editor follows (`piwi/ciSessionChanged`). A run is found as the instance's stream announces it
 * (`RunWatch`'s `runStarted`), or as the context reads it in progress (its latest run, its run in progress). It is
 * followed through its own stream, the connection `RunStreams` shares with the context's run in progress: its tests,
 * whether its live view can be watched, and the call each running test is at, from the steps its reporter streams
 * while someone follows the run. Its tally also comes from the instance's stream (`run-progress`). At most
 * `MAX_CI_RUNS` runs of one branch are followed, the newest. Nothing here steers a run: no control, share or hold.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PiwiContext } from './context.js';
import type { PiwiClient, RunDetails } from './piwi-client.js';
import { MAX_CI_TESTS, type CiPosition, type CiSession, type CiTest, type LiveTestStatus } from './protocol.js';
import type { InstanceEvent, RunEvent, RunStreams } from './run-stream.js';
import { countsOf, endedStatus, isCiRun } from './run-watch.js';

/** The most CI runs of one instance, project and branch followed at once: the newest. */
export const MAX_CI_RUNS = 2;
/** A session's changes reach the client at most this often. */
const PUSH_MS = 500;
/** The most tests of a run kept in memory: past it, the oldest that passed or were skipped go. */
const MAX_KEPT_TESTS = 1_000;
/** The steps kept open per worker: a step inside a step inside a step. */
const MAX_OPEN_STEPS = 32;
/** The runs whose session ended that are kept, so a read of a run that ended since never follows it again. */
const MAX_ENDED_KEPT = 200;
/** The longest call title a position carries. */
const MAX_TITLE = 200;
const ACTIVE = new Set(['running', 'initializing', 'finalizing']);

export interface CiSessionsOptions {
  /** The service's contexts. */
  contexts: () => readonly PiwiContext[];
  /** The runs' streams, shared with the runs in progress the contexts follow. */
  streams: Pick<RunStreams, 'follow'>;
  /** A session changed, or ended: the client hears it. */
  changed: (session: CiSession) => void;
  /** Whether a file of the workspace exists. */
  exists?: (file: string) => boolean;
  /** How often a session's changes reach the client, at most. */
  pushMs?: number;
}

/** A test of a followed run, as its stream names it. */
interface KeptTest {
  title: string[];
  /** Its spec as the run names it, relative to the run's Playwright config. */
  file: string;
  /** Its `test(…)` call's 1-based line; null when the run names none. */
  line: number | null;
  project: string;
  status: LiveTestStatus;
  retry: number;
  /** Playwright's worker index, which the steps name. */
  worker: number | null;
  lane: number | null;
  shard: number | null;
  /** When it last began or ended, in the order the stream told it. */
  seq: number;
}

/** An open step of a worker: its title and where it runs, as the run's reporter names it. */
interface OpenStep {
  /** The step's title as sent, which its end names again. */
  name: string;
  /** As a position shows it: the title, then the call's target where the reporter sends it apart. */
  title: string;
  /** The location as sent (`/ci/work/tests/a.spec.ts:12:5`), which its end names again. */
  location: string;
  file: string;
  line: number;
  column: number;
}

interface Followed {
  key: string;
  context: PiwiContext;
  client: PiwiClient;
  serverUrl: string;
  projectId: number;
  runId: number;
  branch: string | null;
  startedAt: string;
  status: string;
  counts: { done: number; total: number; failed: number; skipped: number };
  tests: Map<string, KeptTest>;
  /** Each worker's open steps, by `shard:worker`, the innermost last. */
  steps: Map<string, OpenStep[]>;
  /**
   * Where the run's Playwright config sits on the CI machine (`/home/runner/work/shop/shop/`), as a step in a spec told
   * it: the step locations under it are files of the context's folder.
   */
  ciBase: string | null;
  watchable: boolean;
  seq: number;
  unfollow: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  pushedAt: number;
  sent: string;
}

/** A location as a run names it, `file:line:column`, the file in `/` separators; null for `unknown`. */
export function parseLocation(location: unknown): { file: string; line: number; column: number } | null {
  if (typeof location !== 'string') return null;
  const match = /^(.+):(\d+):(\d+)$/.exec(location);
  if (!match) return null;
  return { file: match[1]!.replace(/\\/g, '/'), line: Number(match[2]), column: Number(match[3]) };
}

/**
 * Where the run's Playwright config sits on the CI machine, from a step of a test in `testFile` (relative to the
 * config, as the run names the test's spec) that runs in `stepFile`: the folder before that relative path; null when
 * the step is in another file.
 */
export function ciBaseOf(stepFile: string, testFile: string): string | null {
  const spec = testFile.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!spec || spec.split('/').includes('..')) return null;
  if (!stepFile.endsWith(`/${spec}`)) return null;
  return stepFile.slice(0, stepFile.length - spec.length);
}

/** A step's file relative to the run's Playwright config, when it lies under `ciBase`; null otherwise. */
export function ciRelative(ciBase: string | null, stepFile: string): string | null {
  return ciBase && stepFile.startsWith(ciBase) ? stepFile.slice(ciBase.length) : null;
}

/**
 * The file of the context's folder `root` that a path relative to the run's Playwright config names; null for one
 * outside the folder or in `node_modules`, and for one the workspace does not hold.
 */
export function workspaceFile(root: string, relative: string | null, exists: (file: string) => boolean): string | null {
  const parts = relative?.replace(/\\/g, '/').split('/') ?? [];
  if (!parts.length || parts.some((p) => p === '' || p === '.' || p === '..') || parts.includes('node_modules')) {
    return null;
  }
  const full = path.join(root, ...parts);
  const inside = path.relative(root, full);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return exists(full) ? full : null;
}

/** A test's key in its run: its spec, describe blocks, title, Playwright project and repetition. */
function testKey(data: Record<string, unknown>, project: string): string | null {
  if (typeof data.title !== 'string' || typeof data.filePath !== 'string') return null;
  const suite = Array.isArray(data.suitePath) ? data.suitePath.filter((s) => typeof s === 'string') : [];
  const repeat = typeof data.repeatEachIndex === 'number' ? data.repeatEachIndex : 0;
  return [data.filePath, ...suite, data.title, project, repeat].join('\x1f');
}

/** The Playwright project a run event names (`browser.projectName`); empty when it names none. */
function projectOf(data: Record<string, unknown>): string {
  const browser = data.browser as { projectName?: unknown } | null | undefined;
  return typeof browser?.projectName === 'string' ? browser.projectName : '';
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/** The key of a worker's steps: its shard and its worker index. */
const workerKey = (shard: number | null, worker: number) => `${shard ?? ''}:${worker}`;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A CI run's progress in words: `12 of 40 tests · 1 failed · 1 flaky`. */
export function ciSummary(progress: CiSession['progress']): string {
  const parts = [`${progress.done} of ${plural(progress.total, 'test')}`];
  if (progress.failed) parts.push(`${progress.failed} failed`);
  if (progress.flaky) parts.push(`${progress.flaky} flaky`);
  if (progress.status === 'finalizing') parts.push('finishing');
  return parts.join(' · ');
}

/** Who a position is of, in words: `worker 2`, `shard 1, worker 2`, or nothing for a run that names no lane. */
function laneWords(test: Pick<CiTest, 'lane' | 'shard'>): string {
  if (test.lane === null) return '';
  return test.shard !== null ? `shard ${test.shard}, worker ${test.lane}` : `worker ${test.lane}`;
}

/** The words shown at a CI position's line: `CI run #78 · worker 2: Click getByRole('button')`. */
export function positionText(runId: number, test: Pick<CiTest, 'lane' | 'shard'>, call: string): string {
  const lane = laneWords(test);
  return `CI run #${runId}${lane ? ` · ${lane}` : ''}: ${call}`;
}

/**
 * The tests a session lists: those running, by shard and lane, then those that ended, newest first, a failure kept
 * before a pass, `MAX_CI_TESTS` at most in all.
 */
export function listedTests<
  T extends { status: LiveTestStatus; seq: number; shard: number | null; lane: number | null },
>(tests: Iterable<T>): T[] {
  const all = [...tests];
  const running = all
    .filter((t) => t.status === 'running')
    .sort((a, b) => (a.shard ?? 0) - (b.shard ?? 0) || (a.lane ?? 0) - (b.lane ?? 0) || a.seq - b.seq)
    .slice(0, MAX_CI_TESTS);
  const ended = all.filter((t) => t.status !== 'running').sort((a, b) => b.seq - a.seq);
  const room = MAX_CI_TESTS - running.length;
  const failures = ended.filter((t) => t.status === 'failed' || t.status === 'flaky').slice(0, room);
  const others = ended.filter((t) => t.status !== 'failed' && t.status !== 'flaky').slice(0, room - failures.length);
  return [...running, ...[...failures, ...others].sort((a, b) => b.seq - a.seq)];
}

/** One per service: the CI sessions of every context. */
export class CiSessions {
  private readonly followed = new Map<string, Followed>();
  /** The runs whose session ended, by instance and run, the latest `MAX_ENDED_KEPT`: never followed again. */
  private readonly endedRuns = new Set<string>();
  private disposed = false;

  constructor(private readonly options: CiSessionsOptions) {}

  /**
   * A run of a context's project started, or the context reads it in progress: a CI run of the branch the context
   * reads, or of the checked-out branch, is followed, one of the newest `MAX_CI_RUNS` of that branch.
   */
  offer(
    context: PiwiContext,
    run: Pick<RunDetails, 'id' | 'status' | 'branch' | 'startTime' | 'metadata'> & {
      origin?: string;
    },
  ): void {
    const client = context.client;
    const project = context.project;
    if (this.disposed || !client || !project || !ACTIVE.has(run.status) || !run.branch) return;
    const ci = run.origin !== undefined ? run.origin === 'ci' || run.origin === 'ci-rerun' : isCiRun(run as RunDetails);
    if (!ci || !this.onBranch(context, run.branch)) return;
    const serverUrl = client.connection.serverUrl;
    const key = `${serverUrl}\n${run.id}`;
    if (this.followed.has(key) || this.endedRuns.has(key)) return;
    const same = [...this.followed.values()]
      .filter((f) => f.serverUrl === serverUrl && f.projectId === project.id && f.branch === run.branch)
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    if (same.length >= MAX_CI_RUNS) {
      const oldest = same[0]!;
      if (Date.parse(run.startTime) <= Date.parse(oldest.startedAt)) return;
      this.end(oldest);
    }
    const followed: Followed = {
      key,
      context,
      client,
      serverUrl,
      projectId: project.id,
      runId: run.id,
      branch: run.branch,
      startedAt: run.startTime,
      status: run.status,
      counts: { done: 0, total: 0, failed: 0, skipped: 0 },
      tests: new Map(),
      steps: new Map(),
      ciBase: null,
      watchable: false,
      seq: 0,
      unfollow: () => {},
      timer: null,
      pushedAt: 0,
      sent: '',
    };
    this.count(followed, run as unknown as Record<string, unknown>);
    this.followed.set(key, followed);
    followed.unfollow = this.options.streams.follow(client, run.id, (event) => this.onRunEvent(followed, event));
    this.push(followed, true);
  }

  /**
   * The contexts' runs were read again: a CI run each reads in progress (its latest run, its run in progress) is
   * offered, and a session whose context reads another instance, project or branch ends.
   */
  sync(): void {
    if (this.disposed) return;
    const contexts = this.options.contexts();
    for (const f of Array.from(this.followed.values())) {
      const c = f.context;
      const current =
        contexts.includes(c) &&
        c.client?.connection.serverUrl === f.serverUrl &&
        c.project?.id === f.projectId &&
        this.onBranch(c, f.branch);
      if (!current) this.end(f);
    }
    for (const c of contexts) {
      const run = c.failures?.run;
      if (run?.origin) this.offer(c, run);
      if (c.live?.ci && c.live.branch) {
        this.offer(c, {
          id: c.live.runId,
          status: c.live.status,
          branch: c.live.branch,
          startTime: c.live.startedAt,
          origin: 'ci',
        });
      }
    }
  }

  /** An event of the instance's stream about a context's project: a followed run's tally, or its end. */
  instanceEvent(context: PiwiContext, event: InstanceEvent): void {
    const serverUrl = context.client?.connection.serverUrl;
    const f = serverUrl ? this.followed.get(`${serverUrl}\n${event.runId}`) : undefined;
    if (!f) return;
    switch (event.type) {
      case 'run-progress':
        this.count(f, event as unknown as Record<string, unknown>);
        this.push(f);
        break;
      case 'run-finalizing':
        f.status = 'finalizing';
        this.push(f);
        break;
      case 'run-finished':
      case 'run-submitted':
      case 'run-cancelled':
        if (event.status) f.status = event.status;
        this.end(f);
        break;
    }
  }

  /** The sessions followed now, as the client last heard them or is about to. */
  sessions(): CiSession[] {
    return [...this.followed.values()].map((f) => this.sessionOf(f, false));
  }

  /**
   * The run a client asks to watch a lane of (`piwi/ciWatch`): the session's root, the client of its instance, whether
   * it can be watched, and the worker of the lane's running test, else of its latest (Playwright's worker index, null
   * when the run named none there yet); null when no session of the run is followed, of `root` when it is named.
   */
  watchTarget(
    root: string | undefined,
    runId: number,
    shard: number | null,
    lane: number,
  ): { root: string; client: PiwiClient; watchable: boolean; worker: number | null } | null {
    const f = [...this.followed.values()].find(
      (each) => each.runId === runId && (root === undefined || each.context.root === root),
    );
    if (!f) return null;
    const [latest] = [...f.tests.values()]
      .filter((t) => t.lane === lane && t.shard === shard && t.worker !== null)
      .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.seq - a.seq);
    return { root: f.context.root, client: f.client, watchable: f.watchable, worker: latest?.worker ?? null };
  }

  dispose(): void {
    this.disposed = true;
    for (const f of this.followed.values()) {
      if (f.timer) clearTimeout(f.timer);
      f.unfollow();
    }
    this.followed.clear();
  }

  private onBranch(context: PiwiContext, branch: string | null): boolean {
    return !!branch && (branch === context.runBranch || branch === context.checkedOutBranch);
  }

  /** The run's counts from an event that carries them: its stream's `init`, `run-progress`, or the instance's tally. */
  private count(f: Followed, data: Record<string, unknown>): void {
    const counts = countsOf(data);
    if (!counts) return;
    f.counts = { ...counts, skipped: count(data.skippedTests) ?? 0 };
  }

  /** An event of the run's own stream. */
  private onRunEvent(f: Followed, event: RunEvent): void {
    if (this.followed.get(f.key) !== f) return;
    const data = event.data;
    switch (event.type) {
      case 'init':
      case 'run-progress':
        this.count(f, data);
        if (typeof data.status === 'string' && ACTIVE.has(data.status)) f.status = data.status;
        break;
      case 'run-finalizing':
        f.status = 'finalizing';
        break;
      case 'run-finished':
        this.count(f, data);
        if (typeof data.status === 'string' && !ACTIVE.has(data.status)) {
          f.status = data.status;
          this.end(f);
          return;
        }
        break;
      case 'live-view':
        f.watchable = data.enabled === true && data.keyed === true;
        break;
      case 'test-begin':
      case 'test-completed':
        this.testEvent(f, event.type, data);
        break;
      case 'step-begin':
      case 'step-end':
        this.stepEvent(f, event.type, data);
        break;
      default:
        return;
    }
    this.push(f);
  }

  /** A test began, or ended with its result; a suite's hooks name no test. */
  private testEvent(f: Followed, type: 'test-begin' | 'test-completed', data: Record<string, unknown>): void {
    if (data.filePath === 'hooks') return;
    const project = projectOf(data);
    const key = testKey(data, project);
    const status = type === 'test-begin' ? 'running' : endedStatus(data);
    if (!key || !status) return;
    const at = parseLocation(data.location);
    const worker = count(data.workerIndex);
    const shard = count(data.shardIndex);
    const lane = count(data.parallelIndex);
    const suite = Array.isArray(data.suitePath) ? data.suitePath.filter((s): s is string => typeof s === 'string') : [];
    const kept = f.tests.get(key);
    // A later attempt's events replace an earlier one's; an earlier one's that arrive late change nothing.
    const retry = count(data.retries) ?? 0;
    if (kept && retry < kept.retry) return;
    f.tests.delete(key);
    f.tests.set(key, {
      title: [...suite, data.title as string],
      file: data.filePath as string,
      line: at?.line ?? kept?.line ?? null,
      project,
      status,
      retry,
      worker: worker ?? kept?.worker ?? null,
      lane: lane !== null ? lane + 1 : (kept?.lane ?? null),
      shard: shard ?? kept?.shard ?? null,
      seq: ++f.seq,
    });
    // A worker that begins or ends a test leaves the steps of the one before.
    if (worker !== null) f.steps.delete(workerKey(shard, worker));
    if (status !== 'running') this.prune(f);
  }

  /** Past `MAX_KEPT_TESTS`, the oldest tests that passed or were skipped go, then the oldest that ended. */
  private prune(f: Followed): void {
    if (f.tests.size <= MAX_KEPT_TESTS) return;
    for (const pass of [
      (t: KeptTest) => t.status === 'passed' || t.status === 'skipped',
      (t: KeptTest) => t.status !== 'running',
    ]) {
      for (const [key, test] of f.tests) {
        if (f.tests.size <= MAX_KEPT_TESTS) return;
        if (pass(test)) f.tests.delete(key);
      }
    }
  }

  /** A worker's step began or ended: the innermost open step is where its test is. */
  private stepEvent(f: Followed, type: 'step-begin' | 'step-end', data: Record<string, unknown>): void {
    const worker = count(data.workerIndex);
    const at = parseLocation(data.location);
    if (worker === null || !at || typeof data.title !== 'string' || data.stepCategory === 'fixture') return;
    const key = workerKey(count(data.shardIndex), worker);
    const location = data.location as string;
    const open = f.steps.get(key) ?? [];
    if (type === 'step-end') {
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i]!.location !== location || open[i]!.name !== data.title) continue;
        open.splice(i);
        break;
      }
      return;
    }
    if (!f.ciBase) {
      const test = [...f.tests.values()].find(
        (t) => t.status === 'running' && t.worker === worker && t.shard === count(data.shardIndex),
      );
      if (test) f.ciBase = ciBaseOf(at.file, test.file);
    }
    const subtitle = typeof data.subtitle === 'string' && data.subtitle ? ` ${data.subtitle}` : '';
    open.push({ name: data.title, title: `${data.title}${subtitle}`.slice(0, MAX_TITLE), location, ...at });
    if (open.length > MAX_OPEN_STEPS) open.shift();
    f.steps.set(key, open);
  }

  /** Tell the client of a change: at once for the first, then at most every `PUSH_MS`. */
  private push(f: Followed, now = false): void {
    if (f.timer || this.disposed) return;
    const pace = this.options.pushMs ?? PUSH_MS;
    f.timer = setTimeout(
      () => {
        f.timer = null;
        if (this.followed.get(f.key) !== f) return;
        f.pushedAt = Date.now();
        this.send(f, this.sessionOf(f, false));
      },
      now ? 0 : Math.max(0, f.pushedAt + pace - Date.now()),
    );
    f.timer.unref?.();
  }

  private send(f: Followed, session: CiSession): void {
    const text = JSON.stringify(session);
    if (text === f.sent) return;
    f.sent = text;
    this.options.changed(session);
  }

  /** The session ends: the client hears it last, with `ended`, and the run's stream is let go. */
  private end(f: Followed): void {
    if (this.followed.get(f.key) !== f) return;
    this.followed.delete(f.key);
    this.endedRuns.add(f.key);
    for (const oldest of this.endedRuns) {
      if (this.endedRuns.size <= MAX_ENDED_KEPT) break;
      this.endedRuns.delete(oldest);
    }
    if (f.timer) clearTimeout(f.timer);
    f.timer = null;
    f.unfollow();
    this.send(f, this.sessionOf(f, true));
  }

  private sessionOf(f: Followed, ended: boolean): CiSession {
    const root = f.context.root;
    const exists = this.options.exists ?? fs.existsSync;
    const url = f.client.runUrl(f.runId);
    const flaky = [...f.tests.values()].filter((t) => t.status === 'flaky').length;
    const progress = { ...f.counts, flaky, status: f.status };
    const specs = new Map<string, string | null>();
    const specUri = (file: string): string | null => {
      if (!specs.has(file)) {
        const full = workspaceFile(root, file.replace(/^\.\//, ''), exists);
        specs.set(file, full ? pathToFileURL(full).href : null);
      }
      return specs.get(file)!;
    };
    const tests = listedTests(f.tests.values()).map((t): CiTest => {
      const running = t.status === 'running' && !ended;
      const at = running && t.worker !== null ? this.positionOf(f, t, exists) : null;
      const uri = specUri(t.file);
      return {
        title: t.title,
        uri,
        line: uri && t.line !== null ? t.line - 1 : null,
        project: t.project,
        status: t.status,
        retry: t.retry,
        lane: t.lane,
        shard: t.shard,
        at,
        watch:
          running && f.watchable && t.lane !== null
            ? `${url}?watch=${t.shard !== null ? `${t.shard}.` : ''}${t.lane}`
            : null,
      };
    });
    return {
      runId: f.runId,
      root,
      url,
      name: `CI run #${f.runId}`,
      branch: f.branch,
      startedAt: f.startedAt,
      progress,
      summary: ciSummary(progress),
      tests,
      watchable: f.watchable && !ended,
      ended,
    };
  }

  /** The innermost open step of a test's worker that runs in a file of the workspace. */
  private positionOf(f: Followed, test: KeptTest, exists: (file: string) => boolean): CiPosition | null {
    const open = f.steps.get(workerKey(test.shard, test.worker!)) ?? [];
    for (let i = open.length - 1; i >= 0; i--) {
      const step = open[i]!;
      const file = workspaceFile(f.context.root, ciRelative(f.ciBase, step.file), exists);
      if (!file) continue;
      return {
        title: step.title,
        uri: pathToFileURL(file).href,
        line: Math.max(0, step.line - 1),
        character: step.column > 0 ? step.column - 1 : null,
        text: positionText(f.runId, test, step.title),
      };
    }
    return null;
  }
}
