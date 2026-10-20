/**
 * Renders a `RecordedSession` as a runnable Playwright TypeScript spec.
 *
 * Two modes, one function: with no catalog, every step becomes a raw
 * `page.*` line (the extension's fully offline path — works with no Piwi
 * connection at all). With a catalog, `matchFunctionAt` (see
 * `function-match.ts`) greedily collapses a *contiguous* run of steps that
 * matches a function's whole pattern into a call against the project's own
 * page-object methods/helpers, leaving anything unmatched as raw lines — never
 * a partial or guessed call, and never a call that quietly swallows a step it
 * does not perform.
 *
 * This is the one place recorded steps become code. Every value is written as
 * an escaped literal, every locator is re-rendered from its parsed chain, and
 * every catalog identifier and the page expression are checked, so steps that
 * arrive from a file can shape the spec but never add code of their own. With
 * no options the output is the plain recorder export; the options adapt it to a
 * project (its `test` import, `baseURL`, stable locators, URL checks, test
 * details) and to where it goes (a file, a test, a test's body, the page the
 * lines run on).
 */
import {
  VALUE_MATCHERS,
  type RecordedSession,
  type RecordedStep,
  type RecordedTarget,
  type StepViewport,
} from './recording';
import { matchFunctionAt, type TestFunctionEntry, type RankedFunctionMatch } from './function-match';
import {
  quoteJsString,
  renderLocatorChain,
  tryParseLocatorChain,
  type LocatorArg,
  type LocatorChain,
} from './locator-chain';
import { assessLocatorChain, type LocatorStabilityLevel } from './locator-stability';
import { pageKey } from './page-key';

export interface CodegenOptions {
  /** Test title; defaults to a generic placeholder the user is expected to rename. */
  title?: string;
  /** When set, complete pattern matches against these entries collapse into function calls. */
  catalog?: TestFunctionEntry[];
  /** Module `test` and `expect` are imported from — a project's own fixtures file, for instance. `@playwright/test` by default. */
  testImport?: string;
  /** `absolute` (default) keeps recorded URLs; `relative` writes URLs on the recorded origin as paths, so the project's `baseURL` applies. */
  urls?: 'absolute' | 'relative';
  /** `first` (default) takes each target's best-ranked alternative; `stable` takes the first one `assessLocatorChain` rates stable, when there is one. */
  locators?: 'first' | 'stable';
  /** Canonical chains the project's tests already use. An alternative among them that is not brittle comes first. */
  preferLocators?: ReadonlySet<string>;
  /** After a step that leads to another page, wait for that page's URL before the next step. */
  urlChecks?: boolean;
  /** `env` reads every typed value from an environment variable named after its field (`E2E_EMAIL`, see `envPrefix`) instead of writing it into the spec. */
  values?: 'literal' | 'env';
  /**
   * What the environment variables typed values are read from start with: `E2E_` by default. Upper-case letters,
   * digits and underscores, starting with a letter; any other value is ignored.
   */
  envPrefix?: string;
  /** Mark the test as expected to fail (`test.fail()`), with an optional reason written beside it. */
  expectFail?: boolean | { reason: string };
  /** Test tags; a missing `@` is added. */
  tags?: string[];
  /** Test annotations, such as `{ type: 'piwi:bug', description: '37' }`. */
  annotations?: Array<{ type: string; description?: string }>;
  /**
   * `file` (default): imports and one test. `test`: the `test(…)` call alone, for a new test in an existing file.
   * `body`: only the test's lines, to paste into an existing test.
   */
  format?: 'file' | 'test' | 'body';
  /**
   * In the `test` and `body` formats, the imports a catalog call needs: `comments` (default) writes them first as
   * `// Needs: import …` lines, `none` leaves them out of `code` (they stay in `CodegenResult.imports`).
   */
  bodyImports?: 'comments' | 'none';
  /**
   * The expression every line runs on: the locators, navigation, key presses, URL checks and viewport sizes, a
   * helper's first argument and a page object's constructor. `page` by default; any expression `isPageExpression`
   * accepts, such as `adminPage`, `this.page` or `app.page`. In the `file` and `test` formats the test's parameter is
   * its first segment, so it cannot start with `this` there.
   */
  page?: string;
  /**
   * The names already declared where the code goes. A page object whose receiver is one of them is neither imported
   * nor instantiated: its calls use that variable.
   */
  declaredNames?: ReadonlySet<string>;
  /**
   * In the `file` and `test` formats, the fixtures the test can take (those the file's other tests take). A page
   * object whose receiver is one of them is taken as a fixture, after the page's, instead of being imported and
   * instantiated.
   */
  fixtures?: ReadonlySet<string>;
  /**
   * `page` wraps the lines of each page the steps go through in `await test.step('<path>', async () => { … })`, so a
   * report reads like the scenario; `none` (default) writes them one after another. The code needs `test` in scope.
   */
  testSteps?: 'none' | 'page';
}

