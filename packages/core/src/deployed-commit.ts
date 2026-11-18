/**
 * The commit of a deployed application: what an instrumented server reports as `appCommit` and a deploy marker
 * carries. No import, so plain Node loads it from the dashboard's shared modules.
 */
const DEPLOYED_COMMIT = /^[0-9a-f]{7,40}$/i;

/** A deployed commit as Piwi keeps it: 7 to 40 hexadecimal characters, lower-cased; null for any other value. */
export function deployedCommitOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return DEPLOYED_COMMIT.test(value) ? value.toLowerCase() : null;
}
