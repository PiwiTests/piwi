/**
 * Renders a report bundle as Markdown that pastes into Confluence, Jira, a pull
 * request or Slack: tables for tables, a text sparkline under each series.
 * Run-derived text is escaped (pipes, backticks, a leading `#`, link and
 * emphasis characters) so a test title can never change the document's shape.
 */
import { piwiCreditMarkdown } from '#shared/brand';
import { sparkline } from './chart';
import { makeFormatter, type ValueFormatter } from './format';
import { sentencesFor, type ReportSentences } from './sentences';
import { hasVerdictWidget, type ReportBlock, type ReportBundle } from './types';

/** Escape a run-derived string for a Markdown line or table cell. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/([\\`*_[\]|<>])/g, '\\$1')
    .replace(/^(\s*)([#>+-]|\d+\.)(\s)/, '$1\\$2$3');
}

function linked(text: string, href: string | null | undefined): string {
  return href ? `[${escapeMarkdown(text)}](${href.replace(/[()\s]/g, encodeURIComponent)})` : escapeMarkdown(text);
}

function renderBlock(block: ReportBlock, s: ReportSentences, f: ValueFormatter): string[] {
  switch (block.kind) {
    case 'text':
      return [escapeMarkdown(block.text), ''];
    case 'stats':
      return [
        `| ${block.tiles.map((t) => escapeMarkdown(t.label)).join(' | ')} |`,
        `|${block.tiles.map(() => ' ---: ').join('|')}|`,
        `| ${block.tiles
          .map((t) =>
            [[t.value, t.change ? `(${t.change})` : ''].filter(Boolean).join(' '), t.note ?? '']
              .filter(Boolean)
              .map(escapeMarkdown)
              .join(' · '),
          )
          .join(' | ')} |`,
        '',
      ];
    case 'series': {
      const lines: string[] = [];
      if (block.summary) lines.push(escapeMarkdown(block.summary), '');
      for (const line of block.series) {
        const values = line.formatted.filter((v, i) => line.points[i]!.value !== null);
        const range = values.length ? ` ${values[0]} → ${values[values.length - 1]}` : '';
        lines.push(
          `${escapeMarkdown(line.label)}${s.colon}\`${sparkline(line.points) || '·'}\`${escapeMarkdown(range)}`,
          '',
        );
      }
      if (block.markers.length)
        lines.push(
          `${s.labels.markers}${s.colon}${block.markers.map((m) => `${f.day(m.date)}${s.colon}${escapeMarkdown(m.label)}`).join(' · ')}`,
          '',
        );
      return lines;
    }
    case 'table':
      if (block.rows.length === 0) return [];
      return [
        `| ${block.columns.map((c) => escapeMarkdown(c.label)).join(' | ')} |`,
        `|${block.columns.map((c) => (c.align === 'right' ? ' ---: ' : ' --- ')).join('|')}|`,
        ...block.rows.map(
          (row) =>
            `| ${block.columns.map((c, i) => (i === 0 ? linked(row.cells[c.key] ?? '', row.link) : escapeMarkdown(row.cells[c.key] ?? ''))).join(' | ')} |`,
        ),
        '',
      ];
    case 'list':
      return [
        ...block.items.map(
          // The detail on a line of its own, as in the HTML and the PDF (a hard line break inside the item).
          (item) => `- ${linked(item.text, item.link)}${item.detail ? `  \n  ${escapeMarkdown(item.detail)}` : ''}`,
        ),
        '',
      ];
  }
}

export function renderReportMarkdown(bundle: ReportBundle): string {
  const s = sentencesFor(bundle.language);
  const f = makeFormatter(bundle.language, bundle.locale);
  const L = s.labels;
  const out: string[] = [
    `# ${L.qualityReport}${s.colon}${escapeMarkdown(bundle.title)}`,
    '',
    `${escapeMarkdown(bundle.period.label)}${bundle.comparison ? ` · ${L.comparedWith.toLowerCase()} ${escapeMarkdown(bundle.comparison.label)}` : ''}`,
    '',
  ];
  if (!hasVerdictWidget(bundle)) out.push(`> ${escapeMarkdown(bundle.verdict.sentence)}`, '');
  for (const band of bundle.bands) {
    out.push(`## ${escapeMarkdown(band.title)}`, '');
    if (band.description) out.push(escapeMarkdown(band.description), '');
    for (const widget of band.widgets) {
      out.push(`### ${escapeMarkdown(widget.title)}`, '');
      for (const note of widget.notes) out.push(`_${escapeMarkdown(note)}_`, '');
      for (const block of widget.blocks) out.push(...renderBlock(block, s, f));
    }
  }
  out.push('---', '');
  out.push(`- **${L.dashboard}**${s.colon}${escapeMarkdown(bundle.dashboard.name)}`);
  out.push(`- **${L.projects}**${s.colon}${escapeMarkdown(bundle.scopeText.projects)}`);
  out.push(`- **${L.branchPolicy}**${s.colon}${escapeMarkdown(bundle.scopeText.branches)}`);
  out.push(`- ${escapeMarkdown(bundle.scopeText.runs)}`);
  if (bundle.scopeText.tests) out.push(`- **${L.testFilter}**${s.colon}${escapeMarkdown(bundle.scopeText.tests)}`);
  out.push('');
  if (bundle.targets.length) {
    out.push(`**${L.targets}**`, '');
    for (const t of bundle.targets) out.push(`- ${escapeMarkdown(t.text)}`);
    out.push('');
  }
  if (bundle.definitions.length) {
    out.push(`**${L.definitions}**`, '');
    for (const d of bundle.definitions)
      out.push(`- **${escapeMarkdown(d.label)}**${s.colon}${escapeMarkdown(d.definition)}`);
    out.push('');
  }
  if (bundle.limits.length) {
    out.push(`**${L.limits}**`, '');
    for (const l of bundle.limits) out.push(`- ${escapeMarkdown(l)}`);
    out.push('');
  }
  out.push(
    `${f.date(bundle.generatedAt, bundle.timeZone)}${bundle.piwiVersion ? ` · ${bundle.piwiVersion}` : ''}${bundle.sourceUrl ? ` · [${L.openInPiwi}](${bundle.sourceUrl})` : ''}`,
    '',
    '---',
    '',
    `_${piwiCreditMarkdown(L.generatedBy)}_`,
    '',
  );
  return out.join('\n');
}
