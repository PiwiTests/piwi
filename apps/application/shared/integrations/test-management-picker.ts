/** What the binding form's pickers read from a test management tool for one connection and project. */

export interface TestManagementProjectOption {
  key: string;
  /** False for a project the tool lists but has not switched test management on for. */
  enabled: boolean;
}

export interface TestManagementStatusOption {
  name: string;
  isDefault: boolean;
}

export interface TestManagementFolderOption {
  id: string;
  /** The folder's name with its parents, `Nightly / Release 4.2`, so two folders of one name tell apart. */
  path: string;
}

/** The pickers' content: the projects of the connection, and (with a project key) its statuses and folders. */
export interface TestManagementPickerOptions {
  projects: TestManagementProjectOption[];
  statuses: TestManagementStatusOption[];
  folders: TestManagementFolderOption[];
}

/** The longest folder path a picker shows, in parents: a cycle in a malformed answer ends here. */
const MAX_FOLDER_DEPTH = 20;

/**
 * Folders as picker options, each named with its parents (`Nightly / Release 4.2`) and sorted by that path. A folder
 * whose parent is not in the list is shown from where its chain stops.
 */
export function folderOptions(
  folders: readonly { id: string; name: string; parentId: string | null }[],
): TestManagementFolderOption[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const options = folders.map((folder) => {
    const names = [folder.name];
    let parent = folder.parentId;
    for (let depth = 0; parent !== null && byId.has(parent) && depth < MAX_FOLDER_DEPTH; depth++) {
      const next = byId.get(parent)!;
      names.unshift(next.name);
      parent = next.parentId;
    }
    return { id: folder.id, path: names.join(' / ') };
  });
  return options.sort((a, b) => a.path.localeCompare(b.path));
}
