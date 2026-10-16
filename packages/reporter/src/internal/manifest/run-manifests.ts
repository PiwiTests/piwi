import type { WireNetworkRequest } from '@piwitests/core/wire';
import { errorMessage } from '../support/errors.js';
import type { Logger } from '../support/logger.js';
import type { HttpClient } from '../transport/http-client.js';
import { backendManifestFetch, fetchOriginManifest, type FetchLike, type ReporterManifest } from './collect.js';

/**
 * The declared surface of the origins a run reached beyond its configured base
 * URLs: an application whose tests navigate several origins (one per portal or
 * service, no `baseURL`) has a manifest on each. The reporter notes the origin of
 * every request whose response carried an instrumentation header and fetches its
 * `/__piwi/manifest` the first time it is noted, while its server is up since it
 * just answered, then uploads them once the run is submitted. The base URLs'
 * origins are the global setup's.
 */

/** The project id a project name has on the dashboard, from its project menu; undefined when none matches. */
export async function lookupProjectId(
  httpClient: HttpClient,
  auth: string | null,
  projectName: string,
): Promise<number | undefined> {
  const menu = await httpClient.getJSON('/api/projects/menu', auth);
  return (menu?.items as Array<{ id: number; name: string }> | undefined)?.find(
    (p) => p.name.toLowerCase() === projectName.toLowerCase(),
  )?.id;
}

/** Upload one declared-surface manifest; best-effort, a failure is logged at debug level. */
export async function uploadManifest(
  httpClient: HttpClient,
  auth: string | null,
  projectId: number,
  upload: { source: 'instrumentation' | 'committed'; branch: string | null; manifest: ReporterManifest },
  logger: Logger,
): Promise<void> {
  await httpClient
    .putJSON(`/api/projects/${projectId}/surface/manifest`, upload, auth)
    .catch((e: unknown) => logger.debug(`Manifest upload (${upload.source}) skipped: ${errorMessage(e)}`));
}

/** The origins of the requests whose response carried an instrumentation header (backend logs or spans). */
export function instrumentedOrigins(requests: readonly WireNetworkRequest[] | null | undefined): Set<string> {
  const origins = new Set<string>();
  for (const request of requests ?? []) {
    if (request.serverLogs === undefined && request.serverTraces === undefined) continue;
    try {
      const url = new URL(request.url);
      if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(url.origin);
    } catch {
      // Not a URL: nothing to fetch.
    }
  }
  return origins;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export class RunManifests {
  private readonly skipped: Set<string>;
  private readonly fetched = new Map<string, Promise<ReporterManifest | null>>();

  /**
   * @param baseUrls the configured base URLs, whose origins the global setup covers.
   * @param fetchImpl how a manifest is fetched; {@link backendManifestFetch} with
   *   `insecure` set when the run ignores HTTPS errors.
   */
  constructor(
    baseUrls: readonly string[],
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = backendManifestFetch(false),
  ) {
    this.skipped = new Set(baseUrls.map(originOf).filter((origin): origin is string => origin !== null));
  }

  /** Note the instrumented origins a test's requests reached, and fetch the manifest of each one not seen yet. */
  note(requests: readonly WireNetworkRequest[] | null | undefined): void {
    for (const origin of instrumentedOrigins(requests)) {
      if (!this.skipped.has(origin) && !this.fetched.has(origin)) {
        this.fetched.set(origin, fetchOriginManifest(origin, this.fetchImpl));
      }
    }
  }

  /** Upload the fetched manifests to the project, one per origin. Never throws. */
  async upload(
    httpClient: HttpClient,
    auth: string | null,
    projectName: string | undefined,
    branch: string | null,
  ): Promise<void> {
    if (!projectName || this.fetched.size === 0) return;
    try {
      const manifests = (await Promise.all(this.fetched.values())).filter((m): m is ReporterManifest => m !== null);
      if (manifests.length === 0) return;
      const projectId = await lookupProjectId(httpClient, auth, projectName);
      if (projectId === undefined) return;
      for (const manifest of manifests) {
        await uploadManifest(httpClient, auth, projectId, { source: 'instrumentation', branch, manifest }, this.logger);
      }
      this.logger.debug(`Declared surface: uploaded the manifests of ${manifests.length} origin(s) the run reached.`);
    } catch (error) {
      this.logger.debug(`Manifest upload skipped: ${errorMessage(error)}`);
    }
  }
}
