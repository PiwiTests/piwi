/**
 * What a file loads from modules, read with the scanner of `page-candidates.ts`: its import statements and its
 * top-level `require` declarations, the names they bind, the modules its `test` and `expect` come from, the import
 * lines a rendering needs that the file lacks, and the edit that adds them after the file's import statements, or, in
 * a file that loads its modules with `require`, as `require` declarations after the last of them.
 */
import type { FileEdit } from '../protocol.js';
import { tokenize, type Token } from './page-candidates.js';

/** The module Playwright's `test` and `expect` come from. */
export const PLAYWRIGHT_TEST = '@playwright/test';

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === 'punct' && token.text === text;
}

function isName(token: Token | undefined, text?: string): boolean {
  return token?.kind === 'name' && (text === undefined || token.text === text);
}

/** A name a module statement binds. */
export interface BoundName {
  /** The export it takes: `default` for a default import, `*` for a namespace or a whole module, else its name. */
  imported: string;
  local: string;
  /** Bound by `import type`, or as a `type` member: a type, not a value. */
  typeOnly: boolean;
}

/**
 * A statement loading a module at the top level of a file: an import statement (`import … from '…'`, `import '…'`,
 * `import X = require('…')`), a `const`, `let` or `var` declarator from `require('…')` (`const { test, expect } =
 * require('…')`, `const base = require('…')`, `const { test: it } = require('…')`, `const expect =
 * require('…').expect`), or a bare `require('…')`.
 */
export interface ModuleStatement {
  kind: 'import' | 'require';
  module: string;
  names: BoundName[];
  /** The offset the statement ends at: after its `;`, else after its last token. */
  end: number;
}

/** What one tokenization of a file reads: its module statements, in order, and the names they bind. */
export interface ImportBindings {
  statements: ModuleStatement[];
  /** The local names the statements bind. */
  names: Set<string>;
  /** The names of the file's own top-level declarations: `const test = base.extend(…)`, `function test() {}`. */
  declared: Set<string>;
}

/** The `require('…')` call whose `require` is `tokens[i]`: its module and the index of its `)`. */
function requireCall(tokens: Token[], i: number): { module: string; last: number } | null {
  if (!isName(tokens[i], 'require') || !isPunct(tokens[i + 1], '(') || !isPunct(tokens[i + 3], ')')) return null;
  const module = tokens[i + 2];
  return module?.kind === 'string' ? { module: module.text, last: i + 3 } : null;
}

/**
 * The module an import statement starting at `tokens[start]` loads and the index of its last token: its module
 * specifier, then its import attributes (`with { … }`, `assert { … }`) and its `;`. Null when no module ends it before
 * a `;` or the next `import`, as in `import A = B.C` or code cut short.
 */
function statementEnd(tokens: Token[], start: number): { module: string; last: number } | null {
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
      else if (requireCall(tokens, j)) module = j + 2;
    }
  }
  if (module === null) return null;
  let last = tokens[module - 1]?.text === '(' ? module + 1 : module;
  if ((isName(tokens[last + 1], 'with') || isName(tokens[last + 1], 'assert')) && isPunct(tokens[last + 2], '{')) {
    for (let k = last + 3, depth = 1; k < tokens.length; k++) {
      if (isPunct(tokens[k], '{')) depth++;
      else if (isPunct(tokens[k], '}') && --depth === 0) {
        last = k;
        break;
      }
    }
  }
  return { module: tokens[module]!.text, last: isPunct(tokens[last + 1], ';') ? last + 1 : last };
}

/**
 * The import statement whose `import` is `tokens[i]`: a default import, `* as NS`, each named import under its local
 * name (`B` for `A as B`, `D` for `type D`), with or without `import type`, and the alias of `import X = require('…')`,
 * which binds the whole module; `import '…'` binds no name. Null for `import(…)` and `import.meta`, which are not
 * statements, and for a statement no module ends.
 */
