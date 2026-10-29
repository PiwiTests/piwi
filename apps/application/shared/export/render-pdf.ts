/**
 * Renders an `ExportBundle` as a real PDF — the same bytes on the server, the
 * desktop shell and the demo, with no browser print dialog and no headless
 * browser anywhere. `pdf-lib` lays out vector text and embeds screenshots
 * directly, so the file opens identically everywhere and its text stays
 * selectable and searchable.
 *
 * The document follows the HTML report: a header tinted by the outcome, the
 * execution's figures as tiles, its run's tests as a bar split by outcome, the
 * error with its expected and received values colored, the failing source line
 * marked, and the steps on the test's timeline.
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
  SCOPE_ROLES,
  type HighlightSpan,
  type TokenRole,
} from '#shared/highlight';
import { parseSourceSnippet } from '#shared/source-snippet';
import { stepLabelParts } from '@piwitests/core/step-analysis';
import { percent, type OutcomeSegment } from '#shared/notifications/message-parts';
import {
  caseFacts,
  caseHeadline,
  caseLabels,
  casePath,
  clusterFacts,
  clusterHeadline,
  clusterOccurrences,
  clusterOccurrencesText,
  clusterOwner,
  clusterState,
  diagnosisFacts,
  errorRows,
  fmtBytes,
  fmtDate,
  fmtDuration,
  fmtStepDuration,
  hasDiagnosis,
  OMISSION_REASONS,
  projectLabel,
  runFacts,
  runFailureGroups,
  runHeadline,
  runSummaryFacts,
  runTestsByOutcome,
  runTestDuration,
  runTestStatus,
  slowestTests,
  statusTone,
  statusLabel,
  stepBars,
  type CaseLabel,
  type ErrorRowKind,
  type Fact,
} from './fields';
import { drawPiwiCredit, PDF_CREDIT_HEIGHT } from '#shared/brand';
import { STATUS_COLORS, hexToRgb, type StatusColorKey } from '#shared/status-colors';
import type { ExportAsset, ExportBundle, ExportCase, ExportRun } from './types';

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

/** A `#rrggbb` color laid at `alpha` over white: the tint behind a header or a failing line. */
export function tint(hex: string, alpha: number): Color {
  const [r, g, b] = hexToRgb(hex);
  const mix = (c: number) => (255 - (255 - c) * alpha) / 255;
  return rgb(mix(r), mix(g), mix(b));
}

const COLORS = {
  fg: rgb(0.11, 0.11, 0.13),
  muted: rgb(0.37, 0.37, 0.42),
  faint: rgb(0.55, 0.55, 0.59),
  line: rgb(0.89, 0.89, 0.91),
  lineStrong: rgb(0.79, 0.79, 0.82),
  accent: hexColor('#4f46e5'),
  white: rgb(1, 1, 1),
  fail: hexColor(STATUS_COLORS.failed.text),
  pass: hexColor(STATUS_COLORS.passed.text),
  warn: hexColor(STATUS_COLORS.didnotrun.text),
  info: rgb(0.11, 0.31, 0.83),
  sunken: rgb(0.965, 0.965, 0.975),
  failTint: tint(STATUS_COLORS.failed.fill, 0.1),
  // Syntax tokens, matching the light `--tok-*` palette of the HTML report.
  tokKey: rgb(0.486, 0.227, 0.929),
  tokStr: rgb(0.059, 0.463, 0.431),
  tokNum: rgb(0.706, 0.325, 0.035),
  tokFn: rgb(0.114, 0.306, 0.847),
  tokAttr: rgb(0.635, 0.11, 0.686),
  tokBuiltin: rgb(0.012, 0.412, 0.631),
} as const;

/** Each token role's color, mirroring the HTML report's CSS. */
const ROLE_COLORS: Record<TokenRole, Color> = {
  comment: COLORS.faint,
  keyword: COLORS.tokKey,
  string: COLORS.tokStr,
  number: COLORS.tokNum,
  function: COLORS.tokFn,
  attribute: COLORS.tokAttr,
  builtin: COLORS.tokBuiltin,
  addition: COLORS.pass,
  deletion: COLORS.fail,
};

/** highlight.js scope → the color that carries it. */
const TOKEN_COLORS: Record<string, Color> = Object.fromEntries(
  Object.entries(SCOPE_ROLES).map(([scope, role]) => [scope, ROLE_COLORS[role]]),
);

/** The color of each line of an error, as the HTML report's `pre.error` paints it. */
const ERROR_COLORS: Record<ErrorRowKind, Color> = {
  head: COLORS.fail,
  expected: COLORS.pass,
  received: COLORS.fail,
  log: COLORS.muted,
  stack: COLORS.faint,
  body: COLORS.fg,
};

const PAGE_WIDTH = 595.28; // A4 portrait
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
/** The band under the bottom margin where each page's footer sits. */
const FOOTER_Y = MARGIN / 2;

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

/** A run of monospace text sharing one color and font, the unit a code line draws. */
interface CodeSegment {
  text: string;
  color: Color;
  bold?: boolean;
}

/** One source or error line as drawn: its segments, and the tint behind it (the failing line's). */
interface CodeLine {
  segments: CodeSegment[];
  tint?: Color;
}

/**
 * Fold colored segments into wrapped lines. Newlines become hard breaks (so
 * indentation survives) and each visual line is hard-wrapped at `maxChars` —
 * the mono font is fixed-width, so a character budget is the exact column
 * count and never splits a glyph mid-color.
 */
function wrapSegments(segments: CodeSegment[], maxChars: number): CodeSegment[][] {
  const lines: CodeSegment[][] = [[]];
  let col = 0;
  for (const segment of segments) {
    segment.text.split('\n').forEach((part, i) => {
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
        lines[lines.length - 1]!.push({ ...segment, text: take });
        col += take.length;
        text = text.slice(take.length);
      }
    });
  }
  return lines;
}

