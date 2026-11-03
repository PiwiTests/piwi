/**
 * Glob matching whose steps grow with the pattern's length times the text's at
 * worst, whatever wildcards the pattern holds: the text is read once, keeping
 * the set of pattern positions reached so far. A pattern someone saves (a
 * branch filter, a path glob, a URL pattern) is matched with it, never turned
 * into a regular expression. It matches what the regular expression the
 * pattern stands for matches, with no `u` flag: `.` for a wildcard that takes a
 * `/`, `[^/]` for one that does not, and the `i` flag for `ignoreCase`.
 */

/**
 * One step of a glob: a literal character (one UTF-16 code unit), one
 * character, or a run of any number of characters, none included. With
 * `slash`, `one` and `run` take what a regular expression's `.` takes: any
 * character but a line terminator (`\n`, `\r`, U+2028, U+2029). Without it,
 * what `[^/]` takes: any character but `/`.
 */
export type GlobToken = { kind: 'char'; char: string } | { kind: 'one' | 'run'; slash: boolean };

/** How a pattern's wildcards read. Every other character matches itself. */
export interface GlobSyntax {
  /**
   * `*` matches within one path segment (any character but `/`) and `**`
   * across them. Without it, `*` matches any run of characters, `/` included.
   * A wildcard that takes a `/` takes no line terminator.
   */
  segments?: boolean;
  /** `?` matches one character (never a `/` with `segments`). Without it, `?` matches itself. */
  questionMark?: boolean;
  /** Letters match in either case, as a regular expression's `i` flag without `u` compares them. */
  ignoreCase?: boolean;
}

/** Whether a regular expression's `.` takes the character: any but a line terminator. */
function dotTakes(char: string): boolean {
  return char !== '\n' && char !== '\r' && char !== '\u2028' && char !== '\u2029';
}

/**
 * The character a regular expression with the `i` flag and no `u` flag
 * compares: its upper case when that is one code unit, unless it would turn a
 * character outside ASCII into one inside.
 */
function canonicalize(char: string): string {
  const upper = char.toUpperCase();
  if (upper.length !== 1) return char;
  return char.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128 ? char : upper;
}

/** A pattern's tokens, read left to right: with `segments`, `**` is one token. */
function globTokens(pattern: string, syntax: GlobSyntax): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*') {
      const globstar = !!syntax.segments && pattern[i + 1] === '*';
      if (globstar) i++;
      tokens.push({ kind: 'run', slash: !syntax.segments || globstar });
    } else if (char === '?' && syntax.questionMark) {
      tokens.push({ kind: 'one', slash: !syntax.segments });
    } else {
      tokens.push({ kind: 'char', char });
    }
  }
  return tokens;
}

/**
 * Whether the whole text matches `tokens`, compiled once. Anchored at both
 * ends, as a pattern names the whole value.
 */
export function compileGlob(tokens: readonly GlobToken[], ignoreCase = false): (text: string) => boolean {
  const steps = ignoreCase
    ? tokens.map((token) => (token.kind === 'char' ? { ...token, char: canonicalize(token.char) } : token))
    : tokens;
  const end = steps.length;
  return (text) => {
    // `seen[state] === step` once `state` (the number of tokens matched) is reached after `step` characters.
    const seen = new Int32Array(end + 1).fill(-1);
    let current: number[] = [];
    let next: number[] = [];
    const reach = (list: number[], from: number, step: number) => {
      // A run may take no character: reaching it reaches the token after it too.
      for (let state = from; seen[state] !== step; state++) {
        seen[state] = step;
        list.push(state);
        if (state === end || steps[state]!.kind !== 'run') break;
      }
    };
    reach(current, 0, 0);
    for (let i = 0; i < text.length; i++) {
      const char = ignoreCase ? canonicalize(text[i]!) : text[i]!;
      const dot = dotTakes(char);
      for (const state of current) {
        if (state === end) continue;
        const token = steps[state]!;
        const takes = token.kind === 'char' ? token.char === char : token.slash ? dot : char !== '/';
        if (takes) reach(next, token.kind === 'run' ? state : state + 1, i + 1);
      }
      if (next.length === 0) return false;
      [current, next] = [next, current];
      next.length = 0;
    }
    return seen[end] === text.length;
  };
}

/** Whether the whole text matches `pattern`, read with `syntax`; compiled once, for any number of texts. */
export function globMatcher(pattern: string, syntax: GlobSyntax = {}): (text: string) => boolean {
  return compileGlob(globTokens(pattern, syntax), syntax.ignoreCase);
}
