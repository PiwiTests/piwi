/**
 * A project's coverage scope: the files a coverage ratio counts, as include
 * and exclude patterns over repository-relative paths, in the gitignore-style
 * syntax CODEOWNERS uses (`*` within a segment, `**` across segments, a
 * pattern without an inner `/` at any depth, a directory owning its
 * contents). No include pattern includes every file; an exclude pattern wins
 * over an include. The default excludes leave out tests, build output and
 * generated sources, whatever tool reports them.
 *
 * A project also names areas of its code (`front: apps/web/`, `back: src/Api/`)
 * in the same syntax: a file belongs to the first area whose patterns match
 * it, so every suite's coverage splits the same way.
 */
import { pathPatternMatcher } from './codeowners';

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

/** Patterns per list at most, characters per pattern, and `*` per pattern. */
export const MAX_SCOPE_PATTERNS = 200;
const MAX_PATTERN_LENGTH = 300;
const MAX_PATTERN_WILDCARDS = 20;

/**
 * The patterns of a list from untrusted input, trimmed, blank ones and
 * comments dropped, each kept once. Null when the list is not one of strings,
 * holds a `!` negation, a pattern over 300 characters or with more than 20
 * `*`, or names more than 200 patterns.
 */
function patterns(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    const pattern = item.trim();
    if (!pattern || pattern.startsWith('#')) continue;
    const tooLarge = pattern.length > MAX_PATTERN_LENGTH || pattern.split('*').length - 1 > MAX_PATTERN_WILDCARDS;
    if (tooLarge || pattern.startsWith('!')) return null;
    if (!out.includes(pattern)) out.push(pattern);
  }
  return out.length > MAX_SCOPE_PATTERNS ? null : out;
}

/**
 * A scope from untrusted input: two lists of patterns, blank ones and
 * comments dropped, each kept once. Null when either is not a list of
 * strings, holds a `!` negation, a pattern over 300 characters or with more
 * than 20 `*`, or names more than 200 patterns. A missing list is empty.
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
  const include = scope.include.map(pathPatternMatcher);
  const exclude = scope.exclude.map(pathPatternMatcher);
  return (path) => {
    const file = path.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (include.length > 0 && !include.some((matches) => matches(file))) return false;
    return !exclude.some((matches) => matches(file));
  };
}

/** A named area of the code, `front` or `back`: the files its patterns match, in the scope's syntax. */
export interface CoverageArea {
  name: string;
  include: string[];
}

/** Areas a project names at most. */
export const MAX_COVERAGE_AREAS = 20;
const AREA_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;

/**
 * Areas from untrusted input: each a name (1 to 40 letters, digits, spaces,
 * `.`, `_` or `-`, starting with a letter or digit) and at least one include
 * pattern, held to a scope's limits, the names distinct. Null when the input
 * is not such a list, or names more than 20 areas.
 */
export function parseCoverageAreas(raw: unknown): CoverageArea[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_COVERAGE_AREAS) return null;
  const out: CoverageArea[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const include = patterns(record.include);
    if (!AREA_NAME.test(name) || !include || include.length === 0) return null;
    if (out.some((area) => area.name.toLowerCase() === name.toLowerCase())) return null;
    out.push({ name, include });
  }
  return out;
}

/** The area a repository-relative path belongs to: the first whose patterns match it, else null. */
export function compileCoverageAreas(areas: CoverageArea[]): (path: string) => string | null {
  const compiled = areas.map((area) => ({ name: area.name, patterns: area.include.map(pathPatternMatcher) }));
  return (path) => {
    const file = path.replace(/\\/g, '/').replace(/^\.?\//, '');
    return compiled.find((area) => area.patterns.some((matches) => matches(file)))?.name ?? null;
  };
}
