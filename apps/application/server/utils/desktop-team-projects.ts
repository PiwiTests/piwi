/**
 * Compare with team instance, on the desktop app's server: the projects of the connected team instance, and for each
 * project of this app with a folder on this machine, the team project that folder is linked to. The page links a
 * folder through the shell, which keeps the links; this server only reads them.
 */
import { inArray } from 'drizzle-orm';
import { teamProjectsOfFolder, teamProjects, type TeamProject } from '@piwitests/editor/run-target';
import { projects } from '../database/schema';
import type { DrizzleDB } from '#shared/handlers/db';
import { desktopLinkedFolders } from './desktop-links';

/** A project of this app with a folder on this machine, and the team project its folder is linked to. */
export interface DesktopProjectFolder {
  projectId: number;
  projectName: string;
  folder: string;
  /** The team project the folder is linked to, the lowest when several are; null while it is linked to none. */
  teamProjectId: number | null;
  /** Every team project the folder is linked to, lowest first: requests may have linked it to several. */
  teamProjectIds: number[];
}

export type DesktopTeamProjects =
  | { status: 'ok'; instance: string; teamProjects: TeamProject[]; folders: DesktopProjectFolder[] }
  | { status: 'unavailable'; problem: string; message: string; folders: DesktopProjectFolder[] };

/** The projects of the team instance and this app's folders, or why the instance did not list its projects. */
export async function desktopTeamProjects(db: DrizzleDB): Promise<DesktopTeamProjects> {
  const links = desktopLinkedFolders();
  const names = links.length
    ? new Map(
        (
          await db
            .select({ id: projects.id, name: projects.name, label: projects.label })
            .from(projects)
            .where(
              inArray(
                projects.id,
                links.map((link) => link.id),
              ),
            )
        ).map((row) => [row.id, row.label || row.name]),
      )
    : new Map<number, string>();
  const folders: DesktopProjectFolder[] = [];
  for (const link of links) {
    const projectName = names.get(link.id);
    if (projectName === undefined) continue;
    const teamProjectIds = await teamProjectsOfFolder(link.path);
    folders.push({
      projectId: link.id,
      projectName,
      folder: link.path,
      teamProjectId: teamProjectIds[0] ?? null,
      teamProjectIds,
    });
  }
  folders.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.projectId - b.projectId);
  const listed = await teamProjects();
  if (!listed.ok) return { status: 'unavailable', problem: listed.problem, message: listed.message, folders };
  return { status: 'ok', instance: listed.instance, teamProjects: listed.projects, folders };
}
