/**
 * Desktop shell only: the dialog that links a project to its folder on this machine, `DesktopLinkFolderModal`, mounted
 * once in the default layout. Every **Choose folder…** of the app opens it with `chooseProjectFolder`: it says which
 * folder to pick, offers the folders found on this machine, and checks a folder picked by hand before linking it. The
 * request is a singleton, so one dialog serves every page.
 */

export interface DesktopLinkFolderRequest {
  projectId: string | number;
  /** The project's name, shown in the dialog. */
  projectLabel?: string | null;
  /**
   * The spec paths of the tests at hand (relative to the Playwright config's folder): a folder is checked against
   * them, else against the latest run's.
   */
  specs?: string[];
}

/** Settles the promise `chooseProjectFolder` returned; client-side only, never part of the rendered state. */
let settle: ((path: string | null) => void) | null = null;

export function useDesktopLinkFolder() {
  const request = useState<DesktopLinkFolderRequest | null>('desktop-link-folder-request', () => null);
  const open = useState<boolean>('desktop-link-folder-open', () => false);

  /**
   * Open the dialog for a project. Resolves with the folder it linked, or null when the dialog closes without one.
   * A second call while it is open answers the first with null.
   */
  function chooseProjectFolder(next: DesktopLinkFolderRequest): Promise<string | null> {
    settle?.(null);
    request.value = next;
    open.value = true;
    return new Promise((resolve) => {
      settle = resolve;
    });
  }

  /** Close the dialog with its answer: the folder linked, or null. */
  function finish(path: string | null) {
    const resolve = settle;
    settle = null;
    open.value = false;
    resolve?.(path);
  }

  return { request, open, chooseProjectFolder, finish };
}
