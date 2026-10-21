/**
 * Patch coverage: the share of a change's added and modified lines that ran,
 * counted on the head commit's combined coverage. A changed line counts when
 * it is a reference line of its file; a blank line, a comment or a file no
 * suite names is left out of both sides of the ratio.
 */
import { lineInRanges, normalizeLineRanges, type LineRange } from '@piwitests/core/coverage';
import { diffFileFromPatch } from '@piwitests/core/diff-anchors';
import { coveragePercent, type CombinedFile, type CoverageSuiteKind } from './coverage-combine';

/** One suite's share of a change's lines. */
export interface PatchSuiteLines {
  name: string;
  kind: CoverageSuiteKind;
  executedLines: number;
}

/** A change's lines, as the head commit's combined coverage counts them. */
export interface PatchCoverage {
  /** The commit whose coverage counts the lines. */
  commit: string;
  /** Changed lines that are reference lines. */
  changedLines: number;
  /** Of those, the lines any suite ran. */
  executedLines: number;
  /** Lines a unit suite ran, and lines the end-to-end suite ran; a line both ran counts in each. */
  unitLines: number;
  e2eLines: number;
  /** Unrun lines inside a function the browser ran. */
  undeterminedLines: number;
  suites: PatchSuiteLines[];
  /** Per named area of the code with a changed line, in the project's order. */
  areas: Array<{ name: string; changedLines: number; executedLines: number }>;
  /** Changed files the coverage counts lines of. */
  files: number;
}

/** One changed file's lines, as the head commit's combined coverage counts them. */
export interface ChangedLines {
  /** Changed lines that are reference lines of the file. */
  changed: number;
  /** Of those, the lines a suite ran. */
  ran: number;
  /** Of those, the lines in a function the browser ran, its lines not recorded. */
  undetermined: number;
  /** Of those, the lines no suite ran, as ranges. */
  notRun: LineRange[];
}

/** Line ranges in words, each range kept on one line: "57 to 59, 64". */
export function lineRangesText(ranges: LineRange[]): string {
  return ranges.map(([start, end]) => (start === end ? String(start) : `${start}\u00a0to\u00a0${end}`)).join(', ');
}

/** The new file's added lines of a provider's patch, ascending. */
export function patchChangedLines(path: string, patch: string | null | undefined): number[] {
  if (!patch) return [];
  const lines = new Set<number>();
  for (const hunk of diffFileFromPatch(path, patch).hunks) for (const added of hunk.added) lines.add(added.line);
  return [...lines].sort((a, b) => a - b);
}

/** Of `lines`, how many fall in `ranges`. */
function countIn(ranges: LineRange[] | undefined, lines: number[]): number {
  if (!ranges || ranges.length === 0) return 0;
  let n = 0;
  for (const line of lines) if (lineInRanges(ranges, line)) n++;
  return n;
}

/** A changed file's lines on its combined coverage; null when none of them is a reference line. */
export function changedLinesOf(file: CombinedFile, changedLines: number[]): ChangedLines | null {
  const counted = changedLines.filter((line) => lineInRanges(file.executable, line));
  if (counted.length === 0) return null;
  const notRun = counted.filter((line) => lineInRanges(file.classes.none, line));
  return {
    changed: counted.length,
    ran: countIn(file.executed, counted),
    undetermined: countIn(file.classes.undetermined, counted),
    notRun: normalizeLineRanges(notRun.map((line) => [line, line])),
  };
}

/** Per changed file, the suites that ran one of its changed lines. */
export function suitesOnChangedLines(file: CombinedFile, changedLines: number[]): string[] {
  return Object.entries(file.bySuite)
    .filter(([, ranges]) => countIn(ranges, changedLines) > 0)
    .map(([name]) => name)
    .sort();
}

/** The project's named areas, in order, and the area of a path. */
export interface PatchAreas {
  names: string[];
  areaOf: (path: string) => string | null;
}

/**
 * Count a change's lines on a commit's combined files. `changed` maps a
 * repository-relative path to its changed lines. Null when no changed line is
 * a reference line.
 */
export function computePatchCoverage(
  commit: string,
  files: CombinedFile[],
  suites: Array<{ name: string; kind: CoverageSuiteKind }>,
  changed: ReadonlyMap<string, number[]>,
  areas: PatchAreas | null = null,
): PatchCoverage | null {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out: PatchCoverage = {
    commit,
    changedLines: 0,
    executedLines: 0,
    unitLines: 0,
    e2eLines: 0,
    undeterminedLines: 0,
    suites: suites.map((s) => ({ name: s.name, kind: s.kind, executedLines: 0 })),
    areas: [],
    files: 0,
  };
  const byArea = new Map((areas?.names ?? []).map((name) => [name, { name, changedLines: 0, executedLines: 0 }]));
  for (const [path, lines] of changed) {
    const file = byPath.get(path);
    if (!file || lines.length === 0) continue;
    const counted = lines.filter((line) => lineInRanges(file.executable, line));
    if (counted.length === 0) continue;
    out.files++;
    out.changedLines += counted.length;
    const executed = countIn(file.executed, counted);
    out.executedLines += executed;
    const area = areas ? byArea.get(areas.areaOf(path) ?? '') : undefined;
    if (area) {
      area.changedLines += counted.length;
      area.executedLines += executed;
    }
    out.unitLines += countIn(file.classes.unitOnly, counted) + countIn(file.classes.both, counted);
    out.e2eLines += countIn(file.classes.e2eOnly, counted) + countIn(file.classes.both, counted);
    out.undeterminedLines += countIn(file.classes.undetermined, counted);
    for (const suite of out.suites) suite.executedLines += countIn(file.bySuite[suite.name], counted);
  }
  out.areas = [...byArea.values()].filter((a) => a.changedLines > 0);
  return out.changedLines > 0 ? out : null;
}

/** The gate's warn-only `minPatchCoverage` warning; null when the change meets it. */
export function patchCoverageWarning(pc: PatchCoverage | null, minPercent: number): string | null {
  if (!pc) {
    return `Patch coverage could not be counted (minimum ${minPercent}%): the head commit's coverage names no changed line — warn-only.`;
  }
  // The counts meet the minimum, not the rounded percentage.
  if (pc.executedLines * 100 >= minPercent * pc.changedLines) return null;
  const percent = coveragePercent(pc.executedLines, pc.changedLines) ?? 0;
  return (
    `Patch coverage ${percent}%: ${pc.executedLines} of the ${pc.changedLines} changed lines ran ` +
    `(minimum ${minPercent}%) — warn-only.`
  );
}