type CodegenWarningCode =
  | 'no-locator'
  | 'brittle-locator'
  | 'redacted-value'
  | 'incomplete-assertion'
  | 'file-needed'
  | 'manual-step';

/** Something about a step the reader of the generated spec should check. */
export interface CodegenWarning {
  /** Index of the step in the session. */
  step: number;
  code: CodegenWarningCode;
  /**
   * The value the message names, for a reader that words the warning itself
   * from its code: the brittle locator, the environment variable of a redacted
   * value, the matcher an incomplete assertion lacks a value for, the names
   * of the files a file step needs, or what a manual step asks to do.
   */
  detail?: string;
  /** The warning in English. */
  message: string;
}

export interface CodegenResult {
  code: string;
  /**
   * The import lines the catalog calls in `code` need (`import { CartPage } from './pages/cart.page';`), deduped, in
   * the order the calls first appear; never the `test` and `expect` import. The `file` format writes them into `code`
   * too, the others as `// Needs:` comments unless `bodyImports` is `none`.
   */
  imports: string[];
  /** One entry per emitted line that came from a function match, keyed by the matched steps' first index — lets a UI highlight which recorded steps a given call represents. */
  matchedSpans: Array<{ startStep: number; endStep: number; functionName: string }>;
  warnings: CodegenWarning[];
  /**
   * The 1-based line of `code` each step starts on, by step index; the steps a
   * function call stands for share its line. Lets a run's failure line name the
   * step it failed at.
   */
  stepLines: number[];
}

/**
 * A line terminator inside a single-quoted literal is a syntax error, not a
 * newline — and a recorded value reaches codegen unnormalized (`normalizeSteps`
 * collapses whitespace on a target's *text*, never on the value the user typed),
 * so a multi-line paste into a textarea is escaped for the exported spec to parse.
 */
const quote = quoteJsString;

const LINE_TERMINATORS = /[\n\r\u2028\u2029]/;

function argIsSafe(arg: LocatorArg): boolean {
  switch (arg.type) {
    case 'regex':
      // Rendered as a literal: it must be a valid pattern on one line. An empty
      // source would start a comment, and `new RegExp` refuses a leading `*`.
      if (!arg.source || LINE_TERMINATORS.test(arg.source)) return false;
      try {
        new RegExp(arg.source, arg.flags);
        return true;
      } catch {
        return false;
      }
    case 'object':
      return arg.entries.every(([, value]) => argIsSafe(value));
    case 'chain':
      return chainIsSafe(arg.chain);
    default:
      return true;
  }
}

function chainIsSafe(chain: LocatorChain): boolean {
  return chain.calls.length > 0 && chain.calls.every((call) => call.args.every(argIsSafe));
}

/**
 * A locator expression as code the spec can hold: parsed with the chain grammar
 * (a fixed list of Playwright methods, literal arguments only), checked, and
 * rendered back in canonical form. Null for anything else — the text a step
 * carries is never pasted into the spec as it is.
 */
export function safeLocator(expr: string): { chain: LocatorChain; text: string } | null {
  const chain = tryParseLocatorChain(expr);
  if (!chain || !chainIsSafe(chain)) return null;
  return { chain, text: renderLocatorChain(chain) };
}

interface ChosenLocator {
  text: string;
  level: LocatorStabilityLevel;
}

/**
 * The locator a step's target is written with. Alternatives come ranked best
 * first; a chain the suite already uses wins when it is not brittle, then, with
 * `locators: 'stable'`, the first chain rated stable, then the first chain.
 */
function chooseLocator(target: RecordedTarget | null, options: CodegenOptions): ChosenLocator | null {
  if (!target) return null;
  const candidates = target.alternatives.flatMap((alt) => {
    const safe = safeLocator(alt.locator);
    return safe ? [safe] : [];
  });
  if (candidates.length === 0) return null;
  const levels = new Map<string, LocatorStabilityLevel>();
  const levelOf = (c: { chain: LocatorChain; text: string }): LocatorStabilityLevel => {
    let level = levels.get(c.text);
    if (!level) {
      level = assessLocatorChain(c.chain).level;
      levels.set(c.text, level);
    }
    return level;
  };
  const prefer = options.preferLocators;
  if (prefer && prefer.size > 0) {
    const known = candidates.find((c) => prefer.has(c.text) && levelOf(c) !== 'brittle');
    if (known) return { text: known.text, level: levelOf(known) };
  }
  if (options.locators === 'stable') {
    const stable = candidates.find((c) => levelOf(c) === 'stable');
    if (stable) return { text: stable.text, level: 'stable' };
  }
  const first = candidates[0]!;
  return { text: first.text, level: levelOf(first) };
}

