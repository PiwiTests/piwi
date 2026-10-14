/**
 * The coverage the project's tests recorded of an application file, as marks on the file as it stands. The coverage
 * names lines of one version of the file, by its git blob id; the file as it stands may be that version, an older or a
 * newer one, saved or not. The marks come from the version that is the file as it stands, else from a version the
 * repository holds, placed through the diff between the two (`placeLine`): a line changed since that version is marked
 * changed rather than guessed. With neither, no line is marked.
 */
import { createHash } from 'node:crypto';
import { normalizeLineRanges, type LineRange } from '@piwitests/core/coverage';
import { sameFilePath } from '@piwitests/core/locator-break';
import type { DiffHunk } from '@piwitests/core/diff-anchors';
import { diffLines } from '@piwitests/core/line-diff';
import { placeLine } from './analysis.js';
import type { CodeIndex, CoverageFragment, FileCoverage } from './piwi-client.js';
import type { CoverageResult, CoverageState, ExecutedSpan, LineSpan } from './protocol.js';
import { blobText } from './workspace.js';

/**
 * The git blob id of a content: the SHA-1 of `blob <byte length>\0` followed by the bytes, as `git hash-object` gives
 * a file git stores unfiltered.
 */
export function gitBlobId(content: string | Uint8Array): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

const BOM = '\uFEFF';

/**
 * The blob ids a text can have in git: its bytes as they are, and with CRLF line endings stored as LF (`core.autocrlf`,
 * `eol=lf`, which the reporter's `git hash-object` applies); each with and without the UTF-8 byte order mark an editor
 * keeps out of a document's text.
 */
export function textBlobIds(text: string): string[] {
  const bare = text.startsWith(BOM) ? text.slice(1) : text;
  const forms = new Set([bare, bare.replace(/\r\n/g, '\n')]);
  return [...forms].flatMap((form) => [gitBlobId(form), gitBlobId(BOM + form)]);
}

/** A text without its byte order mark, which a line diff would count as a change of its first line. */
function withoutBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/**
 * Whether the instance may hold coverage of a file (repository-relative), by the code index: when the tests' coverage
 * recorded it there (`via: 'coverage'`), or when the index cannot tell: none read, an older instance that does not say
 * how a file is reached, a file past a truncated index. A file the index says no coverage reaches is not asked for.
 */
export function mayHaveCoverage(codeIndex: CodeIndex | null, repoRelative: string): boolean {
  if (!codeIndex) return true;
  const reach = codeIndex.reach.filter((r) => {
    const file = codeIndex.files[r.file];
    return file !== undefined && sameFilePath(file, repoRelative);
  });
  if (!reach.length) return codeIndex.truncated;
  return reach.some((r) => r.via === undefined || r.via === 'coverage');
}

/** One version of a file the coverage names: its blob, its fragments and the tests that recorded them. */
export interface CoverageVersion {
  blob: string;
  fragments: CoverageFragment[];
  /** Positions in `FileCoverage.tests`, ascending. */
  tests: number[];
  /** Its executable lines, as a run's coverage recorded them; null when none did. */
  executable: LineRange[] | null;
}

/** The versions the coverage names lines of, the one the most tests recorded first. */
export function coverageVersions(coverage: FileCoverage): CoverageVersion[] {
  const byBlob = new Map<string, CoverageFragment[]>();
  for (const fragment of coverage.fragments) {
    if (!fragment.blob || !(fragment.lines?.length || fragment.functions?.length)) continue;
    byBlob.set(fragment.blob, [...(byBlob.get(fragment.blob) ?? []), fragment]);
  }
  return [...byBlob]
    .map(([blob, fragments]): CoverageVersion => {
      const executable = (coverage.executable ?? []).filter((e) => e.blob === blob).flatMap((e) => e.lines);
      return {
        blob,
        fragments,
        tests: [...new Set(fragments.flatMap((f) => f.tests))].sort((a, b) => a - b),
        executable: executable.length ? normalizeLineRanges(executable) : null,
      };
    })
    .sort((a, b) => b.tests.length - a.tests.length || (a.blob < b.blob ? -1 : 1));
}

/** The version the marks come from, and the text the file is diffed from when it is not the file as it stands. */
export interface ChosenVersion {
  state: CoverageState;
  version: CoverageVersion | null;
  /** The version's text, for `mapped`; null otherwise. */
  base: string | null;
}

/**
 * The texts of the versions the coverage names: a text seen with a version's blob id (the file as it stood when it was
 * that version, saved or not), else the blob as the repository holds it, read once. A blob the repository lacks is
 * asked again after `forgetMissing`, since a fetch may bring it.
 */
export class BlobTexts {
  /** Texts by blob id, the latest kept last. */
  private readonly seen = new Map<string, string>();
  private readonly reads = new Map<string, Promise<string | null>>();

  constructor(
    private readonly readBlob: (repoRoot: string, blob: string) => Promise<string | null> = blobText,
    private readonly max = 64,
  ) {}

