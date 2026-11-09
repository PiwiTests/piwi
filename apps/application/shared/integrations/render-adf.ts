/**
 * Render an `IssueDocument` as Atlassian Document Format — the JSON body Jira
 * Cloud's REST v3 accepts for an issue description and for comments. Pure and
 * covered against fixtures; the node set is the small one Piwi emits, not all of
 * ADF.
 *
 * ADF forbids empty text nodes, so empty inlines and empty paragraphs collapse
 * to a paragraph with no content rather than a `text` node with `""`.
 */
import type { DocNode, IssueDocument, Inline } from './document';

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface AdfDocument {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

/** One inline run to an ADF `text` node with `strong`/`code`/`link` marks. */
function inlineToText(inline: Inline): AdfNode | null {
  const text = typeof inline === 'string' ? inline : inline.text;
  if (!text) return null;
  const node: AdfNode = { type: 'text', text };
  if (typeof inline !== 'string') {
    const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
    if (inline.strong) marks.push({ type: 'strong' });
    if (inline.code) marks.push({ type: 'code' });
    if (inline.href) marks.push({ type: 'link', attrs: { href: inline.href } });
    if (marks.length) node.marks = marks;
  }
  return node;
}

function inlinesToContent(inlines: Inline[]): AdfNode[] {
  return inlines.map(inlineToText).filter((n): n is AdfNode => n !== null);
}

function paragraph(inlines: Inline[]): AdfNode {
  return { type: 'paragraph', content: inlinesToContent(inlines) };
}

/** A table cell (header or body) wrapping its text in a paragraph. */
function tableCell(type: 'tableHeader' | 'tableCell', inlines: Inline[]): AdfNode {
  return { type, content: [paragraph(inlines)] };
}

function tableRow(cells: AdfNode[]): AdfNode {
  return { type: 'tableRow', content: cells };
}

function renderNode(node: DocNode): AdfNode | null {
  switch (node.type) {
    case 'heading':
      return { type: 'heading', attrs: { level: node.level }, content: [{ type: 'text', text: node.text }] };
    case 'paragraph':
      return paragraph(node.inlines);
    case 'bullets': {
      if (!node.items.length) return null;
      return {
        type: 'bulletList',
        content: node.items.map((item) => ({ type: 'listItem', content: [paragraph(item)] })),
      };
    }
    case 'code':
      return {
        type: 'codeBlock',
        ...(node.language ? { attrs: { language: node.language } } : {}),
        content: node.text ? [{ type: 'text', text: node.text }] : [],
      };
    case 'table': {
      if (!node.rows.length) return null;
      const header = tableRow(node.headers.map((h) => tableCell('tableHeader', [h])));
      const rows = node.rows.map((r) => tableRow(r.map((c) => tableCell('tableCell', [c]))));
      return { type: 'table', content: [header, ...rows] };
    }
    case 'facts': {
      const rows = node.rows.filter(([, v]) => v.length > 0);
      if (!rows.length) return null;
      return {
        type: 'table',
        content: rows.map(([label, value]) =>
          tableRow([tableCell('tableHeader', [{ text: label, strong: true }]), tableCell('tableCell', value)]),
        ),
      };
    }
    case 'rule':
      return { type: 'rule' };
  }
}

export function renderAdf(document: IssueDocument): AdfDocument {
  const content: AdfNode[] = [];
  for (const node of document.nodes) {
    const rendered = renderNode(node);
    if (rendered) content.push(rendered);
  }
  return { type: 'doc', version: 1, content };
}

/**
 * The text of an ADF tree: its text nodes in document order, whatever their
 * marks and layout — what a description says, for telling an edit apart.
 */
export function adfPlainText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { text?: unknown; content?: unknown };
  const own = typeof n.text === 'string' ? n.text : '';
  const children = Array.isArray(n.content) ? n.content.map(adfPlainText).join('') : '';
  return own + children;
}

/** Where an ADF tree's links point, in document order. */
export function adfLinkHrefs(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const n = node as { marks?: unknown; content?: unknown };
  const own = Array.isArray(n.marks)
    ? n.marks.flatMap((mark: { type?: unknown; attrs?: { href?: unknown } } | null) =>
        mark?.type === 'link' && typeof mark.attrs?.href === 'string' ? [mark.attrs.href] : [],
      )
    : [];
  const children = Array.isArray(n.content) ? n.content.flatMap(adfLinkHrefs) : [];
  return [...own, ...children];
}
