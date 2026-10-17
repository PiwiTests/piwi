import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CoverageReportReader,
  detectCoverageFormat,
  mergeReportedFiles,
  reportPathCandidates,
  type CoverageReport,
  type CoverageReportFormat,
  type ReportedFile,
} from '@piwitests/core/coverage-formats';
import type { CoverageScopeMatcher } from '@piwitests/core/coverage-scope';

/**
 * The reports `piwi coverage upload` names, read into Piwi's model: patterns
 * expanded by the command itself, so a quoted `**` pattern works the
 * same in every shell; each report read as a stream; each of its paths
 * resolved to a repository-relative path of the checkout.
 */

/** Directories a pattern never walks into unless it names them. */
const SKIPPED_DIRS = new Set(['node_modules', '.git']);

function globSegmentRegExp(segment: string): RegExp {
  const source = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`);
}

/** The files a pattern names under `cwd`: `*` and `?` within a path segment, `**` across segments. */
export function expandPattern(pattern: string, cwd: string): string[] {
  const normalized = pattern.replace(/\\/g, '/');
  if (!/[*?]/.test(normalized)) {
    const file = path.resolve(cwd, normalized);
    return fs.existsSync(file) && fs.statSync(file).isFile() ? [file] : [];
  }
  const absolute = path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized);
  const segments = normalized.split('/');
  const firstWild = segments.findIndex((s) => /[*?]/.test(s));
  const baseParts = segments.slice(0, firstWild);
  const base = absolute ? baseParts.join('/') || '/' : path.resolve(cwd, ...baseParts);
  const rest = segments.slice(firstWild).filter((s) => s !== '');
  const out: string[] = [];
  const walk = (dir: string, at: number) => {
    if (at >= rest.length) return;
    const segment = rest[at]!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (segment === '**') {
      // Zero segments, then one more and still `**`.
      walk(dir, at + 1);
      for (const entry of entries) {
        if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), at);
      }
      return;
    }
    const match = globSegmentRegExp(segment);
    const last = at === rest.length - 1;
    for (const entry of entries) {
      if (!match.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (last && entry.isFile()) out.push(full);
      else if (!last && entry.isDirectory() && (!SKIPPED_DIRS.has(entry.name) || segment === entry.name)) {
        walk(full, at + 1);
      }
    }
  };
  walk(base, 0);
  return [...new Set(out)].sort();
}

/** A report file read as a stream, in chunks; its format detected from its first bytes unless given. */
export async function readReport(file: string, format?: CoverageReportFormat): Promise<CoverageReport> {
  let reader: CoverageReportReader | null = format ? new CoverageReportReader(format) : null;
  let head = '';
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1024 * 1024 })) {
    if (!reader) {
      head += chunk as string;
      if (head.length < 4096) continue;
      const detected = detectCoverageFormat(head);
      if (!detected) throw new Error(`${file} is not a Cobertura, LCOV or Piwi coverage report`);
      reader = new CoverageReportReader(detected);
      reader.write(head);
      head = '';
      continue;
    }
    reader.write(chunk as string);
  }
  if (!reader) {
    const detected = detectCoverageFormat(head);
    if (!detected) throw new Error(`${file} is not a Cobertura, LCOV or Piwi coverage report`);
    reader = new CoverageReportReader(detected);
    reader.write(head);
  }
  return reader.end();
}

/** Where a report's paths are resolved, and which files count. */
export interface ResolveOptions {
  repoRoot: string;
  cwd: string;
  /** `--root`: the one directory a relative path starts from. */
  root?: string;
  /** The tracked files of the checkout, by repository-relative path, with their blob ids. */
  inventory: ReadonlyMap<string, string>;
  inScope: CoverageScopeMatcher;
}

/** What resolving one or more reports came to. */
export interface ResolvedReports {
  /** The files in scope, by repository-relative path, the reports' entries merged. */
  files: Map<string, ReportedFile>;
  /** Paths no file of the checkout matched. */
  unmatched: string[];
  /** Files left out by the project's coverage scope. */
  outOfScope: number;
}

/**
 * The bases a report's relative paths are tried against, in order: `--root`
 * alone when given; else the report's `<source>`s (relative ones from the
 * report's directory), the current directory, the report's directory and its
 * parent (Vitest writes `coverage/` under its root), and the repository root.
 */
export function reportBases(report: CoverageReport, reportFile: string, options: ResolveOptions): string[] {
  if (options.root) return [path.resolve(options.cwd, options.root)];
  const dir = path.dirname(path.resolve(reportFile));
  const sources = report.sources.map((source) =>
    path.isAbsolute(source) || /^[A-Za-z]:[\\/]/.test(source) ? source : path.resolve(dir, source),
  );
  return [...sources, options.cwd, dir, path.dirname(dir), options.repoRoot];
}

/**
 * Add a report's files to `into`: each path resolved to the first candidate a
 * file of the checkout has (tracked, else on disk), files out of scope left
 * out, entries of one file merged.
 */
export function resolveReport(
  report: CoverageReport,
  reportFile: string,
  options: ResolveOptions,
  into: ResolvedReports,
): void {
  const bases = reportBases(report, reportFile, options);
  for (const file of report.files) {
    const candidates = reportPathCandidates(file.path, { repoRoot: options.repoRoot, bases });
    const match =
      candidates.find((candidate) => options.inventory.has(candidate)) ??
      candidates.find((candidate) => fs.existsSync(path.join(options.repoRoot, candidate)));
    if (!match) {
      into.unmatched.push(file.path);
      continue;
    }
    if (!options.inScope(match)) {
      into.outOfScope++;
      continue;
    }
    const known = into.files.get(match);
    into.files.set(match, known ? mergeReportedFiles(known, file) : { ...file, path: match });
  }
}
