/**
 * The secrets of connected mode, in the extension origin's IndexedDB: the
 * instance's API key with the origin it was given for, the tokens of the
 * paired desktop app and editor, and the addresses and tokens of the editor's
 * run hubs (`background/run-hubs.ts`). A content script cannot open this database,
 * since its IndexedDB is the page's, so only the background worker and the
 * extension's own pages read them; `chrome.storage.local`, which content
 * scripts read and write, keeps the settings that are not secret.
 */

export type SecretName = 'instance' | 'desktop' | 'editor' | 'hubs';

/** Where the secrets are kept: the extension's IndexedDB, or what a unit test hands over instead. */
export interface SecretArea {
  get(name: SecretName): Promise<unknown>;
  set(name: SecretName, value: unknown): Promise<void>;
  remove(name: SecretName): Promise<void>;
}

const DB_NAME = 'piwi-secrets';
const DB_VERSION = 1;
const STORE = 'secrets';

let opened: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opened = null;
      reject(request.error ?? new Error('IndexedDB'));
    };
  });
  return opened;
}

/** Runs one request in its own transaction and resolves once the transaction has committed. */
async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const transaction = (await open()).transaction(STORE, mode);
  const request = work(transaction.objectStore(STORE));
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB'));
  });
  return request.result;
}

const indexedDbArea: SecretArea = {
  get: (name) => run('readonly', (store) => store.get(name)),
  set: async (name, value) => {
    await run('readwrite', (store) => store.put(value, name));
  },
  remove: async (name) => {
    await run('readwrite', (store) => store.delete(name));
  },
};

/** True in the background worker and the extension's own pages: the contexts whose IndexedDB is the extension's. */
export function isExtensionContext(): boolean {
  try {
    return globalThis.location?.origin === new URL(chrome.runtime.getURL('/')).origin;
  } catch {
    return false;
  }
}

/** The extension's secret area. Throws in a content script, whose IndexedDB belongs to the page. */
export function secretArea(): SecretArea {
  if (!isExtensionContext()) throw new Error('Secrets are kept in the extension only');
  return indexedDbArea;
}

/**
 * Moves a secret an older version kept in `chrome.storage.local` into the
 * area: written there first and only then removed from the local copy by
 * `strip`, so a move cut short leaves it in both places and the next one
 * finishes it. A secret the area already holds is kept, and the local copy is
 * only removed.
 */
export async function moveLegacySecret(
  area: SecretArea,
  name: SecretName,
  legacy: unknown,
  strip: () => Promise<void>,
): Promise<void> {
  if (legacy != null && (await area.get(name)) == null) await area.set(name, legacy);
  await strip();
}
