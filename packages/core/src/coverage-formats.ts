/**
 * Coverage reports written by other tools, read into Piwi's coverage model:
 * per file, its executable lines, the lines that ran, and the functions the
 * tool knows, run or not. Three formats are read:
 *
 * - **Cobertura** (Vitest's `cobertura` reporter, coverlet, Microsoft code
 *   coverage): a tag scanner reading `<source>`, each `<class filename>`, its
 *   own `<line number hits>` and each `<method>`'s lines. A method repeats its
 *   class's lines, so only the class's own lines count as lines; a method's
 *   lines give its start and end line, and it ran when one of them did. No DTD
 *   is read and no entity is expanded beyond XML's five and character
 *   references;
 * - **LCOV** (Vitest's `lcov` reporter, coverlet): `SF`, `DA`, `FN` (with an
 *   end line when the writer gives one), `FNDA`, the `FNL` and `FNA` records of
 *   LCOV 2.2, and `end_of_record`;
 * - **Piwi** (`PiwiTests.Instrumentation.Coverage`'s run-level report, which a
 *   .NET test host writes at exit with `PIWI_COVERAGE_OUTPUT`): JSON,
 *   `{ "v": 1, "files": [{ "path", "lines", "executable", "functions",
 *   "allFunctions" }] }`, its ranges as written. Read whole when it ends.
 *
 * Every line a report lists is executable; it ran when its hit count is above
 * zero. A file named several times (Cobertura's classes, merged LCOV records)
 * is the union of its entries. Reports are fed in chunks and never held whole:
 * a file's lines are kept as one byte per source line until the end.
 *
 * Paths are kept as the report writes them; {@link reportPathCandidates} turns
 * one into the repository-relative paths it may stand for.
 */
import { normalizeFunctionRanges, normalizeLineRanges, type LineRange } from './coverage';

/** The report formats read. */
export type CoverageReportFormat = 'cobertura' | 'lcov' | 'piwi';

/** One file of a report, its path as the report writes it. */
export interface ReportedFile {
  path: string;
  /** Every line the tool can mark as run, normalized. */
  executable: LineRange[];
  /** The lines that ran, normalized. */
  lines: LineRange[];
  /** The start and end line of each function that ran. */
  functions: LineRange[];
  /** The start and end line of every function the tool knows, run or not. */
  allFunctions: LineRange[];
}

/** A whole report as read. */
export interface CoverageReport {
  format: CoverageReportFormat;
  /** Cobertura's `<source>` directories, in order; empty for LCOV. */
  sources: string[];
  files: ReportedFile[];
}

/** Highest line number kept. */
const MAX_LINE = 1_000_000;

/** Longest pending text the Cobertura scanner keeps between chunks, past which the report is refused. */
const MAX_PENDING = 1024 * 1024;

const EXECUTABLE = 1;
const RAN = 2;

const GREATER_THAN = 0x3e;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;

/** The format of a report from its first bytes; null when it is neither. */
export function detectCoverageFormat(head: string): CoverageReportFormat | null {
  const text = head.replace(/^﻿/, '').trimStart();
  if (text.startsWith('{')) return /"files"\s*:/.test(text) ? 'piwi' : null;
  if (text.startsWith('<'))
    return /<coverage[\s>]/.test(text) || !/<\w/.test(text.replace(/<[?!][^>]*>/g, '')) ? 'cobertura' : null;
  return /^(?:TN|SF):/m.test(text) ? 'lcov' : null;
}

/** The lines and functions of one file, as they accumulate. */
class FileLines {
  private flags = new Uint8Array(64);
  private length = 0;
  readonly functions = new Map<string, { start: number; end: number; ran: boolean }>();

  line(number: number, hits: number): void {
    if (!Number.isInteger(number) || number < 1 || number > MAX_LINE) return;
    if (number >= this.flags.length) {
      const grown = new Uint8Array(Math.min(MAX_LINE + 1, Math.max(number + 1, this.flags.length * 2)));
      grown.set(this.flags);
      this.flags = grown;
    }
    this.flags[number]! |= hits > 0 ? EXECUTABLE | RAN : EXECUTABLE;
    if (number >= this.length) this.length = number + 1;
  }

