<script setup lang="ts">
/**
 * Desktop shell only: the separate windows of the dashboard window's Local runs (`separate` of the store), one
 * `DesktopRunOutputWindow` each, by the window's name (`windowNameOf`), so a run a window's Run again starts takes that
 * same window. Mounted with the app rather than the tray, so a window stays open whatever page or layout shows (an
 * analytics dashboard in TV mode, an error page), and comes back to its run after a reload (`keptWindows`). A window
 * closes as its run leaves the tray (Clear finished runs, the oldest dropped) or as the person closes it or shows the
 * run in the tray again. It also hears a worker's window ask to show its run in Local runs (`show-run`): the tray opens
 * on that run, back from its separate window, and the dashboard window comes to the front; and a run's or a worker's
 * window ask to open a file in the editor (`open-in-ide`), which only this window's grant does. It holds the question a
 * Run again asks of a protected environment (`DesktopEnvironmentQuestion`), whatever page or layout shows. Only the
 * dashboard window has them: a run's window and a worker's window show no runs of their own.
 */
import { desktopRunOf } from '~/utils/desktop-run-view';
import { RUN_OUTPUT_CHANNEL, type RunOutputMessage } from '~/utils/run-output-channel';

const store = useDesktopLocalRuns();
const toast = useToast();
const { openInIde } = useOpenInIde();

const shown = ref(false);
let channel: BroadcastChannel | null = null;
onMounted(() => {
  const label = tauriWindowLabel();
  shown.value = !!tauriCore() && !label?.startsWith('output-') && !label?.startsWith('worker-');
  if (!shown.value) return;
  channel = new BroadcastChannel(RUN_OUTPUT_CHANNEL);
  channel.onmessage = ({ data }: MessageEvent<RunOutputMessage>) => {
    if (data?.type === 'open-in-ide' && typeof data.target?.filePath === 'string') {
      void openInIde(data.target);
      return;
    }
    if (data?.type !== 'show-run' || typeof data.ref !== 'string') return;
    const run = store.runs.value.find((each) => each.hubRefs.includes(desktopRunOf(data.ref)));
    if (run) store.showRun(run.key);
    else store.trayOpen.value = true;
    void tauriCore()
      ?.invoke('desktop_bring_to_front')
      .catch(() => {});
  };
});
onBeforeUnmount(() => channel?.close());

const separateRuns = computed(() =>
  shown.value ? store.runs.value.filter((run) => store.separate.value[run.key]) : [],
);

/** Whether the page before a reload had the run's window open: asked for once, never opened again. */
function kept(key: number): boolean {
  return store.keptWindows.value.includes(key);
}

// A kept window counts once: brought back to the tray and opened again, it is a new window.
watch(
  () => store.separate.value,
  (separate) => {
    const kept = store.keptWindows.value.filter((key) => separate[key]);
    if (kept.length !== store.keptWindows.value.length) store.keptWindows.value = kept;
  },
);

function closed(key: number, opened: boolean) {
  store.separateRun(key, false);
  store.keptWindows.value = store.keptWindows.value.filter((k) => k !== key);
  if (!opened) {
    toast.add({
      title: 'Could not open a separate window',
      description: 'The run stays in the tray.',
      color: 'error',
    });
  }
}
</script>

<template>
  <DesktopEnvironmentQuestion v-if="shown" />
  <DesktopRunOutputWindow
    v-for="run in separateRuns"
    :key="store.windowNameOf(run.key)"
    :run="run"
    :name="store.windowNameOf(run.key)"
    :kept="kept(run.key)"
    @closed="(opened: boolean) => closed(run.key, opened)"
  />
</template>
