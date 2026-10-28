import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the desktop shell publishes its connection details and the folders
 * linked to projects: `~/.piwi/desktop.json` (`{ url, token, projects: [{ id, path }] }`),
 * the same file the reporter and the editor service read.
 */
export function desktopDiscoveryFilePath(): string {
  return join(homedir(), '.piwi', 'desktop.json');
}

/** A project's folder on this machine, as the desktop app links it. */
export interface DesktopLink {
  id: number;
  path: string;
}

/**
 * The folders the desktop app links to projects, or none outside the desktop runtime, or when the discovery file is
 * missing, malformed, or published for another server (its token is not this server's).
 */
export function desktopLinkedFolders(file = desktopDiscoveryFilePath()): DesktopLink[] {
  const token = process.env.PIWI_DESKTOP_TOKEN;
  if (!token) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      token?: unknown;
      projects?: Array<{ id?: unknown; path?: unknown }>;
    };
    if (parsed?.token !== token || !Array.isArray(parsed.projects)) return [];
    return parsed.projects.flatMap((p) =>
      typeof p?.id === 'number' && typeof p.path === 'string' && p.path ? [{ id: p.id, path: p.path }] : [],
    );
  } catch {
    return [];
  }
}

/**
 * The folder on this machine the desktop app links to a project, or null outside
 * the desktop runtime, without a link, or when the discovery file is missing,
 * malformed, or published for another server (its token is not this server's).
 */
export function desktopLinkedFolder(projectId: number, file = desktopDiscoveryFilePath()): string | null {
  return desktopLinkedFolders(file).find((link) => link.id === projectId)?.path ?? null;
}