/**
 * The locator a spec writes for a step's target, as `renderSpec` chooses it
 * with the same options; null when no alternative can be written. A replay
 * uses it to act on the element the spec would.
 */
export function stepLocator(
  target: RecordedTarget | null,
  options: Pick<CodegenOptions, 'locators' | 'preferLocators'> = {},
): string | null {
  return chooseLocator(target, options)?.text ?? null;
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Placeholder segments `pageKey` puts in place of ids and tokens. */
const PLACEHOLDER_SEGMENT = /^:(?:id|uuid|ulid|token|jwt)$/;

/**
 * A regex literal that matches any URL of the same page: the page key's path,
 * with each id or token segment open, followed by the end, a query or a hash.
 * Null for a URL that is not a web page.
 */
export function pageUrlPattern(url: string): string | null {
  const key = pageKey(url);
  if (key === null) return null;
  if (key === '/') return String.raw`/:\/\/[^/]+\/?(?:[?#]|$)/`;
  const body = key
    .slice(1)
    .split('/')
    .map((segment) => (PLACEHOLDER_SEGMENT.test(segment) ? '[^/?#]+' : segment.replace(/[^A-Za-z0-9_]/g, '\\$&')))
    .join('\\/');
  return `/\\/${body}(?:[?#]|$)/`;
}

/** A comment's text on one line. */
function commentText(s: string): string {
  return s.replace(/[\n\r\u2028\u2029]+/g, ' ').trim();
}

interface RenderContext {
  options: CodegenOptions;
  /** The origin the steps were recorded on, when they have one. */
  origin: string | null;
  /** The expression every line runs on. */
  page: string;
  warnings: CodegenWarning[];
  /** Environment variables the spec reads typed values from, in step order. */
  envNames: string[];
}

/** The most characters a field's name gives an environment variable, after its prefix. */
const ENV_NAME_MAX = 40;

/** The prefix `envPrefix` names when it is a valid one, else `E2E_`. */
function envPrefixOf(options: Pick<CodegenOptions, 'envPrefix'>): string {
  const prefix = options.envPrefix;
  return typeof prefix === 'string' && ENV_PREFIX.test(prefix) ? prefix : 'E2E_';
}

/** What an environment variable prefix may hold. */
const ENV_PREFIX = /^[A-Z][A-Z0-9_]*$/;

/**
 * The name of the environment variable a step's typed value is read from,
 * before it is made unique: the prefix (`E2E_` by default) and its field's
 * accessible name, else its test id, else its text, in upper case with
 * diacritics removed and every run of other characters than letters and
 * digits as one `_`; the prefix and `VALUE` when none of them leaves a letter
 * or a digit.
 */
function envNameOf(target: RecordedTarget | null, prefix: string): string {
  for (const source of [target?.accessibleName, target?.testId, target?.text]) {
    const name = (source ?? '')
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, ENV_NAME_MAX)
      .replace(/_+$/, '');
    if (name) return `${prefix}${name}`;
  }
  return `${prefix}VALUE`;
}

/** `name` when no earlier step reads it, else the first of `name_2`, `name_3`… that none does. */
function uniqueEnvName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  let n = 2;
  while (taken.includes(`${name}_${n}`)) n++;
  return `${name}_${n}`;
}

/**
 * The environment variable the typed value of the fill at `index` is read
 * from, named after its field and unique in the test, with a warning when it
 * was typed in a password field.
 */
function envVarFor(step: RecordedStep, index: number, ctx: RenderContext): string {
  const envVar = uniqueEnvName(envNameOf(step.target, envPrefixOf(ctx.options)), ctx.envNames);
  ctx.envNames.push(envVar);
  if (step.redacted) {
    ctx.warnings.push({
      step: index,
      code: 'redacted-value',
      detail: envVar,
      message: `A password was typed here; the spec reads it from ${envVar}.`,
    });
  }
  return envVar;
}

/** Whether the typed value of `step` is read from the environment: a fill in a password field, or every fill with `values: 'env'`. */
function readsEnv(step: RecordedStep, ctx: RenderContext): boolean {
  return step.action === 'fill' && (step.redacted || ctx.options.values === 'env');
}

/** A URL as the spec writes it: a path when `urls: 'relative'` and it is on the recorded origin, absolute otherwise. */
function urlForCode(url: string, ctx: RenderContext): string {
  const isPath = url.startsWith('/');
  if (ctx.options.urls === 'relative') {
    if (isPath || !ctx.origin) return url;
    try {
      const parsed = new URL(url);
      return parsed.origin === ctx.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : url;
    } catch {
      return url;
    }
  }
  return isPath && ctx.origin ? `${ctx.origin}${url}` : url;
}

