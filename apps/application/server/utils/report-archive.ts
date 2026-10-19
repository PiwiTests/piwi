import { and, eq } from 'drizzle-orm';
import { files, testRuns } from '../database/schema';
import type { DbClient } from '../database';
import { readArchiveEntry } from './compression';

/** What the cached `index.html` files may hold together; the one read last is always kept. */
const CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

/** How many archives the cache tracks, read or still being read. */
const CACHE_MAX_ENTRIES = 32;

interface CachedIndex {
  html: Promise<Buffer | null>;
  bytes: number;
}

const cache = new Map<string, CachedIndex>();
let cachedBytes = 0;

/** Whether `path` is a report archive uploaded for a run of the project, the only `.gz` served from inside. */
async function isReportArchive(db: DbClient, projectId: number, path: string): Promise<boolean> {
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .innerJoin(testRuns, eq(files.testRunId, testRuns.id))
    .where(and(eq(testRuns.projectId, projectId), eq(files.type, 'report'), eq(files.path, path)))
    .limit(1);
  return rows.length > 0;
}

function forget(path: string): void {
  const entry = cache.get(path);
  if (!entry) return;
  cache.delete(path);
  cachedBytes -= entry.bytes;
}

/** Drop the oldest archives until the cache is within its budget, keeping `keep`. */
function trimCache(keep: string): void {
  for (const path of [...cache.keys()]) {
    if (cachedBytes <= CACHE_BUDGET_BYTES && cache.size <= CACHE_MAX_ENTRIES) break;
    if (path !== keep) forget(path);
  }
}

/**
 * The `index.html` inside the stored report archive at `path`, or null when the
 * path is not a report archive of the project or holds no `index.html`. The
 * archive is read as a stream within the limits of `readArchiveEntry`, once for
 * every request that asks while it is read, and the answer is kept: a stored
 * path's bytes never change.
 */
export function readReportArchiveIndex(
  db: DbClient,
  projectId: number,
  path: string,
  readArchive: () => Promise<Buffer>,
): Promise<Buffer | null> {
  const cached = cache.get(path);
  if (cached) {
    // Most recently read last, so the trim drops the archives read least recently.
    cache.delete(path);
    cache.set(path, cached);
    return cached.html;
  }

  const entry: CachedIndex = { html: Promise.resolve(null), bytes: 0 };
  const read = (async () => {
    // A path that is not a report archive is not kept: its file may be one by the next request.
    if (!(await isReportArchive(db, projectId, path))) return { html: null, keep: false };
    try {
      return { html: await readArchiveEntry(await readArchive(), 'index.html'), keep: true };
    } catch {
      // An archive over the limits or unreadable: kept as such, so it is not inflated again.
      return { html: null, keep: true };
    }
  })();
  entry.html = read.then((result) => result.html);
  cache.set(path, entry);
  trimCache(path);
  read.then(
    ({ html, keep }) => {
      if (cache.get(path) !== entry) return;
      if (!keep) {
        forget(path);
        return;
      }
      entry.bytes = html?.length ?? 0;
      cachedBytes += entry.bytes;
      trimCache(path);
    },
    () => forget(path),
  );
  return entry.html;
}

/** Empty the cache; for tests. */
export function clearReportArchiveCache(): void {
  cache.clear();
  cachedBytes = 0;
}
