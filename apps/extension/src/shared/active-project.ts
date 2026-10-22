import { urlMatches } from '@piwitests/core/function-match';
import type { PathPrefixes } from '@piwitests/core/page-key';
import type { ConnectionSettings } from './connection-settings.js';
import { sessionArea } from './session-area.js';

/** Where the active project came from: the popup's choice, a pattern kept in this browser, or one of the instance's. */
type ActiveProjectSource = 'override' | 'local' | 'server';

export interface ActiveProject {
  projectId: number;
  projectLabel: string;
  /** The branch the matching URL mapping names; absent for the project's default branch. */
  branch?: string | null;
  /** The path prefix the matching URL mapping names: removed from the page's path before it is compared with the tests' pages. */
  pathPrefix?: string;
  /** The tests' path prefix the matching URL mapping names: put in front of the page's path before it is compared with the tests' pages. */
  testPathPrefix?: string;
  /** The environment the matching server pattern names, if any. */
  environment?: string;
  source?: ActiveProjectSource;
}

export const OVERRIDE_KEY = 'piwiActiveProjectOverride';

/** The origin a choice is kept under; null for an address with none (`about:blank`, a file). */
function overrideOrigin(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** Every site's choice, by origin. */
async function readOverrides(): Promise<Record<string, ActiveProject>> {
  const value = (await sessionArea().get(OVERRIDE_KEY))[OVERRIDE_KEY];
  if (!value || typeof value !== 'object') return {};
  const overrides: Record<string, ActiveProject> = {};
  for (const [origin, entry] of Object.entries(value as Record<string, unknown>)) {
    const v = entry as Partial<ActiveProject> | null;
    if (v && typeof v === 'object' && typeof v.projectId === 'number') {
      overrides[origin] = { projectId: v.projectId, projectLabel: String(v.projectLabel ?? `#${v.projectId}`) };
    }
  }
  return overrides;
}

/**
 * A manual "use this project regardless of the URL-pattern mapping" choice for
 * one site, made from the popup's active-project select and kept per origin:
 * the choice made on one site never applies on another. `url` is the page's
 * address: a content script's own by default; the popup, the background worker
 * and the DevTools pages pass the tab's. `chrome.storage.session` — a
 * for-this-browser-run choice, not a permanent setting; closing the browser
 * goes back to pure pattern matching, same reasoning as the recording/pick-session
 * state in `recording-storage.ts`/`session-storage.ts`.
 */
export async function getActiveProjectOverride(
  url: string = globalThis.location?.href ?? '',
): Promise<ActiveProject | null> {
  const origin = overrideOrigin(url);
  return origin ? ((await readOverrides())[origin] ?? null) : null;
}

/** Keeps `project` as the choice for `url`'s origin; null goes back to the URL patterns there. */
export async function setActiveProjectOverride(url: string, project: ActiveProject | null): Promise<void> {
  const origin = overrideOrigin(url);
  if (!origin) return;
  const overrides = await readOverrides();
  if (project) overrides[origin] = { projectId: project.projectId, projectLabel: project.projectLabel };
  else delete overrides[origin];
  await sessionArea().set({ [OVERRIDE_KEY]: overrides });
}

/** Drops the choice of every site: on Disconnect, and when another instance's projects take over. */
export async function clearActiveProjectOverrides(): Promise<void> {
  await sessionArea().remove(OVERRIDE_KEY);
}

/**
 * Which project applies to `url` right now, in this order: the popup's manual
 * override (with the path prefixes of a mapping of that project matching `url`); then the first pattern kept in this browser (`projectMappings`)
 * that matches, so a local pattern overrides the instance's for this browser;
 * then the first of the instance's own patterns (`serverMappings`, in the order
 * it lists them). `null` when nothing matches (not connected, or this page
 * isn't covered by any pattern).
 */
export function resolveActiveProject(
  settings: ConnectionSettings,
  override: ActiveProject | null,
  url: string,
): ActiveProject | null {
  if (override) {
    // The path prefixes still follow the URL: from the first mapping of the chosen project that matches.
    const mapping = [...settings.projectMappings, ...settings.serverMappings].find(
      (m) => m.projectId === override.projectId && urlMatches(m.urlPattern, url),
    );
    return { ...override, ...prefixesOf(mapping), source: 'override' };
  }
  for (const mapping of settings.projectMappings) {
    if (urlMatches(mapping.urlPattern, url))
      return {
        projectId: mapping.projectId,
        projectLabel: mapping.projectLabel,
        ...(mapping.branch ? { branch: mapping.branch } : {}),
        ...prefixesOf(mapping),
        source: 'local',
      };
  }
  for (const mapping of settings.serverMappings) {
    if (urlMatches(mapping.urlPattern, url))
      return {
        projectId: mapping.projectId,
        projectLabel: mapping.projectLabel,
        ...(mapping.branch ? { branch: mapping.branch } : {}),
        ...prefixesOf(mapping),
        ...(mapping.environment ? { environment: mapping.environment } : {}),
        source: 'server',
      };
  }
  return null;
}

/** A mapping's path prefixes, each only when set. */
function prefixesOf(mapping: { pathPrefix?: string; testPathPrefix?: string } | undefined): {
  pathPrefix?: string;
  testPathPrefix?: string;
} {
  return {
    ...(mapping?.pathPrefix ? { pathPrefix: mapping.pathPrefix } : {}),
    ...(mapping?.testPathPrefix ? { testPathPrefix: mapping.testPathPrefix } : {}),
  };
}

/**
 * The path prefixes of the URL mapping that applies to `url`: the ones the bug
 * report's page key is keyed with.
 */
export async function activePathPrefixes(settings: ConnectionSettings, url: string): Promise<PathPrefixes> {
  const override = await getActiveProjectOverride(url).catch(() => null);
  return prefixesOf(resolveActiveProject(settings, override, url) ?? undefined);
}
