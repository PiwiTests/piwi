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
  let source = pattern;

  const anchored = source.startsWith('/');
  if (anchored) source = source.slice(1);
  if (source.endsWith('/')) source = source.slice(0, -1);

  const floating = !anchored && !source.includes('/');

  const segments = source.split('/');
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
