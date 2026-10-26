/**
 * The coverage transform: the Rollup plugin the Nitro module adds to a coverage
 * build (`PIWI_COVERAGE_BUILD=true`). It runs after Nitro's own transforms, so
 * it reads JavaScript, and rewrites each application module so that:
 *
 * - the module registers with the coverage runtime (`__piwiModule`), with the
 *   payload length of each of its functions;
 * - each function, on entry, asks for its payload (`__pm.f(i)`: the request's
 *   being served, else the shared one) and marks entry 0;
 * - each statement marks its own entry before it runs;
 * - top-level statements mark the module's shared payload, the run level.
 *
 * The statements and functions are those `istanbul-lib-instrument` counts, and
 * a statement's line is its first line (a variable's, its initializer's), as
 * Istanbul and Vitest's coverage count them. Lines are mapped to the original
 * file through the combined source map at build time and written into the span
 * table the generated plugin hands to the runtime; a module carries only its
 * file id and payload lengths.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import MagicString from 'magic-string';
import { LEAST_UPPER_BOUND, TraceMap, originalPositionFor, type SourceMapInput } from '@jridgewell/trace-mapping';
import type { CoverageTable, CoverageTableFile, LineRange } from './coverage-runtime.js';

/** The id of the plugin the module generates to hand the span table to the runtime. */
export const COVERAGE_PLUGIN_ID = '#piwi/coverage';

