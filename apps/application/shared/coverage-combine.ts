/**
 * Combined coverage: one ratio per commit over every suite that ran the code,
 * the Playwright suite's own coverage and the reports uploaded for the commit.
 * Pure: the server and the demo load the inputs, this counts.
 *
 * Per file version (path and blob) in the coverage scope:
 *
 * 1. **Reference lines**: the span table's executable lines when a run
 *    recorded them for that blob, else the union of the reports' executable
 *    lines for it. Every suite's lines count on them only, so the suites'
 *    ratios share one denominator; a line a tool marks outside them is ignored.
 * 2. **Executed**: a reference line ran when any suite ran it.
 * 3. **Undetermined**: reference lines no suite ran, inside a function a suite
 *    that records functions only (the browser end-to-end suite) ran, and not
 *    inside a function nested in it that the suite reports as not run. Shown
 *    next to the ratio, never added to it.
 * 4. **Functions**: every function a suite knows, matched across suites by its
 *    start line; one ran when any suite ran a function starting there.
 * 5. **Files without coverage data**: files of the commit's inventory in scope
 *    that no suite names, outside both ratios.
 *
 * Each reference line falls in one class: unit only, end to end only, both,
 * none, or undetermined.
 */
import {
  countLines,
  intersectLineRanges,
  normalizeFunctionRanges,
  normalizeLineRanges,
  type LineRange,
} from '@piwitests/core/coverage';

/** What a suite's tests are. */
export type CoverageSuiteKind = 'unit' | 'e2e';

/** The suite name of the Playwright suite Piwi records itself. */
export const E2E_SUITE = 'e2e';
/** The name totals use for every suite together. */
export const COMBINED_SUITE = 'combined';

/** One file as one suite covered it. */
export interface SuiteFile {
  path: string;
  /** The file version the line numbers refer to; without one, the file counts as reached, its lines do not. */
  blob?: string;
  /** The lines the suite's tool can mark as run (a report's), empty when it names none. */
  executable: LineRange[];
  lines: LineRange[];
  /** The functions that ran. */
  functions: LineRange[];
  /** Every function the suite knows in the file, run or not. */
  allFunctions: LineRange[];
  /** False when the suite records functions only (the browser): its unrun lines in a function that ran are undetermined. */
  linesRecorded: boolean;
}

/** One suite's coverage of the commit. */
export interface SuiteInput {
  name: string;
  kind: CoverageSuiteKind;
  files: SuiteFile[];
  /** The commit an absent suite's files were carried forward from, file by file where the blob matches. */
  carriedFrom?: string | null;
  /** How many of its files were carried forward. */
  carriedFiles?: number;
  /** The suite left part of its coverage out. */
  incomplete?: boolean;
}

/** What the commit's coverage is read against. */
export interface CombineInput {
  /** The commit's tracked files in scope and their blobs; null when no upload named an inventory. */
  inventory: ReadonlyMap<string, string> | null;
  /** Whether a path counts. */
  inScope: (path: string) => boolean;
  /** The span table's executable lines of each file version, by `path\0blob`. */
  spanTable: ReadonlyMap<string, LineRange[]>;
  suites: SuiteInput[];
}

/** The classes of a file's reference lines. */
export interface LineClasses {
  unitOnly: LineRange[];
  e2eOnly: LineRange[];
  both: LineRange[];
  none: LineRange[];
  undetermined: LineRange[];
}

/** One file of the commit, combined. */
export interface CombinedFile {
  path: string;
  blob: string | null;
  /** Where the reference lines come from: the span table, the reports, or none (functions only). */
  reference: 'span-table' | 'report' | 'none';
  executable: LineRange[];
  executed: LineRange[];
  classes: LineClasses;
  /** Per suite, the reference lines it ran. */
  bySuite: Record<string, LineRange[]>;
  knownFunctions: LineRange[];
  runFunctions: LineRange[];
  /** Per suite, the functions it ran, matched by start line. */
  functionsBySuite: Record<string, number>;
}

/** Counts over files: the totals of a commit, a suite or a folder. */
export interface CoverageCounts {
  executableLines: number;
  executedLines: number;
  undeterminedLines: number;
  knownFunctions: number;
  runFunctions: number;
  /** Files counted: in scope, named by a suite. */
  files: number;
  unitOnlyLines: number;
  e2eOnlyLines: number;
  bothLines: number;
}

