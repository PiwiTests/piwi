/**
 * Line-level impact: which of the tests that reach a changed file ran the
 * lines the change touches, read from each test's recorded coverage of the
 * file at the change's base version (the side of the diff the tests ran).
 *
 * A changed line is decided at the finest level the coverage allows, and only
 * ever rules a test out when the coverage can say the test did not run it:
 *
 * - **lines**: a changed executable line selects the tests whose recorded
 *   lines include it (server coverage at `lines`, with the version's
 *   executable lines known);
 * - **functions**: any other changed line inside a function selects the tests
 *   that ran a function around it (a line that is not a statement, an
 *   insertion point, or coverage recorded at `functions`);
 * - **file**: a changed line outside every function known in the version
 *   (module code, a declaration, an attribute), or a change that crosses from
 *   one function into the next (code inserted between two adjacent functions
 *   runs at module level), selects every test that reaches the file, as does a
 *   test whose coverage of the file is of another version, has no ranges, or
 *   came from an incomplete capture.
 *
 * Insertions count by the base lines on both sides of the insertion point
 * (`hunkBaseLines`), so an added line selects the tests that ran the code
 * around it.
 */
import {
  intersectLineRanges,
  normalizeLineRanges,
  type CoverageFile,
  type CoverageRuntime,
  type LineRange,
} from '@piwitests/core/coverage';
import { subtractLineRanges, unionLineRanges } from './coverage-insights';

/** Shortest abbreviated blob id compared, as `git diff` abbreviates them by default. */
const MIN_BLOB_PREFIX = 7;

/** Whether two git blob ids, either one abbreviated, name the same object. */
export function sameBlob(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= MIN_BLOB_PREFIX && longer.toLowerCase().startsWith(shorter.toLowerCase());
}

/** What one version of the file holds in one runtime, as run coverage recorded it. */
export interface LineImpactVersion {
  runtime: CoverageRuntime;
  /** Its executable lines; empty when no run coverage named them. */
  executable: LineRange[];
  /** Every function known in it, run or not. */
  functions: LineRange[];
}

/** How a test is selected for a changed file at line level. */
export type LineImpactVia = 'lines' | 'functions' | 'file';

export interface LineImpactDecision {
  via: LineImpactVia;
  /** The changed lines the test ran (`lines`), or that sit in a function it ran; absent for `file`. */
  lines?: LineRange[];
}

export interface LineImpactInput {
  /** The changed lines on the base side, normalized. */
  changed: LineRange[];
  /** The file's git blob id on the base side, full or abbreviated. */
  blob: string;
  /**
   * Per test, the runtimes it reaches the file in through coverage, and its
   * recorded coverage of the file in each (none when it recorded none there).
   */
  tests: Map<number, Map<CoverageRuntime, CoverageFile[]>>;
  /** The base version's executable lines and functions, per runtime, where known. */
  versions: LineImpactVersion[];
  /** Tests whose recorded coverage came from an incomplete capture: never ruled out. */
  incomplete?: Set<number>;
  /**
   * The coverage of the file recorded by tests that reach it another way (their
   * test file, failure frames, a route), which are never narrowed: the
   * functions it names are known, and the lines it ran are not `notRun`.
   */
  others?: CoverageFile[];
}

export interface LineImpactResult {
  /** The tests selected, with how; a test of the input missing here ran none of the changed lines. */
  selected: Map<number, LineImpactDecision>;
  /** Tests the coverage rules out: they reach the file and ran none of its changed lines. */
  ruledOut: number[];
  /** Changed lines outside every function known in the version, or crossing between two, which select every test reaching the file. */
  fileLevel: LineRange[];
  /** Other changed lines, inside functions, that no test reaching the file ran: the lines a new test would cover. */
  notRun: LineRange[];
}

const VIA_RANK: Record<LineImpactVia, number> = { lines: 0, functions: 1, file: 2 };

interface RuntimeView {
  /** Every function known in the version: the version's own list and those the tests ran. */
  functions: LineRange[];
  /** Changed lines inside a known function that are executable, when the version's executable lines are known. */
  executable: LineRange[];
  /** Changed lines inside a known function, crossing into no other. */
  inFunctions: LineRange[];
  /** Changed lines outside every known function, or crossing from one function into another. */
  outside: LineRange[];
}

/**
 * The pairs of adjacent changed lines no one function holds both of: where a
 * change crosses from one function into the next, or into code outside them.
 * Each function's range as recorded, unmerged.
 */
