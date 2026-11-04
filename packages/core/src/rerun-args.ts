/**
 * The Playwright arguments of a CI re-run, as the dashboard hands them to a job: one string in which each argument
 * is double-quoted (`"tests/login.spec.ts:10" --project="chromium"`). A job reads them from `PIWI_RERUN_ARGS` and
 * splits them back into words with {@link splitRerunArgs}, without a shell.
 */

/** The environment variable a CI job receives the re-run's Playwright arguments in. */
export const RERUN_ARGS_ENV = 'PIWI_RERUN_ARGS';

const WHITESPACE = /\s/;

/**
 * The words of `text`, split as a shell splits double-quoted arguments with no escapes: whitespace outside quotes
 * separates words, a pair of double quotes keeps what it holds as it is (whitespace included), and quoted and bare
 * parts that touch make one word (`--project="chromium"` is `--project=chromium`). Nothing is expanded: `$`, `` ` ``
 * and `\` are plain characters. Throws on a quote left open.
 */
export function splitRerunArgs(text: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quoted = false;
  for (const ch of text) {
    if (quoted) {
      if (ch === '"') quoted = false;
      else word += ch;
    } else if (ch === '"') {
      quoted = true;
      inWord = true;
    } else if (WHITESPACE.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quoted) throw new Error('a double quote is not closed');
  if (inWord) words.push(word);
  return words;
}