function locatorForStep(step: RecordedStep, index: number, ctx: RenderContext): string {
  const chosen = chooseLocator(step.target, ctx.options);
  if (!chosen) {
    ctx.warnings.push({ step: index, code: 'no-locator', message: 'No locator was captured for this element.' });
    return `${ctx.page}.locator(${quote('/* no locator captured */')})`;
  }
  if (chosen.level === 'brittle') {
    ctx.warnings.push({
      step: index,
      code: 'brittle-locator',
      detail: chosen.text,
      message: `The best locator captured for this element is brittle: ${chosen.text}`,
    });
  }
  return `${ctx.page}.${chosen.text}`;
}

function renderAssertStep(step: RecordedStep, index: number, ctx: RenderContext): string[] {
  const assertion = step.action === 'assertVisible' ? null : step.assertion;
  if (step.action === 'assert' && !assertion) {
    ctx.warnings.push({ step: index, code: 'incomplete-assertion', message: 'This assertion has nothing to check.' });
    return [`  // Step ${index + 1}: an assertion with nothing to check.`];
  }
  const matcher = assertion?.matcher ?? 'toBeVisible';
  const not = assertion?.negated ? '.not' : '';
  const lines: string[] = [];
  if (assertion?.note) lines.push(`  // ${commentText(assertion.note)}`);
  let arg = '';
  if (VALUE_MATCHERS.has(matcher)) {
    if (assertion?.expected == null) {
      ctx.warnings.push({
        step: index,
        code: 'incomplete-assertion',
        detail: matcher,
        message: `${matcher} needs an expected value.`,
      });
      return [`  // Step ${index + 1}: ${matcher} without an expected value.`];
    }
    arg =
      matcher === 'toHaveCount'
        ? String(Number.parseInt(assertion.expected, 10) || 0)
        : quote(matcher === 'toHaveURL' ? urlForCode(assertion.expected, ctx) : assertion.expected);
  }
  const subject = matcher === 'toHaveURL' ? ctx.page : locatorForStep(step, index, ctx);
  let line = `  await expect(${subject})${not}.${matcher}(${arg});`;
  if (assertion?.actual != null && assertion.actual !== assertion.expected) {
    line += ` // recorded: ${quote(assertion.actual)}`;
  }
  lines.push(line);
  return lines;
}

/** The file names a `setInputFiles` step holds, one per line, without any directory. */
export function fileNames(value: string | null): string[] {
  return (value ?? '')
    .split('\n')
    .map((name) => name.trim().replace(/^.*[\\/]/, ''))
    .filter(Boolean);
}

/**
 * A manual step as a comment, never as code: what to do, and the call it
 * stands for and where it is in the test when the step says.
 */
function renderManualStep(step: RecordedStep, index: number, ctx: RenderContext): string[] {
  const description = commentText(step.manual?.description ?? '') || 'a step to do by hand';
  ctx.warnings.push({
    step: index,
    code: 'manual-step',
    detail: description,
    message: `Step ${index + 1} cannot be written as code: ${description}`,
  });
  const lines = [`  // Manual step: ${description}`];
  const call = step.manual?.call ? commentText(step.manual.call) : '';
  const location = step.manual?.location ? commentText(step.manual.location) : '';
  if (call || location) lines.push(`  //   ${[call, location ? `at ${location}` : ''].filter(Boolean).join(' ')}`);
  return lines;
}

function renderRawStep(step: RecordedStep, index: number, ctx: RenderContext): string[] {
  const { page } = ctx;
  if (step.action === 'goto') return [`  await ${page}.goto(${quote(urlForCode(step.value ?? step.pageUrl, ctx))});`];
  if (step.action === 'assert' || step.action === 'assertVisible') return renderAssertStep(step, index, ctx);
  if (step.action === 'manual') return renderManualStep(step, index, ctx);
  if (step.action === 'press' && !step.target) {
    return [`  await ${page}.keyboard.press(${quote(step.value ?? 'Enter')});`];
  }
  const loc = locatorForStep(step, index, ctx);
  switch (step.action) {
    case 'click':
      return [`  await ${loc}.click();`];
    case 'dblclick':
      return [`  await ${loc}.dblclick();`];
    case 'dragTo': {
      const to = locatorForStep({ ...step, target: step.dropTarget ?? null }, index, ctx);
      return [`  await ${loc}.dragTo(${to});`];
    }
    case 'setInputFiles': {
      const names = fileNames(step.value);
      if (names.length === 0) return [`  await ${loc}.setInputFiles([]);`];
      ctx.warnings.push({
        step: index,
        code: 'file-needed',
        detail: names.join(', '),
        message: `A file was chosen here (${names.join(', ')}); the spec reads it from the directory Playwright runs in.`,
      });
      const files = names.length === 1 ? quote(names[0]!) : `[${names.map(quote).join(', ')}]`;
      return [`  await ${loc}.setInputFiles(${files});`];
    }
    case 'hover':
      return [`  await ${loc}.hover();`];
    case 'fill': {
      if (readsEnv(step, ctx)) return [`  await ${loc}.fill(process.env.${envVarFor(step, index, ctx)} ?? '');`];
      return [`  await ${loc}.fill(${quote(step.value ?? '')});`];
    }
    case 'check':
      return [`  await ${loc}.check();`];
    case 'uncheck':
      return [`  await ${loc}.uncheck();`];
    case 'selectOption':
      return [`  await ${loc}.selectOption(${quote(step.value ?? '')});`];
    case 'press':
      return [`  await ${loc}.press(${quote(step.value ?? 'Enter')});`];
  }
}

