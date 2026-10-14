/**
 * What a test's coverage tells beyond the files it ran, as the dashboard
 * answers it: the code a failing execution took that its last passing
 * execution did not (divergence), the code a test runs in some of its runs
 * only and the earlier test that predicts it (path variation), the code only
 * some tests run (coverage loss), and which target lines a test ran
 * (coverage reach). Pure: the reads live in `#shared/handlers/coverage-insights`;
 * the server endpoints, their demo mirror, the MCP tools and the AI context
 * share these shapes and computations.
 *
 * An incomplete capture missed part of what ran, so it never yields a claim
 * that something did not run: the claims that would need it are left out.
 * Line numbers are compared only between captures of the same file version
 * (the same git blob); a file whose version differs is named, never compared
 * line by line.
 */
import {
  countLines,
  encodeLineRanges,
  intersectLineRanges,
  normalizeFunctionRanges,
  normalizeLineRanges,
  type CoverageCapture,
  type CoverageFile,
  type CoverageGranularity,
  type CoverageRuntime,
  type LineRange,
} from '@piwitests/core/coverage';

export type { CoverageRuntime, LineRange } from '@piwitests/core/coverage';

/** Line ranges listed per file and list, at most; the rest are counted in `moreRanges`. */
export const MAX_RANGES_PER_FILE = 20;

/** Files a divergence lists, at most. */
export const MAX_DIVERGED_FILES = 50;

/** Files a coverage loss lists, at most. */
export const MAX_LOSS_FILES = 100;

/** Executions a path variation compares, at most (one bit each in a 32-bit mask). */
export const MAX_VARIATION_EXECUTIONS = 30;

/** Varying code groups a path variation lists, at most. */
export const MAX_VARYING_GROUPS = 10;

/** Files listed per varying code group, at most. */
export const MAX_VARYING_FILES = 10;

/**
 * Executions needed on each side of a split before a path variation names an
 * earlier test as its explanation: on each side of the varying code (ran it,
 * did not), and on each side of the other test (had run before, had not).
 */
export const EXPLANATION_MIN_SIDE = 3;

/** Share of the compared executions an explanation must predict, at least. */
export const EXPLANATION_MIN_AGREEMENT = 0.9;

/** Failing executions needed, and the share of them on one side of the varying code, before failures follow it. */
export const FAILURES_FOLLOW_MIN = 2;
export const FAILURES_FOLLOW_MIN_SHARE = 0.9;

/** Tests a coverage loss reads at once, at most. */
export const MAX_LOSS_TESTS = 50;

// ── Range helpers ────────────────────────────────────────────────────────────

/** The lines of normalized ranges `a` that are not in normalized ranges `b`, as normalized ranges. */
export function subtractLineRanges(a: LineRange[], b: LineRange[]): LineRange[] {
  const out: LineRange[] = [];
  let j = 0;
  for (const [start, end] of a) {
    let cursor = start;
    while (j < b.length && b[j]![1] < cursor) j++;
    for (let k = j; k < b.length && b[k]![0] <= end && cursor <= end; k++) {
      const [bStart, bEnd] = b[k]!;
      if (bStart > cursor) out.push([cursor, bStart - 1]);
      cursor = Math.max(cursor, bEnd + 1);
    }
    if (cursor <= end) out.push([cursor, end]);
  }
  return out;
}

/** The union of several lists of line ranges, normalized. */
export function unionLineRanges(...lists: Array<LineRange[] | undefined>): LineRange[] {
  return normalizeLineRanges(lists.flatMap((list) => list ?? []));
}

/** The function ranges of `a` (exact start and end) that `b` does not name. */
export function subtractFunctionRanges(a: LineRange[], b: LineRange[]): LineRange[] {
  const known = new Set(b.map(([s, e]) => `${s}-${e}`));
  return a.filter(([s, e]) => !known.has(`${s}-${e}`));
}

/** The function ranges of `a` that `b` names too. */
function intersectFunctionRanges(a: LineRange[], b: LineRange[]): LineRange[] {
  const known = new Set(b.map(([s, e]) => `${s}-${e}`));
  return a.filter(([s, e]) => known.has(`${s}-${e}`));
}

/** Ranges cut to {@link MAX_RANGES_PER_FILE}, with how many were left out. */
function capRanges(ranges: LineRange[]): { ranges: LineRange[]; more: number } {
  return ranges.length > MAX_RANGES_PER_FILE
    ? { ranges: ranges.slice(0, MAX_RANGES_PER_FILE), more: ranges.length - MAX_RANGES_PER_FILE }
    : { ranges, more: 0 };
}

/** Line ranges as they read in prose: `57-59, 63`. */
export function rangesText(ranges: LineRange[]): string {
  return encodeLineRanges(ranges).replace(/,/g, ', ');
}

/**
 * Target lines from a query value (`57-59,63`): 1-based ranges, merged.
 * Null when the value names no valid line or more than 100 ranges.
 */
export function parseTargetLines(raw: unknown): LineRange[] | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  const parts = raw.split(',').map((p) => p.trim());
  if (parts.length > 100) return null;
  const ranges: LineRange[] = [];
  for (const part of parts) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start || end > 1_000_000) return null;
    ranges.push([start, end]);
  }
  const normalized = normalizeLineRanges(ranges);
  return normalized.length > 0 ? normalized : null;
}

/** The query of a coverage reach: the file, the target lines and the execution to read, or why it is refused. */
export function parseCoverageReachQuery(query: {
  file?: unknown;
  lines?: unknown;
  executionId?: unknown;
}): { file: string; lines: LineRange[]; executionId: number | null } | { error: string } {
  const file = typeof query.file === 'string' ? query.file.trim() : '';
  if (!file || file.length > 500) return { error: 'file is required (at most 500 characters)' };
  const lines = parseTargetLines(query.lines);
  if (!lines) return { error: 'lines must be 1-based line ranges, such as 57-59,63' };
  if (query.executionId == null || query.executionId === '') return { file, lines, executionId: null };
  const executionId = Number(query.executionId);
  if (!Number.isInteger(executionId) || executionId <= 0) return { error: 'executionId must be a positive integer' };
  return { file, lines, executionId };
}

/**
 * Test case ids from a query value (`12,15,40`) or an array of ids: 1 to
 * {@link MAX_LOSS_TESTS} positive integers, deduplicated. Null otherwise.
 */
