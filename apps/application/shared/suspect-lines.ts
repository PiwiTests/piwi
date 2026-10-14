/**
 * Suspect lines, as the dashboard answers them: the lines changed since the
 * last green run that a failure's tests executed, ranked by how many passing
 * tests executed them too (`@piwitests/core/suspect-lines`). Shared by the
 * server endpoints, their demo mirror, the AI diagnosis context and the fix
 * plan, so every surface states them the same way.
 */
import { encodeLineRanges } from '@piwitests/core/coverage';
import type { SuspectLine, SuspectLinesSummary } from '@piwitests/core/suspect-lines';

export type { SuspectLine, SuspectLinesSummary } from '@piwitests/core/suspect-lines';

/**
 * Why there are no suspect lines to compute:
 *
 * - `not-failing`: the execution did not fail;
 * - `no-coverage`: the failing executions recorded no coverage;
 * - `no-baseline`: no passing run to compare with, or no commit recorded on it or on the failing run;
 * - `no-scm`: no repository to read, no provider for it, or the provider could not give the range's patches;
 * - `no-changes`: the range changes no line (the same commit on both sides, or no line on the head side).
 */
export type SuspectLinesReason = 'not-failing' | 'no-coverage' | 'no-baseline' | 'no-scm' | 'no-changes';

/** The suspect lines of one execution. */
export interface SuspectLinesAnswer {
  /** Whether the changed lines were joined with the coverage; false with a `reason` otherwise. */
  available: boolean;
  reason?: SuspectLinesReason;
  /** The commits compared, full SHAs: the last green run's, then the failing run's (the head). */
  range?: { from: string; to: string };
  /** The last green run the range starts at. */
  baselineRunId?: number;
  summary: SuspectLinesSummary;
  /** Most suspect first, at most 50. */
  suspects: SuspectLine[];
}

/** The suspect lines of a failure cluster. */
export interface ClusterSuspectLinesAnswer extends SuspectLinesAnswer {
  /** The newest run in which the cluster has failing executions with coverage; null when there is none. */
  runId: number | null;
}

/** Suspects the fix plan carries. */
const FIX_PLAN_SUSPECTS = 5;

/** A cluster's answer cut to the suspects a fix plan carries. */
export function fixPlanSuspectLines(answer: ClusterSuspectLinesAnswer): ClusterSuspectLinesAnswer {
  return { ...answer, suspects: answer.suspects.slice(0, FIX_PLAN_SUSPECTS) };
}

/** A summary with nothing counted, for an answer that could not join anything. */
function emptySuspectSummary(): SuspectLinesSummary {
  return {
    changedFiles: 0,
    changedLines: 0,
    hunks: 0,
    executedHunks: 0,
    executedLines: 0,
    failingWithCoverage: 0,
    passingWithCoverage: 0,
  };
}

/** The answer when suspect lines cannot be computed, with the range when it is known. */
export function unavailableSuspectLines(
  reason: SuspectLinesReason,
  known: Pick<SuspectLinesAnswer, 'range' | 'baselineRunId'> = {},
): SuspectLinesAnswer {
  return { available: false, reason, ...known, summary: emptySuspectSummary(), suspects: [] };
}

/** Why the answer is unavailable, as a clause: "the failing tests recorded no coverage". */
export function suspectLinesReasonText(reason: SuspectLinesReason): string {
  switch (reason) {
    case 'not-failing':
      return 'the execution did not fail';
    case 'no-coverage':
      return 'the failing tests recorded no coverage';
    case 'no-baseline':
      return 'there is no passing run with a commit to compare with';
    case 'no-scm':
      return 'the changes of the range could not be read from the repository';
    case 'no-changes':
      return 'the range changes no line';
  }
}

/** A suspect's file and lines: "`src/Basket.cs` 57-59". */
function suspectLocation(suspect: Pick<SuspectLine, 'path' | 'lines'>): string {
  return `\`${suspect.path}\` ${encodeLineRanges(suspect.lines).replace(/,/g, ', ')}`;
}

