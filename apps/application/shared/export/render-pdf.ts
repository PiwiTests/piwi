/**
 * Renders an `ExportBundle` as a real PDF — the same bytes on the server, the
 * desktop shell and the demo, with no browser print dialog and no headless
 * browser anywhere. `pdf-lib` lays out vector text and embeds screenshots
 * directly, so the file opens identically everywhere and its text stays
 * selectable and searchable.
 *
 * Only screenshots embed: video and trace archives cannot live in a PDF, so
 * they are listed by name — the same evidence the HTML report references but
 * does not inline.
 *
 * Every value here comes from a test run — error text, console output, page
 * source — so all of it is drawn as data. Standard PDF fonts encode Windows-1252
 * only, so `winAnsiSafe` folds the characters a run can carry but the font
 * cannot into safe equivalents rather than letting the encoder throw.
 *
 * Source blocks are syntax-highlighted with the same highlight.js setup the HTML
 * report uses: it tokenizes server-side just as well, and `highlightToSpans`
 * turns its markup into a token stream `pdf-lib` can paint as colored runs.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { stripAnsi } from '#shared/error-fingerprint';
import {
  highlightLinesToSpans,
  highlightToSpans,
  isKnownLanguage,
  languageForPath,
  type HighlightSpan,
} from '#shared/highlight';
import { parseSourceSnippet } from '#shared/source-snippet';
import {
  caseFacts,
  clusterFacts,
  diagnosisFacts,
  fmtBytes,
  fmtDuration,
  hasDiagnosis,
  OMISSION_REASONS,
  projectLabel,
  type Fact,
} from './fields';
import { drawPiwiCredit } from '#shared/brand';
import { STATUS_COLORS, hexToRgb } from '#shared/status-colors';
import type { ExportAsset, ExportBundle, ExportCase } from './types';

export interface PdfRenderOptions {
  /** Bytes for an embeddable screenshot, or null to leave it out. */
  imageFor: (asset: ExportAsset) => Uint8Array | null;
}

type Color = ReturnType<typeof rgb>;

/** A `#rrggbb` literal as a pdf-lib color. */
function hexColor(hex: string): Color {
  const [r, g, b] = hexToRgb(hex);
  return rgb(r / 255, g / 255, b / 255);
}

const COLORS = {
  fg: rgb(0.11, 0.11, 0.13),
  muted: rgb(0.42, 0.42, 0.46),
  faint: rgb(0.55, 0.55, 0.59),
  line: rgb(0.89, 0.89, 0.91),
  lineStrong: rgb(0.79, 0.79, 0.82),
  accent: rgb(0.26, 0.22, 0.79),
  fail: hexColor(STATUS_COLORS.failed.text),
  pass: hexColor(STATUS_COLORS.passed.text),
  warn: hexColor(STATUS_COLORS.didnotrun.text),
  info: rgb(0.11, 0.31, 0.83),
  sunken: rgb(0.96, 0.96, 0.97),
  // Syntax tokens, matching the light `--tok-*` palette of the HTML report.
  tokKey: rgb(0.486, 0.227, 0.929),
  tokStr: rgb(0.059, 0.463, 0.431),
  tokNum: rgb(0.706, 0.325, 0.035),
  tokFn: rgb(0.114, 0.306, 0.847),
  tokAttr: rgb(0.635, 0.11, 0.686),
  tokBuiltin: rgb(0.012, 0.412, 0.631),
} as const;

/** highlight.js scope → the color that carries it, mirroring the HTML report's CSS. */
const TOKEN_COLORS: Record<string, Color> = {
  comment: COLORS.faint,
  quote: COLORS.faint,
  keyword: COLORS.tokKey,
  'selector-tag': COLORS.tokKey,
  literal: COLORS.tokKey,
  type: COLORS.tokKey,
  meta: COLORS.tokKey,
  string: COLORS.tokStr,
  regexp: COLORS.tokStr,
  symbol: COLORS.tokStr,
  char: COLORS.tokStr,
  number: COLORS.tokNum,
  bullet: COLORS.tokNum,
  title: COLORS.tokFn,
  section: COLORS.tokFn,
  name: COLORS.tokFn,
  attr: COLORS.tokAttr,
  attribute: COLORS.tokAttr,
  property: COLORS.tokAttr,
  variable: COLORS.tokAttr,
  'template-variable': COLORS.tokAttr,
  built_in: COLORS.tokBuiltin,
  addition: COLORS.pass,
  deletion: COLORS.fail,
};

