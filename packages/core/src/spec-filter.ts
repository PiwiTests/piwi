/**
 * Spec paths as Playwright's command line reads them: each file argument (`tests/checkout.spec.ts:42`) is matched as a
 * regular expression against the spec's path.
 */

/**
 * A spec path as Playwright's file filter reads it, in POSIX form and with nothing a shell expands inside double
 * quotes: a character a regular expression gives a meaning to stands in a class of its own (`tests/[[]slug].spec.ts`),
 * and an anchor (`^`, `$`) or a character a shell expands (`` ` ``, `"`, `%`, `!`) stands as `.`, so a route-style name
 * (`[id]`, `(group)`, `posts.$postId`) or `c++.spec.ts` names its own file.
 */
export function specPattern(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/[[(){}*+?|]/g, '[$&]')
    .replace(/[$^`"%!\u201C\u201D\u201E]/g, '.');
}
