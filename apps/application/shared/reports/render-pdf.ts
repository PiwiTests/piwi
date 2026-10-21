/**
 * Renders a report bundle as a PDF with pdf-lib: vector text and vector charts
 * (lines and rectangles), no browser anywhere, so the file is identical on the
 * server, the desktop shell and the demo. Each band starts a page, so pages
 * drop into a slide deck one section at a time.
 *
 * Standard PDF fonts encode Windows-1252 only; every string goes through the
 * export's `winAnsiSafe` so a character a test title carries cannot throw.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { winAnsiSafe } from '#shared/export/render-pdf';
import { drawPiwiCredit, PDF_CREDIT_HEIGHT } from '#shared/brand';
import { STATUS_COLORS, PASS_RATE_COLORS, hexToRgb } from '#shared/status-colors';
import { chartLabelAnchor, chartTickLabel, seriesGeometry } from './chart';
import { makeFormatter, type ValueFormatter } from './format';
import { sentencesFor } from './sentences';
import { hasVerdictWidget, type ReportBlock, type ReportBundle, type ReportTone } from './types';

type Color = ReturnType<typeof rgb>;

function hex(value: string): Color {
  const [r, g, b] = hexToRgb(value);
  return rgb(r / 255, g / 255, b / 255);
}

const INK = hex('#1c1c20');
const MUTED = hex('#6b6b76');
const LINE = hex('#e2e2e7');
const CARD = hex('#fafafa');
const TONE: Record<ReportTone, Color> = {
  good: hex(STATUS_COLORS.passed.text),
  bad: hex(STATUS_COLORS.failed.text),
  neutral: MUTED,
};
const VERDICT = {
  good: hex(PASS_RATE_COLORS.good.fill),
  mixed: hex(PASS_RATE_COLORS.fair.fill),
  bad: hex(PASS_RATE_COLORS.poor.fill),
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const WIDTH = PAGE_W - MARGIN * 2;

class Layout {
  page!: PDFPage;
  y = 0;
  pages = 0;

  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
    this.pages++;
  }

  /** Start a new page when fewer than `height` points remain. */
  ensure(height: number) {
    if (this.y - height < MARGIN + 16) this.newPage();
  }

  wrap(text: string, size: number, width: number, font = this.font): string[] {
    const words = winAnsiSafe(text).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  /** Clip a string to a width, ending with an ellipsis. */
  fit(text: string, size: number, width: number, font = this.font): string {
    let t = winAnsiSafe(text);
    if (font.widthOfTextAtSize(t, size) <= width) return t;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1);
    return `${t}…`;
  }

  paragraph(text: string, opts: { size?: number; font?: PDFFont; color?: Color; indent?: number; gap?: number } = {}) {
    const size = opts.size ?? 10;
    const indent = opts.indent ?? 0;
    for (const line of this.wrap(text, size, WIDTH - indent, opts.font)) {
      this.ensure(size + 4);
      this.page.drawText(line, {
        x: MARGIN + indent,
        y: this.y - size,
        size,
        font: opts.font ?? this.font,
        color: opts.color ?? INK,
      });
      this.y -= size + 4;
    }
    this.y -= opts.gap ?? 4;
  }
}

function drawStats(l: Layout, block: Extract<ReportBlock, { kind: 'stats' }>) {
  const perRow = 3;
  const gap = 8;
  const w = (WIDTH - gap * (perRow - 1)) / perRow;
  const h = 54;
  for (let i = 0; i < block.tiles.length; i += perRow) {
    l.ensure(h + gap);
    block.tiles.slice(i, i + perRow).forEach((tile, j) => {
      const x = MARGIN + j * (w + gap);
      const top = l.y;
      l.page.drawRectangle({ x, y: top - h, width: w, height: h, color: CARD, borderColor: LINE, borderWidth: 0.5 });
      l.page.drawText(l.fit(tile.label, 8, w - 12), { x: x + 6, y: top - 13, size: 8, font: l.font, color: MUTED });
      l.page.drawText(l.fit(tile.value, 14, w - 12, l.bold), {
        x: x + 6,
        y: top - 31,
        size: 14,
        font: l.bold,
        color: INK,
      });
      const extra = [tile.change, tile.note].filter(Boolean).join(' · ');
      if (extra) {
        l.page.drawText(l.fit(extra, 8, w - 12), {
          x: x + 6,
          y: top - 45,
          size: 8,
          font: l.font,
          color: tile.change ? TONE[tile.tone] : MUTED,
        });
      }
    });
    l.y -= h + gap;
  }
  l.y -= 4;
}

