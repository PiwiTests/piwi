import type { ViewportBox } from '@piwitests/core/recording';

/**
 * The screenshots of the page as each step of a recording began, and the
 * ones a replay shows for a step it hands to the person, in the background
 * worker's IndexedDB: a recording can take a hundred, more than session
 * storage holds. Only the worker opens it, since a content script's IndexedDB
 * is the page's own; content scripts ask the worker by message.
 */

const DB_NAME = 'piwi-step-views';
const DB_VERSION = 1;
/** A recording's views, by the id the recorder gave each. */
const RECORDING = 'recording';
/** The views of the replay running now, by step. */
const REPLAY = 'replay';

export interface StoredStepView {
  id: string;
  /** A `data:image/jpeg;base64,…` URL. */
  dataUrl: string;
  /** When the screenshot was taken: of two kept under one id, the later one stays. */
  takenAt: number;
  /** The viewport the screenshot shows, in CSS pixels. */
  viewport: { width: number; height: number } | null;
}

/** The page as a replayed step began, and where its element was. */
export interface ReplayStepView {
  step: number;
  dataUrl: string;
  box: ViewportBox | null;
  viewport: { width: number; height: number } | null;
}

let opened: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDING)) db.createObjectStore(RECORDING, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(REPLAY)) db.createObjectStore(REPLAY, { keyPath: 'step' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opened = null;
      reject(request.error ?? new Error('IndexedDB'));
    };
  });
  return opened;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
  });
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB'));
  });
}

async function store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await open()).transaction(name, mode).objectStore(name);
}

/** Keeps the view, unless the one kept under its id was taken later. */
export async function putRecordingView(view: StoredStepView): Promise<void> {
  const transaction = (await open()).transaction(RECORDING, 'readwrite');
  const recording = transaction.objectStore(RECORDING);
  const kept = recording.get(view.id);
  kept.onsuccess = () => {
    const earlier = kept.result as StoredStepView | undefined;
    if (!earlier || earlier.takenAt <= view.takenAt) recording.put(view);
  };
  await completed(transaction);
}

export async function deleteRecordingView(id: string): Promise<void> {
  await done((await store(RECORDING, 'readwrite')).delete(id));
}

export async function countRecordingViews(): Promise<number> {
  return done((await store(RECORDING, 'readonly')).count());
}

/** The views with these ids, in their order; a view not kept is left out. */
export async function getRecordingViews(ids: string[]): Promise<StoredStepView[]> {
  const views = await Promise.all(
    ids.map(async (id) => (await done((await store(RECORDING, 'readonly')).get(id))) as StoredStepView | undefined),
  );
  return views.filter((view): view is StoredStepView => !!view);
}

export async function clearRecordingViews(): Promise<void> {
  await done((await store(RECORDING, 'readwrite')).clear());
}

/** Keeps the views of the replay starting now, in place of any earlier replay's, in one transaction. */
export async function setReplayViews(views: ReplayStepView[]): Promise<void> {
  const transaction = (await open()).transaction(REPLAY, 'readwrite');
  const replay = transaction.objectStore(REPLAY);
  replay.clear();
  for (const view of views) replay.put(view);
  await completed(transaction);
}

export async function getReplayView(step: number): Promise<ReplayStepView | null> {
  return ((await done((await store(REPLAY, 'readonly')).get(step))) as ReplayStepView | undefined) ?? null;
}