/** A bare identifier can be an object key as-is; anything else has to be quoted. */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Whether a catalog entry's own names are safe to emit unquoted.
 *
 * `name`, `receiver` and `importName` are interpolated straight into the
 * generated source — `import { X } from …`, `new X(page)`, `await r.name()` —
 * so anything that is not a plain identifier is arbitrary code, not a call. The
 * API validates these on the way in; this is the second line of defence, on the
 * way out, because a catalog can also be filled by the MCP tool from an agent
 * reading repository source, and the generated spec's whole promise is that it
 * is deterministic rather than invented. An entry that fails this is skipped for
 * matching entirely, so its steps come out as ordinary locator lines.
 */
export function callIdentifiersAreSafe(entry: TestFunctionEntry): boolean {
  if (!IDENTIFIER_RE.test(entry.name)) return false;
  if (entry.kind !== 'page-object-method') return true;
  if (entry.receiver != null && !IDENTIFIER_RE.test(entry.receiver)) return false;
  if (entry.importName != null && !IDENTIFIER_RE.test(entry.importName)) return false;
  return true;
}

/** JavaScript's reserved words and literals: none of them but `this` can start a page expression. */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

/**
 * Whether `text` can be the expression the lines run on (`CodegenOptions.page`):
 * `this` or an identifier, followed by any number of `.identifier` segments,
 * such as `page`, `adminPage`, `this.page` or `app.page`. It is written into
 * the spec as it is, so nothing else passes.
 */
export function isPageExpression(text: string): boolean {
  if (typeof text !== 'string') return false;
  const segments = text.split('.');
  return (
    segments.every((segment) => IDENTIFIER_RE.test(segment)) &&
    (segments[0] === 'this' || !RESERVED_WORDS.has(segments[0]!))
  );
}

/**
 * The page expression a rendering writes: `options.page`, `page` by default.
 * A `RangeError` for one `isPageExpression` refuses, and in the `file` and
 * `test` formats, whose test takes the expression's first segment as its
 * parameter, for one that starts with `this`.
 */
function pageExpression(options: CodegenOptions): string {
  const page = options.page ?? 'page';
  if (!isPageExpression(page)) {
    throw new RangeError(
      `Not a page expression (an identifier or a member chain such as app.page): ${JSON.stringify(page)}`,
    );
  }
  if (options.format !== 'body' && page.split('.')[0] === 'this') {
    throw new RangeError(
      `The ${options.format ?? 'file'} format takes the test's parameter from the page expression, which starts with this: ${JSON.stringify(page)}`,
    );
  }
  return page;
}

/**
 * An `object` param renders as a literal built from whichever of its `fields`
 * resolved — unresolved fields are *omitted* rather than emitted empty, since
 * an options bag's fields are typically optional and a missing key type-checks
 * where `label: ''` would silently target nothing.
 */
function objectArgExpr(
  param: TestFunctionEntry['params'][number],
  match: RankedFunctionMatch,
  envArgs: ReadonlyMap<string, string>,
): string {
  const entries = (param.fields ?? [])
    .map((field) => {
      const key = `${param.name}.${field}`;
      const env = envArgs.get(key);
      const raw = match.args[key];
      if (env == null && raw == null) return null;
      return `${IDENTIFIER_RE.test(field) ? field : quote(field)}: ${env ?? quote(raw!)}`;
    })
    .filter((pair): pair is string => pair != null);
  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
}

/**
 * The arguments of a call that read a typed value from the environment, by
 * `args` key (`password`, or `credentials.password` for an object's field):
 * each string value the call takes from a fill `readsEnv` sends there, read
 * from the variable a raw fill would read.
 */
