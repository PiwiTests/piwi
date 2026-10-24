/**
 * What a recording writes into a file, read from the file's text alone: the page expressions the lines written at a
 * position could run on (`piwi/pageCandidates`), and where the recorded block goes and how its lines are indented
 * (`RecordingPlacement`). One scanner in the style of `callEndLine`: strings, template literals, regular expressions
 * and comments are skipped and brackets matched; no TypeScript parser.
 */
import { isPageExpression } from '@piwitests/core/codegen';
import type { PageCandidate, PageCandidatesResult, RecordInto, RecordingPlacement } from '../protocol.js';

type CursorContext = PageCandidatesResult['context'];

export interface Token {
  kind: 'name' | 'punct' | 'string' | 'template' | 'number' | 'regex';
  /** The name, the punctuator, or a string's content between its quotes. */
  text: string;
  start: number;
  end: number;
}

/** Names after which a `/` starts a regular expression rather than a division. */
const BEFORE_EXPRESSION = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/** Punctuators longer than one character, longest first. */
const PUNCTUATORS = [
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '>>>',
  '&&=',
  '||=',
  '??=',
  '=>',
  '?.',
  '??',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '**',
  '<<',
  '>>',
];

const NAME_START = /[A-Za-z_$#\u0080-￿]/;
const NAME_PART = /[\w$\u0080-￿]/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // The open `{` of code and `${` of template literals, innermost last: a `}` closes the innermost.
  const braces: string[] = [];
  const length = text.length;

  /** Template text from `from`: the index after its closing backtick, or after a `${`, which it pushes. */
  const templateText = (from: number): number => {
    let j = from;
    while (j < length) {
      const c = text[j];
      if (c === '\\') j += 2;
      else if (c === '`') return j + 1;
      else if (c === '$' && text[j + 1] === '{') {
        braces.push('${');
        return j + 2;
      } else j++;
    }
    return length;
  };

  const regexAllowed = (): boolean => {
    const last = tokens[tokens.length - 1];
    if (!last) return true;
    if (last.kind === 'name') return BEFORE_EXPRESSION.has(last.text);
    return last.kind === 'punct' && ![')', ']', '}', '++', '--'].includes(last.text);
  };

  /** The end of a regular expression literal starting at `from`, or -1 when none closes on its line. */
  const regexEnd = (from: number): number => {
    let inClass = false;
    for (let j = from + 1; j < length; j++) {
      const c = text[j]!;
      if (LINE_BREAK.test(c)) return -1;
      if (c === '\\') j++;
      else if (inClass) inClass = c !== ']';
      else if (c === '[') inClass = true;
      else if (c === '/') {
        let end = j + 1;
        while (end < length && /[a-z]/i.test(text[end]!)) end++;
        return end;
      }
    }
    return -1;
  };

  let i = 0;
  while (i < length) {
    const c = text[i]!;
    const start = i;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < length && !LINE_BREAK.test(text[i]!)) i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? length : close + 2;
    } else if (c === "'" || c === '"') {
      i++;
      while (i < length && text[i] !== c && !LINE_BREAK.test(text[i]!)) i += text[i] === '\\' ? 2 : 1;
      const closed = text[i] === c;
      tokens.push({ kind: 'string', text: text.slice(start + 1, Math.min(i, length)), start, end: closed ? i + 1 : i });
      if (closed) i++;
    } else if (c === '`') {
      i = templateText(i + 1);
      tokens.push({ kind: 'template', text: text.slice(start, i), start, end: i });
    } else if (c === '}' && braces[braces.length - 1] === '${') {
      braces.pop();
      i = templateText(i + 1);
      tokens.push({ kind: 'template', text: text.slice(start, i), start, end: i });
    } else if (c === '/' && regexAllowed() && regexEnd(i) > 0) {
      i = regexEnd(i);
      tokens.push({ kind: 'regex', text: text.slice(start, i), start, end: i });
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      i++;
      while (i < length && /[\w.$]/.test(text[i]!)) i++;
      tokens.push({ kind: 'number', text: text.slice(start, i), start, end: i });
    } else if (NAME_START.test(c)) {
      i++;
      while (i < length && NAME_PART.test(text[i]!)) i++;
      tokens.push({ kind: 'name', text: text.slice(start, i), start, end: i });
    } else {
      let punct = PUNCTUATORS.find((p) => text.startsWith(p, i)) ?? c;
      if (punct === '?.' && /[0-9]/.test(text[i + 2] ?? '')) punct = '?';
      if (punct === '{') braces.push('{');
      else if (punct === '}') braces.pop();
      i += punct.length;
      tokens.push({ kind: 'punct', text: punct, start, end: i });
    }
  }
  return tokens;
}

/** A pair of matching brackets, by token index; an unclosed one closes at the end of the file. */
interface Bracket {
  char: string;
  open: number;
  close: number;
}

/** A function: its parameter list (or the single parameter of `x => …`) and its body (null for `x => expression`). */
interface FunctionInfo {
  params: Bracket | number | null;
  body: Bracket | null;
  /** The token the function starts at: its parameter list, or its single parameter. */
  start: number;
}

/** A name a scope declares. */
interface Declaration {
  name: string;
  /** The token naming it. */
  token: number;
  /** The block it is visible in; null at the top of the file. */
  scope: Bracket | null;
  /** A page (`page`), a promise of one (`promise`), or neither. */
  page: 'page' | 'promise' | null;
  reason: string;
  /** For a fixture a test's callback destructures, the fixture's name. */
  fixture?: string;
}

/** A receiver the code calls a page's method on. */
interface PageUse {
  expression: string;
  /** The token the expression starts at. */
  token: number;
  /** Whether a locator has the method too: the receiver then counts only when it looks like, or holds, a page. */
  ambiguous: boolean;
}

interface TestCall {
  callback: FunctionInfo;
  body: Bracket;
}

interface ClassInfo {
  name: string | null;
  body: Bracket;
  /** The fields holding a page (named `page`, or typed `Page`). */
  pageFields: string[];
}

