import { describe, expect, test } from 'vitest';
import { renderReportHtml } from '../../shared/reports/render-html';
import { renderReportMarkdown } from '../../shared/reports/render-markdown';
import { renderReportPdf } from '../../shared/reports/render-pdf';
import { buildReport } from '../../shared/reports/build';
import { reportFacts } from '../../shared/reports/facts';
import { fixtureBundle, HOSTILE } from './report-fixture';

/**
 * The HTML and Markdown renderings of a quality report state the same facts:
 * someone pasting the Markdown into a ticket loses no number the HTML shows.
 * The in-app view renders the same blocks; the E2E spec checks it against the
 * JSON bundle.
 */

function htmlText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function markdownText(md: string): string {
  return md.replace(/\\([\\`*_[\]|<>#+\-.])/g, '$1').replace(/\s+/g, ' ');
}

const norm = (s: string) => s.replace(/\s+/g, ' ');

describe('quality report parity', () => {
  const bundle = fixtureBundle();
  const facts = reportFacts(bundle);

  test('the HTML states every fact', () => {
    const text = htmlText(renderReportHtml(bundle));
    for (const fact of facts) expect(text, fact).toContain(norm(fact));
  });

  test('the Markdown states every fact', () => {
    const text = markdownText(renderReportMarkdown(bundle));
    for (const fact of facts) expect(text, fact).toContain(norm(fact));
  });

  test('run-derived text is escaped in HTML and Markdown', () => {
    const html = renderReportHtml(bundle);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    const md = renderReportMarkdown(bundle);
    expect(md).toContain('\\| \\<script\\>');
    expect(md).not.toMatch(/^# h/m);
  });

  test("a chart's last day on the right edge ends there instead of being cut", () => {
    const html = renderReportHtml(fixtureBundle());
    // The fixture's three days put the last label on the plot's right edge.
    const anchors = [...html.matchAll(/text-anchor="(middle|end)"[^>]*>(Sep \d+)</g)].map((m) => [m[2], m[1]]);
    expect(anchors).toEqual([
      ['Sep 23', 'middle'],
      ['Sep 24', 'middle'],
      ['Sep 25', 'end'],
    ]);
  });

  test('the Markdown draws a text sparkline under a series, a gap as a space', () => {
    expect(renderReportMarkdown(bundle)).toContain('`█ ▁`');
  });

  test('the PDF renders a page per band plus the footer page', async () => {
    const bytes = await renderReportPdf(bundle);
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('%PDF-')).toBe(true);
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBe(bundle.bands.length + 1);
  });

  test('build names the file and sets the content type of every format', async () => {
    for (const format of ['html', 'pdf', 'md', 'csv', 'json'] as const) {
      const built = await buildReport(bundle, format);
      expect(built.fileName).toBe(`piwi-quality-report-executive-2026-09-25.${format}`);
      expect(built.bytes.length).toBeGreaterThan(0);
    }
    expect((await buildReport(bundle, 'pdf')).contentType).toBe('application/pdf');
  });

  test('the HTML numbers each band and edges the verdict in its tone', () => {
    const html = renderReportHtml(bundle);
    bundle.bands.forEach((band, i) => expect(html).toContain(`<span class="num">${i + 1}</span>${band.title}`));
    expect(html).toMatch(/class="verdict" data-verdict="mixed" style="--tone:#[0-9a-f]{6}"/);
  });

  test('the HTML shades the area under a lone series, never under a lone point', () => {
    expect(renderReportHtml(bundle)).not.toContain('fill-opacity');
    const joined = fixtureBundle();
    const series = joined.bands
      .flatMap((b) => b.widgets)
      .flatMap((w) => w.blocks)
      .find((b) => b.kind === 'series');
    if (series?.kind !== 'series') throw new Error('the fixture has a series');
    series.series[0]!.points[1]!.value = 90;
    expect(renderReportHtml(joined)).toContain('fill-opacity="0.09"');
  });

  test('the fixture carries the hostile string into the facts', () => {
    expect(facts).toContain(HOSTILE);
  });
});
