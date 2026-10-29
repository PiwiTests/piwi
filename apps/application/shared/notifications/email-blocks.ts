/**
 * The pieces a notification email is built from: the banner, the outcome bar,
 * the run history, a failing test's card with its highlighted code. Each
 * returns HTML made of tables and inline styles, the subset mail clients
 * render; the layout's `<style>` only narrows the padding on a phone. A text
 * argument is escaped here; an argument named `html` is HTML its caller built
 * from escaped values.
 */
import { STATUS_COLORS } from '#shared/status-colors';
import { BRAND_VIOLET } from '#shared/brand';
import { EMAIL_PAD_CLASS, EMAIL_TIGHT_CLASS, emailButton, escapeHtml } from '#shared/email-layout';
import { highlightLines, languageForPath, SCOPE_ROLES, type TokenRole } from '#shared/highlight';
import { safeHttpUrl } from '#shared/utils/safe-url';
import type { FailureSource, HistoryOutcome, RunHistoryEntry, TopFailure } from '#shared/notification-events';
import {
  codeRows,
  errorLines,
  failureHeadline,
  historyLabel,
  historySentence,
  percent,
  runStatusKey,
  failureMeta,
  testLocation,
  testPath,
  type ErrorLineKind,
  type EventHeadline,
  type OutcomeSegment,
  type Tone,
} from './message-parts';

/** The card width of a notification email. */
export const NOTIFICATION_EMAIL_WIDTH = 680;

/** The neutral colors and the code font every notification email paints with. */
export const EMAIL_COLORS = {
  ink: '#18181b',
  body: '#3f3f46',
  muted: '#71717a',
  line: '#e4e4e7',
  sunken: '#f4f4f5',
} as const;
export const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

const INK = EMAIL_COLORS.ink;
const BODY = EMAIL_COLORS.body;
const MUTED = EMAIL_COLORS.muted;
const LINE = EMAIL_COLORS.line;
const SUNKEN = EMAIL_COLORS.sunken;

interface ToneColors {
  /** The banner's background, and text on a light background. */
  strong: string;
  /** Marks: a bar, a dot, the banner's far end. */
  fill: string;
  /** A light background. */
  tint: string;
}

const TONES: Record<Tone, ToneColors> = {
  failed: { strong: STATUS_COLORS.failed.text, fill: STATUS_COLORS.failed.fill, tint: '#fff1f2' },
  passed: { strong: STATUS_COLORS.passed.text, fill: STATUS_COLORS.passed.fill, tint: '#ecfdf5' },
  warning: { strong: STATUS_COLORS.didnotrun.text, fill: STATUS_COLORS.didnotrun.fill, tint: '#fffbeb' },
  flaky: { strong: STATUS_COLORS.flaky.text, fill: STATUS_COLORS.flaky.fill, tint: '#fdf4ff' },
  brand: { strong: '#6d28d9', fill: BRAND_VIOLET, tint: '#f5f3ff' },
};

/** The color a tone marks with: a card's edge, a bar. */
export function toneFill(tone: Tone): string {
  return TONES[tone].fill;
}

/** A framed row: `html` in a bordered card whose left edge carries the tone. */
export function cardRow(html: string, tone: Tone, padding = '12px 14px'): string {
  return `<tr><td class="${EMAIL_TIGHT_CLASS}" style="padding:${padding};border:1px solid ${LINE};border-left:4px solid ${TONES[tone].fill};border-radius:8px;">${html}</td></tr><tr><td height="10" style="height:10px;font-size:1px;line-height:10px;">&nbsp;</td></tr>`;
}

/** Framed rows, one under the other. */
export function cards(rows: string): string {
  return table(rows, 'margin:0 0 12px;');
}

/** A table with no spacing of its own, the base of every block. */
function table(rows: string, style = ''): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;${style}">${rows}</table>`;
}

function spacer(height: number): string {
  return `<div style="height:${height}px;line-height:${height}px;font-size:1px;">&nbsp;</div>`;
}

// ── Text ──────────────────────────────────────────────────────────────────────

/** A path, a branch or a commit in running text. */
export function mono(text: string): string {
  return `<span style="font-family:${MONO};font-size:12px;color:${INK};background:${SUNKEN};border-radius:4px;padding:1px 5px;">${escapeHtml(text)}</span>`;
}

/** A link inside a sentence, in the sentence's color; the bare text for an address that is not http(s). */
export function textLink(url: string, html: string): string {
  const href = safeHttpUrl(url);
  if (!href) return html;
  return `<a href="${escapeHtml(href)}" style="color:inherit;text-decoration:underline;text-decoration-style:dotted;">${html}</a>`;
}

