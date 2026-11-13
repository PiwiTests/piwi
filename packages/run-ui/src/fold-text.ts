/**
 * Text folded for search: lower case with the accents taken off, so `resume`,
 * `Résumé` and `RÉSUMÉ` compare equal. Every search box compares what is typed
 * with what is listed through this fold: in memory with `foldText`, in SQL with
 * `foldedContains` / `foldedEquals` (the dashboard's `shared/utils/fold-text-sql.ts`).
 */

const NON_ASCII = /[\u0080-\uffff]/;

/** The combining accents a canonical decomposition splits off a letter (`é` → `e` + U+0301). */
const COMBINING_ACCENTS = /[\u0300-\u036f]/g;

/**
 * Letters whose mark no decomposition splits off (a stroke, a missing dot), and
 * the final sigma, which `toLowerCase` picks by position in the word.
 */
const LETTER_ALIASES: Record<string, string> = { ø: 'o', ł: 'l', đ: 'd', ħ: 'h', ı: 'i', ς: 'σ' };
const LETTER_ALIAS = /[øłđħıς]/g;

/** `text` in lower case, without its accents. */
export function foldText(text: string): string {
  const lower = text.toLowerCase();
  if (!NON_ASCII.test(lower)) return lower;
  return lower
    .normalize('NFD')
    .replace(COMBINING_ACCENTS, '')
    .replace(LETTER_ALIAS, (letter) => LETTER_ALIASES[letter]!)
    .normalize('NFC');
}

/**
 * A folded text that remembers where each of its characters came from: the
 * folded character at `i` stands for `original.slice(starts[i], ends[i])`, so a
 * match found in the folded text can be marked in the original.
 */
export interface FoldedText {
  text: string;
  starts: number[];
  ends: number[];
}

/** One character as it is read: a base character with the marks that follow it. */
const CHARACTER = /\P{M}\p{M}*|\p{M}+/gu;

export function foldTextWithOffsets(text: string): FoldedText {
  const out: FoldedText = { text: '', starts: [], ends: [] };
  for (const match of text.matchAll(CHARACTER)) {
    const folded = foldText(match[0]);
    const end = match.index + match[0].length;
    for (let i = 0; i < folded.length; i++) {
      out.starts.push(match.index);
      out.ends.push(end);
    }
    out.text += folded;
  }
  return out;
}
