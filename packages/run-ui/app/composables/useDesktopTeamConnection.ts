/**
 * **Run on my machine**'s connection to one team instance, as every view of it acts on it: connect (the device flow
 * starts on the instance's page, which opens in the browser), disconnect (the shell removes the key from the OS
 * keychain), and the folders linked to the instance's projects, each unlinked on its own. The folders and whether an
 * action is on its way are shared by every view, and a failed action says why in a notification, in the host's words.
 * A disconnect waits while the shell keeps a key the instance just gave (`keeping`), which would connect it again.
 */
import type { RunTargetConnectionView } from '@piwitests/editor/run-target-view';

/** How long Connect waits for the host to start the sign-in on the instance. */
const CONNECT_TIMEOUT_MS = 30_000;

export function useDesktopTeamConnection() {
  const { connection } = useDesktopTeamRequests();
  /** The folder linked to each project, by the project's id on the instance. */
  const folders = useState<Record<string, string>>('desktop-team-folders', () => ({}));
  /** A connect or a disconnect is on its way. */
  const busy = useState('desktop-team-busy', () => false);
  /** The shell is keeping in the OS keychain the key the instance just gave (`desktop-team-requests.client.ts`). */
  const keeping = useState('desktop-team-keeping', () => false);
  const toast = useToast();
  const { t } = useRunUiWords();

  const connected = computed(() => teamInstanceConnected(connection.value.state));

  function fail(title: string, error: unknown) {
    toast.add({ title, description: errorMessage(error, t('runui_commonUnknownError')), color: 'error' });
  }

  /**
   * Reads the connection from the host, as the window opens. The host's event stream tells each change after, and a
   * change it told while the read was on its way stays.
   */
  async function loadConnection(): Promise<void> {
    const before = connection.value;
    try {
      const answer = await $fetch<{ connection?: RunTargetConnectionView }>('/api/desktop/run-target');
      if (answer.connection && connection.value === before) connection.value = answer.connection;
    } catch {
      // The event stream tells the connection once it opens.
    }
  }

  /** Reads the linked folders from the shell; none while the app is not connected. */
  async function loadFolders(): Promise<void> {
    const core = tauriCore();
    if (!core || !connected.value) {
      folders.value = {};
      return;
    }
    folders.value =
      (await core.invoke<Record<string, string> | null>('desktop_request_folders').catch(() => null)) ?? {};
  }

  /** Opens a page of the instance in the browser. */
  function openPage(url: string): void {
    tauriCore()
      ?.invoke('desktop_open_external', { url })
      .catch(() => {});
  }

  /** Starts the device flow on the instance at `address`, and opens its page to allow the app there. */
  async function connect(address: string): Promise<void> {
    if (!address.trim() || busy.value) return;
    busy.value = true;
    try {
      connection.value = await $fetch<RunTargetConnectionView>('/api/desktop/run-target/connect', {
        method: 'POST',
        body: { instance: address.trim() },
        timeout: CONNECT_TIMEOUT_MS,
      });
      if (connection.value.verificationUrl) openPage(connection.value.verificationUrl);
    } catch (error) {
      fail(t('runui_connectionConnectFailed'), error);
    } finally {
      busy.value = false;
    }
  }

  /** Ends the connection, or the sign-in on its way, and removes the key from the keychain. */
  async function disconnect(): Promise<void> {
    const core = tauriCore();
    if (!core || busy.value || keeping.value) return;
    busy.value = true;
    try {
      await core.invoke('desktop_forget_run_target');
    } catch (error) {
      fail(t('runui_connectionDisconnectFailed'), error);
    } finally {
      busy.value = false;
    }
  }

  /** Unlinks a project's folder: the next request for the project asks for one again. */
  async function unlink(projectId: string): Promise<void> {
    await tauriCore()
      ?.invoke('desktop_unlink_request_folder', { projectId })
      .catch((error: unknown) => fail(t('runui_connectionUnlinkFailed'), error));
    await loadFolders();
  }

  return {
    connection,
    connected,
    folders,
    busy,
    keeping,
    loadConnection,
    loadFolders,
    openPage,
    connect,
    disconnect,
    unlink,
  };
}
