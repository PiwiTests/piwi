/**
 * The app's own updates, as the shell checks and installs them (`updates.rs`): what the startup check already found,
 * a check by hand, the download and install with its progress (`piwi:update-progress`), the restart the person asks
 * for, and whether the startup check announces an update with a notification. Each view keeps its own state; without
 * the shell's bridge nothing is read and every action does nothing. A failed action says why in a notification, in
 * the host's words.
 */

/**
 * What a check found: a build that cannot update, the latest version, a newer one on offer, or a latest release that
 * has no package for this system yet (it is still being published).
 */
export interface DesktopUpdateStatus {
  state: 'unsupported' | 'uptodate' | 'available' | 'unpublished';
  version: string | null;
  date: string | null;
}

interface DesktopUpdateSettings {
  supported: boolean;
  notify_on_startup: boolean;
  pending: DesktopUpdateStatus | null;
}

export function useDesktopUpdate() {
  const toast = useToast();
  const { t } = useRunUiWords();

  /** The shell's bridge is there. */
  const bridged = ref(false);
  /** This build carries an update channel. */
  const supported = ref(false);
  const notifyOnStartup = ref(true);
  const savingNotify = ref(false);
  const status = ref<DesktopUpdateStatus | null>(null);
  const checking = ref(false);
  const installing = ref(false);
  const installed = ref(false);
  const progress = ref<{ downloaded: number; total: number | null } | null>(null);

  let unlisten: (() => void) | null = null;

  onMounted(async () => {
    const core = tauriCore();
    bridged.value = !!core;
    if (!core) return;
    try {
      const settings = await core.invoke<DesktopUpdateSettings>('desktop_get_update_settings');
      supported.value = settings.supported;
      notifyOnStartup.value = settings.notify_on_startup;
      if (settings.pending && !status.value) status.value = settings.pending;
    } catch {
      // Leaves the checkbox hidden; checking by hand still works.
    }
  });

  onScopeDispose(() => {
    unlisten?.();
  });

  /** The shell answers a failed command with its reason as a string. */
  function fail(title: string, error: unknown) {
    const description =
      typeof error === 'string' && error.trim() ? error : errorMessage(error, t('runui_commonUnknownError'));
    toast.add({ title, description, color: 'error' });
  }

  async function check(): Promise<void> {
    const core = tauriCore();
    if (!core || checking.value) return;
    checking.value = true;
    try {
      status.value = await core.invoke<DesktopUpdateStatus>('desktop_check_update');
    } catch (error) {
      fail(t('runui_updateCheckFailed'), error);
    } finally {
      checking.value = false;
    }
  }

  async function install(): Promise<void> {
    const core = tauriCore();
    const events = tauriEvent();
    if (!core || installing.value) return;
    installing.value = true;
    progress.value = { downloaded: 0, total: null };
    try {
      if (events && !unlisten) {
        unlisten = await events.listen<{ downloaded: number; total: number | null }>(
          'piwi:update-progress',
          ({ payload }) => {
            progress.value = payload;
          },
        );
      }
      // `false`: the person kept the runs going rather than install now.
      installed.value = (await core.invoke<boolean | null>('desktop_install_update')) !== false;
    } catch (error) {
      fail(t('runui_updateFailed'), error);
    } finally {
      installing.value = false;
      if (!installed.value) progress.value = null;
    }
  }

  async function restart(): Promise<void> {
    try {
      await tauriCore()?.invoke('desktop_restart_app');
    } catch {
      // The process is replacing itself: a dropped answer is expected.
    }
  }

  async function setNotifyOnStartup(value: boolean): Promise<void> {
    const core = tauriCore();
    if (!core) return;
    savingNotify.value = true;
    try {
      await core.invoke('desktop_set_update_notification', { enabled: value });
      notifyOnStartup.value = value;
    } catch (error) {
      fail(t('runui_updateNotifySaveFailed'), error);
    } finally {
      savingNotify.value = false;
    }
  }

  /** The download's progress in percent, once its size is known. */
  const progressPercent = computed(() => {
    const p = progress.value;
    if (!p?.total) return null;
    return Math.min(100, Math.round((p.downloaded / p.total) * 100));
  });

  return {
    bridged,
    supported,
    notifyOnStartup,
    savingNotify,
    status,
    checking,
    installing,
    installed,
    progressPercent,
    check,
    install,
    restart,
    setNotifyOnStartup,
  };
}