const PAGE_WIDTH = 595.28; // A4 portrait
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/** Windows-1252 punctuation the standard fonts can render at its own code point. */
const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018,
  0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/** Common characters a run emits that Windows-1252 lacks, mapped to plain text. */
const REPLACEMENTS: Record<string, string> = {
  '→': '->',
  '←': '<-',
  '↑': '^',
  '↓': 'v',
  '⇒': '=>',
  '↳': '->',
  '✓': '[ok]',
  '✔': '[ok]',
  '✗': '[x]',
  '✘': '[x]',
  '⚠': '(!)',
  '│': '|',
  '─': '-',
  '├': '|',
  '└': '`',
  '▶': '>',
  // French puts a narrow no-break space before % and between thousands; the font has the plain one.
  '\u202f': '\u00a0',
  '\u2009': ' ',
  // The minus sign of a report's changes (−2.1 pts).
  '\u2212': '-',
};

/**
 * Fold a string to characters a standard PDF font can encode: printable ASCII,
 * Latin-1 and the Windows-1252 punctuation, with common symbols mapped to text
 * and everything else replaced. Control characters — newlines included — become
 * a space, so callers split on newlines first to keep line breaks.
 */
export function winAnsiSafe(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9) {
      out += '    ';
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // C0 / DEL / C1 controls — nothing printable.
      out += ' ';
    } else if (code <= 0xff || WIN_ANSI_EXTRA.has(code)) {
      out += ch;
    } else {
      out += REPLACEMENTS[ch] ?? '?';
    }
  }
  return out;
}

/** Status-ish value → the color that carries its meaning, matching the dashboard. */
function statusColor(value: unknown): Color {
  const v = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (v === 'passed' || v === 'resolved') return COLORS.pass;
  if (v === 'didnotrun' || v === 'warning' || v === 'warn') return COLORS.warn;
  if (v === 'skipped' || v === 'log' || v === 'debug' || v === 'ignored') return COLORS.muted;
  if (v === 'info') return COLORS.info;
  return COLORS.fail;
}

function httpColor(status: unknown): Color {
  const n = Number(status);
  if (!Number.isFinite(n)) return COLORS.fg;
  if (n >= 500) return COLORS.fail;
  if (n >= 400) return COLORS.warn;
  if (n >= 300) return COLORS.info;
  if (n >= 200) return COLORS.pass;
  return COLORS.fg;
}

/** A run of monospace text sharing one color, the unit a highlighted line draws. */
interface CodeSegment {
  text: string;
  color: Color;
}

/**
 * Fold highlighted spans into wrapped, colored lines. Newlines become hard
 * breaks (so indentation survives) and each visual line is hard-wrapped at
 * `maxChars` — the mono font is fixed-width, so a character budget is the exact
 * column count and never splits a glyph mid-color.
 */
function layoutHighlighted(spans: HighlightSpan[], maxChars: number): CodeSegment[][] {
  const lines: CodeSegment[][] = [[]];
  let col = 0;
  for (const span of spans) {
    const color = TOKEN_COLORS[span.scope] ?? COLORS.fg;
    span.text.split('\n').forEach((part, i) => {
      if (i > 0) {
        lines.push([]);
        col = 0;
      }
      let text = winAnsiSafe(part);
      while (text.length > 0) {
        if (col >= maxChars) {
          lines.push([]);
          col = 0;
        }
        const take = text.slice(0, maxChars - col);
        lines[lines.length - 1]!.push({ text: take, color });
        col += take.length;
        text = text.slice(take.length);
      }
    });
  }
  return lines;
}