/** Methods a page has and a locator does not: the receiver of a call to one is a page. */
const PAGE_ONLY_METHODS = new Set([
  'goto',
  'reload',
  'goBack',
  'goForward',
  'waitForURL',
  'waitForLoadState',
  'waitForNavigation',
  'waitForResponse',
  'waitForRequest',
  'waitForTimeout',
  'setViewportSize',
  'viewportSize',
  'bringToFront',
  'pause',
  'setContent',
  'content',
  'title',
  'emulateMedia',
  'opener',
  'mainFrame',
  'frames',
  'video',
  'pdf',
  'exposeFunction',
  'exposeBinding',
  'context',
]);

/** Properties only a page has: `page.keyboard.press(…)`. */
const PAGE_ONLY_PROPERTIES = new Set(['keyboard', 'mouse', 'touchscreen']);

/** Methods a page shares with a locator. */
const PAGE_OR_LOCATOR = new Set([
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
  'getByTestId',
  'locator',
  'frameLocator',
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'check',
  'uncheck',
  'hover',
  'tap',
  'focus',
  'selectOption',
  'dragAndDrop',
  'waitForSelector',
  'isVisible',
  'textContent',
  'innerText',
  'getAttribute',
]);

/** Matchers only a page takes: `expect(page).toHaveURL(…)`. */
const PAGE_MATCHERS = new Set(['toHaveURL', 'toHaveTitle']);

/** The members of `test` that take a test's or a hook's callback. */
const TEST_MEMBERS = new Set([
  'only',
  'skip',
  'fixme',
  'fail',
  'slow',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
]);

const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

const MODIFIERS = new Set([
  'readonly',
  'private',
  'public',
  'protected',
  'static',
  'declare',
  'override',
  'abstract',
  'accessor',
]);

/** Calls whose result is a page: `context.newPage()`, an Electron app's `firstWindow()`. */
const PAGE_FACTORIES = new Set(['newPage', 'firstWindow']);

/** Events whose value is a page: `page.waitForEvent('popup')`, `context.waitForEvent('page')`. */
const PAGE_EVENTS = new Set(['popup', 'page']);

/** Names after which a `{` opens an object literal: `return {`, `await {`. */
const OBJECT_BEFORE = new Set([
  'return',
  'yield',
  'throw',
  'await',
  'typeof',
  'void',
  'delete',
  'in',
  'of',
  'instanceof',
]);

/** Punctuators after which a `{` opens a block, a body or a class, not an object literal. */
const BLOCK_BEFORE = new Set([')', ']', '}', ';', '=>', '{', '>']);

const CLOSER_OF: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/** Whether a name looks like a page's: `page`, or one ending in `Page` (`adminPage`). */
function pageLikeName(name: string): boolean {
  return name === 'page' || /[a-z0-9_$]Page$/.test(name);
}

/** One file, scanned: its tokens and brackets, functions, tests, classes, declarations and page receivers. */
class FileModel {
  readonly tokens: Token[];
  readonly lines: string[];
  /** The offset each line starts at, as `split(/\r?\n/)` cuts them. */
  readonly starts: number[] = [0];
  /** The innermost bracket around each token; for a bracket's own tokens, the one around the pair. */
  readonly owner: Array<Bracket | null> = [];
  readonly openers = new Map<number, Bracket>();
  readonly closers = new Map<number, Bracket>();
  readonly functions: FunctionInfo[] = [];
  readonly tests: TestCall[] = [];
  /** The names that call a test (`test`, and the ones `testNames` finds). */
  private testNames = new Set(['test']);
  readonly classes: ClassInfo[] = [];
  readonly declarations: Declaration[] = [];
  readonly uses: PageUse[] = [];

  constructor(readonly text: string) {
    this.tokens = tokenize(text);
    this.lines = text.split(/\r?\n/);
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') this.starts.push(i + 1);
    this.matchBrackets();
    this.findFunctions();
    this.findTests();
    this.findClasses();
    this.findDeclarations();
    this.findUses();
  }

