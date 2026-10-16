/**
 * A project's coverage scope: the files a coverage ratio counts, as include
 * and exclude patterns over repository-relative paths, in the gitignore-style
 * syntax CODEOWNERS uses (`*` within a segment, `**` across segments, a
 * pattern without an inner `/` at any depth, a directory owning its
 * contents). No include pattern includes every file; an exclude pattern wins
 * over an include. The default excludes leave out tests, build output and
 * generated sources, whatever tool reports them.
 */
import { pathPatternToRegExp } from './codeowners';

/** The include and exclude patterns of a project's coverage scope. */
export interface CoverageScope {
  include: string[];
  exclude: string[];
}

/** What every scope leaves out unless a project changes its excludes. */
export const DEFAULT_COVERAGE_EXCLUDES: readonly string[] = [
  '*.test.*',
  '*.spec.*',
  'tests/',
  'test/',
  '__tests__/',
  '*Tests/',
  '*.Tests/',
  'obj/',
  'bin/',
  'node_modules/',
  '*.g.cs',
  '*.Designer.cs',
  '*.generated.*',
];

/** The scope a project starts with: every file, but the default excludes. */
export const DEFAULT_COVERAGE_SCOPE: CoverageScope = { include: [], exclude: [...DEFAULT_COVERAGE_EXCLUDES] };

/** Patterns per list at most, and characters per pattern. */
export const MAX_SCOPE_PATTERNS = 200;
const MAX_PATTERN_LENGTH = 300;

function patterns(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    const pattern = item.trim();
    if (!pattern || pattern.startsWith('#')) continue;
    if (pattern.length > MAX_PATTERN_LENGTH || pattern.startsWith('!')) return null;
    if (!out.includes(pattern)) out.push(pattern);
  }
  return out.length > MAX_SCOPE_PATTERNS ? null : out;
}

/**
 * A scope from untrusted input: two lists of patterns, blank ones and
 * comments dropped, each kept once. Null when either is not a list of
 * strings, holds a `!` negation or a pattern over 300 characters, or names
 * more than 200 patterns. A missing list is empty.
 */
export function parseCoverageScope(raw: unknown): CoverageScope | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const include = record.include === undefined ? [] : patterns(record.include);
  const exclude = record.exclude === undefined ? [] : patterns(record.exclude);
  return include && exclude ? { include, exclude } : null;
}

/** A compiled scope: whether a repository-relative path counts. */
export type CoverageScopeMatcher = (path: string) => boolean;

/** Whether a path is in the scope: matched by an include pattern (or no include at all), by no exclude pattern. */
export function compileCoverageScope(scope: CoverageScope): CoverageScopeMatcher {
  const include = scope.include.map(pathPatternToRegExp);
  const exclude = scope.exclude.map(pathPatternToRegExp);
  return (path) => {
    const file = path.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (include.length > 0 && !include.some((pattern) => pattern.test(file))) return false;
    return !exclude.some((pattern) => pattern.test(file));
  };
}
