import { readdir, readFile } from 'fs/promises';
import { join, posix, relative, sep } from 'path';
import type { StorageAdapter } from '../storage/types';

/** How many files a directory upload reads and writes at once. */
const UPLOAD_CONCURRENCY = 8;

/** Run `task` over `items`, at most `limit` at a time. */
export async function forEachLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Upload a directory tree to storage, a few files at a time.
 * @param localDir - Local directory path to upload
 * @param storagePrefix - Prefix path in storage
 * @param storage - Storage adapter
 * @returns Total size of uploaded files
 */
export async function uploadDirectory(
  localDir: string,
  storagePrefix: string,
  storage: StorageAdapter,
): Promise<number> {
  const entries = await readdir(localDir, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

  let total = 0;
  await forEachLimited(files, UPLOAD_CONCURRENCY, async (localPath) => {
    const content = await readFile(localPath);
    await storage.writeFile(posix.join(storagePrefix, ...relative(localDir, localPath).split(sep)), content);
    total += content.length;
  });
  return total;
}
