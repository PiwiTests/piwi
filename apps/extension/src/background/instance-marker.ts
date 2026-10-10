import { CONNECTION_KEY, getConnectionSettings } from '../shared/connection-settings.js';
import { hostPattern, webOrigin } from '../shared/web-origin.js';

/**
 * Keeps `instance-marker.js` registered on the connected instance's pages, and
 * only there: the instance's origin while the extension is connected to it and
 * holds its grant, nothing otherwise. The grant is the one connecting already
 * asked for; no other permission is involved. Synced as the worker starts, when
 * the connection settings change and when a grant is added or removed, so
 * Disconnect, another instance or a grant taken back in the browser's settings
 * each leave the registration matching.
 */

const MARKER_SCRIPT_ID = 'piwi-instance-marker';

/** The pattern the marker belongs on: the instance origin's, while the grant for it is held; null otherwise. */
async function wantedPattern(): Promise<string | null> {
  const origin = webOrigin((await getConnectionSettings()).instanceUrl.trim());
  if (!origin) return null;
  const pattern = hostPattern(origin);
  return (await chrome.permissions.contains({ origins: [pattern] })) ? pattern : null;
}

async function sync(): Promise<void> {
  const wanted = await wantedPattern();
  const [current] = await chrome.scripting.getRegisteredContentScripts({ ids: [MARKER_SCRIPT_ID] });
  if ((current?.matches?.[0] ?? null) === wanted) return;
  if (current) await chrome.scripting.unregisterContentScripts({ ids: [MARKER_SCRIPT_ID] });
  if (!wanted) return;
  await chrome.scripting.registerContentScripts([
    { id: MARKER_SCRIPT_ID, js: ['instance-marker.js'], matches: [wanted], runAt: 'document_end' },
  ]);
  // The registration applies to pages loaded from now on: the instance's pages already open are marked here.
  const tabs = await chrome.tabs.query({ url: wanted });
  await Promise.all(
    tabs.map((tab) =>
      tab.id === undefined
        ? undefined
        : chrome.scripting
            .executeScript({ target: { tabId: tab.id }, files: ['instance-marker.js'] })
            .catch(() => undefined),
    ),
  );
}

/** One sync at a time, in the order asked: a Disconnect's never runs before the Connect it follows. */
let syncing: Promise<void> = Promise.resolve();

export function syncInstanceMarker(): Promise<void> {
  syncing = syncing.then(sync).catch((err: unknown) => console.warn('[Piwi Picker] instance marker:', err));
  return syncing;
}

/** Whether a `chrome.storage.onChanged` change touches the connection settings. */
export function connectionChanged(changes: Record<string, chrome.storage.StorageChange>, area: string): boolean {
  return area === 'local' && CONNECTION_KEY in changes;
}