export function parseLossTestIds(raw: unknown): number[] | null {
  const parts = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
  if (!parts) return null;
  const ids: number[] = [];
  for (const part of parts) {
    const id = Number(typeof part === 'string' ? part.trim() : part);
    if (!Number.isInteger(id) || id <= 0) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 && ids.length <= MAX_LOSS_TESTS ? ids : null;
}

function fileKey(file: Pick<CoverageFile, 'runtime' | 'path'>): string {
  return `${file.runtime}\x00${file.path}`;
}

function popcount(mask: number): number {
  let count = 0;
  for (let m = mask >>> 0; m; m &= m - 1) count++;
  return count;
}

/** The one-sentence answer of a coverage tool for a project that recorded no coverage. */
export function noCoverageSentence(projectId: number): string {
  return `Project ${projectId} has recorded no coverage: set the reporter's \`coverage\` option (\`coverage: { server: 'lines' }\` with an instrumented ASP.NET Core backend, \`coverage: { browser: 'files' }\` for browser files) and run the tests again.`;
}

// ── Divergence: a failing execution against its last passing one ───────────

/**
 * Why there is no divergence:
 *
 * - `not-failing`: the execution did not fail;
 * - `no-coverage`: the execution recorded no coverage;
 * - `no-baseline`: the test has no passing execution with coverage that started before this one;
 * - `incomplete`: both captures are incomplete, so no difference can be claimed.
 */
export type CoverageDivergenceReason = 'not-failing' | 'no-coverage' | 'no-baseline' | 'incomplete';

/** The passing execution a divergence compares with. */
export interface CoverageBaseline {
  executionId: number;
  runId: number;
  /** When the baseline started (ISO 8601). */
  startedAt: string;
  /** The baseline run's branch; null when the run recorded none. */
  branch: string | null;
  /** The baseline run's commit, as recorded; null when it recorded none. */
  commit: string | null;
  /** The baseline's Playwright project; null when unknown. */
  project: string | null;
  /** Whether it ran in the same Playwright project as the failing execution. */
  sameProject: boolean;
  /** Whether it ran on the failing execution's branch; false when it is the default branch's instead. */
  sameBranch: boolean;
}

/** One file whose coverage differs between the failing execution and its baseline. */
export interface DivergedFile {
  path: string;
  runtime: CoverageRuntime;
  /**
   * `only-here`: only the failing execution ran the file; `only-baseline`: only
   * the baseline did; `diverged`: both ran the same version of it, not the
   * same lines or functions; `changed`: they ran different versions, not
   * compared line by line.
   */
  status: 'only-here' | 'only-baseline' | 'diverged' | 'changed';
  /** The version the failing execution ran (the baseline's for `only-baseline`). */
  blob?: string;
  /** The baseline's version, for `changed`. */
  baselineBlob?: string;
  linesOnlyHere?: LineRange[];
  linesOnlyBaseline?: LineRange[];
  functionsOnlyHere?: LineRange[];
  functionsOnlyBaseline?: LineRange[];
  /** Ranges left out of the lists past {@link MAX_RANGES_PER_FILE}. */
  moreRanges?: number;
}

export interface CoverageDivergenceSummary {
  /** Files both ran at the same version, compared line by line. */
  filesCompared: number;
  filesOnlyHere: number;
  filesOnlyBaseline: number;
  filesDiverged: number;
  filesChanged: number;
  linesOnlyHere: number;
  linesOnlyBaseline: number;
  functionsOnlyHere: number;
  functionsOnlyBaseline: number;
}

/** The divergence of a failing execution from the test's last passing execution with coverage. */
export interface CoverageDivergenceAnswer {
  available: boolean;
  reason?: CoverageDivergenceReason;
  executionId: number;
  baseline?: CoverageBaseline;
  /**
   * Which capture was incomplete, when one was: an incomplete failing
   * execution yields no `only-baseline` claim (files or lines it may have run
   * unrecorded), an incomplete baseline no `only-here` claim.
   */
  incomplete?: { execution: boolean; baseline: boolean };
  summary: CoverageDivergenceSummary;
  /** Only-here files first, then diverged, only-baseline and changed files; at most {@link MAX_DIVERGED_FILES}. */
  files: DivergedFile[];
  /** Files left out past {@link MAX_DIVERGED_FILES}. */
  moreFiles?: number;
}

function emptyDivergenceSummary(): CoverageDivergenceSummary {
  return {
    filesCompared: 0,
    filesOnlyHere: 0,
    filesOnlyBaseline: 0,
    filesDiverged: 0,
    filesChanged: 0,
    linesOnlyHere: 0,
    linesOnlyBaseline: 0,
    functionsOnlyHere: 0,
    functionsOnlyBaseline: 0,
  };
}

/** The answer when no divergence can be computed, with the baseline when it is known. */
export function unavailableDivergence(
  executionId: number,
  reason: CoverageDivergenceReason,
  known: Pick<CoverageDivergenceAnswer, 'baseline' | 'incomplete'> = {},
): CoverageDivergenceAnswer {
  return { available: false, reason, executionId, ...known, summary: emptyDivergenceSummary(), files: [] };
}

const STATUS_ORDER: Record<DivergedFile['status'], number> = {
  'only-here': 0,
  diverged: 1,
  'only-baseline': 2,
  changed: 3,
};

/** Lines and functions only the failing execution ran, the weight a diverged file sorts by. */
function hereWeight(file: DivergedFile): number {
  return countLines(file.linesOnlyHere ?? []) + (file.functionsOnlyHere?.length ?? 0);
}

/** A diverged file's lists capped, empty lists dropped. */
function cappedDivergedFile(
  base: Omit<DivergedFile, 'linesOnlyHere' | 'linesOnlyBaseline' | 'functionsOnlyHere' | 'functionsOnlyBaseline'>,
  lists: Partial<
    Record<'linesOnlyHere' | 'linesOnlyBaseline' | 'functionsOnlyHere' | 'functionsOnlyBaseline', LineRange[]>
  >,
): DivergedFile {
  const file: DivergedFile = { ...base };
  let more = 0;
  for (const name of ['linesOnlyHere', 'linesOnlyBaseline', 'functionsOnlyHere', 'functionsOnlyBaseline'] as const) {
    const ranges = lists[name];
    if (!ranges || ranges.length === 0) continue;
    const capped = capRanges(ranges);
    file[name] = capped.ranges;
    more += capped.more;
  }
  if (more > 0) file.moreRanges = more;
  return file;
}

/**
 * The divergence of a failing execution's capture from its baseline's, per
 * runtime and path. A file only one side ran is claimed only when the other
 * side's capture is complete; line and function differences are read only on
 * files both ran at the same blob, each side's lines against the other's
 * lines and functions against functions, and the differences only the
 * complete side can vouch for are kept.
 */
export function divergeCaptures(
  here: CoverageCapture,
  baseline: CoverageCapture,
): Pick<CoverageDivergenceAnswer, 'summary' | 'files' | 'moreFiles'> {
  const hereComplete = !here.incomplete;
  const baselineComplete = !baseline.incomplete;
  const hereFiles = new Map(here.files.map((f) => [fileKey(f), f]));
  const baselineFiles = new Map(baseline.files.map((f) => [fileKey(f), f]));
  const summary = emptyDivergenceSummary();
  const files: DivergedFile[] = [];

  for (const [key, h] of hereFiles) {
    const b = baselineFiles.get(key);
    if (!b) {
      if (!baselineComplete) continue;
      summary.filesOnlyHere++;
      summary.linesOnlyHere += countLines(h.lines ?? []);
      summary.functionsOnlyHere += h.functions?.length ?? 0;
      files.push(
        cappedDivergedFile(
          { path: h.path, runtime: h.runtime, status: 'only-here', ...(h.blob ? { blob: h.blob } : {}) },
          { linesOnlyHere: h.lines, functionsOnlyHere: h.functions },
        ),
      );
      continue;
    }
    if (h.blob && b.blob && h.blob !== b.blob) {
      summary.filesChanged++;
      files.push({ path: h.path, runtime: h.runtime, status: 'changed', blob: h.blob, baselineBlob: b.blob });
      continue;
    }
    if (!h.blob || !b.blob) continue;
    summary.filesCompared++;
    const bothLines = Boolean(h.lines && b.lines);
    const bothFunctions = Boolean(h.functions && b.functions);
    const lists = {
      linesOnlyHere: bothLines && baselineComplete ? subtractLineRanges(h.lines!, b.lines!) : [],
      linesOnlyBaseline: bothLines && hereComplete ? subtractLineRanges(b.lines!, h.lines!) : [],
      functionsOnlyHere: bothFunctions && baselineComplete ? subtractFunctionRanges(h.functions!, b.functions!) : [],
      functionsOnlyBaseline: bothFunctions && hereComplete ? subtractFunctionRanges(b.functions!, h.functions!) : [],
    };
    if (Object.values(lists).every((list) => list.length === 0)) continue;
    summary.filesDiverged++;
    summary.linesOnlyHere += countLines(lists.linesOnlyHere);
    summary.linesOnlyBaseline += countLines(lists.linesOnlyBaseline);
    summary.functionsOnlyHere += lists.functionsOnlyHere.length;
    summary.functionsOnlyBaseline += lists.functionsOnlyBaseline.length;
    files.push(cappedDivergedFile({ path: h.path, runtime: h.runtime, status: 'diverged', blob: h.blob }, lists));
  }
  if (hereComplete) {
    for (const [key, b] of baselineFiles) {
      if (hereFiles.has(key)) continue;
      summary.filesOnlyBaseline++;
      summary.linesOnlyBaseline += countLines(b.lines ?? []);
      summary.functionsOnlyBaseline += b.functions?.length ?? 0;
      files.push(
        cappedDivergedFile(
          { path: b.path, runtime: b.runtime, status: 'only-baseline', ...(b.blob ? { blob: b.blob } : {}) },
          { linesOnlyBaseline: b.lines, functionsOnlyBaseline: b.functions },
        ),
      );
    }
  }

  files.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      hereWeight(b) - hereWeight(a) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : a.runtime < b.runtime ? -1 : 1),
  );
  const moreFiles = Math.max(0, files.length - MAX_DIVERGED_FILES);
  return { summary, files: files.slice(0, MAX_DIVERGED_FILES), ...(moreFiles > 0 ? { moreFiles } : {}) };
}

