import type { Page } from '@playwright/test';

/**
 * One secret from the extension's IndexedDB (`src/shared/secret-store.ts`),
 * read from an extension page. The database is opened at the extension's own
 * version and schema, so a spec that opens it first leaves it as the extension
 * expects.
 */
export function storedSecret(page: Page, name: 'instance' | 'desktop' | 'editor' | 'hubs'): Promise<unknown> {
  return page.evaluate(
    (name) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('piwi-secrets', 1);
        open.onupgradeneeded = () => {
          if (!open.result.objectStoreNames.contains('secrets')) open.result.createObjectStore('secrets');
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction('secrets').objectStore('secrets').get(name);
          get.onsuccess = () => {
            db.close();
            resolve(get.result ?? null);
          };
          get.onerror = () => {
            db.close();
            reject(get.error);
          };
        };
      }),
    name,
  );
}

/** Everything in `chrome.storage.local`, which a content script reads as freely as an extension page. */
export function localStorageText(page: Page): Promise<string> {
  return page.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
}
