import { getActiveProjectOverride, resolveActiveProject } from '../shared/active-project.js';
import { isCatalogStale, setCachedCatalog } from '../shared/catalog-cache.js';
import type { RefreshCatalogResult } from '../shared/catalog-refresh.js';
import { withConnectionHealth } from '../shared/connection-health.js';
import { getConnectionSettings, type ConnectionSettings } from '../shared/connection-settings.js';
import { t } from '../shared/i18n.js';
import { isLocatorIndexStale, setCachedLocatorIndex } from '../shared/locator-index-cache.js';
import type { LocatorIndexRefreshResult } from '../shared/locator-index-refresh.js';
import { fetchCatalog, fetchLocatorIndex } from '../shared/piwi-client.js';
import { fromExtensionPage } from './senders.js';

/**
 * Re-fetches a project's function catalog or locator index for the panels
 * that show them. This lives in the background worker for the same reason as
 * `piwi-client.ts`: the API key must never be reachable from a web page's JS
 * context. Content scripts ask over `chrome.runtime.sendMessage`
 * (`catalog-refresh.ts`, `locator-index-refresh.ts`) and read the cache the
 * worker writes, so a function added in the dashboard reaches the extension
 * without saving the options page again. Each request's outcome is recorded
 * for the popup and the settings (`connection-health.ts`).
 */

/**
 * The project a refresh fetches: the one asked for, from an extension page
 * (the DevTools panel resolves the inspected tab's project itself); from a
 * content script, only the project its tab's address maps to.
 */
async function projectToRefresh(
  projectId: number,
  sender: chrome.runtime.MessageSender,
  settings: ConnectionSettings,
): Promise<number | null> {
  if (fromExtensionPage(sender)) return projectId;
  const url = sender.tab?.url ?? '';
  const project = resolveActiveProject(settings, await getActiveProjectOverride(url), url);
  return project?.projectId === projectId ? projectId : null;
}

function isProjectId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** One project's function catalog into the cache, unless the cached one is fresh and `force` is not set. */
export async function handleRefreshCatalog(
  message: { projectId?: unknown; force?: unknown },
  sender: chrome.runtime.MessageSender,
): Promise<RefreshCatalogResult> {
  if (!isProjectId(message.projectId)) return { ok: false, error: t('common_noProject') };
  const settings = await getConnectionSettings();
  if (!settings.instanceUrl.trim()) return { ok: false, error: t('common_notConnected') };
  const projectId = await projectToRefresh(message.projectId, sender, settings);
  if (projectId == null) return { ok: false, error: t('common_noProject') };

  if (message.force !== true && !(await isCatalogStale(projectId))) return { ok: true, refreshed: false, count: null };

  try {
    const entries = await withConnectionHealth(settings.instanceUrl, () => fetchCatalog(settings, projectId));
    await setCachedCatalog(projectId, entries);
    return { ok: true, refreshed: true, count: entries.length };
  } catch (err) {
    // The caller already rendered whatever was cached, so a failed refresh
    // degrades to "showing older data" rather than showing nothing.
    return { ok: false, error: err instanceof Error ? err.message : t('common_catalogRefreshFailed') };
  }
}

/**
 * One project's locator index for the coverage overlay. Answers with the index
 * itself when it re-fetched, because a large index may not fit the storage
 * cache.
 */
export async function handleRefreshLocatorIndex(
  message: { projectId?: unknown; force?: unknown; branch?: unknown },
  sender: chrome.runtime.MessageSender,
): Promise<LocatorIndexRefreshResult> {
  if (!isProjectId(message.projectId)) return { ok: false, error: t('common_noProject') };
  const branch = typeof message.branch === 'string' && message.branch.trim() ? message.branch.trim() : null;
  const settings = await getConnectionSettings();
  if (!settings.instanceUrl.trim()) return { ok: false, error: t('common_notConnected') };
  const projectId = await projectToRefresh(message.projectId, sender, settings);
  if (projectId == null) return { ok: false, error: t('common_noProject') };
  if (message.force !== true && !(await isLocatorIndexStale(projectId, branch))) {
    return { ok: true, refreshed: false, index: null };
  }
  try {
    const index = await withConnectionHealth(settings.instanceUrl, () =>
      fetchLocatorIndex(settings, projectId, branch),
    );
    await setCachedLocatorIndex(projectId, index, branch);
    return { ok: true, refreshed: true, index };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : t('common_locatorIndexFailed') };
  }
}