  /** 0-based line of an offset. */
  lineOf(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  /** 0-based line of a token. */
  lineOfToken(i: number): number {
    return this.lineOf(this.tokens[i]!.start);
  }

  /** Where a bracket's inside starts and ends, as offsets. */
  inside(b: Bracket): { from: number; to: number } {
    return {
      from: this.tokens[b.open]!.end,
      to: b.close < this.tokens.length ? this.tokens[b.close]!.start : this.text.length,
    };
  }

  /** Whether an offset is inside a bracket; everything is inside the file (null). */
  contains(b: Bracket | null, offset: number): boolean {
    if (!b) return true;
    const { from, to } = this.inside(b);
    return from <= offset && offset <= to;
  }

  is(i: number, text: string): boolean {
    const t = this.tokens[i];
    return !!t && (t.kind === 'punct' || t.kind === 'name') && t.text === text;
  }

  isName(i: number): boolean {
    return this.tokens[i]?.kind === 'name';
  }

  private matchBrackets(): void {
    const stack: Bracket[] = [];
    this.tokens.forEach((t, i) => {
      if (t.kind === 'punct' && (t.text === '(' || t.text === '[' || t.text === '{')) {
        this.owner[i] = stack[stack.length - 1] ?? null;
        const bracket: Bracket = { char: t.text, open: i, close: this.tokens.length };
        this.openers.set(i, bracket);
        stack.push(bracket);
        return;
      }
      if (t.kind === 'punct' && (t.text === ')' || t.text === ']' || t.text === '}')) {
        const opening = t.text === ')' ? '(' : t.text === ']' ? '[' : '{';
        let at = stack.length - 1;
        while (at >= 0 && stack[at]!.char !== opening) at--;
        if (at >= 0) {
          const bracket = stack[at]!;
          // Brackets opened inside it and never closed end here too.
          for (const b of stack.splice(at)) b.close = i;
          this.closers.set(i, bracket);
        }
      }
      this.owner[i] = stack[stack.length - 1] ?? null;
    });
  }

  /** The parameters before an arrow at `k`: their bracket, the index of a single parameter, or null. */
  private arrowParams(k: number): Bracket | number | null {
    const before = this.closers.get(k - 1);
    if (before?.char === '(') return before;
    // `(a: A): R => …`: back over the return type to the parameter list.
    for (let j = k - 1, steps = 0; j >= 0 && steps < 60; steps++) {
      const closed = this.closers.get(j);
      if (closed) {
        if (closed.char === '(' && this.is(j + 1, ':')) return closed;
        j = closed.open - 1;
        continue;
      }
      if (this.openers.has(j) || [';', ',', '=', '=>'].includes(this.tokens[j]!.text)) break;
      j--;
    }
    return this.isName(k - 1) ? k - 1 : null;
  }

  /** The body `{` after a parameter list closing at `close`, past a return type; null when none follows. */
  private bodyAfter(close: number): Bracket | null {
    if (this.is(close + 1, '{')) return this.openers.get(close + 1) ?? null;
    if (!this.is(close + 1, ':')) return null;
    for (let j = close + 2; j < this.tokens.length && j < close + 60; j++) {
      const t = this.tokens[j]!;
      const opened = this.openers.get(j);
      if (opened?.char === '{') {
        // A type ends with a name, a literal or a closing bracket; a `{` right after `:` opens an object type.
        const previous = this.tokens[j - 1]!;
        const endsType = previous.kind !== 'punct' || [')', ']', '}', '>'].includes(previous.text);
        if (endsType) return opened;
      }
      if (opened) {
        j = opened.close;
        continue;
      }
      if (t.kind === 'punct' && [';', '=>', '=', ',', ')', ']', '}'].includes(t.text)) return null;
    }
    return null;
  }

  private findFunctions(): void {
    this.tokens.forEach((t, k) => {
      if (t.kind !== 'punct') return;
      if (t.text === '=>') {
        const params = this.arrowParams(k);
        const body = this.is(k + 1, '{') ? (this.openers.get(k + 1) ?? null) : null;
        const start = params === null ? k : typeof params === 'number' ? params : params.open;
        this.functions.push({ params, body, start });
        return;
      }
      if (t.text !== '(') return;
      const params = this.openers.get(k)!;
      const previous = this.tokens[k - 1];
      if (!previous || params.close >= this.tokens.length) return;
      // `name(…) {`, `function (…) {`, `[key](…) {`, `name<T>(…) {`: not a control statement, not `a.b(…)`.
      const named = previous.kind === 'name' && !CONTROL_KEYWORDS.has(previous.text) && !this.is(k - 2, '.');
      if (!named && previous.text !== ']' && previous.text !== '>') return;
      const body = this.bodyAfter(params.close);
      if (body) this.functions.push({ params, body, start: k });
    });
  }

  /**
   * The names a file calls its tests with: `test`; a name `test` is imported or exported as (`import { test as
   * setup }`); a name assigned from one of them extended (`const adminTest = test.extend(…)`, `base.extend<…>(…)`);
   * and a name called as a test is, with a title first and a callback whose first parameter is a set of fixtures
   * (`adminTest('opens settings', async ({ adminPage }) => {`), such as a test imported from a fixtures module.
   */
  private findTestNames(): void {
    const names = this.testNames;
    this.tokens.forEach((t, i) => {
      if (t.text === 'test' && t.kind === 'name' && this.is(i + 1, 'as') && this.isName(i + 2))
        names.add(this.tokens[i + 2]!.text);
    });
    for (let grew = true; grew;) {
      grew = false;
      this.tokens.forEach((t, i) => {
        if (t.kind !== 'name' || names.has(t.text) || !this.is(i + 1, '=') || !this.isName(i + 2)) return;
        if (!names.has(this.tokens[i + 2]!.text) || !this.is(i + 3, '.') || !this.is(i + 4, 'extend')) return;
        names.add(t.text);
        grew = true;
      });
    }
    this.tokens.forEach((t, i) => {
      if (t.kind !== 'name' || names.has(t.text) || this.is(i - 1, '.') || this.is(i - 1, '?.')) return;
      if (this.is(i - 1, 'function') || !this.is(i + 1, '(')) return;
      const title = this.tokens[i + 2];
      if (!title || (title.kind !== 'string' && title.kind !== 'template') || !this.is(i + 3, ',')) return;
      const call = this.openers.get(i + 1);
      const callback = this.functions.filter((f) => f.body && this.owner[f.start] === call).pop();
      const params = callback?.params;
      if (params && typeof params === 'object' && this.is(params.open + 1, '{')) names.add(t.text);
    });
  }

  private findTests(): void {
    this.findTestNames();
    this.tokens.forEach((t, i) => {
      if (t.kind !== 'name' || !this.testNames.has(t.text) || this.is(i - 1, '.') || this.is(i - 1, '?.')) return;
      let j = i + 1;
      while (this.is(j, '.') && this.isName(j + 1)) {
        if (!TEST_MEMBERS.has(this.tokens[j + 1]!.text)) return;
        j += 2;
      }
      const call = this.is(j, '(') ? this.openers.get(j) : undefined;
      if (!call) return;
      const callback = this.functions.filter((f) => f.body && this.owner[f.start] === call).pop();
      if (callback?.body) this.tests.push({ callback, body: callback.body });
    });
  }

  private findClasses(): void {
    this.tokens.forEach((t, i) => {
      if (t.kind !== 'name' || t.text !== 'class' || this.is(i - 1, '.')) return;
      const next = this.tokens[i + 1];
      const name = next?.kind === 'name' && next.text !== 'extends' && next.text !== 'implements' ? next.text : null;
      let j = i + 1;
      while (j < this.tokens.length && !(this.is(j, '{') && this.owner[j] === this.owner[i])) {
        if (this.is(j, ';')) return;
        j = (this.openers.get(j)?.close ?? j) + 1;
      }
      const body = this.openers.get(j);
      if (body) this.classes.push({ name, body, pageFields: this.pageFields(body) });
    });
  }

  /** A class's fields holding a page: declared, parameter properties, or assigned as `this.page = …`. */
  private pageFields(body: Bracket): string[] {
    const fields = new Set<string>();
    for (let m = body.open + 1; m < body.close; m++) {
      if (this.owner[m] !== body || !this.isName(m) || MODIFIERS.has(this.tokens[m]!.text)) continue;
      const previous = this.tokens[m - 1]!;
      const onNewLine = this.lineOfToken(m - 1) < this.lineOfToken(m);
      const startsMember =
        m - 1 === body.open ||
        previous.text === ';' ||
        (previous.text === '}' && this.closers.has(m - 1)) ||
        (previous.kind === 'name' && MODIFIERS.has(previous.text)) ||
        (onNewLine && (previous.kind !== 'punct' || [')', ']'].includes(previous.text)));
      let after = m + 1;
      if (this.is(after, '?') || this.is(after, '!')) after++;
      if (!startsMember || !(this.is(after, ':') || this.is(after, '=') || this.is(after, ';'))) continue;
      const field = this.tokens[m]!.text;
      if (field === 'page' || (this.is(after, ':') && this.typeOf(after + 1, true) === 'page')) fields.add(field);
    }
    for (const f of this.functions) {
      if (typeof f.params !== 'object' || !f.params || this.owner[f.params.open] !== body) continue;
      if (!this.is(f.params.open - 1, 'constructor')) continue;
      for (let m = f.params.open + 1; m < f.params.close; m++) {
        if (this.owner[m] !== f.params || !this.isName(m) || !MODIFIERS.has(this.tokens[m]!.text)) continue;
        let p = m;
        while (this.isName(p + 1) && MODIFIERS.has(this.tokens[p + 1]!.text)) p++;
        if (!this.isName(p + 1)) continue;
        const field = this.tokens[p + 1]!.text;
        if (field === 'page' || (this.is(p + 2, ':') && this.typeOf(p + 3, false) === 'page')) fields.add(field);
        m = p + 1;
      }
    }
    for (let m = body.open + 1; m + 3 < body.close; m++) {
      if (this.is(m, 'this') && this.is(m + 1, '.') && this.is(m + 2, 'page') && this.is(m + 3, '='))
        fields.add('page');
    }
    return [...fields];
  }

  /**
   * What the type annotation starting at token `from` names: `Page`, a `Promise` of one, or neither. It ends at the
   * first `;`, `=`, `,` or closing bracket of its depth, or with its line when `oneLine` is set.
   */
  private typeOf(from: number, oneLine: boolean): 'page' | 'promise' | null {
    const scope = this.owner[from];
    const line = this.lineOfToken(from);
    const end = Math.min(this.tokens.length, from + 40, scope ? scope.close : Infinity);
    for (let j = from; j < end; j++) {
      const t = this.tokens[j]!;
      if (oneLine && this.lineOfToken(j) !== line) return null;
      if (this.owner[j] === scope && t.kind === 'punct' && [';', '=', ',', ')', ']', '}', '{', '=>'].includes(t.text)) {
        return null;
      }
      if (t.kind === 'name' && t.text === 'Page' && !this.is(j + 1, '.'))
        return this.is(from, 'Promise') ? 'promise' : 'page';
    }
    return null;
  }

  /** The tokens of an initializer after the `=` at `eq`, up to its end at the same depth. */
  private initializer(eq: number): number[] {
    const scope = this.owner[eq];
    const out: number[] = [];
    const carryOn = new Set(['.', '?.', '=', '(', '[', '{', ',', '?', ':', '&&', '||', '??', '+', '-', '=>', '|']);
    for (let j = eq + 1; j < this.tokens.length; j++) {
      const t = this.tokens[j]!;
      if (this.owner[j] === scope) {
        if (t.kind === 'punct' && [';', ',', ')', ']', '}'].includes(t.text)) break;
        // A statement without a semicolon ends with its line, unless the next line carries the expression on.
        const previous = this.tokens[j - 1]!;
        const continues =
          (previous.kind === 'punct' && carryOn.has(previous.text)) ||
          (previous.kind === 'name' && BEFORE_EXPRESSION.has(previous.text)) ||
          (t.kind === 'punct' && (t.text === '.' || t.text === '?.'));
        if (j > eq + 1 && this.lineOfToken(j) !== this.lineOf(previous.end) && !continues) break;
      }
      out.push(j);
    }
    return out;
  }

  /** What an initializer gives: a page (`await context.newPage()`), a promise of one, or neither. */
  private initializerPage(tokens: number[]): 'page' | 'promise' | null {
    const awaited = tokens.length > 0 && this.is(tokens[0]!, 'await');
    const produces = tokens.some((j) => {
      const t = this.tokens[j]!;
      if (t.kind !== 'name' || !this.is(j + 1, '(')) return false;
      if (PAGE_FACTORIES.has(t.text)) return true;
      const event = this.tokens[j + 2];
      return t.text === 'waitForEvent' && event?.kind === 'string' && PAGE_EVENTS.has(event.text);
    });
    if (produces) return awaited ? 'page' : 'promise';
    // `const popup = await popupPromise;`
    if (awaited && tokens.length === 2 && this.isName(tokens[1]!)) {
      const promise = this.resolveAt(this.tokens[tokens[1]!]!.text, this.tokens[tokens[1]!]!.start);
      if (promise?.page === 'promise') return 'page';
    }
    return null;
  }

  private findDeclarations(): void {
    // Parameters, visible in their function's body.
    for (const f of this.functions) {
      if (!f.body) continue;
      if (typeof f.params === 'number') {
        const name = this.tokens[f.params]!.text;
        this.declare(name, f.params, f.body, pageLikeName(name) ? 'page' : null, 'declared');
      } else if (f.params) {
        this.declareParameters(f, f.params, f.body);
      }
    }
    // `const`, `let` and `var`, visible in the block around them once declared.
    this.tokens.forEach((t, d) => {
      if (t.kind !== 'name' || !['const', 'let', 'var'].includes(t.text) || this.is(d - 1, '.')) return;
      const scope = this.owner[d] ?? null;
      let j = d + 1;
      while (j < this.tokens.length) {
        const target = this.tokens[j]!;
        if (target.kind === 'name') {
          let eq = j + 1;
          let annotated: 'page' | 'promise' | null = null;
          if (this.is(eq, ':')) {
            annotated = this.typeOf(eq + 1, true);
            for (eq++; eq < this.tokens.length && this.lineOfToken(eq) === this.lineOfToken(j); eq++) {
              if (this.owner[eq] === scope && (this.is(eq, '=') || this.is(eq, ';') || this.is(eq, ','))) break;
              eq = this.openers.get(eq)?.close ?? eq;
            }
          }
          const init = this.is(eq, '=') ? this.initializer(eq) : [];
          const page = annotated ?? this.initializerPage(init);
          this.declare(target.text, j, scope, page, page === 'page' && !annotated ? 'opened' : 'declared');
          j = init.length ? init[init.length - 1]! + 1 : eq;
        } else if (this.is(j, '[') || this.is(j, '{')) {
          const pattern = this.openers.get(j)!;
          const eq = pattern.close + 1;
          const init = this.is(eq, '=') ? this.initializer(eq) : [];
          if (target.text === '[') {
            // `const [popup] = await Promise.all([page.waitForEvent('popup'), …])`: the first element is the page.
            const page = this.initializerPage(init) === 'page' ? 'page' : null;
            let first = true;
            for (let m = pattern.open + 1; m < pattern.close; m++) {
              if (this.owner[m] !== pattern) continue;
              if (this.is(m, ',')) first = false;
              else if (this.isName(m) && !this.is(m - 1, '='))
                this.declare(this.tokens[m]!.text, m, scope, first ? page : null, 'opened');
            }
          } else {
            for (const p of this.objectPattern(pattern)) this.declare(p.local, p.token, scope, null, 'declared');
          }
          j = init.length ? init[init.length - 1]! + 1 : eq;
        } else {
          return;
        }
        if (!this.is(j, ',')) return;
        j++;
      }
    });
  }

  /** A function's parameters; a test's callback destructures its fixtures from the first. */
  private declareParameters(f: FunctionInfo, params: Bracket, body: Bracket): void {
    const test = this.tests.some((t) => t.callback === f);
    let first = true;
    for (let m = params.open + 1; m < params.close; m++) {
      if (this.owner[m] !== params) continue;
      if (this.is(m, ',')) {
        first = false;
        continue;
      }
      if (this.is(m, '{')) {
        const pattern = this.openers.get(m)!;
        for (const p of this.objectPattern(pattern)) {
          const page = pageLikeName(p.key) || pageLikeName(p.local) ? 'page' : null;
          if (test && first) {
            this.declarations.push({
              name: p.local,
              token: p.token,
              scope: body,
              page,
              reason: 'fixture of this test',
              fixture: p.key,
            });
          } else {
            this.declare(p.local, p.token, body, page, 'declared');
          }
        }
        m = pattern.close;
        continue;
      }
      const t = this.tokens[m]!;
      if (t.kind !== 'name' || MODIFIERS.has(t.text) || this.is(m - 1, ':') || this.is(m - 1, '=')) continue;
      const optional = this.is(m + 1, '?') ? 1 : 0;
      const next = m + 1 + optional;
      if (!(this.is(next, ':') || this.is(next, ',') || this.is(next, '=') || next === params.close)) continue;
      const typed = this.is(next, ':') ? this.typeOf(next + 1, false) : null;
      this.declare(t.text, m, body, t.text === 'page' || typed === 'page' ? 'page' : typed, 'declared');
    }
  }

  private declare(
    name: string,
    token: number,
    scope: Bracket | null,
    page: Declaration['page'],
    how: 'declared' | 'opened',
  ): void {
    this.declarations.push({ name, token, scope, page, reason: `${how} on line ${this.lineOfToken(token) + 1}` });
  }

  /** The names an object pattern binds: `{ page, adminPage: admin, user = x, ...rest }`. */
  private objectPattern(pattern: Bracket): Array<{ key: string; local: string; token: number }> {
    const out: Array<{ key: string; local: string; token: number }> = [];
    for (let m = pattern.open + 1; m < pattern.close; m++) {
      if (this.owner[m] !== pattern) continue;
      const t = this.tokens[m]!;
      if (this.is(m, '...') && this.isName(m + 1)) {
        out.push({ key: this.tokens[m + 1]!.text, local: this.tokens[m + 1]!.text, token: m + 1 });
        m++;
        continue;
      }
      if ((t.kind !== 'name' && t.kind !== 'string') || !(m - 1 === pattern.open || this.is(m - 1, ','))) continue;
      if (this.is(m + 1, ':')) {
        if (this.isName(m + 2)) out.push({ key: t.text, local: this.tokens[m + 2]!.text, token: m + 2 });
      } else if (t.kind === 'name') {
        out.push({ key: t.text, local: t.text, token: m });
      }
    }
    return out;
  }

  /** The declaration a name means at an offset: the innermost one visible there, declared before it. */
  resolveAt(name: string, offset: number): Declaration | null {
    let best: Declaration | null = null;
    for (const d of this.declarations) {
      if (d.name !== name || this.tokens[d.token]!.start > offset || !this.contains(d.scope, offset)) continue;
      if (!best || (d.scope && (!best.scope || this.inside(d.scope).from >= this.inside(best.scope).from))) best = d;
    }
    return best;
  }

  private findUses(): void {
    this.tokens.forEach((t, i) => {
      if (t.kind !== 'name' || this.is(i - 1, '.') || this.is(i - 1, '?.')) return;
      const segments = [t.text];
      let j = i + 1;
      while (this.is(j, '.') && this.isName(j + 1)) {
        segments.push(this.tokens[j + 1]!.text);
        j += 2;
      }
      for (let k = 1; k < segments.length; k++) {
        const member = segments[k]!;
        const receiver = segments.slice(0, k).join('.');
        const called = k === segments.length - 1 && this.is(j, '(');
        if (PAGE_ONLY_PROPERTIES.has(member) || (called && PAGE_ONLY_METHODS.has(member))) {
          this.uses.push({ expression: receiver, token: i, ambiguous: false });
        } else if (called && PAGE_OR_LOCATOR.has(member)) {
          this.uses.push({ expression: receiver, token: i, ambiguous: true });
        }
      }
      // `expect(page).toHaveURL(…)`, `expect(page).not.toHaveTitle(…)`.
      if (this.is(i - 1, '(') && this.is(i - 2, 'expect') && this.is(j, ')')) {
        let m = j + 1;
        if (this.is(m, '.') && this.is(m + 1, 'not')) m += 2;
        if (this.is(m, '.') && PAGE_MATCHERS.has(this.tokens[m + 1]?.text ?? '')) {
          this.uses.push({ expression: segments.join('.'), token: i, ambiguous: false });
        }
      }
    });
  }

  private innermost<T>(entries: Array<[Bracket, T]>): T | null {
    let best: [Bracket, T] | null = null;
    for (const entry of entries) {
      if (!best || this.inside(entry[0]).from > this.inside(best[0]).from) best = entry;
    }
    return best ? best[1] : null;
  }

  /** The innermost test (or hook) whose body holds an offset. */
  testAt(offset: number): TestCall | null {
    return this.innermost(this.tests.filter((t) => this.contains(t.body, offset)).map((t) => [t.body, t]));
  }

  classAt(offset: number): ClassInfo | null {
    return this.innermost(this.classes.filter((c) => this.contains(c.body, offset)).map((c) => [c.body, c]));
  }

  functionAt(offset: number): FunctionInfo | null {
    return this.innermost(
      this.functions.filter((f) => f.body && this.contains(f.body, offset)).map((f) => [f.body!, f]),
    );
  }

  /**
   * Whether a function is the callback of `test.describe(…)` (any of its members, or a bare `describe(…)`) or of
   * `test.step(…)`: its body belongs to the code around the call.
   */
  private groups(f: FunctionInfo): boolean {
    const call = this.owner[f.start];
    if (!call || call.char !== '(') return false;
    const chain: string[] = [];
    for (let j = call.open - 1; this.isName(j); j -= 2) {
      chain.unshift(this.tokens[j]!.text);
      if (!this.is(j - 1, '.')) break;
    }
    return (
      chain[0] === 'describe' || (this.testNames.has(chain[0]!) && (chain[1] === 'describe' || chain[1] === 'step'))
    );
  }

  /**
   * Where an offset is: in the body of a test's or a hook's callback (`test`), of another function or method
   * (`function`), in a class body between its members (`class`), or elsewhere (`file`). The innermost body decides;
   * the callbacks of `test.describe(…)` and `test.step(…)` count as the code around them.
   */
  contextAt(offset: number): CursorContext {
    const fn = this.innermost(
      this.functions.filter((f) => f.body && this.contains(f.body, offset) && !this.groups(f)).map((f) => [f.body!, f]),
    );
    const klass = this.classAt(offset);
    if (klass && (!fn?.body || this.inside(klass.body).from > this.inside(fn.body).from)) return 'class';
    if (!fn) return 'file';
    return this.tests.some((t) => t.callback === fn) ? 'test' : 'function';
  }

  /** The innermost bracket around an offset, of any kind. */
  bracketAt(offset: number): Bracket | null {
    return this.innermost([...this.openers.values()].filter((b) => this.contains(b, offset)).map((b) => [b, b]));
  }

  /**
   * The outermost bracket of the expression an offset is in: from the innermost bracket around it, out through the
   * `(`, `[` and object-literal `{` brackets (a multi-line `expect(` and the object it takes). Null when the
   * innermost one is a block, a body or a class, or when there is none.
   */
  expressionAround(offset: number): Bracket | null {
    let outer: Bracket | null = null;
    for (let b = this.bracketAt(offset); b && this.holdsExpression(b); b = this.owner[b.open] ?? null) outer = b;
    return outer;
  }

  /** Whether a bracket holds an expression: `(`, `[`, or a `{` in an operand position (an object literal, a pattern). */
  private holdsExpression(b: Bracket): boolean {
    if (b.char !== '{') return true;
    const previous = this.tokens[b.open - 1];
    if (!previous) return false;
    if (previous.kind === 'name') return OBJECT_BEFORE.has(previous.text);
    return previous.kind === 'punct' && !BLOCK_BEFORE.has(previous.text);
  }

  /** Whether code starts at an offset: a token, or a comment, but not text inside a string or a comment. */
  startsCodeAt(offset: number): boolean {
    let low = 0;
    let high = this.tokens.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const start = this.tokens[mid]!.start;
      if (start === offset) return true;
      if (start < offset) low = mid + 1;
      else high = mid - 1;
    }
    const inToken = this.tokens[high];
    if (inToken && inToken.end > offset) return false;
    return this.text.startsWith('//', offset) || this.text.startsWith('/*', offset);
  }

