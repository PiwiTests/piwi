/**
 * The words of the combined coverage screens: the commit's totals, a suite's
 * line, a folder's ratio, the notes on what the numbers leave out, which
 * suites ran a range of a file, and the steps between a file's lines not run. Pure, so
 * the sentences are tested once and read the same on every screen.
 */
import { lineInRanges, type LineRange } from '@piwitests/core/coverage';
import type { CoverageDataNote, CoverageRatios, CoverageSummary } from '~~/server/utils/coverage-summary';
import type { RunCoverageGap } from '#shared/run-coverage-gaps';

/** A count with thousands separators, the same in every locale so the server and the browser agree. */
export function formatCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A percentage as the screens write it: one decimal, `—` when there is nothing to count. */
export function formatPercent(percent: number | null): string {
  return percent === null ? '—' : `${percent.toFixed(1)}%`;
}

/** A count and its noun: `1 line`, `1,204 lines`. */
export const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

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

/** A note's sentence, in parts: text, the commits it names, each a link to its coverage, and the runs, each a link to its page. */
export type NoteSentence = Array<string | { commit: string } | { run: number }>;

/** Runs as sentence parts, `#12, #14`. */
function runParts(ids: number[]): NoteSentence {
  return ids.flatMap((id, i) => (i === 0 ? [{ run: id }] : [', ', { run: id }]));
}

/** One note on a commit's numbers as one plain sentence; `branch` is the commit's, null for the default branch. */
export function dataNoteSentence(note: CoverageDataNote, branch: string | null): NoteSentence {
  switch (note.kind) {
    case 'detail-removed':
      return note.supersededBy
        ? [
            'Only this commit’s totals are kept: its file detail went when ',
            { commit: note.supersededBy },
            ` arrived on ${branch ?? 'the default branch'}.`,
          ]
        : ['Only this commit’s totals are kept: its file detail is no longer stored.'];
    case 'carried':
      return [
        `${note.suite}: ${plural(note.files, 'file')} carried from `,
        { commit: note.from },
        ', an earlier commit.',
      ];
    case 'incomplete':
      if (note.suite === 'e2e') {
        return ['e2e: incomplete: a backend restarted or was unreachable during every run it counts.'];
      }
      return [
        `${note.suite}: the report is incomplete, cut at a size limit or with files that disagreed with the checkout.`,
      ];
    case 'runs-incomplete': {
      const one = note.runs.length === 1;
      const restarted = note.runs.every((r) => r.reasons.includes('restarted'));
      const unreachable = note.runs.every((r) => !r.reasons.includes('restarted'));
      const runs = runParts(note.runs.map((r) => r.id));
      const lead = restarted
        ? `the backend restarted during ${one ? 'run' : 'runs'} `
        : unreachable
          ? `the backend was unreachable at the end of ${one ? 'run' : 'runs'} `
          : `a backend restarted or was unreachable in ${one ? 'run' : 'runs'} `;
      if (note.completeRuns > 0) {
        return [
          `e2e: ${lead}`,
          ...runs,
          `. ${one ? 'Its' : 'Their'} lines still count; ${plural(note.completeRuns, 'complete run')} ${note.completeRuns === 1 ? 'keeps' : 'keep'} the suite whole.`,
        ];
      }
      return [
        `e2e: incomplete: ${lead}`,
        ...runs,
        `. The lines the tests ran are kept; what the backend ran outside a request${restarted ? ' before the restart' : ''} is missing, so e2e may read low.`,
      ];
    }
    case 'missing-suite':
      return [`${note.suite}: no coverage for this commit or an earlier one.`];
    case 'no-inventory':
      return ['No inventory uploaded: files no suite names are not counted.'];
    case 'scope-changed':
      return ['These totals were computed under an earlier coverage scope or areas than the project’s current ones.'];
    case 'runs-not-counted': {
      const runs = note.partial + note.lab;
      const why = [
        note.partial ? `${formatCount(note.partial)} partial or unfinished` : null,
        note.lab ? `${formatCount(note.lab)} from a lab or a probe` : null,
      ].filter((part): part is string => !!part);
      return [
        `${plural(runs, 'end-to-end run')} of this commit ${runs === 1 ? 'doesn’t' : 'don’t'} count: ${why.join(', ')}.`,
      ];
    }
  }
}

