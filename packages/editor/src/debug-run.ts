/**
 * A run that debugs one test from a failure: **Debug in my editor** on the dashboard's failure page, through the IDE's
 * open link with `debug=1` (`RunTestsArgs.debug`). The test is found in its spec by its title (`debugTest`) and run
 * headed with one worker (`debugArgs`), and it stops once at the failing line: a breakpoint of that run alone, which
 * its breakpoints carry until a worker stops there, whatever the editor's own breakpoints become meanwhile
 * (`DebugRuns.breakpoints`), and never one of the editor's. At that stop, the failure's suggested locator (the
 * recommendation of its locator healing on the instance) is counted on the stopped page, outlined there where the
 * pause bar shows, and said: in a notice, and at the end of the stopped line while the caret is there and the outline
 * stands (`DebugRuns.atCaret`), so the caret's own count does not take it down.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCalls, type TestCall } from './analysis.js';
import type {
  DebugRun,
  EditorBreakpoint,
  LocatorAtCaretParams,
  LocatorAtCaretResult,
  Notice,
  RunStop,
  SetRunBreakpointsParams,
} from './protocol.js';
import type { RunHeard, RunSessions } from './run-sessions.js';

/** How the dashboard joins a test's describe blocks' titles and its own. */
const TITLE_SEPARATOR = ' › ';

/** The longest title a debug run names, and the longest Playwright project name. */
export const MAX_DEBUG_TITLE = 1000;
export const MAX_DEBUG_PROJECT = 200;

/** The runs whose one-shot stop and suggested locator the service keeps, at most. */
const MAX_DEBUG_RUNS = 50;

/**
 * What a debug run's title and project may hold: text alone, no control character, and none of the characters a
 * client's message could read as markup or a link (`[`, `]`, `<`, `>`, a backtick, a backslash).
 */
const PLAIN_TEXT = /^[^\p{Cc}[\]<>`\\]+$/u;

/** A debug run's fields as a client sent them, checked one by one; why not otherwise. */
export function checkedDebugRun(value: unknown): DebugRun | string {
  const run = value as Partial<DebugRun> | null;
  const stop = run?.stop as Partial<EditorBreakpoint> | undefined;
  if (typeof stop?.uri !== 'string' || !Number.isSafeInteger(stop.line) || stop.line! < 0) {
    return 'The failing line to stop at is missing.';
  }
  const title = typeof run?.title === 'string' ? run.title.trim() : '';
  if (!title || title.length > MAX_DEBUG_TITLE || !PLAIN_TEXT.test(title)) {
    return "The test's title is not one Piwi takes: text alone, of 1,000 characters at most.";
  }
  const project = run?.project === undefined || run.project === null || run.project === '' ? null : run.project;
  if (
    project !== null &&
    (typeof project !== 'string' || project.length > MAX_DEBUG_PROJECT || !PLAIN_TEXT.test(project))
  ) {
    return 'The Playwright project is not one Piwi takes: text alone, of 200 characters at most.';
  }
  const execution = run?.execution ?? null;
  if (execution !== null && (!Number.isSafeInteger(execution) || execution <= 0)) {
    return 'The failed execution is not an id Piwi takes.';
  }
  return { stop: { uri: stop.uri, line: stop.line! }, title, project, execution };
}

/**
 * The test of a spec's `text` that `title` names: the one whose describe blocks' titles and its own, joined by
 * {@link TITLE_SEPARATOR}, are `title`, else the only one whose own title it is (a dashboard that knows no describe
 * block). A title written with `${…}` parts, in a template literal, names the tests whose title it gives with any text
 * in their place, when no title is `title` as written. Why not otherwise, naming the spec (`spec`).
 */
export function debugTest(text: string, spec: string, title: string): TestCall | string {
  const calls = testCalls(text.split(/\r?\n/));
  const exact = testsTitled(calls, (written) => written === title);
  const own = exact.length ? exact : testsTitled(calls, (written) => computedTitleGives(written, title));
  if (own.length === 1) return own[0]!;
  if (own.length) {
    return `${own.length} tests of ${spec} are titled “${title}”, so Piwi runs none of them: run the one to debug yourself.`;
  }
  const computed = calls.some((c) => [...c.suite, c.title].some((written) => written.includes('${')));
  return computed
    ? `No test of ${spec} is titled “${title}” as it is saved, so Piwi runs nothing: the test may have been renamed or moved since the run, or its title is computed from more than its \`\${…}\` parts.`
    : `No test of ${spec} is titled “${title}” as it is saved, so Piwi runs nothing: the test may have been renamed or moved since the run.`;
}

