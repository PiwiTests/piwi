/**
 * The folder on this machine linked to a Piwi project (desktop shell only).
 *
 * Links are stored by the shell in its own settings store — a folder path is a
 * fact about this machine, not about the project — and are what enable running
 * tests locally and resolving IDE links without manual configuration. Every
 * accessor feature-detects the IPC bridge and no-ops in a plain browser.
 */

export interface DesktopProjectLink {
  path: string;
  exists: boolean;
}

/** One-shot read of a project's linked folder; `null` without bridge or link. */
export async function getDesktopProjectLink(
  projectId: string | number | null | undefined,
): Promise<DesktopProjectLink | null> {
  const core = tauriCore();
  if (!core || projectId == null || projectId === '') return null;
  try {
    return await core.invoke<DesktopProjectLink | null>('desktop_get_project_link', {
      projectId: String(projectId),
    });
  } catch {
    return null;
  }
}

/** Link a folder to a project outside the composable (e.g. right after creating the project). */
export async function setDesktopProjectLink(projectId: string | number, path: string): Promise<void> {
  const core = tauriCore();
  if (!core) throw new Error('not running inside the desktop shell');
  await core.invoke('desktop_set_project_link', { projectId: String(projectId), path });
}

export function useDesktopProjectLink(projectId: MaybeRefOrGetter<string | number | null | undefined>) {
  const toast = useToast();

  /** The IPC bridge exists — resolved on mount so SSR renders nothing. */
  const available = ref(false);
  const link = ref<DesktopProjectLink | null>(null);
  const busy = ref(false);

  async function refresh() {
    link.value = await getDesktopProjectLink(toValue(projectId));
  }

  onMounted(() => {
    available.value = !!tauriCore();
    if (available.value) void refresh();
  });
  watch(
    () => toValue(projectId),
    () => {
      if (available.value) void refresh();
    },
  );

  /** Open the native folder picker and link the chosen folder. False on cancel. */
  async function pickAndLink(): Promise<boolean> {
    const core = tauriCore();
    const id = toValue(projectId);
    if (!core || id == null || id === '') return false;
    busy.value = true;
    try {
      const path = await pickDesktopFolder();
      if (!path) return false;
      await core.invoke('desktop_set_project_link', { projectId: String(id), path });
      await refresh();
      return true;
    } catch (error) {
      toast.add({ title: 'Could not link the folder', description: errorMessage(error), color: 'error' });
      return false;
    } finally {
      busy.value = false;
    }
  }

  async function unlink() {
    const core = tauriCore();
    const id = toValue(projectId);
    if (!core || id == null || id === '') return;
    busy.value = true;
    try {
      await core.invoke('desktop_set_project_link', { projectId: String(id), path: null });
      link.value = null;
    } catch (error) {
      toast.add({ title: 'Could not unlink the folder', description: errorMessage(error), color: 'error' });
    } finally {
      busy.value = false;
    }
  }

  return { available, link, busy, refresh, pickAndLink, unlink };
}
