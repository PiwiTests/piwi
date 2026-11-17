import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseSfc } from '@vue/compiler-sfc';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Text written straight into a Vue app's UI, bypassing its catalogs: a string or template literal with a letter in it
 *
 * - written as text in a template, outside `<code>`, `<pre>` and `<kbd>`;
 * - given to a text attribute (`title`, `label`, `description`, `placeholder`, `aria-label`, `alt`, and `text`, `hint`,
 *   `help`, `filename` of Nuxt UI's and the layer's components), as a static value or in a bound expression;
 * - passed to `emit` after the event's name, or to `announce`: what a live region reads out;
 * - written in a template's `{{ … }}`;
 * - given to an object's `title`, `description`, `label`, `message`, `placeholder`, `hint` or `help`, in a script (a
 *   toast, an answer) or in a template's expression (`:items="[{ label: … }]"`).
 *
 * Text a table holds under another name (`{ running: 'Running' }`) or a function returns is the reviewer's to catch.
 *
 * The walk of an expression follows `? :`, `??`, `||`, `&&`, `+` and template parts, and stops at calls: `t('key')` is
 * a call. A static attribute whose value is an address (`https://…`) is an example, and a literal shaped as a catalog's
 * key (`runui_requestRun`) names a message, and a product's name is never translated: none of them is text.
 */

/** The parts of a template's AST the scan reads (`@vue/compiler-core`'s node types). */
interface TemplateNode {
  type: number;
  loc: { start: { line: number } };
  content?: string | { type: number; content: string };
  tag?: string;
  props?: Array<{
    type: number;
    name: string;
    loc: { start: { line: number } };
    value?: { content: string };
    arg?: { type: number; content: string };
    exp?: { type: number; content: string };
  }>;
  children?: TemplateNode[];
}

export interface UiTextFinding {
  line: number;
  text: string;
}

const TEXT_ATTRIBUTES = new Set([
  'title',
  'label',
  'description',
  'placeholder',
  'aria-label',
  'alt',
  'text',
  'hint',
  'help',
  'filename',
]);
/** Calls whose arguments after the first are said to the person: an event a host announces (`emit('announce', …)`). */
const SAYING_CALLS = new Set(['emit', 'announce']);
const TEXT_PROPERTIES = new Set(['title', 'description', 'label', 'message', 'placeholder', 'hint', 'help']);
const CODE_ELEMENTS = new Set(['code', 'pre', 'kbd']);
const LETTER = /\p{L}/u;
const ADDRESS = /^https?:\/\//;
const CATALOG_KEY = /^[a-z]+_[A-Za-z0-9_]+$/;

const PRODUCT_NAMES = new Set(['Piwi', 'Piwi Runner', 'Piwi Desktop', 'Piwi Picker', 'Playwright']);

/** Whether a literal is text a reader sees. */
const isText = (text: string) => LETTER.test(text) && !CATALOG_KEY.test(text.trim()) && !PRODUCT_NAMES.has(text.trim());

/** The `.vue` and `.ts` files under `dir`, as paths relative to `root` with `/`. */
export function uiSourceFiles(root: string, dir: string): string[] {
  const walk = (at: string): string[] =>
    readdirSync(at).flatMap((name) => {
      const full = path.join(at, name);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(vue|ts)$/.test(name) ? [path.relative(root, full).split(path.sep).join('/')] : [];
    });
  return walk(path.join(root, dir)).sort();
}

/** The literal text parts of an expression, through the operators that pass text along. */
function literalParts(node: ts.Expression): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.flatMap((span) => [...literalParts(span.expression), span.literal.text]),
    ];
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return literalParts(node.expression);
  }
  if (ts.isConditionalExpression(node)) return [...literalParts(node.whenTrue), ...literalParts(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.PlusToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return [...literalParts(node.left), ...literalParts(node.right)];
    }
  }
  return [];
}