/** A captured source snippet as spans: the line-number gutter faint, the code syntax-highlighted. */
function snippetSpans(text: string, file: string): HighlightSpan[] {
  const rows = parseSourceSnippet(stripAnsi(text));
  const code = highlightLinesToSpans(
    rows.map((row) => row.code),
    languageForPath(file),
  );
  return rows.flatMap((row, i) => [
    { text: i === 0 ? row.gutter : `\n${row.gutter}`, scope: 'comment' },
    ...(code[i] ?? []),
  ]);
}

interface TextOptions {
  font?: PDFFont;
  size?: number;
  color?: Color;
  x?: number;
  maxWidth?: number;
  lineGap?: number;
}

/**
 * A downward-flowing cursor over one or more pages. Every primitive advances
 * `y`, adds a page when a block would cross the bottom margin, and never leaves
 * layout to the caller.
 */
class PdfBuilder {
  private page: PDFPage;
  private y = 0;

  constructor(
    readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    readonly mono: PDFFont,
  ) {
    this.page = this.addPage();
  }

  private addPage(): PDFPage {
    const page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
    return page;
  }

  newPage(): void {
    this.page = this.addPage();
  }

  space(height: number): void {
    this.y -= height;
  }

  /** Room left on the current page above the bottom margin. */
  private get available(): number {
    return this.y - MARGIN;
  }

  private ensure(height: number): void {
    if (this.available < height) this.newPage();
  }

  /** Hard-split a token that on its own is wider than the column. */
  private splitToken(token: string, font: PDFFont, size: number, maxWidth: number): string[] {
    if (font.widthOfTextAtSize(token, size) <= maxWidth) return [token];
    const parts: string[] = [];
    let current = '';
    for (const ch of token) {
      const next = current + ch;
      if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
        parts.push(current);
        current = ch;
      } else {
        current = next;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  private wrapLine(line: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const out: string[] = [];
    let current = '';
    for (const token of line.split(' ')) {
      for (const piece of this.splitToken(token, font, size, maxWidth)) {
        const candidate = current ? `${current} ${piece}` : piece;
        if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
          out.push(current);
          current = piece;
        } else {
          current = candidate;
        }
      }
    }
    out.push(current);
    return out;
  }

  wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    return text.split('\n').flatMap((line) => this.wrapLine(winAnsiSafe(line), font, size, maxWidth));
  }

  /** A flowing paragraph; wraps, paginates and returns the cursor below it. */
  text(value: string, opts: TextOptions = {}): void {
    const font = opts.font ?? this.regular;
    const size = opts.size ?? 9.5;
    const color = opts.color ?? COLORS.fg;
    const x = opts.x ?? MARGIN;
    const maxWidth = opts.maxWidth ?? MARGIN + CONTENT_WIDTH - x;
    const lineGap = opts.lineGap ?? size * 0.5;
    const lineHeight = size + lineGap;
    for (const line of this.wrap(value, font, size, maxWidth)) {
      this.ensure(lineHeight);
      this.page.drawText(line, { x, y: this.y - size, size, font, color });
      this.y -= lineHeight;
    }
  }

  eyebrow(value: string): void {
    this.text(value.toUpperCase(), { font: this.bold, size: 7.5, color: COLORS.accent, lineGap: 3 });
    this.space(2);
  }

  heading1(value: string): void {
    this.space(2);
    this.text(value, { font: this.bold, size: 18, lineGap: 4 });
    this.space(2);
  }

  heading2(value: string): void {
    this.space(6);
    this.text(value, { font: this.bold, size: 13, lineGap: 3 });
    this.space(1);
  }

  /** The small uppercase section label above a block (Error, Steps, Console…). */
  sectionLabel(value: string): void {
    this.space(6);
    this.text(value.toUpperCase(), { font: this.bold, size: 7.5, color: COLORS.muted, lineGap: 3 });
    this.space(1);
  }

  /** The closing credit: the Piwi mark, `label` and the site, linked. */
  credit(label: string): void {
    this.ensure(14);
    drawPiwiCredit(this.doc, this.page, {
      x: MARGIN,
      top: this.y,
      size: 11,
      label,
      font: this.regular,
      textSize: 8,
      textColor: COLORS.muted,
    });
    this.y -= 15;
  }

  meta(value: string, font: PDFFont = this.regular): void {
    this.text(value, { font, size: 8, color: COLORS.muted, lineGap: 3 });
  }

