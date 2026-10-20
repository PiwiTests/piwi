/**
 * Locator chains: the Playwright locator expressions the test runner prints for
 * every locator step (`getByRole('form', { name: 'Shipping' }).getByLabel('Country')`),
 * parsed into calls without `eval` and rendered back in one canonical form.
 *
 * The grammar is the JavaScript form Playwright's own `asLocator` produces:
 * method calls joined by `.`, with string, regex, number, boolean, object and
 * nested-locator arguments (`filter({ has: getByRole('combobox') })`). Methods
 * outside {@link LOCATOR_CHAIN_METHODS} are refused, so a parsed chain can be
 * rebuilt against a real page through a fixed list of calls.
 */

/** One argument of a locator call. */
export type LocatorArg =
  | { type: 'string'; value: string }
  | { type: 'regex'; source: string; flags: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'object'; entries: Array<[string, LocatorArg]> }
  | { type: 'chain'; chain: LocatorChain };

export interface LocatorCall {
  method: string;
  args: LocatorArg[];
}

export interface LocatorChain {
  calls: LocatorCall[];
}

/** Calls that locate elements. Each one starts a new scope inside the previous link. */
export const LOCATING_METHODS: ReadonlySet<string> = new Set([
  'getByRole',
  'getByTestId',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
  'locator',
  'frameLocator',
]);

/** Calls that narrow, combine or re-root the current link without locating anew. */
const NARROWING_METHODS: ReadonlySet<string> = new Set([
  'filter',
  'first',
  'last',
  'nth',
  'and',
  'or',
  'visible',
  'contentFrame',
  'owner',
]);

/** Every method a chain may contain. */
const LOCATOR_CHAIN_METHODS: ReadonlySet<string> = new Set([...LOCATING_METHODS, ...NARROWING_METHODS]);

/** Raised for any expression outside the supported grammar; the message says where. */
class LocatorParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocatorParseError';
  }
}

/** Where one top-level call of a chain starts and ends in the parsed text. */
export interface CallSpan {
  start: number;
  end: number;
}

/** Single-character escapes and what they stand for. */
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
};

class Parser {
  private i = 0;

  constructor(private readonly src: string) {}

  parseTopLevel(): LocatorChain {
    const chain = this.parseChain();
    this.skipSpace();
    if (this.i < this.src.length) this.fail('unexpected text');
    return chain;
  }

  private fail(message: string): never {
    throw new LocatorParseError(`${message} at "${this.src.slice(this.i, this.i + 20)}"`);
  }

  private skipSpace(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++;
  }

  private peek(): string | undefined {
    return this.src[this.i];
  }

  private expect(ch: string): void {
    this.skipSpace();
    if (this.src[this.i] !== ch) this.fail(`expected "${ch}"`);
    this.i++;
  }

