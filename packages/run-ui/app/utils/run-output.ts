/**
 * A run's output as both hosts keep it (the dashboard's Local runs, Piwi Runner's runs) and as the output pane
 * (`DesktopRunOutputPane`) shows it: one entry a line, numbered from 1 in its run, so a pane follows the newest line
 * while its run keeps only its last ones. Plain TypeScript, imported by name (`@piwitests/run-ui/run-output`).
 */
import { foldText } from '../../src/fold-text';
import { stripAnsi } from './ansi';

export interface RunOutputLine {
  /** The line's number in its run, from 1: its key while the run keeps its last lines. */
  id: number;
  /** The line without its ANSI color codes. */
  text: string;
  /** Printed on stderr, or written by the app about the run. */
  error: boolean;
  /** The line as printed, ANSI color codes included; only on a line that has them and has text. */
  ansi?: string;
}

/** The line numbered `id`, as the process printed it. */
export function runOutputLine(id: number, printed: string, error: boolean): RunOutputLine {
  const text = stripAnsi(printed);
  return text === printed || !text ? { id, text, error } : { id, text, error, ansi: printed };
}

/**
 * The lines that read as an error, the most telling first: a failure Playwright's list and line reporters number with
 * its error (`  1) [chromium] › …`), a thrown error's first line, a failed test's result line (`  ✘  1 [chromium] › …`).
 */
const ERROR_LINES = [/^\s*\d+\) /, /^\s*\w*Error: /, /^\s*[✘✗]\s/];

/**
 * The line the pane's **Go to the first error** scrolls to: the first line of the most telling kind the output holds
 * (`ERROR_LINES`); null when there is none. A line on stderr alone is no error: a web server, `npx` and a reporter warn
 * there.
 */
export function runOutputFirstError(lines: readonly RunOutputLine[]): RunOutputLine | null {
  for (const kind of ERROR_LINES) {
    const line = lines.find((each) => kind.test(each.text));
    if (line) return line;
  }
  return null;
}

/** The lines holding `query`, case and accents ignored; every line for a blank query. */
export function runOutputMatching(lines: readonly RunOutputLine[], query: string): readonly RunOutputLine[] {
  const folded = foldText(query.trim());
  if (!folded) return lines;
  return lines.filter((line) => foldText(line.text).includes(folded));
}

/** What **Copy output** copies: every line kept, without colors. */
export function runOutputText(lines: readonly RunOutputLine[]): string {
  return lines.map((line) => line.text).join('\n');
}

/** How a test came out, as Playwright's end-of-run summary or its list reporter names it. */
export type RunOutputStatus = 'passed' | 'failed' | 'flaky' | 'skipped' | 'interrupted' | 'did-not-run';

/** One test the output names, at the place its result line or its summary put it. */
export interface RunOutputResult {
  status: RunOutputStatus;
  /** Its Playwright project; null for a config with no named project. */
  project: string | null;
  /** Its file, as Playwright prints it: relative to the folder it runs in, the config's for a run the shell starts. */
  file: string;
  line: number;
  column: number;
  /** Its titles, its describe blocks first, joined with ` › `. */
  title: string;
  /** The first lines of its first error, up to its code frame; empty when the output shows none. */
  error: string[];
}

/** What Playwright's end-of-run summary counts, each step's summed. */
export type RunOutputCounts = Record<RunOutputStatus, number>;

/** A run's results as its output tells them: what its summaries counted, and each test they or its result lines name. */
export interface RunOutputSummary {
  counts: RunOutputCounts;
  /** Failed, flaky and interrupted tests first, in the order the summaries list them, then passed and skipped ones. */
  results: RunOutputResult[];
}

/** `[chromium] › tests/cart.spec.ts:4:3 › cart › applies a coupon`, the project optional, a trailing rule left out. */
const TEST_PLACE = /^(?:\[([^\]]+)\] › )?(.+?):(\d+):(\d+) › (.+?)(?: ─+)?$/;
/** A numbered failure: `  1) <place>`. */
const FAILURE_HEAD = /^\s*\d+\) (.+)$/;
/** A summary's section: `  2 failed`, `  1 passed (2.5s)`. */
const SUMMARY_HEAD = /^\s{2}(\d+) (passed|failed|flaky|skipped|interrupted|did not run)(?: \(.+\))?$/;
/**
 * A list reporter's result line: `  ✓  1 [chromium] › <place> (5ms)`, a retry's marked `(retry #1)`; `ok` and `x` on a
 * Windows console that shows no UTF-8 marks.
 */
