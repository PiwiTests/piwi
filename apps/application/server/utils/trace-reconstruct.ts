import { getStorage } from '../storage';
import { parseZip, buildZip } from './trace-zip';
import { decodeResource } from './resource-compression';
import { parseTraceManifest, traceManifestPath, traceManifestPoolNames } from './trace-manifest';

/**
 * Reconstruct a full Playwright trace ZIP from a slim ZIP and its shared resource pool.
 *
 * The slim ZIP holds the entries that stayed with the trace (event streams, aria
 * snapshots, sources); the manifest lists what went to the project-wide pool —
 * the `resources/` entries and the screenshots and screencast frames (see
 * `TraceBlobManifest`). We fetch each pooled file once and rebuild a complete
 * ZIP, with every entry under its original name, that the trace viewer can open.
 *
 * Returns null if any required component is missing so the caller can fall back.
 */
export async function reconstructTraceZip(
  storage: ReturnType<typeof getStorage>,
  slimZipData: Buffer,
  manifestPath: string,
  projectPrefix: string, // e.g. "project-1/"
): Promise<Buffer | null> {
  try {
    const manifest = parseTraceManifest(await storage.readFile(manifestPath));

    // Parse slim ZIP to recover event entries
    const slimEntries = await parseZip(slimZipData);

    // Fetch pooled files in bounded batches rather than all at once, so a
    // trace with hundreds of resources doesn't open hundreds of simultaneous
    // storage reads (which pressures S3 connection/rate limits); missing
    // files are skipped. A file several entries share is read once.
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
          } catch {
            console.warn(`[TraceZip] Missing shared resource: ${resourcePath}`);
          }
        }),
      );
    }

    const pooledEntries: { name: string; data: Buffer }[] = [];
    for (const name of manifest.resources) {
      const data = pooled.get(name);
      if (data) pooledEntries.push({ name: `resources/${name}`, data });
    }
    for (const [entryName, poolName] of Object.entries(manifest.pooledEntries)) {
      const data = pooled.get(poolName);
      if (data) pooledEntries.push({ name: entryName, data });
    }

    return buildZip([...slimEntries, ...pooledEntries]);
  } catch (err) {
    console.warn(`[TraceZip] Reconstruction failed: ${err}`);
    return null;
  }
}

/**
 * Read a stored file, rebuilding it into a complete trace archive when the path
 * points at a slim trace blob. Any other path is returned as stored.
 */
export async function readFileResolvingTrace(path: string): Promise<Buffer | null> {
  const storage = getStorage();
  if (!(await storage.exists(path))) return null;

  const data = await storage.readFile(path);
  if (!path.endsWith('.zip') || !path.includes('/blobs/')) return data;

  const manifestPath = traceManifestPath(path);
  const projectPrefix = path.split('/blobs/')[0] + '/';
  if (!(await storage.exists(manifestPath))) return data;

  return (await reconstructTraceZip(storage, data, manifestPath, projectPrefix)) ?? data;
}