/** What the generated plugin carries until the bundle is rendered, then the span table as JSON. */
const TABLE_PLACEHOLDER = '__PIWI_COVERAGE_TABLE__';
const TABLE_PLACEHOLDER_LITERAL = /(["'])__PIWI_COVERAGE_TABLE__\1/;

/** The source of the generated plugin: it hands the span table to the runtime at startup. */
export function coveragePluginSource(runtimePath: string): string {
  return [
    `import { enableCoverage } from ${JSON.stringify(runtimePath)};`,
    `export default function piwiCoverage() {`,
    `  enableCoverage(${JSON.stringify(TABLE_PLACEHOLDER)});`,
    `}`,
    '',
  ].join('\n');
}

/** An ESTree node as Rollup's parser returns it. */
interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** The statements Istanbul counts, besides variable declarators with an initializer. */
const STATEMENTS = new Set([
  'ExpressionStatement',
  'BreakStatement',
  'ContinueStatement',
  'DebuggerStatement',
  'ReturnStatement',
  'ThrowStatement',
  'TryStatement',
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'SwitchStatement',
  'WithStatement',
  'LabeledStatement',
]);

/** The node keys a statement's own body sits under: a statement there, if not a block, is wrapped in one. */
const BODY_KEYS = new Set(['consequent', 'alternate', 'body']);

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

/** A function being instrumented: its index in the module, and the position of each payload entry's statement. */
interface FunctionScope {
  index: number;
  /** The payload variable its statements write into. */
  payload: string;
  /** Per entry from 1, the source offset whose line it counts. */
  entries: number[];
}

export interface InstrumentResult {
  code: string;
  map: ReturnType<MagicString['generateMap']>;
  file: CoverageTableFile;
}

export interface InstrumentOptions {
  /** The file's id in the span table. */
  fileId: string;
  /** The import specifier of the coverage runtime. */
  runtime: string;
  /** Its path relative to the repository root, `/`-separated. */
  path: string;
  /** The checksums of its source, `sha256:<hex>`. */
  checksums: string[];
  /** The original line of a 1-based line and 0-based column of `code`; null when unknown. */
  originalLine: (line: number, column: number) => number | null;
}

/** Instrument one module's code, given its ESTree (`Program`). */
export function instrument(code: string, program: Node, options: InstrumentOptions): InstrumentResult {
  const out = new MagicString(code);
  const functions: Array<{ range: [number, number] | null; scope: FunctionScope }> = [];
  const top: FunctionScope = { index: 0, payload: '__pt', entries: [] };
  functions.push({ range: null, scope: top });

  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return options.originalLine(low + 1, offset - lineStarts[low]) ?? 0;
  };

  /** The markers a statement adds, or none: its entries are added to the scope. */
  const markersFor = (statement: Node, scope: FunctionScope): string => {
    let target = statement;
    if (statement.type === 'ExportNamedDeclaration' && isNode(statement.declaration)) target = statement.declaration;
    const offsets: number[] = [];
    if (target.type === 'VariableDeclaration') {
      for (const declarator of (target.declarations as Node[]) ?? []) {
        if (isNode(declarator.init)) offsets.push(declarator.init.start);
      }
    } else if (STATEMENTS.has(target.type)) {
      offsets.push(target.start);
    }
    let markers = '';
    for (const offset of offsets) {
      scope.entries.push(offset);
      markers += `${scope.payload}[${scope.entries.length}]=1;`;
    }
    return markers;
  };

  const visitList = (statements: Node[], scope: FunctionScope): void => {
    for (const statement of statements) {
      if (FUNCTIONS.has(statement.type)) {
        visitFunction(statement, null, '');
        continue;
      }
      const markers = markersFor(statement, scope);
      if (markers) out.appendLeft(statement.start, markers);
      visitChildren(statement, scope);
    }
  };

  const visitFunction = (fn: Node, parent: Node | null, key: string): void => {
    const isMethod =
      parent !== null &&
      key === 'value' &&
      (parent.type === 'MethodDefinition' || (parent.type === 'Property' && (parent.method || parent.kind !== 'init')));
    const start = isMethod ? parent.start : fn.start;
    const own: FunctionScope = { index: functions.length, payload: '__p', entries: [] };
    functions.push({ range: [start, Math.max(start, fn.end - 1)], scope: own });
    const prologue = `const __p=(__pm||__pmi()).f(${own.index});__p[0]=1;`;
    for (const param of (fn.params as Node[]) ?? []) visit(param, fn, 'params', own);
    const body = fn.body as Node;
    if (body.type === 'BlockStatement') {
      const statements = body.body as Node[];
      let at = body.start + 1;
      for (const statement of statements) {
        if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') break;
        at = statement.end;
      }
      out.appendLeft(at, prologue);
      visitList(
        statements.filter((statement) => typeof statement.directive !== 'string'),
        own,
      );
      return;
    }
    // An expression body: `x => expr` becomes `x => {…; return (expr)}`.
    own.entries.push(body.start);
    const arrow = code.lastIndexOf('=>', body.start);
    out.appendLeft(arrow + 2, `{${prologue}__p[1]=1;return (`);
    out.prependLeft(fn.end, ')}');
    visit(body, fn, 'body', own);
  };

  const visitChildren = (node: Node, scope: FunctionScope): void => {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) {
        if (node.type === 'SwitchCase' && key === 'consequent') {
          visitList(value.filter(isNode), scope);
          continue;
        }
        for (const item of value) if (isNode(item)) visit(item, node, key, scope);
      } else if (isNode(value)) {
        visit(value, node, key, scope);
      }
    }
  };

  const visit = (node: Node, parent: Node | null, key: string, scope: FunctionScope): void => {
    if (FUNCTIONS.has(node.type)) {
      visitFunction(node, parent, key);
      return;
    }
    if (node.type === 'BlockStatement' || node.type === 'StaticBlock') {
      visitList(node.body as Node[], scope);
      return;
    }
    // A statement standing as another's body (`if (a) b();`) is wrapped in a block to take its marker. A labeled
    // statement's body is left as it is, so `continue label` keeps its loop.
    if (
      parent !== null &&
      parent.type !== 'LabeledStatement' &&
      BODY_KEYS.has(key) &&
      (STATEMENTS.has(node.type) || node.type === 'VariableDeclaration') &&
      !FUNCTIONS.has(parent.type)
    ) {
      const markers = markersFor(node, scope);
      if (markers) {
        out.appendLeft(node.start, `{${markers}`);
        out.prependLeft(node.end, '}');
      }
    }
    visitChildren(node, scope);
  };

  const body = program.body as Node[];
  let at = 0;
  for (const statement of body) {
    if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') break;
    at = statement.end;
  }
  visitList(
    body.filter((statement) => typeof statement.directive !== 'string'),
    top,
  );

  const lengths = functions.map(({ scope }) => scope.entries.length + 1);
  // Before the top-level statements' markers, which may sit at the same offset.
  out.prependLeft(
    at,
    `import { __piwiModule as __piwiM } from ${JSON.stringify(options.runtime)};` +
      `var __pm;function __pmi(){return __pm=__piwiM(${JSON.stringify(options.fileId)},${JSON.stringify(lengths)});}` +
      `__pmi();var __pt=__pm.s[0];`,
  );

  const file: CoverageTableFile = {
    path: options.path,
    checksums: options.checksums,
    f: functions.map(({ range }) => {
      if (!range) return null;
      const first = lineOf(range[0]);
      const last = lineOf(range[1]);
      return first > 0 && last >= first ? ([first, last] as LineRange) : null;
    }),
    s: functions.map(({ scope }) => [0, ...scope.entries.map(lineOf)]),
  };
  return { code: out.toString(), map: out.generateMap({ hires: true, includeContent: false }), file };
}

