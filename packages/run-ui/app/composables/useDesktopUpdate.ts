/**
 * The app's own updates, as the shell checks and installs them (`updates.rs`): what the startup check already found,
 * a check by hand, the download and install with its progress (`piwi:update-progress`), the restart the person asks
 * for, and whether the startup check announces an update with a notification. The state is the window's, shared by
 * every view and kept while none shows it, so an install started from Settings → About is still followed, and its
 * restart offered, after the person goes elsewhere and back. Without the shell's bridge nothing is read and every
 * action does nothing. A failed action says why in a notification, in the host's words.
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

/** The window's one listener to the download's progress, once an install started. */
let progressHeard: Promise<unknown> | undefined;

export function useDesktopUpdate() {
  const toast = useToast();
  const { t } = useRunUiWords();

  /** This build carries an update channel. */
  const supported = useState('desktop-update-supported', () => false);
  const notifyOnStartup = useState('desktop-update-notify', () => true);
  const savingNotify = useState('desktop-update-saving-notify', () => false);
  const status = useState<DesktopUpdateStatus | null>('desktop-update-status', () => null);
  const checking = useState('desktop-update-checking', () => false);
  const installing = useState('desktop-update-installing', () => false);
  const installed = useState('desktop-update-installed', () => false);
  const progress = useState<{ downloaded: number; total: number | null } | null>('desktop-update-progress', () => null);

  onMounted(async () => {
    const core = tauriCore();
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
      // One listener for the window's life: the download goes on whichever view shows it.
      progressHeard ??= events
        ?.listen<{ downloaded: number; total: number | null }>('piwi:update-progress', ({ payload }) => {
          progress.value = payload;
        })
        .catch(() => null);
      await progressHeard;
      // `false`: the person kept the runs going rather than install now.
      installed.value = (await core.invoke<boolean | null>('desktop_install_update')) !== false;
    } catch (error) {
      fail(t('runui_updateFailed'), error);
      // A failed download leaves no update on offer in the shell: the next step is a check again.
      status.value = null;
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
