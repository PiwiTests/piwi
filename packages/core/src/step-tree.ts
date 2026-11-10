/**
 * The structure of a flattened Playwright step list: each step's parent, the
 * phase it ran in (setup, the test body, teardown), the step that actually
 * failed, and the steps Piwi's own capture added.
 *
 * Playwright reports steps as a tree: `Before Hooks` holds the `beforeAll` /
 * `beforeEach` hooks and the fixtures they set up, the test body follows, and
 * `After Hooks` (then `Worker Cleanup`) holds the teardown. A failing step marks
 * every step around it failed too, so one error makes a failing chain, and the
 * step that failed is the innermost step of the chain that carries the test's
 * own error. A run can hold other errored steps: an error the test caught and
 * went on from (`try`/`catch`, a retried `toPass` attempt), which the reporter
 * marks `recovered`, a second soft assertion, or a teardown that failed after
 * the body. Stored steps are flat: the tree is rebuilt from each step's `depth`
 * when every step records one, else from start times and durations (a step
 * contains the steps that run inside its span), else every step is top level.
 */
import { extractTopFrame, stripAnsi } from './error-parse';
import { sameFilePath } from './locator-break';

/** The fields of a stored step the structure reads. */
export interface TreeStepLike {
  title?: unknown;
  category?: unknown;
  failed?: boolean | null;
  /**
   * `{ message, location }` as the reporter records it (`location` is where the
   * error was thrown, `file:line:col`); a bare string on some older rows.
   */
  error?: { message?: unknown; location?: unknown } | string | null;
  /** The step's error is none of the test's errors: the test caught it and went on. */
  recovered?: boolean | null;
  depth?: unknown;
  startTime?: unknown;
  duration?: unknown;
  location?: unknown;
}

/** Where a step ran: before the test body, in it, or after it. */
export type StepPhase = 'setup' | 'body' | 'teardown';

/** Where a failure happened when the failing step ran outside the test body. */
export interface FailureHookContext {
  phase: 'setup' | 'teardown';
  /** What failed, by its short name: `beforeAll`, `fixture "db"`, `hook "seed"`, or the phase itself. */
  hook: string;
}

/** Slack for millisecond rounding when a step's span is compared with its parent's. */
const SPAN_TOLERANCE_MS = 1;

const SETUP_CONTAINER_RE = /^before hooks$/i;
const TEARDOWN_CONTAINER_RE = /^(?:after hooks|worker cleanup|worker teardown)$/i;
const NAMED_HOOK_RE = /^(before|after)(each|all) hook$/i;
const FIXTURE_TITLE_RE = /^fixture\s+["“](.+)["”]$/i;