const RESULT_LINE = /^\s{2}(✓|✘|ok|x|-)\s+\d+ (.+?)(?: \(retry #\d+\))?(?: \([\d.]+(?:ms|s|m|h)\))?$/;
/**
 * A code frame's line (`    > 4 |   test(…)`), a stack line, a retry's rule or the line reporter's next test
 * (`[16/20] …`): where an error's message ends.
 */
const ERROR_END = /^\s*(?:>?\s*\d+ \||\|\s|at |Error Context: |Retry #\d+|\[\d+\/\d+\] )/;
/** At most this many lines of an error. */
const ERROR_LINES_MAX = 4;

/** Where a test is and what it is called, as the output prints it. */
type TestPlace = Omit<RunOutputResult, 'status' | 'error'>;

function placeOf(text: string): TestPlace | null {
  const match = TEST_PLACE.exec(text.trim());
  if (!match) return null;
  const [, project, file, line, column, title] = match;
  return { project: project ?? null, file: file!, line: Number(line), column: Number(column), title: title! };
}

const placeKey = (place: TestPlace) =>
  `${place.project ?? ''}|${place.file}:${place.line}:${place.column}|${place.title}`;

/**
 * Whether a numbered failure is of the test `test`: same project and place, and its title, or its title followed by the
 * step the test failed in (`checkout completes › Pay`), which a failure's header adds. Tests a loop declares share
 * their place and differ by their titles.
 */
function isFailureOf(failure: TestPlace, test: TestPlace): boolean {
  return (
    failure.project === test.project &&
    failure.file === test.file &&
    failure.line === test.line &&
    failure.column === test.column &&
    (failure.title === test.title || failure.title.startsWith(`${test.title} › `))
  );
}

/** The message lines of the error that starts after line `from`: its first lines, up to its code frame or stack. */
function errorAfter(lines: readonly RunOutputLine[], from: number): string[] {
  const texts: string[] = [];
  for (let i = from + 1; i < lines.length; i++) {
    const text = lines[i]!.text;
    if (FAILURE_HEAD.test(text) || SUMMARY_HEAD.test(text)) break;
    texts.push(text);
  }
  return runErrorLines(texts);
}

/**
 * The first lines of an error's message, as a run's results show it: its non-blank lines up to its code frame, its
 * stack or a retry's rule, at most four, trimmed, colors taken off. One rule for an error Playwright printed and one a
 * Piwi run stored.
 */
export function runErrorLines(error: string | readonly string[]): string[] {
  const texts = typeof error === 'string' ? stripAnsi(error).split('\n') : error.map((text) => stripAnsi(text));
  const lines: string[] = [];
  for (const text of texts) {
    if (lines.length >= ERROR_LINES_MAX) break;
    if (ERROR_END.test(text)) {
      if (lines.length > 0) break;
      continue;
    }
    if (text.trim()) lines.push(text.trim());
  }
  return lines;
}

/** A test of a finished run as its results list shows it (`DesktopRunResults`). */
export interface RunResultRow {
  key: string;
  /** How it came out; `unknown` when the output does not say. */
  status: RunOutputStatus | 'unknown';
  title: string;
  /** Where it is, `file:line`; null when unknown. */
  place: string | null;
  /** Its Playwright project, which tells apart a test run in several browsers; null when none is named. */
  project: string | null;
  /** The first lines of its first error (`runErrorLines`). */
  error: readonly string[];
}

/**
 * What a run's output says of its tests, read from what Playwright prints with its list, line and dot reporters: the
 * counts of each end-of-run summary, summed over a run of several steps, the failed, flaky and interrupted tests they
 * list, each with the first lines of its first error, then the tests the list reporter's result lines say passed or were
 * skipped. Null when the output holds no summary: the run did not get that far, or a reporter printed none.
 */
export function runOutputSummary(lines: readonly RunOutputLine[]): RunOutputSummary | null {
  const counts: RunOutputCounts = { passed: 0, failed: 0, flaky: 0, skipped: 0, interrupted: 0, 'did-not-run': 0 };
  const failures: Array<{ place: TestPlace; error: string[] }> = [];
  const listed = new Map<string, RunOutputResult>();
  const outcomes = new Map<string, { status: 'passed' | 'skipped'; place: TestPlace }>();
  let summarized = false;
  let section: RunOutputStatus | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text;
    const head = SUMMARY_HEAD.exec(text);
    if (head) {
      summarized = true;
      section = head[2] === 'did not run' ? 'did-not-run' : (head[2] as RunOutputStatus);
      counts[section] += Number(head[1]);
      continue;
    }
    if (section && /^\s{4}\S/.test(text)) {
      const place = placeOf(text);
      // A test repeated (`--repeat-each`), or failing in several steps, is listed once.
      if (place && section !== 'passed' && section !== 'skipped' && !listed.has(placeKey(place))) {
        const error = failures.find((failure) => isFailureOf(failure.place, place))?.error ?? [];
        listed.set(placeKey(place), { status: section, ...place, error });
      }
      continue;
    }
    section = null;
    const failure = FAILURE_HEAD.exec(text);
    const failed = failure && placeOf(failure[1]!);
    if (failed) {
      failures.push({ place: failed, error: errorAfter(lines, i) });
      continue;
    }
    const result = RESULT_LINE.exec(text);
    const place = result && placeOf(result[2]!);
    if (result && place) {
      const key = placeKey(place);
      if (result[1] === '✓' || result[1] === 'ok') outcomes.set(key, { status: 'passed', place });
      else if (result[1] === '-') outcomes.set(key, { status: 'skipped', place });
      else outcomes.delete(key);
    }
  }
  if (!summarized) return null;
  // A numbered failure no summary lists (a summary that names no test) failed all the same.
  for (const { place, error } of failures) {
    const key = placeKey(place);
    if (listed.has(key) || outcomes.has(key)) continue;
    if ([...listed.values()].some((test) => isFailureOf(place, test))) continue;
    listed.set(key, { status: 'failed', ...place, error });
  }
  // The list reporter marks a skipped test and one a serial group did not run alike: the counts tell which it was.
  const unmarked: RunOutputStatus = counts.skipped === 0 && counts['did-not-run'] > 0 ? 'did-not-run' : 'skipped';
  const others = [...outcomes.entries()]
    .filter(([key]) => !listed.has(key))
    .map(([, { status, place }]): RunOutputResult => ({
      status: status === 'skipped' ? unmarked : status,
      ...place,
      error: [],
    }));
  return { counts, results: [...listed.values(), ...others] };
}
