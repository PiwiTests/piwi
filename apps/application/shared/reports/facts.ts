/**
 * The facts a quality report states: every title, number, sentence and cell a
 * reader sees. Each rendering (the in-app view, HTML, Markdown) must carry all
 * of them; the parity test checks that none drops one.
 */
import { hasVerdictWidget, type ReportBundle } from './types';

export function reportFacts(bundle: ReportBundle): string[] {
  const facts = [bundle.title, bundle.period.label];
  if (bundle.comparison) facts.push(bundle.comparison.label);
  if (!hasVerdictWidget(bundle)) facts.push(bundle.verdict.sentence);
  for (const band of bundle.bands) {
    facts.push(band.title);
    for (const widget of band.widgets) {
      facts.push(widget.title, ...widget.notes);
      for (const block of widget.blocks) {
        if (block.kind === 'text') facts.push(block.text);
        else if (block.kind === 'stats') {
          for (const t of block.tiles)
            facts.push(t.label, t.value, ...(t.change ? [t.change] : []), ...(t.note ? [t.note] : []));
        } else if (block.kind === 'series') {
          if (block.summary) facts.push(block.summary);
          facts.push(...block.series.map((s) => s.label));
        } else if (block.kind === 'table') {
          facts.push(...block.columns.map((c) => c.label));
          for (const row of block.rows) facts.push(...block.columns.map((c) => row.cells[c.key] ?? '').filter(Boolean));
        } else {
          for (const item of block.items) facts.push(item.text, ...(item.detail ? [item.detail] : []));
        }
      }
    }
  }
  facts.push(bundle.scopeText.projects, bundle.scopeText.branches);
  if (bundle.scopeText.environments) facts.push(bundle.scopeText.environments);
  for (const t of bundle.targets) facts.push(t.text);
  for (const d of bundle.definitions) facts.push(d.label, d.definition);
  facts.push(...bundle.limits);
  return facts.filter((f) => f.trim() !== '');
}