export function paragraph(html: string, style = ''): string {
  return `<p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:${BODY};${style}">${html}</p>`;
}

/** A section's heading, with an optional count or note beside it. */
export function sectionTitle(text: string, aside?: string): string {
  const note = aside ? ` <span style="font-weight:400;color:${MUTED};">${escapeHtml(aside)}</span>` : '';
  return `<h3 style="margin:0 0 12px;font-size:15px;line-height:1.4;font-weight:700;color:${INK};">${escapeHtml(text)}${note}</h3>`;
}

/** A small badge in a tone: an exception worth the eye (a new failure). */
export function badge(text: string, tone: Tone): string {
  const t = TONES[tone];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${t.tint};color:${t.strong};font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;line-height:16px;">${escapeHtml(text)}</span>`;
}

/** Facts as label and value rows. Values are HTML; rows without a value are left out. */
export function factsTable(rows: Array<[label: string, valueHtml: string | null | undefined]>): string {
  const kept = rows.filter((row): row is [string, string] => Boolean(row[1]));
  if (kept.length === 0) return '';
  return table(
    kept
      .map(
        ([label, value]) =>
          `<tr><td valign="top" width="96" style="width:96px;padding:5px 12px 5px 0;font-size:13px;line-height:20px;color:${MUTED};white-space:nowrap;">${escapeHtml(label)}</td><td valign="top" style="padding:5px 0;font-size:13px;line-height:20px;color:${INK};">${value}</td></tr>`,
      )
      .join(''),
    'margin:0 0 20px;',
  );
}

/** The call to action, and a second, quieter one beside it. */
export function actions(
  primary: { url: string; label: string },
  secondary?: { url: string; label: string } | null,
): string {
  const second = secondary
    ? `<a href="${escapeHtml(secondary.url)}" style="display:inline-block;margin-left:8px;padding:10px 20px;border:1px solid #d4d4d8;border-radius:6px;color:${INK};text-decoration:none;font-weight:600;font-size:14px;">${escapeHtml(secondary.label)}</a>`
    : '';
  return `<div style="margin:8px 0 4px;">${emailButton(escapeHtml(primary.url), escapeHtml(primary.label))}${second}</div>`;
}

// ── Banner ────────────────────────────────────────────────────────────────────

/** The headline of a notification, white on its tone, edge to edge atop the card, its figure set large. */
export function banner(h: EventHeadline): string {
  const t = TONES[h.tone];
  const headline = `${escapeHtml(h.lead)}${h.figure ? bigNumber(h.figure) : ''}${escapeHtml(h.rest)}`;
  const details = h.details.length
    ? `<div style="margin-top:8px;font-size:14px;line-height:1.5;color:#ffffff;">${escapeHtml(h.details.join(' · '))}</div>`
    : '';
  return table(
    `<tr><td class="${EMAIL_PAD_CLASS}" bgcolor="${t.strong}" style="padding:24px 32px 22px;background:${t.strong};background-image:linear-gradient(115deg,${t.strong} 0%,${t.strong} 50%,${t.fill} 100%);color:#ffffff;">` +
      `<div style="font-size:12px;line-height:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#ffffff;opacity:.85;">${escapeHtml(h.label)}</div>` +
      `<div style="margin-top:6px;font-size:28px;line-height:1.2;font-weight:800;color:#ffffff;">${headline}</div>` +
      details +
      `</td></tr>`,
  );
}

/** A number set larger than the rest of a banner's headline. */
export function bigNumber(value: string | number): string {
  return `<span style="font-size:40px;line-height:1;letter-spacing:-.02em;">${escapeHtml(String(value))}</span>`;
}

// ── Outcome bar ───────────────────────────────────────────────────────────────

/** The narrowest share a segment is drawn at, so a single skipped test still shows. */
const MIN_SEGMENT_PCT = 1.5;

