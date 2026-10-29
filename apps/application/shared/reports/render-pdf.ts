/**
 * Renders a report bundle as a PDF with pdf-lib: vector text and vector charts
 * (lines and rectangles), no browser anywhere, so the file is identical on the
 * server, the desktop shell and the demo. Each band starts a page, so pages
 * drop into a slide deck one section at a time; every page carries the
 * report's name at its top and its number at its foot.
 *
 * Standard PDF fonts encode Windows-1252 only; every string goes through the
 * export's `winAnsiSafe` so a character a test title carries cannot throw.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { roundedPath, tint, winAnsiSafe } from '#shared/export/render-pdf';
import { drawPiwiCredit, PDF_CREDIT_HEIGHT } from '#shared/brand';
import { STATUS_COLORS, PASS_RATE_COLORS, hexToRgb } from '#shared/status-colors';
import { chartLabelAnchor, chartTickLabel, REPORT_ACCENT, seriesGeometry } from './chart';
import { makeFormatter, type ValueFormatter } from './format';
import { sentencesFor } from './sentences';
import { hasVerdictWidget, type ReportBlock, type ReportBundle, type ReportTone } from './types';

type Color = ReturnType<typeof rgb>;

function hex(value: string): Color {
  const [r, g, b] = hexToRgb(value);
  return rgb(r / 255, g / 255, b / 255);
}

const INK = hex('#1c1c20');
const MUTED = hex('#5f5f6b');
const FAINT = hex('#8b8b96');
const LINE = hex('#e4e4e9');
const CARD = hex('#fafafb');
const WHITE = rgb(1, 1, 1);
const ACCENT = hex(REPORT_ACCENT);
const TONE: Record<ReportTone, Color> = {
  good: hex(STATUS_COLORS.passed.text),
  bad: hex(STATUS_COLORS.failed.text),
  neutral: MUTED,
};
/** The top edge of a tile: the outcome color of its change, or a hairline for a change that is neither good nor bad. */
const TILE_EDGE: Record<ReportTone, Color> = {
  good: hex(STATUS_COLORS.passed.fill),
  bad: hex(STATUS_COLORS.failed.fill),
  neutral: LINE,
};
const VERDICT = {
  good: PASS_RATE_COLORS.good.fill,
  mixed: PASS_RATE_COLORS.fair.fill,
  bad: PASS_RATE_COLORS.poor.fill,
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

  rounded(x: number, top: number, w: number, h: number, r: number, fill?: Color, border?: Color) {
    this.page.drawSvgPath(roundedPath(w, h, r), {
      x,
      y: top,
      color: fill,
      borderColor: border,
      borderWidth: border ? 0.6 : 0,
    });
  }
}

function drawStats(l: Layout, block: Extract<ReportBlock, { kind: 'stats' }>) {
  const perRow = 3;
  const gap = 8;
  const w = (WIDTH - gap * (perRow - 1)) / perRow;
  const h = 66;
  for (let i = 0; i < block.tiles.length; i += perRow) {
    l.ensure(h + gap);
    block.tiles.slice(i, i + perRow).forEach((tile, j) => {
      const x = MARGIN + j * (w + gap);
      const top = l.y;
      const edge = tile.change ? TILE_EDGE[tile.tone] : TILE_EDGE.neutral;
      l.rounded(x, top, w, h, 6, edge);
      l.rounded(x, top - 2.5, w, h - 2.5, 5, CARD, LINE);
      l.page.drawText(l.fit(tile.label, 8, w - 16), { x: x + 8, y: top - 16, size: 8, font: l.font, color: MUTED });
      l.page.drawText(l.fit(tile.value, 18, w - 16, l.bold), {
        x: x + 8,
        y: top - 38,
        size: 18,
        font: l.bold,
        color: INK,
      });
      let nx = x + 8;
      if (tile.change) {
        const change = l.fit(tile.change, 7.5, w / 2, l.bold);
        const cw = l.bold.widthOfTextAtSize(change, 7.5) + 10;
        l.page.drawSvgPath(roundedPath(cw, 11, 5.5), {
          x: nx,
          y: top - 45,
          color: WHITE,
          borderColor: TONE[tile.tone],
          borderWidth: 0.8,
        });
        l.page.drawText(change, { x: nx + 5, y: top - 53, size: 7.5, font: l.bold, color: TONE[tile.tone] });
        nx += cw + 6;
      }
      if (tile.note) {
        l.page.drawText(l.fit(tile.note, 7.5, x + w - 8 - nx), {
          x: nx,
          y: top - 53,
          size: 7.5,
          font: l.font,
          color: MUTED,
        });
      }
    });
    l.y -= h + gap;
  }
  l.y -= 4;
}