  /** A function by a key unique in the file; a later entry for the same key widens it and keeps it run. */
  fn(key: string, start: number, end: number, ran: boolean): void {
    if (!(start >= 1 && start <= MAX_LINE)) return;
    const last = end >= start && end <= MAX_LINE ? end : start;
    const known = this.functions.get(key);
    if (known) {
      known.start = Math.min(known.start, start);
      known.end = Math.max(known.end, last);
      known.ran ||= ran;
    } else {
      this.functions.set(key, { start, end: last, ran });
    }
  }

  toFile(path: string): ReportedFile {
    const executable: LineRange[] = [];
    const lines: LineRange[] = [];
    const push = (ranges: LineRange[], line: number) => {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === line - 1) last[1] = line;
      else ranges.push([line, line]);
    };
    for (let line = 1; line < this.length; line++) {
      const flags = this.flags[line]!;
      if (flags & EXECUTABLE) push(executable, line);
      if (flags & RAN) push(lines, line);
    }
    const all: LineRange[] = [];
    const ran: LineRange[] = [];
    for (const { start, end, ran: didRun } of this.functions.values()) {
      all.push([start, end]);
      if (didRun) ran.push([start, end]);
    }
    return {
      path,
      executable,
      lines,
      functions: normalizeFunctionRanges(ran),
      allFunctions: normalizeFunctionRanges(all),
    };
  }
}

/** The files of a report, by path as written, in the order first named. */
class ReportFiles {
  private readonly byPath = new Map<string, FileLines>();

  of(path: string): FileLines {
    let file = this.byPath.get(path);
    if (!file) {
      file = new FileLines();
      this.byPath.set(path, file);
    }
    return file;
  }

  toFiles(): ReportedFile[] {
    return [...this.byPath].map(([path, file]) => file.toFile(path));
  }
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML text with its five predefined entities and its character references decoded; any other entity is kept as is. */
function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
    if (name[0] !== '#') return XML_ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** The attributes of a start tag's text (after its name). */
function attributesOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    out[match[1]!] = decodeXml(match[2] ?? match[3] ?? '');
  }
  return out;
}

const NUMBER_ATTRIBUTE = /\snumber\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const HITS_ATTRIBUTE = /\shits\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/** One attribute's raw value in a start tag, or undefined. */
function attributeValue(markup: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(markup);
  return match ? (match[1] ?? match[2]) : undefined;
}

function integer(value: string | undefined): number {
  if (value === undefined) return Number.NaN;
  const number = Number(value.trim());
  return Number.isFinite(number) ? Math.trunc(number) : Number.NaN;
}

/** A Cobertura report, fed in chunks. */
class CoberturaReader {
  /** The text not read yet: empty, or the markup still open, from its `<`. */
  private pending = '';
  /** How many characters of that markup are scanned, and the quote open after them (0 when none). */
  private scanned = 0;
  private quote = 0;
  private readonly files = new ReportFiles();
  private readonly sources: string[] = [];
  /** The text inside the `<source>` being read, or null outside one. */
  private sourceText: string | null = null;
  private file: FileLines | null = null;
  private methodCount = 0;
  /** The method being read: its lines' extent and whether one ran. */
  private method: { start: number; end: number; ran: boolean; key: string } | null = null;

  write(chunk: string): void {
    let text = this.pending + chunk;
    let at = 0;
    for (;;) {
      const open = text.indexOf('<', at);
      if (open < 0) {
        if (this.sourceText !== null) this.sourceText += text.slice(at);
        at = text.length;
        break;
      }
      if (this.sourceText !== null) this.sourceText += text.slice(at, open);
      const close = this.tagEnd(text, open);
      if (close < 0) {
        at = open;
        break;
      }
      this.tag(text.slice(open, close + 1));
      at = close + 1;
    }
    text = text.slice(at);
    if (text.length > MAX_PENDING) throw new Error('The Cobertura report has a tag longer than 1 MB.');
    this.pending = text;
  }

  end(): CoverageReport {
    this.write('');
    return { format: 'cobertura', sources: this.sources, files: this.files.toFiles() };
  }

