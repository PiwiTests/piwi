import * as fs from 'node:fs';
import * as path from 'node:path';

/** The folder of the nearest `package.json` at or above `dir`, or null when there is none. */
function packageJsonFolder(dir: string): string | null {
  for (let current = dir; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    if (path.dirname(current) === current) return null;
  }
}

/**
 * The folder Playwright's html reporter writes the run's report to, found as that reporter finds it:
 * `PLAYWRIGHT_HTML_OUTPUT_DIR` (or the older `PLAYWRIGHT_HTML_REPORT`) from the working directory, else its
 * `outputFolder` option from the config's folder, else `playwright-report` beside the nearest `package.json` at or
 * above the config's folder (the working directory when there is none). Null when the run has no html reporter: none
 * among the config's reporters, nor `PW_TEST_REPORTER`.
 */
export function htmlReportFolder(
  reporters: unknown,
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const entry = Array.isArray(reporters)
    ? (reporters as unknown[]).find((r): r is [string, unknown?] => Array.isArray(r) && r[0] === 'html')
    : undefined;
  if (!entry && env.PW_TEST_REPORTER !== 'html') return null;
  const fromEnv = env.PLAYWRIGHT_HTML_OUTPUT_DIR || env.PLAYWRIGHT_HTML_REPORT;
  if (fromEnv) return path.resolve(fromEnv);
  const outputFolder = (entry?.[1] as { outputFolder?: unknown } | undefined)?.outputFolder;
  if (typeof outputFolder === 'string' && outputFolder) return path.resolve(configDir, outputFolder);
  return path.resolve(packageJsonFolder(configDir) ?? process.cwd(), 'playwright-report');
}