/** The literal text parts of a template expression (`{{ … }}`, a bound attribute). */
function expressionParts(code: string): string[] {
  const source = ts.createSourceFile('expression.ts', `(${code});`, ts.ScriptTarget.Latest, true);
  const statement = source.statements[0];
  return statement && ts.isExpressionStatement(statement) ? literalParts(statement.expression) : [];
}

/** What a script gives an object's text properties. */
function scriptFindings(code: string, lineOffset: number): UiTextFinding[] {
  const source = ts.createSourceFile('script.ts', code, ts.ScriptTarget.Latest, true);
  const found: UiTextFinding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : null;
      const said =
        callee === 'emit' ? node.arguments.slice(1) : callee && SAYING_CALLS.has(callee) ? node.arguments : [];
      for (const argument of said) {
        for (const text of literalParts(argument)) {
          if (isText(text)) {
            const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1 + lineOffset;
            found.push({ line, text: text.trim() });
          }
        }
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      TEXT_PROPERTIES.has(node.name.text)
    ) {
      for (const text of literalParts(node.initializer)) {
        if (isText(text)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1 + lineOffset;
          found.push({ line, text: text.trim() });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** What a template writes as text. */
function templateFindings(children: TemplateNode[]): UiTextFinding[] {
  const found: UiTextFinding[] = [];
  const report = (line: number, texts: string[]) => {
    for (const text of texts) if (isText(text)) found.push({ line, text: text.trim() });
  };
  const visit = (nodes: TemplateNode[]) => {
    for (const node of nodes) {
      // 1: element, 2: text, 5: interpolation of an expression (4).
      if (node.type === 2 && typeof node.content === 'string') report(node.loc.start.line, [node.content]);
      else if (node.type === 5 && typeof node.content === 'object' && node.content.type === 4) {
        report(node.loc.start.line, expressionParts(node.content.content));
        found.push(...scriptFindings(`(${node.content.content});`, node.loc.start.line - 1));
      } else if (node.type === 1) {
        for (const prop of node.props ?? []) {
          // 6: a static attribute, 7: a directive, `:title` among them.
          if (prop.type === 6 && TEXT_ATTRIBUTES.has(prop.name) && prop.value && !ADDRESS.test(prop.value.content)) {
            report(prop.loc.start.line, [prop.value.content]);
          }
          if (
            prop.type === 7 &&
            prop.name === 'bind' &&
            prop.arg?.type === 4 &&
            TEXT_ATTRIBUTES.has(prop.arg.content) &&
            prop.exp?.type === 4
          ) {
            report(prop.loc.start.line, expressionParts(prop.exp.content));
          }
          if (prop.type === 7 && prop.exp?.type === 4) {
            found.push(...scriptFindings(`(${prop.exp.content});`, prop.loc.start.line - 1));
          }
        }
        if (!CODE_ELEMENTS.has(node.tag ?? '')) visit(node.children ?? []);
      }
    }
  };
  visit(children);
  return found;
}

/** Declares a test per `.vue` and `.ts` file under `dir` of `root` that fails on the text it writes into the UI. */
export function describeUiTextScan(name: string, root: string, dir: string): void {
  describe(name, () => {
    it.each(uiSourceFiles(root, dir))('%s takes its texts from the catalogs', (file) => {
      expect(uiTextFindings(path.join(root, file))).toEqual([]);
    });
  });
}

/** The text a `.vue` or `.ts` file writes straight into the UI. */
export function uiTextFindings(file: string): UiTextFinding[] {
  const code = readFileSync(file, 'utf8');
  if (!file.endsWith('.vue')) return scriptFindings(code, 0);
  const { descriptor } = parseSfc(code, { filename: file });
  const found: UiTextFinding[] = [];
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (block) found.push(...scriptFindings(block.content, block.loc.start.line - 1));
  }
  const ast = descriptor.template?.ast as { children?: TemplateNode[] } | undefined;
  found.push(...templateFindings(ast?.children ?? []));
  return found.sort((a, b) => a.line - b.line);
}