/** The segments as one horizontal bar, each as wide as its share, with a legend under it. */
export function outcomeBar(segments: OutcomeSegment[], total: number): string {
  if (total <= 0 || segments.length === 0) return '';
  const shares = segments.map((s) => Math.max(MIN_SEGMENT_PCT, (s.count / total) * 100));
  const scale = 100 / shares.reduce((sum, share) => sum + share, 0);
  const cells = segments
    .map((s, i) => {
      const fill = STATUS_COLORS[s.key].fill;
      const radius =
        segments.length === 1 ? '6px' : i === 0 ? '6px 0 0 6px' : i === segments.length - 1 ? '0 6px 6px 0' : '0';
      const gap = i === 0 ? '' : 'border-left:2px solid #ffffff;';
      return `<td width="${(shares[i]! * scale).toFixed(1)}%" height="12" bgcolor="${fill}" style="height:12px;line-height:12px;font-size:1px;background:${fill};border-radius:${radius};${gap}" title="${escapeHtml(`${s.count} ${s.label}`)}">&nbsp;</td>`;
    })
    .join('');
  const legend = segments
    .map(
      (s) =>
        `<span style="display:inline-block;margin:0 16px 4px 0;white-space:nowrap;"><span style="color:${STATUS_COLORS[s.key].fill};font-size:15px;">&#9679;</span>&nbsp;<strong style="color:${INK};">${s.count}</strong> ${escapeHtml(s.label)} <span style="color:${MUTED};">${percent(s.count, total)}</span></span>`,
    )
    .join('');
  return (
    table(`<tr>${cells}</tr>`, 'table-layout:fixed;') +
    `<div style="margin:10px 0 20px;font-size:13px;line-height:20px;color:${BODY};">${legend}</div>`
  );
}

// ── History ───────────────────────────────────────────────────────────────────

/** The width of a strip of `count` squares. */
function stripWidth(count: number, size: number, gap: number): number {
  return count * size + (count - 1) * gap;
}

/** Squares in a row, one per run, the current one underlined, in a table exactly as wide as they are. */
function squares(
  cells: Array<{ color: string | null; title: string; url: string | null }>,
  size: number,
  gap: number,
): string {
  const gapCell = `<td width="${gap}" style="width:${gap}px;font-size:1px;line-height:1px;">&nbsp;</td>`;
  const top = cells
    .map((cell, i) => {
      const color = cell.color ?? '#ffffff';
      const border = cell.color ? '' : `border:1px dashed #d4d4d8;`;
      const inner = cell.url
        ? `<a href="${escapeHtml(cell.url)}" title="${escapeHtml(cell.title)}" style="display:block;height:${size}px;line-height:${size}px;font-size:1px;text-decoration:none;">&nbsp;</a>`
        : '&nbsp;';
      return `<td width="${size}" height="${size}" bgcolor="${color}" title="${escapeHtml(cell.title)}" style="width:${size}px;height:${size}px;line-height:${size}px;font-size:1px;background:${color};border-radius:3px;box-sizing:border-box;${border}">${inner}</td>${i === cells.length - 1 ? '' : gapCell}`;
    })
    .join('');
  const under = cells
    .map((_, i) => {
      const mark = i === cells.length - 1 ? `background:${INK};` : '';
      return `<td height="3" style="height:3px;line-height:3px;font-size:1px;border-radius:2px;${mark}">&nbsp;</td>${i === cells.length - 1 ? '' : gapCell}`;
    })
    .join('');
  const width = stripWidth(cells.length, size, gap);
  return `<table role="presentation" width="${width}" cellpadding="0" cellspacing="0" border="0" style="width:${width}px;border-collapse:separate;table-layout:fixed;"><tr>${top}</tr><tr><td colspan="${cells.length * 2 - 1}" height="3" style="height:3px;line-height:3px;font-size:1px;">&nbsp;</td></tr><tr>${under}</tr></table>`;
}

/** The run history as a strip of squares linking to each run, with its sentence beside it. */
export function historyStrip(
  history: RunHistoryEntry[],
  runUrl: (runId: number) => string,
  scope: { branch?: string; environment?: string },
): string {
  if (history.length < 2) return '';
  const strip = squares(
    history.map((entry) => ({
      color: STATUS_COLORS[runStatusKey(entry.status)].fill,
      title: `Run #${entry.runId}: ${entry.status}${entry.failedTests > 0 ? `, ${entry.failedTests} failed` : ''}`,
      url: runUrl(entry.runId),
    })),
    18,
    4,
  );
  const sentence = historySentence(history);
  return (
    `<div style="margin:0 0 8px;font-size:13px;line-height:20px;color:${MUTED};">${escapeHtml(historyLabel(history, scope))}, oldest first</div>` +
    table(
      `<tr><td valign="middle" width="${stripWidth(history.length, 18, 4)}" style="width:${stripWidth(history.length, 18, 4)}px;padding-right:16px;">${strip}</td><td valign="middle" style="font-size:14px;line-height:20px;color:${INK};font-weight:600;">${sentence ? escapeHtml(sentence) : ''}</td></tr>`,
      'margin:0 0 24px;',
    )
  );
}

