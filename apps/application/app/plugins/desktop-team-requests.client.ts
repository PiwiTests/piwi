import type { RunRequestPromptView, RunTargetConnectionView } from '#shared/desktop-run-target';

/**
 * Desktop shell: hear the connection to the team instance and the run requests it sends. A key the device flow just
 * gave goes to the shell, which keeps it in the OS keychain (the window never reads it); a key the instance revoked
 * leaves the keychain. Each request brings the window to the front, where the person runs or declines it. Activates
 * only in the `main` window.
 */
export default defineNuxtPlugin(() => {
  const core = tauriCore();
  if (!core || tauriWindowLabel() !== 'main') return;

  const { connection, add, remove } = useDesktopTeamRequests();
  let keeping = false;
  subscribeDesktopEvents((message) => {
    if (message.type === 'run-target' && message.connection && typeof message.connection === 'object') {
      const next = message.connection as RunTargetConnectionView;
      const wasRevoked = connection.value.state === 'revoked';
      connection.value = next;
      if (next.keyToKeep && !keeping) {
        keeping = true;
        core
          .invoke('desktop_keep_run_target_key')
          .catch((error: unknown) => {
            // A key the keychain cannot keep would be lost at the next start: disconnect rather than take requests.
            useToast().add({
              title: 'Could not keep the key: disconnected',
              description: errorMessage(error),
              color: 'error',
            });
            return core.invoke('desktop_forget_run_target').catch(() => {});
          })
          .finally(() => (keeping = false));
      }
      if (next.state === 'revoked' && !wasRevoked) core.invoke('desktop_forget_run_target').catch(() => {});
      return;
    }
    if (message.type === 'run-request' && message.request && typeof message.request === 'object') {
      add(message.request as RunRequestPromptView);
      core.invoke('desktop_bring_to_front').catch(() => {});
      return;
    }
    if (message.type === 'run-request-gone' && typeof message.id === 'string') remove(message.id);
  });
});