  /**
   * Where the markup starting at `open` ends: its `>`, past comments, CDATA and quoted attribute values; -1 if not
   * yet read. The text is scanned once, forward: an unfinished markup keeps how far it is scanned and its open quote
   * for the next chunk.
   */
  private tagEnd(text: string, open: number): number {
    const head = text.slice(open, open + 9);
    if (head.length < 9 && ('<!--'.startsWith(head) || '<![CDATA['.startsWith(head))) return -1;
    if (head.startsWith('<!--')) return this.through(text, open, '-->', 4);
    if (head.startsWith('<![CDATA[')) return this.through(text, open, ']]>', 9);
    let quote = this.quote;
    for (let at = open + Math.max(1, this.scanned); at < text.length; at++) {
      const char = text.charCodeAt(at);
      if (quote !== 0) {
        if (char === quote) quote = 0;
      } else if (char === GREATER_THAN) {
        this.scanned = 0;
        this.quote = 0;
        return at;
      } else if (char === DOUBLE_QUOTE || char === SINGLE_QUOTE) {
        quote = char;
      }
    }
    this.scanned = text.length - open;
    this.quote = quote;
    return -1;
  }

  /** Where a comment or CDATA section starting at `open` ends: the last character of `end`; -1 if not yet read. */
  private through(text: string, open: number, end: string, start: number): number {
    const at = text.indexOf(end, open + Math.max(start, this.scanned));
    if (at < 0) {
      this.scanned = Math.max(start, text.length - open - end.length + 1);
      return -1;
    }
    this.scanned = 0;
    return at + end.length - 1;
  }

  private tag(markup: string): void {
    // The bulk of a report: `<line number="12" hits="3" …/>`, read without a full attribute scan.
    if (markup.startsWith('<line ') || markup.startsWith('<line\t') || markup.startsWith('<line\n')) {
      this.line(integer(attributeValue(markup, NUMBER_ATTRIBUTE)), integer(attributeValue(markup, HITS_ATTRIBUTE)));
      return;
    }
    if (markup.startsWith('<![CDATA[')) {
      if (this.sourceText !== null) this.sourceText += markup.slice(9, -3);
      return;
    }
    if (markup.startsWith('<!') || markup.startsWith('<?')) return;
    const closing = markup[1] === '/';
    const match = /^<\/?([\w:.-]+)/.exec(markup);
    if (!match) return;
    const name = match[1]!.toLowerCase();
    const selfClosing = markup.endsWith('/>');
    if (closing) {
      this.closeTag(name);
      return;
    }
    const attributes = attributesOf(markup.slice(match[0].length));
    switch (name) {
      case 'source':
        if (!selfClosing) this.sourceText = '';
        break;
      case 'class':
        this.file = attributes.filename ? this.files.of(attributes.filename) : null;
        this.method = null;
        if (selfClosing) this.file = null;
        break;
      case 'method':
        if (this.file) {
          const line = integer(attributes.line);
          this.method = { start: line, end: line, ran: false, key: `m${this.methodCount++}` };
          if (selfClosing) this.closeTag('method');
        }
        break;
    }
  }

  private line(number: number, hits: number): void {
    if (!Number.isInteger(number)) return;
    const { method } = this;
    if (method) {
      method.start = Number.isInteger(method.start) ? Math.min(method.start, number) : number;
      method.end = Number.isInteger(method.end) ? Math.max(method.end, number) : number;
      if (hits > 0) method.ran = true;
    } else if (this.file) {
      this.file.line(number, Number.isInteger(hits) ? hits : 0);
    }
  }

  private closeTag(name: string): void {
    if (name === 'source' && this.sourceText !== null) {
      const source = decodeXml(this.sourceText).trim();
      if (source) this.sources.push(source);
      this.sourceText = null;
    } else if (name === 'method' && this.method) {
      const { start, end, ran, key } = this.method;
      if (this.file && Number.isInteger(start)) this.file.fn(key, start, end, ran);
      this.method = null;
    } else if (name === 'class') {
      this.file = null;
      this.method = null;
    }
  }
}

/** An LCOV report, fed in chunks. */
class LcovReader {
  private pending = '';
  private readonly files = new ReportFiles();
  private file: FileLines | null = null;
  /**
   * The functions of the current record by name (`FN`/`FNDA`), each name's in the order its `FN`s come, with how
   * many `FNDA`s of the name are read; and by index (`FNL`/`FNA`).
   */
  private byName = new Map<string, Array<{ start: number; end: number }>>();
  private namesRun = new Map<string, number>();
  private byIndex = new Map<string, { start: number; end: number }>();
  private record = 0;

  write(chunk: string): void {
    const text = this.pending + chunk;
    const lines = text.split(/\r?\n/);
    this.pending = lines.pop() ?? '';
    if (this.pending.length > MAX_PENDING) throw new Error('The LCOV report has a line longer than 1 MB.');
    for (const line of lines) this.line(line);
  }

