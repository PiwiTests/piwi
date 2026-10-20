/**
 * Source maps, read just far enough to answer two questions: which original
 * file, and which of its lines, does a position in a generated script come
 * from? Code reach uses them to turn the functions Chromium's JavaScript
 * coverage reports as executed into the application source files they were
 * compiled from, and the lines those functions span.
 *
 * Supports version 3 maps (`mappings` with Base64 VLQ segments) and index maps
 * (`sections`). Names and original columns are decoded but not kept.
 */

/** A source map as JSON. */
export interface RawSourceMap {
  version?: number;
  sources?: Array<string | null>;
  sourceRoot?: string;
  mappings?: string;
  sections?: Array<{ offset: { line: number; column: number }; map: RawSourceMap }>;
}

/** Answers which original source a generated position maps to. */
export interface SourceMapLookup {
  /** The map's sources, with `sourceRoot` applied. */
  sources: string[];
  /** The index in `sources` of the source a 0-based generated line and column map to; null when unmapped. */
  sourceAt(line: number, column: number): number | null;
  /** The source and original 0-based line a generated line and column map to; null when unmapped. */
  originalAt(line: number, column: number): { source: number; line: number } | null;
  /**
   * The original 0-based line of the first segment, in generated order, at or after a generated position and before
   * an end position that maps to a source index; null when none does.
   */
  firstOriginalLineBetween(source: number, start: GeneratedPosition, end: GeneratedPosition): number | null;
  /**
   * The first and last original 0-based lines, from `fromLine` on, of the segments at or after a generated position
   * and before an end position that map to a source index; null when none does.
   */
  originalLinesBetween(
    source: number,
    start: GeneratedPosition,
    end: GeneratedPosition,
    fromLine?: number,
  ): [number, number] | null;
}

/** A 0-based position in generated code. */
interface GeneratedPosition {
  line: number;
  column: number;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) BASE64_VALUE[BASE64.charCodeAt(i)] = i;

/** One line's segments: generated columns ascending, each with its source index (-1: unmapped) and original line. */
interface LineSegments {
  columns: number[];
  sources: number[];
  originalLines: number[];
}

/**
 * Every line's segments end to end, as the lookup keeps them: line `n`'s are at
 * indexes `lineStarts[n]` to `lineStarts[n + 1]` (excluded). Four typed arrays
 * per map, whatever its line count: a caller may hold the maps of thousands of
 * scripts, and arrays per line would cost more in headers than in segments.
 */
interface CompactSegments {
  lineStarts: Int32Array;
  columns: Int32Array;
  sources: Int32Array;
  originalLines: Int32Array;
}

