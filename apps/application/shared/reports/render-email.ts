/**
 * A quality report as an email: the verdict, the headline numbers, the trend
 * as an image with its axis values and dates as HTML text beside it, what
 * changed, and a link to the report. Tables and inline styles only, so the
 * body stays well under the clipping size of common mail clients. The server
 * sends it with the chart attached by content id; the schedule form previews
 * it with the same marks as an SVG data address.
 */
import { STATUS_COLORS } from '#shared/status-colors';
import { emailLayout, escapeHtml } from '#shared/email-layout';
import { CHART_MARKS_PAD, chartTickLabel, seriesColor, seriesGeometry } from './chart';
import { makeFormatter, type ValueFormatter } from './format';
import { sentencesFor } from './sentences';
import { reportWidgets, type ReportBlock, type ReportBundle, type ReportTone } from './types';

type SeriesBlock = Extract<ReportBlock, { kind: 'series' }>;

/** The chart image in CSS pixels, and the column of axis values on its left: together the card's 496 px. */
export const EMAIL_CHART = { width: 456, height: 140, axis: 40 } as const;

/** The height of one axis value, centered on its gridline. */
const AXIS_LINE = 12;

const TONE_COLORS: Record<ReportTone, string> = {
  good: STATUS_COLORS.passed.text,
  bad: STATUS_COLORS.failed.text,
  neutral: '#71717a',
};

/** The trend a quality report email draws: the first series of the report, the pass rate over time on the built-ins. */
export function emailTrendBlock(bundle: ReportBundle): SeriesBlock | null {
  for (const widget of reportWidgets(bundle)) {
    for (const block of widget.blocks) if (block.kind === 'series') return block;
  }
  return null;
}

export interface ReportEmailOptions {
  /** *Open in Piwi*: the report's snapshot. */
  url: string;
  /** The chart image: `cid:…` when sent, a data address in a preview; null leaves the chart out. */
  chartSrc: string | null;
  /** *Read without an account*, when the schedule attaches a share link. */
  shareUrl?: string | null;
  /** The instance the footer names. */
  siteUrl: string;
  /** The Piwi mark in the footer: its attachment's `cid:…` by default, a data address in a preview. */
  markSrc?: string;
}

/**
 * The axis values as the rows of a table as tall as the image, each value
 * centered on its gridline (kept inside the image at the top and the bottom).
 * Mail clients drop positioned elements, so the rows' heights place them.
 */
function axisRows(block: SeriesBlock, f: ValueFormatter): string {
  const { width, height } = EMAIL_CHART;
  const pad = CHART_MARKS_PAD;
  const g = seriesGeometry(block, width - pad * 2, height - pad * 2);
  const spacer = (h: number) =>
    `<tr><td height="${h}" style="height:${h}px;line-height:${h}px;font-size:1px;mso-line-height-rule:exactly;">&nbsp;</td></tr>`;
  const rows: string[] = [];
  let cursor = 0;
  for (const tick of [...g.ticks].sort((a, b) => a.y - b.y)) {
    const top = Math.round(Math.min(height - AXIS_LINE, Math.max(0, pad + tick.y - AXIS_LINE / 2)));
    // A value too close to the previous one to print both keeps the first.
    if (top < cursor) continue;
    if (top > cursor) rows.push(spacer(top - cursor));
    rows.push(
      `<tr><td height="${AXIS_LINE}" align="right" style="height:${AXIS_LINE}px;line-height:${AXIS_LINE}px;font-size:10px;color:#71717a;padding-right:6px;white-space:nowrap;mso-line-height-rule:exactly;">${escapeHtml(chartTickLabel(block, tick.value, f))}</td></tr>`,
    );
    cursor = top + AXIS_LINE;
  }
  if (height > cursor) rows.push(spacer(height - cursor));
  return rows.join('');
}

/** The first, middle and last day under the chart, each where its point sits. */
function axisDates(block: SeriesBlock, day: (date: string) => string): string {
  const dates = block.series[0]?.points.map((p) => p.date) ?? [];
  if (dates.length === 0) return '';
  const cell = (align: 'left' | 'center' | 'right', width: string, date: string) =>
    `<td width="${width}" align="${align}" style="font-size:12px;color:#71717a;">${escapeHtml(day(date))}</td>`;
  const last = dates[dates.length - 1]!;
  const cells =
    dates.length === 1
      ? cell('center', '100%', last)
      : dates.length === 2
        ? cell('left', '50%', dates[0]!) + cell('right', '50%', last)
        : cell('left', '33%', dates[0]!) +
          cell('center', '34%', dates[Math.round((dates.length - 1) / 2)]!) +
          cell('right', '33%', last);
  return `<table width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>`;
}