  /** The page fixtures a test destructures, as declared in its callback. */
  fixturesOf(test: TestCall): Declaration[] {
    return this.declarations.filter((d) => d.scope === test.body && d.fixture !== undefined && d.page === 'page');
  }
}

interface BlockPosition {
  line: number;
  newLine: boolean;
  /** The offset that stands for the block's place: where it goes, in the text as it is. */
  offset: number;
  /** A bracket around the caret the file never closes: the block has nowhere to go after it. */
  unclosed: Bracket | null;
}

/**
 * The line a recording's block goes on, and the offset that stands for it: a blank caret line takes the block; after
 * a line with text, the block goes on a new line after it. A caret inside an expression's brackets (the end of a line
 * of a multi-line `expect(`) puts the block on a new line after the line those brackets close on, the statement's
 * end.
 */
function blockPosition(model: FileModel, caretLine: number): BlockPosition {
  const line = Math.max(0, Math.min(caretLine, model.lines.length - 1));
  const text = model.lines[line]!;
  const start = model.starts[line]!;
  const blank = !text.trim();
  const caret = blank ? start : start + text.length;
  const outer = model.expressionAround(caret);
  if (!outer) {
    if (blank) return { line, newLine: false, offset: start, unclosed: null };
    return { line: line + 1, newLine: true, offset: caret, unclosed: null };
  }
  // A bracket the file never closes ends at the file's end, or where an outer bracket closes.
  if (model.tokens[outer.close]?.text !== CLOSER_OF[outer.char]) {
    return { line: line + 1, newLine: true, offset: caret, unclosed: outer };
  }
  const closeLine = model.lineOfToken(outer.close);
  const offset = model.starts[closeLine]! + model.lines[closeLine]!.length;
  return { line: closeLine + 1, newLine: true, offset, unclosed: null };
}