function spanSegments(spans: HighlightSpan[]): CodeSegment[] {
  return spans.map((span) => ({ text: span.text, color: TOKEN_COLORS[span.scope] ?? COLORS.fg }));
}

/** A captured source snippet as lines: the gutter faint, the code highlighted, the failing line tinted and marked. */
function snippetLines(text: string, file: string, maxChars: number): CodeLine[] {
  const rows = parseSourceSnippet(stripAnsi(text));
  const code = highlightLinesToSpans(
    rows.map((row) => row.code),
    languageForPath(file),
  );
  return rows.flatMap((row, i) => {
    const gutter: CodeSegment = row.failing
      ? { text: row.gutter, color: COLORS.fail, bold: true }
      : { text: row.gutter, color: COLORS.faint };
    const wrapped = wrapSegments([gutter, ...spanSegments(code[i] ?? [])], maxChars);
    return wrapped.map((segments) => ({ segments, tint: row.failing ? COLORS.failTint : undefined }));
  });
}

/** An error as lines: the first line, the expected and received values colored, the call log and stack faded. */
function errorCodeLines(text: string, maxChars: number): CodeLine[] {
  return errorRows(text).flatMap((row) =>
    wrapSegments(
      [
        {
          text: row.text,
          color: ERROR_COLORS[row.kind],
          bold: row.kind === 'head' || row.kind === 'expected' || row.kind === 'received',
        },
      ],
      maxChars,
    ).map((segments) => ({ segments })),
  );
}

/** A rounded rectangle as an SVG path, `w` by `h` with corners of radius `r`, from its top left corner. */
export function roundedPath(w: number, h: number, r: number): string {
  const k = Math.min(r, w / 2, h / 2);
  return `M ${k} 0 H ${w - k} A ${k} ${k} 0 0 1 ${w} ${k} V ${h - k} A ${k} ${k} 0 0 1 ${w - k} ${h} H ${k} A ${k} ${k} 0 0 1 0 ${h - k} V ${k} A ${k} ${k} 0 0 1 ${k} 0 Z`;
}

interface TextOptions {
  font?: PDFFont;
  size?: number;
  color?: Color;
  x?: number;
  maxWidth?: number;
  lineGap?: number;
}

/** A cell of a table: text with its color and font, or a bar on the test's timeline. */
interface TableCell {
  text: string;
  color?: Color;
  font?: PDFFont;
  bar?: { offset: number; width: number; color: Color };
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
    readonly monoBold: PDFFont,
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

