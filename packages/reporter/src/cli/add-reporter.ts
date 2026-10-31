/**
 * `--add-reporter` support for `piwi run`: when the target Playwright config has
 * no Piwi reporter, `run` appends `--add-reporter @piwitests/reporter` so results
 * still reach the dashboard without editing the config, provided the installed
 * Playwright is 1.63 or later (the version whose CLI added the flag — it appends
 * to the configured reporters rather than replacing them like `--reporter`).
 *
 * This trades away the wrapped-config defaults: no capture fixtures and none of
 * `wrapConfig`'s failure-evidence capture defaults. It is the no-edit trial path,
 * not a substitute for wiring the reporter into the config.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { detectProject } from './detect.js';
import { playwrightVersionAtLeast } from '../internal/support/playwright-version.js';

export const REPORTER_PACKAGE = '@piwitests/reporter';
export const ADD_REPORTER_FLAG = '--add-reporter';

/** Whether the installed Playwright version accepts `--add-reporter` (1.63 and later). */
export function playwrightSupportsAddReporter(version: string | null | undefined): boolean {
  return playwrightVersionAtLeast(version, '1.63');
}

/** Whether a config's source already wires in the Piwi reporter (import or entry). */
export function configHasPiwiReporter(source: string): boolean {
  return new RegExp(REPORTER_PACKAGE.replace(/[/\\]/g, '\\$&')).test(source);
}

export interface AddReporterDecision {
  /** Extra Playwright CLI args to prepend — empty when nothing is added. */
  args: string[];
  /** One line to log, or null when there is nothing worth saying. */
  log: string | null;
}

/**
 * Decide whether to append `--add-reporter`, from the config's source (null when
 * no config was found) and the installed Playwright version. Adds the flag only
 * when a config exists, does not already wire in the reporter, and the installed
 * Playwright is new enough; on an older Playwright it logs that the reporter is
 * not configured and adds nothing.
 */
export function decideAddReporter(configSource: string | null, playwrightVersion: string | null): AddReporterDecision {
  if (configSource === null || configHasPiwiReporter(configSource)) return { args: [], log: null };
  if (playwrightSupportsAddReporter(playwrightVersion)) {
    return {
      args: [ADD_REPORTER_FLAG, REPORTER_PACKAGE],
      log: `piwi run: the Playwright config has no Piwi reporter — appending ${ADD_REPORTER_FLAG} ${REPORTER_PACKAGE}`,
    };
  }
  return {
    args: [],
    log: `piwi run: the Playwright config has no Piwi reporter and Playwright ${playwrightVersion ?? 'unknown'} predates ${ADD_REPORTER_FLAG} (1.63) — results will not reach the dashboard`,
  };
}

/** Resolve the Playwright config the run will use, honoring `--config` / `-c`. */
function resolveConfigPath(cwd: string, playwrightArgs: string[]): string | null {
  for (let i = 0; i < playwrightArgs.length; i++) {
    const arg = playwrightArgs[i]!;
    if (arg === '--config' || arg === '-c') {
      const next = playwrightArgs[i + 1];
      if (next) return path.resolve(cwd, next);
    } else if (arg.startsWith('--config=')) {
      return path.resolve(cwd, arg.slice('--config='.length));
    }
  }
  return detectProject(cwd).configPath;
}

function readConfigSource(configPath: string | null): string | null {
  if (!configPath) return null;
  try {
    return fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
}

/** Read the Playwright version installed in the target project, or null. */
function readInstalledPlaywrightVersion(cwd: string): string | null {
  try {
    const require = createRequire(path.join(cwd, 'noop.js'));
    for (const id of ['@playwright/test/package.json', 'playwright/package.json']) {
      try {
        return (require(id) as { version?: string }).version ?? null;
      } catch {
        // Try the next candidate.
      }
    }
  } catch {
    // No resolvable Playwright — treat as unknown.
  }
  return null;
}

/**
 * Compute the `--add-reporter` arguments and log line for a `run` about to spawn
 * Playwright in `cwd` with `playwrightArgs`.
 */
export function computeAddReporterArgs(cwd: string, playwrightArgs: string[]): AddReporterDecision {
  const source = readConfigSource(resolveConfigPath(cwd, playwrightArgs));
  return decideAddReporter(source, readInstalledPlaywrightVersion(cwd));
}