/** One suite's totals on the commit's reference lines. */
export interface SuiteTotals extends CoverageCounts {
  name: string;
  kind: CoverageSuiteKind;
  carriedFrom: string | null;
  carriedFiles: number;
  incomplete: boolean;
}

/** A commit's coverage, combined. */
export interface CombinedCoverage {
  files: CombinedFile[];
  totals: CoverageCounts;
  suites: SuiteTotals[];
  /** Files of the inventory in scope no suite names; null without an inventory. */
  filesWithoutData: string[] | null;
  /** Files whose reference lines are the reports' because no run recorded the span table of their version. */
  filesReferencedByReports: number;
}

const key = (path: string, blob: string) => `${path}\0${blob}`;

/** Lines of `a` not in `b`, both normalized. */
export function subtractLineRanges(a: LineRange[], b: LineRange[]): LineRange[] {
  const out: LineRange[] = [];
  let j = 0;
  for (const [start, end] of a) {
    let from = start;
    while (j < b.length && b[j]![1] < from) j++;
    let k = j;
    while (k < b.length && b[k]![0] <= end) {
      const [bStart, bEnd] = b[k]!;
      if (bStart > from) out.push([from, bStart - 1]);
      from = Math.max(from, bEnd + 1);
      if (from > end) break;
      k++;
    }
    if (from <= end) out.push([from, end]);
  }
  return out;
}

const union = (...ranges: LineRange[][]) => normalizeLineRanges(ranges.flat());

/**
 * The lines of the functions a suite recording functions only ran, less the
 * functions nested in them it lists as not run: a line counts when the
 * innermost function around it ran.
 */
function linesInRunFunctions(file: SuiteFile): LineRange[] {
  const ran = normalizeFunctionRanges(file.functions);
  const ranStarts = new Set(ran.map((f) => f[0]));
  const notRun = normalizeFunctionRanges(file.allFunctions)
    .filter((f) => !ranStarts.has(f[0]))
    .sort((a, b) => a[0] - b[0]);
  return union(
    ...ran.map((outer) => {
      const nested: LineRange[] = [];
      for (const inner of notRun) {
        if (inner[0] > outer[1]) break;
        if (inner[0] > outer[0] && inner[1] <= outer[1]) nested.push(inner);
      }
      return subtractLineRanges([outer], normalizeLineRanges(nested));
    }),
  );
}

function emptyCounts(): CoverageCounts {
  return {
    executableLines: 0,
    executedLines: 0,
    undeterminedLines: 0,
    knownFunctions: 0,
    runFunctions: 0,
    files: 0,
    unitOnlyLines: 0,
    e2eOnlyLines: 0,
    bothLines: 0,
  };
}

/** Add a file's counts to `into`. */
export function addFileCounts(into: CoverageCounts, file: CombinedFile): void {
  into.files++;
  into.executableLines += countLines(file.executable);
  into.executedLines += countLines(file.executed);
  into.undeterminedLines += countLines(file.classes.undetermined);
  into.knownFunctions += file.knownFunctions.length;
  into.runFunctions += file.runFunctions.length;
  into.unitOnlyLines += countLines(file.classes.unitOnly);
  into.e2eOnlyLines += countLines(file.classes.e2eOnly);
  into.bothLines += countLines(file.classes.both);
}

/** The functions known by start line, the widest range kept for each. */
function functionsByStart(ranges: LineRange[]): Map<number, LineRange> {
  const out = new Map<number, LineRange>();
  for (const range of ranges) {
    const known = out.get(range[0]);
    if (!known || range[1] > known[1]) out.set(range[0], range);
  }
  return out;
}

/** Each suite's totals over files, on the files' reference lines. */
function suiteTotals(
  files: CombinedFile[],
  suites: Array<Pick<SuiteInput, 'name' | 'kind' | 'carriedFrom' | 'carriedFiles' | 'incomplete'>>,
): SuiteTotals[] {
  return suites.map((suite) => {
    const counts = emptyCounts();
    // Every suite counts on the same reference lines: a file it does not name is all unrun for it.
    for (const file of files) {
      counts.executableLines += countLines(file.executable);
      counts.knownFunctions += file.knownFunctions.length;
      if (!(suite.name in file.bySuite)) continue;
      counts.files++;
      counts.executedLines += countLines(file.bySuite[suite.name]!);
      counts.runFunctions += file.functionsBySuite[suite.name] ?? 0;
    }
    return {
      ...counts,
      name: suite.name,
      kind: suite.kind,
      carriedFrom: suite.carriedFrom ?? null,
      carriedFiles: suite.carriedFiles ?? 0,
      incomplete: suite.incomplete === true,
    };
  });
}

