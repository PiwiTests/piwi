import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseTemplate, type TemplateChildNode, type ElementNode } from '@vue/compiler-dom';
import { parse as parseSfc } from '@vue/compiler-sfc';
import ts from 'typescript';

/**
 * Text written straight into a Vue app's UI, bypassing its catalogs: a string or template literal with a letter in it
 *
 * - written as text in a template, outside `<code>`, `<pre>` and `<kbd>`;
 * - given to a text attribute (`title`, `label`, `description`, `placeholder`, `aria-label`, `alt`), as a static value
 *   or in a bound expression;
 * - written in a template's `{{ … }}`;
 * - given to an object's `title`, `description`, `label`, `message` or `placeholder` in a script (a toast, an answer).
 *
 * The walk of an expression follows `? :`, `??`, `||`, `&&`, `+` and template parts, and stops at calls: `t('key')` is
 * a call. A static attribute whose value is an address (`https://…`) is an example, and a literal shaped as a catalog's
 * key (`runui_requestRun`) names a message, and a product's name is never translated: none of them is text.
 */

export interface UiTextFinding {
  line: number;
  text: string;
}

const TEXT_ATTRIBUTES = new Set(['title', 'label', 'description', 'placeholder', 'aria-label', 'alt']);
const TEXT_PROPERTIES = new Set(['title', 'description', 'label', 'message', 'placeholder']);
const CODE_ELEMENTS = new Set(['code', 'pre', 'kbd']);
const LETTER = /\p{L}/u;
const ADDRESS = /^https?:\/\//;
const CATALOG_KEY = /^[a-z]+_[A-Za-z0-9_]+$/;

const PRODUCT_NAMES = new Set(['Piwi', 'Piwi Runner', 'Piwi Desktop', 'Piwi Picker', 'Playwright']);

/** Whether a literal is text a reader sees. */
const isText = (text: string) =>
  LETTER.test(text) && !CATALOG_KEY.test(text.trim()) && !PRODUCT_NAMES.has(text.trim());

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
function templateFindings(children: TemplateChildNode[]): UiTextFinding[] {
  const found: UiTextFinding[] = [];
  const report = (line: number, texts: string[]) => {
    for (const text of texts) if (isText(text)) found.push({ line, text: text.trim() });
  };
  const visit = (nodes: TemplateChildNode[]) => {
    for (const node of nodes) {
      // 1: element, 2: text, 5: interpolation, 9 to 11: v-if branches and v-for.
      if (node.type === 2) report(node.loc.start.line, [node.content]);
      else if (node.type === 5 && node.content.type === 4) {
        report(node.loc.start.line, expressionParts(node.content.content));
      } else if (node.type === 1) {
        const element = node as ElementNode;
        for (const prop of element.props) {
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
        }
        if (!CODE_ELEMENTS.has(element.tag)) visit(element.children);
      } else if ('children' in node && Array.isArray(node.children)) {
        visit(node.children as TemplateChildNode[]);
      } else if ('branches' in node) {
        for (const branch of node.branches) visit(branch.children);
      }
    }
  };
  visit(children);
  return found;
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
  if (descriptor.template) {
    const ast = parseTemplate(descriptor.template.content);
    const offset = descriptor.template.loc.start.line - 1;
    found.push(...templateFindings(ast.children).map((f) => ({ ...f, line: f.line + offset })));
  }
  return found.sort((a, b) => a.line - b.line);
}
