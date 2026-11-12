/**
 * Piwi Runner's window on the hub of the runs its shell starts (`useDesktopRunHub`, the host's `ShellRuns`): it holds
 * the hub's stream from its start until the hub listed its live runs, then while a requested run runs or the hub still
 * has a live one, so a headless stop of those runs waits for the window, and only then. It is present on the runs while it is visible, says `show` for the running runs whose
 * **Hold failures** is on, comes to the front at each stop it hears, and stops a run as its own Stop does when another
 * tool asks through the hub.
 */
import type { HubSession } from '@piwitests/core/run-hub';
import { runnerShellIdOf, runnerShownRefs } from '~/utils/runner-runs';

export default defineNuxtPlugin(() => {
  if (!tauriCore()) return;
  const { runs, stopRun } = useRunnerRuns();
  const hub = useDesktopRunHub();
  const sessions = computed(() => Object.values(hub.state.sessions) as HubSession[]);

  // Held from the window's start until the hub listed its live runs, so a run that went on while the window reloaded is
  // found; then while a run runs or the hub still has one.
  const listedOnce = ref(false);
  watch(
    () => hub.state.listed,
    (listed) => {
      if (listed) listedOnce.value = true;
    },
    { immediate: true },
  );
  watch(
    () => !listedOnce.value || runs.value.some((run) => run.status === 'running') || sessions.value.length > 0,
    (on) => hub.want(on),
    { immediate: true },
  );

  const visibility = useDocumentVisibility();
  watch(
    () => visibility.value === 'visible',
    (on) => hub.present(on),
    { immediate: true },
  );

  const shown = computed(() => runnerShownRefs(runs.value));
  watch(
    () => shown.value.join(' '),
    () => hub.show(shown.value),
    { immediate: true },
  );

  hub.onStopRun((ref) => {
    const shellId = runnerShellIdOf(ref);
    const run = runs.value.find((r) => r.shellId !== null && r.shellId === shellId);
    if (run && run.status === 'running' && !run.stopRequested) void stopRun(run);
  });

  // A stop waits for the person: the window, perhaps hidden in the tray, comes to the front.
  hub.onStop(() => {
    void tauriCore()
      ?.invoke('desktop_bring_to_front')
      .catch(() => {});
  });
});