/** Why there is no divergence, as a clause: "the execution did not fail". */
export function divergenceReasonText(reason: CoverageDivergenceReason): string {
  switch (reason) {
    case 'not-failing':
      return 'the execution did not fail';
    case 'no-coverage':
      return 'the failing execution recorded no coverage';
    case 'no-baseline':
      return 'the test has no earlier passing execution with coverage to compare with';
    case 'incomplete':
      return 'both captures are incomplete';
  }
}

/** Files and ranges the AI context section lists, at most. */
const CONTEXT_FILES = 12;
const CONTEXT_RANGES = 8;

function contextRanges(ranges: LineRange[] | undefined): string {
  if (!ranges || ranges.length === 0) return '';
  const shown = ranges.slice(0, CONTEXT_RANGES);
  const more = ranges.length - shown.length;
  return ` lines ${rangesText(shown)}${more > 0 ? ` (+${more} more ranges)` : ''}`;
}

function contextFunctions(ranges: LineRange[] | undefined): string {
  if (!ranges || ranges.length === 0) return '';
  const shown = ranges.slice(0, CONTEXT_RANGES).map(([s, e]) => `${s}-${e}`);
  const more = ranges.length - shown.length;
  return ` functions ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

/**
 * The AI context's "Code Paths vs the Last Passing Run" section: the code the
 * failing execution ran that the baseline did not, then the code the baseline
 * ran that it did not, at most {@link CONTEXT_FILES} files each. Null when the
 * answer is unavailable or names no difference.
 */
export function divergenceMarkdown(answer: CoverageDivergenceAnswer): string | null {
  if (!answer.available || !answer.baseline || answer.files.length === 0) return null;
  const { baseline, summary } = answer;
  const where = [
    baseline.sameProject ? 'same Playwright project' : `Playwright project ${baseline.project ?? 'unknown'}`,
    baseline.sameBranch ? 'same branch' : `default branch${baseline.branch ? ` ${baseline.branch}` : ''}`,
    baseline.commit ? `commit ${baseline.commit.slice(0, 7)}` : null,
  ].filter(Boolean);
  const lines = [
    '## Code Paths vs the Last Passing Run',
    `Coverage of this execution against the test's last passing execution with coverage (execution #${baseline.executionId}, run #${baseline.runId}, ${baseline.startedAt}; ${where.join(', ')}). Files at a different version on each side are counted, not compared.`,
    `- Only this run: ${summary.filesOnlyHere} file${summary.filesOnlyHere === 1 ? '' : 's'}, ${summary.linesOnlyHere} line${summary.linesOnlyHere === 1 ? '' : 's'} in files both ran; only the passing run: ${summary.filesOnlyBaseline} file${summary.filesOnlyBaseline === 1 ? '' : 's'}, ${summary.linesOnlyBaseline} line${summary.linesOnlyBaseline === 1 ? '' : 's'}; changed version: ${summary.filesChanged}.`,
  ];
  if (answer.incomplete?.execution) {
    lines.push('- This execution’s capture is incomplete: what only the passing run ran is not listed.');
  }
  if (answer.incomplete?.baseline) {
    lines.push('- The passing run’s capture is incomplete: what only this run ran is not listed.');
  }
  const here = answer.files.filter((f) => f.linesOnlyHere || f.functionsOnlyHere || f.status === 'only-here');
  const base = answer.files.filter(
    (f) => f.linesOnlyBaseline || f.functionsOnlyBaseline || f.status === 'only-baseline',
  );
  const item = (f: DivergedFile, side: 'here' | 'baseline') => {
    const ranges =
      side === 'here'
        ? contextRanges(f.linesOnlyHere) || contextFunctions(f.functionsOnlyHere)
        : contextRanges(f.linesOnlyBaseline) || contextFunctions(f.functionsOnlyBaseline);
    const whole = f.status === (side === 'here' ? 'only-here' : 'only-baseline') ? ' (whole file)' : '';
    return `- \`${f.path}\` (${f.runtime})${whole}${ranges}`;
  };
  if (here.length > 0) {
    lines.push('', '### Ran in this execution only', ...here.slice(0, CONTEXT_FILES).map((f) => item(f, 'here')));
    if (here.length > CONTEXT_FILES) lines.push(`- … and ${here.length - CONTEXT_FILES} more files`);
  }
  if (base.length > 0) {
    lines.push('', '### Ran in the passing run only', ...base.slice(0, CONTEXT_FILES).map((f) => item(f, 'baseline')));
    if (base.length > CONTEXT_FILES) lines.push(`- … and ${base.length - CONTEXT_FILES} more files`);
  }
  return lines.join('\n');
}

// ── Path variation: one test's runs compared ────────────────────────────────

/** One compared execution of a path variation, newest first. */
export interface VariationExecution {
  id: number;
  failed: boolean;
  /** Start in ms since the epoch; null when the reporter recorded none (the execution is then left out of explanations). */
  startedAt: number | null;
  capture: CoverageCapture;
}