/** One named area of a commit's coverage: its files' totals and each suite's. */
export interface AreaCoverage {
  name: string;
  totals: CoverageCounts;
  suites: SuiteTotals[];
}

/**
 * A commit's coverage split by area: each of `names`, in order, with the
 * files `areaOf` puts in it. An area no file of the commit falls in counts
 * nothing.
 */
export function areaCoverage(
  combined: Pick<CombinedCoverage, 'files' | 'suites'>,
  names: string[],
  areaOf: (path: string) => string | null,
): AreaCoverage[] {
  const byArea = new Map<string, CombinedFile[]>(names.map((name) => [name, []]));
  for (const file of combined.files) {
    const area = areaOf(file.path);
    if (area !== null) byArea.get(area)?.push(file);
  }
  return names.map((name) => {
    const files = byArea.get(name)!;
    const totals = emptyCounts();
    for (const file of files) addFileCounts(totals, file);
    return { name, totals, suites: suiteTotals(files, combined.suites) };
  });
}

/** Combine the suites' coverage of one commit. */
export function combineCoverage(input: CombineInput): CombinedCoverage {
  // Each file's entries per suite, at the version the inventory names (else the first a suite names).
  const byPath = new Map<string, Array<{ suite: SuiteInput; file: SuiteFile }>>();
  for (const suite of input.suites) {
    for (const file of suite.files) {
      if (!input.inScope(file.path)) continue;
      const list = byPath.get(file.path);
      if (list) list.push({ suite, file });
      else byPath.set(file.path, [{ suite, file }]);
    }
  }

  const files: CombinedFile[] = [];
  let referencedByReports = 0;
  for (const [path, entries] of [...byPath].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const blob = input.inventory?.get(path) ?? entries.find((e) => e.file.blob)?.file.blob ?? null;
    // Entries of another version name other lines: only those of this version count, a file without a blob counts as reached.
    const placed = entries.filter((e) => blob !== null && e.file.blob === blob);
    const span = blob ? input.spanTable.get(key(path, blob)) : undefined;
    const reported = union(...placed.map((e) => e.file.executable));
    const reference: CombinedFile['reference'] =
      span && span.length > 0 ? 'span-table' : reported.length > 0 ? 'report' : 'none';
    if (reference === 'report') referencedByReports++;
    const executable = reference === 'span-table' ? normalizeLineRanges(span) : reported;

    const bySuite: Record<string, LineRange[]> = {};
    const unitRan: LineRange[][] = [];
    const e2eRan: LineRange[][] = [];
    const inFunctionsRan: LineRange[][] = [];
    for (const { suite, file } of placed) {
      const ran = intersectLineRanges(normalizeLineRanges(file.lines), executable);
      bySuite[suite.name] = union(bySuite[suite.name] ?? [], ran);
      (suite.kind === 'unit' ? unitRan : e2eRan).push(ran);
      if (!file.linesRecorded) inFunctionsRan.push(linesInRunFunctions(file));
    }
    const unit = union(...unitRan);
    const e2e = union(...e2eRan);
    const executed = union(unit, e2e);
    const notRun = subtractLineRanges(executable, executed);
    const undetermined = intersectLineRanges(notRun, union(...inFunctionsRan));
    const both = intersectLineRanges(unit, e2e);
    const classes: LineClasses = {
      unitOnly: subtractLineRanges(unit, e2e),
      e2eOnly: subtractLineRanges(e2e, unit),
      both,
      none: subtractLineRanges(notRun, undetermined),
      undetermined,
    };

    const known = functionsByStart(
      normalizeFunctionRanges(placed.flatMap((e) => [...e.file.allFunctions, ...e.file.functions])),
    );
    const ranStarts = new Set<number>();
    // A suite can name a file twice (its server and browser coverage): a function counts once.
    const startsBySuite = new Map<string, Set<number>>();
    for (const { suite, file } of placed) {
      const starts = startsBySuite.get(suite.name) ?? new Set<number>();
      for (const [start] of file.functions) {
        if (!known.has(start)) continue;
        starts.add(start);
        ranStarts.add(start);
      }
      startsBySuite.set(suite.name, starts);
    }
    const functionsBySuite: Record<string, number> = {};
    for (const [name, starts] of startsBySuite) functionsBySuite[name] = starts.size;
    const knownFunctions = [...known.values()].sort((a, b) => a[0] - b[0]);
    files.push({
      path,
      blob,
      reference,
      executable,
      executed,
      classes,
      bySuite,
      knownFunctions,
      runFunctions: knownFunctions.filter((f) => ranStarts.has(f[0])),
      functionsBySuite,
    });
  }

  const totals = emptyCounts();
  for (const file of files) addFileCounts(totals, file);

  const suites = suiteTotals(files, input.suites);

  const named = new Set(files.map((f) => f.path));
  const filesWithoutData = input.inventory
    ? [...input.inventory.keys()].filter((path) => input.inScope(path) && !named.has(path)).sort()
    : null;

  return { files, totals, suites, filesWithoutData, filesReferencedByReports: referencedByReports };
}

