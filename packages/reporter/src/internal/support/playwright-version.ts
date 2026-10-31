/**
 * Whether Playwright `version` (`1.62.0`: its package's, or `testInfo.config.version`) is `minimum` (`1.62`) or later,
 * by major and minor; false for a version it cannot read.
 */
export function playwrightVersionAtLeast(version: string | null | undefined, minimum: string): boolean {
  const have = version ? /^(\d+)\.(\d+)/.exec(version) : null;
  const want = /^(\d+)\.(\d+)/.exec(minimum);
  if (!have || !want) return false;
  const major = Number(have[1]);
  const wantMajor = Number(want[1]);
  return major > wantMajor || (major === wantMajor && Number(have[2]) >= Number(want[2]));
}