/** Decode a `mappings` string into per-line segments, source indexes offset by `sourceBase`. */
function decodeMappings(mappings: string, sourceBase: number): LineSegments[] {
  const lines: LineSegments[] = [];
  let current: LineSegments = { columns: [], sources: [], originalLines: [] };
  let column = 0;
  let source = 0;
  let originalLine = 0;
  const fields: number[] = [];
  let value = 0;
  let shift = 0;
  const flush = () => {
    if (fields.length === 0) return;
    column += fields[0]!;
    if (fields.length >= 4) {
      source += fields[1]!;
      originalLine += fields[2]!;
      current.columns.push(column);
      current.sources.push(sourceBase + source);
      current.originalLines.push(originalLine);
    } else {
      current.columns.push(column);
      current.sources.push(-1);
      current.originalLines.push(-1);
    }
    fields.length = 0;
  };
  for (let i = 0; i <= mappings.length; i++) {
    const ch = i < mappings.length ? mappings.charCodeAt(i) : 59; // ';' ends the last line
    if (ch === 59 || ch === 44) {
      flush();
      if (ch === 59) {
        lines.push(current);
        current = { columns: [], sources: [], originalLines: [] };
        column = 0;
      }
      continue;
    }
    const digit = ch < 128 ? BASE64_VALUE[ch]! : -1;
    if (digit < 0) continue;
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  // Segments are sorted by generated column within a line per the spec; sort defensively.
  for (const line of lines) {
    if (line.columns.every((c, i) => i === 0 || c >= line.columns[i - 1]!)) continue;
    const order = line.columns.map((_, i) => i).sort((a, b) => line.columns[a]! - line.columns[b]!);
    line.columns = order.map((i) => line.columns[i]!);
    line.sources = order.map((i) => line.sources[i]!);
    line.originalLines = order.map((i) => line.originalLines[i]!);
  }
  return lines;
}

function joinRoot(root: string | undefined, source: string): string {
  if (!root || /^[a-z][\w+.-]*:/i.test(source) || source.startsWith('/')) return source;
  return root.endsWith('/') ? root + source : `${root}/${source}`;
}

/** A map's sources and per-line segments, its sections merged; null when a section is not a map. */
function decodeLines(raw: RawSourceMap): { sources: string[]; lines: Array<LineSegments | undefined> } | null {
  const sources: string[] = [];
  const decoded: Array<LineSegments | undefined> = [];

  const add = (map: RawSourceMap, lineOffset: number, columnOffset: number): boolean => {
    if (map.sections) {
      for (const section of map.sections) {
        if (!add(section.map, section.offset.line, section.offset.column)) return false;
      }
      return true;
    }
    if (typeof map.mappings !== 'string' || !Array.isArray(map.sources)) return false;
    const base = sources.length;
    for (const s of map.sources) sources.push(joinRoot(map.sourceRoot, s ?? ''));
    decodeMappings(map.mappings, base).forEach((segments, i) => {
      const at = lineOffset + i;
      const shifted = i === 0 && columnOffset ? segments.columns.map((c) => c + columnOffset) : segments.columns;
      const existing = decoded[at];
      if (!existing)
        decoded[at] = { columns: shifted, sources: segments.sources, originalLines: segments.originalLines };
      else {
        existing.columns.push(...shifted);
        existing.sources.push(...segments.sources);
        existing.originalLines.push(...segments.originalLines);
      }
    });
    return true;
  };
  return add(raw, 0, 0) ? { sources, lines: decoded } : null;
}

function compactSegments(lines: ReadonlyArray<LineSegments | undefined>): CompactSegments {
  let total = 0;
  for (const line of lines) total += line?.columns.length ?? 0;
  const segments: CompactSegments = {
    lineStarts: new Int32Array(lines.length + 1),
    columns: new Int32Array(total),
    sources: new Int32Array(total),
    originalLines: new Int32Array(total),
  };
  let at = 0;
  for (let n = 0; n < lines.length; n++) {
    segments.lineStarts[n] = at;
    const line = lines[n];
    if (!line) continue;
    segments.columns.set(line.columns, at);
    segments.sources.set(line.sources, at);
    segments.originalLines.set(line.originalLines, at);
    at += line.columns.length;
  }
  segments.lineStarts[lines.length] = at;
  return segments;
}

/** Parse a source map. Null when it is not a version 3 map. */
export function decodeSourceMap(raw: RawSourceMap): SourceMapLookup | null {
  if (raw.version !== undefined && raw.version !== 3) return null;
  // Decoded apart, so the lookup's closures hold the compact segments only.
  const decoded = decodeLines(raw);
  if (!decoded) return null;
  const { sources } = decoded;
  const segments = compactSegments(decoded.lines);
  const lineCount = segments.lineStarts.length - 1;

  const originalAt = (line: number, column: number): { source: number; line: number } | null => {
    if (line < 0 || line >= lineCount) return null;
    // The last segment starting at or before the column.
    let lo = segments.lineStarts[line]!;
    let hi = segments.lineStarts[line + 1]! - 1;
    if (lo > hi || segments.columns[lo]! > column) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments.columns[mid]! <= column) lo = mid;
      else hi = mid - 1;
    }
    const source = segments.sources[lo]!;
    return source < 0 ? null : { source, line: segments.originalLines[lo]! };
  };

  return {
    sources,
    sourceAt(line, column) {
      return originalAt(line, column)?.source ?? null;
    },
    originalAt,
    firstOriginalLineBetween(source, start, end) {
      let first: number | null = null;
      eachSegmentBetween(segments, start, end, (i) => {
        if (segments.sources[i] !== source || segments.originalLines[i]! < 0) return false;
        first = segments.originalLines[i]!;
        return true;
      });
      return first;
    },
    originalLinesBetween(source, start, end, fromLine = 0) {
      let first = Number.POSITIVE_INFINITY;
      let last = -1;
      eachSegmentBetween(segments, start, end, (i) => {
        const line = segments.originalLines[i]!;
        if (segments.sources[i] === source && line >= fromLine) {
          if (line < first) first = line;
          if (line > last) last = line;
        }
        return false;
      });
      return last < 0 ? null : [first, last];
    },
  };
}

