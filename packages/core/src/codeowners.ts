/**
 * CODEOWNERS parsing and matching.
 *
 * Ownership that costs nobody an annotation: the repository already says who
 * owns which files, so a spec file's owner can be derived rather than declared.
 * A `piwi:owner` annotation still wins where a team wants to be explicit — this
 * is the fallback that makes ownership work on day one with zero test edits.
 *
 * The pattern syntax is gitignore-style, as GitHub, GitLab and Bitbucket all
 * document it. Deliberately not supported: `!` negation (GitHub ignores it in
 * CODEOWNERS) and character classes, which real CODEOWNERS files do not use.
 */

/** One parsed CODEOWNERS rule, in file order. */
export interface CodeownersRule {
  /** The raw pattern as written, kept for display and debugging. */
  pattern: string;
  /** Owners as written — `@team`, `@user`, or an email. */
  owners: string[];
  /** 1-based line in the source file. */
  line: number;
}

/**
 * Parse a CODEOWNERS file. Comments, blank lines and rules with no owners are
 * dropped. Rules are returned in file order; matching walks them in reverse,
 * because the *last* matching rule wins.
 */
export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const withoutComment = (lines[i] ?? '').split('#')[0] ?? '';
    const trimmed = withoutComment.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    const pattern = parts[0];
    const owners = parts.slice(1).filter(Boolean);
    if (!pattern || owners.length === 0) continue;

    rules.push({ pattern, owners, line: i + 1 });
  }

  return rules;
}

function escapeSegment(segment: string): string {
  // `*` and `?` are left out of the escape class on purpose — they are wildcards
  // here, and are rewritten immediately after escaping the rest.
  return segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
}

/** A pattern's segments, consecutive `**` read as one, and whether it matches at any depth. */
function patternParts(pattern: string): { segments: string[]; floating: boolean } {
  let source = pattern;

  const anchored = source.startsWith('/');
  if (anchored) source = source.slice(1);
  if (source.endsWith('/')) source = source.slice(0, -1);

  // `**/**` spans what one `**` spans.
  const segments = source.split('/').filter((segment, i, all) => segment !== '**' || all[i - 1] !== '**');
  return { segments, floating: !anchored && !source.includes('/') };
}

/**
 * Translate one gitignore-style CODEOWNERS pattern into a regular expression
 * anchored at the repository root.
 *
 * The rules that matter:
 * - a pattern with no interior `/` matches at any depth (`*.spec.ts`, `tests`);
 * - a leading `/` anchors it to the root;
 * - `**` spans zero or more path segments, `*` never crosses one;
 * - every pattern also owns what sits beneath it, because a bare name in
 *   CODEOWNERS may be a directory and a directory owns its contents.
 */
export function pathPatternToRegExp(pattern: string): RegExp {
  const { segments, floating } = patternParts(pattern);

  let body = '';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const isLast = i === segments.length - 1;

    if (segment === '**') {
      // Zero or more segments, so `a/**/b` still matches `a/b` — which is why
      // this cannot simply become `.*`.
      body += isLast ? '.*' : '(?:[^/]+/)*';
      continue;
    }

    body += escapeSegment(segment);
    if (!isLast) body += '/';
  }

  const prefix = floating ? '(?:.*/)?' : '';
  return new RegExp(`^${prefix}${body}(?:/.*)?$`);
}

/** Whether one path segment matches one pattern segment: `*` any run of characters, `?` one, the rest themselves. */
function segmentMatches(pattern: string, segment: string): boolean {
  // After a mismatch, only the last `*` takes one more character: at most pattern × segment steps.
  let p = 0;
  let s = 0;
  let afterStar = -1;
  let starTook = 0;
  while (s < segment.length) {
    const char = pattern[p];
    if (char === '*') {
      afterStar = ++p;
      starTook = s;
    } else if (char !== undefined && (char === '?' || char === segment[s])) {
      p++;
      s++;
    } else if (afterStar >= 0) {
      p = afterStar;
      s = ++starTook;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

/**
 * The paths {@link pathPatternToRegExp} matches, matched segment by segment
 * without a regular expression: the steps grow with the pattern's segments
 * times the path's, whatever wildcards the pattern holds.
 */
export function pathPatternMatcher(pattern: string): (path: string) => boolean {
  const { segments, floating } = patternParts(pattern);
  if (floating) {
    const only = segments[0]!;
    return (path) => path.split('/').some((part) => segmentMatches(only, part));
  }
  return (path) => {
    const parts = path.split('/');
    // `at[j]`: the pattern's segments read so far match the path up to the `/` before its segment j.
    let at = new Uint8Array(parts.length);
    at[0] = 1;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      const isLast = i === segments.length - 1;
      if (segment === '**') {
        // Last, it takes the rest; before, it skips zero or more non-empty segments.
        if (isLast) return at.includes(1);
        for (let j = 1; j < parts.length; j++) if (at[j - 1] && parts[j - 1] !== '') at[j] = 1;
        continue;
      }
      const next = new Uint8Array(parts.length);
      for (let j = 0; j < parts.length; j++) {
        if (!at[j] || !segmentMatches(segment, parts[j]!)) continue;
        // The last segment owns what sits beneath it.
        if (isLast) return true;
        if (j + 1 < parts.length) next[j + 1] = 1;
      }
      at = next;
    }
    return false;
  };
}

/** Rules with their compiled matchers, so a file list is matched in one pass. */
export interface CompiledCodeowners {
  rules: Array<CodeownersRule & { regex: RegExp }>;
}

export function compileCodeowners(rules: CodeownersRule[]): CompiledCodeowners {
  return { rules: rules.map((rule) => ({ ...rule, regex: pathPatternToRegExp(rule.pattern) })) };
}

/**
 * Owners of one repo-relative path, or an empty array when no rule matches.
 * The last matching rule wins — what every CODEOWNERS implementation does, and
 * what someone writing the file expects.
 */
export function ownersForPath(compiled: CompiledCodeowners, filePath: string): string[] {
  const normalized = filePath.replace(/^\.?\//, '');
  for (let i = compiled.rules.length - 1; i >= 0; i--) {
    const rule = compiled.rules[i]!;
    if (rule.regex.test(normalized)) return rule.owners;
  }
  return [];
}

/**
 * The single owner shown when there is only room for one. CODEOWNERS lists are
 * ordered by convention with the primary owner first.
 */
export function primaryOwnerForPath(compiled: CompiledCodeowners, filePath: string): string | null {
  return ownersForPath(compiled, filePath)[0] ?? null;
}

/** The paths a CODEOWNERS file may live at, in the order hosts check them. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;
