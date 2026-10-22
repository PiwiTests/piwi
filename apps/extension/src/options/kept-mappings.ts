import { coerceConnectionSettings, type ConnectionSettings } from '../shared/connection-settings.js';

/**
 * The lines of this browser (`ConnectionSettings.projectMappings`) as
 * Disconnect leaves them: kept with the origin of the instance they map
 * projects of, and given back by the next connection to that same origin.
 * The next connection to any other instance drops them, since their project
 * ids belong to the first one.
 */

export const KEPT_MAPPINGS_KEY = 'piwiKeptMappings';

type ProjectMappings = ConnectionSettings['projectMappings'];

interface KeptMappings {
  origin: string;
  projectMappings: ProjectMappings;
}

/** The origin of an http or https instance address; null for anything else. */
function instanceOrigin(instanceUrl: string): string | null {
  try {
    const url = new URL(instanceUrl.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The lines `value` keeps for the instance at `instanceUrl`; none when it keeps them for another, or is not a record. */
export function keptFor(value: unknown, instanceUrl: string): ProjectMappings {
  const kept = value as Partial<KeptMappings> | null | undefined;
  const origin = instanceOrigin(instanceUrl);
  if (!kept || !origin || kept.origin !== origin) return [];
  return coerceConnectionSettings({ projectMappings: kept.projectMappings }).projectMappings;
}

/** Keeps `projectMappings` for the instance at `instanceUrl`, as it is disconnected; no line keeps nothing. */
export async function keepMappings(instanceUrl: string, projectMappings: ProjectMappings): Promise<number> {
  const origin = instanceOrigin(instanceUrl);
  if (!origin || projectMappings.length === 0) {
    await chrome.storage.local.remove(KEPT_MAPPINGS_KEY);
    return 0;
  }
  await chrome.storage.local.set({ [KEPT_MAPPINGS_KEY]: { origin, projectMappings } satisfies KeptMappings });
  return projectMappings.length;
}

/** The lines kept for the instance at `instanceUrl`, as a connection to it is kept; the record goes either way. */
export async function takeKeptMappings(instanceUrl: string): Promise<ProjectMappings> {
  const stored = await chrome.storage.local.get(KEPT_MAPPINGS_KEY);
  if (stored[KEPT_MAPPINGS_KEY] === undefined) return [];
  await chrome.storage.local.remove(KEPT_MAPPINGS_KEY);
  return keptFor(stored[KEPT_MAPPINGS_KEY], instanceUrl);
}
