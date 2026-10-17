/**
 * The words of the combined coverage screens: the commit's totals, a suite's
 * line, a folder's ratio, which suites ran a range of a file, and the steps
 * between a file's gaps. Pure, so
 * the sentences are tested once and read the same on every screen.
 */
import { lineInRanges, type LineRange } from '@piwitests/core/coverage';
import type { CoverageRatios, CoverageSummary } from '~~/server/utils/coverage-summary';

/** A count with thousands separators, the same in every locale so the server and the browser agree. */
export function formatCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A percentage as the screens write it: one decimal, `—` when there is nothing to count. */
export function formatPercent(percent: number | null): string {
  return percent === null ? '—' : `${percent.toFixed(1)}%`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

/** The commit's headline: the share of lines that ran, of how many, across how many suites. */
export function totalsSentence(summary: Pick<CoverageSummary, 'totals' | 'suites'>): string {
  const { totals, suites } = summary;
  if (totals.executableLines === 0) {
    return `No executable lines are known for this commit, across ${plural(suites.length, 'suite')}.`;
  }
  return `${formatPercent(totals.linePercent)} of ${plural(totals.executableLines, 'executable line')} ran, across ${plural(suites.length, 'suite')}.`;
}

/** The undetermined share, when there is one: lines inside functions the browser suite ran. */
export function undeterminedSentence(totals: CoverageRatios): string | null {
  if (!totals.undeterminedLines) return null;
  return `${formatPercent(totals.undeterminedPercent)} more (${plural(totals.undeterminedLines, 'line')}) are in functions the end-to-end tests ran, whose lines are not recorded.`;
}

/** The share of functions that ran. */
export function functionsSentence(totals: CoverageRatios): string | null {
  if (!totals.knownFunctions) return null;
  return `${formatCount(totals.runFunctions)} of ${plural(totals.knownFunctions, 'function')} ran (${formatPercent(totals.functionPercent)}).`;
}

/** What only one kind of suite protects: the lines only unit tests, and only end-to-end tests, ran. */
export function splitSentence(totals: CoverageRatios): string | null {
  if (!totals.executedLines) return null;
  return `Unit tests only: ${plural(totals.unitOnlyLines, 'line')} · end-to-end tests only: ${formatCount(totals.e2eOnlyLines)} · both: ${formatCount(totals.bothLines)}.`;
}

/** A suite's label: its name, and `end to end` or `unit`. */
export function suiteKindLabel(kind: 'unit' | 'e2e'): string {
  return kind === 'e2e' ? 'End to end' : 'Unit';
}

/** Where a carried-forward suite came from, or null for one the commit has. */
export function carriedSentence(suite: { carriedFrom: string | null; carriedFiles: number }): string | null {
  if (!suite.carriedFrom) return null;
  return `${plural(suite.carriedFiles, 'file')} carried from ${suite.carriedFrom.slice(0, 7)}`;
}

/** The suites that ran any line of a range of a file, by name; empty when none did. */
export function suitesOnLines(bySuite: Record<string, LineRange[]>, range: LineRange): string[] {
  const out: string[] = [];
  for (const [name, ranges] of Object.entries(bySuite)) {
    for (let line = range[0]; line <= range[1]; line++) {
      if (lineInRanges(ranges, line)) {
        out.push(name);
        break;
      }
    }
  }
  return out.sort();
}

/** The parent folders of a folder, for its breadcrumb: `a/b/c` gives `a`, `a/b`, `a/b/c`. */
export function folderTrail(folder: string): Array<{ name: string; path: string }> {
  const parts = folder.split('/').filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}

/** Where a selection stands among a file's gaps: the gap it is in, and the gaps before and after it. */
export interface GapSteps {
  /** The index of the gap the selection starts in; null when it is in none. */
  index: number | null;
  previous: LineRange | null;
  next: LineRange | null;
}

/** Step through normalized gaps from a selection: without one, the first gap is next. */
export function gapSteps(gaps: LineRange[], selection: LineRange | null): GapSteps {
  const index = selection ? gaps.findIndex(([start, end]) => start <= selection[0] && selection[0] <= end) : -1;
  const after = selection ? selection[1] : 0;
  const before = selection ? selection[0] : 0;
  return {
    index: index < 0 ? null : index,
    previous: selection ? ([...gaps].reverse().find(([, end]) => end < before) ?? null) : null,
    next: gaps.find(([start]) => start > after) ?? null,
  };
}

/** The narrowest function holding a line; null outside every function. */
export function enclosingFunction(functions: LineRange[], line: number): LineRange | null {
  let found: LineRange | null = null;
  for (const range of functions) {
    if (range[0] <= line && line <= range[1] && (!found || range[1] - range[0] < found[1] - found[0])) found = range;
  }
  return found;
}