const OUTCOME_COLORS: Record<Exclude<HistoryOutcome, null>, string> = {
  passed: STATUS_COLORS.passed.fill,
  flaky: STATUS_COLORS.flaky.fill,
  failed: STATUS_COLORS.failed.fill,
  skipped: STATUS_COLORS.skipped.fill,
  didnotrun: STATUS_COLORS.didnotrun.fill,
};

// ── Code ──────────────────────────────────────────────────────────────────────

/** The dark palette of the code block, as the HTML report's dark theme paints each token role. */
const CODE = {
  background: '#18181b',
  header: '#27272a',
  text: '#e4e4e7',
  gutter: '#71717a',
  failingBackground: '#4c0519',
  failingText: '#fda4af',
} as const;

const DARK_ROLE_COLORS: Record<TokenRole, string> = {
  comment: '#7e7e8c',
  keyword: '#c4b5fd',
  string: '#5eead4',
  number: '#fcd34d',
  function: '#93c5fd',
  attribute: '#f0abfc',
  builtin: '#7dd3fc',
  addition: STATUS_COLORS.passed.textDark,
  deletion: STATUS_COLORS.failed.textDark,
};

/** highlight.js markup with its classes turned into inline colors, which mail clients keep. */
function inlineTokenColors(html: string): string {
  return html.replace(/<span class="([^"]*)">/g, (_whole, classes: string) => {
    const scope = (classes.split(/\s+/)[0] ?? '').replace(/^hljs-/, '');
    const role = SCOPE_ROLES[scope];
    if (!role) return '<span>';
    const italic = role === 'comment' ? 'font-style:italic;' : '';
    return `<span style="color:${DARK_ROLE_COLORS[role]};${italic}">`;
  });
}

/** The lines a failure threw at, syntax-highlighted on a dark background, the failing line marked. */
export function codeBlock(source: FailureSource): string {
  const rows = codeRows(source);
  const highlighted = highlightLines(
    rows.map((row) => row.code),
    languageForPath(source.file),
  );
  const body = rows
    .map((row, i) => {
      const code = inlineTokenColors(highlighted[i] ?? escapeHtml(row.code));
      const failing = row.failing;
      const background = failing ? ` bgcolor="${CODE.failingBackground}"` : '';
      const fill = failing ? `background:${CODE.failingBackground};` : '';
      const gutterColor = failing ? CODE.failingText : CODE.gutter;
      const gutter = `${failing ? '&#8250;&nbsp;' : ''}${row.line}`;
      return `<tr><td${background} valign="top" align="right" style="${fill}padding:0 10px 0 14px;color:${gutterColor};white-space:nowrap;width:1%;${failing ? 'font-weight:700;' : ''}">${gutter}</td><td${background} valign="top" style="${fill}padding:0 14px 0 0;color:${CODE.text};white-space:pre-wrap;word-break:break-word;">${code || '&nbsp;'}</td></tr>`;
    })
    .join('');
  const edge = `<tr><td colspan="2" height="8" style="height:8px;line-height:8px;font-size:1px;">&nbsp;</td></tr>`;
  return table(
    `<tr><td colspan="2" bgcolor="${CODE.header}" style="padding:7px 14px;background:${CODE.header};color:#a1a1aa;font-size:11px;line-height:16px;border-radius:8px 8px 0 0;">${escapeHtml(`${source.file}:${source.line}`)}</td></tr>${edge}${body}${edge}`,
    `background:${CODE.background};border-radius:8px;font-family:${MONO};font-size:12px;line-height:19px;margin:0 0 12px;`,
  ).replace('<table ', `<table bgcolor="${CODE.background}" `);
}

/** The source in the plain-text part: the rows as captured. */
export function codeText(source: FailureSource): string {
  return `${source.file}:${source.line}\n${source.snippet}`;
}

// ── Errors ────────────────────────────────────────────────────────────────────

const ERROR_LINE_STYLES: Record<ErrorLineKind, string> = {
  head: `color:${INK};font-weight:700;`,
  expected: `color:${STATUS_COLORS.passed.text};`,
  received: `color:${STATUS_COLORS.failed.text};`,
  body: `color:${BODY};`,
};