  private identifier(): string {
    const m = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.i));
    if (!m) this.fail('expected a name');
    this.i += m[0].length;
    return m[0];
  }

  /**
   * A chain of calls joined by `.`. With `lenient`, parsing stops before the
   * first link that doesn't parse instead of failing, so a chain followed by
   * other text (an error message) is read up to where it ends. `spans` receives
   * where each top-level call starts and ends.
   */
  parseChain(opts: { lenient?: boolean; spans?: CallSpan[] } = {}): LocatorChain {
    this.skipSpace();
    const calls: LocatorCall[] = [];
    for (;;) {
      const before = this.i;
      if (calls.length > 0) this.i++; // the `.`
      this.skipSpace();
      const start = this.i;
      try {
        calls.push(this.parseCall(calls.length === 0));
      } catch (error) {
        if (!opts.lenient || calls.length === 0) throw error;
        this.i = before;
        break;
      }
      opts.spans?.push({ start, end: this.i });
      const end = this.i;
      this.skipSpace();
      if (this.peek() !== '.') {
        this.i = end;
        break;
      }
    }
    return { calls };
  }

  /** Where the parser stopped. */
  get position(): number {
    return this.i;
  }

  private parseCall(first: boolean): LocatorCall {
    this.skipSpace();
    const method = this.identifier();
    if (!LOCATOR_CHAIN_METHODS.has(method)) this.fail(`unsupported method ${method}()`);
    if (first && !LOCATING_METHODS.has(method)) this.fail(`${method}() needs a locator before it`);
    this.expect('(');
    const args: LocatorArg[] = [];
    this.skipSpace();
    if (this.peek() === ')') {
      this.i++;
      return { method, args };
    }
    for (;;) {
      args.push(this.parseValue());
      this.skipSpace();
      if (this.peek() === ',') {
        this.i++;
        this.skipSpace();
        if (this.peek() === ')') {
          this.i++;
          break;
        }
        continue;
      }
      this.expect(')');
      break;
    }
    return { method, args };
  }

  private parseValue(): LocatorArg {
    this.skipSpace();
    const ch = this.peek();
    if (ch === "'" || ch === '"' || ch === '`') return { type: 'string', value: this.parseString() };
    if (ch === '/') return this.parseRegex();
    if (ch === '{') return this.parseObject();
    if (ch !== undefined && /[-\d]/.test(ch)) {
      const m = /^-?\d+(?:\.\d+)?/.exec(this.src.slice(this.i));
      if (!m) this.fail('expected a number');
      this.i += m[0].length;
      return { type: 'number', value: Number(m[0]) };
    }
    const rest = this.src.slice(this.i);
    if (/^true\b/.test(rest)) {
      this.i += 4;
      return { type: 'boolean', value: true };
    }
    if (/^false\b/.test(rest)) {
      this.i += 5;
      return { type: 'boolean', value: false };
    }
    if (/^[A-Za-z_$]/.test(rest)) return { type: 'chain', chain: this.parseChain() };
    return this.fail('expected a value');
  }

  /** A quoted string, decoding the escapes `JSON.stringify` and JavaScript produce. */
  private parseString(): string {
    const quote = this.src[this.i]!;
    let out = '';
    this.i++;
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === quote) {
        this.i++;
        return out;
      }
      if (c !== '\\') {
        out += c;
        this.i++;
        continue;
      }
      const next = this.src[this.i + 1];
      if (next === undefined) break;
      const simple = SIMPLE_ESCAPES[next];
      if (simple !== undefined) {
        out += simple;
        this.i += 2;
        continue;
      }
      const hex =
        next === 'u' && this.src[this.i + 2] === '{'
          ? /^u\{([0-9a-fA-F]{1,6})\}/.exec(this.src.slice(this.i + 1))
          : next === 'u'
            ? /^u([0-9a-fA-F]{4})/.exec(this.src.slice(this.i + 1))
            : next === 'x'
              ? /^x([0-9a-fA-F]{2})/.exec(this.src.slice(this.i + 1))
              : null;
      if (hex) {
        out += String.fromCodePoint(parseInt(hex[1]!, 16));
        this.i += 1 + hex[0].length;
        continue;
      }
      if (next === 'u' || next === 'x') this.fail('malformed escape');
      // `\\`, `\'`, `\"`, `\/` and any other escaped character stand for themselves.
      out += next;
      this.i += 2;
    }
    return this.fail('unterminated string');
  }

  private parseRegex(): LocatorArg {
    let j = this.i + 1;
    let inClass = false;
    while (j < this.src.length) {
      const c = this.src[j]!;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      j++;
    }
    if (j >= this.src.length) this.fail('unterminated regex');
    const source = this.src.slice(this.i + 1, j);
    const flags = /^[a-z]*/.exec(this.src.slice(j + 1))![0];
    this.i = j + 1 + flags.length;
    return { type: 'regex', source, flags };
  }

  private parseObject(): LocatorArg {
    this.expect('{');
    const entries: Array<[string, LocatorArg]> = [];
    for (;;) {
      this.skipSpace();
      if (this.peek() === '}') {
        this.i++;
        break;
      }
      const ch = this.peek();
      const key = ch === "'" || ch === '"' ? this.parseString() : this.identifier();
      this.expect(':');
      entries.push([key, this.parseValue()]);
      this.skipSpace();
      if (this.peek() === ',') {
        this.i++;
        continue;
      }
      this.expect('}');
      break;
    }
    return { type: 'object', entries };
  }
}

/**
 * Parse a locator expression. A leading `page.` / `await page.` is ignored.
 * Throws {@link LocatorParseError} on anything outside the grammar.
 */
export function parseLocatorChain(expr: string): LocatorChain {
  const trimmed = expr.trim().replace(/^(?:await\s+)?(?:this\.)?page\./, '');
  if (!trimmed) throw new LocatorParseError('empty expression');
  return new Parser(trimmed).parseTopLevel();
}

/**
 * Read the chain at the start of `text`, stopping where it ends — before any
 * following text or link that doesn't parse. Returns the chain, each top-level
 * call's span in `text`, and where the chain ends; null when `text` does not
 * start with a locator call.
 */
export function scanLocatorChain(text: string): { chain: LocatorChain; spans: CallSpan[]; end: number } | null {
  const parser = new Parser(text);
  const spans: CallSpan[] = [];
  try {
    const chain = parser.parseChain({ lenient: true, spans });
    return { chain, spans, end: parser.position };
  } catch {
    return null;
  }
}