  /** Keep a text as the version whose blob id is `blob`. */
  remember(text: string, blob: string): void {
    this.seen.delete(blob);
    this.seen.set(blob, text);
    for (const oldest of [...this.seen.keys()].slice(0, Math.max(0, this.seen.size - this.max)))
      this.seen.delete(oldest);
  }

  /** A version's text; null when no text was seen with its blob id and the repository lacks it. */
  async textOf(repoRoot: string, blob: string): Promise<string | null> {
    const seen = this.seen.get(blob);
    if (seen !== undefined) return seen;
    const key = `${repoRoot}\n${blob}`;
    let read = this.reads.get(key);
    if (!read) {
      read = this.readBlob(repoRoot, blob).catch(() => null);
      this.reads.set(key, read);
    }
    return read;
  }

  /** Ask the repository again for the blobs it lacked. */
  async forgetMissing(): Promise<void> {
    for (const [key, read] of this.reads) if ((await read) === null) this.reads.delete(key);
  }
}

/**
 * The version the marks of a file come from. The version whose blob id is the file's as it stands (`text`) is exact;
 * else the version the file as saved is (`savedText`, for a document edited since), else the first of the others, the
 * version the most tests recorded first, whose text is known or held by the repository, is mapped; else, with versions
 * none of which can be read, `other-version`; with none, `none`.
 */
export async function chooseVersion(
  versions: CoverageVersion[],
  text: string,
  savedText: () => string | null,
  texts: (blob: string) => Promise<string | null>,
  remember: (text: string, blob: string) => void,
): Promise<ChosenVersion> {
  if (!versions.length) return { state: 'none', version: null, base: null };
  const ids = new Set(textBlobIds(text));
  const exact = versions.find((v) => ids.has(v.blob));
  if (exact) {
    remember(text, exact.blob);
    return { state: 'exact', version: exact, base: null };
  }
  const saved = savedText();
  if (saved !== null && saved !== text) {
    const savedIds = new Set(textBlobIds(saved));
    const asSaved = versions.find((v) => savedIds.has(v.blob));
    if (asSaved) {
      remember(saved, asSaved.blob);
      return { state: 'mapped', version: asSaved, base: saved };
    }
  }
  for (const version of versions) {
    const base = await texts(version.blob);
    if (base !== null) return { state: 'mapped', version, base };
  }
  return { state: 'other-version', version: null, base: null };
}

/** The coverage of a file placed on its text as it stands, 1-based. */
export interface CoverageMarks {
  state: CoverageState;
  blob: string | null;
  /** Whether the coverage names the lines that ran, not only the functions. */
  byLine: boolean;
  /** Each line run, with the tests that ran it: positions in `FileCoverage.tests`. */
  executed: Map<number, number[]>;
  /** The executable lines no test ran, as known for the version. */
  notRun: Set<number>;
  /** The lines changed since the version. */
  changed: Set<number>;
  /** Each function that ran, at its first line, with the tests that ran it, first line first. */
  functions: Array<{ line: number; tests: number[] }>;
  /** The tests whose coverage the marks show; with `other-version` and `none`, every test that recorded the file. */
  tests: number[];
  /** The executable lines as placed; null when no run recorded them for the version. */
  executableLines: number | null;
}

/**
 * Where each line of the version is in the file as it stands: the same line for an exact version; through the hunks
 * of the diff for a mapped one, a line a hunk removed or changed having none (`changed` holds the lines the hunks
 * added instead). Lines past the file's end have none.
 */
function placement(
  chosen: ChosenVersion,
  text: string,
): { place: (line: number) => number | null; hunks: DiffHunk[]; changed: Set<number> } {
  const lineCount = withoutBom(text).split(/\r?\n/).length;
  if (chosen.state !== 'mapped' || chosen.base === null) {
    return { place: (line) => (line <= lineCount ? line : null), hunks: [], changed: new Set() };
  }
  const hunks = diffLines('file', withoutBom(chosen.base), withoutBom(text)).hunks;
  const removed = new Set(hunks.flatMap((h) => h.removed.map((r) => r.line)));
  // A blank line carries no code: its change says nothing about what ran.
  const changed = new Set(hunks.flatMap((h) => h.added.filter((a) => a.text.trim()).map((a) => a.line)));
  return {
    place: (line) => {
      if (removed.has(line)) return null;
      const at = placeLine(line, hunks).line;
      return at <= lineCount ? at : null;
    },
    hunks,
    changed,
  };
}

/** Every line of normalized ranges, in order. */
function* linesOf(ranges: LineRange[]): Generator<number> {
  for (const [start, end] of ranges) for (let line = start; line <= end; line++) yield line;
}