  statusLine(value: unknown): void {
    this.text(String(value ?? '').toUpperCase(), {
      font: this.bold,
      size: 8,
      color: statusColor(value),
      lineGap: 3,
    });
  }

  rule(color: Color = COLORS.line, thickness = 0.5): void {
    this.space(4);
    this.ensure(thickness + 4);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: MARGIN + CONTENT_WIDTH, y: this.y },
      thickness,
      color,
    });
    this.space(6);
  }

  /** A two-column label/value grid; `null` values are dropped by the caller. */
  factsGrid(facts: Fact[]): void {
    const present = facts.filter(([, v]) => v != null && v !== '');
    if (!present.length) return;
    this.space(4);
    const gap = 18;
    const colWidth = (CONTENT_WIDTH - gap) / 2;
    const labelSize = 6.5;
    const valueSize = 8.5;
    const valueLineHeight = valueSize + valueSize * 0.4;

    for (let i = 0; i < present.length; i += 2) {
      const cells = present.slice(i, i + 2).map(([label, value]) => ({
        label,
        lines: this.wrap(String(value), this.regular, valueSize, colWidth - 8),
      }));
      const bodyLines = Math.max(...cells.map((c) => c.lines.length));
      const rowHeight = labelSize + 4 + bodyLines * valueLineHeight + 6;
      this.ensure(rowHeight);
      const top = this.y;

      cells.forEach((cell, idx) => {
        const x = MARGIN + idx * (colWidth + gap);
        this.page.drawRectangle({ x, y: top - rowHeight + 6, width: 2, height: rowHeight - 8, color: COLORS.line });
        let cursor = top - labelSize;
        this.page.drawText(winAnsiSafe(cell.label).toUpperCase(), {
          x: x + 8,
          y: cursor,
          size: labelSize,
          font: this.bold,
          color: COLORS.faint,
        });
        cursor -= labelSize + 4;
        for (const line of cell.lines) {
          this.page.drawText(line, {
            x: x + 8,
            y: cursor - valueSize + labelSize,
            size: valueSize,
            font: this.regular,
            color: COLORS.fg,
          });
          cursor -= valueLineHeight;
        }
      });
      this.y = top - rowHeight;
    }
  }

  /**
   * A monospace block on a sunken background, split cleanly across pages. Spans
   * are drawn in their token colors; text with a known `lang` is
   * syntax-highlighted into colored runs; text without one (stack traces, raw
   * errors) is drawn as a single plain run per line.
   */
  codeBlock(source: string | HighlightSpan[], lang?: string): void {
    const size = 8;
    const lineGap = size * 0.5;
    const lineHeight = size + lineGap;
    const padX = 6;
    const padY = 5;
    const innerWidth = CONTENT_WIDTH - padX * 2;
    const maxChars = Math.max(1, Math.floor(innerWidth / this.mono.widthOfTextAtSize('M', size)));

    let lines: CodeSegment[][];
    if (typeof source !== 'string') {
      lines = layoutHighlighted(source, maxChars);
    } else if (lang && isKnownLanguage(lang)) {
      lines = layoutHighlighted(highlightToSpans(stripAnsi(source), lang).spans, maxChars);
    } else {
      lines = this.wrap(stripAnsi(source), this.mono, size, innerWidth).map((line) => [
        { text: line, color: COLORS.fg },
      ]);
    }
    this.space(2);

    let index = 0;
    while (index < lines.length) {
      if (this.available < lineHeight + padY * 2) this.newPage();
      const fit = Math.max(1, Math.floor((this.available - padY * 2) / lineHeight));
      const chunk = lines.slice(index, index + fit);
      const blockHeight = chunk.length * lineHeight + padY * 2;
      this.page.drawRectangle({
        x: MARGIN,
        y: this.y - blockHeight,
        width: CONTENT_WIDTH,
        height: blockHeight,
        color: COLORS.sunken,
        borderColor: COLORS.line,
        borderWidth: 0.5,
      });
      let cursor = this.y - padY - size;
      for (const line of chunk) {
        let x = MARGIN + padX;
        for (const seg of line) {
          this.page.drawText(seg.text, { x, y: cursor, size, font: this.mono, color: seg.color });
          x += this.mono.widthOfTextAtSize(seg.text, size);
        }
        cursor -= lineHeight;
      }
      this.y -= blockHeight;
      index += chunk.length;
    }
    this.space(4);
  }

  bullets(items: string[]): void {
    for (const item of items) {
      const top = this.y;
      this.text(item, { x: MARGIN + 12, maxWidth: CONTENT_WIDTH - 12, size: 9 });
      this.page.drawText('-', { x: MARGIN + 2, y: top - 9, size: 9, font: this.regular, color: COLORS.muted });
    }
  }

  /**
   * A table with wrapped cells and a header that repeats on every page. `cells`
   * of a row may carry a color; the header stays faint and uppercase.
   */
  table(headers: string[], rows: { text: string; color?: Color; font?: PDFFont }[][], weights: number[]): void {
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / total) * CONTENT_WIDTH);
    const size = 8;
    const lineGap = size * 0.45;
    const lineHeight = size + lineGap;
    const padX = 4;
    const padY = 3;

    const drawHeader = () => {
      this.ensure(lineHeight + padY * 2);
      const top = this.y;
      let x = MARGIN;
      headers.forEach((header, idx) => {
        this.page.drawText(winAnsiSafe(header).toUpperCase(), {
          x: x + padX,
          y: top - size,
          size: 6.5,
          font: this.bold,
          color: COLORS.faint,
        });
        x += widths[idx] ?? 0;
      });
      this.y = top - (size + padY * 2);
      this.page.drawLine({
        start: { x: MARGIN, y: this.y },
        end: { x: MARGIN + CONTENT_WIDTH, y: this.y },
        thickness: 0.5,
        color: COLORS.lineStrong,
      });
      this.y -= 2;
    };

    this.space(4);
    drawHeader();

    for (const row of rows) {
      const wrapped = row.map((cell, idx) =>
        this.wrap(cell.text, cell.font ?? this.regular, size, (widths[idx] ?? 0) - padX * 2),
      );
      const rowHeight = Math.max(1, ...wrapped.map((w) => w.length)) * lineHeight + padY * 2;
      if (this.available < rowHeight) {
        this.newPage();
        drawHeader();
      }
      const top = this.y;
      let x = MARGIN;
      row.forEach((cell, idx) => {
        let cursor = top - padY - size;
        for (const line of wrapped[idx] ?? []) {
          this.page.drawText(line, {
            x: x + padX,
            y: cursor,
            size,
            font: cell.font ?? this.regular,
            color: cell.color ?? COLORS.fg,
          });
          cursor -= lineHeight;
        }
        x += widths[idx] ?? 0;
      });
      this.y = top - rowHeight;
      this.page.drawLine({
        start: { x: MARGIN, y: this.y },
        end: { x: MARGIN + CONTENT_WIDTH, y: this.y },
        thickness: 0.25,
        color: COLORS.line,
      });
    }
    this.space(4);
  }

  async image(bytes: Uint8Array, contentType: string): Promise<boolean> {
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const preferPng = isPng || /png/i.test(contentType);
    let image: Awaited<ReturnType<PDFDocument['embedPng']>> | null = null;
    try {
      image = preferPng ? await this.doc.embedPng(bytes) : await this.doc.embedJpg(bytes);
    } catch {
      try {
        image = preferPng ? await this.doc.embedJpg(bytes) : await this.doc.embedPng(bytes);
      } catch {
        return false;
      }
    }

    // A padded, bordered frame on a sunken ground so a screenshot reads as
    // inset evidence rather than part of the text flow, echoing the HTML report's
    // bordered `img.shot`. The image is inset by `pad`, so it fits the frame.
    const pad = 5;
    let { width, height } = image;
    const scale = Math.min((CONTENT_WIDTH - pad * 2) / width, 340 / height, 1);
    width *= scale;
    height *= scale;
    const pageArea = PAGE_HEIGHT - MARGIN * 2 - pad * 2;
    if (height > pageArea) {
      const shrink = pageArea / height;
      width *= shrink;
      height *= shrink;
    }
    const frameHeight = height + pad * 2;
    this.ensure(frameHeight + 6);
    const top = this.y;
    this.page.drawRectangle({
      x: MARGIN,
      y: top - frameHeight,
      width: width + pad * 2,
      height: frameHeight,
      color: COLORS.sunken,
      borderColor: COLORS.lineStrong,
      borderWidth: 0.75,
    });
    this.page.drawImage(image, { x: MARGIN + pad, y: top - pad - height, width, height });
    this.y = top - frameHeight;
    this.space(6);
    return true;
  }

  save(): Promise<Uint8Array> {
    return this.doc.save();
  }
}