/** A Playwright error's message head as Playwright prints it, the expected and received lines in color. */
export function errorBlock(excerpt: string, tone: Tone = 'failed'): string {
  const html = errorLines(excerpt)
    .map((line) =>
      line.text.trim()
        ? `<div style="${ERROR_LINE_STYLES[line.kind]}white-space:pre-wrap;word-break:break-word;">${escapeHtml(line.text)}</div>`
        : spacer(8),
    )
    .join('');
  return table(
    `<tr><td style="padding:10px 14px;background:${TONES[tone].tint};border-left:3px solid ${TONES[tone].fill};border-radius:0 6px 6px 0;font-family:${MONO};font-size:12px;line-height:19px;">${html}</td></tr>`,
    'margin:0 0 12px;',
  );
}

// ── A failing test ────────────────────────────────────────────────────────────

/**
 * One failing test as a card: its full name and location, what the failure
 * says, the code it threw at, the error, and its own recent history.
 */
export function failureCard(
  failure: TopFailure,
  opts: { url: string; history?: RunHistoryEntry[]; runUrl: (runId: number) => string },
): string {
  const { isNew, story, labels } = failureMeta(failure);
  const meta = [...(isNew ? [badge('New failure', 'failed')] : []), ...labels.map(escapeHtml)].join(
    `<span style="color:#d4d4d8;">&nbsp;&nbsp;·&nbsp;&nbsp;</span>`,
  );
  const suites = failure.suitePath?.length
    ? `<div style="font-size:13px;line-height:18px;color:${MUTED};">${failure.suitePath.map(escapeHtml).join(' › ')} ›</div>`
    : '';
  const location = testLocation(failure);
  const head =
    (meta ? `<div style="margin:0 0 8px;font-size:12px;line-height:20px;color:${MUTED};">${meta}</div>` : '') +
    suites +
    `<a href="${escapeHtml(opts.url)}" style="font-size:16px;line-height:22px;font-weight:700;color:${INK};text-decoration:none;">${escapeHtml(failure.title)}</a>` +
    (location
      ? `<div style="margin-top:2px;font-family:${MONO};font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(location)}</div>`
      : '');
  const shown = failureHeadline(failure);
  const headline = shown
    ? `<div style="margin:14px 0 12px;font-size:14px;line-height:21px;color:${INK};">${escapeHtml(shown)}</div>`
    : spacer(14);
  const source = failure.source ? codeBlock(failure.source) : '';
  const error = failure.errorExcerpt ? errorBlock(failure.errorExcerpt) : '';
  const own =
    failure.history && opts.history && failure.history.length === opts.history.length && opts.history.length > 1
      ? table(
          `<tr><td valign="middle" width="${stripWidth(failure.history.length, 10, 3)}" style="width:${stripWidth(failure.history.length, 10, 3)}px;padding-right:12px;">${squares(
            failure.history.map((outcome, i) => ({
              color: outcome ? OUTCOME_COLORS[outcome] : null,
              title: `Run #${opts.history![i]!.runId}: ${outcome ?? 'not run'}`,
              url: outcome ? opts.runUrl(opts.history![i]!.runId) : null,
            })),
            10,
            3,
          )}</td><td valign="middle" style="font-size:13px;line-height:18px;color:${BODY};">${story ? escapeHtml(story) : ''}</td></tr>`,
          'margin:4px 0 2px;',
        )
      : '';
  const open = `<div style="margin-top:10px;font-size:13px;line-height:20px;"><a href="${escapeHtml(opts.url)}" style="color:${TONES.brand.strong};font-weight:600;text-decoration:none;">Open the failure &rarr;</a></div>`;
  return cards(cardRow(`${head}${headline}${source}${error}${own}${open}`, 'failed', '16px 18px'));
}

/** One failing test in the plain-text part. */
export function failureText(failure: TopFailure, url: string): string {
  const location = testLocation(failure);
  const { isNew, story, labels } = failureMeta(failure);
  const lines = [`✗ ${testPath(failure)}`];
  const facts = [...(isNew ? ['New failure'] : []), ...labels];
  if (location || facts.length) lines.push(`  ${[location, ...facts].filter(Boolean).join(' · ')}`);
  if (failure.headline) lines.push(`  ${failure.headline}`);
  if (story) lines.push(`  ${story}`);
  if (failure.source) lines.push(`\n${codeText(failure.source).replace(/^/gm, '    ')}\n`);
  if (failure.errorExcerpt) lines.push(failure.errorExcerpt.replace(/^/gm, '    '));
  lines.push(`  ${url}`);
  return lines.join('\n');
}