/** The marks of a file whose text is `text`, from the coverage of the version `chosen` names. */
export function coverageMarks(
  coverage: FileCoverage,
  versions: CoverageVersion[],
  chosen: ChosenVersion,
  text: string,
): CoverageMarks {
  const version = chosen.version;
  if (!version) {
    return {
      state: chosen.state,
      blob: null,
      byLine: false,
      executed: new Map(),
      notRun: new Set(),
      changed: new Set(),
      functions: [],
      tests: [...new Set(versions.flatMap((v) => v.tests))].sort((a, b) => a - b),
      executableLines: null,
    };
  }
  const { place, hunks, changed } = placement(chosen, text);
  const ran = new Map<number, Set<number>>();
  for (const fragment of version.fragments) {
    for (const line of linesOf(normalizeLineRanges(fragment.lines ?? []))) {
      const tests = ran.get(line) ?? new Set<number>();
      for (const t of fragment.tests) tests.add(t);
      ran.set(line, tests);
    }
  }
  const executed = new Map<number, number[]>();
  for (const [line, tests] of ran) {
    const at = place(line);
    if (at !== null)
      executed.set(
        at,
        [...tests].sort((a, b) => a - b),
      );
  }
  const notRun = new Set<number>();
  let executableLines: number | null = null;
  if (version.executable) {
    executableLines = 0;
    for (const line of linesOf(version.executable)) {
      const at = place(line);
      if (at === null || changed.has(at)) continue;
      executableLines++;
      if (!ran.has(line)) notRun.add(at);
    }
  }
  const functionTests = new Map<string, Set<number>>();
  for (const fragment of version.fragments) {
    for (const [start, end] of fragment.functions ?? []) {
      const key = `${start}:${end}`;
      const tests = functionTests.get(key) ?? new Set<number>();
      for (const t of fragment.tests) tests.add(t);
      functionTests.set(key, tests);
    }
  }
  const functions: CoverageMarks['functions'] = [];
  for (const [key, tests] of functionTests) {
    const [start, end] = key.split(':').map(Number) as [number, number];
    // A function the edits removed whole has no line left.
    let kept = false;
    for (let line = start; line <= end && !kept; line++) kept = place(line) !== null;
    if (!kept) continue;
    const at = chosen.state === 'mapped' ? placeLine(start, hunks).line : start;
    functions.push({ line: at, tests: [...tests].sort((a, b) => a - b) });
  }
  functions.sort((a, b) => a.line - b.line);
  return {
    state: chosen.state,
    blob: version.blob,
    byLine: version.fragments.some((f) => f.lines?.length),
    executed,
    notRun,
    changed,
    functions,
    tests: version.tests,
    executableLines,
  };
}

/** Lines (1-based) as 0-based spans of consecutive lines, each with the value `of` gives it equal along the span. */
function spans<T>(lines: Iterable<number>, of: (line: number) => T): Array<LineSpan & { value: T }> {
  const out: Array<LineSpan & { value: T }> = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const value = of(line);
    const last = out[out.length - 1];
    if (last && last.end === line - 2 && last.value === value) last.end = line - 1;
    else out.push({ start: line - 1, end: line - 1, value });
  }
  return out;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The lines marked as run that the version's executable lines hold, or all of them when those are not known. */
function runLines(marks: CoverageMarks): number {
  if (marks.executableLines === null) return marks.executed.size;
  return marks.executableLines - marks.notRun.size;
}

/**
 * What the file's lens adds about its lines: `41 of 63 lines run` when the executable lines are known,
 * `3 lines changed since the coverage run`, `coverage recorded on another version`; null when there is nothing to add.
 */
export function coverageNote(marks: CoverageMarks): string | null {
  if (marks.state === 'other-version') return 'coverage recorded on another version';
  const parts = [
    marks.executableLines !== null ? `${runLines(marks)} of ${plural(marks.executableLines, 'line')} run` : null,
    marks.changed.size ? `${plural(marks.changed.size, 'line')} changed since the coverage run` : null,
  ];
  return parts.filter(Boolean).join(' · ') || null;
}

/** The marks as `piwi/coverage` answers them. */
export function coverageResult(uri: string, marks: CoverageMarks | null): CoverageResult {
  if (!marks || marks.state === 'none') {
    return {
      uri,
      state: 'none',
      executed: [],
      notRun: [],
      changed: [],
      tests: 0,
      executedLines: 0,
      executableLines: null,
      blob: null,
      label: null,
    };
  }
  const executed: ExecutedSpan[] = spans(marks.executed.keys(), (line) => marks.executed.get(line)!.length).map(
    ({ start, end, value }) => ({ start, end, tests: value }),
  );
  const plain = (lines: Set<number>): LineSpan[] => spans(lines, () => 0).map(({ start, end }) => ({ start, end }));
  const run = runLines(marks);
  const what = !marks.byLine
    ? plural(marks.functions.length, 'function')
    : marks.executableLines !== null
      ? `${run} of ${plural(marks.executableLines, 'line')}`
      : plural(run, 'line');
  const label =
    marks.state === 'other-version'
      ? `${plural(marks.tests.length, 'test')} ran another version of this file`
      : [
          `${what} run by ${plural(marks.tests.length, 'test')}`,
          marks.changed.size ? `${plural(marks.changed.size, 'line')} changed since the coverage run` : null,
        ]
          .filter(Boolean)
          .join(' · ');
  return {
    uri,
    state: marks.state,
    executed,
    notRun: plain(marks.notRun),
    changed: plain(marks.changed),
    tests: marks.tests.length,
    executedLines: marks.executed.size,
    executableLines: marks.executableLines,
    blob: marks.blob,
    label,
  };
}
