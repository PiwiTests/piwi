/**
 * Suspect lines in a reader's words: the sentence the What changed line of a
 * failure page says about them, the granularity of each suspect, its line
 * ranges, and which rows of a diff they mark. Pure, so the cluster page, the
 * execution page and the What changed card word them one way.
 */
import { normalizeLineRanges, type LineRange } from '@piwitests/core/coverage';
import { lineRangesText } from '#shared/patch-coverage';
import type { SuspectLine, SuspectLinesAnswer } from '#shared/suspect-lines';
import type { PatchLine } from '~/utils';

/** Whose coverage the sentence speaks of: a cluster's failing tests, or the one execution's test. */
export type SuspectSubject = 'cluster' | 'execution';

/** The sentence of a What changed line about the suspect lines, split around the first suspect. */
export interface SuspectSentence {
  /** The words before the first suspect: "3 of the 13 changed lines ran in the failing test: ". */
  lead: string;
  /** The most suspect hunk, null when the failing tests ran none of the changed lines. */
  first: {
    /** Repository-relative path. */
    path: string;
    /** The file's name, what the sentence shows. */
    name: string;
    /** The first line it names, for a link that opens the file there. */
    line: number;
    /** Its line ranges in words: "57 to 59". */
    lines: string;
    /** Its granularity in words when the lead counts hunks rather than lines: "file reached". */
    granularity: string | null;
  } | null;
  /** The words after it: " and 2 more", or "" when it is the only one. */
  more: string;
}

/** A suspect's granularity in a reader's words. */
export function suspectGranularityLabel(granularity: SuspectLine['granularity']): string {
  if (granularity === 'lines') return 'lines it ran';
  if (granularity === 'functions') return 'a function it ran';
  return 'file reached';
}

export { lineRangesText };

/** "3 failing tests", "1 passing test". */
export function testCountText(n: number, kind: 'failing' | 'passing'): string {
  return `${n} ${kind} test${n === 1 ? '' : 's'}`;
}

/**
 * "3 of the 13 changed lines", "all 13 changed lines", "the changed line"; with
 * `since`, "3 of the 13 lines changed since the last passing run".
 */
function ofTheChanged(n: number, total: number, noun: string, since: boolean): string {
  const plural = `${noun}s`;
  const changed = (word: string) => (since ? `${word} changed since the last passing run` : `changed ${word}`);
  if (n < total) return `${n} of the ${total} ${changed(plural)}`;
  return total === 1 ? `the ${changed(noun)}` : `all ${total} ${changed(plural)}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The sentence the What changed line says about an answer, or null when there
 * is none to say (no answer, or suspect lines not available). With every
 * suspect at line granularity it counts the changed lines the failing tests
 * ran; with a coarser one it counts the hunks they reached, and names the
 * first suspect's granularity.
 */
export function suspectLinesSentence(
  answer: SuspectLinesAnswer | null | undefined,
  subject: SuspectSubject,
): SuspectSentence | null {
  if (!answer?.available) return null;
  const { summary, suspects } = answer;
  const who =
    subject === 'execution'
      ? 'this test'
      : summary.failingWithCoverage === 1
        ? 'the failing test'
        : 'the failing tests';
  // The cluster's line says since when in its first clause; the execution's has only this sentence.
  const since = subject === 'execution';
  const top = suspects[0];
  if (!top) {
    const whose = who === 'the failing tests' ? 'the failing tests’' : `${who}’s`;
    const lines = summary.changedLines === 1 ? 'line' : `${summary.changedLines} lines`;
    const none = since
      ? `the ${lines} changed since the last passing run`
      : `the ${lines.replace(/line/, 'changed line')}`;
    return { lead: `${capitalize(whose)} coverage includes none of ${none}.`, first: null, more: '' };
  }

  const byLines = summary.executedLines > 0 && suspects.every((s) => s.granularity === 'lines');
  const lead = byLines
    ? `${capitalize(ofTheChanged(summary.executedLines, summary.changedLines, 'line', since))} ran in ${who}: `
    : `${capitalize(who)} reached ${ofTheChanged(summary.executedHunks, summary.hunks, 'hunk', since)}: `;
  const others = Math.max(summary.executedHunks, suspects.length) - 1;
  return {
    lead,
    first: {
      path: top.path,
      name: top.path.split('/').pop() || top.path,
      line: top.lines[0]?.[0] ?? top.hunk[0],
      lines: lineRangesText(top.lines),
      granularity: byLines ? null : suspectGranularityLabel(top.granularity),
    },
    more: others > 0 ? ` and ${others} more` : '',
  };
}

/** The suspect lines of each file, keyed by path and normalized, for the diff to mark. */
export function suspectMarks(suspects: SuspectLine[]): Record<string, LineRange[]> {
  const marks: Record<string, LineRange[]> = {};
  for (const suspect of suspects) (marks[suspect.path] ??= []).push(...suspect.lines);
  for (const path of Object.keys(marks)) marks[path] = normalizeLineRanges(marks[path]);
  return marks;
}

/**
 * The head-side line number of each row of a parsed patch: the hunk header's
 * new start, counted up through the context and added rows. A removed row, a
 * hunk header, a "\ No newline at end of file" note and anything before the
 * first hunk have none.
 */
export function patchHeadLines(lines: PatchLine[]): Array<number | null> {
  let next: number | null = null;
  return lines.map((row) => {
    if (row.type === 'hunk') {
      const match = row.text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      next = match ? Number(match[1]) : null;
      return null;
    }
    if (next === null || row.type === 'remove' || row.text.startsWith('\\')) return null;
    return next++;
  });
}