  end(): CoverageReport {
    if (this.pending) this.line(this.pending);
    this.pending = '';
    this.endRecord();
    return { format: 'lcov', sources: [], files: this.files.toFiles() };
  }

  private line(raw: string): void {
    const line = raw.trim();
    const colon = line.indexOf(':');
    const key = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1);
    switch (key) {
      case 'SF':
        this.endRecord();
        this.file = value ? this.files.of(value) : null;
        this.record++;
        break;
      case 'DA': {
        const [number, hits] = value.split(',');
        this.file?.line(integer(number), Math.max(0, integer(hits) || 0));
        break;
      }
      case 'FN': {
        // `FN:<start>,<name>`, or `FN:<start>,<end>,<name>` from writers that give the end line.
        const parts = value.split(',');
        const start = integer(parts[0]);
        const withEnd = parts.length >= 3 && /^\s*\d+\s*$/.test(parts[1]!);
        const end = withEnd ? integer(parts[1]) : start;
        const name = parts.slice(withEnd ? 2 : 1).join(',');
        if (this.file && Number.isInteger(start)) {
          const named = this.byName.get(name) ?? [];
          this.byName.set(name, named);
          named.push({ start, end });
          this.file.fn(`${this.record}:n:${named.length - 1}:${name}`, start, end, false);
        }
        break;
      }
      case 'FNDA': {
        // The n-th `FNDA` of a name counts the n-th `FN` of that name, in the order both are written.
        const comma = value.indexOf(',');
        const hits = integer(value.slice(0, comma));
        const name = value.slice(comma + 1);
        const nth = this.namesRun.get(name) ?? 0;
        this.namesRun.set(name, nth + 1);
        const known = this.byName.get(name)?.[nth];
        if (this.file && known && hits > 0) {
          this.file.fn(`${this.record}:n:${nth}:${name}`, known.start, known.end, true);
        }
        break;
      }
      case 'FNL': {
        // `FNL:<index>,<start>[,<end>]`
        const [index, start, end] = value.split(',');
        const first = integer(start);
        if (this.file && index !== undefined && Number.isInteger(first)) {
          const last = end === undefined ? first : integer(end);
          this.byIndex.set(index, { start: first, end: last });
          this.file.fn(`${this.record}:i:${index}`, first, last, false);
        }
        break;
      }
      case 'FNA': {
        // `FNA:<index>,<hits>,<name>`
        const [index, hits] = value.split(',');
        const known = index === undefined ? undefined : this.byIndex.get(index);
        if (this.file && known && integer(hits) > 0) {
          this.file.fn(`${this.record}:i:${index}`, known.start, known.end, true);
        }
        break;
      }
      case 'end_of_record':
        this.endRecord();
        break;
    }
  }

  private endRecord(): void {
    this.file = null;
    this.byName = new Map();
    this.namesRun = new Map();
    this.byIndex = new Map();
  }
}

/** Longest Piwi report read, in characters. */
const MAX_PIWI_REPORT = 512 * 1024 * 1024;

/** A Piwi run-level report: its text kept until the end, then parsed. */
class PiwiReader {
  private readonly chunks: string[] = [];
  private length = 0;

  write(chunk: string): void {
    this.length += chunk.length;
    if (this.length > MAX_PIWI_REPORT) throw new Error('The Piwi coverage report is larger than 512 MB.');
    this.chunks.push(chunk);
  }

  end(): CoverageReport {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.chunks.join('').replace(/^﻿/, ''));
    } catch {
      throw new Error('The Piwi coverage report is not JSON.');
    }
    const files = (parsed as { files?: unknown } | null)?.files;
    if (!Array.isArray(files)) throw new Error('The Piwi coverage report has no "files" array.');
    const byPath = new Map<string, ReportedFile>();
    for (const item of files as Array<Record<string, unknown>>) {
      if (typeof item?.path !== 'string' || !item.path) continue;
      const file: ReportedFile = {
        path: item.path,
        executable: normalizeLineRanges(item.executable),
        lines: normalizeLineRanges(item.lines),
        functions: normalizeFunctionRanges(item.functions),
        allFunctions: normalizeFunctionRanges(item.allFunctions),
      };
      const known = byPath.get(file.path);
      byPath.set(file.path, known ? mergeReportedFiles(known, file) : file);
    }
    return { format: 'piwi', sources: [], files: [...byPath.values()] };
  }
}