/** One file of a varying code group. */
export interface VaryingFile {
  path: string;
  runtime: CoverageRuntime;
  blob?: string;
  /** The lines that ran in the group's executions only, at line granularity. */
  lines?: LineRange[];
  /** The functions that ran in the group's executions only, at function granularity. */
  functions?: LineRange[];
  /** The file ran in the group's executions only, at file granularity. */
  file?: true;
  moreRanges?: number;
}

/** Code that ran in some of the compared executions only: the same executions ran all of it. */
export interface VaryingCode {
  /** How many compared executions ran it. */
  ranIn: number;
  /** How many of those failed. */
  failedIn: number;
  /** Lines and functions in it, before the caps. */
  lines: number;
  functions: number;
  files: VaryingFile[];
  moreFiles?: number;
  /** Executions that ran it and executions that did not, newest first, at most 3 each. */
  examples: { ran: number[]; notRan: number[] };
}

/** The earlier test whose having run predicts which executions ran a varying code group. */
export interface PathExplanation {
  /** Position of the predicted group in `varying`. */
  varying: number;
  testCaseId: number;
  title: string;
  filePath: string;
  /**
   * `earlier-in-run`: the other test finished earlier in the same run before
   * the execution started (the backend is shared by every worker);
   * `earlier-on-worker`: the same, on the execution's worker.
   */
  relation: 'earlier-in-run' | 'earlier-on-worker';
  /** `runs-code`: the code runs after the other test ran; `prevents-code`: it runs when the other test has not run. */
  effect: 'runs-code' | 'prevents-code';
  /** Share of the placed executions the relation predicts, 0 to 1. */
  agreement: number;
  /** Executions where the other test had run before, and how many of them ran the code. */
  before: { executions: number; ranCode: number };
  /** Executions where it had not, and how many of them ran the code. */
  notBefore: { executions: number; ranCode: number };
}

/** The failing executions of a path variation, when they fall on one side of a varying code group. */
export interface FailuresFollow {
  /** Position of the group in `varying`. */
  varying: number;
  /** `ran`: the failures ran the group's code; `not-ran`: they did not. */
  side: 'ran' | 'not-ran';
  failed: number;
  onSide: number;
}

export type PathVariationReason = 'no-coverage' | 'too-few-executions';

/** How a test's coverage varies across its recent runs, and what predicts it. */
export interface PathVariationAnswer {
  available: boolean;
  reason?: PathVariationReason;
  testCaseId: number;
  /** The Playwright project whose executions were compared. */
  project?: string | null;
  /** Executions compared (complete captures), left out as incomplete, and the failed ones among the compared. */
  executions: { compared: number; incomplete: number; failed: number };
  /** Files compared, and files left out because the executions ran different versions of them. */
  files: { compared: number; changedVersion: number };
  /** Most evenly split first, at most {@link MAX_VARYING_GROUPS}. */
  varying: VaryingCode[];
  moreVarying?: number;
  explanation?: PathExplanation;
  failuresFollow?: FailuresFollow;
  /**
   * The failures follow the code an earlier test predicts: evidence that the
   * test depends on what ran before it (shared state), which flaky
   * classification reads as the `order` root cause.
   */
  orderDependent: boolean;
}

/** A path variation with nothing compared. */
export function unavailableVariation(
  testCaseId: number,
  reason: PathVariationReason,
  executions: PathVariationAnswer['executions'] = { compared: 0, incomplete: 0, failed: 0 },
): PathVariationAnswer {
  return {
    available: false,
    reason,
    testCaseId,
    executions,
    files: { compared: 0, changedVersion: 0 },
    varying: [],
    orderDependent: false,
  };
}

/** A varying code group as the computation builds it, with its execution mask. */
export interface VaryingGroup {
  mask: number;
  code: VaryingCode;
}

interface GroupFile {
  path: string;
  runtime: CoverageRuntime;
  blob?: string;
  lines: LineRange[];
  functions: LineRange[];
  file: boolean;
}

/** The newest executions of a mask, at most 3. */
function examplesOf(mask: number, executions: VariationExecution[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < executions.length && out.length < 3; i++) if (mask & (1 << i)) out.push(executions[i]!.id);
  return out;
}

/**
 * The code that ran in some of the executions only, grouped by the executions
 * that ran it. A file is compared when every execution that ran it ran the
 * same version: at line granularity when each of them recorded lines, else
 * function granularity when each recorded functions, else by whether the file
 * ran at all. Executions are bits of a mask, newest first.
 */
