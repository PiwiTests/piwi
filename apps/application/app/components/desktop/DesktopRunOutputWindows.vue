<script setup lang="ts">
/**
 * Desktop shell only: the separate output windows of the dashboard window's Local runs (`separate` of the store), one
 * `DesktopRunOutputWindow` each, mounted with the app rather than the tray, so a window stays open whatever page or
 * layout shows (an analytics dashboard in TV mode, an error page), and comes back to its run after a reload
 * (`keptWindows`). A window closes as its run leaves the tray (Clear finished runs, the oldest dropped) or as the
 * person closes it or brings the output back. Only the dashboard window has them: a run's output window and a
 * worker's window show no runs of their own.
 */
import { localRunDetail, localRunTitle } from '~/composables/useDesktopLocalRuns';

const store = useDesktopLocalRuns();
const { badge } = useDesktopRunBadge();
const toast = useToast();

const shown = ref(false);
onMounted(() => {
  const label = tauriWindowLabel();
  shown.value = !!tauriCore() && !label?.startsWith('output-') && !label?.startsWith('worker-');
});

const separateRuns = computed(() =>
  shown.value ? store.runs.value.filter((run) => store.separate.value[run.key]) : [],
);

/** Whether the page before a reload had the run's window open: asked for once, never opened again. */
function kept(key: number): boolean {
  return store.keptWindows.value.includes(key);
}

// A window brought back to the tray is no longer the page before's: opened again, it is a new one.
watch(
  () => store.separate.value,
  (separate) => {
    const kept = store.keptWindows.value.filter((key) => separate[key]);
    if (kept.length !== store.keptWindows.value.length) store.keptWindows.value = kept;
  },
);

function closed(key: number, opened: boolean) {
  store.separate.value = { ...store.separate.value, [key]: false };
  store.keptWindows.value = store.keptWindows.value.filter((k) => k !== key);
  if (!opened) {
    toast.add({
      title: 'Could not open a separate window',
      description: 'The output stays in the tray.',
      color: 'error',
    });
  }
}
</script>

<template>
  <DesktopRunOutputWindow
    v-for="run in separateRuns"
    :key="run.key"
    :run="run"
    :title="localRunTitle(run)"
    :status="badge(run)"
    :detail="localRunDetail(run)"
    :kept="kept(run.key)"
    @stop="store.stopRun(run)"
    @closed="(opened: boolean) => closed(run.key, opened)"
  />
</template>
