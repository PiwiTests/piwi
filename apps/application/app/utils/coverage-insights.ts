/**
 * The coverage insights in a reader's words: the rows of a failing execution's
 * comparison with its last passing run, the sentences of a test's path
 * variation, and the preview of what quarantining or releasing tests does to
 * the code no other trusted test runs. Pure, so the components and their tests
 * read one wording; the answers come from `#shared/coverage-insights`.
 */
import { countLines, type LineRange } from '@piwitests/core/coverage';
import type {
  CoverageDivergenceAnswer,
  CoverageLossAnswer,
  DivergedFile,
  LossFile,
  PathExplanation,
  PathVariationAnswer,
  VaryingCode,
  VaryingFile,
} from '#shared/coverage-insights';
import { lineRangesText } from '~/utils/suspect-lines';

const plural = (n: number, noun: string, many = `${noun}s`) => `${n} ${n === 1 ? noun : many}`;

/** "lines 58 to 59, 62", "line 54"; "" for none. */
export function linesPhrase(ranges: LineRange[] | undefined): string {
  if (!ranges?.length) return '';
  return `${countLines(ranges) === 1 ? 'line' : 'lines'} ${lineRangesText(ranges)}`;
}

/** What one side of a file ran: its lines, else its function count. */
function sidePhrase(lines: LineRange[] | undefined, functions: LineRange[] | undefined): string {
  return linesPhrase(lines) || (functions?.length ? plural(functions.length, 'function') : '');
}

/** " (and 3 more ranges)" for ranges left out of a capped list. */
function moreRangesPhrase(more: number | undefined): string {
  return more ? ` (and ${plural(more, 'more range')})` : '';
}

// ── A failure's path against its last pass ──────────────────────────────────

/** One file of the comparison as the Coverage section lists it. */
export interface DivergenceRow {
  file: DivergedFile;
  /** What differs, as meta text: "only in this execution · lines 58 to 59". */
  text: string;
  /** The line the file opens at in the editor: the first line that differs. */
  firstLine: number | null;
  /** Both sides ran the same version with line numbers: its source shows what each ran. */
  comparable: boolean;
}

/** The text of a file whose code only one side, or each side, ran. */
export function divergenceRowText(file: DivergedFile): string {
  const here = sidePhrase(file.linesOnlyHere, file.functionsOnlyHere);
  const pass = sidePhrase(file.linesOnlyBaseline, file.functionsOnlyBaseline);
  const runtime = file.runtime === 'browser' ? 'browser · ' : '';
  const more = moreRangesPhrase(file.moreRanges);
  if (file.status === 'only-here') return `${runtime}only in this execution${here ? ` · ${here}` : ''}${more}`;
  if (file.status === 'only-baseline') return `${runtime}only in the passing run${pass ? ` · ${pass}` : ''}${more}`;
  const parts = [here && `here: ${here}`, pass && `in the pass: ${pass}`].filter(Boolean);
  return `${runtime}${parts.join(' · ')}${more}`;
}

/**
 * The comparison's files as the section lists them, in the answer's order:
 * the files only this execution ran, then those both ran differently, then
 * those only the passing run ran. Files at another version are counted apart.
 */
export function divergenceRows(answer: CoverageDivergenceAnswer): { rows: DivergenceRow[]; changed: DivergedFile[] } {
  const rows: DivergenceRow[] = [];
  const changed: DivergedFile[] = [];
  for (const file of answer.files) {
    if (file.status === 'changed') {
      changed.push(file);
      continue;
    }
    const first = [file.linesOnlyHere, file.functionsOnlyHere, file.linesOnlyBaseline, file.functionsOnlyBaseline]
      .map((ranges) => ranges?.[0]?.[0])
      .find((line) => line != null);
    rows.push({
      file,
      text: divergenceRowText(file),
      firstLine: first ?? null,
      comparable:
        file.status === 'diverged' &&
        Boolean(file.blob) &&
        Boolean(file.linesOnlyHere?.length || file.linesOnlyBaseline?.length),
    });
  }
  return { rows, changed };
}

