import * as path from 'node:path';
import { createRequire } from 'node:module';

/** The package name a Playwright config names Piwi's reporter by. */
export const PIWI_REPORTER_MODULE = '@piwitests/reporter';

/**
 * This copy's own entry file. The reporter and the global setup module are bundled side by side at the package's
 * `dist/` root, so it sits next to either of them.
 */
const OWN_ENTRY = path.resolve(__dirname, 'index.js');

/**
 * The file a module resolves to from `dir`, as Playwright resolves a reporter's; null when it resolves to none. It is
 * resolved for a module in `dir`, never for this package, which a package name resolves to itself from.
 */
function resolveFrom(id: string, dir: string): string | null {
  try {
    return createRequire(path.join(dir, 'noop.js')).resolve(id);
  } catch {
    return null;
  }
}

/**
 * Whether a reporter entry's module is Piwi's reporter: its package name, or a path to the file that name resolves to
 * from `dir` (the config's folder), or to this copy's own entry. Playwright hands the global setup each reporter as the
 * path it resolved. Any other reporter is not Piwi's, whatever its path or name holds.
 */
export function isPiwiReporterModule(id: string, dir: string): boolean {
  if (id === PIWI_REPORTER_MODULE) return true;
  const file = resolveFrom(id, dir);
  if (!file) return false;
  return file === OWN_ENTRY || file === resolveFrom(PIWI_REPORTER_MODULE, dir);
}