function crossings(changed: LineRange[], functions: LineRange[]): LineRange[] {
  const sorted = [...functions].sort((a, b) => a[0] - b[0]);
  // The furthest end among the functions starting at or before each position.
  const reach: number[] = [];
  for (const [i, [, end]] of sorted.entries()) reach.push(Math.max(end, i > 0 ? reach[i - 1]! : 0));
  const heldTogether = (line: number) => {
    let low = 0;
    let high = sorted.length - 1;
    let last = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (sorted[mid]![0] <= line) {
        last = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    return last >= 0 && reach[last]! >= line + 1;
  };
  const out: LineRange[] = [];
  for (const [start, end] of changed) {
    for (let line = start; line < end; line++) if (!heldTogether(line)) out.push([line, line + 1]);
  }
  return normalizeLineRanges(out);
}

function runtimeView(
  changed: LineRange[],
  matching: CoverageFile[],
  version: LineImpactVersion | undefined,
): RuntimeView {
  const listed = [...(version?.functions ?? []), ...matching.flatMap((f) => f.functions ?? [])];
  const functions = normalizeLineRanges(listed);
  const outside = unionLineRanges(subtractLineRanges(changed, functions), crossings(changed, listed));
  const inFunctions = subtractLineRanges(changed, outside);
  const executable = version?.executable.length ? normalizeLineRanges(version.executable) : [];
  return {
    functions,
    executable: executable.length > 0 ? intersectLineRanges(inFunctions, executable) : [],
    inFunctions,
    outside,
  };
}

/** The changed lines one test's coverage of the file ran. */
interface Ran {
  /** Changed executable lines its recorded lines include. */
  lines: LineRange[];
  /** Every changed line it ran: those, and the other changed lines inside a function it ran. */
  all: LineRange[];
}

/** The changed lines one test's coverage in one runtime ran, or null when that coverage cannot tell. */
function ranLines(view: RuntimeView, files: CoverageFile[], blob: string): Ran | null {
  if (files.length === 0) return null;
  const linesRan: LineRange[] = [];
  const functionsRan: LineRange[] = [];
  for (const file of files) {
    if (!sameBlob(file.blob, blob) || (!file.lines?.length && !file.functions?.length)) return null;
    const lines = normalizeLineRanges(file.lines ?? []);
    // The functions that ran: the recorded ones, else the known functions holding a line that ran.
    const ranFunctions = file.functions?.length
      ? normalizeLineRanges(file.functions)
      : normalizeLineRanges(view.functions.filter((range) => intersectLineRanges([range], lines).length > 0));
    // Line coverage decides an executable line; any other changed line goes by its function.
    const byLine = lines.length > 0 ? view.executable : [];
    linesRan.push(...intersectLineRanges(byLine, lines));
    functionsRan.push(...intersectLineRanges(subtractLineRanges(view.inFunctions, byLine), ranFunctions));
  }
  const lines = normalizeLineRanges(linesRan);
  return { lines, all: unionLineRanges(lines, functionsRan) };
}

/**
 * Decide, for one changed file, which of the tests reaching it through
 * coverage ran its changed lines. See the module comment for the rules.
 */
export function lineImpact(input: LineImpactInput): LineImpactResult {
  const changed = normalizeLineRanges(input.changed);
  if (changed.length === 0) {
    // No changed line to read the coverage against: the change is the file's, every test that reaches it.
    return {
      selected: new Map([...input.tests.keys()].map((id) => [id, { via: 'file' as const }])),
      ruledOut: [],
      fileLevel: [],
      notRun: [],
    };
  }
  const runtimes = new Set<CoverageRuntime>();
  for (const byRuntime of input.tests.values()) for (const runtime of byRuntime.keys()) runtimes.add(runtime);

  const others = input.others ?? [];
  const views = new Map<CoverageRuntime, RuntimeView>();
  for (const runtime of runtimes) {
    const matching = [...[...input.tests.values()].flatMap((byRuntime) => byRuntime.get(runtime) ?? []), ...others]
      .filter((f) => f.runtime === runtime)
      .filter((f) => sameBlob(f.blob, input.blob));
    // Without a recorded version to read the changed lines against, every line is at file level.
    const version = input.versions.find((v) => v.runtime === runtime);
    views.set(
      runtime,
      matching.length > 0 || version
        ? runtimeView(changed, matching, version)
        : { functions: [], executable: [], inFunctions: [], outside: changed },
    );
  }

  const selected = new Map<number, LineImpactDecision>();
  const ruledOut: number[] = [];
  const ran: LineRange[] = [];
  for (const [testCaseId, byRuntime] of input.tests) {
    let best: LineImpactDecision | null = null;
    let fileLevel = false;
    for (const [runtime, files] of byRuntime) {
      const view = views.get(runtime)!;
      const result = ranLines(view, files, input.blob);
      if (!result || view.outside.length > 0 || input.incomplete?.has(testCaseId)) fileLevel = true;
      if (!result || result.all.length === 0) continue;
      ran.push(...result.all);
      const decision: LineImpactDecision = { via: result.lines.length > 0 ? 'lines' : 'functions', lines: result.all };
      if (!best || VIA_RANK[decision.via] < VIA_RANK[best.via]) best = decision;
    }
    if (best) selected.set(testCaseId, best);
    else if (fileLevel) selected.set(testCaseId, { via: 'file' });
    else ruledOut.push(testCaseId);
  }
  for (const file of others) {
    const view = views.get(file.runtime);
    const result = view ? ranLines(view, [file], input.blob) : null;
    if (result) ran.push(...result.all);
  }

  const inFunctions = unionLineRanges(...[...views.values()].map((v) => v.inFunctions));
  return {
    selected,
    ruledOut: ruledOut.sort((a, b) => a - b),
    fileLevel: unionLineRanges(...[...views.values()].map((v) => v.outside)),
    notRun: subtractLineRanges(inFunctions, normalizeLineRanges(ran)),
  };
}