function drawSeries(l: Layout, block: Extract<ReportBlock, { kind: 'series' }>, f: ValueFormatter, colon: string) {
  if (block.summary) l.paragraph(block.summary, { size: 9, color: MUTED });
  const chartH = 140;
  const left = 36;
  l.ensure(chartH + 40);
  const g = seriesGeometry(block, WIDTH - left - 4, chartH);
  const ox = MARGIN + left;
  const oy = l.y - 14;
  const X = (x: number) => ox + x;
  const Y = (y: number) => oy - y;

  // Legend
  let lx = MARGIN;
  for (const line of g.lines) {
    l.page.drawRectangle({ x: lx, y: l.y - 8, width: 7, height: 7, color: hex(line.color) });
    const label = l.fit(line.label, 8, 160);
    l.page.drawText(label, { x: lx + 10, y: l.y - 8, size: 8, font: l.font, color: MUTED });
    lx += 18 + l.font.widthOfTextAtSize(label, 8);
  }

  for (const t of g.ticks) {
    l.page.drawLine({
      start: { x: X(0), y: Y(t.y) },
      end: { x: X(g.width), y: Y(t.y) },
      thickness: 0.4,
      color: LINE,
      dashArray: t.value === 0 ? undefined : [2, 2],
    });
    // Folded like every other text: a French axis value carries a narrow no-break space (`100 %`, `1 500`).
    const label = winAnsiSafe(chartTickLabel(block, t.value, f));
    l.page.drawText(label, {
      x: X(0) - 4 - l.font.widthOfTextAtSize(label, 7),
      y: Y(t.y) - 2,
      size: 7,
      font: l.font,
      color: MUTED,
    });
  }
  for (const m of g.markers) {
    l.page.drawLine({
      start: { x: X(m.x), y: Y(0) },
      end: { x: X(m.x), y: Y(g.height) },
      thickness: 0.6,
      color: hex(STATUS_COLORS.flaky.fill),
      dashArray: [2, 2],
    });
  }
  for (const line of g.lines) {
    const color = hex(line.color);
    for (const run of line.runs) {
      if (run.length === 1) {
        l.page.drawCircle({ x: X(run[0]![0]), y: Y(run[0]![1]), size: 1.8, color });
        continue;
      }
      for (let i = 1; i < run.length; i++) {
        l.page.drawLine({
          start: { x: X(run[i - 1]![0]), y: Y(run[i - 1]![1]) },
          end: { x: X(run[i]![0]), y: Y(run[i]![1]) },
          thickness: line.faint ? 1 : 1.6,
          color,
          dashArray: line.faint ? [3, 2] : undefined,
        });
      }
    }
  }
  for (const lab of g.labels) {
    const text = winAnsiSafe(f.day(lab.date));
    const width = l.font.widthOfTextAtSize(text, 7);
    l.page.drawText(text, {
      x: X(lab.x) - (chartLabelAnchor(lab.x, g.width) === 'end' ? width : width / 2),
      y: Y(g.height) - 10,
      size: 7,
      font: l.font,
      color: MUTED,
    });
  }
  l.y = oy - g.height - 18;
  if (block.markers.length) {
    l.paragraph(block.markers.map((m) => `${f.day(m.date)}${colon}${m.label}`).join(' · '), { size: 8, color: MUTED });
  }
}

function drawTable(l: Layout, block: Extract<ReportBlock, { kind: 'table' }>) {
  if (block.rows.length === 0) return;
  const cols = block.columns.length;
  const first = cols === 1 ? WIDTH : Math.max(WIDTH * 0.35, WIDTH - (cols - 1) * 95);
  const rest = cols === 1 ? 0 : (WIDTH - first) / (cols - 1);
  const widths = block.columns.map((_, i) => (i === 0 ? first : rest));
  const rowH = 14;
  const drawRow = (cells: string[], font: PDFFont, color: Color) => {
    l.ensure(rowH);
    let x = MARGIN;
    cells.forEach((cell, i) => {
      const w = widths[i]! - 6;
      const text = l.fit(cell, 8, w, font);
      const right = block.columns[i]!.align === 'right';
      const tx = right ? x + widths[i]! - 3 - font.widthOfTextAtSize(text, 8) : x + 3;
      l.page.drawText(text, { x: tx, y: l.y - 10, size: 8, font, color });
      x += widths[i]!;
    });
    l.page.drawLine({
      start: { x: MARGIN, y: l.y - rowH },
      end: { x: MARGIN + WIDTH, y: l.y - rowH },
      thickness: 0.4,
      color: LINE,
    });
    l.y -= rowH;
  };
  drawRow(
    block.columns.map((c) => c.label),
    l.bold,
    MUTED,
  );
  for (const row of block.rows)
    drawRow(
      block.columns.map((c) => row.cells[c.key] ?? ''),
      l.font,
      INK,
    );
  l.y -= 8;
}

function drawList(l: Layout, block: Extract<ReportBlock, { kind: 'list' }>) {
  for (const item of block.items) {
    const lines = l.wrap(item.text, 9.5, WIDTH - 12);
    l.ensure(lines.length * 13);
    const color = item.tone && item.tone !== 'neutral' ? TONE[item.tone] : MUTED;
    l.page.drawRectangle({ x: MARGIN, y: l.y - lines.length * 13 + 2, width: 2, height: lines.length * 13 - 2, color });
    l.paragraph(item.text, { size: 9.5, indent: 10, gap: 0 });
    if (item.detail) l.paragraph(item.detail, { size: 8, indent: 10, color: MUTED, gap: 0 });
    l.y -= 3;
  }
  l.y -= 4;
}