/** The Rollup plugin context methods the transform uses. */
interface TransformContext {
  parse(code: string): unknown;
  getCombinedSourcemap(): SourceMapInput;
}

export interface CoveragePluginOptions {
  /** The repository root: paths are relative to it, and only files under it are instrumented. */
  root: string;
  /** The coverage runtime's file, imported by every instrumented module. */
  runtime: string;
  /** Directories whose files are never instrumented: the integration's own. */
  exclude: string[];
}

const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const GENERATED = /\/(?:node_modules|\.nitro|\.nuxt|\.output)\//;

/** Whether a module id is application code the transform instruments. */
export function instrumentable(id: string, options: CoveragePluginOptions): boolean {
  if (id.startsWith('\0') || id.includes('?')) return false;
  const path = id.replace(/\\/g, '/');
  const root = `${options.root.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  if (!path.startsWith(root) || GENERATED.test(path) || !SOURCE.test(path) || path.endsWith('.d.ts')) return false;
  return !options.exclude.some((dir) => path.startsWith(`${dir.replace(/\\/g, '/').replace(/\/$/, '')}/`));
}

/** The Rollup plugin of a coverage build. */
export function coverageRollupPlugin(options: CoveragePluginOptions) {
  const files = new Map<string, { fileId: string; file: CoverageTableFile }>();
  const root = `${options.root.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  return {
    name: 'piwi-coverage',
    transform(this: TransformContext, code: string, id: string) {
      if (!instrumentable(id, options)) return null;
      const path = id.replace(/\\/g, '/').slice(root.length);
      let source: Buffer;
      try {
        source = readFileSync(id);
      } catch {
        return null;
      }
      const fileId = createHash('sha256').update(path).digest('hex').slice(0, 16);
      const traced = new TraceMap(this.getCombinedSourcemap());
      const result = instrument(code, this.parse(code) as Node, {
        fileId,
        runtime: options.runtime,
        path,
        checksums: [`sha256:${createHash('sha256').update(source).digest('hex')}`],
        originalLine: (line, column) =>
          originalPositionFor(traced, { line, column }).line ??
          originalPositionFor(traced, { line, column, bias: LEAST_UPPER_BOUND }).line,
      });
      files.set(id, { fileId, file: result.file });
      return { code: result.code, map: result.map };
    },
    renderChunk(this: { getModuleIds(): IterableIterator<string> }, code: string) {
      const match = TABLE_PLACEHOLDER_LITERAL.exec(code);
      if (!match) return null;
      const live = new Set(this.getModuleIds());
      const table: CoverageTable = { v: 1, files: {} };
      for (const [id, { fileId, file }] of files) if (live.has(id)) table.files[fileId] = file;
      const out = new MagicString(code);
      out.overwrite(match.index, match.index + match[0].length, JSON.stringify(JSON.stringify(table)));
      return { code: out.toString(), map: out.generateMap({ hires: true }) };
    },
  };
}