/** "2 files ran at another version in the passing run, not compared." */
export function changedFilesText(count: number): string {
  return `${plural(count, 'file')} ran at another version in the passing run, not compared.`;
}

/** The side whose capture was incomplete, in one sentence; null when both were complete. */
export function divergenceIncompleteText(answer: CoverageDivergenceAnswer): string | null {
  if (answer.incomplete?.execution) {
    return 'This execution’s coverage is incomplete, so what only the passing run ran is left out.';
  }
  if (answer.incomplete?.baseline) {
    return 'The passing run’s coverage is incomplete, so what only this execution ran is left out.';
  }
  return null;
}

// ── A path that depends on the tests before it ─────────────────────────────

/**
 * How many executions took the less common side of the most evenly split
 * code: "Takes a different path in 3 of 10 recent executions".
 */
export function pathVariationHeadline(answer: PathVariationAnswer): string | null {
  const first = answer.varying[0];
  if (!answer.available || !first) return null;
  const compared = answer.executions.compared;
  const minority = Math.min(first.ranIn, compared - first.ranIn);
  return `Takes a different path in ${minority} of ${compared} recent executions`;
}

/** A varying file's code, as meta text: "lines 58 to 59", "2 functions", "the file". */
export function varyingFilePhrase(file: VaryingFile): string {
  return (sidePhrase(file.lines, file.functions) || 'the file') + moreRangesPhrase(file.moreRanges);
}

/** The first line a varying file ran, to open it at. */
export function varyingFileLine(file: VaryingFile): number | null {
  return file.lines?.[0]?.[0] ?? file.functions?.[0]?.[0] ?? null;
}

/** A varying group in one meta line: "Ran in 3 of 10 executions, all 3 failed". */
export function varyingCodeText(code: VaryingCode, compared: number): string {
  const failed =
    code.failedIn === 0
      ? ''
      : code.failedIn === code.ranIn
        ? code.ranIn === 1
          ? ', which failed'
          : `, all ${code.ranIn} failed`
        : `, ${code.failedIn} failed`;
  return `Ran in ${code.ranIn} of ${compared} executions${failed}`;
}

/** Where the earlier test finished, in the explanation's sentence. */
export function explanationRelationText(relation: PathExplanation['relation']): string {
  return relation === 'earlier-in-run' ? 'finished earlier in the run' : 'finished earlier on the same worker';
}

/**
 * Why the test's failures matter to the explanation, in one sentence: they
 * follow the code the earlier test predicts. Null when the test is not
 * order-dependent.
 */
export function orderDependentText(answer: PathVariationAnswer): string | null {
  const follow = answer.failuresFollow;
  if (!answer.orderDependent || !follow) return null;
  const ran = follow.side === 'ran' ? 'ran' : 'did not run';
  const which =
    follow.onSide === follow.failed
      ? follow.failed === 1
        ? 'its failed execution'
        : `all ${follow.failed} of its failed executions`
      : `${follow.onSide} of its ${follow.failed} failed executions`;
  return `Its failures follow that difference: ${which} ${ran} that code. The test depends on what an earlier test leaves behind, the order flaky root cause.`;
}

// ── What quarantining or releasing tests leaves uncovered ───────────────────

/** A file a preview names, with the lines it would leave to no other trusted test. */
export interface LossPreviewFile {
  file: LossFile;
  /** "lines 58 to 59", "2 functions", "the file". */
  text: string;
  firstLine: number | null;
}

/** What a quarantine or a release does to the code only these tests run. */
export interface LossPreview {
  /** The answer in one sentence. */
  headline: string;
  /** The worst files, at most three. */
  files: LossPreviewFile[];
  /** The rest in one meta line: what only flaky tests run, the files that could not be compared; null when nothing. */
  extra: string | null;
}

const LOSS_FILES_SHOWN = 3;

/** The amount of code, the lines first: "12 lines", "3 functions", "2 files". */
function amountPhrase(lines: number, functions: number, files: number): string {
  if (lines > 0) return plural(lines, 'line');
  if (functions > 0) return plural(functions, 'function');
  return plural(files, 'file');
}