/** {@link parseLocatorChain}, returning null instead of throwing. */
export function tryParseLocatorChain(expr: string): LocatorChain | null {
  try {
    return parseLocatorChain(expr);
  } catch {
    return null;
  }
}

/**
 * Quote a string as a single-quoted JavaScript string literal, the way
 * Playwright prints it: `JSON.stringify`'s escapes (control characters as `\n`,
 * `\r`, `\u001b`, …) plus the line separators U+2028 and U+2029, so the literal
 * always stays on one line. Every locator text Piwi generates quotes its strings
 * with it, and {@link parseLocatorChain} reads them back.
 */
export function quoteJsString(value: string): string {
  const json = JSON.stringify(value).slice(1, -1);
  return `'${json
    .replace(/\\"/g, '"')
    .replace(/'/g, "\\'")
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}'`;
}

function renderArg(arg: LocatorArg): string {
  switch (arg.type) {
    case 'string':
      return quoteJsString(arg.value);
    case 'regex':
      return `/${arg.source}/${arg.flags}`;
    case 'number':
    case 'boolean':
      return String(arg.value);
    case 'object':
      return arg.entries.length === 0
        ? '{}'
        : `{ ${arg.entries.map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : quoteJsString(k)}: ${renderArg(v)}`).join(', ')} }`;
    case 'chain':
      return renderLocatorChain(arg.chain);
  }
}

/** Render a call in canonical form: single quotes, `{ key: value }` objects. */
function renderLocatorCall(call: LocatorCall): string {
  return `${call.method}(${call.args.map(renderArg).join(', ')})`;
}

/** Render a chain in canonical form, the same text Playwright prints for it. */
export function renderLocatorChain(chain: LocatorChain): string {
  return chain.calls.map(renderLocatorCall).join('.');
}

/** Canonical text of an expression, or null when it does not parse. */
export function canonicalLocator(expr: string): string | null {
  const chain = tryParseLocatorChain(expr);
  return chain ? renderLocatorChain(chain) : null;
}

/**
 * The call that picks the final element: the last locating call. Two chains
 * with the same target call but different containers
 * (`getByRole('form').getByLabel('Country')` and `getByLabel('Country')`)
 * aim at the same kind of element.
 */
export function locatorTarget(chain: LocatorChain): string {
  for (let i = chain.calls.length - 1; i >= 0; i--) {
    if (LOCATING_METHODS.has(chain.calls[i]!.method)) return renderLocatorCall(chain.calls[i]!);
  }
  return renderLocatorCall(chain.calls[0]!);
}

/**
 * The containers a chain searches inside: every prefix that ends right before
 * a locating call. `locator('.field').filter({ hasText: 'Country' }).locator('select')`
 * has one scope, `locator('.field').filter({ hasText: 'Country' })`.
 */
export function locatorScopes(chain: LocatorChain): string[] {
  const out: string[] = [];
  for (let i = 1; i < chain.calls.length; i++) {
    if (LOCATING_METHODS.has(chain.calls[i]!.method)) {
      out.push(renderLocatorChain({ calls: chain.calls.slice(0, i) }));
    }
  }
  return out;
}

/**
 * The call that picks the final element of an expression — its last locating
 * call, so `getByRole('row', { name: 'Acme' }).getByRole('button').first()` gives
 * `getByRole('button')`. Null when the expression does not parse.
 */
export function parseLeafLocatorCall(expr: string): LocatorCall | null {
  const chain = tryParseLocatorChain(expr);
  if (!chain) return null;
  for (let i = chain.calls.length - 1; i >= 0; i--) {
    if (LOCATING_METHODS.has(chain.calls[i]!.method)) return chain.calls[i]!;
  }
  return null;
}

/**
 * A call's arguments as the plain values a test passes: strings, numbers,
 * booleans and option objects, so `getByRole('button', { name: 'Pay' })` gives
 * `['button', { name: 'Pay' }]`. Nested locators are left out. Regexes are left
 * out too, or kept as their `/source/flags` text with `regexAsText`, for display.
 */
export function locatorCallValues(call: LocatorCall, opts: { regexAsText?: boolean } = {}): unknown[] {
  const value = (arg: LocatorArg): unknown => {
    switch (arg.type) {
      case 'string':
      case 'number':
      case 'boolean':
        return arg.value;
      case 'regex':
        return opts.regexAsText ? `/${arg.source}/${arg.flags}` : undefined;
      case 'object': {
        const out: Record<string, unknown> = {};
        for (const [key, v] of arg.entries) {
          const plain = value(v);
          if (plain !== undefined) out[key] = plain;
        }
        return out;
      }
      case 'chain':
        return undefined;
    }
  };
  return call.args.map(value).filter((v) => v !== undefined);
}