function importStatement(tokens: Token[], i: number): ModuleStatement | null {
  let j = i + 1;
  if (isPunct(tokens[j], '(') || isPunct(tokens[j], '.')) return null;
  const end = statementEnd(tokens, i);
  if (!end) return null;
  const names: BoundName[] = [];
  let typeOnly = false;
  // `import type { A }`, `import type A from`, `import type * as NS`; but `import type from '…'` imports `type`.
  if (isName(tokens[j], 'type') && (isPunct(tokens[j + 1], '{') || isPunct(tokens[j + 1], '*'))) {
    typeOnly = true;
    j++;
  } else if (isName(tokens[j], 'type') && isName(tokens[j + 1]) && !isName(tokens[j + 1], 'from')) {
    typeOnly = true;
    j++;
  }
  if (isName(tokens[j]) && !isName(tokens[j], 'from')) {
    names.push({ imported: isPunct(tokens[j + 1], '=') ? '*' : 'default', local: tokens[j]!.text, typeOnly });
    j++;
    if (isPunct(tokens[j], ',')) j++;
  }
  if (isPunct(tokens[j], '*') && isName(tokens[j + 1], 'as') && isName(tokens[j + 2])) {
    names.push({ imported: '*', local: tokens[j + 2]!.text, typeOnly });
  } else if (isPunct(tokens[j], '{')) {
    // A member is its tokens up to a comma: `a`, `a as b`, `type d`, `type d as e`, `'x-y' as z`, `default as e`.
    let member: Token[] = [];
    const add = () => {
      const typed = isName(member[0], 'type') && (member.length === 2 || member.length === 4);
      const rest = typed ? member.slice(1) : member;
      const imported = rest[0];
      const local = rest[rest.length - 1];
      if (imported && isName(local) && (imported.kind === 'name' || imported.kind === 'string')) {
        names.push({ imported: imported.text, local: local!.text, typeOnly: typeOnly || typed });
      }
      member = [];
    };
    for (j++; j < tokens.length && j < end.last && !isPunct(tokens[j], '}'); j++) {
      if (isPunct(tokens[j], ',')) add();
      else member.push(tokens[j]!);
    }
    add();
  }
  return { kind: 'import', module: end.module, names, end: tokens[end.last]!.end };
}

/**
 * The names an object pattern starting at `tokens[open]` binds, with the properties they take (`{ test, expect: e }`),
 * and the index of its `}`. A nested pattern binds nothing here.
 */
function objectPattern(tokens: Token[], open: number): { names: BoundName[]; last: number } {
  const names: BoundName[] = [];
  let depth = 0;
  let j = open + 1;
  for (; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (t.kind === 'punct' && OPENERS.has(t.text)) {
      depth++;
      continue;
    }
    if (t.kind === 'punct' && CLOSERS.has(t.text)) {
      if (depth === 0) break;
      depth--;
      continue;
    }
    if (depth > 0 || (t.kind !== 'name' && t.kind !== 'string')) continue;
    if (!isPunct(tokens[j - 1], '{') && !isPunct(tokens[j - 1], ',')) continue;
    if (isPunct(tokens[j + 1], ':')) {
      if (isName(tokens[j + 2])) names.push({ imported: t.text, local: tokens[j + 2]!.text, typeOnly: false });
    } else if (t.kind === 'name') {
      names.push({ imported: t.text, local: t.text, typeOnly: false });
    }
  }
  return { names, last: j };
}

/**
 * The declarators of the `const`, `let` or `var` at `tokens[keyword]`: each one from `require('…')` is a module
 * statement, each plain name with another initializer or none is a declaration of the file's own. Returns the index of
 * the last token read; an initializer that is not a `require` call is left to the caller.
 */