/** A file's indentation step: a tab, or the most common increase in spaces from one line to the next; two by default. */
function indentUnit(lines: string[]): string {
  let tabs = 0;
  let spaces = 0;
  const steps = new Map<number, number>();
  let previous = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith('\t')) {
      tabs++;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent > 0) spaces++;
    if (indent > previous && indent - previous <= 8)
      steps.set(indent - previous, (steps.get(indent - previous) ?? 0) + 1);
    previous = indent;
  }
  if (tabs > spaces) return '\t';
  const best = [...steps].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return ' '.repeat(best?.[0] ?? 2);
}

function leadingSpace(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}

/**
 * The indentation of a line written at an offset: that of the lines already inside the block of code around it, else
 * the indentation of the line opening that block plus the file's step; none at the top of the file.
 */
function blockIndent(model: FileModel, offset: number): string {
  const block = model.bracketAt(offset);
  if (!block) return '';
  const openLine = model.lineOfToken(block.open);
  const closeLine = block.close < model.tokens.length ? model.lineOfToken(block.close) : model.lines.length;
  for (let line = openLine + 1; line < closeLine; line++) {
    const text = model.lines[line]!;
    if (!text.trim()) continue;
    const first = model.starts[line]! + (text.length - text.trimStart().length);
    if (model.startsCodeAt(first) && model.bracketAt(first) === block) return leadingSpace(text);
  }
  return leadingSpace(model.lines[openLine]!) + indentUnit(model.lines);
}