/**
 * One suspect as a Markdown list item:
 * "- `src/Basket.cs` 57-59: executed lines, 1 failing test, 2 passing tests, score 0.58".
 */
export function suspectLineMarkdown(suspect: SuspectLine): string {
  const evidence =
    suspect.granularity === 'lines'
      ? 'executed lines'
      : suspect.granularity === 'functions'
        ? 'changed lines in a function that ran'
        : 'file reached, whole hunk';
  const failing = `${suspect.failing} failing test${suspect.failing === 1 ? '' : 's'}`;
  const passing = `${suspect.passing} passing test${suspect.passing === 1 ? '' : 's'}`;
  return `- ${suspectLocation(suspect)} (${suspect.runtime}): ${evidence}, ${failing}, ${passing}, score ${suspect.score.toFixed(2)}`;
}

/**
 * The sentence that opens a list of suspects: "Of 13 changed lines in 4 files
 * (`a1b2c3d..e4f5a6b`), the failing tests executed 3 (1 of 5 hunks)."
 */
export function suspectLinesLead(answer: SuspectLinesAnswer): string {
  const { summary } = answer;
  const range = answer.range ? ` (\`${answer.range.from.slice(0, 7)}..${answer.range.to.slice(0, 7)}\`)` : '';
  const files = `${summary.changedFiles} file${summary.changedFiles === 1 ? '' : 's'}`;
  const changed = `${summary.changedLines} changed line${summary.changedLines === 1 ? '' : 's'} in ${files}${range}`;
  if (summary.executedHunks === 0) return `The failing tests executed none of the ${changed}.`;
  const lines =
    summary.executedLines > 0 ? `${summary.executedLines} line${summary.executedLines === 1 ? '' : 's'} in ` : '';
  return `Of ${changed}, the failing tests executed ${lines}${summary.executedHunks} of ${summary.hunks} hunk${summary.hunks === 1 ? '' : 's'}.`;
}

/** Suspects listed in the AI context at most. */
export const CONTEXT_SUSPECTS = 10;

/** Changed files with the files of the suspects first, in suspect order, then the rest in their order. */
export function suspectFilesFirst<T extends { filename: string }>(files: T[], suspects: Array<{ path: string }>): T[] {
  const rank = new Map<string, number>();
  for (const suspect of suspects) if (!rank.has(suspect.path)) rank.set(suspect.path, rank.size);
  const first = files.filter((f) => rank.has(f.filename)).sort((a, b) => rank.get(a.filename)! - rank.get(b.filename)!);
  return [...first, ...files.filter((f) => !rank.has(f.filename))];
}

/**
 * The AI context's "Changed Lines the Failing Tests Executed" section: the
 * summary and the top suspects, at most {@link CONTEXT_SUSPECTS}.
 */
export function suspectLinesSection(answer: ClusterSuspectLinesAnswer): string {
  const { summary } = answer;
  const shown = answer.suspects.slice(0, CONTEXT_SUSPECTS);
  const failing = `${summary.failingWithCoverage} failing execution${summary.failingWithCoverage === 1 ? '' : 's'}`;
  const passing = `${summary.passingWithCoverage} passing execution${summary.passingWithCoverage === 1 ? '' : 's'}`;
  const run = answer.runId != null ? ` of run #${answer.runId}` : '';
  const lines = [
    '## Changed Lines the Failing Tests Executed',
    suspectLinesLead(answer),
    `- Coverage${run}: ${failing}, ${passing} of the same run.`,
  ];
  if (shown.length > 0) {
    lines.push(
      '- Ranked by evidence (executed lines, then a function that ran, then the file reached), then by how few passing executions ran the same lines (Ochiai score, 1 when only failing executions ran them). The patches of these files come first in the changed files below.',
      '',
      ...shown.map(suspectLineMarkdown),
    );
    const more = summary.executedHunks - shown.length;
    if (more > 0) lines.push(`- … and ${more} more executed hunk${more === 1 ? '' : 's'}`);
  }
  return lines.join('\n');
}
