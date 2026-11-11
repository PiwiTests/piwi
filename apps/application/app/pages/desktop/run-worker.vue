<script setup lang="ts">
/**
 * Desktop shell only: one worker of a run in a window of its own, which the shell keeps above the others
 * (`desktop_open_worker_window`, from the worker's **Open in a window** in the Local runs tray): its test, where it
 * stands, its controls and its page live, as the tray shows them (`DesktopRunWorker`). The run is named by `?ref=` and
 * Playwright's worker by `?worker=`. The window holds the runs' hub stream itself (`useDesktopRunHub`), present on the
 * runs while it is not hidden; the hub plugin leaves it alone. A window of its own: no layout.
 */
import { testName } from '@piwitests/run-model/stop';
import { DESKTOP_APP_NAME } from '#shared/piwi-ecosystem';

definePageMeta({ layout: false });

const route = useRoute();
const runRef = String(route.query.ref ?? '');
const workerIndex = Number(route.query.worker);

const hub = useDesktopRunHub();
const session = computed(() => hub.state.sessions[runRef]);
const worker = computed(() => session.value?.workers.find((w) => w.worker === workerIndex));

useHead({
  title: computed(() => {
    const test = worker.value?.test;
    return test ? `${testName(test)} · ${DESKTOP_APP_NAME}` : DESKTOP_APP_NAME;
  }),
});

/** What the live region reads out: what a command answered. */
const announcement = ref('');
function announce(text: string) {
  announcement.value = '';
  requestAnimationFrame(() => {
    announcement.value = text;
  });
}

const visibility = useDocumentVisibility();
onMounted(() => {
  hub.want(true);
  watch(visibility, (shown) => hub.present(shown === 'visible'), { immediate: true });
});
onBeforeUnmount(() => {
  hub.present(false);
  hub.want(false);
});
</script>

<template>
  <main class="min-h-dvh bg-default">
    <DesktopRunWorker v-if="session && worker" :session="session" :worker="worker" @announce="announce" />
    <p v-else class="p-4 text-sm text-muted">
      This worker runs no test now: its run ended, or another worker took its place.
    </p>
    <p role="status" aria-live="polite" class="sr-only">{{ announcement }}</p>
  </main>
</template>