/** Reads a report fed in chunks: {@link write} each chunk of text in order, then {@link end}. */
export class CoverageReportReader {
  private readonly reader: CoberturaReader | LcovReader | PiwiReader;

  constructor(readonly format: CoverageReportFormat) {
    this.reader =
      format === 'cobertura' ? new CoberturaReader() : format === 'lcov' ? new LcovReader() : new PiwiReader();
  }

  /** Adds the next chunk of the report's text. Throws on a tag or a line longer than 1 MB. */
  write(chunk: string): void {
    this.reader.write(chunk);
  }

  /** The report read; its files merged by path and sorted in the order the report first names them. */
  end(): CoverageReport {
    return this.reader.end();
  }
}

/** A report read whole from its text: the stream reader fed once. */
export function parseCoverageReport(text: string, format?: CoverageReportFormat): CoverageReport | null {
  const detected = format ?? detectCoverageFormat(text.slice(0, 4096));
  if (!detected) return null;
  const reader = new CoverageReportReader(detected);
  reader.write(text);
  return reader.end();
}

/** A path with slashes, `.` and `..` segments resolved; null when it climbs above its root. */
function normalizeSlashPath(raw: string): string | null {
  const absolute = raw.startsWith('/');
  const drive = /^[A-Za-z]:\//.exec(raw)?.[0] ?? '';
  const rest = drive ? raw.slice(drive.length) : absolute ? raw.slice(1) : raw;
  const out: string[] = [];
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return (drive || (absolute ? '/' : '')) + out.join('/');
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

/** `path` relative to `root`, both absolute and slash-separated; drive letters compare in any case. Null when outside. */
function relativeTo(path: string, root: string): string | null {
  const drive = /^[A-Za-z]:/.test(root);
  const base = root.endsWith('/') ? root : `${root}/`;
  const head = path.slice(0, base.length);
  const inside = drive ? head.toLowerCase() === base.toLowerCase() : head === base;
  if (!inside) return null;
  const relative = path.slice(base.length);
  return relative || null;
}

/** Where a report's relative paths may start. */
export interface ReportPathBases {
  /** The repository root, absolute. */
  repoRoot: string;
  /**
   * Absolute directories a relative path is tried against, in order (`--root`,
   * or the report's `<source>`s, the current directory, the report's directory
   * and its parent, the repository root).
   */
  bases: string[];
}

/**
 * The repository-relative POSIX paths a report's path may stand for, in the
 * order to try them, each once: backslashes turned into slashes; an absolute
 * path made relative to the repository root; a relative path tried against
 * each base; the deterministic `/_/` root of a .NET build with
 * `ContinuousIntegrationBuild`, in the path or in the base it joins (coverlet's
 * `<source>`), read as the repository root. A path outside the repository
 * stands for none.
 */
export function reportPathCandidates(raw: string, { repoRoot, bases }: ReportPathBases): string[] {
  const slash = (value: string) => value.replace(/\\/g, '/');
  const root = normalizeSlashPath(slash(repoRoot));
  const path = slash(raw.trim());
  if (!root || !path || path.includes('\0')) return [];
  const out: string[] = [];
  const add = (absolute: string) => {
    const normalized = normalizeSlashPath(absolute);
    if (!normalized) return;
    const relative = normalized.startsWith('/_/') ? normalized.slice(3) : relativeTo(normalized, root);
    if (relative && !out.includes(relative)) out.push(relative);
  };
  if (isAbsolutePath(path)) {
    add(path);
  } else {
    for (const base of bases) {
      const dir = slash(base);
      if (isAbsolutePath(dir)) add(`${dir}/${path}`);
    }
  }
  return out;
}

/** Two entries of one file as one: the union of their lines and functions. */
export function mergeReportedFiles(a: ReportedFile, b: ReportedFile): ReportedFile {
  return {
    path: a.path,
    executable: normalizeLineRanges([...a.executable, ...b.executable]),
    lines: normalizeLineRanges([...a.lines, ...b.lines]),
    functions: normalizeFunctionRanges([...a.functions, ...b.functions]),
    allFunctions: normalizeFunctionRanges([...a.allFunctions, ...b.allFunctions]),
  };
}