/**
 * Where a recording started at a caret writes its block: the caret's line when it is blank, else a new line after
 * it, or after the statement whose brackets the caret is in, indented like the code of the block around it. `file`
 * writes a whole new file: its first line, not indented. A caret inside a bracket the file never closes refuses, with
 * one sentence for the client to show.
 */
export function recordingPlacement(
  text: string,
  caretLine: number,
  into: RecordInto,
): RecordingPlacement | { refusal: string } {
  if (into === 'file') return { line: 0, newLine: false, indent: '' };
  const model = new FileModel(text);
  const at = blockPosition(model, caretLine);
  if (at.unclosed) {
    const opened = model.tokens[at.unclosed.open]!;
    return {
      refusal: `The cursor is inside a ${opened.text} opened on line ${model.lineOf(opened.start) + 1} and not closed: close it, or put the cursor after the statement.`,
    };
  }
  return { line: at.line, newLine: at.newLine, indent: blockIndent(model, at.offset) };
}

/**
 * Where a block written before the statement holding a line goes, the statement a test is paused before: a new line
 * above the line that statement starts on (the line opening the brackets the line is in, and the line above it while
 * the line goes on with `.`: a chain broken over lines), indented as that line is.
 */
export function placementBefore(text: string, line: number): RecordingPlacement {
  const model = new FileModel(text);
  let at = Math.max(0, Math.min(line, model.lines.length - 1));
  for (let step = 0; step < model.lines.length; step++) {
    const here = model.lines[at]!;
    const outer = model.expressionAround(model.starts[at]! + (here.length - here.trimStart().length));
    const opened = outer ? model.lineOfToken(outer.open) : at;
    if (opened < at) {
      at = opened;
      continue;
    }
    let above = at - 1;
    while (above >= 0 && !model.lines[above]!.trim()) above--;
    if (above < 0 || !/^(?:\?\.|\.(?!\.))/.test(here.trim())) break;
    at = above;
  }
  return { line: at, newLine: true, indent: leadingSpace(model.lines[at]!) };
}

