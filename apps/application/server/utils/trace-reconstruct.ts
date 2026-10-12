import { getStorage } from '../storage';
import { parseZip, buildZip } from './trace-zip';
import type { ZipEntry } from './trace-zip';
import { decodeResource } from './resource-compression';
import {
  parseTraceManifest,
  traceManifestPath,
  traceManifestPoolNames,
  traceProjectPrefix,
  type TraceBlobManifest,
} from './trace-manifest';

type Storage = ReturnType<typeof getStorage>;

/**
 * Reconstruct a full Playwright trace ZIP from a slim ZIP and its shared resource pool.
 *
 * The slim ZIP holds the entries that stayed with the trace (event streams, aria
 * snapshots, sources); the manifest lists what went to the project-wide pool —
 * the `resources/` entries and the screenshots and screencast frames (see
 * `TraceBlobManifest`). We fetch each pooled file once and rebuild a complete
 * ZIP, with every entry under its original name, that the trace viewer can open.
 *
 * Returns null when the slim ZIP or the manifest cannot be parsed, so the caller
 * can fall back to the stored bytes. A pooled file that is gone is left out with
 * a warning; a pooled file that exists but cannot be read throws, so a passing
 * storage error is never served, or cached, as the complete trace.
 */
export async function reconstructTraceZip(
  storage: Storage,
  slimZipData: Buffer,
  manifestPath: string,
  projectPrefix: string, // e.g. "project-1/"
): Promise<Buffer | null> {
  let manifest: TraceBlobManifest;
  let slimEntries: ZipEntry[];
  try {
    manifest = parseTraceManifest(await storage.readFile(manifestPath));
    slimEntries = await parseZip(slimZipData);
  } catch (err) {
    console.warn(`[TraceZip] Reconstruction failed: ${err}`);
    return null;
  }

  // Fetch pooled files in bounded batches rather than all at once, so a trace
  // with hundreds of them doesn't open hundreds of simultaneous storage reads
  // (which pressures S3 connection/rate limits). A file several entries share
  // is read once.
  const pooled = new Map<string, Buffer>();
  const poolNames = traceManifestPoolNames(manifest);
  const RESOURCE_FETCH_CONCURRENCY = 16;
  for (let i = 0; i < poolNames.length; i += RESOURCE_FETCH_CONCURRENCY) {
    const batch = poolNames.slice(i, i + RESOURCE_FETCH_CONCURRENCY);
    await Promise.all(
      batch.map(async (name) => {
        const resourcePath = `${projectPrefix}trace-resources/${name}`;
        try {
          pooled.set(name, decodeResource(await storage.readFile(resourcePath)));
        } catch (error) {
          if (await storage.exists(resourcePath)) throw error;
          console.warn(`[TraceZip] Missing shared resource: ${resourcePath}`);
        }
      }),
    );
  }

  const pooledEntries: ZipEntry[] = [];
  for (const name of manifest.resources) {
    const data = pooled.get(name);
    if (data) pooledEntries.push({ name: `resources/${name}`, data });
  }
  for (const [entryName, poolName] of Object.entries(manifest.pooledEntries)) {
    const data = pooled.get(poolName);
    if (data) pooledEntries.push({ name: entryName, data });
  }

  return buildZip([...slimEntries, ...pooledEntries]);
}

/**
 * A stored file's bytes as users get them: a slim trace blob comes back as the
 * complete archive, any other file as stored. Throws when the pool cannot be
 * read (see {@link reconstructTraceZip}).
 */
export async function resolveStoredTrace(storage: Storage, path: string, data: Buffer): Promise<Buffer> {
  if (!path.endsWith('.zip') || !path.includes('/blobs/')) return data;
  const projectPrefix = traceProjectPrefix(path);
  const manifestPath = traceManifestPath(path);
  if (!projectPrefix || !(await storage.exists(manifestPath))) return data;
  return (await reconstructTraceZip(storage, data, manifestPath, `${projectPrefix}/`)) ?? data;
}

/**
 * Read a stored file, rebuilding it into a complete trace archive when the path
 * points at a slim trace blob. Any other path is returned as stored.
 */
export async function readFileResolvingTrace(path: string): Promise<Buffer | null> {
  const storage = getStorage();
  if (!(await storage.exists(path))) return null;
  return resolveStoredTrace(storage, path, await storage.readFile(path));
}