/** A run's flag when part of its server coverage is missing: `Coverage incomplete: the backend restarted during the run`. */
export function coverageGapHeadline(gaps: RunCoverageGap[]): string | null {
  if (gaps.length === 0) return null;
  if (gaps.every((g) => g.reason === 'restarted')) return 'Coverage incomplete: the backend restarted during the run';
  if (gaps.every((g) => g.reason === 'unreachable'))
    return 'Coverage incomplete: the backend was unreachable at the end of the run';
  return 'Coverage incomplete: a backend restarted or was unreachable';
}

/** What one origin's gap loses, one sentence; `formatTime` writes the restart's time. */
export function coverageGapDetail(gap: RunCoverageGap, formatTime: (iso: string) => string): string {
  if (gap.reason === 'unreachable') {
    return `${gap.origin} was unreachable at the end of the run: only the lines the tests ran are kept, not what it ran outside a request.`;
  }
  const when = gap.at ? ` at about ${formatTime(gap.at)}` : '';
  return `${gap.origin} restarted${when}: the lines the tests ran are kept; what it ran outside a request before the restart is missing.`;
}

/** The notes a file's view shows: those about its marks, not about the commit's totals. */
export function fileViewNotes(notes: CoverageDataNote[]): CoverageDataNote[] {
  return notes.filter((n) => n.kind !== 'no-inventory' && n.kind !== 'scope-changed');
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

/** What a link between the coverage screens carries over: the pinned commit, the branch and the area. */
export interface CoverageLinkContext {
  commit?: string | null;
  branch?: string | null;
  area?: string | null;
}

/** A link to the coverage page with `query`, the commit, branch and area of `context` kept. */
export function coverageLink(
  projectId: number,
  context: CoverageLinkContext,
  query: Record<string, string | undefined> = {},
): { path: string; query: Record<string, string | undefined> } {
  return {
    path: `/projects/${projectId}/coverage`,
    query: {
      commit: context.commit || undefined,
      branch: context.branch || undefined,
      area: context.area || undefined,
      ...query,
    },
  };
}

/** A file's view, marked by the suites that ran each line, at the same commit, branch and area. */
export function coverageFileLink(projectId: number, context: CoverageLinkContext, path: string) {
  return coverageLink(projectId, context, { file: path, marks: 'suites' });
}

/** The open folders with `folder` and its parents added, the saved ones kept in their order. */
export function withLineage(open: string[], folder: string): string[] {
  const missing = folderTrail(folder)
    .map((part) => part.path)
    .filter((path) => !open.includes(path));
  return missing.length ? [...open, ...missing] : open;
}

/** Where a selection stands among a file's ranges of lines not run: the one it is in, and those before and after it. */
export interface RangeSteps {
  /** The index of the range the selection starts in; null when it is in none. */
  index: number | null;
  previous: LineRange | null;
  next: LineRange | null;
}

/** Step through normalized ranges from a selection: without one, the first range is next. */
export function rangeSteps(ranges: LineRange[], selection: LineRange | null): RangeSteps {
  const index = selection ? ranges.findIndex(([start, end]) => start <= selection[0] && selection[0] <= end) : -1;
  const after = selection ? selection[1] : 0;
  const before = selection ? selection[0] : 0;
  return {
    index: index < 0 ? null : index,
    previous: selection ? ([...ranges].reverse().find(([, end]) => end < before) ?? null) : null,
    next: ranges.find(([start]) => start > after) ?? null,
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

/** Areas as the settings form writes them: one per line, `name: pattern, pattern`. */
export function areasText(areas: Array<{ name: string; include: string[] }> | null | undefined): string {
  return (areas ?? []).map((a) => `${a.name}: ${a.include.join(', ')}`).join('\n');
}

/**
 * Areas read back from the settings form's text: blank lines and `#`
 * comments skipped. An error names the first line that is not `name: patterns`.
 */
export function parseAreasText(
  text: string,
): { areas: Array<{ name: string; include: string[] }> } | { error: string } {
  const areas: Array<{ name: string; include: string[] }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    const name = colon < 0 ? '' : line.slice(0, colon).trim();
    const include = (colon < 0 ? '' : line.slice(colon + 1))
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!name || include.length === 0) return { error: `Line ${i + 1}: write the area as “name: pattern, pattern”.` };
    areas.push({ name, include });
  }
  return { areas };
}

/** Patterns as the settings form writes them, one per line; and read back, blank lines dropped. */
export function patternsText(patterns: string[] | null | undefined): string {
  return (patterns ?? []).join('\n');
}
export function parsePatternsText(text: string): string[] {
  return text
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
}
