/**
 * `resolveSelection()` — resolve the selection named in `PIWI_SELECTION` from a
 * Playwright config, for people who prefer `PIWI_SELECTION=smoke playwright test`
 * over `piwi run smoke`.
 *
 * `wrapConfig` is synchronous and runs before any Piwi setup, so a config cannot
 * await a server round-trip there. This helper is the explicit alternative for
 * ESM configs (top-level await is fine): it fetches the resolution, stamps the
 * environment so the reporter records the selection, and returns a grep the
 * config can apply. It never throws unless `strict` is set — a config-load
 * failure falls back to the full suite rather than breaking the run.
 */
import { PIWI_ENV_KEYS, PIWI_SELECTION_ENV } from '../internal/config/env.js';
import { resolveCliConnection } from '../internal/support/connection.js';
import { fetchResolution, resolveProjectId } from '../internal/support/selection-client.js';

export interface ResolveSelectionResult {
  key: string;
  version: number;
  resolvedHash: string;
  resolvedCount: number;
  /** A `--grep` regex that selects the resolved tests, when the grep format was produced. */
  grep?: string;
  /** File (or `file:line`) tokens, when grep fell back to a file materialization. */
  files?: string[];
}

export interface ResolveSelectionOptions {
  /** Selection key; defaults to the `PIWI_SELECTION` env var. */
  key?: string;
  serverUrl?: string;
  apiKey?: string | null;
  /** Project name or id; defaults to `PIWI_PROJECT_NAME`. */
  project?: string;
  budgetMs?: number | null;
  /** Throw instead of falling back to the full suite when resolution fails. */
  strict?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the configured selection. Returns `undefined` when no selection is
 * named or (in non-strict mode) when the dashboard cannot be reached, so the
 * config runs the full suite. On success it also writes `PIWI_SELECTION_*` so
 * the reporter stamps the run with the resolved selection.
 */
export async function resolveSelection(
  options: ResolveSelectionOptions = {},
): Promise<ResolveSelectionResult | undefined> {
  const env = options.env ?? process.env;
  const key = options.key ?? env[PIWI_SELECTION_ENV.key];
  if (!key) return undefined;

  const serverUrl = (options.serverUrl ?? env[PIWI_ENV_KEYS.serverUrl] ?? '').replace(/\/$/, '');
  const apiKey = options.apiKey ?? env[PIWI_ENV_KEYS.apiKey] ?? null;
  const project = options.project ?? env[PIWI_ENV_KEYS.projectName] ?? '';

  if (!serverUrl) {
    if (options.strict) throw new Error('resolveSelection: no dashboard URL (set PIWI_DASHBOARD_URL)');
    return undefined;
  }

  // The desktop app's key, from its discovery file or the run it started, goes only to a server that proves it.
  const keyIsFromEnv = apiKey === env[PIWI_ENV_KEYS.apiKey];
  resolveCliConnection(
    { serverUrl },
    {
      ...env,
      [PIWI_ENV_KEYS.apiKey]: apiKey ?? undefined,
      [PIWI_ENV_KEYS.desktopKey]: keyIsFromEnv ? env[PIWI_ENV_KEYS.desktopKey] : undefined,
    },
    [],
    'resolveSelection',
  );

  const clientOptions = { serverUrl, apiKey, project, key, format: 'grep', budgetMs: options.budgetMs ?? null };

  try {
    const projectId = await resolveProjectId(clientOptions);
    const resolution = await fetchResolution(clientOptions, projectId);
    if (resolution.estimate.count === 0) {
      if (options.strict) throw new Error(`resolveSelection: "${key}" resolved to 0 tests`);
      console.warn(`[Piwi Dashboard] selection "${key}" resolved to 0 tests — running the full suite`);
      return undefined;
    }

    env[PIWI_SELECTION_ENV.key] = resolution.key ?? key;
    env[PIWI_SELECTION_ENV.version] = String(resolution.version ?? 0);
    env[PIWI_SELECTION_ENV.hash] = resolution.resolvedHash;
    env[PIWI_SELECTION_ENV.count] = String(resolution.estimate.count);

    const args = resolution.materialization.args;
    const result: ResolveSelectionResult = {
      key: resolution.key ?? key,
      version: resolution.version ?? 0,
      resolvedHash: resolution.resolvedHash,
      resolvedCount: resolution.estimate.count,
    };
    if (args[0] === '--grep') result.grep = args[1];
    else result.files = args;
    return result;
  } catch (e) {
    if (options.strict) throw e;
    console.warn(
      `[Piwi Dashboard] selection "${key}" could not be resolved — running the full suite (${(e as Error).message})`,
    );
    return undefined;
  }
}