/**
 * Visit the indexes of the segments at or after a generated position and before
 * an end position, in order, until `visit` returns true.
 */
function eachSegmentBetween(
  segments: CompactSegments,
  start: GeneratedPosition,
  end: GeneratedPosition,
  visit: (index: number) => boolean,
): void {
  const lineCount = segments.lineStarts.length - 1;
  for (let line = Math.max(start.line, 0); line <= end.line && line < lineCount; line++) {
    let i = segments.lineStarts[line]!;
    const stop = segments.lineStarts[line + 1]!;
    // The first segment at or after the start column on the start line.
    if (line === start.line) {
      let hi = stop;
      while (i < hi) {
        const mid = (i + hi) >> 1;
        if (segments.columns[mid]! < start.column) i = mid + 1;
        else hi = mid;
      }
    }
    for (; i < stop; i++) {
      if (line === end.line && segments.columns[i]! >= end.column) return;
      if (visit(i)) return;
    }
  }
}

/** The offsets at which each line of a text starts. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** The 0-based line and column of a character offset, given the text's line starts. */
export function offsetToPosition(starts: ArrayLike<number>, offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, column: offset - starts[lo]! };
}

/** The URL in a script's last `//# sourceMappingURL=` comment; null when there is none. */
export function sourceMappingUrl(script: string): string | null {
  const tail = script.slice(-4096);
  const matches = [...tail.matchAll(/(?:\/\/|\/\*)[#@]\s*sourceMappingURL=([^\s*'"]+)/g)];
  return matches.length ? matches[matches.length - 1]![1]! : null;
}

/** The JSON text of a `data:` source map URL; null for any other URL or an undecodable one. */
export function decodeDataUrl(url: string): string | null {
  const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  try {
    if (!m[2]) return decodeURIComponent(m[3]!);
    const binary = globalThis.atob(m[3]!);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * A source path from a map or a module URL, reduced to a file path: bundler
 * prefixes (`webpack://<namespace>/`, `vite:`, `turbopack:///[project]/`,
 * `file://`), Vite's `/@fs`
 * prefix, a query and a hash dropped, and `./` segments removed. Absolute
 * paths stay absolute; others are relative to a root the caller picks.
 */
export function normalizeSourcePath(source: string): string {
  let s = source.replace(/[?#].*$/, '');
  s = s.replace(/^webpack:\/\/[^/]*\//, '').replace(/^webpack:\/\//, '');
  s = s.replace(/^(?:vite|rollup|turbopack|ng):\/*/, '');
  // Turbopack names the project root `[project]`.
  s = s.replace(/^\[project\]\//, '');
  s = s.replace(/^file:\/\//, '');
  s = s.replace(/^\/@fs\//, '/');
  s = s.replace(/^\/@id\//, '');
  try {
    s = decodeURIComponent(s);
  } catch {
    // Keep the raw text.
  }
  s = s.replace(/\\/g, '/');
  // Windows drive paths come as `/C:/…` after `/@fs`.
  if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
  s = s.replace(/(^|\/)\.\//g, '$1');
  return s;
}