function drawSeries(l: Layout, block: Extract<ReportBlock, { kind: 'series' }>, f: ValueFormatter, colon: string) {
  if (block.summary) l.paragraph(block.summary, { size: 9, color: MUTED });
  const chartH = 150;
  const left = 36;
  l.ensure(chartH + 40);
  const g = seriesGeometry(block, WIDTH - left - 4, chartH);
  const ox = MARGIN + left;
  const oy = l.y - 16;
  const X = (x: number) => ox + x;
  const Y = (y: number) => oy - y;

  // Legend
  let lx = MARGIN;
  for (const line of g.lines) {
    l.page.drawCircle({ x: lx + 3.5, y: l.y - 5, size: 3.5, color: hex(line.color) });
    const label = l.fit(line.label, 8, 160);
    l.page.drawText(label, { x: lx + 10, y: l.y - 8, size: 8, font: l.font, color: MUTED });
    lx += 22 + l.font.widthOfTextAtSize(label, 8);
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
  // A lone series gets a light area under its line, as in the HTML report.
  const shaded = g.lines.filter((line) => !line.faint).length === 1;
  for (const line of g.lines) {
    if (!shaded || line.faint) continue;
    for (const run of line.runs) {
      if (run.length < 2) continue;
      const path = [
        `M ${run[0]![0]} ${g.height}`,
        ...run.map(([x, y]) => `L ${x} ${y}`),
        `L ${run[run.length - 1]![0]} ${g.height} Z`,
      ].join(' ');
      l.page.drawSvgPath(path, { x: ox, y: oy, color: hex(line.color), opacity: 0.09, borderWidth: 0 });
    }
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
          thickness: line.faint ? 1 : 1.8,
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
  const rowH = 16;
  const drawRow = (cells: string[], font: PDFFont, color: Color, size: number, header: boolean) => {
    l.ensure(rowH);
    if (header) l.page.drawRectangle({ x: MARGIN, y: l.y - rowH, width: WIDTH, height: rowH, color: CARD });
    let x = MARGIN;
    cells.forEach((cell, i) => {
      const w = widths[i]! - 10;
      const text = l.fit(header ? cell.toUpperCase() : cell, size, w, font);
      const right = block.columns[i]!.align === 'right';
      const tx = right ? x + widths[i]! - 5 - font.widthOfTextAtSize(text, size) : x + 5;
      l.page.drawText(text, { x: tx, y: l.y - 11, size, font, color });
      x += widths[i]!;
    });
    l.page.drawLine({
      start: { x: MARGIN, y: l.y - rowH },
      end: { x: MARGIN + WIDTH, y: l.y - rowH },
      thickness: header ? 0.6 : 0.4,
      color: LINE,
    });
    l.y -= rowH;
  };
  drawRow(
    block.columns.map((c) => c.label),
    l.bold,
    FAINT,
    6.5,
    true,
  );
  for (const row of block.rows)
    drawRow(
      block.columns.map((c) => row.cells[c.key] ?? ''),
      l.font,
      INK,
      8,
      false,
    );
  l.y -= 8;
}

function drawList(l: Layout, block: Extract<ReportBlock, { kind: 'list' }>) {
  for (const item of block.items) {
    const toned = item.tone && item.tone !== 'neutral';
    const lines = l.wrap(item.text, 9.5, WIDTH - 20);
    const details = item.detail ? l.wrap(item.detail, 8, WIDTH - 20) : [];
    const height = lines.length * 13.5 + details.length * 12 + (toned ? 10 : 2);
    l.ensure(height + 4);
    const top = l.y;
    if (toned) {
      l.page.drawRectangle({
        x: MARGIN,
        y: top - height,
        width: WIDTH,
        height,
        color: CARD,
        borderColor: LINE,
        borderWidth: 0.5,
      });
      l.page.drawRectangle({ x: MARGIN, y: top - height, width: 3, height, color: TONE[item.tone!] });
    } else {
      l.page.drawCircle({ x: MARGIN + 5, y: top - 5.5, size: 1.8, color: MUTED });
    }
    l.y -= toned ? 5 : 1;
    l.paragraph(item.text, { size: 9.5, indent: 12, gap: 0 });
    if (item.detail) l.paragraph(item.detail, { size: 8, indent: 12, color: MUTED, gap: 0 });
    l.y = top - height - 4;
  }
  l.y -= 4;
}

function drawVerdict(l: Layout, text: string, tone: keyof typeof VERDICT) {
  const lines = l.wrap(text, 11, WIDTH - 40);
  const height = lines.length * 15 + 20;
  l.ensure(height + 8);
  const top = l.y;
  l.rounded(MARGIN, top, WIDTH, height, 7, hex(VERDICT[tone]));
  l.rounded(MARGIN + 4, top, WIDTH - 4, height, 6, tint(VERDICT[tone], 0.1));
  l.page.drawCircle({ x: MARGIN + 18, y: top - 17.5, size: 4, color: hex(VERDICT[tone]) });
  l.y -= 10;
  l.paragraph(text, { size: 11, indent: 30, gap: 0 });
  l.y = top - height - 10;
}

/** A band's heading: its number in an accent square, its title and what it covers. */
function drawBandTitle(l: Layout, index: number, title: string, description: string | null) {
  const size = 15;
  const box = 20;
  l.rounded(MARGIN, l.y, box, box, 5, ACCENT);
  const n = String(index + 1);
  l.page.drawText(n, {
    x: MARGIN + (box - l.bold.widthOfTextAtSize(n, 11)) / 2,
    y: l.y - 14.5,
    size: 11,
    font: l.bold,
    color: WHITE,
  });
  l.page.drawText(l.fit(title, size, WIDTH - box - 10, l.bold), {
    x: MARGIN + box + 9,
    y: l.y - 15,
    size,
    font: l.bold,
    color: INK,
  });
  l.y -= box + 6;
  if (description) l.paragraph(description, { size: 9, color: MUTED, indent: box + 9, gap: 8 });
  else l.y -= 6;
}

/** A widget's title over a hairline. */
function drawWidgetTitle(l: Layout, title: string) {
  l.ensure(48);
  l.y -= 6;
  l.paragraph(title, { size: 11, font: l.bold, gap: 2 });
  l.page.drawLine({ start: { x: MARGIN, y: l.y }, end: { x: MARGIN + WIDTH, y: l.y }, thickness: 0.4, color: LINE });
  l.y -= 8;
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

  l.paragraph(`${L.qualityReport} · ${bundle.dashboard.name}`.toUpperCase(), {
    size: 8,
    font: bold,
    color: ACCENT,
    gap: 2,
  });
  l.paragraph(bundle.title, { size: 22, font: bold, gap: 2 });
  l.paragraph(
    `${bundle.period.label}${bundle.comparison ? ` · ${L.comparedWith.toLowerCase()} ${bundle.comparison.label}` : ''}`,
    { size: 9, color: MUTED, gap: 14 },
  );
  if (!hasVerdictWidget(bundle)) drawVerdict(l, bundle.verdict.sentence, bundle.verdict.tone);
  l.y -= 6;

  bundle.bands.forEach((band, i) => {
    if (i > 0) l.newPage();
    drawBandTitle(l, i, band.title, band.description);
    for (const widget of band.widgets) {
      drawWidgetTitle(l, widget.title);
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
      l.y -= 6;
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
  const labelWidth = 110;
  const pair = (label: string, value: string, size: number) => {
    const lines = l.wrap(value, size, WIDTH - labelWidth);
    l.ensure(lines.length * (size + 4));
    l.page.drawText(l.fit(label, size, labelWidth - 10, bold), {
      x: MARGIN,
      y: l.y - size,
      size,
      font: bold,
      color: INK,
    });
    for (const line of lines) {
      l.page.drawText(line, { x: MARGIN + labelWidth, y: l.y - size, size, font, color: MUTED });
      l.y -= size + 4;
    }
    l.y -= 2;
  };
  for (const [k, v] of facts) pair(k, v, 9);
  if (bundle.targets.length) {
    drawWidgetTitle(l, L.targets);
    for (const t of bundle.targets) {
      const color = t.met === true ? TONE.good : t.met === false ? TONE.bad : FAINT;
      l.page.drawCircle({ x: MARGIN + 3, y: l.y - 5.5, size: 2.5, color });
      l.paragraph(t.text, { size: 8.5, indent: 10 });
    }
  }
  if (bundle.definitions.length) {
    drawWidgetTitle(l, L.definitions);
    for (const d of bundle.definitions) pair(d.label, d.definition, 8.5);
  }
  if (bundle.limits.length) {
    drawWidgetTitle(l, L.limits);
    for (const limit of bundle.limits) l.paragraph(limit, { size: 8.5, color: MUTED });
  }
  l.y -= 6;
  l.paragraph(
    `${f.date(bundle.generatedAt, bundle.timeZone)}${bundle.piwiVersion ? ` · ${bundle.piwiVersion}` : ''}${bundle.sourceUrl ? ` · ${bundle.sourceUrl}` : ''}`,
    { size: 8, color: MUTED },
  );
  l.y -= 14;
  l.ensure(PDF_CREDIT_HEIGHT);
  drawPiwiCredit(doc, l.page, { x: MARGIN, top: l.y, width: WIDTH, label: L.generatedBy, font });
  l.y -= PDF_CREDIT_HEIGHT;

  const pages = doc.getPages();
  const running = `${L.qualityReport} · ${bundle.dashboard.name} · ${bundle.title}`;
  pages.forEach((page, i) => {
    page.drawRectangle({ x: 0, y: PAGE_H - 5, width: PAGE_W, height: 5, color: ACCENT });
    if (i > 0) {
      page.drawText(l.fit(running, 7, WIDTH), { x: MARGIN, y: PAGE_H - MARGIN / 2 - 4, size: 7, font, color: FAINT });
    }
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