function renderDiagnosis(b: PdfBuilder, diagnosis: Record<string, unknown> | null): void {
  if (!hasDiagnosis(diagnosis)) return;
  const d = diagnosis as Record<string, any>;
  const det = (d.details ?? {}) as Record<string, any>;

  b.sectionLabel('AI diagnosis');
  b.factsGrid(diagnosisFacts(d));
  if (d.summary) b.text(String(d.summary), { font: b.bold });
  if (d.rootCause) b.text(`Root cause: ${String(d.rootCause)}`);

  const evidence = (det.evidence ?? []) as unknown[];
  if (evidence.length) {
    b.sectionLabel('Evidence');
    b.bullets(evidence.map((e) => String(e)));
  }

  const fix = (det.suggestedFix ?? null) as Record<string, any> | null;
  if (fix) {
    b.sectionLabel('Suggested fix');
    if (fix.description) b.text(String(fix.description));
    if (fix.patch) b.codeBlock(String(fix.patch), 'diff');
    else if (fix.code) b.codeBlock(String(fix.code), 'typescript');
  }
}

async function renderCase(
  b: PdfBuilder,
  exportCase: ExportCase,
  opts: PdfRenderOptions,
  index: number,
  total: number,
): Promise<void> {
  const d = exportCase.detail as Record<string, any>;

  if (index > 0) b.rule();
  if (total > 1) b.eyebrow(`Case ${index + 1} of ${total}`);
  b.heading2(exportCase.title);
  b.statusLine(exportCase.status);
  const location = exportCase.location ?? exportCase.filePath ?? '';
  if (location) b.meta(location, b.mono);

  b.factsGrid(caseFacts(exportCase));

  if (d.error) {
    b.sectionLabel('Error');
    b.codeBlock(String(d.error));
  }

  renderDiagnosis(b, exportCase.diagnosis);

  const screenshots = exportCase.assets.filter((a) => a.kind === 'screenshot');
  const embedded: string[] = [];
  for (const asset of screenshots) {
    const bytes = opts.imageFor(asset);
    if (!bytes) continue;
    if (embedded.length === 0) b.sectionLabel('Screenshots');
    if (await b.image(bytes, asset.contentType)) {
      b.meta(asset.name, b.regular);
      embedded.push(asset.name);
    }
  }

  const steps = (d.steps ?? []) as Record<string, any>[];
  if (Array.isArray(steps) && steps.length) {
    b.sectionLabel('Steps');
    b.table(
      ['Step', 'Category', 'Duration'],
      steps.map((step) => [
        { text: String(step.title ?? '') },
        { text: String(step.category ?? ''), color: COLORS.muted },
        { text: fmtDuration(step.duration), font: b.mono },
      ]),
      [6, 2, 2],
    );
  }

  const logs = (d.consoleLogs ?? []) as Record<string, any>[];
  if (Array.isArray(logs) && logs.length) {
    b.sectionLabel('Console');
    b.table(
      ['Level', 'Message'],
      logs.map((log) => [
        { text: String(log.type ?? 'log'), color: statusColor(log.type ?? 'log'), font: b.bold },
        { text: String(log.text ?? '') },
      ]),
      [1, 6],
    );
  }

  const requests = (d.networkRequests ?? []) as Record<string, any>[];
  if (Array.isArray(requests) && requests.length) {
    b.sectionLabel('Network');
    b.table(
      ['Method', 'Status', 'Time', 'URL'],
      requests.map((r) => [
        { text: String(r.method ?? ''), font: b.mono },
        { text: String(r.status ?? ''), color: httpColor(r.status), font: b.bold },
        { text: fmtDuration(r.duration), font: b.mono },
        { text: String(r.url ?? '') },
      ]),
      [1.2, 1, 1, 5],
    );
  }

  if (d.testSource) {
    b.sectionLabel('Test source');
    b.codeBlock(String(d.testSource), 'typescript');
  }

  if (Array.isArray(d.testSourceFrames) && d.testSourceFrames.length) {
    b.sectionLabel('Call stack');
    for (const frame of d.testSourceFrames as Record<string, any>[]) {
      b.meta(`${frame.file ?? ''}:${frame.line ?? ''}`, b.mono);
      if (frame.snippet) b.codeBlock(snippetSpans(String(frame.snippet), String(frame.file ?? '')));
    }
  }

  if (d.ariaSnapshot) {
    b.sectionLabel('ARIA snapshot');
    b.codeBlock(String(d.ariaSnapshot), 'yaml');
  }
}

