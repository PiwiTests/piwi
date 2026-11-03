/**
 * Glob matching whose steps grow with the pattern's length times the text's at
 * worst, whatever wildcards the pattern holds: the text is read once, keeping
 * the set of pattern positions reached so far. A pattern someone saves (a
 * branch filter, a path glob, a URL pattern) is matched with it, never turned
 * into a regular expression.
 */

/**
 * One step of a glob: a literal character (one UTF-16 code unit), one
 * character, or a run of any number of characters, none included. `slash`
 * says whether `one` and `run` take a `/`.
 */
export type GlobToken = { kind: 'char'; char: string } | { kind: 'one' | 'run'; slash: boolean };

/** How a pattern's wildcards read. Every other character matches itself. */
export interface GlobSyntax {
  /**
   * `*` matches within one path segment (never a `/`) and `**` across them.
   * Without it, `*` matches any run of characters, `/` included.
   */
  segments?: boolean;
  /** `?` matches one character (never a `/` with `segments`). Without it, `?` matches itself. */
  questionMark?: boolean;
  /** Letters match in either case. */
  ignoreCase?: boolean;
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
    ? tokens.map((token) => (token.kind === 'char' ? { ...token, char: token.char.toLowerCase() } : token))
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
      const char = ignoreCase ? text[i]!.toLowerCase() : text[i]!;
      for (const state of current) {
        if (state === end) continue;
        const token = steps[state]!;
        const takes = token.kind === 'char' ? token.char === char : token.slash || char !== '/';
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