  /** Clip a string to a width, ending with an ellipsis. */
  fit(text: string, font: PDFFont, size: number, width: number): string {
    const t = winAnsiSafe(text);
    if (font.widthOfTextAtSize(t, size) <= width) return t;
    let lo = 1;
    let hi = t.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (font.widthOfTextAtSize(`${t.slice(0, mid)}…`, size) <= width) lo = mid;
      else hi = mid - 1;
    }
    return `${t.slice(0, lo)}…`;
  }

  /** Wrapped lines kept to `max`, the last one ending with an ellipsis when some were left out. */
  clamp(lines: string[], max: number, font: PDFFont, size: number, width: number): string[] {
    if (lines.length <= max) return lines;
    return [...lines.slice(0, max - 1), this.fit(`${lines[max - 1]} ${lines[max]}`, font, size, width)];
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

  private rounded(
    x: number,
    top: number,
    w: number,
    h: number,
    r: number,
    fill?: Color,
    border?: Color,
    borderWidth = 0.6,
  ) {
    this.page.drawSvgPath(roundedPath(w, h, r), {
      x,
      y: top,
      color: fill,
      borderColor: border,
      borderWidth: border ? borderWidth : 0,
    });
  }

  /** The first line of the document: what it is and the project, then when it was exported. */
  docHeader(kind: string, stamp: string, sourceUrl: string | null): void {
    const size = 7.5;
    const right = this.fit(stamp, this.regular, size, CONTENT_WIDTH / 2);
    const label = this.fit(
      kind.toUpperCase(),
      this.bold,
      size,
      CONTENT_WIDTH - this.regular.widthOfTextAtSize(right, size) - 16,
    );
    this.page.drawText(label, { x: MARGIN, y: this.y - size, size, font: this.bold, color: COLORS.accent });
    this.page.drawText(right, {
      x: MARGIN + CONTENT_WIDTH - this.regular.widthOfTextAtSize(right, size),
      y: this.y - size,
      size,
      font: this.regular,
      color: COLORS.faint,
    });
    this.y -= size + 4;
    if (sourceUrl) {
      const url = this.fit(sourceUrl, this.mono, 7, CONTENT_WIDTH);
      this.page.drawText(url, {
        x: MARGIN + CONTENT_WIDTH - this.mono.widthOfTextAtSize(url, 7),
        y: this.y - 7,
        size: 7,
        font: this.mono,
        color: COLORS.faint,
      });
      this.y -= 11;
    }
    this.space(8);
  }

  /**
   * The header of an execution or a cluster: a box tinted by its outcome with a colored edge, its status and labels as
   * pills, then its title, full name, location and the one-line reading of its failure.
   */
  hero(opts: {
    tone: StatusColorKey;
    status: string | null;
    labels: CaseLabel[];
    title: string;
    titleSize: number;
    path?: string | null;
    location?: string | null;
    headline?: string | null;
    detail?: string | null;
  }): void {
    const pad = 12;
    const edge = 4;
    const innerX = MARGIN + edge + pad;
    const innerWidth = CONTENT_WIDTH - edge - pad * 2;
    // Each block is kept to a few lines, so the box always fits on one page.
    const lines = (text: string | null | undefined, font: PDFFont, size: number, max: number) =>
      text ? this.clamp(this.wrap(text, font, size, innerWidth), max, font, size, innerWidth) : [];
    const titleLines = lines(opts.title, this.bold, opts.titleSize, 6);
    const pathLines = lines(opts.path, this.regular, 9, 3);
    const locationLines = lines(opts.location, this.mono, 8, 2);
    const headlineLines = lines(opts.headline, this.bold, 10, 4);
    const detailLines = lines(opts.detail, this.regular, 9, 8);

    // The status and labels as pills, wrapped onto as many rows as they need.
    const pillHeight = 13;
    const pillGap = 5;
    const pillSize = 7;
    const pills = [...(opts.status ? [{ text: opts.status, news: false, status: true }] : []), ...opts.labels].map(
      (pill) => {
        const status = 'status' in pill;
        const font = status || pill.news ? this.bold : this.regular;
        const text = this.fit(status ? pill.text.toUpperCase() : pill.text, font, pillSize, innerWidth - 12);
        return { text, font, status, news: pill.news, width: font.widthOfTextAtSize(text, pillSize) + 12 };
      },
    );
    const pillRows: (typeof pills)[] = [];
    let rowWidth = Infinity;
    for (const pill of pills) {
      if (rowWidth + pill.width > innerWidth) {
        pillRows.push([]);
        rowWidth = 0;
      }
      pillRows[pillRows.length - 1]!.push(pill);
      rowWidth += pill.width + pillGap;
    }
    const titleLine = opts.titleSize * 1.25;
    const height =
      pad * 2 +
      (pillRows.length ? pillRows.length * (pillHeight + 4) + 3 : 0) +
      titleLines.length * titleLine +
      pathLines.length * 12.5 +
      locationLines.length * 11 +
      (headlineLines.length ? 8 + headlineLines.length * 13.5 : 0) +
      detailLines.length * 12.5;
    this.ensure(height + 8);

    const top = this.y;
    const tone = STATUS_COLORS[opts.tone];
    this.rounded(MARGIN, top, CONTENT_WIDTH, height, 7, hexColor(tone.fill));
    this.rounded(MARGIN + edge, top, CONTENT_WIDTH - edge, height, 6, tint(tone.fill, 0.08));

    let cursor = top - pad;
    for (const row of pillRows) {
      let x = innerX;
      for (const pill of row) {
        const color = pill.status ? hexColor(tone.text) : pill.news ? COLORS.fail : COLORS.muted;
        const border = pill.status || pill.news ? color : COLORS.lineStrong;
        this.rounded(x, cursor, pill.width, pillHeight, pillHeight / 2, COLORS.white, border, pill.status ? 1 : 0.6);
        this.page.drawText(pill.text, { x: x + 6, y: cursor - pillHeight + 4, size: pillSize, font: pill.font, color });
        x += pill.width + pillGap;
      }
      cursor -= pillHeight + 4;
    }
    if (pillRows.length) cursor -= 3;
    for (const line of titleLines) {
      this.page.drawText(line, {
        x: innerX,
        y: cursor - opts.titleSize,
        size: opts.titleSize,
        font: this.bold,
        color: COLORS.fg,
      });
      cursor -= titleLine;
    }
    for (const line of pathLines) {
      this.page.drawText(line, { x: innerX, y: cursor - 9, size: 9, font: this.regular, color: COLORS.muted });
      cursor -= 12.5;
    }
    for (const line of locationLines) {
      this.page.drawText(line, { x: innerX, y: cursor - 8, size: 8, font: this.mono, color: COLORS.muted });
      cursor -= 11;
    }
    if (headlineLines.length) cursor -= 8;
    for (const line of headlineLines) {
      this.page.drawText(line, { x: innerX, y: cursor - 10, size: 10, font: this.bold, color: COLORS.fg });
      cursor -= 13.5;
    }
    for (const line of detailLines) {
      this.page.drawText(line, { x: innerX, y: cursor - 9, size: 9, font: this.regular, color: COLORS.muted });
      cursor -= 12.5;
    }
    this.y = top - height;
    this.space(8);
  }

  /**
   * Label/value pairs as tiles, four to a row; a long value (a signature, a note) takes a row of its own. `null`
   * values are dropped.
   */
  tiles(facts: Fact[]): void {
    const present = facts.filter(([, v]) => v != null && v !== '') as [string, string][];
    if (!present.length) return;
    const perRow = 4;
    const gap = 6;
    const narrow = (CONTENT_WIDTH - gap * (perRow - 1)) / perRow;
    const labelSize = 6;
    const valueSize = 9;
    const valueLine = valueSize * 1.3;

    const rows: [string, string][][] = [];
    for (const fact of present) {
      const last = rows[rows.length - 1];
      if (fact[1].length > 48) rows.push([fact]);
      else if (last && last.length < perRow && last[0]![1].length <= 48) last.push(fact);
      else rows.push([fact]);
    }

    for (const row of rows) {
      const width = row.length === 1 && row[0]![1].length > 48 ? CONTENT_WIDTH : narrow;
      const cells = row.map(([label, value]) => ({
        label,
        lines: this.clamp(this.wrap(value, this.bold, valueSize, width - 14), 12, this.bold, valueSize, width - 14),
      }));
      const height = 8 + labelSize + 5 + Math.max(...cells.map((c) => c.lines.length)) * valueLine + 4;
      this.ensure(height + gap);
      const top = this.y;
      cells.forEach((cell, idx) => {
        const x = MARGIN + idx * (width + gap);
        this.rounded(x, top, width, height, 5, COLORS.white, COLORS.line);
        let cursor = top - 8 - labelSize;
        this.page.drawText(winAnsiSafe(cell.label.toUpperCase()), {
          x: x + 7,
          y: cursor,
          size: labelSize,
          font: this.bold,
          color: COLORS.faint,
        });
        cursor -= 5;
        for (const line of cell.lines) {
          this.page.drawText(line, {
            x: x + 7,
            y: cursor - valueSize,
            size: valueSize,
            font: this.bold,
            color: COLORS.fg,
          });
          cursor -= valueLine;
        }
      });
      this.y = top - height - gap;
    }
    this.space(2);
  }

  /** A small uppercase label over a block, kept on one page with the `keepWith` points that follow it. */
  label(value: string, keepWith = 0): void {
    this.ensure(14 + keepWith);
    this.page.drawText(winAnsiSafe(value.toUpperCase()), {
      x: MARGIN,
      y: this.y - 7,
      size: 7,
      font: this.bold,
      color: COLORS.muted,
    });
    this.y -= 12;
  }

  /** Label/value pairs on wrapping lines: `Run #4   Branch main   Commit a1b2c3d …`. */
  inlineFacts(facts: Fact[]): void {
    const present = facts.filter(([, v]) => v != null && v !== '') as [string, string][];
    if (!present.length) return;
    const size = 8.5;
    const lineHeight = size + 5;
    let x = MARGIN;
    this.ensure(lineHeight);
    for (const [label, value] of present) {
      const l = winAnsiSafe(label);
      const v = this.fit(value, this.bold, size, CONTENT_WIDTH - this.regular.widthOfTextAtSize(`${l} `, size));
      const width = this.regular.widthOfTextAtSize(`${l} `, size) + this.bold.widthOfTextAtSize(v, size);
      if (x > MARGIN && x + width > MARGIN + CONTENT_WIDTH) {
        x = MARGIN;
        this.y -= lineHeight;
        this.ensure(lineHeight);
      }
      this.page.drawText(`${l} `, { x, y: this.y - size, size, font: this.regular, color: COLORS.faint });
      this.page.drawText(v, {
        x: x + this.regular.widthOfTextAtSize(`${l} `, size),
        y: this.y - size,
        size,
        font: this.bold,
        color: COLORS.fg,
      });
      x += width + 14;
    }
    this.y -= lineHeight;
  }

  /** A run's tests as one bar split by outcome, then each outcome's count and share. */
  outcomeBar(segments: OutcomeSegment[], total: number): void {
    const height = 7;
    this.ensure(height + 24);
    this.space(3);
    // Every outcome keeps a sliver, and the rest of the bar is shared by count.
    const sum = segments.reduce((n, segment) => n + segment.count, 0) || 1;
    const sliver = 2;
    const free = Math.max(0, CONTENT_WIDTH - sliver * segments.length);
    let x = MARGIN;
    for (const segment of segments) {
      const width = sliver + (free * segment.count) / sum;
      this.page.drawRectangle({
        x,
        y: this.y - height,
        width,
        height,
        color: hexColor(STATUS_COLORS[segment.key].fill),
      });
      x += width;
      if (x < MARGIN + CONTENT_WIDTH) {
        this.page.drawRectangle({ x: x - 0.75, y: this.y - height, width: 1.5, height, color: COLORS.white });
      }
    }
    this.y -= height + 7;
    const size = 8;
    x = MARGIN;
    for (const segment of segments) {
      const text = `${segment.count} ${segment.label} (${percent(segment.count, total)})`;
      const width = 10 + this.regular.widthOfTextAtSize(winAnsiSafe(text), size);
      if (x > MARGIN && x + width > MARGIN + CONTENT_WIDTH) {
        x = MARGIN;
        this.y -= size + 5;
      }
      this.page.drawRectangle({
        x,
        y: this.y - size + 0.5,
        width: 6,
        height: 6,
        color: hexColor(STATUS_COLORS[segment.key].fill),
      });
      this.page.drawText(winAnsiSafe(text), {
        x: x + 10,
        y: this.y - size + 1,
        size,
        font: this.regular,
        color: COLORS.muted,
      });
      x += width + 12;
    }
    this.y -= size + 6;
  }

  /** A cluster's occurrences per recent run as small bars, a failing run in red. */
  occurrenceBars(points: Array<{ count: number }>): void {
    const height = 26;
    this.ensure(height + 6);
    const max = Math.max(1, ...points.map((p) => p.count));
    const gap = 3;
    const width = Math.min(16, (CONTENT_WIDTH - gap * (points.length - 1)) / points.length);
    points.forEach((p, i) => {
      const h = p.count > 0 ? Math.max(8, (p.count / max) * height) : 2.5;
      this.page.drawRectangle({
        x: MARGIN + i * (width + gap),
        y: this.y - height,
        width,
        height: h,
        color: p.count > 0 ? hexColor(STATUS_COLORS.failed.fill) : COLORS.lineStrong,
      });
    });
    this.y -= height + 6;
  }

  /**
   * The heading of a section (Error, Steps, Console…): a colored mark, its name and a count, kept with the first lines
   * of what follows it.
   */
  section(title: string, opts: { color?: Color; count?: number; aside?: string | null; keepWith?: number } = {}): void {
    this.space(10);
    this.ensure(Math.max(60, 22 + (opts.keepWith ?? 0)));
    const size = 10.5;
    this.page.drawRectangle({
      x: MARGIN,
      y: this.y - size,
      width: 3,
      height: size + 1,
      color: opts.color ?? COLORS.lineStrong,
    });
    const label = winAnsiSafe(title);
    this.page.drawText(label, { x: MARGIN + 9, y: this.y - size + 1, size, font: this.bold, color: COLORS.fg });
    let x = MARGIN + 9 + this.bold.widthOfTextAtSize(label, size) + 6;
    if (opts.count != null) {
      const count = String(opts.count);
      this.page.drawText(count, { x, y: this.y - size + 1, size: 9, font: this.regular, color: COLORS.faint });
      x += this.regular.widthOfTextAtSize(count, 9) + 8;
    }
    if (opts.aside) {
      const aside = this.fit(opts.aside, this.mono, 7.5, MARGIN + CONTENT_WIDTH - x);
      this.page.drawText(aside, { x, y: this.y - size + 1, size: 7.5, font: this.mono, color: COLORS.faint });
    }
    this.y -= size + 7;
  }

  /** The closing credit, set apart under a hairline: the Piwi mark, `label` and the site, linked. */
  credit(label: string): void {
    this.space(18);
    this.ensure(PDF_CREDIT_HEIGHT);
    drawPiwiCredit(this.doc, this.page, { x: MARGIN, top: this.y, width: CONTENT_WIDTH, label, font: this.regular });
    this.y -= PDF_CREDIT_HEIGHT;
  }

  meta(value: string, font: PDFFont = this.regular): void {
    this.text(value, { font, size: 8, color: COLORS.muted, lineGap: 3 });
  }

  /**
   * A monospace block on a sunken background, split cleanly across pages. Spans
   * are drawn in their token colors; text with a known `lang` is
   * syntax-highlighted into colored runs; text without one is drawn as a single
   * plain run per line. Lines already laid out (a snippet, an error) draw as
   * given, a tinted line over its tint.
   */
  codeBlock(source: string | HighlightSpan[] | ((maxChars: number) => CodeLine[]), lang?: string): void {
    const size = 8;
    const lineHeight = size * 1.5;
    const padX = 7;
    const padY = 6;
    const innerWidth = CONTENT_WIDTH - padX * 2;
    const maxChars = Math.max(1, Math.floor(innerWidth / this.mono.widthOfTextAtSize('M', size)));

    let lines: CodeLine[];
    if (typeof source === 'function') {
      lines = source(maxChars);
    } else if (typeof source !== 'string') {
      lines = wrapSegments(spanSegments(source), maxChars).map((segments) => ({ segments }));
    } else if (lang && isKnownLanguage(lang)) {
      lines = wrapSegments(spanSegments(highlightToSpans(stripAnsi(source), lang).spans), maxChars).map((segments) => ({
        segments,
      }));
    } else {
      lines = wrapSegments([{ text: stripAnsi(source), color: COLORS.fg }], maxChars).map((segments) => ({ segments }));
    }
    this.space(2);

    let index = 0;
    while (index < lines.length) {
      if (this.available < lineHeight + padY * 2) this.newPage();
      const fit = Math.max(1, Math.floor((this.available - padY * 2) / lineHeight));
      const chunk = lines.slice(index, index + fit);
      const blockHeight = chunk.length * lineHeight + padY * 2;
      this.rounded(MARGIN, this.y, CONTENT_WIDTH, blockHeight, 4, COLORS.sunken, COLORS.line, 0.5);
      let cursor = this.y - padY;
      for (const line of chunk) {
        if (line.tint) {
          this.page.drawRectangle({
            x: MARGIN + 1,
            y: cursor - lineHeight,
            width: CONTENT_WIDTH - 2,
            height: lineHeight,
            color: line.tint,
          });
        }
        let x = MARGIN + padX;
        for (const seg of line.segments) {
          const font = seg.bold ? this.monoBold : this.mono;
          this.page.drawText(seg.text, { x, y: cursor - size - 1.5, size, font, color: seg.color });
          x += font.widthOfTextAtSize(seg.text, size);
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
      this.ensure(14);
      const top = this.y;
      this.text(item, { x: MARGIN + 12, maxWidth: CONTENT_WIDTH - 12, size: 9 });
      this.page.drawCircle({ x: MARGIN + 4, y: top - 6, size: 1.6, color: COLORS.muted });
    }
  }

  /**
   * A table with wrapped cells and a header that repeats on every page. A cell
   * may carry a color, a font, or a bar on the test's timeline in place of text.
   */
  table(headers: string[], rows: TableCell[][], weights: number[]): void {
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / total) * CONTENT_WIDTH);
    const size = 8;
    const lineGap = size * 0.45;
    const lineHeight = size + lineGap;
    const padX = 5;
    const padY = 4;

    const drawHeader = () => {
      this.ensure(lineHeight + padY * 2 + lineHeight);
      const top = this.y;
      const height = size + padY * 2;
      this.page.drawRectangle({ x: MARGIN, y: top - height, width: CONTENT_WIDTH, height, color: COLORS.sunken });
      let x = MARGIN;
      headers.forEach((header, idx) => {
        this.page.drawText(winAnsiSafe(header.toUpperCase()), {
          x: x + padX,
          y: top - size - 1,
          size: 6.5,
          font: this.bold,
          color: COLORS.faint,
        });
        x += widths[idx] ?? 0;
      });
      this.y = top - height;
      this.page.drawLine({
        start: { x: MARGIN, y: this.y },
        end: { x: MARGIN + CONTENT_WIDTH, y: this.y },
        thickness: 0.5,
        color: COLORS.lineStrong,
      });
      this.y -= 1;
    };

    this.space(2);
    drawHeader();

    for (const row of rows) {
      const wrapped = row.map((cell, idx) =>
        cell.bar ? [] : this.wrap(cell.text, cell.font ?? this.regular, size, (widths[idx] ?? 0) - padX * 2),
      );
      const rowHeight = Math.max(1, ...wrapped.map((w) => w.length)) * lineHeight + padY * 2;
      if (this.available < rowHeight) {
        this.newPage();
        drawHeader();
      }
      const top = this.y;
      let x = MARGIN;
      row.forEach((cell, idx) => {
        const width = widths[idx] ?? 0;
        if (cell.bar) {
          const trackWidth = width - padX * 2;
          const trackY = top - padY - size / 2 - 2;
          this.page.drawRectangle({ x: x + padX, y: trackY, width: trackWidth, height: 4, color: COLORS.sunken });
          this.page.drawRectangle({
            x: x + padX + cell.bar.offset * trackWidth,
            y: trackY,
            width: Math.max(1.5, cell.bar.width * trackWidth),
            height: 4,
            color: cell.bar.color,
          });
        } else {
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
        }
        x += width;
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

  /**
   * A screenshot in a bordered frame on a sunken ground, so it reads as inset
   * evidence rather than part of the text flow. It shrinks to the room left on
   * the page rather than leaving a gap, down to a third of a page.
   */
  async image(bytes: Uint8Array, contentType: string, caption: string): Promise<boolean> {
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

    const pad = 5;
    const captionHeight = 13;
    let { width, height } = image;
    const scale = Math.min((CONTENT_WIDTH - pad * 2) / width, 340 / height, 1);
    width *= scale;
    height *= scale;
    const room = this.available - pad * 2 - captionHeight - 6;
    const minHeight = (PAGE_HEIGHT - MARGIN * 2) / 3;
    if (height > room) {
      if (room >= Math.min(height, minHeight)) {
        width *= room / height;
        height = room;
      } else {
        this.newPage();
      }
    }
    const frameHeight = height + pad * 2;
    const top = this.y;
    this.rounded(MARGIN, top, width + pad * 2, frameHeight, 4, COLORS.sunken, COLORS.lineStrong, 0.75);
    this.page.drawImage(image, { x: MARGIN + pad, y: top - pad - height, width, height });
    this.y = top - frameHeight - 3;
    this.page.drawText(this.fit(caption, this.regular, 7.5, CONTENT_WIDTH), {
      x: MARGIN,
      y: this.y - 7.5,
      size: 7.5,
      font: this.regular,
      color: COLORS.faint,
    });
    this.y -= captionHeight;
    return true;
  }

  /** Each page's footer: the document's title on the left, its page number on the right. */
  footers(title: string): void {
    const pages = this.doc.getPages();
    const size = 7;
    const widest = this.regular.widthOfTextAtSize(`${pages.length} / ${pages.length}`, size);
    const name = this.fit(`Piwi · ${title}`, this.regular, size, CONTENT_WIDTH - widest - 20);
    pages.forEach((page, i) => {
      const number = `${i + 1} / ${pages.length}`;
      const numberWidth = this.regular.widthOfTextAtSize(number, size);
      page.drawText(name, {
        x: MARGIN,
        y: FOOTER_Y,
        size,
        font: this.regular,
        color: COLORS.faint,
      });
      page.drawText(number, {
        x: MARGIN + CONTENT_WIDTH - numberWidth,
        y: FOOTER_Y,
        size,
        font: this.regular,
        color: COLORS.faint,
      });
    });
  }

  save(): Promise<Uint8Array> {
    return this.doc.save();
  }
}

function renderDiagnosis(b: PdfBuilder, diagnosis: Record<string, unknown> | null): void {
  if (!hasDiagnosis(diagnosis)) return;
  const d = diagnosis as Record<string, any>;
  const det = (d.details ?? {}) as Record<string, any>;

  b.section('AI diagnosis', { color: COLORS.accent });
  if (d.summary) b.text(String(d.summary), { font: b.bold, size: 10.5 });
  if (d.rootCause) {
    b.space(2);
    b.text(`Root cause: ${String(d.rootCause)}`);
  }
  b.space(4);
  b.tiles(diagnosisFacts(d));

  const evidence = (det.evidence ?? []) as unknown[];
  if (evidence.length) {
    b.label('Evidence');
    b.bullets(evidence.map((e) => String(e)));
  }

  const fix = (det.suggestedFix ?? null) as Record<string, any> | null;
  if (fix) {
    b.space(4);
    b.label('Suggested fix');
    if (fix.description) b.text(String(fix.description));
    if (fix.patch) b.codeBlock(String(fix.patch), 'diff');
    else if (fix.code) b.codeBlock(String(fix.code), 'typescript');
  }
}

/** A run: its context on wrapping lines, then its tests by outcome. */
function renderRunPanel(b: PdfBuilder, run: Record<string, any> | null | undefined): void {
  const context = runFacts(run ?? {});
  const outcome = runTestsByOutcome(run);
  if (!context.some(([, v]) => v) && !outcome) return;
  b.space(4);
  b.label('The run');
  b.inlineFacts(context);
  if (outcome) b.outcomeBar(outcome.segments, outcome.total);
}

interface CaseOptions {
  /** The case is the document's subject: its title is the largest. */
  standalone: boolean;
  /** The line above a case among several (`Test 2 of 5`). */
  label?: string;
  /** Leave out the run panel, which a run export shows once at its top. */
  withoutRun?: boolean;
}

async function renderCase(
  b: PdfBuilder,
  exportCase: ExportCase,
  opts: PdfRenderOptions,
  caseOpts: CaseOptions,
): Promise<void> {
  const d = exportCase.detail as Record<string, any>;
  const headline = caseHeadline(exportCase);
  const standalone = caseOpts.standalone;

  if (caseOpts.label) b.label(caseOpts.label, 120);
  b.hero({
    tone: statusTone(exportCase.status, Number(d.retries ?? 0)),
    status: exportCase.status,
    labels: caseLabels(exportCase),
    title: exportCase.title,
    titleSize: standalone ? 16 : 13,
    path: casePath(exportCase),
    location: exportCase.location ?? exportCase.filePath,
    headline: headline?.headline,
    detail: headline?.detail,
  });
  b.tiles(caseFacts(exportCase));

  if (!caseOpts.withoutRun) renderRunPanel(b, d.testRun);

  if (d.error) {
    b.section('Error', { color: COLORS.fail });
    b.codeBlock((maxChars) => errorCodeLines(String(d.error), maxChars));
  }

  const frames = Array.isArray(d.testSourceFrames) ? (d.testSourceFrames as Record<string, any>[]) : [];
  if (frames.length) {
    b.section('Call stack', {
      color: hexColor(STATUS_COLORS.flaky.fill),
      count: frames.length > 1 ? frames.length : undefined,
    });
    for (const frame of frames) {
      b.text(`${frame.file ?? ''}:${frame.line ?? ''}`, { font: b.monoBold, size: 8, color: COLORS.muted, lineGap: 3 });
      if (frame.snippet)
        b.codeBlock((maxChars) => snippetLines(String(frame.snippet), String(frame.file ?? ''), maxChars));
    }
  }

  renderDiagnosis(b, exportCase.diagnosis);

  const screenshots = exportCase.assets.filter((a) => a.kind === 'screenshot');
  let headed = false;
  for (const asset of screenshots) {
    const bytes = opts.imageFor(asset);
    if (!bytes) continue;
    if (!headed) b.section('Screenshots', { color: COLORS.info, keepWith: (PAGE_HEIGHT - MARGIN * 2) / 3 });
    headed = true;
    await b.image(bytes, asset.contentType, asset.name);
  }

  const steps = (d.steps ?? []) as Record<string, any>[];
  if (Array.isArray(steps) && steps.length) {
    b.section('Steps', { count: steps.length });
    const bars = stepBars(steps);
    b.table(
      ['Step', 'Category', 'Timeline', 'Duration'],
      steps.map((step, i) => {
        const { title, subtitle } = stepLabelParts(step);
        const color = step.failed
          ? hexColor(STATUS_COLORS.failed.fill)
          : step.recovered
            ? hexColor(STATUS_COLORS.didnotrun.fill)
            : COLORS.accent;
        return [
          { text: subtitle ? `${title} ${subtitle}` : title, color: step.failed ? COLORS.fail : undefined },
          {
            text: [String(step.category ?? ''), step.failed ? 'failed' : step.recovered ? 'recovered' : '']
              .filter(Boolean)
              .join(' · '),
            color: COLORS.muted,
          },
          { text: '', bar: { ...bars[i]!, color } },
          { text: fmtStepDuration(step, d.pauses), font: b.mono },
        ];
      }),
      [5, 1.6, 2.6, 1.5],
    );
  }

  const logs = (d.consoleLogs ?? []) as Record<string, any>[];
  if (Array.isArray(logs) && logs.length) {
    b.section('Console', { count: logs.length });
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
    b.section('Network', { count: requests.length });
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
    b.section('Test source', { aside: exportCase.filePath });
    b.codeBlock((maxChars) => snippetLines(String(d.testSource), exportCase.filePath ?? 'test.ts', maxChars));
  }

  if (d.ariaSnapshot) {
    b.section('ARIA snapshot');
    b.codeBlock(String(d.ariaSnapshot), 'yaml');
  }
}

function renderClusterHeader(b: PdfBuilder, bundle: ExportBundle): void {
  const cluster = bundle.cluster as Record<string, any> | null;
  if (!cluster) return;

  const headline = clusterHeadline(cluster);
  const state = clusterState(cluster);
  const owner = clusterOwner(cluster);
  b.hero({
    tone: statusTone(cluster.status),
    status: cluster.status ? String(cluster.status) : null,
    labels: owner ? [{ text: `Owner ${owner}`, news: false }] : [],
    title: bundle.title,
    titleSize: 16,
    headline: headline?.headline,
    detail: [headline?.detail, state].filter(Boolean).join('\n') || null,
  });
  b.tiles(clusterFacts(cluster));

  const points = clusterOccurrences(cluster);
  if (points.length > 1) {
    b.space(4);
    b.label('Recent runs');
    b.occurrenceBars(points);
    b.meta(`${clusterOccurrencesText(points)}, oldest on the left.`);
  }

  if (cluster.sampleError) {
    b.section('Representative error', { color: COLORS.fail });
    b.codeBlock((maxChars) => errorCodeLines(String(cluster.sampleError), maxChars));
  }

  renderDiagnosis(b, (cluster.diagnosis ?? null) as Record<string, unknown> | null);

  if (bundle.cases.length > 1) {
    b.section('Affected tests in this export', { count: bundle.cases.length });
    b.table(
      ['Status', 'Test', 'Location'],
      bundle.cases.map((c) => [
        { text: c.status, color: statusColor(c.status), font: b.bold },
        { text: c.title },
        { text: c.location ?? c.filePath ?? '', font: b.mono, color: COLORS.muted },
      ]),
      [1.2, 5, 3.5],
    );
  }

  if (bundle.truncatedCases.length) {
    b.section(`Other affected tests (${bundle.truncatedCases.length}, evidence not included)`);
    b.bullets(bundle.truncatedCases.map((t) => `${t.title}${t.filePath ? `  ${t.filePath}` : ''}`));
  }
}

/** The top of a run export: the run's header, figures, context and tests, then its failures, flaky and slowest tests. */
function renderRunHeader(b: PdfBuilder, bundle: ExportBundle, run: ExportRun): void {
  const d = run.detail as Record<string, any>;
  b.hero({
    tone: statusTone(d.status),
    status: d.status ? String(d.status) : null,
    labels: [d.isFullRun === false ? 'Partial run' : null, d.origin ? String(d.origin) : null]
      .filter((text): text is string => Boolean(text))
      .map((text) => ({ text, news: false })),
    title: bundle.title,
    titleSize: 16,
    path: [d.branch, d.environment].filter(Boolean).join(' · ') || null,
    headline: runHeadline(d),
  });
  b.tiles(runSummaryFacts(run));
  renderRunPanel(b, d);

  const groups = runFailureGroups(run);
  if (groups.length) {
    b.section('Failures by root cause', { color: COLORS.fail, count: groups.reduce((n, g) => n + g.tests.length, 0) });
    for (const g of groups) {
      b.space(2);
      b.text(g.title, { font: b.bold, size: 9.5, lineGap: 3 });
      const meta = [g.isNew ? 'New' : null, g.status, `${g.tests.length} ${g.tests.length === 1 ? 'test' : 'tests'}`];
      b.meta(meta.filter(Boolean).join(' · '));
      if (g.diagnosis) b.meta(g.diagnosis);
      b.table(
        ['Status', 'Test', 'Browser'],
        g.tests.map((t) => [
          { text: statusLabel(runTestStatus(t)), color: statusColor(runTestStatus(t)), font: b.bold },
          { text: [t.title, t.location, t.flaky ? null : t.error].filter(Boolean).join('\n') },
          { text: t.browser ?? '', color: COLORS.muted },
        ]),
        [1.1, 6.5, 1.6],
      );
    }
  }

  const flaky = run.tests.filter((t) => t.flaky);
  if (flaky.length) {
    b.section('Flaky tests', { color: hexColor(STATUS_COLORS.flaky.fill), count: flaky.length });
    b.table(
      ['Test', 'Browser', 'Retries', 'Duration'],
      flaky.map((t) => [
        { text: [t.title, t.location].filter(Boolean).join('\n') },
        { text: t.browser ?? '', color: COLORS.muted },
        { text: String(t.retries), font: b.mono },
        { text: runTestDuration(t), font: b.mono },
      ]),
      [6, 1.6, 1, 1.4],
    );
  }

  const slowest = slowestTests(run.tests);
  if (slowest.length) {
    const longest = slowest[0]!.duration ?? 1;
    b.section('Slowest tests', { count: slowest.length });
    b.table(
      ['Test', 'Browser', '', 'Duration'],
      slowest.map((t) => [
        { text: t.title },
        { text: t.browser ?? '', color: COLORS.muted },
        { text: '', bar: { offset: 0, width: (t.duration ?? 0) / longest, color: COLORS.accent } },
        { text: runTestDuration(t), font: b.mono },
      ]),
      [5, 1.5, 2.4, 1.4],
    );
  }

  if (run.tests.length) {
    b.section('All tests', { count: run.tests.length });
    b.table(
      ['Status', 'Test', 'Browser', 'Duration', 'Retries'],
      run.tests.map((t) => [
        { text: statusLabel(runTestStatus(t)), color: statusColor(runTestStatus(t)), font: b.bold },
        { text: [[...t.suitePath, t.title].join(' › '), t.location].filter(Boolean).join('\n') },
        { text: t.browser ?? '', color: COLORS.muted },
        { text: runTestDuration(t), font: b.mono },
        { text: String(t.retries), font: b.mono },
      ]),
      [1.1, 6, 1.5, 1.2, 0.9],
    );
  }
}

function renderOmissions(b: PdfBuilder, bundle: ExportBundle): void {
  if (!bundle.omitted.length) return;
  b.section(`Omitted from this export (${bundle.omitted.length})`);
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
  const monoBold = await doc.embedFont(StandardFonts.CourierBold);
  const b = new PdfBuilder(doc, regular, bold, mono, monoBold);

  const isCluster = bundle.kind === 'cluster';
  const isRun = bundle.kind === 'run';
  const label = projectLabel(bundle);
  const standalone = bundle.kind === 'execution' && bundle.cases.length === 1;
  const exported = fmtDate(bundle.generatedAt) ?? bundle.generatedAt;
  const kindLabel = isRun ? 'Test run' : isCluster ? 'Failure cluster' : 'Test execution';
  b.docHeader(
    `${kindLabel}${label ? ` · ${label}` : ''}`,
    `Exported ${exported}${bundle.piwiVersion ? ` · Piwi ${bundle.piwiVersion}` : ''}`,
    bundle.sourceUrl,
  );

  if (isCluster) renderClusterHeader(b, bundle);
  else if (isRun && bundle.run) renderRunHeader(b, bundle, bundle.run);
  else if (!standalone) b.text(bundle.title, { font: bold, size: 18, lineGap: 5 });

  if (isRun && bundle.cases.length) {
    b.newPage();
    b.text('Failures in detail', { font: bold, size: 15, lineGap: 6 });
  }
  const caseWord = isRun ? 'Failure' : 'Test';
  for (let i = 0; i < bundle.cases.length; i++) {
    const exportCase = bundle.cases[i];
    if (!exportCase) continue;
    if (bundle.cases.length > 1 || isCluster) b.space(14);
    await renderCase(b, exportCase, opts, {
      standalone,
      label: bundle.cases.length > 1 ? `${caseWord} ${i + 1} of ${bundle.cases.length}` : undefined,
      withoutRun: isRun,
    });
  }
  if (isRun && bundle.truncatedCases.length) {
    b.section(`Other failing tests (${bundle.truncatedCases.length}, evidence not included)`);
    b.bullets(bundle.truncatedCases.map((t) => `${t.title}${t.filePath ? `  ${t.filePath}` : ''}`));
  }
  if (bundle.cases.length === 0 && !isRun) {
    b.text('No executions were included in this export.', { color: COLORS.muted });
  }

  renderOmissions(b, bundle);
  b.space(10);
  b.meta('Self-contained, no network connection required.');
  b.credit('Generated by Piwi');
  b.footers(bundle.title);

  return b.save();
}