function renderClusterHeader(b: PdfBuilder, bundle: ExportBundle): void {
  const cluster = bundle.cluster as Record<string, any> | null;
  if (!cluster) return;

  b.factsGrid(clusterFacts(cluster));

  if (cluster.sampleError) {
    b.sectionLabel('Representative error');
    b.codeBlock(String(cluster.sampleError));
  }

  renderDiagnosis(b, (cluster.diagnosis ?? null) as Record<string, unknown> | null);

  if (bundle.truncatedCases.length) {
    b.sectionLabel(`Other affected tests (${bundle.truncatedCases.length}, evidence not included)`);
    b.bullets(bundle.truncatedCases.map((t) => `${t.title}${t.filePath ? `  ${t.filePath}` : ''}`));
  }
}

function renderOmissions(b: PdfBuilder, bundle: ExportBundle): void {
  if (!bundle.omitted.length) return;
  b.sectionLabel(`Omitted from this export (${bundle.omitted.length})`);
  b.table(
    ['File', 'Kind', 'Size', 'Reason'],
    bundle.omitted.map((o) => [
      { text: o.name },
      { text: o.kind, color: COLORS.muted },
      { text: fmtBytes(o.bytes), font: b.mono },
      { text: OMISSION_REASONS[o.reason] ?? o.reason, color: COLORS.muted },
    ]),
    [3, 1.5, 1.5, 4],
  );
}