function drawVerdict(l: Layout, text: string, tone: keyof typeof VERDICT) {
  const lines = l.wrap(text, 11, WIDTH - 20);
  l.ensure(lines.length * 15 + 8);
  l.page.drawCircle({ x: MARGIN + 4, y: l.y - 7, size: 4, color: VERDICT[tone] });
  l.paragraph(text, { size: 11, indent: 16 });
  l.y -= 4;
}

export async function renderReportPdf(bundle: ReportBundle): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const s = sentencesFor(bundle.language);
  const L = s.labels;
  const f = makeFormatter(bundle.language, bundle.locale);
  doc.setTitle(winAnsiSafe(`${L.qualityReport}${s.colon}${bundle.title}`));
  doc.setCreator('Piwi');
  doc.setProducer('Piwi');
  doc.setCreationDate(new Date(bundle.generatedAt));
  doc.setModificationDate(new Date(bundle.generatedAt));

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const l = new Layout(doc, font, bold);

  l.paragraph(`${L.qualityReport} · ${bundle.dashboard.name}`, { size: 9, color: MUTED });
  l.paragraph(bundle.title, { size: 18, font: bold, gap: 2 });
  l.paragraph(
    `${bundle.period.label}${bundle.comparison ? ` · ${L.comparedWith.toLowerCase()} ${bundle.comparison.label}` : ''}`,
    { size: 9, color: MUTED, gap: 10 },
  );
  if (!hasVerdictWidget(bundle)) drawVerdict(l, bundle.verdict.sentence, bundle.verdict.tone);

  bundle.bands.forEach((band, i) => {
    if (i > 0) l.newPage();
    l.paragraph(band.title, { size: 14, font: bold, gap: 0 });
    if (band.description) l.paragraph(band.description, { size: 9, color: MUTED, gap: 6 });
    for (const widget of band.widgets) {
      l.ensure(40);
      l.y -= 4;
      l.paragraph(widget.title, { size: 11, font: bold, gap: 2 });
      for (const note of widget.notes) l.paragraph(note, { size: 8, color: MUTED });
      for (const block of widget.blocks) {
        if (block.kind === 'text') {
          if (block.tone) drawVerdict(l, block.text, block.tone);
          else l.paragraph(block.text, { size: 9.5 });
        } else if (block.kind === 'stats') drawStats(l, block);
        else if (block.kind === 'series') drawSeries(l, block, f, s.colon);
        else if (block.kind === 'table') drawTable(l, block);
        else drawList(l, block);
      }
    }
  });

  l.newPage();
  const facts: Array<[string, string]> = [
    [L.dashboard, bundle.dashboard.name],
    [L.period, bundle.period.label],
    [L.comparedWith, bundle.comparison?.label ?? L.noComparison],
    [L.projects, bundle.scopeText.projects],
    [L.branchPolicy, bundle.scopeText.branches],
    [sentencesFor(bundle.language).metricLabel('runs', 'Runs'), bundle.scopeText.runs],
    ...(bundle.scopeText.tests ? ([[L.testFilter, bundle.scopeText.tests]] as Array<[string, string]>) : []),
  ];
  for (const [k, v] of facts) {
    l.paragraph(k, { size: 8, font: bold, color: MUTED, gap: 0 });
    l.paragraph(v, { size: 9, gap: 4 });
  }
  if (bundle.targets.length) {
    l.paragraph(L.targets, { size: 11, font: bold });
    for (const t of bundle.targets) l.paragraph(t.text, { size: 8.5 });
  }
  if (bundle.definitions.length) {
    l.paragraph(L.definitions, { size: 11, font: bold });
    for (const d of bundle.definitions) {
      l.paragraph(d.label, { size: 8.5, font: bold, gap: 0 });
      l.paragraph(d.definition, { size: 8.5, color: MUTED });
    }
  }
  if (bundle.limits.length) {
    l.paragraph(L.limits, { size: 11, font: bold });
    for (const limit of bundle.limits) l.paragraph(limit, { size: 8.5, color: MUTED });
  }
  l.paragraph(
    `${f.date(bundle.generatedAt, bundle.timeZone)}${bundle.piwiVersion ? ` · ${bundle.piwiVersion}` : ''}${bundle.sourceUrl ? ` · ${bundle.sourceUrl}` : ''}`,
    { size: 8, color: MUTED },
  );
  l.y -= 14;
  l.ensure(PDF_CREDIT_HEIGHT);
  drawPiwiCredit(doc, l.page, { x: MARGIN, top: l.y, width: WIDTH, label: L.generatedBy, font });
  l.y -= PDF_CREDIT_HEIGHT;

  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const text = `${i + 1} / ${pages.length}`;
    page.drawText(text, {
      x: PAGE_W - MARGIN - font.widthOfTextAtSize(text, 7),
      y: MARGIN / 2,
      size: 7,
      font,
      color: MUTED,
    });
  });
  return doc.save({ useObjectStreams: false });
}
