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
 * (`ERROR_LINES`), else the first line printed on stderr; null when there is none.
 */
export function runOutputFirstError(lines: readonly RunOutputLine[]): RunOutputLine | null {
  for (const kind of ERROR_LINES) {
    const line = lines.find((each) => kind.test(each.text));
    if (line) return line;
  }
  return lines.find((line) => line.error) ?? null;
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