export async function renderExportPdf(bundle: ExportBundle, opts: PdfRenderOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Piwi — ${bundle.title}`);
  doc.setCreator('Piwi');
  doc.setProducer('Piwi');
  const created = new Date(bundle.generatedAt);
  if (!Number.isNaN(created.getTime())) doc.setCreationDate(created);

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const b = new PdfBuilder(doc, regular, bold, mono);

  const kindLabel = bundle.kind === 'cluster' ? 'Failure cluster' : 'Test execution';
  const label = projectLabel(bundle);
  b.eyebrow(`${kindLabel}${label ? ` · ${label}` : ''}`);
  b.heading1(bundle.title);
  const clusterStatus = (bundle.cluster as Record<string, any> | null)?.status;
  if (bundle.kind === 'cluster' && clusterStatus) b.statusLine(clusterStatus);
  b.meta(`Exported ${bundle.generatedAt}${bundle.piwiVersion ? ` · Piwi ${bundle.piwiVersion}` : ''}`);
  if (bundle.sourceUrl) b.meta(bundle.sourceUrl, mono);
  b.rule(COLORS.lineStrong, 1);

  if (bundle.kind === 'cluster') renderClusterHeader(b, bundle);

  for (let i = 0; i < bundle.cases.length; i++) {
    const exportCase = bundle.cases[i];
    if (exportCase) await renderCase(b, exportCase, opts, i, bundle.cases.length);
  }
  if (bundle.cases.length === 0) {
    b.text('No executions were included in this export.', { color: COLORS.muted });
  }

  renderOmissions(b, bundle);
  b.space(10);
  b.credit('Generated by Piwi');
  b.meta('Self-contained, no network connection required.');

  return b.save();
}