/**
 * A ratio as a percentage with one decimal, or null when there is nothing to
 * count. A part short of the whole never reads as 100.
 */
export function coveragePercent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  const percent = Math.round((part / whole) * 1000) / 10;
  return percent >= 100 && part < whole ? 99.9 : percent;
}

/** One folder's (or file's) entry in a breakdown. */
export interface FolderEntry extends CoverageCounts {
  /** The folder or file path, repository-relative; '' for the root. */
  path: string;
  kind: 'folder' | 'file';
}

/**
 * The breakdown of a folder: its direct children, folders then files, each
 * with the sum of its files' counts. `folder` is '' for the repository root.
 */
export function folderBreakdown(files: CombinedFile[], folder: string): FolderEntry[] {
  const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : '';
  const children = new Map<string, FolderEntry>();
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    const childPath = prefix + name;
    let entry = children.get(childPath);
    if (!entry) {
      entry = { ...emptyCounts(), path: childPath, kind: slash < 0 ? 'file' : 'folder' };
      children.set(childPath, entry);
    }
    addFileCounts(entry, file);
  }
  return [...children.values()].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

/**
 * The files under a folder with the most lines no suite ran (not counting the
 * undetermined ones), the most first, then the lowest share run, then by path;
 * a file with every line run is left out.
 */
export function leastCoveredFiles(
  files: CombinedFile[],
  folder: string,
  limit: number,
): Array<FolderEntry & { unrunLines: number }> {
  const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : '';
  const out: Array<FolderEntry & { unrunLines: number }> = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const unrunLines = countLines(file.classes.none);
    if (unrunLines === 0) continue;
    const entry = { ...emptyCounts(), path: file.path, kind: 'file' as const, unrunLines };
    addFileCounts(entry, file);
    out.push(entry);
  }
  const share = (e: FolderEntry) => (e.executableLines > 0 ? e.executedLines / e.executableLines : 1);
  return out
    .sort((a, b) => b.unrunLines - a.unrunLines || share(a) - share(b) || (a.path < b.path ? -1 : 1))
    .slice(0, limit);
}

/** One child of a folder in the coverage tree: its counts, its lines no suite ran, and its files without data. */
export interface TreeEntry extends FolderEntry {
  /** Executable lines no suite ran, the undetermined ones not counted. */
  unrunLines: number;
  /** Tracked files in scope under it that no suite names; 1 for such a file itself. */
  filesWithoutData: number;
  /** A file no suite names: it has no lines to count. */
  noData: boolean;
}

/**
 * The children of `folder` in the coverage tree: the folders and files of
 * the combined coverage, each with its counts, and the files without
 * coverage data in place, each under its folder. Folders first, then files,
 * by path.
 */
export function coverageTreeLevel(files: CombinedFile[], withoutData: string[], folder: string): TreeEntry[] {
  const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : '';
  const entries = new Map<string, TreeEntry>(
    folderBreakdown(files, folder).map((e) => [
      e.path,
      {
        ...e,
        unrunLines: e.executableLines - e.executedLines - e.undeterminedLines,
        filesWithoutData: 0,
        noData: false,
      },
    ]),
  );
  for (const path of withoutData) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const childPath = prefix + (slash < 0 ? rest : rest.slice(0, slash));
    const known = entries.get(childPath);
    if (known) known.filesWithoutData++;
    else {
      entries.set(childPath, {
        ...emptyCounts(),
        path: childPath,
        kind: slash < 0 ? 'file' : 'folder',
        unrunLines: 0,
        filesWithoutData: 1,
        noData: slash < 0,
      });
    }
  }
  return [...entries.values()].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}
