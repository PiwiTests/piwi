/**
 * Material bundled into the server build as Nitro server assets
 * (`nitro.serverAssets` in nuxt.config.ts), so it answers for the running
 * version with no network: the changelog here, the docs pages read by the MCP
 * `describe_piwi` tool (`mcp/about-piwi.ts`).
 */
import { parseChangelog, type ChangelogRelease } from '#shared/changelog';

const CHANGELOG_STORAGE = 'assets:piwi-changelog';

/** A bundled asset as text: production builds hand non-text types back as bytes. */
export function assetText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return null;
}

let changelogCache: Promise<ChangelogRelease[] | null> | null = null;

/**
 * The bundled changelog, parsed once per process (read again on every call in
 * dev, so edits show up); `null` when the build has none.
 */
export function bundledChangelog(): Promise<ChangelogRelease[] | null> {
  if (changelogCache && !import.meta.dev) return changelogCache;
  changelogCache = (async () => {
    const text = assetText(await useStorage(CHANGELOG_STORAGE).getItemRaw('CHANGELOG.md'));
    const releases = text ? parseChangelog(text) : [];
    return releases.length ? releases : null;
  })().catch(() => null);
  return changelogCache;
}