export function renderReportEmail(
  bundle: ReportBundle,
  opts: ReportEmailOptions,
): { subject: string; html: string; text: string } {
  const s = sentencesFor(bundle.language);
  const f = makeFormatter(bundle.language, bundle.locale);
  const subject = `${s.labels.qualityReport}${s.colon}${bundle.title}`;
  const widgets = reportWidgets(bundle);
  const tiles = widgets.flatMap((w) => w.blocks).find((b) => b.kind === 'stats');
  const trend = emailTrendBlock(bundle);
  const changes = widgets.find((w) => w.type === 'insights')?.blocks.find((b) => b.kind === 'list');
  const p = (text: string, style = '') =>
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#18181b;${style}">${text}</p>`;
  const meta = (text: string) => `<span style="font-size:12px;color:#71717a;">${text}</span>`;

  const parts: string[] = [
    `<h2 style="margin:0 0 4px;font-size:20px;color:#18181b;">${escapeHtml(bundle.title)}</h2>`,
    p(meta(escapeHtml(bundle.period.label))),
    p(escapeHtml(bundle.verdict.sentence)),
  ];
  const textParts: string[] = [bundle.title, bundle.period.label, '', bundle.verdict.sentence, ''];

  if (tiles && tiles.kind === 'stats') {
    const cells = tiles.tiles.map((t) => {
      const change = t.change
        ? ` <span style="font-size:12px;color:${TONE_COLORS[t.tone]};">${escapeHtml(t.change)}</span>`
        : '';
      const note = t.note ? `<br>${meta(escapeHtml(t.note))}` : '';
      return `<td width="50%" valign="top" style="padding:8px 8px 8px 0;">${meta(escapeHtml(t.label))}<br><span style="font-size:18px;font-weight:700;color:#18181b;">${escapeHtml(t.value)}</span>${change}${note}</td>`;
    });
    const rows: string[] = [];
    for (let i = 0; i < cells.length; i += 2) rows.push(`<tr>${cells[i]}${cells[i + 1] ?? '<td></td>'}</tr>`);
    parts.push(`<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">${rows.join('')}</table>`);
    for (const t of tiles.tiles) textParts.push(`${t.label}${s.colon}${t.value}${t.change ? ` (${t.change})` : ''}`);
    textParts.push('');
  }

  if (trend && opts.chartSrc) {
    const { width, height, axis } = EMAIL_CHART;
    const legend = trend.series
      .map(
        (series) =>
          `<span style="display:inline-block;margin-right:12px;font-size:12px;color:#71717a;"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${seriesColor(series.color, series.faint)};margin-right:4px;"></span>${escapeHtml(series.label)}</span>`,
      )
      .join('');
    parts.push(
      `<table width="${axis + width}" cellpadding="0" cellspacing="0" style="margin:0 0 4px;">` +
        `<tr><td width="${axis}" valign="top" style="width:${axis}px;"><table width="${axis}" cellpadding="0" cellspacing="0">${axisRows(trend, f)}</table></td>` +
        `<td width="${width}" valign="top"><img src="${escapeHtml(opts.chartSrc)}" width="${width}" height="${height}" alt="${escapeHtml(trend.summary ?? '')}" style="display:block;width:${width}px;height:${height}px;border:0;"></td></tr>` +
        `<tr><td></td><td style="padding-top:4px;">${axisDates(trend, (d) => f.day(d))}</td></tr></table>`,
      p(`${legend}`, 'margin-bottom:4px;'),
    );
    if (trend.summary) parts.push(p(meta(escapeHtml(trend.summary))));
    if (trend.markers.length > 0) {
      parts.push(
        p(meta(trend.markers.map((m) => `${escapeHtml(f.day(m.date))}${s.colon}${escapeHtml(m.label)}`).join(' · '))),
      );
    }
    if (trend.summary) textParts.push(trend.summary, '');
  }

  if (changes && changes.kind === 'list' && changes.items.length > 0) {
    const items = changes.items
      .slice(0, 6)
      .map(
        (item) =>
          `<li style="margin:0 0 6px;font-size:14px;line-height:1.5;color:#18181b;">${escapeHtml(item.text)}</li>`,
      )
      .join('');
    parts.push(
      `<h3 style="margin:16px 0 8px;font-size:15px;color:#18181b;">${escapeHtml(s.title('What changed'))}</h3><ul style="margin:0 0 16px;padding-left:18px;">${items}</ul>`,
    );
    for (const item of changes.items.slice(0, 6)) textParts.push(`- ${item.text}`);
    textParts.push('');
  }

  parts.push(
    `<p style="margin:16px 0;"><a href="${escapeHtml(opts.url)}" style="display:inline-block;background:#18181b;color:#ffffff;padding:10px 16px;border-radius:6px;font-size:14px;text-decoration:none;">${escapeHtml(s.labels.openInPiwi)}</a>${
      opts.shareUrl
        ? ` <a href="${escapeHtml(opts.shareUrl)}" style="display:inline-block;margin-left:8px;font-size:14px;color:#18181b;">${escapeHtml(s.labels.readWithoutAccount)}</a>`
        : ''
    }</p>`,
    p(
      meta(
        [bundle.scopeText.projects, bundle.scopeText.branches, bundle.scopeText.runs, bundle.scopeText.tests]
          .filter(Boolean)
          .map((v) => escapeHtml(v!))
          .join(' · '),
      ),
    ),
  );
  textParts.push(`${s.labels.openInPiwi}${s.colon}${opts.url}`);
  if (opts.shareUrl) textParts.push(`${s.labels.readWithoutAccount}${s.colon}${opts.shareUrl}`);

  return {
    subject,
    html: emailLayout(escapeHtml(subject), parts.join('\n'), opts.siteUrl, {
      lang: bundle.language,
      automatedMessage: s.labels.automatedMessage,
      sentBy: s.labels.sentBy,
      markSrc: opts.markSrc,
    }),
    text: textParts.join('\n'),
  };
}