/**
 * The preview of quarantining (or deleting) the tests, or of releasing them:
 * "Leaves 12 lines in 2 files run by no other trusted test", or "Covers again
 * 12 lines in 2 files no other trusted test runs", with the worst files and
 * one meta line for what only flaky tests run and the files run at another
 * version. A quarantine whose tests' code every other test runs too says so
 * in one sentence; a release with nothing to cover again, and an answer with
 * no coverage, give null.
 */
export function coverageLossPreview(
  answer: CoverageLossAnswer | null | undefined,
  action: 'quarantine' | 'release',
): LossPreview | null {
  if (!answer?.available) return null;
  const { summary } = answer;
  const lost = answer.files.filter((f) => f.lines?.length || f.functions?.length || f.status === 'only-these');
  const onlyFlaky = answer.files.filter(
    (f) => f.onlyFlakyLines?.length || f.onlyFlakyFunctions?.length || (f.status === 'only-flaky' && !f.lines?.length),
  );
  const flakyAmount =
    summary.onlyFlakyLines + summary.onlyFlakyFunctions > 0
      ? amountPhrase(summary.onlyFlakyLines, summary.onlyFlakyFunctions, 0)
      : summary.filesOnlyFlaky > 0
        ? plural(summary.filesOnlyFlaky, 'file')
        : '';
  const uncertain =
    summary.filesUncertain > 0
      ? `${plural(summary.filesUncertain, 'file')} other tests ran only at another version, not compared`
      : '';
  const files = (list: LossFile[], pick: (f: LossFile) => LineRange[] | undefined, functions: typeof pick) =>
    list.slice(0, LOSS_FILES_SHOWN).map((file) => {
      const lines = pick(file);
      const fns = functions(file);
      return {
        file,
        text: (sidePhrase(lines, fns) || 'the file') + moreRangesPhrase(file.moreRanges),
        firstLine: lines?.[0]?.[0] ?? fns?.[0]?.[0] ?? null,
      };
    });

  if (lost.length > 0) {
    const amount = amountPhrase(summary.lines, summary.functions, lost.length);
    const where = summary.lines + summary.functions > 0 ? ` in ${plural(lost.length, 'file')}` : '';
    const headline =
      action === 'quarantine'
        ? `Leaves ${amount}${where} run by no other trusted test`
        : `Covers again ${amount}${where} no other trusted test runs`;
    const flakyMore = flakyAmount.replace(/^(\d+) /, '$1 more ');
    const extra = [flakyMore && `Only flaky tests run ${flakyMore}`, uncertain].filter(Boolean).join(' · ');
    return {
      headline,
      files: files(
        lost,
        (f) => f.lines,
        (f) => f.functions,
      ),
      extra: extra || null,
    };
  }
  if (flakyAmount) {
    const headline =
      action === 'quarantine'
        ? `Leaves ${flakyAmount} run only by flaky tests`
        : `Covers again ${flakyAmount} only flaky tests run`;
    return {
      headline,
      files: files(
        onlyFlaky,
        (f) => f.onlyFlakyLines,
        (f) => f.onlyFlakyFunctions,
      ),
      extra: uncertain || null,
    };
  }
  if (action === 'release') return null;
  const many = answer.tests.filter((t) => t.hasCoverage).length > 1;
  if (summary.filesUncertain > 0) {
    const files = plural(
      summary.filesUncertain,
      `of ${many ? 'their' : 'its'} files`,
      `of ${many ? 'their' : 'its'} files`,
    );
    return {
      headline: `Other tests ran ${files} only at another version, so no line is compared`,
      files: [],
      extra: null,
    };
  }
  return { headline: `Every line ${many ? 'they run' : 'it runs'} is run by another test too`, files: [], extra: null };
}

/** A path cut after each slash, where a narrow line may wrap it. */
export function pathWrapParts(path: string): string[] {
  return path.split(/(?<=\/)/);
}

/** The test ids a coverage-loss read names, deduplicated and sorted: `12,15,40`. */
export function coverageLossKey(testCaseIds: number[]): string {
  return [...new Set(testCaseIds)].sort((a, b) => a - b).join(',');
}