/**
 * Whether a call counts as made on a page, seen from offset `at`: its receiver starts with the variable the name
 * means at `at` (or with `this`, inside the class `klass`), and the method is a page's only, or the receiver looks
 * like or holds a page.
 */
function onPage(model: FileModel, use: PageUse, at: number, klass: ClassInfo | null): boolean {
  const offset = model.tokens[use.token]!.start;
  const segments = use.expression.split('.');
  const last = segments[segments.length - 1]!;
  if (segments[0] === 'this')
    return !!klass && model.contains(klass.body, offset) && (!use.ambiguous || pageLikeName(last));
  const declared = model.resolveAt(segments[0]!, at);
  if (!declared || model.resolveAt(segments[0]!, offset) !== declared) return false;
  return !use.ambiguous || pageLikeName(last) || (segments.length === 1 && declared.page === 'page');
}

/**
 * A test's fixtures named like a page, told apart by the test's calls: `page` and those a page call runs on directly
 * (`adminPage.goto(…)`, `userPage.getByRole(…)`) are pages; those with no such call may be page objects (`todoPage`
 * with `todoPage.addTodo(…)`, or nothing yet). A fixture the calls show to hold a page (`app.page.goto(…)`) is
 * neither: it is offered through its page.
 */
function fixturePages(
  model: FileModel,
  test: TestCall,
  uses: PageUse[],
): { pages: Declaration[]; maybe: Declaration[] } {
  const direct = new Set(uses.filter((u) => !u.expression.includes('.')).map((u) => u.expression));
  const holders = new Set(uses.filter((u) => u.expression.includes('.')).map((u) => u.expression.split('.')[0]!));
  const pages: Declaration[] = [];
  const maybe: Declaration[] = [];
  for (const d of model.fixturesOf(test)) {
    if (d.fixture === 'page' || direct.has(d.name)) pages.push(d);
    else if (!holders.has(d.name)) maybe.push(d);
  }
  return { pages, maybe };
}

const MAY_BE_PAGE_OBJECT = 'may be a page object';

/**
 * The page expressions the lines written at a caret could run on, best first, and where the block goes
 * (`FileModel.contextAt`): in a test's body (hooks included), in another function or method, in a class body between
 * its members, or elsewhere in the file. Offered: the receivers of the page
 * calls around it, the test's page fixtures, the variables holding a page (`newPage()`, a `popup` or `page` event,
 * `firstWindow()`, a `Page` annotation) and a class's page fields. The default is the receiver of the nearest page
 * call before it; else, in a test, its `page` fixture, the receiver of its next page call, or its first page
 * fixture; in a class, `this.page`; in another function, a page it declares; between tests, what the nearest test
 * runs its calls on, else its page fixture; else `page`. A fixture the calls show to hold a page (`app.page`) is
 * offered through it, not on its own; a fixture named like a page that no page call runs on (`todoPage`) is offered
 * after `page`, as one that may be a page object.
 */
