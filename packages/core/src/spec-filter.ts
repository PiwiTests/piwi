/**
 * Spec paths as Playwright's command line reads them: each file argument (`tests/checkout.spec.ts:42`) is matched as a
 * regular expression against the spec's path.
 */

/**
 * A spec path as Playwright's file filter reads it, in POSIX form and with no backslash a shell would expand: each
 * character a regular expression gives a meaning to stands in a class of its own (`tests/[[]slug].spec.ts`), so a
 * route-style name (`[id]`, `(group)`) or `c++.spec.ts` names its own file.
 */
export function specPattern(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/[[(){}*+?|]/g, '[$&]');
}
