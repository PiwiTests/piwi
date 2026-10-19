/**
 * The names a file's import statements bind, read with the scanner of `page-candidates.ts`, the import lines a
 * rendering needs that a file lacks, and the edit that adds them after the file's import statements.
 */
import type { FileEdit } from '../protocol.js';
import { tokenize, type Token } from './page-candidates.js';

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === 'punct' && token.text === text;
}

function isName(token: Token | undefined, text?: string): boolean {
  return token?.kind === 'name' && (text === undefined || token.text === text);
}

/**
 * The local names the import statements at the top level of a file bind: a default import, `* as NS`, each named
 * import under its local name (`B` for `A as B`, `D` for `type D`), with or without `import type`, and the name of
 * `import X = require('…')`. `import '…'` binds none, and neither do `import(…)`, `import.meta` and `require`.
 */
export function importedNames(text: string): Set<string> {
  const tokens = tokenize(text);
  const names = new Set<string>();
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'punct' && OPENERS.has(t.text)) depth++;
    else if (t.kind === 'punct' && CLOSERS.has(t.text)) depth = Math.max(0, depth - 1);
    if (depth > 0 || !isName(t, 'import') || isPunct(tokens[i - 1], '.') || isPunct(tokens[i - 1], '?.')) continue;
    let j = i + 1;
    if (isPunct(tokens[j], '(') || isPunct(tokens[j], '.')) continue;
    // `import type { A }`, `import type A from`, `import type * as NS`; but `import type from '…'` imports `type`.
    if (isName(tokens[j], 'type') && (isPunct(tokens[j + 1], '{') || isPunct(tokens[j + 1], '*'))) j++;
    else if (isName(tokens[j], 'type') && isName(tokens[j + 1]) && !isName(tokens[j + 1], 'from')) j++;
    if (isName(tokens[j]) && !isName(tokens[j], 'from')) {
      names.add(tokens[j]!.text);
      j++;
      if (!isPunct(tokens[j], ',')) continue;
      j++;
    }
    if (isPunct(tokens[j], '*') && isName(tokens[j + 1], 'as') && isName(tokens[j + 2])) {
      names.add(tokens[j + 2]!.text);
    } else if (isPunct(tokens[j], '{')) {
      // Each member's local name is its last token: `a`, `a as b`, `type d`, `'x-y' as z`, `default as e`.
      let last: Token | undefined;
      for (j++; j < tokens.length && !isPunct(tokens[j], '}'); j++) {
        if (isPunct(tokens[j], ',')) {
          if (isName(last)) names.add(last!.text);
          last = undefined;
        } else {
          last = tokens[j];
        }
      }
      if (isName(last)) names.add(last!.text);
      i = j;
    }
  }
  return names;
}

/**
 * The import lines whose names `text` does not bind yet, in their order: a line binding a name the file's imports
 * lack is kept whole. A line that binds no name is kept.
 */
export function missingImports(text: string, lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  const bound = importedNames(text);
  return lines.filter((line) => {
    const names = [...importedNames(line)];
    return names.length === 0 || names.some((name) => !bound.has(name));
  });
}

/**
 * The index of the last token of the import statement whose `import` is `tokens[start]`: its module specifier, then
 * its import attributes (`with { … }`, `assert { … }`) and its `;`. Null when no module ends it before a `;` or the
 * next `import`, as in `import A = B.C` or code cut short.
 */
function statementEnd(tokens: Token[], start: number): number | null {
  let module: number | null = null;
  if (tokens[start + 1]?.kind === 'string') {
    module = start + 1;
  } else {
    let depth = 0;
    for (let j = start + 1; j < tokens.length && module === null; j++) {
      const t = tokens[j]!;
      if (t.kind === 'punct' && OPENERS.has(t.text)) depth++;
      else if (t.kind === 'punct' && CLOSERS.has(t.text)) depth--;
      if (depth > 0) continue;
      if (isPunct(t, ';') || isName(t, 'import')) return null;
      if (isName(t, 'from') && tokens[j + 1]?.kind === 'string') module = j + 1;
      else if (
        isName(t, 'require') &&
        isPunct(tokens[j + 1], '(') &&
        tokens[j + 2]?.kind === 'string' &&
        isPunct(tokens[j + 3], ')')
      ) {
        module = j + 3;
      }
    }
  }
  if (module === null) return null;
  let end = module;
  if ((isName(tokens[end + 1], 'with') || isName(tokens[end + 1], 'assert')) && isPunct(tokens[end + 2], '{')) {
    for (let k = end + 3, depth = 1; k < tokens.length; k++) {
      if (isPunct(tokens[k], '{')) depth++;
      else if (isPunct(tokens[k], '}') && --depth === 0) {
        end = k;
        break;
      }
    }
  }
  return isPunct(tokens[end + 1], ';') ? end + 1 : end;
}

/**
 * Where each import statement at the top level of a file ends, as an offset in `text`, in order: `import … from '…'`,
 * `import '…'` and `import X = require('…')`, over one line or several. `import(…)` and `import.meta` are not
 * statements.
 */
export function importStatementEnds(text: string): number[] {
  const tokens = tokenize(text);
  const ends: number[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'punct' && OPENERS.has(t.text)) depth++;
    else if (t.kind === 'punct' && CLOSERS.has(t.text)) depth = Math.max(0, depth - 1);
    if (depth > 0 || !isName(t, 'import') || isPunct(tokens[i - 1], '.') || isPunct(tokens[i - 1], '?.')) continue;
    if (isPunct(tokens[i + 1], '(') || isPunct(tokens[i + 1], '.')) continue;
    const end = statementEnd(tokens, i);
    if (end === null) continue;
    ends.push(tokens[end]!.end);
    i = end;
  }
  return ends;
}

const LINE_BREAK = /\r\n|\r|\n/g;

/** The 0-based line and character of `offset` in `text`, as the language server protocol counts them. */
function positionAt(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let start = 0;
  LINE_BREAK.lastIndex = 0;
  for (let m = LINE_BREAK.exec(text); m && m.index < offset; m = LINE_BREAK.exec(text)) {
    line++;
    start = m.index + m[0].length;
  }
  return { line, character: offset - start };
}

function insertion(at: { line: number; character: number }, newText: string): FileEdit {
  return { range: { start: at, end: at }, newText };
}

/**
 * The edit that adds `lines`, import lines a file lacks, to its text, each once: on the lines after its last top-level
 * import statement, else at its top, followed by an empty line unless the file starts with one; null when there is
 * none to add.
 */
export function importInsertion(text: string, lines: readonly string[]): FileEdit | null {
  const missing = [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
  if (!missing.length) return null;
  const block = missing.join('\n');
  const ends = importStatementEnds(text);
  const last = ends[ends.length - 1];
  if (last === undefined) {
    const first = text.split(/\r\n|\r|\n/, 1)[0] ?? '';
    return insertion({ line: 0, character: 0 }, `${block}\n${text && !first.trim() ? '' : '\n'}`);
  }
  const lineEnd = text.slice(last).search(/\r\n|\r|\n/);
  if (lineEnd < 0) return insertion(positionAt(text, text.length), `\n${block}`);
  return insertion({ line: positionAt(text, last).line + 1, character: 0 }, `${block}\n`);
}
