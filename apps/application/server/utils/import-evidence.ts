/**
 * Failure evidence recovered from an imported archive.
 *
 * A live run gets its ARIA snapshot, source snippet and console entries from
 * Piwi's own capture fixtures, which no historical archive can contain. Two
 * substitutes are available and produce the same stored shapes:
 *
 *  - Playwright's `error-context` attachment, written alongside a failure,
 *    carries the failure-time page snapshot and the spec source. Older archives
 *    have no such attachment, and simply yield no evidence.
 *  - The trace's event stream carries the browser console.
 *
 * Everything else Piwi renders from a trace — call stack, network, DOM
 * snapshots, the trace viewer — reads the stored trace at view time, so it
 * needs nothing at ingest.
 */

import type { ParsedTraceData } from './trace-events';

/** A fenced block in the error-context markdown, with its info string. */
interface FencedBlock {
  lang: string;
  body: string;
  /** Index of the nearest `# Heading` above the block, lower-cased. */
  heading: string;
}

/** Split markdown into fenced code blocks tagged with the heading above them. */
function fencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  const lines = markdown.split('\n');
  let heading = '';
  let open: { lang: string; body: string[] } | null = null;

  for (const line of lines) {
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      if (open) {
        blocks.push({ lang: open.lang, body: open.body.join('\n'), heading });
        open = null;
      } else {
        open = { lang: fence[1] ?? '', body: [] };
      }
      continue;
    }
    if (open) open.body.push(line);
    else if (line.startsWith('# ')) heading = line.slice(2).trim().toLowerCase();
  }

  return blocks;
}

/**
 * Re-render numbered source lines in the reporter's snippet format so an
 * imported snippet is byte-identical to a reported one: a `> ` marker on the
 * failing line, `* ` on the test declaration, and the line number padded to
 * four columns.
 */
function renderSnippet(
  numbered: Array<{ line: number; text: string }>,
  declLine: number | null,
  failingLine: number | null,
  context: number,
): string | null {
  if (numbered.length === 0) return null;

  const anchor = failingLine ?? declLine;
  const windowed =
    anchor == null ? numbered : numbered.filter((l) => l.line > anchor - context - 1 && l.line <= anchor + context);
  if (windowed.length === 0) return null;

  return windowed
    .map(({ line, text }) => {
      const isFailing = failingLine != null && line === failingLine;
      const isDecl = line === declLine && !isFailing;
      let marker = '  ';
      if (isFailing) marker = '> ';
      else if (isDecl) marker = failingLine != null ? '* ' : '> ';
      return `${marker}${String(line).padStart(4)} | ${text}`;
    })
    .join('\n');
}

export interface ErrorContextEvidence {
  /** The failure-time page snapshot, in Playwright's ARIA YAML form. */
  ariaSnapshot: string | null;
  /** Source window around the failure, in the reporter's snippet format. */
  testSource: string | null;
}

/**
 * Pull the page snapshot and source snippet out of an `error-context`
 * attachment. Both sections are optional — a snapshot is only written when the
 * failure had a live page, and the source only when Playwright could read the
 * spec file.
 */
export function parseErrorContext(
  markdown: string,
  options: { declLine?: number | null; failingLine?: number | null; context?: number } = {},
): ErrorContextEvidence {
  const blocks = fencedBlocks(markdown);

  const snapshot = blocks.find((b) => b.lang === 'yaml');

  const sourceBlock = blocks.find((b) => b.heading.includes('test source'));
  const numbered: Array<{ line: number; text: string }> = [];
  for (const raw of sourceBlock?.body.split('\n') ?? []) {
    // Playwright writes `  12 | code`, with a `>` marker on the failing line.
    const match = raw.match(/^\s*>?\s*(\d+)\s*\|(.*)$/);
    if (match) numbered.push({ line: Number(match[1]), text: match[2]!.replace(/^ /, '') });
  }

  return {
    ariaSnapshot: snapshot?.body.trim() || null,
    testSource: renderSnippet(numbered, options.declLine ?? null, options.failingLine ?? null, options.context ?? 30),
  };
}

/** One stored console entry, matching what the capture fixtures record. */
export interface ImportedConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
  location: string | null;
}

/** Console levels the capture fixtures keep — noise like `log` is dropped. */
const KEPT_CONSOLE_TYPES = new Set(['warning', 'error', 'assert']);

/**
 * Project a parsed trace's console events into the stored shape.
 *
 * A console event's time too small to be an epoch is the worker's monotonic
 * clock: it goes onto the wall clock through the anchor a `context-options`
 * header records (its `wallTime` at its `monotonicTime`, the browser context's
 * first), else, in a trace that records none, it is taken as an offset from the
 * execution's start. Either way the entries sort against the rest of the
 * timeline.
 */
export function consoleLogsFromTrace(
  parsed: ParsedTraceData | null,
  startedAt: number | null,
): ImportedConsoleEntry[] | null {
  if (!parsed?.consoleEntries?.length) return null;

  const anchored = (context: ParsedTraceData['contexts'][number]) =>
    typeof context.wallTime === 'number' && typeof context.monotonicTime === 'number';
  const anchor =
    parsed.contexts.find((context) => context.origin === 'library' && anchored(context)) ??
    parsed.contexts.find(anchored);
  const wallClock = (monotonic: number): number | null => {
    if (anchor) return anchor.wallTime! + (monotonic - anchor.monotonicTime!);
    return startedAt ? startedAt + monotonic : null;
  };

  const entries: ImportedConsoleEntry[] = [];
  for (const entry of parsed.consoleEntries) {
    if (!KEPT_CONSOLE_TYPES.has(entry.type)) continue;

    const raw = entry.timestamp ?? 0;
    const timestamp = Math.round((raw > 0 && raw < 1e12 ? wallClock(raw) : null) ?? raw);

    entries.push({
      type: entry.type,
      text: entry.text,
      timestamp,
      location: normalizeConsoleLocation(entry.location),
    });
  }

  return entries.length ? entries : null;
}

/** Traces carry the console location as an object; storage wants `url:line:col`. */
function normalizeConsoleLocation(location: unknown): string | null {
  if (typeof location === 'string') return location || null;
  if (!location || typeof location !== 'object') return null;
  const loc = location as Record<string, unknown>;
  // An inline script reports an empty URL — there is nothing to link to.
  if (typeof loc.url !== 'string' || !loc.url) return null;
  return `${loc.url}:${loc.lineNumber ?? 0}:${loc.columnNumber ?? 0}`;
}