export function pageCandidates(text: string, caretLine: number): PageCandidatesResult {
  const model = new FileModel(text);
  const at = blockPosition(model, caretLine).offset;
  const test = model.testAt(at);
  const found = model.classAt(at);
  const klass = found && (!test || model.inside(found.body).from > model.inside(test.body).from) ? found : null;
  const context = model.contextAt(at);
  const fn = model.functionAt(at);
  const region = klass ? klass.body : test ? test.body : (fn?.body ?? null);
  const line = (token: number) => model.lineOfToken(token) + 1;

  const used = model.uses.filter(
    (u) => model.contains(region, model.tokens[u.token]!.start) && onPage(model, u, at, klass),
  );
  const before: PageCandidate[] = used
    .filter((u) => model.tokens[u.token]!.start < at)
    .sort((a, b) => b.token - a.token)
    .map((u) => ({ expression: u.expression, reason: `used on line ${line(u.token)}` }));
  const after: PageCandidate[] = used
    .filter((u) => model.tokens[u.token]!.start >= at)
    .sort((a, b) => a.token - b.token)
    .map((u) => ({ expression: u.expression, reason: `used on line ${line(u.token)}` }));

  /** The page variables the block can use, the latest declared first. */
  const declared = model.declarations
    .filter((d) => d.page === 'page' && model.resolveAt(d.name, at) === d)
    .sort((a, b) => b.token - a.token);
  const asCandidate = (d: Declaration): PageCandidate => ({ expression: d.name, reason: d.reason });

  let preferred: PageCandidate | undefined;
  let others: PageCandidate[];
  let fallback: PageCandidate;
  /** The fixtures that may be page objects, offered last, after `page`. */
  let maybe: PageCandidate[] = [];
  if (klass) {
    const reason = klass.name ? `field of ${klass.name}` : 'field of this class';
    const fields = klass.pageFields.map((field) => ({ expression: `this.${field}`, reason }));
    fallback = { expression: 'this.page', reason };
    others = [...fields, ...declared.map(asCandidate)];
    preferred =
      before[0] ??
      fields.find((f) => f.expression === 'this.page') ??
      fields[0] ??
      (declared[0] && asCandidate(declared[0]));
  } else if (test) {
    const visible = (d: Declaration) => model.resolveAt(d.name, at) === d;
    const split = fixturePages(model, test, used);
    const fixtures = split.pages.filter(visible);
    const locals = declared.filter((d) => d.fixture === undefined);
    fallback = { expression: 'page', reason: "Playwright's page fixture" };
    others = [...fixtures.map(asCandidate), ...locals.map(asCandidate)];
    maybe = split.maybe.filter(visible).map((d) => ({ expression: d.name, reason: MAY_BE_PAGE_OBJECT }));
    const pageFixture = fixtures.find((d) => d.fixture === 'page');
    const guessed = fixtures[0] ?? locals[0];
    preferred = before[0] ?? (pageFixture && asCandidate(pageFixture)) ?? after[0] ?? (guessed && asCandidate(guessed));
  } else if (fn?.body) {
    fallback = { expression: 'page', reason: "Playwright's page fixture" };
    others = declared.map(asCandidate);
    preferred = before[0] ?? (declared[0] && asCandidate(declared[0]));
  } else {
    fallback = { expression: 'page', reason: "Playwright's page fixture" };
    const tests = testsByDistance(model, at).map((t) => fileCandidates(model, t));
    others = [...tests.flatMap((t) => t.pages), fallback];
    maybe = tests.flatMap((t) => t.maybe);
    const nearest = nearestTest(model, at);
    preferred = before[0] ?? (nearest ? fileCandidates(model, nearest).pages[0] : undefined);
  }

  const seen = new Set<string>();
  const candidates: PageCandidate[] = [];
  const last = maybe.length ? [fallback, ...maybe] : [];
  for (const c of [preferred ?? fallback, ...before, ...others, ...after, ...last]) {
    if (seen.has(c.expression) || !isPageExpression(c.expression)) continue;
    seen.add(c.expression);
    candidates.push(c);
  }
  return { candidates, default: candidates[0]!.expression, context };
}

/**
 * The page expressions a new test could take from a test of the file: what its page calls run on, rooted at its
 * fixtures and named after them (`adminPage` for `{ adminPage: admin }`), the most used first; then its page fixtures.
 * Apart, the fixtures that may be page objects.
 */
function fileCandidates(model: FileModel, test: TestCall): { pages: PageCandidate[]; maybe: PageCandidate[] } {
  const uses = model.uses.filter((u) => {
    const offset = model.tokens[u.token]!.start;
    return model.contains(test.body, offset) && onPage(model, u, offset, null);
  });
  const counted = new Map<string, { candidate: PageCandidate; count: number }>();
  for (const u of uses) {
    const offset = model.tokens[u.token]!.start;
    const [first, ...rest] = u.expression.split('.');
    const declared = model.resolveAt(first!, offset);
    if (declared?.scope !== test.body || declared.fixture === undefined) continue;
    const expression = [declared.fixture, ...rest].join('.');
    const entry = counted.get(expression) ?? {
      candidate: { expression, reason: `used on line ${model.lineOf(offset) + 1}` },
      count: 0,
    };
    entry.count++;
    counted.set(expression, entry);
  }
  const byUse = [...counted.values()].sort((a, b) => b.count - a.count).map((e) => e.candidate);
  const split = fixturePages(model, test, uses);
  const fixtures = split.pages
    .sort((a, b) => Number(b.fixture === 'page') - Number(a.fixture === 'page'))
    .map((d) => ({ expression: d.fixture!, reason: 'fixture in this file' }));
  return {
    pages: [...byUse, ...fixtures],
    maybe: split.maybe.map((d) => ({ expression: d.fixture!, reason: MAY_BE_PAGE_OBJECT })),
  };
}

/** The file's tests, the nearest to an offset first. */
function testsByDistance(model: FileModel, at: number): TestCall[] {
  const distance = (t: TestCall) => Math.abs(model.tokens[t.body.open]!.start - at);
  return [...model.tests].sort((a, b) => distance(a) - distance(b));
}

/** The nearest test before an offset, else the first after it. */
function nearestTest(model: FileModel, at: number): TestCall | undefined {
  const opens = (t: TestCall) => model.tokens[t.body.open]!.start;
  return model.tests.filter((t) => opens(t) < at).pop() ?? model.tests.find((t) => opens(t) >= at);
}

/**
 * The names declared where the lines written at a caret go, before them: the parameters and declarations of the
 * functions and blocks around the caret, out to the top of the file.
 */
export function declaredNamesAt(text: string, caretLine: number): Set<string> {
  const model = new FileModel(text);
  const at = blockPosition(model, caretLine).offset;
  return new Set(
    model.declarations
      .filter((d) => model.tokens[d.token]!.start <= at && model.contains(d.scope, at))
      .map((d) => d.name),
  );
}

/**
 * The fixtures the tests of a file take, by fixture name (`loginPage` for `({ loginPage })`, `user` for
 * `({ user: admin })`): the ones a new test in that file can take too.
 */
export function fileFixtures(text: string): Set<string> {
  const model = new FileModel(text);
  return new Set(model.declarations.flatMap((d) => (d.fixture === undefined ? [] : [d.fixture])));
}