export function varyingCode(executions: VariationExecution[]): {
  groups: VaryingGroup[];
  files: PathVariationAnswer['files'];
} {
  const n = Math.min(executions.length, MAX_VARIATION_EXECUTIONS);
  const full = n === 0 ? 0 : 2 ** n - 1;
  const failedMask = executions.slice(0, n).reduce((m, e, i) => (e.failed ? m | (1 << i) : m), 0);
  const perFile = new Map<string, Array<CoverageFile | undefined>>();
  for (let i = 0; i < n; i++) {
    for (const file of executions[i]!.capture.files) {
      const key = fileKey(file);
      let entries = perFile.get(key);
      if (!entries) perFile.set(key, (entries = new Array<CoverageFile | undefined>(n).fill(undefined)));
      entries[i] = file;
    }
  }

  const groups = new Map<number, Map<string, GroupFile>>();
  const groupFile = (mask: number, file: CoverageFile, blob: string | undefined): GroupFile => {
    let files = groups.get(mask);
    if (!files) groups.set(mask, (files = new Map()));
    const key = fileKey(file);
    let entry = files.get(key);
    if (!entry) {
      entry = { path: file.path, runtime: file.runtime, lines: [], functions: [], file: false };
      if (blob) entry.blob = blob;
      files.set(key, entry);
    }
    return entry;
  };

  let compared = 0;
  let changedVersion = 0;
  for (const entries of perFile.values()) {
    const present = entries.filter((e): e is CoverageFile => e !== undefined);
    const blobs = new Set(present.flatMap((e) => (e.blob ? [e.blob] : [])));
    if (blobs.size > 1) {
      changedVersion++;
      continue;
    }
    compared++;
    const sample = present[0]!;
    const ranged = blobs.size === 1 && present.every((e) => e.blob);
    const blob = ranged ? [...blobs][0] : undefined;
    const presentMask = entries.reduce((m, e, i) => (e ? m | (1 << i) : m), 0);
    if (ranged && present.every((e) => e.lines?.length)) {
      // A sweep over range boundaries: between two boundaries the same executions ran every line.
      const events = new Map<number, number>();
      entries.forEach((entry, i) => {
        for (const [start, end] of entry?.lines ?? []) {
          events.set(start, (events.get(start) ?? 0) ^ (1 << i));
          events.set(end + 1, (events.get(end + 1) ?? 0) ^ (1 << i));
        }
      });
      const positions = [...events.keys()].sort((a, b) => a - b);
      let mask = 0;
      for (let p = 0; p < positions.length - 1; p++) {
        mask ^= events.get(positions[p]!)!;
        if (mask !== 0 && mask !== full) {
          groupFile(mask, sample, blob).lines.push([positions[p]!, positions[p + 1]! - 1]);
        }
      }
    } else if (ranged && present.every((e) => e.functions?.length)) {
      const masks = new Map<string, { range: LineRange; mask: number }>();
      entries.forEach((entry, i) => {
        for (const range of entry?.functions ?? []) {
          const key = `${range[0]}-${range[1]}`;
          const known = masks.get(key) ?? { range, mask: 0 };
          known.mask |= 1 << i;
          masks.set(key, known);
        }
      });
      for (const { range, mask } of masks.values()) {
        if (mask !== full) groupFile(mask, sample, blob).functions.push(range);
      }
    } else if (presentMask !== full) {
      groupFile(presentMask, sample, undefined).file = true;
    }
  }

  const built: VaryingGroup[] = [...groups.entries()].map(([mask, files]) => {
    const list = [...files.values()].map((f) => {
      const lines = normalizeLineRanges(f.lines);
      const functions = normalizeFunctionRanges(f.functions);
      return { ...f, lines, functions };
    });
    list.sort(
      (a, b) =>
        countLines(b.lines) + b.functions.length - (countLines(a.lines) + a.functions.length) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    const shown = list.slice(0, MAX_VARYING_FILES).map((f) => {
      const out: VaryingFile = { path: f.path, runtime: f.runtime };
      if (f.blob) out.blob = f.blob;
      let more = 0;
      if (f.lines.length > 0) {
        const capped = capRanges(f.lines);
        out.lines = capped.ranges;
        more += capped.more;
      }
      if (f.functions.length > 0) {
        const capped = capRanges(f.functions);
        out.functions = capped.ranges;
        more += capped.more;
      }
      if (f.file) out.file = true;
      if (more > 0) out.moreRanges = more;
      return out;
    });
    const code: VaryingCode = {
      ranIn: popcount(mask),
      failedIn: popcount(mask & failedMask),
      lines: list.reduce((sum, f) => sum + countLines(f.lines), 0),
      functions: list.reduce((sum, f) => sum + f.functions.length, 0),
      files: shown,
      examples: { ran: examplesOf(mask, executions), notRan: examplesOf(full & ~mask, executions) },
    };
    if (list.length > shown.length) code.moreFiles = list.length - shown.length;
    return { mask, code };
  });
  built.sort((a, b) => {
    const balance = (g: VaryingGroup) => Math.min(g.code.ranIn, n - g.code.ranIn);
    const size = (g: VaryingGroup) => g.code.lines + g.code.functions + g.code.files.length;
    return balance(b) - balance(a) || size(b) - size(a) || a.mask - b.mask;
  });
  return { groups: built, files: { compared, changedVersion } };
}

/** The varying groups an explanation is looked for, at most. */
export const EXPLAINED_GROUPS = 5;

/**
 * The groups worth explaining: split with at least
 * {@link EXPLANATION_MIN_SIDE} executions on each side among the placed ones
 * (`universe`, the executions with a start time), most balanced first.
 */
export function explainableGroups(groups: VaryingGroup[], universe: number): number[] {
  const size = popcount(universe);
  const out: number[] = [];
  groups.forEach((g, index) => {
    const ran = popcount(g.mask & universe);
    if (ran >= EXPLANATION_MIN_SIDE && size - ran >= EXPLANATION_MIN_SIDE && out.length < EXPLAINED_GROUPS) {
      out.push(index);
    }
  });
  return out;
}

const RELATION_RANK: Record<PathExplanation['relation'], number> = { 'earlier-in-run': 0, 'earlier-on-worker': 1 };

/** An earlier test as a candidate explanation: the placed executions it ran before, per relation. */
export interface ExplanationCandidate {
  testCaseId: number;
  /** Bits of the executions it finished before, earlier in the same run. */
  run: number;
  /** Bits of the executions it finished before on the same worker. */
  worker: number;
}

/**
 * The candidate whose having run before best predicts one of the explainable
 * groups: agreement at least {@link EXPLANATION_MIN_AGREEMENT}, with at least
 * {@link EXPLANATION_MIN_SIDE} placed executions on each side of the
 * candidate. Highest agreement first, then the larger smaller side, then
 * `earlier-in-run` over `earlier-on-worker`, then the earlier group, then the
 * lower test id. Null when none qualifies.
 */
export function bestExplanation(
  groups: VaryingGroup[],
  explainable: number[],
  candidates: ExplanationCandidate[],
  universe: number,
): Omit<PathExplanation, 'title' | 'filePath'> | null {
  const size = popcount(universe);
  let best: (Omit<PathExplanation, 'title' | 'filePath'> & { support: number }) | null = null;
  for (const candidate of candidates) {
    for (const relation of ['earlier-in-run', 'earlier-on-worker'] as const) {
      const before = (relation === 'earlier-in-run' ? candidate.run : candidate.worker) & universe;
      const beforeCount = popcount(before);
      const support = Math.min(beforeCount, size - beforeCount);
      if (support < EXPLANATION_MIN_SIDE) continue;
      for (const index of explainable) {
        const code = groups[index]!.mask & universe;
        const same = popcount(~(before ^ code) & universe);
        const effect = same * 2 >= size ? 'runs-code' : 'prevents-code';
        const agreement = (effect === 'runs-code' ? same : size - same) / size;
        if (agreement < EXPLANATION_MIN_AGREEMENT) continue;
        const better =
          !best ||
          agreement > best.agreement ||
          (agreement === best.agreement &&
            (support > best.support ||
              (support === best.support &&
                (RELATION_RANK[relation] < RELATION_RANK[best.relation] ||
                  (relation === best.relation &&
                    (index < best.varying || (index === best.varying && candidate.testCaseId < best.testCaseId)))))));
        if (!better) continue;
        const ranBefore = popcount(before & code);
        best = {
          varying: index,
          testCaseId: candidate.testCaseId,
          relation,
          effect,
          agreement: Math.round(agreement * 100) / 100,
          before: { executions: beforeCount, ranCode: ranBefore },
          notBefore: { executions: size - beforeCount, ranCode: popcount(code) - ranBefore },
          support,
        };
      }
    }
  }
  if (!best) return null;
  const { support: _support, ...explanation } = best;
  return explanation;
}

/**
 * Whether the failing executions fall on one side of a group: at least
 * {@link FAILURES_FOLLOW_MIN} of them, {@link FAILURES_FOLLOW_MIN_SHARE} on
 * the same side. The explained group is checked first, then the others in
 * order. Null when none qualifies.
 */
export function failuresFollow(
  groups: VaryingGroup[],
  executions: VariationExecution[],
  explained: number | null,
): FailuresFollow | null {
  const n = Math.min(executions.length, MAX_VARIATION_EXECUTIONS);
  const failedMask = executions.slice(0, n).reduce((m, e, i) => (e.failed ? m | (1 << i) : m), 0);
  const failed = popcount(failedMask);
  if (failed < FAILURES_FOLLOW_MIN) return null;
  const order = explained === null ? groups.map((_, i) => i) : [explained, ...groups.map((_, i) => i)];
  for (const index of order) {
    const ran = popcount(failedMask & groups[index]!.mask);
    const onSide = Math.max(ran, failed - ran);
    if (onSide / failed >= FAILURES_FOLLOW_MIN_SHARE) {
      return { varying: index, side: ran >= failed - ran ? 'ran' : 'not-ran', failed, onSide };
    }
  }
  return null;
}

// ── Coverage loss: what only some tests run ─────────────────────────────────

/** A fragment other tests recorded, with how many trusted tests referencing it are steady and how many flaky. */
export interface OtherFragment extends CoverageFile {
  steady: number;
  flaky: number;
}

/** One file whose code only the given tests run among the other trusted tests. */
export interface LossFile {
  path: string;
  runtime: CoverageRuntime;
  /** The version the given tests ran; absent at file granularity. */
  blob?: string;
  /**
   * `only-these`: no other trusted test runs the file; `only-flaky`: the only
   * other trusted tests running it are flaky; `partial`: other tests run the
   * file, not every line or function the given tests run; `uncertain`: the
   * other tests recorded the file only at another version or without lines,
   * so no line is claimed.
   */
  status: 'only-these' | 'only-flaky' | 'partial' | 'uncertain';
  /** Lines and functions no other trusted test runs. */
  lines?: LineRange[];
  functions?: LineRange[];
  /** Lines and functions that, besides the given tests, only flaky tests run. */
  onlyFlakyLines?: LineRange[];
  onlyFlakyFunctions?: LineRange[];
  /** Other trusted tests that run the file at any version, steady and flaky. */
  otherTests: { steady: number; flaky: number };
  moreRanges?: number;
}

export interface CoverageLossSummary {
  /** Files the given tests run. */
  files: number;
  /** Files whose every line and function another steady trusted test runs too. */
  filesCovered: number;
  filesOnlyThese: number;
  filesOnlyFlaky: number;
  filesPartial: number;
  filesUncertain: number;
  /** Lines and functions no other trusted test runs. */
  lines: number;
  functions: number;
  /** Lines and functions only flaky tests run besides the given ones. */
  onlyFlakyLines: number;
  onlyFlakyFunctions: number;
}

/** A test a coverage loss was asked about. */
export interface LossTest {
  testCaseId: number;
  title: string;
  filePath: string;
  quarantined: boolean;
  /** Whether it has coverage on the default branch. */
  hasCoverage: boolean;
}

/** What a set of tests leaves uncovered when it stops running or counting: the code only they run. */
export interface CoverageLossAnswer {
  available: boolean;
  reason?: 'no-coverage';
  projectId: number;
  /** The default branch, whose latest coverage per test is read. */
  branch: string;
  tests: LossTest[];
  /** Ids asked about that are no test of the project. */
  unknownTestIds?: number[];
  summary: CoverageLossSummary;
  /** Only-these and only-flaky files first, then partial and uncertain ones, at most {@link MAX_LOSS_FILES}. */
  files: LossFile[];
  moreFiles?: number;
}

export function emptyLossSummary(): CoverageLossSummary {
  return {
    files: 0,
    filesCovered: 0,
    filesOnlyThese: 0,
    filesOnlyFlaky: 0,
    filesPartial: 0,
    filesUncertain: 0,
    lines: 0,
    functions: 0,
    onlyFlakyLines: 0,
    onlyFlakyFunctions: 0,
  };
}

const LOSS_ORDER: Record<LossFile['status'], number> = { 'only-these': 0, 'only-flaky': 1, partial: 2, uncertain: 3 };

/**
 * The code only the given tests run, per runtime, path and version: their
 * lines and functions no fragment of another trusted test at the same version
 * names. A fragment with functions and no lines covers the lines of its
 * functions. Other tests count per file whatever the version: a file no other
 * trusted test runs is `only-these` (or `only-flaky`) at any granularity, and
 * a file they ran only at another version, or without ranges, is `uncertain`.
 */
export function coverageLoss(
  ours: CoverageFile[],
  others: OtherFragment[],
  otherTests: Map<string, { steady: number; flaky: number }>,
): { summary: CoverageLossSummary; files: LossFile[]; moreFiles?: number } {
  const summary = emptyLossSummary();
  const versions = new Map<string, { file: CoverageFile; lines: LineRange[][]; functions: LineRange[][] }>();
  for (const file of ours) {
    const key = `${fileKey(file)}\x00${file.blob ?? ''}`;
    const version = versions.get(key) ?? { file, lines: [], functions: [] };
    if (file.lines) version.lines.push(file.lines);
    if (file.functions) version.functions.push(file.functions);
    versions.set(key, version);
  }
  const othersByFile = new Map<string, OtherFragment[]>();
  for (const other of others) {
    if (other.steady + other.flaky === 0) continue;
    const key = fileKey(other);
    othersByFile.set(key, [...(othersByFile.get(key) ?? []), other]);
  }

  const files: LossFile[] = [];
  for (const { file, lines: lineLists, functions: functionLists } of versions.values()) {
    summary.files++;
    const key = fileKey(file);
    const counts = otherTests.get(key) ?? { steady: 0, flaky: 0 };
    const fragments = othersByFile.get(key) ?? [];
    const lines = unionLineRanges(...lineLists);
    const functions = normalizeFunctionRanges(functionLists.flat());
    const base = { path: file.path, runtime: file.runtime, ...(file.blob ? { blob: file.blob } : {}) };
    const steadyAny = fragments.some((f) => f.steady > 0) || counts.steady > 0;
    const flakyAny = fragments.some((f) => f.flaky > 0) || counts.flaky > 0;

    let entry: LossFile | null = null;
    if (!steadyAny && !flakyAny) {
      entry = { ...base, status: 'only-these', otherTests: counts };
      if (lines.length > 0) entry.lines = lines;
      if (functions.length > 0) entry.functions = functions;
    } else if (!file.blob || (lines.length === 0 && functions.length === 0)) {
      if (!steadyAny) {
        entry = { ...base, status: 'only-flaky', otherTests: counts };
      }
    } else {
      const sameVersion = fragments.filter((f) => f.blob === file.blob && (f.lines?.length || f.functions?.length));
      if (sameVersion.length === 0) {
        entry = { ...base, status: 'uncertain', otherTests: counts };
      } else {
        const side = (pick: (f: OtherFragment) => boolean) => {
          const chosen = sameVersion.filter(pick);
          return {
            lines: unionLineRanges(...chosen.map((f) => f.lines)),
            // Functions recorded without lines cover the lines inside them.
            functionLines: unionLineRanges(...chosen.filter((f) => !f.lines?.length).map((f) => f.functions)),
            functions: normalizeFunctionRanges(chosen.flatMap((f) => f.functions ?? [])),
          };
        };
        const steady = side((f) => f.steady > 0);
        const flaky = side((f) => f.flaky > 0);
        const notSteady = subtractLineRanges(subtractLineRanges(lines, steady.lines), steady.functionLines);
        const lost = subtractLineRanges(subtractLineRanges(notSteady, flaky.lines), flaky.functionLines);
        const onlyFlaky = subtractLineRanges(notSteady, lost);
        const functionsNotSteady = subtractFunctionRanges(functions, steady.functions);
        const functionsLost = subtractFunctionRanges(functionsNotSteady, flaky.functions);
        const functionsOnlyFlaky = intersectFunctionRanges(functionsNotSteady, flaky.functions);
        if (lost.length + onlyFlaky.length + functionsLost.length + functionsOnlyFlaky.length > 0) {
          entry = { ...base, status: steadyAny ? 'partial' : 'only-flaky', otherTests: counts };
          if (lost.length > 0) entry.lines = lost;
          if (functionsLost.length > 0) entry.functions = functionsLost;
          if (onlyFlaky.length > 0) entry.onlyFlakyLines = onlyFlaky;
          if (functionsOnlyFlaky.length > 0) entry.onlyFlakyFunctions = functionsOnlyFlaky;
        }
      }
    }

    if (!entry) {
      summary.filesCovered++;
      continue;
    }
    if (entry.status === 'only-these') summary.filesOnlyThese++;
    else if (entry.status === 'only-flaky') summary.filesOnlyFlaky++;
    else if (entry.status === 'partial') summary.filesPartial++;
    else summary.filesUncertain++;
    summary.lines += countLines(entry.lines ?? []);
    summary.functions += entry.functions?.length ?? 0;
    summary.onlyFlakyLines += countLines(entry.onlyFlakyLines ?? []);
    summary.onlyFlakyFunctions += entry.onlyFlakyFunctions?.length ?? 0;
    files.push(entry);
  }

  const weight = (f: LossFile) => countLines(f.lines ?? []) + (f.functions?.length ?? 0);
  files.sort(
    (a, b) =>
      LOSS_ORDER[a.status] - LOSS_ORDER[b.status] ||
      weight(b) - weight(a) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const capped = files.slice(0, MAX_LOSS_FILES).map((f) => {
    let more = 0;
    const out: LossFile = { ...f };
    for (const name of ['lines', 'functions', 'onlyFlakyLines', 'onlyFlakyFunctions'] as const) {
      const ranges = f[name];
      if (!ranges) continue;
      const cut = capRanges(ranges);
      out[name] = cut.ranges;
      more += cut.more;
    }
    if (more > 0) out.moreRanges = more;
    return out;
  });
  const moreFiles = files.length - capped.length;
  return { summary, files: capped, ...(moreFiles > 0 ? { moreFiles } : {}) };
}

// ── Coverage reach: did a test run its target lines ─────────────────────────

/** The test that runs most of the code around target lines: the one to copy. */
export interface NearestTest {
  testCaseId: number;
  title: string;
  filePath: string;
  /** Its latest outcome on the branch read, when known. */
  status: 'passed' | 'flaky' | 'failed' | 'skipped' | null;
  /** The function around the target, from the coverage at the same version; null when none is known. */
  function: LineRange | null;
  /** Lines it ran in that function (or in the target lines when no function is known). */
  executedLines: number;
  /** The target lines it ran. */
  ranTarget: LineRange[];
  /** Whether its coverage is of the same version of the file as the target lines. */
  sameVersion: boolean;
}

/** Which target lines one execution ran. */
export interface CoverageReachAnswer {
  available: boolean;
  /** `no-coverage`: the test has no execution with coverage (or the one asked about has none). */
  reason?: 'no-coverage';
  testCaseId: number;
  executionId?: number;
  runId?: number;
  /** When the execution started (ISO 8601). */
  startedAt?: string;
  /** The file asked about: a repository-relative path or a suffix of one. */
  file: string;
  target: LineRange[];
  /** Whether the execution's coverage names the file. */
  reachedFile: boolean;
  /** The covered path the file matched, its runtime and the version its lines refer to. */
  path?: string;
  runtime?: CoverageRuntime;
  blob?: string;
  /** What the execution recorded of the file: `lines`, or `functions` (a line runs when a function around it ran), or `files`. */
  granularity?: CoverageGranularity;
  /** Whether the capture was complete: only then does a target line it did not record count as not run. */
  complete: boolean;
  ran: LineRange[];
  notRan: LineRange[];
  /** Target lines the capture cannot tell: at file granularity, or not recorded by an incomplete capture. */
  unknown: LineRange[];
  /** Target lines the run's executable lines leave out (blank lines, comments, declarations), when known. */
  notExecutable?: LineRange[];
  /** Every executable target line ran. */
  allRan: boolean;
  /** When a target line did not run: the test running most of the code around it; null when no test ran the file. */
  nearest?: NearestTest | null;
}

/** The target lines a covered file says ran, did not run, or cannot tell. */
export function reachOfTargets(
  entry: CoverageFile | null,
  complete: boolean,
  target: LineRange[],
  executable: LineRange[] | null,
): Pick<CoverageReachAnswer, 'ran' | 'notRan' | 'unknown' | 'notExecutable' | 'allRan' | 'granularity'> {
  const notExecutable = executable ? subtractLineRanges(target, executable) : [];
  const relevant = executable ? intersectLineRanges(target, executable) : target;
  let ran: LineRange[] = [];
  let missing: LineRange[] = relevant;
  let unknown: LineRange[] = [];
  let granularity: CoverageGranularity | undefined;
  if (entry) {
    if (entry.lines?.length) {
      granularity = 'lines';
      ran = intersectLineRanges(relevant, entry.lines);
      missing = subtractLineRanges(relevant, entry.lines);
    } else if (entry.functions?.length) {
      granularity = 'functions';
      const inFunctions = normalizeLineRanges(entry.functions);
      ran = intersectLineRanges(relevant, inFunctions);
      missing = subtractLineRanges(relevant, inFunctions);
    } else {
      granularity = 'files';
      unknown = relevant;
      missing = [];
    }
  }
  if (!complete) {
    unknown = unionLineRanges(unknown, missing);
    missing = [];
  }
  return {
    ...(granularity ? { granularity } : {}),
    ran,
    notRan: missing,
    unknown,
    ...(executable ? { notExecutable } : {}),
    allRan: missing.length === 0 && unknown.length === 0,
  };
}

/** A file's coverage as `getFileCoverage` reads it: its distinct fragments and the tests behind each. */
export interface FileCoverageView {
  fragments: Array<CoverageFile & { tests: number[] }>;
  tests: Array<{
    id: number;
    title: string;
    file: string;
    status: 'passed' | 'flaky' | 'failed' | 'skipped' | null;
  }>;
}

/**
 * The test that runs most of the code around the target lines, from a file's
 * coverage: at the target's version (`blob`, else the version most tests
 * ran), the smallest function a fragment names around the first target line
 * is the region, else the target lines themselves; the test running most of
 * the region's lines wins, then the one running most target lines, then a
 * passing one, then the lower id. Without a fragment at that version, the
 * test running most lines of the file at any version stands in. Null when no
 * other test ran the file.
 */
export function nearestTest(
  view: FileCoverageView,
  target: LineRange[],
  opts: { blob?: string | null; excludeTestId?: number } = {},
): NearestTest | null {
  const usable = view.fragments.filter((f) =>
    f.tests.some((t) => view.tests[t] && view.tests[t]!.id !== opts.excludeTestId),
  );
  if (usable.length === 0 || target.length === 0) return null;
  const testsPerBlob = new Map<string, Set<number>>();
  for (const f of usable) {
    if (!f.blob) continue;
    const set = testsPerBlob.get(f.blob) ?? new Set<number>();
    for (const t of f.tests) set.add(t);
    testsPerBlob.set(f.blob, set);
  }
  const blob =
    opts.blob && testsPerBlob.has(opts.blob)
      ? opts.blob
      : [...testsPerBlob.entries()].sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1))[0]?.[0];
  const sameVersion = Boolean(blob && (!opts.blob || opts.blob === blob));
  const atVersion = blob ? usable.filter((f) => f.blob === blob) : [];

  const first = target[0]![0];
  const around = atVersion
    .flatMap((f) => f.functions ?? [])
    .filter(([s, e]) => s <= first && first <= e)
    .sort((a, b) => a[1] - a[0] - (b[1] - b[0]))[0];
  const region: LineRange[] = around ? [around] : target;

  const perTest = new Map<number, { lines: LineRange[][]; functions: LineRange[][] }>();
  for (const f of sameVersion ? atVersion : usable) {
    for (const t of f.tests) {
      if (view.tests[t]?.id === opts.excludeTestId) continue;
      const entry = perTest.get(t) ?? { lines: [], functions: [] };
      if (f.lines) entry.lines.push(f.lines);
      if (f.functions) entry.functions.push(f.functions);
      perTest.set(t, entry);
    }
  }
  const rank = (status: string | null) => (status === 'passed' ? 0 : status === 'flaky' ? 1 : 2);
  let best: { position: number; executed: number; ranTarget: LineRange[] } | null = null;
  for (const [position, entry] of perTest) {
    const lines = unionLineRanges(...entry.lines);
    const ranTarget = sameVersion ? intersectLineRanges(target, lines) : [];
    const executed = sameVersion
      ? lines.length > 0
        ? countLines(intersectLineRanges(region, lines))
        : entry.functions.flat().some(([s, e]) => s <= first && first <= e)
          ? countLines(region)
          : 0
      : countLines(lines);
    if (executed === 0 && ranTarget.length === 0) continue;
    const candidate = { position, executed, ranTarget };
    if (
      !best ||
      executed > best.executed ||
      (executed === best.executed &&
        (countLines(ranTarget) > countLines(best.ranTarget) ||
          (countLines(ranTarget) === countLines(best.ranTarget) &&
            (rank(view.tests[position]!.status) < rank(view.tests[best.position]!.status) ||
              (rank(view.tests[position]!.status) === rank(view.tests[best.position]!.status) &&
                view.tests[position]!.id < view.tests[best.position]!.id)))))
    ) {
      best = candidate;
    }
  }
  if (!best) return null;
  const test = view.tests[best.position]!;
  return {
    testCaseId: test.id,
    title: test.title,
    filePath: test.file,
    status: test.status,
    function: sameVersion && around ? around : null,
    executedLines: best.executed,
    ranTarget: best.ranTarget,
    sameVersion,
  };
}

