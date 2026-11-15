/**
 * Render an `IssueDocument` as GitHub-flavored Markdown — for trackers that
 * accept Markdown (GitHub, GitLab, Linear), for the clipboard, and for the
 * create modal's preview. Pure: the same tree renders the same string every
 * time, so it is covered against fixtures.
 *
 * The fence and table style matches `shared/export/render-markdown.ts` so a
 * body pasted from either place reads the same.
 */
import { markdownCode } from '#shared/utils/markdown-code';
import type { DocNode, IssueDocument, Inline } from './document';

/** A fenced code block, with any triple-backtick in the body escaped. */
function fence(text: string, lang = ''): string {
  return `\`\`\`${lang}\n${text.replace(/```/g, '\\`\\`\\`')}\n\`\`\``;
}

/** Escape the pipe and newline that would break a Markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Render one inline run: plain text, or a styled/linked span. */
function renderInline(inline: Inline): string {
  if (typeof inline === 'string') return inline;
  let text = inline.text;
  if (inline.code) text = markdownCode(text);
  if (inline.strong) text = `**${text}**`;
  if (inline.href) text = `[${text}](${inline.href})`;
  return text;
}

function renderInlines(inlines: Inline[]): string {
  return inlines.map(renderInline).join('');
}

function renderNode(node: DocNode): string[] {
  switch (node.type) {
    case 'heading':
      return [`${'#'.repeat(node.level)} ${node.text}`, ''];
    case 'paragraph': {
      const text = renderInlines(node.inlines);
      return text ? [text, ''] : [];
    }
    case 'bullets': {
      if (!node.items.length) return [];
      return [...node.items.map((item) => `- ${renderInlines(item)}`), ''];
    }
    case 'code':
      return [fence(node.text, node.language ?? ''), ''];
    case 'table': {
      if (!node.rows.length) return [];
      return [
        `| ${node.headers.map(cell).join(' | ')} |`,
        `| ${node.headers.map(() => '---').join(' | ')} |`,
        ...node.rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
        '',
      ];
    }
    case 'facts': {
      // One `- **Label:** value` line per fact.
      const rows = node.rows.filter(([, v]) => v.length > 0);
      if (!rows.length) return [];
      return [...rows.map(([label, value]) => `- **${label}:** ${renderInlines(value).replace(/\n/g, ' ')}`), ''];
    }
    case 'rule':
      return ['---', ''];
  }
}

export function renderMarkdown(document: IssueDocument): string {
  const out: string[] = [];
  for (const node of document.nodes) out.push(...renderNode(node));
  // One trailing newline, no leading blank line.
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}