/** A step Piwi's capture attached (`Attach "piwi-…"`), and its own auto fixtures. */
const CAPTURE_ATTACH_RE = /^attach\s+["“]piwi-/i;
const CAPTURE_FIXTURE_RE = /^fixture\s+["“]piwi(?:Capture|Resources)["”]$/i;
/** A capture read made through the reporter bundle (recorded by reporters that did not keep them internal). */
const CAPTURE_PROBE_TITLE_RE = /^(?:evaluate|aria snapshot|locator\.(?:evaluate|ariasnapshot)|page\.evaluate)\b/i;
const REPORTER_BUNDLE_RE = /[\\/](?:@piwitests[\\/]reporter|packages[\\/]reporter)[\\/]dist[\\/]/;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A stored step's error message, whichever shape the row keeps it in. */
function errorMessage(step: TreeStepLike): string {
  const error = step.error;
  if (typeof error === 'string') return error;
  return str(error?.message);
}

/** Where a stored step's error was thrown, `file:line:col`; empty when the row records none. */
function errorLocation(step: TreeStepLike): string {
  const error = step.error;
  return typeof error === 'string' ? '' : str(error?.location);
}

/** A `file:line:col` location, parsed. */
function parseLocation(location: string): { file: string; line: number; column: number } | null {
  const m = /^(.+):(\d+):(\d+)$/.exec(location.trim());
  return m ? { file: m[1]!, line: Number(m[2]), column: Number(m[3]) } : null;
}

/** Whether two locations point at the same line and column of the same file (one path may be relative). */
export function sameCodeLocation(
  a: { file: string; line: number; column: number } | string | null | undefined,
  b: { file: string; line: number; column: number } | string | null | undefined,
): boolean {
  const x = typeof a === 'string' ? parseLocation(a) : a;
  const y = typeof b === 'string' ? parseLocation(b) : b;
  if (!x || !y) return false;
  return x.line === y.line && x.column === y.column && sameFilePath(x.file, y.file);
}

/** Whether a stored step failed: marked failed, or carrying an error. */
function isFailedStep(step: TreeStepLike): boolean {
  return step.failed === true || errorMessage(step).trim().length > 0;
}

/** Whether the reporter marked a step's error as caught: the test went on after it. */
function isRecoveredStep(step: TreeStepLike): boolean {
  return step.recovered === true;
}

/**
 * Whether a step belongs to Piwi's own capture rather than to the test: its
 * `piwiCapture` and `piwiResources` fixtures, an `Attach "piwi-…"` step, or a
 * page read the capture fixtures made through the reporter bundle.
 */
export function isCaptureStep(step: TreeStepLike): boolean {
  const title = str(step.title).trim();
  if (CAPTURE_ATTACH_RE.test(title) || CAPTURE_FIXTURE_RE.test(title)) return true;
  return CAPTURE_PROBE_TITLE_RE.test(title) && REPORTER_BUNDLE_RE.test(str(step.location));
}

/** Whether a step is one of Playwright's phase containers (`Before Hooks`, `After Hooks`, `Worker Cleanup`). */
export function isPhaseContainer(step: TreeStepLike): boolean {
  const title = str(step.title).trim();
  return SETUP_CONTAINER_RE.test(title) || TEARDOWN_CONTAINER_RE.test(title);
}

/** The parent index of every step, -1 for a top-level step. */
export function stepParents(steps: readonly TreeStepLike[]): number[] {
  const parents = steps.map(() => -1);
  if (steps.length === 0) return parents;

  if (steps.every((s) => num(s.depth) !== null)) {
    const stack: number[] = [];
    steps.forEach((step, i) => {
      const depth = num(step.depth)!;
      while (stack.length > 0 && num(steps[stack[stack.length - 1]!]!.depth)! >= depth) stack.pop();
      parents[i] = stack.length > 0 ? stack[stack.length - 1]! : -1;
      stack.push(i);
    });
    return parents;
  }

  if (steps.every((s) => num(s.startTime) !== null && num(s.duration) !== null)) {
    const start = (i: number) => num(steps[i]!.startTime)!;
    const end = (i: number) => start(i) + Math.max(0, num(steps[i]!.duration)!);
    // A step contains a later one that starts before it ends and finishes by
    // its end; a zero-length step contains nothing. Millisecond timestamps
    // leave a zero-length step at a parent's last instant ambiguous: it is read
    // as the parent's next sibling.
    const contains = (a: number, b: number) =>
      end(a) > start(a) &&
      start(b) >= start(a) - SPAN_TOLERANCE_MS &&
      start(b) < end(a) &&
      end(b) <= end(a) + SPAN_TOLERANCE_MS;
    const stack: number[] = [];
    steps.forEach((_, i) => {
      while (stack.length > 0 && !contains(stack[stack.length - 1]!, i)) stack.pop();
      parents[i] = stack.length > 0 ? stack[stack.length - 1]! : -1;
      stack.push(i);
    });
  }
  return parents;
}

/** Whether step `descendant` sits somewhere under step `ancestor`. */
function isDescendant(descendant: number, ancestor: number, parents: readonly number[]): boolean {
  for (let p = parents[descendant] ?? -1; p !== -1; p = parents[p] ?? -1) {
    if (p === ancestor) return true;
  }
  return false;
}

/** The top-level step each step sits under (itself when top level). */
function topAncestor(index: number, parents: readonly number[]): number {
  let top = index;
  while ((parents[top] ?? -1) !== -1) top = parents[top]!;
  return top;
}

/**
 * The phase every step ran in: a step under `Before Hooks` ran in setup, one
 * under `After Hooks` or `Worker Cleanup` in teardown, the rest in the test
 * body. The containers themselves take the phase they hold.
 */
export function stepPhases(steps: readonly TreeStepLike[], parents = stepParents(steps)): StepPhase[] {
  return steps.map((_, i) => {
    const top = str(steps[topAncestor(i, parents)]!.title).trim();
    if (SETUP_CONTAINER_RE.test(top)) return 'setup';
    if (TEARDOWN_CONTAINER_RE.test(top)) return 'teardown';
    return 'body';
  });
}

/** The first line of an error message, without ANSI codes. */
function firstLine(message: unknown): string {
  return stripAnsi(str(message)).split('\n')[0]!.trim();
}

/** The first line of each error in an execution's error text (the reporter joins several with `---`). */
function errorHeads(error: string): string[] {
  return error
    .split(/\n---\n/)
    .map(firstLine)
    .filter((head) => head.length > 0);
}

/**
 * Whether an inner step carries the same error as a failing step around it —
 * the error propagating out, rather than one caught inside. A step whose error
 * text is missing is taken to carry it.
 */
function sameError(inner: TreeStepLike, outer: TreeStepLike): boolean {
  const a = firstLine(errorMessage(inner));
  const b = firstLine(errorMessage(outer));
  if (!a || !b) return true;
  if (a !== b) return false;
  const at = errorLocation(inner);
  const bt = errorLocation(outer);
  return !at || !bt || sameCodeLocation(at, bt);
}

/**
 * The last of `indices` in the test body, else in setup, else in teardown. A
 * fatal error ends its phase, and the teardown runs after a failed body.
 */
function lastByPhase(indices: readonly number[], phases: readonly StepPhase[]): number | null {
  for (const phase of ['body', 'setup', 'teardown'] as const) {
    const inPhase = indices.filter((i) => phases[i] === phase);
    if (inPhase.length > 0) return inPhase[inPhase.length - 1]!;
  }
  return null;
}

/**
 * The innermost step of every failing chain, in order. A chain starts at a
 * failed step with no failed step around it and walks down through the steps
 * that carry its error, so a caught error inside it is never its end. The
 * capture's own steps and the steps the reporter marked recovered take no part.
 */
function failingChainEnds(steps: readonly TreeStepLike[], parents: readonly number[]): number[] {
  const candidates: number[] = [];
  steps.forEach((step, i) => {
    if (isFailedStep(step) && !isCaptureStep(step) && !isRecoveredStep(step)) candidates.push(i);
  });
  const isCandidate = new Set(candidates);
  const hasFailedAncestor = (i: number) => {
    for (let p = parents[i] ?? -1; p !== -1; p = parents[p] ?? -1) if (isCandidate.has(p)) return true;
    return false;
  };
  return candidates
    .filter((root) => !hasFailedAncestor(root))
    .map((root) => {
      let current = root;
      for (;;) {
        const inner = candidates.filter((c) => c > current && isDescendant(c, current, parents));
        const carrying = inner.filter((c) => sameError(steps[c]!, steps[current]!));
        if (carrying.length === 0) return current;
        current = carrying[carrying.length - 1]!;
      }
    });
}

/**
 * The step that failed: the innermost step of the failing chain that carries
 * the test's own error, skipping the capture's own steps and the errors the
 * test caught. `error` is the execution's error text: the chain whose error
 * matches it, thrown where the text points, wins; then the one whose error only
 * matches its first line. Without a match, the last failing chain of the test
 * body, else of setup, else of teardown. Null when no step failed.
 */
export function failingStepIndex(
  steps: readonly TreeStepLike[],
  parents = stepParents(steps),
  error?: string | null,
): number | null {
  const ends = failingChainEnds(steps, parents);
  if (ends.length === 0) return null;
  const phases = stepPhases(steps, parents);
  if (error) {
    const heads = errorHeads(error);
    const headOf = (i: number) => firstLine(errorMessage(steps[i]!));
    const frame = extractTopFrame(error);
    if (frame) {
      const thrownThere = ends.filter(
        (i) =>
          heads.includes(headOf(i)) && sameCodeLocation(errorLocation(steps[i]!) || str(steps[i]!.location), frame),
      );
      const located = lastByPhase(thrownThere, phases);
      if (located !== null) return located;
    }
    for (const head of heads) {
      const matching = lastByPhase(
        ends.filter((i) => headOf(i) === head),
        phases,
      );
      if (matching !== null) return matching;
    }
  }
  return lastByPhase(ends, phases) ?? ends[ends.length - 1]!;
}

/** How a step took part in its execution's failure. */
export type StepFailureRole =
  /** The step that failed. */
  | 'failing'
  /** A step around it: Playwright marks every enclosing step failed. */
  | 'enclosing'
  /** Another failure: a second soft assertion, a teardown that failed after the body. */
  | 'failed'
  /** An error the test caught and went on from. */
  | 'recovered';

/**
 * Each step's part in the failure, null for a step that passed. A failed step
 * outside the failing chain was caught when the reporter marked it recovered,
 * when a step around it was, or when its error is none of the test's errors
 * (`error`, the execution's error text). The capture's own steps are null.
 */
export function stepFailureRoles(
  steps: readonly TreeStepLike[],
  error?: string | null,
  parents = stepParents(steps),
  failing = failingStepIndex(steps, parents, error),
): Array<StepFailureRole | null> {
  const enclosing = new Set<number>();
  if (failing !== null) for (let p = parents[failing] ?? -1; p !== -1; p = parents[p] ?? -1) enclosing.add(p);
  const heads = error ? errorHeads(error) : [];
  const roles: Array<StepFailureRole | null> = [];
  steps.forEach((step, i) => {
    if (!isFailedStep(step) || isCaptureStep(step)) {
      roles.push(null);
      return;
    }
    if (i === failing) {
      roles.push('failing');
      return;
    }
    if (enclosing.has(i)) {
      roles.push('enclosing');
      return;
    }
    const head = firstLine(errorMessage(step));
    const parent = parents[i] ?? -1;
    const caught =
      isRecoveredStep(step) ||
      (parent !== -1 && roles[parent] === 'recovered') ||
      (heads.length > 0 && head.length > 0 && !heads.includes(head));
    roles.push(caught ? 'recovered' : 'failed');
  });
  return roles;
}

/** The hook or fixture a step is, by its short name (`beforeAll`, `fixture "db"`); null for any other step. */
export function stepHookName(step: TreeStepLike): string | null {
  const title = str(step.title).trim();
  const category = str(step.category);
  const named = NAMED_HOOK_RE.exec(title);
  if (named) return `${named[1]!.toLowerCase()}${named[2]![0]!.toUpperCase()}${named[2]!.slice(1).toLowerCase()}`;
  const fixture = FIXTURE_TITLE_RE.exec(title);
  if (fixture) return `fixture "${fixture[1]}"`;
  if (category === 'fixture') return title ? `fixture "${title.replace(/^fixture:\s*/i, '')}"` : null;
  if (category === 'hook' && title && !isPhaseContainer(step)) return `hook "${title}"`;
  return null;
}

/**
 * Where the failure happened when it happened in a hook or a fixture rather
 * than in the test body: the phase, and the innermost hook or fixture around
 * the failing step. `error` is the execution's own error — when given, the
 * failing step must carry that error, so a teardown failure that followed an
 * error in the body is never named as the failure. Null for a failure in the
 * body, or when no step failed.
 */
export function failureHookContext(
  steps: readonly TreeStepLike[],
  error?: string | null,
  parents = stepParents(steps),
): FailureHookContext | null {
  const index = failingStepIndex(steps, parents, error);
  if (index === null) return null;
  const phase = stepPhases(steps, parents)[index]!;
  if (phase === 'body') return null;
  if (error != null) {
    const stepError = firstLine(errorMessage(steps[index]!));
    if (stepError && firstLine(error) !== stepError) return null;
  }
  for (let i: number = index; i !== -1; i = parents[i] ?? -1) {
    const name = stepHookName(steps[i]!);
    if (name) return { phase, hook: name };
  }
  return { phase, hook: phase };
}
