/**
 * Why a test did not run, as the one sentence its execution page leads with in
 * the Most likely row: the test that blocked it in its group or in a project its
 * project depends on, or where the run stopped, from the reason the reporter
 * recorded. A blocker is a part that links to its execution. The note says where
 * the fact comes from (Playwright reports a run cutoff) or what a failed
 * `beforeAll` or a failed project dependency does to the tests after it.
 *
 * Pure: the handler passes the blocking execution and the run's failed count it
 * already loads, so the server, the demo and the MCP tools say the same.
 */
import type { SituationPart } from '#shared/situation';

export interface DidNotRunExplanation {
  /** The sentence as plain text, for a reader without the page. */
  text: string;
  /** The sentence as parts; the blocking test links to its execution. */
  parts: SituationPart[];
  /** One meta line under the sentence, or null. */
  note: string | null;
}

export interface DidNotRunInput {
  /**
   * The reporter's reason: `previous-failure`, `dependency-failure`, `max-failures`, `global-timeout`, `interrupted`,
   * or none.
   */
  reason: string | null | undefined;
  /** The failing execution of the same run that blocked this one, and where it failed when outside its body. */
  blockedByCase?: { id: number; title: string; failedIn?: { hook: string } | null } | null;
  /** How many tests failed in the run, for the max-failures sentence. */
  runFailedTests?: number | null;
}

/** Playwright reports a run cutoff; Piwi only records it. */
const CUTOFF_NOTE = 'Reported by Playwright';

/** The failed hook or fixture as the sentence names it: "the beforeAll hook", `the "db" fixture`. */
function hookName(hook: string): string {
  if (/^(?:before|after)(?:Each|All)$/.test(hook)) return `the ${hook} hook`;
  const named = /^(hook|fixture) "(.+)"$/.exec(hook);
  if (named) return `the "${named[2]}" ${named[1]}`;
  return `the ${hook}`;
}

function explanation(parts: SituationPart[], note: string | null): DidNotRunExplanation {
  return { text: parts.map((p) => p.text).join(''), parts, note };
}

const text = (t: string): SituationPart => ({ kind: 'text', text: t });

/** The blocking test as a part of the sentence, linking to its execution. */
function blockerPart(blocker: { id: number; title: string }): SituationPart {
  return { kind: 'test', text: blocker.title, id: blocker.id, href: `/test-run-cases/${blocker.id}` };
}

/** The sentence and its note for one did-not-run execution. */
export function describeDidNotRun(input: DidNotRunInput): DidNotRunExplanation {
  const blocker = input.blockedByCase ?? null;
  switch (input.reason) {
    case 'previous-failure': {
      if (!blocker) return explanation([text('Skipped because an earlier test in its serial group failed.')], null);
      const test = blockerPart(blocker);
      const hook = blocker.failedIn?.hook;
      if (hook) {
        return explanation(
          [text(`Skipped because ${hookName(hook)} failed while running `), test, text('.')],
          hook === 'beforeAll' ? 'When a beforeAll hook fails, Playwright skips the rest of its group.' : null,
        );
      }
      return explanation([text('Skipped after '), test, text(' failed earlier in the same serial group.')], null);
    }
    case 'dependency-failure': {
      const note = 'When a project fails, Playwright runs no test of the projects that depend on it.';
      if (!blocker)
        return explanation([text("Skipped because a project this test's project depends on failed.")], note);
      return explanation(
        [text('Skipped because '), blockerPart(blocker), text(" failed in a project this test's project depends on.")],
        note,
      );
    }
    case 'max-failures': {
      const count = input.runFailedTests ?? 0;
      const failed = count > 0 ? ` (${count} failed)` : '';
      return explanation(
        [text(`The run reached its maximum number of failures${failed} and stopped before this test started.`)],
        CUTOFF_NOTE,
      );
    }
    case 'global-timeout':
      return explanation([text('The run hit its global timeout before this test could start.')], CUTOFF_NOTE);
    case 'interrupted':
      return explanation(
        [text('The run was interrupted before this test could start (a worker crashed or it was cancelled).')],
        CUTOFF_NOTE,
      );
    default:
      return explanation([text('This test did not run; the reporter recorded no reason.')], null);
  }
}