function envArgsOf(match: RankedFunctionMatch, steps: RecordedStep[], ctx: RenderContext): Map<string, string> {
  const envArgs = new Map<string, string>();
  const params = new Map(match.entry.params.map((p) => [p.name, p]));
  const sources = match.entry.paramSources
    .filter((source) => source.from === 'value')
    .sort((a, b) => a.stepIndex - b.stepIndex);
  for (const source of sources) {
    const type = params.get(source.param)?.type;
    if (source.path ? type !== 'object' : type !== 'string') continue;
    const index = match.matchedIndices[source.stepIndex];
    const step = index == null ? undefined : steps[index];
    if (index == null || !step || !readsEnv(step, ctx)) continue;
    const key = source.path ? `${source.param}.${source.path}` : source.param;
    if (!envArgs.has(key)) envArgs.set(key, `process.env.${envVarFor(step, index, ctx)} ?? ''`);
  }
  return envArgs;
}

function argExpr(entry: TestFunctionEntry, match: RankedFunctionMatch, envArgs: ReadonlyMap<string, string>): string {
  return entry.params
    .map((p) => {
      if (p.type === 'object') return objectArgExpr(p, match, envArgs);
      const env = envArgs.get(p.name);
      if (env != null) return env;
      const raw = match.args[p.name];
      if (raw == null) return p.type === 'number' ? '0' : p.type === 'boolean' ? 'false' : "''";
      if (p.type === 'number') return String(Number(raw) || 0);
      if (p.type === 'boolean') return String(raw === 'true' || raw === '1');
      return quote(raw);
    })
    .join(', ');
}

function renderFunctionCall(match: RankedFunctionMatch, page: string, envArgs: ReadonlyMap<string, string>): string {
  const { entry } = match;
  const args = argExpr(entry, match, envArgs);
  if (entry.kind === 'page-object-method' && entry.receiver) {
    return `  await ${entry.receiver}.${entry.name}(${args});`;
  }
  return `  await ${entry.name}(${page}${args ? `, ${args}` : ''});`;
}

/** One `import` + (for page-object methods) one instantiation line per receiver actually used, deduped, in first-use order. */
/** One import per function or page-object class used, in first-use order, except the page objects at hand (`given`). */
function renderImports(usedEntries: TestFunctionEntry[], given: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  const seenModules = new Set<string>();
  for (const entry of usedEntries) {
    if (entry.kind === 'page-object-method' && entry.receiver && entry.importName) {
      if (given.has(entry.receiver)) continue;
      const moduleKey = `${entry.module}#${entry.importName}`;
      if (!seenModules.has(moduleKey)) {
        seenModules.add(moduleKey);
        lines.push(`import { ${entry.importName} } from ${quote(entry.module)};`);
      }
    } else if (!seenModules.has(entry.module + entry.name)) {
      seenModules.add(entry.module + entry.name);
      lines.push(`import { ${entry.name} } from ${quote(entry.module)};`);
    }
  }
  return lines;
}

/** One instantiation line per page-object receiver used, in first-use order, except the receivers in `declared`. */
function renderInstantiations(
  usedEntries: TestFunctionEntry[],
  page: string,
  declared: ReadonlySet<string> | undefined,
): string[] {
  const seen = new Set<string>(declared);
  const lines: string[] = [];
  for (const entry of usedEntries) {
    if (entry.kind !== 'page-object-method' || !entry.receiver || !entry.importName) continue;
    if (seen.has(entry.receiver)) continue;
    seen.add(entry.receiver);
    lines.push(`  const ${entry.receiver} = new ${entry.importName}(${page});`);
  }
  return lines;
}