function declarators(tokens: Token[], keyword: number, statements: ModuleStatement[], declared: Set<string>): number {
  let j = keyword + 1;
  for (;;) {
    let local: string | null = null;
    let names: BoundName[] = [];
    if (isName(tokens[j])) {
      local = tokens[j]!.text;
      j++;
    } else if (isPunct(tokens[j], '{')) {
      const pattern = objectPattern(tokens, j);
      names = pattern.names;
      j = pattern.last + 1;
    } else {
      return j - 1;
    }
    if (!isPunct(tokens[j], '=')) {
      if (local) declared.add(local);
      if (!isPunct(tokens[j], ',')) return j - 1;
      j++;
      continue;
    }
    const call = requireCall(tokens, j + 1);
    if (!call) {
      if (local) declared.add(local);
      return j;
    }
    let last = call.last;
    if (local) {
      // `const base = require('…')` binds the module; `const expect = require('…').expect` binds that export.
      let imported = '*';
      if (isPunct(tokens[last + 1], '.') && isName(tokens[last + 2])) {
        imported = tokens[last + 2]!.text;
        last += 2;
      }
      names = [{ imported, local, typeOnly: false }];
    }
    const end = isPunct(tokens[last + 1], ';') ? last + 1 : last;
    statements.push({ kind: 'require', module: call.module, names, end: tokens[end]!.end });
    if (!isPunct(tokens[last + 1], ',')) return end;
    j = last + 2;
  }
}

/**
 * The module statements at the top level of a file, the names they bind and the names the file declares itself, from
 * one tokenization: the import statements, over one line or several, and the `const`, `let` and `var` declarators
 * from `require('…')`. `import(…)`, `import.meta`, and anything inside a block, a string or a comment, count for
 * nothing.
 */
export function importBindings(text: string): ImportBindings {
  const tokens = tokenize(text);
  const statements: ModuleStatement[] = [];
  const declared = new Set<string>();
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'punct' && OPENERS.has(t.text)) depth++;
    else if (t.kind === 'punct' && CLOSERS.has(t.text)) depth = Math.max(0, depth - 1);
    if (depth > 0 || t.kind !== 'name' || isPunct(tokens[i - 1], '.') || isPunct(tokens[i - 1], '?.')) continue;
    if (t.text === 'import') {
      const statement = importStatement(tokens, i);
      if (!statement) continue;
      statements.push(statement);
      while (i + 1 < tokens.length && tokens[i + 1]!.end <= statement.end) i++;
    } else if (t.text === 'const' || t.text === 'let' || t.text === 'var') {
      i = declarators(tokens, i, statements, declared);
    } else if (t.text === 'function' && isName(tokens[i + 1])) {
      declared.add(tokens[i + 1]!.text);
    } else {
      const call = requireCall(tokens, i);
      if (!call) continue;
      statements.push({ kind: 'require', module: call.module, names: [], end: tokens[call.last]!.end });
      i = call.last;
    }
  }
  return { statements, names: new Set(statements.flatMap((s) => s.names.map((n) => n.local))), declared };
}

/**
 * The local names a file's import statements and top-level `require` declarations bind: a default import, `* as NS`,
 * each named import under its local name (`B` for `A as B`, `D` for `type D`), with or without `import type`, the name
 * of `import X = require('…')`, and those of `const { test, expect } = require('…')`, `const base = require('…')` and
 * `const { test: it } = require('…')`. `import '…'` binds none, and neither do `import(…)` and `import.meta`.
 */
export function importedNames(text: string): Set<string> {
  return importBindings(text).names;
}

/**
 * Where each import statement at the top level of a file ends, as an offset in `text`, in order: `import … from '…'`,
 * `import '…'` and `import X = require('…')`, over one line or several. `import(…)` and `import.meta` are not
 * statements, and neither are `require` declarations.
 */
export function importStatementEnds(text: string): number[] {
  return importBindings(text).statements.flatMap((s) => (s.kind === 'import' ? [s.end] : []));
}

/**
 * The module a file takes the export `name` from, under that name or another (`test as it`, `{ test: it }`), through
 * an import statement or a `require` declaration, or as a default import of that name; null when it takes it from
 * none, or as a type only.
 */
export function moduleOf(bindings: ImportBindings, name: string): string | null {
  for (const statement of bindings.statements) {
    for (const bound of statement.names) {
      if (bound.typeOnly) continue;
      if (bound.imported === name || (bound.imported === 'default' && bound.local === name)) return statement.module;
    }
  }
  return null;
}

/**
 * The module a file's `test` comes from: `import { test } from './fixtures'`, `import { test as it } from '…'`,
 * `import test from '…'`, `const { test, expect } = require('…')`, `const { test: it } = require('…')`. Null when the
 * file takes `test` from none, as a type only, or declares a `test` of its own (`const test = base.extend(…)`).
 */
