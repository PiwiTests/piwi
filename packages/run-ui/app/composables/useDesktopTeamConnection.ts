/**
 * **Run on my machine**'s connection to one team instance, as every view of it acts on it: connect (the device flow
 * starts on the instance's page, which opens in the browser), disconnect (the shell removes the key from the OS
 * keychain), and the folders linked to the instance's projects, each unlinked on its own. The folders and whether an
 * action is on its way are shared by every view, and a failed action says why in a notification, in the host's words.
 */
import type { RunTargetConnectionView } from '@piwitests/editor/run-target-view';

export function useDesktopTeamConnection() {
  const { connection } = useDesktopTeamRequests();
  /** The folder linked to each project, by the project's id on the instance. */
  const folders = useState<Record<string, string>>('desktop-team-folders', () => ({}));
  /** A connect or a disconnect is on its way. */
  const busy = useState('desktop-team-busy', () => false);
  const toast = useToast();
  const { t } = useRunUiWords();

  const connected = computed(() => teamInstanceConnected(connection.value.state));

  function fail(title: string, error: unknown) {
    toast.add({ title, description: errorMessage(error, t('runui_commonUnknownError')), color: 'error' });
  }

  /** Reads the connection from the host, as the window opens; the host's event stream tells each change after. */
  async function loadConnection(): Promise<void> {
    try {
      connection.value = (await $fetch<{ connection: RunTargetConnectionView }>('/api/desktop/run-target')).connection;
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
    if (!core || busy.value) return;
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

  return { connection, connected, folders, busy, loadConnection, loadFolders, openPage, connect, disconnect, unlink };
}