/** The tests whose describe blocks' titles and own, joined, `match`; else those whose own title does. */
function testsTitled(calls: TestCall[], match: (written: string) => boolean): TestCall[] {
  const named = calls.filter((c) => match([...c.suite, c.title].join(TITLE_SEPARATOR)));
  return named.length ? named : calls.filter((c) => match(c.title));
}

/** Whether a title written with `${…}` parts gives `title`, each part standing for any text. */
function computedTitleGives(written: string, title: string): boolean {
  if (!written.includes('${')) return false;
  const fixed = written.split(/\$\{[^}]*\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${fixed.join('[\\s\\S]*?')}$`).test(title);
}

/**
 * The arguments that debug the test at `location` (`tests/cart.spec.ts:3`): it alone, in the Playwright project it
 * failed in when one is named, with one worker. A test whose title is computed (`test` written with `${…}`) can stand
 * for several at its line: `title`, the run's title of the one that failed, then narrows the run to the tests whose
 * title holds it, when it holds no character a pattern or a shell reads.
 */
export function debugArgs(
  location: string,
  project: string | null | undefined,
  test?: Pick<TestCall, 'title'>,
  title?: string,
): string[] {
  const own = title?.split(TITLE_SEPARATOR).pop()?.trim() ?? '';
  const grep = test?.title.includes('${') && PLAIN_GREP.test(own) ? [`--grep=${own}`] : [];
  return [location, ...(project ? [`--project=${project}`] : []), ...grep, '--workers=1'];
}

/** A title that reads as itself in a `--grep` pattern and in a quoted shell word. */
const PLAIN_GREP = /^[\p{L}\p{N} _,:;'@#/=<>~&-]+$/u;

/** What the sessions do for a debug run: replace its breakpoints, and count a locator on a stopped page. */
export interface DebugRunsOptions {
  sessions: Pick<RunSessions, 'setBreakpoints' | 'locator'>;
  /** A sentence for the client about the run's folder. */
  notice(root: string | null, severity: Notice['severity'], message: string): void;
}

/** A debug run the service built, by its ref. */
interface Planned {
  /** The failing line, as the client named it, and its file. */
  stop: EditorBreakpoint;
  file: string;
  /** Until a worker stopped at the failing line: its breakpoints carry it. */
  armed: boolean;
  /** The editor's own breakpoints of the run: those it started with, then the latest the client sent. */
  own: EditorBreakpoint[];
  /** Asks the instance for the failure's suggested locator; null without an execution. */
  candidate: (() => Promise<string | null>) | null;
}

/** The suggested locator outlined at a stop, on its line. */
interface Outline {
  locator: string;
  file: string;
  line: number;
}

function uriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** The debug runs the service built: the one-shot stop of each and, at it, the suggested locator outlined. */
export class DebugRuns {
  private readonly runs = new Map<string, Planned>();
  /** The suggested locators outlined, by the stop they are outlined at (its run and `since`). */
  private readonly outlines = new Map<string, Promise<Outline | null>>();

  constructor(private readonly options: DebugRunsOptions) {}

  /**
   * A debug run built: it stops once at `stop`, its command carrying the editor's breakpoints `own` too. `candidate`
   * asks the instance for the failure's suggested locator: at once, so its answer is there by the stop, and at the
   * stop again, which an instance read since answers from what it holds.
   */
  started(
    ref: string,
    stop: EditorBreakpoint,
    own: EditorBreakpoint[],
    candidate: (() => Promise<string | null>) | null,
  ): void {
    const file = uriToPath(stop.uri);
    if (!file) return;
    void candidate?.().catch(() => null);
    this.runs.delete(ref);
    this.runs.set(ref, { stop, file, armed: true, own, candidate });
    for (const oldest of this.runs.keys()) {
      if (this.runs.size <= MAX_DEBUG_RUNS) break;
      this.runs.delete(oldest);
    }
  }

  /**
   * The breakpoints the client sent for a run (`piwi/setRunBreakpoints`), as its workers get them: a debug run's carry
   * its failing line until a worker stopped there.
   */
  breakpoints(params: SetRunBreakpointsParams): SetRunBreakpointsParams {
    const run = typeof params?.ref === 'string' ? this.runs.get(params.ref) : undefined;
    if (!run || !Array.isArray(params.places)) return params;
    run.own = params.places;
    return run.armed ? { ref: params.ref, places: [...params.places, run.stop] } : params;
  }

  /**
   * What a worker of a run said. At a debug run's first stop on its failing line, the run's breakpoints lose that line,
   * and the failure's suggested locator is counted and outlined on the stopped page; a stop that ends takes its outline
   * with it.
   */
  heard(ref: string, worker: number | null, what: RunHeard, root: string | null): void {
    const run = this.runs.get(ref);
    if (!run) return;
    if (what.type === 'running') {
      this.outlines.delete(`${ref}\0${what.since}`);
      return;
    }
    if (what.type !== 'stopped' || worker === null || !run.armed) return;
    const stop = what.stop;
    const file = uriToPath(stop.uri);
    if (stop.reason === 'failure' || stop.line !== run.stop.line || !file || path.relative(file, run.file) !== '') {
      return;
    }
    run.armed = false;
    this.options.sessions.setBreakpoints({ ref, places: run.own });
    if (run.candidate) this.outlines.set(`${ref}\0${stop.since}`, this.outline(ref, worker, stop, run, root));
  }

  /**
   * `piwi/locatorAtCaret` at a stop whose suggested locator is outlined: on the stopped line, that locator, with no
   * count, the outline left as it is; null elsewhere, where the caret's own count goes on, and takes the outline down.
   */
  async atCaret(params: LocatorAtCaretParams): Promise<LocatorAtCaretResult | null> {
    if (typeof params?.ref !== 'string' || typeof params.since !== 'string') return null;
    const key = `${params.ref}\0${params.since}`;
    const outlined = this.outlines.get(key);
    if (!outlined) return null;
    const shown = await outlined;
    const file = typeof params.uri === 'string' ? uriToPath(params.uri) : null;
    if (shown && file && path.relative(file, shown.file) === '' && params.line === shown.line) {
      return {
        ok: true,
        message: `suggested locator ${shown.locator} (outlined on the page)`,
        locator: shown.locator,
        count: null,
      };
    }
    this.outlines.delete(key);
    return null;
  }

  /** Count the failure's suggested locator at the stop, outlined where the pause bar shows, and say so. */
  private async outline(
    ref: string,
    worker: number,
    stop: RunStop,
    run: Planned,
    root: string | null,
  ): Promise<Outline | null> {
    const locator = await (run.candidate?.() ?? Promise.resolve(null)).catch(() => null);
    if (!locator) return null;
    const answer = await this.options.sessions.locator({ ref, worker, since: stop.since }, locator);
    const say = (message: string) => this.options.notice(root, 'information', message);
    if (!answer.ok) {
      say(`Piwi's suggested locator: ${locator}. ${answer.message}`);
      return null;
    }
    if (!answer.count) {
      say(`Piwi's suggested locator, ${locator}, matches nothing on the stopped page.`);
      return null;
    }
    say(`Piwi's suggested locator: ${locator}${stop.bar ? ' (outlined on the page)' : ''}. ${answer.message}`);
    return stop.bar ? { locator, file: run.file, line: stop.line } : null;
  }
}
