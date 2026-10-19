import * as path from 'node:path';

/**
 * The folder a run's test files are named relative to: the Playwright
 * config's, else its `rootDir`, else the working directory. Run from any
 * directory, a test keeps one name, as the dashboard's blob import names it.
 */
export function configDirFromConfig(config: { configFile?: string; rootDir?: string } | null | undefined): string {
  if (config?.configFile) return path.dirname(config.configFile);
  if (config?.rootDir) return config.rootDir;
  return process.cwd();
}

/** `file` relative to `base`, with POSIX separators: the `filePath` the dashboard stores. */
export function relativeTestPath(file: string, base: string): string {
  return path.relative(base, file).split(path.sep).join('/');
}