/** A file's coverage, compacted: per version, line ranges grouped by the tests that ran them. */
export interface CompactFileCoverage {
  file: string;
  branch: string;
  tests: Array<{ testCaseId: number; title: string; filePath: string; status: string | null }>;
  versions: Array<{
    path: string;
    runtime: CoverageRuntime;
    blob?: string;
    /** Executable lines of the version, when a run recorded them (`12-15,20`). */
    executable?: string;
    /** Executed line ranges, each with the positions in `tests` of the tests that ran them. */
    lines?: Array<{ lines: string; tests: number[] }>;
    /** Functions that ran, each with the positions of the tests that ran them. */
    functions?: Array<{ lines: string; tests: number[] }>;
    /** Tests that ran the file at this version without ranges (file granularity). */
    fileOnly?: number[];
    /** Line groups left out past the cap. */
    more?: number;
  }>;
}

/** Line groups a compact version lists, at most. */
const COMPACT_GROUPS = 60;

/**
 * A file's coverage compacted for an agent: per version (runtime, path,
 * blob), the executed lines as ranges, grouped by the exact set of tests that
 * ran them, most tests first.
 */
export function compactFileCoverage(
  view: FileCoverageView & {
    file: string;
    branch: string;
    executable: Array<{ path: string; runtime: CoverageRuntime; blob: string; lines: LineRange[] }>;
  },
): CompactFileCoverage {
  const versions = new Map<string, Array<CoverageFile & { tests: number[] }>>();
  for (const f of view.fragments) {
    const key = `${fileKey(f)}\x00${f.blob ?? ''}`;
    versions.set(key, [...(versions.get(key) ?? []), f]);
  }
  const out: CompactFileCoverage['versions'] = [];
  for (const fragments of versions.values()) {
    const sample = fragments[0]!;
    const version: CompactFileCoverage['versions'][number] = { path: sample.path, runtime: sample.runtime };
    if (sample.blob) version.blob = sample.blob;
    const executable = view.executable.find(
      (e) => e.path === sample.path && e.runtime === sample.runtime && e.blob === sample.blob,
    );
    if (executable) version.executable = encodeLineRanges(executable.lines);

    // Per line segment, the set of tests whose fragments ran it.
    const events = new Map<number, Array<[test: number, delta: number]>>();
    const addEvent = (at: number, test: number, delta: number) => {
      const list = events.get(at);
      if (list) list.push([test, delta]);
      else events.set(at, [[test, delta]]);
    };
    const fileOnly = new Set<number>();
    for (const f of fragments) {
      if (!f.lines?.length && !f.functions?.length) for (const t of f.tests) fileOnly.add(t);
      for (const [start, end] of f.lines ?? []) {
        for (const t of f.tests) {
          addEvent(start, t, 1);
          addEvent(end + 1, t, -1);
        }
      }
    }
    const counts = new Map<number, number>();
    const groups = new Map<string, { tests: number[]; ranges: LineRange[] }>();
    const positions = [...events.keys()].sort((a, b) => a - b);
    for (let p = 0; p < positions.length - 1; p++) {
      for (const [t, delta] of events.get(positions[p]!)!) counts.set(t, (counts.get(t) ?? 0) + delta);
      const tests = [...counts.entries()]
        .filter(([, c]) => c > 0)
        .map(([t]) => t)
        .sort((a, b) => a - b);
      if (tests.length === 0) continue;
      const key = tests.join(',');
      const group = groups.get(key) ?? { tests, ranges: [] };
      group.ranges.push([positions[p]!, positions[p + 1]! - 1]);
      groups.set(key, group);
    }
    const lineGroups = [...groups.values()]
      .map((g) => ({ tests: g.tests, ranges: normalizeLineRanges(g.ranges) }))
      .sort((a, b) => b.tests.length - a.tests.length || a.ranges[0]![0] - b.ranges[0]![0]);
    if (lineGroups.length > 0) {
      version.lines = lineGroups
        .slice(0, COMPACT_GROUPS)
        .map((g) => ({ lines: encodeLineRanges(g.ranges), tests: g.tests }));
      if (lineGroups.length > COMPACT_GROUPS) version.more = lineGroups.length - COMPACT_GROUPS;
    }

    const functionTests = new Map<string, { range: LineRange; tests: Set<number> }>();
    for (const f of fragments) {
      if (f.lines?.length) continue;
      for (const range of f.functions ?? []) {
        const key = `${range[0]}-${range[1]}`;
        const entry = functionTests.get(key) ?? { range, tests: new Set<number>() };
        for (const t of f.tests) entry.tests.add(t);
        functionTests.set(key, entry);
      }
    }
    if (functionTests.size > 0) {
      version.functions = [...functionTests.values()]
        .sort((a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1])
        .slice(0, COMPACT_GROUPS)
        .map((e) => ({ lines: `${e.range[0]}-${e.range[1]}`, tests: [...e.tests].sort((a, b) => a - b) }));
    }
    if (fileOnly.size > 0) version.fileOnly = [...fileOnly].sort((a, b) => a - b);
    out.push(version);
  }
  return {
    file: view.file,
    branch: view.branch,
    tests: view.tests.map((t) => ({ testCaseId: t.id, title: t.title, filePath: t.file, status: t.status })),
    versions: out,
  };
}