export function testImportOf(text: string, bindings = importBindings(text)): string | null {
  return bindings.declared.has('test') ? null : moduleOf(bindings, 'test');
}

/**
 * The module `expect` is imported from when a block checks something: the module the file's `test` comes from, when
 * it is `@playwright/test` or when the file or a spec beside it (`siblings`, read when needed) imports `expect` from
 * it; else `@playwright/test`.
 */
export function expectModuleOf(
  text: string,
  options: { siblings?: () => readonly string[]; bindings?: ImportBindings } = {},
): string {
  const bindings = options.bindings ?? importBindings(text);
  const module = testImportOf(text, bindings);
  if (!module || module === PLAYWRIGHT_TEST) return PLAYWRIGHT_TEST;
  if (moduleOf(bindings, 'expect') === module) return module;
  const siblings = options.siblings?.() ?? [];
  return siblings.some((sibling) => moduleOf(importBindings(sibling), 'expect') === module) ? module : PLAYWRIGHT_TEST;
}

/**
 * The import lines whose names `text` does not bind yet, in their order: a line binding a name the file's imports
 * lack is kept whole. A line that binds no name is kept.
 */
export function missingImports(
  text: string,
  lines: readonly string[],
  bindings: ImportBindings = importBindings(text),
): string[] {
  if (lines.length === 0) return [];
  return lines.filter((line) => {
    const names = [...importBindings(line).names];
    return names.length === 0 || names.some((name) => !bindings.names.has(name));
  });
}

/** A module or export name as a `require` declaration spells it: quoted unless it is an identifier. */
function spell(name: string): string {
  return /^[\w$]+$/.test(name) ? name : `'${name}'`;
}

/**
 * An import line as a `require` declaration: `const { CartPage } = require('./pages/cart.page');`, `const base =
 * require('…');`, `require('./setup');`. A type-only import loads nothing, and a line that is not an import statement
 * stays as it is.
 */
export function requireForm(line: string): string {
  const statement = importBindings(line).statements.find((s) => s.kind === 'import');
  if (!statement) return line;
  const call = `require('${statement.module}')`;
  const values = statement.names.filter((n) => !n.typeOnly);
  if (!values.length) return statement.names.length ? '' : `${call};`;
  const whole = values.filter((n) => n.imported === 'default' || n.imported === '*');
  const members = values
    .filter((n) => n.imported !== 'default' && n.imported !== '*')
    .map((n) => (n.imported === n.local ? n.local : `${spell(n.imported)}: ${n.local}`));
  return [
    ...whole.map((n) => `const ${n.local} = ${call};`),
    ...(members.length ? [`const { ${members.join(', ')} } = ${call};`] : []),
  ].join('\n');
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
 * import statement; in a file without one that loads its modules with `require`, as `require` declarations after the
 * last of them; else at its top, followed by an empty line unless the file starts with one. Null when there is none
 * to add.
 */
export function importInsertion(
  text: string,
  lines: readonly string[],
  bindings: ImportBindings = importBindings(text),
): FileEdit | null {
  const missing = [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
  if (!missing.length) return null;
  const imports = bindings.statements.filter((s) => s.kind === 'import');
  const requires = bindings.statements.filter((s) => s.kind === 'require');
  const asRequire = !imports.length && requires.length > 0;
  const block = (asRequire ? missing.map(requireForm).filter(Boolean) : missing).join('\n');
  if (!block) return null;
  const after = asRequire ? requires : imports;
  const last = after[after.length - 1]?.end;
  if (last === undefined) {
    const first = text.split(/\r\n|\r|\n/, 1)[0] ?? '';
    return insertion({ line: 0, character: 0 }, `${block}\n${text && !first.trim() ? '' : '\n'}`);
  }
  const lineEnd = text.slice(last).search(/\r\n|\r|\n/);
  if (lineEnd < 0) return insertion(positionAt(text, text.length), `\n${block}`);
  return insertion({ line: positionAt(text, last).line + 1, character: 0 }, `${block}\n`);
}