/** Test details (`tag`, `annotation`) as the lines of an object literal, or none. */
function renderDetails(options: CodegenOptions): string[] {
  const tags = (options.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const annotations = (options.annotations ?? []).filter((a) => a.type.trim());
  const lines: string[] = [];
  if (tags.length > 0) lines.push(`  tag: [${tags.map((t) => quote(t.startsWith('@') ? t : `@${t}`)).join(', ')}],`);
  if (annotations.length > 0) {
    lines.push('  annotation: [');
    for (const a of annotations) {
      const description = a.description != null ? `, description: ${quote(a.description)}` : '';
      lines.push(`    { type: ${quote(a.type)}${description} },`);
    }
    lines.push('  ],');
  }
  return lines;
}

function expectFailLine(options: CodegenOptions): string | null {
  if (!options.expectFail) return null;
  const reason = typeof options.expectFail === 'object' ? commentText(options.expectFail.reason) : '';
  return reason ? `  test.fail(); // ${reason}` : '  test.fail();';
}

/** Whether two recorded pages are the same, by page key; a page that is not known (empty) matches any. */
function samePage(a: string, b: string): boolean {
  if (!a || !b) return true;
  const ka = pageKey(a);
  const kb = pageKey(b);
  return ka === null || kb === null || ka === kb;
}

/** `setViewportSize` on the page for a viewport the steps were recorded at. */
function viewportLine(viewport: StepViewport, page: string): string {
  return `  await ${page}.setViewportSize({ width: ${Math.round(viewport.width)}, height: ${Math.round(viewport.height)} });`;
}

/** The title of the `test.step` for a page: its path, with its host when it is not on the recorded origin. */
function pageStepTitle(url: string, origin: string | null): string {
  if (url.startsWith('/')) return url.split(/[?#]/)[0] || '/';
  try {
    const parsed = new URL(url);
    return parsed.origin === origin ? parsed.pathname : `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/**
 * `lines` with the lines from each start up to the next one wrapped in a `test.step` titled after its page, one
 * level deeper, and where each line went: `at(i)` is the new index of `lines[i]`.
 */
function wrapInPageSteps(
  lines: string[],
  starts: Array<{ line: number; url: string }>,
  origin: string | null,
): { lines: string[]; at: (index: number) => number } {
  if (starts.length === 0) return { lines, at: (index) => index };
  const out: string[] = lines.slice(0, starts[0]!.line);
  starts.forEach((start, n) => {
    const end = starts[n + 1]?.line ?? lines.length;
    out.push(`  await test.step(${quote(pageStepTitle(start.url, origin))}, async () => {`);
    out.push(...lines.slice(start.line, end).map((line) => `  ${line}`));
    out.push('  });');
  });
  const at = (index: number): number => {
    const opened = starts.filter((start) => start.line <= index).length;
    return opened === 0 ? index : index + 2 * opened - 1;
  };
  return { lines: out, at };
}

export function renderSpec(session: RecordedSession, options: CodegenOptions = {}): CodegenResult {
  const page = pageExpression(options);
  const { steps } = session;
  /** The viewport each step starts at, when it changes there. */
  const viewportAt = new Map((session.viewports ?? []).map((v) => [v.step, v]));
  const title = options.title ?? 'recorded flow';
  const catalog = (options.catalog ?? []).filter(callIdentifiersAreSafe);
  const ctx: RenderContext = {
    options,
    origin: originOf(session.startUrl) ?? originOf(steps[0]?.pageUrl ?? ''),
    page,
    warnings: [],
    envNames: [],
  };

  const bodyLines: string[] = [];
  const matchedSpans: CodegenResult['matchedSpans'] = [];
  const usedEntries: TestFunctionEntry[] = [];
  /** The index in `bodyLines` each step starts at. */
  const stepStarts: number[] = [];
  /** With `testSteps: 'page'`, where in `bodyLines` each page's lines start, and its URL. */
  const pageStarts: Array<{ line: number; url: string }> = [];
  /** Starts a page's `test.step` at the next line when the step at `index` is on another page than the last one. */
  const enterPageOf = (index: number): void => {
    const url = steps[index]?.pageUrl;
    if (options.testSteps !== 'page' || !url) return;
    const last = pageStarts[pageStarts.length - 1];
    if (!last || !samePage(last.url, url)) pageStarts.push({ line: bodyLines.length, url });
  };

  /**
   * After the step at `last`, wait for the next step's page when the next step
   * is on another one: its URL, then its element as the only match. An app
   * can keep the previous page on screen a moment after the address changes,
   * while the next one loads; an action fails at once on a locator that
   * matches there too, where `toHaveCount` waits for the old page to go. Only
   * between two lines of the steps' own: a catalog call on either side waits
   * for its pages itself.
   */
  const checkNextPage = (last: number): void => {
    if (!options.urlChecks) return;
    const next = steps[last + 1];
    const current = steps[last];
    if (!next || !current || next.action === 'goto' || samePage(current.pageUrl, next.pageUrl)) return;
    const pattern = pageUrlPattern(next.pageUrl);
    // The wait for the next page is that page's first line.
    enterPageOf(last + 1);
    if (pattern) bodyLines.push(`  await expect(${page}).toHaveURL(${pattern});`);
    const acts = next.action !== 'assert' && next.action !== 'assertVisible' && next.action !== 'manual';
    const chosen = acts && next.target ? chooseLocator(next.target, options) : null;
    if (chosen) bodyLines.push(`  await expect(${page}.${chosen.text}).toHaveCount(1);`);
  };

  /** The catalog call that stands for the steps from `at`, if any, by start. */
  const calls = new Map<number, RankedFunctionMatch | null>();
  const callAt = (at: number): RankedFunctionMatch | null => {
    if (calls.has(at)) return calls.get(at)!;
    const step = steps[at];
    const found = step && step.action !== 'goto' && catalog.length > 0 ? matchFunctionAt(steps, at, catalog) : null;
    // A call cannot resize the page between the steps it stands for: those steps stay raw lines.
    const match =
      found && ![...viewportAt.keys()].some((v) => v > at && v <= Math.max(...found.matchedIndices)) ? found : null;
    calls.set(at, match);
    return match;
  };

  let pos = 0;
  let sawGoto = false;
  while (pos < steps.length) {
    const step = steps[pos]!;

    enterPageOf(pos);
    const viewport = pos > 0 ? viewportAt.get(pos) : undefined;
    if (viewport) bodyLines.push(viewportLine(viewport, page));
    stepStarts[pos] = bodyLines.length;
    if (step.action === 'goto') {
      bodyLines.push(...renderRawStep(step, pos, ctx));
      sawGoto = true;
      pos++;
      continue;
    }

    const match = callAt(pos);
    if (match) {
      bodyLines.push(renderFunctionCall(match, page, envArgsOf(match, steps, ctx)));
      usedEntries.push(match.entry);
      const last = Math.max(...match.matchedIndices);
      for (let i = pos + 1; i <= last; i++) stepStarts[i] = stepStarts[pos]!;
      matchedSpans.push({ startStep: pos, endStep: last, functionName: match.entry.name });
      pos = last + 1;
      continue;
    }

    bodyLines.push(...renderRawStep(step, pos, ctx));
    if (!callAt(pos + 1)) checkNextPage(pos);
    pos++;
  }

  // The size the steps were recorded at comes first, before the first page opens.
  const start = viewportAt.get(0);
  const opening = [
    ...(start ? [viewportLine(start, page)] : []),
    ...(!sawGoto && session.startUrl ? [`  await ${page}.goto(${quote(urlForCode(session.startUrl, ctx))});`] : []),
  ];
  bodyLines.unshift(...opening);
  const bodyOffset = opening.length;
  // The opening lines go into the first page's step.
  const wrapped = wrapInPageSteps(
    bodyLines,
    pageStarts.map((start, n) => ({ line: n === 0 ? 0 : start.line + bodyOffset, url: start.url })),
    ctx.origin,
  );

  /** The page-object receivers the test takes as fixtures, in first-use order. */
  const fixtureReceivers =
    options.format === 'body'
      ? []
      : [
          ...new Set(
            usedEntries.flatMap((e) =>
              e.kind === 'page-object-method' && e.receiver && options.fixtures?.has(e.receiver) ? [e.receiver] : [],
            ),
          ),
        ];
  const given = new Set([...(options.declaredNames ?? []), ...fixtureReceivers]);
  const importLines = renderImports(usedEntries, given);
  const instantiationLines = renderInstantiations(usedEntries, page, given);
  const failLine = expectFailLine(options);
  const envLines =
    options.values === 'env' && ctx.envNames.length > 0
      ? [`  // Typed values come from ${[...new Set(ctx.envNames)].join(', ')}.`]
      : [];
  const testBody = [...(failLine ? [failLine] : []), ...envLines, ...instantiationLines, ...wrapped.lines];
  const bodyStart = testBody.length - wrapped.lines.length;
  /** The rendering of `lines`, whose test body starts after its first `header` lines. */
  const result = (lines: string[], header: number): CodegenResult => ({
    code: lines.join('\n'),
    imports: importLines,
    matchedSpans,
    warnings: ctx.warnings,
    stepLines: steps.map((_, i) => header + bodyStart + wrapped.at(bodyOffset + (stepStarts[i] ?? 0)) + 1),
  });
  /** The imports as the comments the `body` and `test` formats start with, at `indent`. */
  const needsLines = (indent: string): string[] =>
    options.bodyImports === 'none' ? [] : importLines.map((line) => `${indent}// Needs: ${line}`);

  if (options.format === 'body') {
    const needs = needsLines('  ');
    return result([...needs, ...testBody, ''], needs.length);
  }

  const details = renderDetails(options);
  const fixture = [...new Set([page.split('.')[0]!, ...fixtureReceivers])].join(', ');
  const testOpening =
    details.length > 0
      ? [`test(${quote(title)}, {`, ...details, `}, async ({ ${fixture} }) => {`]
      : [`test(${quote(title)}, async ({ ${fixture} }) => {`];

  if (options.format === 'test') {
    const needs = needsLines('');
    return result([...needs, ...testOpening, ...testBody, `});`, ``], needs.length + testOpening.length);
  }

  const lines = [
    // Package name interpolated rather than adjoining the preceding keyword
    // directly, so this generated-code line does not itself look like a real
    // import to the boundary test in tests/boundary.test.ts.
    `import { test, expect } from ${quote(options.testImport?.trim() || '@playwright/test')};`,
    ...importLines,
    ``,
    ...testOpening,
    ...testBody,
    `});`,
    ``,
  ];

  return result(lines, 1 + importLines.length + 1 + testOpening.length);
}
